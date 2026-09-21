// Phase 4B.1 — أداة المشغّل اليدوي للاسترداد من RECOVERY_REQUIRED.
// Phase 5B.1 — + وضع استرداد Session Epoch المفقود/التالف (--epoch-recover)
//           + استدعاء Prisma CLI عبر Node نفسه (بلا bunx/npx/shell/PATH/.cmd).
//
// هذا سكربت تشغيلي يدوي موثق (ليس API ولا endpoint) — القرار الحاكم:
// «في RECOVERY_REQUIRED: القراءة والكتابة محجوبتان. لا reset تلقائي.
//  تعرض الإدارة operationId ومعلومات تشخيصية آمنة فقط» — والخروج من
// الحالة يتم عبر هذا الإجراء بعد تحقق بشري صريح من سلامة القاعدة.
//
// الاستخدام:
//   bun scripts/restore-operator.ts --status
//   bun scripts/restore-operator.ts --verify-and-clear [--confirm-manual-verification]
//   bun scripts/restore-operator.ts --epoch-recover --confirm-epoch-loss
//
// منطق --epoch-recover (نص المستخدم 5B.1 §4):
//   • الحالة: ملف epoch مفقود أو تالف على قاعدة إنتاج مهيأة — النظام فشل مغلقًا
//     (لا جلسات، لا كتابة، لا دخول) ولا يُنشئ عدّادًا جديدًا بصمت.
//   • شرط تنفيذ: --confirm-epoch-loss صراحةً + نجاح verifyCurrentDb كاملًا
//     (ترويسة + integrity + canonical + migrate status + قراءة Prisma + مستخدم صالح).
//   • الحد الأمني (موثق): القيمة الجديدة = unix time بالثواني (~1.8e9). كل
//     التوكنات السابقة تحمل epoch من عائلة العدّاد القديم (يبدأ 1 ويزيد 1 لكل
//     استعادة/استرداد — عمليًا بملايين على الأكثر) ⇒ القيمة الزمنية أكبر حتمًا
//     ⇒ لا توكن قديم يمكن أن يطابق ⇒ إبطال كامل مضمون رياضيًا.
//   • المشغّل لا يُدخل أي قيمة يدويًا إطلاقًا (منع قيمة أقل من السابقة المفقودة) —
//     القيمة تُحسب آليًا من الوقت الحالي، وتظل أحادية الاتجاه عبر bump اللاحقة.
//   • الأدلة: حدث MANUAL_RECOVERY_COMPLETED في السجل الخارجي بتفاصيل آمنة.
//
// منطق --verify-and-clear (fail-safe):
//   1. يشغّل مجموعة الفحوص البعدية كاملة على قاعدة التشغيل الحالية مباشرة.
//   2. نجاح كل الفحوص ⇒ رفع Session Epoch (+1) ثم مسح ملف الحالة ⇒ NORMAL
//      + حدث MANUAL_RECOVERY_COMPLETED في السجل الخارجي.
//   3. فشل أي فحص ⇒ لا مسح إطلاقًا — تعليمات مطبوعة: استرجاع يدوي من أحدث
//      نسخة pre-restore سليمة في BACKUP_DIR ثم إعادة الفحص.
//   4. حالة ملف تالف (STATE_FILE_CORRUPT) تتطلب --confirm-manual-verification
//      صراحةً (لا افتراض تلقائي بالسلامة).

import { existsSync, readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

import {
  resolveDatabaseFilePath,
  resolveSessionEpochFilePath,
  PINNED_CURRENT_CANONICAL_FINGERPRINT,
} from "../src/lib/backup-config";
import {
  readMaintenanceStateFile,
  operatorClearMaintenanceState,
} from "../src/lib/maintenance";
import { bumpSessionEpoch, readSessionEpoch, writeSessionEpochValue } from "../src/lib/session-epoch";
import { appendRecoveryEvent } from "../src/lib/recovery-log";
import { canonicalSchemaFingerprint } from "../src/lib/schema-fingerprint";
import { toSqliteFileUrl } from "../src/lib/sqlite-url";
import { runPrismaCli } from "../src/lib/prisma-cli";

const args = process.argv.slice(2);
const MODE_STATUS = args.includes("--status");
const MODE_CLEAR = args.includes("--verify-and-clear");
const MODE_EPOCH_RECOVER = args.includes("--epoch-recover");
const CONFIRM = args.includes("--confirm-manual-verification");
const CONFIRM_EPOCH_LOSS = args.includes("--confirm-epoch-loss");

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
  const client = new PrismaClient({ datasources: { db: { url: toSqliteFileUrl(dbPath) } }, log: [] });
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

  // 3) prisma migrate status (عملية فرعية عبر Node نفسه — Phase 5B.1)
  try {
    const res = runPrismaCli({
      args: ["migrate", "status"],
      cwd: process.cwd(),
      databaseUrl: toSqliteFileUrl(dbPath),
      timeoutMs: 60_000,
    });
    const out = `${res.stdout}${res.stderr}`;
    if (res.ok && /up to date/i.test(out)) ok("prisma migrate status", "up to date");
    else failures.push(`MIGRATE_STATUS: ${res.code === "PRISMA_CLI_UNRESOLVED" ? res.detail : out.slice(0, 200)}`);
  } catch (e) {
    failures.push(`MIGRATE_STATUS: ${String(e)}`);
  }

  return { ok: failures.length === 0, failures };
}

