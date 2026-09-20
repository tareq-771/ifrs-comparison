// Phase 4A.1 — بوابة migrate resolve --applied 0_init على قاعدة التشغيل.
//
// شرط المستخدم الحرفي: التنفيذ فقط بعد تحقق كل ما يلي (فشل أي بند = إلغاء دون resolve):
//   1) نسخة احتياطية جديدة (v3) للإنتاج.
//   2) Validation ناجح لها.
//   3) Restore Drill بنتيجة RESTORE_VERIFIED (مؤقتة معزولة — لا يمس الإنتاج).
//   4) integrity_check = ok على قاعدة التشغيل.
//   5) إثبات canonical equality: canonical(fresh من migrations) == canonical(production) == الثابت المثبّت.
//
// بعد resolve: migrate status clean + لا DDL على أي جدول أعمال (البصمة الفيزيائية
// للكائنات الدلالية لا تتغير — _prisma_migrations مستبعدة من البصمتين) + بيانات
// الأعمال كما هي + أدلة JSONL/JSON خارج القاعدة.
//
// ⛔ لا استعادة إنتاج ولا swap ولا صيانة ولا Session Epoch — هذا كله 4B محظور في 4A.1.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { db as liveDb } from "@/lib/db";
import { createBackup, runRestoreDrillById } from "@/lib/backup-server";
import { PINNED_CURRENT_CANONICAL_FINGERPRINT } from "@/lib/backup-config";
import { canonicalSchemaFingerprint, physicalSchemaFingerprint } from "@/lib/schema-fingerprint";

const ROOT = "/home/z/my-project";
const TMP = path.join(ROOT, "var", "tmp-41");
const BUILT = path.join(TMP, "gate-fresh.db");
const PROD = path.join(ROOT, "db", "custom.db");
const ACTOR = { id: null as string | null, username: "system-4a1-governance" };

function line(title: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${title}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function run(args: string[], env?: Record<string, string>): Promise<{ exit: number; out: string; err: string }> {
  const p = Bun.spawn(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(env ?? {}) } });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  const exit = await p.exited;
  return { exit, out, err };
}

