// Phase 4B.1 — أداة المشغّل اليدوي للاسترداد من RECOVERY_REQUIRED.
//
// هذا سكربت تشغيلي يدوي موثق (ليس API ولا endpoint) — القرار الحاكم:
// «في RECOVERY_REQUIRED: القراءة والكتابة محجوبتان. لا reset تلقائي.
//  تعرض الإدارة operationId ومعلومات تشخيصية آمنة فقط» — والخروج من
// الحالة يتم عبر هذا الإجراء بعد تحقق بشري صريح من سلامة القاعدة.
//
// الاستخدام:
//   bun scripts/restore-operator.ts --status
//   bun scripts/restore-operator.ts --verify-and-clear [--confirm-manual-verification]
//
// المنطق (fail-safe):
//   1. يشغّل مجموعة الفحوص البعدية كاملة على قاعدة التشغيل الحالية مباشرة
//      (ترويسة SQLite، integrity_check، canonical fingerprint، prisma migrate
//      status، قراءة Prisma، وجود مستخدم صالح).
//   2. نجاح كل الفحوص ⇒ رفع Session Epoch (+1 — فشل آمن: أي عملية مقاطعة
//      قد تكون استبدلت القاعدة، فالجلسات القديمة تُبطل تحسبًا) ثم مسح ملف
//      الحالة ⇒ NORMAL + حدث MANUAL_RECOVERY_COMPLETED في السجل الخارجي.
//   3. فشل أي فحص ⇒ لا مسح إطلاقًا — تعليمات مطبوعة: استرجاع يدوي من أحدث
//      نسخة pre-restore سليمة في BACKUP_DIR ثم إعادة الفحص.
//   4. حالة ملف تالف (STATE_FILE_CORRUPT) تتطلب --confirm-manual-verification
//      صراحةً (لا افتراض تلقائي بالسلامة).

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

import { resolveDatabaseFilePath, PINNED_CURRENT_CANONICAL_FINGERPRINT } from "../src/lib/backup-config";
import {
  readMaintenanceStateFile,
  operatorClearMaintenanceState,
} from "../src/lib/maintenance";
import { bumpSessionEpoch, readSessionEpoch } from "../src/lib/session-epoch";
import { appendRecoveryEvent } from "../src/lib/recovery-log";
import { canonicalSchemaFingerprint } from "../src/lib/schema-fingerprint";

const args = process.argv.slice(2);
const MODE_STATUS = args.includes("--status");
const MODE_CLEAR = args.includes("--verify-and-clear");
const CONFIRM = args.includes("--confirm-manual-verification");

function ok(title: string, detail = ""): boolean {
  console.log(`✅ ${title}${detail ? ` — ${detail}` : ""}`);
  return true;
}
function bad(title: string, detail = ""): boolean {
  console.log(`❌ ${title}${detail ? ` — ${detail}` : ""}`);
  return false;
}

