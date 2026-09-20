// Phase 4A.1 — توثيق بعد-الحالة لعملية migrate resolve (الأدلة الرسمية).
//
// سلسلة الأدلة الكاملة:
//   1) تشغيل بوابة phase41-resolve-baseline.ts (bk-20260920T084831Z-z4t3l5):
//      نسخة جديدة v3 + VALIDATED تلقائي + Drill ⇒ RESTORE_VERIFIED + integrity ok
//      + canonical(fresh)==canonical(production)==الثابت المثبّت — كلها ✅.
//   2) prisma migrate resolve --applied 0_init ⇒ "Migration 0_init marked as applied."
//   3) prisma migrate status ⇒ "Database schema is up to date!" (exit=0).
// هذا السكربت يلتقط الحالة البعدية ويكتب ملف الأدلة JSON خارج القاعدة
// (var/recovery/ — بجانب سجل الاسترجاع، لا يلمس JSONL المعرّف).

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PINNED_CURRENT_CANONICAL_FINGERPRINT } from "@/lib/backup-config";
import { canonicalSchemaFingerprint, physicalSchemaFingerprint } from "@/lib/schema-fingerprint";

const ROOT = "/home/z/my-project";
const PROD = path.join(ROOT, "db", "custom.db");
const GATE_BACKUP_ID = "bk-20260920T084831Z-z4t3l5";

function line(title: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${title}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const prod = new PrismaClient({ datasources: { db: { url: `file:${PROD}` } }, log: [] });

  const integ = (await prod.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`))[0]?.integrity_check;
  line("integrity_check على قاعدة التشغيل", integ === "ok", String(integ));

  const migRow = await prod.$queryRawUnsafe<{
    migration_name: string;
    rolled_back_at: string | null;
    finished_at: string | null;
    applied_steps_count: number;
    checksum: string;
  }[]>(`SELECT migration_name, rolled_back_at, finished_at, applied_steps_count, checksum FROM _prisma_migrations`);
  const row = migRow[0];
  line(
    "_prisma_migrations: صف واحد 0_init مكتمل غير مرجوع",
    migRow.length === 1 && row.migration_name === "0_init" && row.rolled_back_at === null && row.finished_at !== null,
    `applied_steps_count=${Number(row.applied_steps_count)} (صفر خطوات DDL — صف علامة حصرًا)`
  );

  const canonical = await canonicalSchemaFingerprint(prod);
  const physical = await physicalSchemaFingerprint(prod);
  line(
    "الهوية القاعدية الدلالية = الثابت المثبّت (لم تتغير بresolve)",
    canonical === PINNED_CURRENT_CANONICAL_FINGERPRINT,
    canonical
  );

  const counts = {
    users: await prod.user.count(),
    groups: await prod.group.count(),
    reports: await prod.report.count(),
    workflowHistory: await prod.workflowHistory.count(),
    auditLog: await prod.auditLog.count(),
  };
  line("بيانات الأعمال كما هي (لا استعادة ولا تعديل)", counts.users === 1 && counts.groups === 0 && counts.reports === 0, JSON.stringify(counts));
  await prod.$disconnect();

  const evidence = {
    phase: "4A.1",
    action: "migrate resolve --applied 0_init",
    gateBackupId: GATE_BACKUP_ID,
    gateResults: {
      newBackupV3: "bk-20260920T084831Z-z4t3l5 VALIDATED",
      drill: "RESTORE_VERIFIED (35ms, prismaReads=5, temp-isolated)",
      integrityCheck: "ok",
      canonicalEquality: "canonical(fresh from migrations) == canonical(production) == pinned",
    },
    resolveOutput: "Migration 0_init marked as applied.",
    migrateStatusAfter: "Database schema is up to date! (exit=0)",
    migrationsTableRow: {
      migration_name: row.migration_name,
      checksum: row.checksum,
      finished_at: row.finished_at,
      applied_steps_count: Number(row.applied_steps_count),
      rolled_back_at: row.rolled_back_at,
    },
    canonicalFingerprint: canonical,
    pinnedFingerprint: PINNED_CURRENT_CANONICAL_FINGERPRINT,
    physicalFingerprintAfter: physical,
    businessCounts: counts,
    integrityAfter: integ,
    lockedLessonsLearned: [
      "أي اتصال Prisma حي بقاعدة التشغيل (حتى الخامل) يجعل schema engine يفشل بـ database is locked — يجب قطع الكل قبل resolve",
      "Prisma 6: عمود الجدول rolled_back_at وليس rolled_back",
    ],
    at: new Date().toISOString(),
  };
  const evidencePath = path.join(ROOT, "var", "recovery", `baseline-resolution-2026-09-20T08-48-34.json`);
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  line("ملف الأدلة خارج القاعدة مكتوب", existsSync(evidencePath), path.basename(evidencePath));
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
