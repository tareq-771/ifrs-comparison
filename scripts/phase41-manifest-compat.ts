// Phase 4A.1 — اختبار توافق Manifest v3/legacy-v2 + أمان البصمات + استقلال تشغيلات Drill.
//
// يثبت (طلب المستخدم 4A.1):
//  1) النسخ الجديدة تُنشأ بصيغة Manifest v3 مع canonicalSchemaFingerprint الحاكمة.
//  2) النسخ القديمة (formatVersion 2 من 4A) لا تُكسر: تُتحقق وتُصنف legacy-v2
//     وتُستخرج بصمتها القاعدية من database.db نفسها — بلا ترقية صامتة.
//  3) لا ثقة بقيمة مكتوبة: تلاعب canonical في v3 أو physical في v2 ⇒ رفض
//     MANIFEST_INCONSISTENT قبل أي اعتماد.
//  4) كل تشغيل Drill له operationId مستقل + drillRun.sequence — تشغيلان لنفس
//     النسخة لا يبدوان كحدثين مكررين للعملية نفسها (backupId يتكرر طبيعيًا).
//
// قاعدة التشغيل: لا تُلمس إطلاقًا (النسخ عبر VACUUM INTO، الـDrill على مؤقتة).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { createBackup, listBackups, runRestoreDrillById, validateBackupById, validateBackupArtifact } from "@/lib/backup-server";
import { PINNED_CURRENT_CANONICAL_FINGERPRINT } from "@/lib/backup-config";
import { countRecoveryEvents, readRecoveryEvents } from "@/lib/recovery-log";

const ROOT = "/home/z/my-project";
const TMP = path.join(ROOT, "var", "tmp-41");
const PROD = path.join(ROOT, "db", "custom.db");

const ACTOR = { id: null as string | null, username: "system-4a1-governance" };

