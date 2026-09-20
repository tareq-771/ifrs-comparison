// Phase 4A.1 — تدقيق حالة لاحق: نتائج اختبار التوافق مأخوذة من الأقراص/السجلات نفسها
// (بدل إعادة تشغيل اختبار التوافق الذي ينشئ نسخًا جديدة في كل مرة).

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { listBackups } from "@/lib/backup-server";
import { PINNED_CURRENT_CANONICAL_FINGERPRINT } from "@/lib/backup-config";
import { readRecoveryEvents } from "@/lib/recovery-log";

const ROOT = "/home/z/my-project";
const BACKUPS = path.join(ROOT, "var", "backups");

function line(title: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${title}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const listing = listBackups().local;
  const v3 = listing.filter((e) => e.manifestFormat === 3);
  const v2 = listing.filter((e) => e.manifestFormat === 2);
  const invalid = listing.filter((e) => e.level === "INVALID");
  line("القائمة: 4 نسخ (3 v2 إرث + 1 v3) وبلا أي INVALID", v2.length === 3 && v3.length === 1 && invalid.length === 0,
    v3.map((e) => `${e.backupId}(v3,${e.level})`).concat(v2.map((e) => `${e.backupId}(v2,${e.level})`)).join(" · "));

  // لا ترقية صامتة: sidecars القديمة بقيت formatVersion 2
  const v2Raw = v2.map((e) => JSON.parse(readFileSync(path.join(BACKUPS, `${e.backupId}.manifest.json`), "utf8")) as { formatVersion: number; verification: { level: string } });
  line("Legacy v2 بقيت formatVersion=2 على القرص (لا ترقية صامتة)", v2Raw.every((m) => m.formatVersion === 2), v2Raw.map((m) => `fv=${m.formatVersion}/${m.verification.level}`).join(" · "));

  // النسخة الجديدة v3: canonical مضمّن ومطابق للثابت
  const v3Entry = v3[0];
  const v3Manifest = v3Entry
    ? (JSON.parse(readFileSync(path.join(BACKUPS, `${v3Entry.backupId}.manifest.json`), "utf8")) as {
        formatVersion: number;
        canonicalSchemaFingerprint: string;
        verification: { level: string; drillRuns?: number };
      })
    : null;
  line(
    "النسخة v3: canonical مضمّن = الثابت المثبّت + level=RESTORE_VERIFIED + drillRuns=2",
    !!v3Manifest &&
      v3Manifest.formatVersion === 3 &&
      v3Manifest.canonicalSchemaFingerprint === PINNED_CURRENT_CANONICAL_FINGERPRINT &&
      v3Manifest.verification.level === "RESTORE_VERIFIED" &&
      v3Manifest.verification.drillRuns === 2,
    v3Manifest ? `drillRuns=${v3Manifest.verification.drillRuns}` : "مفقودة"
  );

  // أحداث التوافق في سجل الاسترجاع: 3 إعادة تحقق للنسخ القديمة + Drill مزدوج
  const { events } = await readRecoveryEvents(500);
  const revalidations = events.filter((e) => e.event === "BACKUP_VALIDATED" && e.details?.source === "local");
  const v2Ids = new Set(v2.map((e) => e.backupId));
  const revalidatedV2 = revalidations.filter((e) => e.backupId && v2Ids.has(e.backupId));
  line("أحداث BACKUP_VALIDATED للنسخ legacy v2 مسجلة", revalidatedV2.length >= 3, `${revalidatedV2.length} حدث`);

  const drillOps = new Set(events.filter((e) => e.event === "DRILL_VERIFIED" && e.backupId === v3Entry?.backupId).map((e) => e.operationId));
  line("DRILL_VERIFIED ×2 بنفس backupId وoperationId مختلفة", drillOps.size === 2, [...drillOps].join(" ≠ "));

  // سلامة الإنتاج
  const prod = new PrismaClient({ datasources: { db: { url: `file:${ROOT}/db/custom.db` } }, log: [] });
  const integ = await prod.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`);
  const counts = {
    users: await prod.user.count(),
    groups: await prod.group.count(),
    reports: await prod.report.count(),
    workflowHistory: await prod.workflowHistory.count(),
  };
  await prod.$disconnect();
  line("قاعدة التشغيل: integrity ok وبيانات الأعمال كما هي", (integ[0]?.integrity_check ?? "") === "ok" && counts.users === 1 && counts.reports === 0 && counts.groups === 0, JSON.stringify(counts));

  // بقايا التلاعب انتهت
  line("لا بقايا ملفات تلاعب في var/tmp-41", !existsSync(path.join(ROOT, "var/tmp-41/tampered-v3.zip")) && !existsSync(path.join(ROOT, "var/tmp-41/tampered-v2.zip")), "نُظفت");
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