async function main() {
  console.log("=== Phase 4A.1 — بوابة migrate resolve --applied 0_init ===\n");
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true, mode: 0o700 });

  const prod = new PrismaClient({ datasources: { db: { url: `file:${PROD}` } }, log: [] });

  const countsBefore = {
    users: await prod.user.count(),
    groups: await prod.group.count(),
    reports: await prod.report.count(),
    workflowHistory: await prod.workflowHistory.count(),
    auditLog: await prod.auditLog.count(),
  };
  const physicalBefore = await physicalSchemaFingerprint(prod);
  const canonicalProd = await canonicalSchemaFingerprint(prod);

  // ── البوابة ─────────────────────────────────────────────────────────────
  let gates = true;

  const integ0 = (await prod.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`))[0]?.integrity_check;
  line("بوابة 4: integrity_check على الإنتاج", integ0 === "ok", String(integ0));
  gates = gates && integ0 === "ok";

  // 1+2) نسخة جديدة v3 + تحقق تلقائي
  const created = await createBackup(ACTOR);
  const createdOk = created.level === "VALIDATED" && created.manifest.formatVersion === 3;
  line("بوابة 1+2: نسخة جديدة v3 + VALIDATED تلقائي", createdOk, `${created.backupId} · level=${created.level}`);
  gates = gates && createdOk;

  // 3) Drill بنتيجة RESTORE_VERIFIED
  const drill = await runRestoreDrillById(created.backupId, ACTOR);
  line("بوابة 3: Restore Drill ⇒ RESTORE_VERIFIED (مؤقتة معزولة)", drill.level === "RESTORE_VERIFIED", `${drill.durationMs}ms · prismaReads=${drill.prismaReadTests.length}`);
  gates = gates && drill.level === "RESTORE_VERIFIED";

  // 5) canonical equality (بناء fresh من migrations الآن)
  if (existsSync(BUILT)) rmSync(BUILT);
  const deploy = await run(["bunx", "prisma", "migrate", "deploy"], { DATABASE_URL: `file:${BUILT}` });
  if (deploy.exit !== 0) {
    line("بوابة 5: بناء fresh من migrations", false, deploy.out + deploy.err);
    gates = false;
  } else {
    const fresh = new PrismaClient({ datasources: { db: { url: `file:${BUILT}` } }, log: [] });
    const canonicalFresh = await canonicalSchemaFingerprint(fresh);
    await fresh.$disconnect();
    const eq = canonicalFresh === canonicalProd && canonicalProd === PINNED_CURRENT_CANONICAL_FINGERPRINT;
    line("بوابة 5: canonical(fresh) == canonical(production) == الثابت المثبّت", eq, canonicalProd.slice(0, 28) + "…");
    gates = gates && eq;
  }

  // حالة ما قبل resolve (أدلة)
  const statusBefore = await run(["bunx", "prisma", "migrate", "status"], { DATABASE_URL: `file:${PROD}` });
  console.log("── prisma migrate status (قبل resolve) ──");
  console.log(statusBefore.out.trim() || statusBefore.err.trim());
  console.log("──────────────────────────────────────────");

  if (!gates) {
    console.log("\n⛔ فشلت بوابة واحدة أو أكثر — لم يُنفَّذ resolve إطلاقًا (سلوك fail-closed).");
    await prod.$disconnect();
    process.exit(1);
  }

  // قطع كل اتصالات Prisma بقاعدة التشغيل قبل resolve — درس موثق: أي اتصال حي
  // (حتى الخامل: عميل lib/db العام القادم عبر backup-server أو العميل المحلي)
  // يجعل schema engine يفشل بـ«database is locked».
  await prod.$disconnect();
  await liveDb.$disconnect();
  let prod2: PrismaClient | null = null;

  // ── التنفيذ: resolve فقط — لا أي DDL ────────────────────────────────────
  console.log("\n→ تنفيذ: prisma migrate resolve --applied 0_init (على قاعدة التشغيل)");
  const resolve = await run(["bunx", "prisma", "migrate", "resolve", "--applied", "0_init"], { DATABASE_URL: `file:${PROD}` });
  line(
    "prisma migrate resolve --applied 0_init",
    resolve.exit === 0,
    resolve.exit === 0 ? resolve.out.trim().split("\n").slice(-3).join(" | ") : `${resolve.out}\n${resolve.err}`
  );

  // الحالة بعده
  const statusAfter = await run(["bunx", "prisma", "migrate", "status"], { DATABASE_URL: `file:${PROD}` });
  console.log("── prisma migrate status (بعد resolve) ──");
  console.log(statusAfter.out.trim() || statusAfter.err.trim());
  console.log("──────────────────────────────────────────");
  const statusClean = statusAfter.exit === 0 && /up to date/i.test(statusAfter.out + statusAfter.err);
  line("migrate status clean بعد resolve", statusClean, `exit=${statusAfter.exit}`);

  // الحالة بعده — إعادة الاتصال بعد اكتمال resolve
  prod2 = new PrismaClient({ datasources: { db: { url: `file:${PROD}` } }, log: [] });
  // ملاحظة: Prisma 6 يستخدم rolled_back_at (وليس rolled_back). applied_steps_count=0
  // مع resolve --applied هو الدليل القاطع: صف علامة حصرًا — صفر خطوات DDL نُفذت.
  const migRow = await prod2.$queryRawUnsafe<{ migration_name: string; rolled_back_at: string | null; finished_at: Date | null }[]>(
    `SELECT migration_name, rolled_back_at, finished_at FROM _prisma_migrations`
  );
  line(
    "_prisma_migrations: صف واحد 0_init مكتمل غير مرجوع",
    migRow.length === 1 && migRow[0].migration_name === "0_init" && migRow[0].rolled_back_at === null && migRow[0].finished_at !== null,
    JSON.stringify(migRow.map((r) => ({ m: r.migration_name, rolledBackAt: r.rolled_back_at })))
  );

  const physicalAfter = await physicalSchemaFingerprint(prod2);
  const canonicalAfter = await canonicalSchemaFingerprint(prod2);
  line("لا أي DDL على جداول الأعمال (البصمة الفيزيائية قبل/بعد متطابقة)", physicalAfter === physicalBefore, "لا إعادة بناء ولا تعديل أعمدة");
  line("الهوية القاعدية الدلالية لم تتغير بعد resolve", canonicalAfter === canonicalProd && canonicalAfter === PINNED_CURRENT_CANONICAL_FINGERPRINT, canonicalAfter.slice(0, 28) + "…");

  const integ1 = (await prod2.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`))[0]?.integrity_check;
  line("integrity_check بعد resolve", integ1 === "ok", String(integ1));

  const countsAfter = {
    users: await prod2.user.count(),
    groups: await prod2.group.count(),
    reports: await prod2.report.count(),
    workflowHistory: await prod2.workflowHistory.count(),
    auditLog: await prod2.auditLog.count(),
  };
  line(
    "بيانات الأعمال لم تتغير",
    countsAfter.users === countsBefore.users && countsAfter.groups === countsBefore.groups && countsAfter.reports === countsBefore.reports && countsAfter.workflowHistory === countsBefore.workflowHistory,
    `auditLog+${countsAfter.auditLog - countsBefore.auditLog} (أحداث النسخ/Drill الرقابية)`
  );

  await prod2?.$disconnect();
  const evidencePath = path.join(ROOT, "var", "recovery", `baseline-resolution-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        phase: "4A.1",
        action: "migrate resolve --applied 0_init",
        actor: ACTOR.username,
        preGateBackupId: created.backupId,
        drillLevel: drill.level,
        canonicalFingerprint: canonicalProd,
        pinned: PINNED_CURRENT_CANONICAL_FINGERPRINT,
        physicalBefore,
        physicalAfter,
        statusBefore: statusBefore.out.trim(),
        statusAfter: statusAfter.out.trim(),
        migrationsTable: migRow,
        integrityAfter: integ1,
        businessCounts: countsAfter,
        at: new Date().toISOString(),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  line("أدلة resolve محفوظة خارج القاعدة", existsSync(evidencePath), path.basename(evidencePath));

  console.log("\n=== البوابة انتهت — Baseline مغلق: الإنتاج مُسجّل عند 0_init بلا أي DDL ===");
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