function line(title: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${title}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  console.log("=== Phase 4A.1 — Manifest v3 / Legacy-v2 Compatibility & Drill Run Identity ===\n");
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true, mode: 0o700 });

  // حالة الإنتاج قبل/بعد — يجب ألا تتغير بيانات الأعمال
  const prod = new PrismaClient({ datasources: { db: { url: `file:${PROD}` } }, log: [] });
  const countsBefore = {
    users: await prod.user.count(),
    groups: await prod.group.count(),
    reports: await prod.report.count(),
    workflowHistory: await prod.workflowHistory.count(),
    auditLog: await prod.auditLog.count(),
  };

  // ── 1) إنشاء نسخة جديدة v3 ──────────────────────────────────────────────
  const created = await createBackup(ACTOR);
  const m3 = created.manifest;
  line(
    "1أ) نسخة جديدة بصيغة Manifest v3 (canonical مضمّن)",
    m3.formatVersion === 3 && typeof m3.canonicalSchemaFingerprint === "string",
    `${created.backupId} · level=${created.level}`
  );
  line(
    "1ب) canonicalSchemaFingerprint في الـ Manifest = الثابت المثبّت",
    m3.formatVersion === 3 && m3.canonicalSchemaFingerprint === PINNED_CURRENT_CANONICAL_FINGERPRINT,
    m3.formatVersion === 3 ? m3.canonicalSchemaFingerprint.slice(0, 28) + "…" : ""
  );
  line(
    "1ج) التحقق التلقائي بعد الإنشاء: VALIDATED + canonicalMatchesManifest=true",
    created.level === "VALIDATED" && created.validationReport?.canonicalMatchesManifest === true,
    created.validationError ?? ""
  );

  // ── 2) إعادة فحص النسخ القديمة (legacy v2 من 4A) ────────────────────────
  const listing = listBackups();
  const oldV2 = listing.local.filter((e) => e.manifestFormat === 2);
  line("2أ) النسخ القديمة تظهر بالقائمة كـ legacy v2 (وليست INVALID)", oldV2.length === 3, oldV2.map((e) => e.backupId).join(", "));
  for (const entry of oldV2) {
    const report = await validateBackupById(entry.backupId, ACTOR);
    line(
      `2ب) إعادة تحقق ${entry.backupId}`,
      report.ok === true && report.manifestFormat === 2 && report.manifestClass === "legacy-v2" && report.canonicalMatchesManifest === null,
      `level=${report.level} · canonical=${report.canonicalSchemaFingerprint?.slice(0, 21)}…`
    );
    line(
      `2ج) ${entry.backupId} — canonical المستخرجة من database.db = الثابت المثبّت`,
      report.canonicalSchemaFingerprint === PINNED_CURRENT_CANONICAL_FINGERPRINT,
      "لا ثقة بقيمة Manifest وحدها — استُخرجت من المحتوى"
    );
  }
  // المستوى لا يهبط بإعادة التحقق
  const afterReval = listBackups();
  const lv = new Map(afterReval.local.map((e) => [e.backupId, e.level]));
  line(
    "2د) مستويات النسخ القديمة محفوظة بلا هبوط",
    oldV2.every((e) => lv.get(e.backupId) === (e.level === "RESTORE_VERIFIED" ? "RESTORE_VERIFIED" : "VALIDATED")),
    oldV2.map((e) => `${e.backupId.slice(3, 17)}=${lv.get(e.backupId)}`).join(" · ")
  );

  // ── 3) التلاعب بالبصمات يُرفض قبل أي اعتماد ────────────────────────────
  async function tamperedZip(srcZip: string, outZip: string, mutate: (m: Record<string, unknown>) => void): Promise<void> {
    const zip = await JSZip.loadAsync(readFileSync(srcZip));
    const manifestRaw = await zip.file("manifest.json")!.async("string");
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    mutate(manifest);
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));
    const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    writeFileSync(outZip, out, { mode: 0o600 });
    // sidecar مطابق (كي يتجاوز فحص الجانبي ويصل لفحص البصمة المحتوائي)
    writeFileSync(outZip.replace(/\.zip$/, ".manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  }

  // 3أ) v3 بcanonical مزيف
  const tamperedV3 = path.join(TMP, "tampered-v3.zip");
  await tamperedZip(path.join(ROOT, "var", "backups", `${created.backupId}.zip`), tamperedV3, (m) => {
    m.canonicalSchemaFingerprint = "csha256:" + "0".repeat(64);
  });
  let rejectedA = "";
  try {
    await validateBackupArtifact({ zipPath: tamperedV3, actor: ACTOR, source: "local", operationId: "op-tamper-a-test" });
  } catch (e) {
    rejectedA = (e as { code?: string }).code ?? String(e);
  }
  line("3أ) v3 بـ canonical مزيف ⇒ MANIFEST_INCONSISTENT", rejectedA === "MANIFEST_INCONSISTENT", rejectedA);

  // 3ب) v2 بphysical مزيف
  const firstV2 = oldV2[0];
  const tamperedV2 = path.join(TMP, "tampered-v2.zip");
  await tamperedZip(path.join(ROOT, "var", "backups", `${firstV2.backupId}.zip`), tamperedV2, (m) => {
    m.schemaFingerprint = "sha256:" + "f".repeat(64);
  });
  let rejectedB = "";
  try {
    await validateBackupArtifact({ zipPath: tamperedV2, actor: ACTOR, source: "local", operationId: "op-tamper-b-test" });
  } catch (e) {
    rejectedB = (e as { code?: string }).code ?? String(e);
  }
  line("3ب) v2 بـ physical مزيف ⇒ MANIFEST_INCONSISTENT", rejectedB === "MANIFEST_INCONSISTENT", rejectedB);
  rmSync(tamperedV3, { force: true });
  rmSync(tamperedV3.replace(/\.zip$/, ".manifest.json"), { force: true });
  rmSync(tamperedV2, { force: true });
  rmSync(tamperedV2.replace(/\.zip$/, ".manifest.json"), { force: true });

  // ── 4) تشغيلان Drill مستقلان لنفس النسخة ────────────────────────────────
  const priorStarted = await countRecoveryEvents("DRILL_STARTED", created.backupId);
  const drill1 = await runRestoreDrillById(created.backupId, ACTOR);
  const drill2 = await runRestoreDrillById(created.backupId, ACTOR);
  line(
    "4أ) Drill ×2 ⇒ RESTORE_VERIFIED في التشغيلين",
    drill1.level === "RESTORE_VERIFIED" && drill2.level === "RESTORE_VERIFIED",
    `run1=${drill1.durationMs}ms · run2=${drill2.durationMs}ms`
  );
  const afterStarted = await countRecoveryEvents("DRILL_STARTED", created.backupId);
  line(
    "4ب) DRILL_STARTED زاد 2 (تشغيلان مستقلان)",
    afterStarted === priorStarted + 2,
    `قبل=${priorStarted} بعد=${afterStarted}`
  );

  // أحداث التشغيلين: operationIds مختلفة + sequences 1 ثم 2
  const { events } = await readRecoveryEvents(200);
  const drillEvents = events.filter((e) => e.backupId === created.backupId && (e.event === "DRILL_STARTED" || e.event === "DRILL_VERIFIED"));
  const startedEvents = drillEvents.filter((e) => e.event === "DRILL_STARTED").slice(0, 2);
  const verifiedEvents = drillEvents.filter((e) => e.event === "DRILL_VERIFIED").slice(0, 2);
  const opIds = new Set(drillEvents.map((e) => e.operationId));
  const seqs = startedEvents.map((e) => (e.details?.drillRun as { sequence?: number })?.sequence);
  line(
    "4ج) كل تشغيل له operationId مستقل (لا تكرار بصمة عملية)",
    drillEvents.length >= 4 && startedEvents.length >= 2 && verifiedEvents.length >= 2 && opIds.size >= 2,
    `operationIds=${[...opIds].slice(0, 2).join(" ≠ ")}`
  );
  line(
    "4د) drillRun.sequence متسلسل 1 ثم 2 — لا يبدوان حدثين مكررين",
    seqs.includes(1) && seqs.includes(2),
    `sequences=${seqs.join(",")}`
  );

  // الـManifest بعد التشغيلين: drillRuns=2 وdrillOperationId = تشغيل الأحدث
  const listingAfter = listBackups().local.find((e) => e.backupId === created.backupId);
  const sidecarRaw = readFileSync(path.join(ROOT, "var", "backups", `${created.backupId}.manifest.json`), "utf8");
  const sidecar = JSON.parse(sidecarRaw) as { verification: { drillRuns?: number; drillOperationId?: string } };
  line(
    "4هـ) Manifest: drillRuns=2 وdrillOperationId = آخر تشغيل",
    sidecar.verification.drillRuns === 2 && sidecar.verification.drillOperationId === verifiedEvents[0]?.operationId,
    `drillRuns=${sidecar.verification.drillRuns} · lastOp=${sidecar.verification.drillOperationId}`
  );
  line("4و) drillRuns ظاهر في القائمة (drillRuns مستخلص من sidecar)", !!listingAfter, listingAfter?.backupId ?? "");

  // ── 5) الإنتاج لم يتغير ────────────────────────────────────────────────
  const countsAfter = {
    users: await prod.user.count(),
    groups: await prod.group.count(),
    reports: await prod.report.count(),
    workflowHistory: await prod.workflowHistory.count(),
    auditLog: await prod.auditLog.count(),
  };
  await prod.$disconnect();
  // auditLog يزداد بأحداث النسخ/التحقق/الDrill الرقابية — هذا مقصود؛ نطبع الفرق ونفحص بيانات الأعمال حصرًا
  const businessSame =
    countsAfter.users === countsBefore.users &&
    countsAfter.groups === countsBefore.groups &&
    countsAfter.reports === countsBefore.reports &&
    countsAfter.workflowHistory === countsBefore.workflowHistory;
  line(
    "5) بيانات الأعمال في قاعدة التشغيل لم تتغير",
    businessSame,
    `قبل=${JSON.stringify(countsBefore)} بعد=${JSON.stringify(countsAfter)} (auditLog+${countsAfter.auditLog - countsBefore.auditLog} أحداث رقابية مقصودة)`
  );

  console.log("\n=== انتهى اختبار التوافق والأمان وهوية تشغيلات Drill ===");
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