async function verifyCurrentDb(): Promise<{ ok: boolean; failures: string[] }> {
  const dbPath = resolveDatabaseFilePath();
  const failures: string[] = [];
  console.log(`— قاعدة التشغيل الحالية (فحص مباشر بلا HTTP) —`);

  // 1) ترويسة SQLite
  try {
    const head = readFileSync(dbPath).subarray(0, 16);
    const magic = Buffer.from("SQLite format 3\0");
    if (!head.equals(magic)) failures.push(`SQLITE_HEADER: ترويسة غير صالحة`);
    else ok("ترويسة SQLite");
  } catch (e) {
    failures.push(`SQLITE_HEADER: ${String(e)}`);
  }

  // 2) integrity + قراءة Prisma + canonical + مستخدم صالح
  const client = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } }, log: [] });
  try {
    const integ = (await client.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`))[0]?.integrity_check;
    if (integ === "ok") ok("integrity_check", integ);
    else failures.push(`INTEGRITY: ${integ}`);

    const counts = {
      users: await client.user.count(),
      groups: await client.group.count(),
      reports: await client.report.count(),
      workflowHistory: await client.workflowHistory.count(),
      auditLog: await client.auditLog.count(),
    };
    ok("قراءة Prisma للجداول الخمسة", JSON.stringify(counts));

    const canonical = await canonicalSchemaFingerprint(client);
    const expected = PINNED_CURRENT_CANONICAL_FINGERPRINT;
    if (!expected || canonical === expected) ok("canonical fingerprint", canonical.slice(0, 25) + "…");
    else failures.push(`CANONICAL: actual=${canonical} expected=${expected}`);

    const activeUsers = await client.user.count({ where: { active: true } });
    if (activeUsers >= 1) ok("مستخدم صالح واحد على الأقل", `active=${activeUsers}`);
    else failures.push(`ACTIVE_USER: ${activeUsers}`);
  } catch (e) {
    failures.push(`PRISMA: ${String(e)}`);
  } finally {
    await client.$disconnect().catch(() => undefined);
  }

  // 3) prisma migrate status (عملية فرعية)
  try {
    const res = spawnSync("bunx", ["prisma", "migrate", "status"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      encoding: "utf8",
      timeout: 60_000,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.status === 0 && /up to date/i.test(out)) ok("prisma migrate status", "up to date");
    else failures.push(`MIGRATE_STATUS: ${out.slice(0, 200)}`);
  } catch (e) {
    failures.push(`MIGRATE_STATUS: ${String(e)}`);
  }

  return { ok: failures.length === 0, failures };
}

async function main() {
  const state = readMaintenanceStateFile();
  if (!state || state.state === "NORMAL") {
    console.log("الحالة: NORMAL — لا حاجة لأي استرداد.");
    return;
  }
  console.log("الحالة التشغيلية الحالية:", JSON.stringify(state.state));
  console.log("operationId:", state.operationId ?? "—");
  console.log("message:", state.message ?? "—");
  if (state.recovery) {
    console.log("recovery:", JSON.stringify(state.recovery));
  }
  console.log("flags:", JSON.stringify(state.flags ?? {}));
  console.log("epoch الحالي:", readSessionEpoch() ?? "غير قابل للقراءة");

  if (MODE_STATUS || !MODE_CLEAR) {
    console.log("\nللاسترداد: bun scripts/restore-operator.ts --verify-and-clear");
    console.log("(فحص كامل للقاعدة الحالية، ثم رفع epoch ومسح الحالة — أو تعليمات يدوية عند الفشل)");
    return;
  }

  // وضع المسح بعد التحقق
  const corrupt = state.message === "STATE_FILE_CORRUPT";
  if (corrupt && !CONFIRM) {
    console.log("\n❌ ملف الحالة تالف — يُمنع المسح التلقائي. راجع سلامة القاعدة يدويًا ثم");
    console.log("   أعد التشغيل مع --confirm-manual-verification لتأكيد تحققك البشري الصريح.");
    process.exit(1);
  }

  console.log("\n— تشغيل الفحوص البعدية الكاملة على القاعدة الحالية —");
  const result = await verifyCurrentDb();
  if (!result.ok) {
    console.log("\n❌ فشل الفحص — لا مسح للحالة إطلاقًا (القاعدة غير موثوقة):");
    for (const f of result.failures) console.log("   • " + f);
    console.log("\nالإجراء الموثق: أوقف الخادم → استبدل القاعدة يدويًا من أحدث نسخة");
    console.log("pre-restore سليمة في BACKUP_DIR (بعد التحقق منها) → أعد التشغيل → أعد هذا الفحص.");
    process.exit(1);
  }

  // نجاح الفحص: رفع epoch (فشل آمن ضد الجلسات القديمة) ثم مسح الحالة
  const bumped = bumpSessionEpoch();
  if (bumped === null) {
    console.log("❌ تعذر رفع Session Epoch (fail-safe) — لا مسح للحالة. أصلح ملف epoch يدويًا بقيمة جديدة كبيرة.");
    process.exit(1);
  }
  const opId = `op-manual-recovery-${new Date().toISOString()}`;
  operatorClearMaintenanceState();
  await appendRecoveryEvent({
    operationId: opId,
    event: "MANUAL_RECOVERY_COMPLETED",
    actor: { id: null, username: "operator:manual" },
    backupId: state.flags?.preRestoreBackupId ?? null,
    result: "success",
    details: {
      originalState: state.state,
      originalOperationId: state.operationId,
      verifyPassed: true,
      epochBumped: true,
    },
  });
  console.log(`\n✅ الفحص كامل — تم رفع epoch (${bumped}) ومسح الحالة ⇒ NORMAL`);
  console.log("   (كل الجلسات القديمة ماتت — يتطلب من الجميع تسجيل الدخول من جديد)");
}

main().catch((e) => {
  console.error("خطأ غير متوقع:", e);
  process.exit(1);
});