/** حالة ملف epoch: missing | corrupt | ok */
function epochFileStatus(): "missing" | "corrupt" | "ok" {
  const value = readSessionEpoch();
  if (value !== null) return "ok";
  return existsSync(resolveSessionEpochFilePath()) ? "corrupt" : "missing";
}

async function runEpochRecovery(): Promise<void> {
  console.log("=== استرداد Session Epoch (5B.1) ===");
  if (!CONFIRM_EPOCH_LOSS) {
    console.log("\n❌ مطلوب تأكيد صريح: أعد التشغيل مع --confirm-epoch-loss بعد تحققك البشري");
    console.log("   من سلامة القاعدة ومن أن فقد/تلف ملف epoch حقيقة وليس إعادة تسمية/نقل عرضي.");
    process.exit(1);
  }

  const status = epochFileStatus();
  console.log("حالة ملف epoch:", status);
  if (status === "ok") {
    console.log("\n❌ ملف epoch سليم وقابل للقراءة — لا مسار استرداد هنا إطلاقًا.");
    console.log("   الإبطال المتحكم به يجري عبر bump المحرك (restore/rollback) أو --verify-and-clear.");
    process.exit(1);
  }

  console.log("\n— الفحص الكامل للقاعدة قبل أي كتابة —");
  const result = await verifyCurrentDb();
  if (!result.ok) {
    console.log("\n❌ فشل الفحص — لا كتابة epoch إطلاقًا (القاعدة غير موثوقة):");
    for (const f of result.failures) console.log("   • " + f);
    console.log("\nالإجراء الموثق: استرجاع القاعدة من أحدث نسخة سليمة عبر محرك الاستعادة");
    console.log("أو المسار اليدوي الموثق — ثم أعد هذا الفحص.");
    process.exit(1);
  }

  // الحد الأمني الموثق: unix-seconds حصرًا — لا إدخال يدوي إطلاقًا
  const newEpoch = Math.floor(Date.now() / 1000);
  const written = writeSessionEpochValue(newEpoch);
  if (!written) {
    console.log("❌ فشل الكتابة الذرية لملف epoch — لا استرداد. افحص صلاحيات مجلد VAR_DIR.");
    process.exit(1);
  }

  const opId = `op-epoch-recovery-${new Date().toISOString()}`;
  await appendRecoveryEvent({
    operationId: opId,
    event: "MANUAL_RECOVERY_COMPLETED",
    actor: { id: null, username: "operator:manual" },
    backupId: null,
    result: "success",
    details: {
      reason: "epoch_recovery",
      epochFileStatus: status,
      strategy: "unix_time_seconds",
      securityBound: "old-token-epoch-family-strictly-below-new-value",
    },
  });

  console.log(`\n✅ تمت كتابة epoch جديدة = ${newEpoch} (unix seconds — كتابة ذرية)`);
  console.log("   كل الجلسات القديمة ميتة حتمًا (قيمها من عائلة العدّاد القديم أصغر حتمًا).");
  console.log("   الأدلة في السجل الخارجي:", opId);
  console.log("   أعد تشغيل الخادم الآن وتحقق: /api/health ⇒ healthy مع دخول جديد.");
}

async function main() {
  if (MODE_EPOCH_RECOVER) {
    await runEpochRecovery();
    return;
  }

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
    console.log("\nلفقد/تلف ملف epoch: bun scripts/restore-operator.ts --epoch-recover --confirm-epoch-loss");
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
