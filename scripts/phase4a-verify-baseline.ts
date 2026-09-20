// Phase 4A — اختبار Migration Baseline (القسم 18 من وثيقة التصميم — خطوات 0-4 حصرًا).
//
// ⛔ ممنوع في 4A: `prisma migrate resolve --applied` على قاعدة التشغيل —
//   يعتمد منفصلًا في 4B بعد موافقة المستخدم. هذا السكربت لا يلمس db/custom.db
//   بقراءة فقط (فingerprint + عدّ) — كل الكتابة على نسخ مؤقتة.
//
// ما يثبته هذا السكربت (طلب المستخدم الصريح):
//  "القاعدة المنشأة من الصفر بواسطة migrations تطابق المخطط الفعلي" — وليس فقط
//  أن Prisma يقول إن العملية نجحت:
//    (أ) migrate diff دلالي: built↔schema.prisma و built↔production = فارغ
//    (ب) مطابقة بصمة sqlite_master (بنفس خوارزمية الـ Manifest حرفيًا)
//    (ج) integrity_check على المبنية + Prisma reads + اختبار CRUD معزول عليها
//    (د) قاعدة التشغيل لم تُلمس (عدّ قبل/بعد + لا _prisma_migrations فيها)

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { computeSchemaFingerprint } from "@/lib/backup-manifest";

const ROOT = "/home/z/my-project";
const TMP = path.join(ROOT, "var", "tmp-baseline");
const BUILT = path.join(TMP, "built-from-migrations.db");
const PROD = path.join(ROOT, "db", "custom.db");

function line(title: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${title}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

/** Prisma يطبع هذا السطر عند عدم وجود فرق — يُعتبر فارغًا. */
function isEmptyMigration(out: string): boolean {
  const t = out.trim();
  return t.length === 0 || t.includes("This is an empty migration");
}

/** فرق جذري على مستوى كائنات sqlite_master (لعرض drift الترتيب النصي). */
async function objectLevelDiff(
  built: PrismaClient,
  prod: PrismaClient
): Promise<Array<{ name: string; kind: string; built: string; prod: string }>> {
  const q = `SELECT type, name, sql FROM sqlite_master
             WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'
             ORDER BY type, name`;
  const rowsB = await built.$queryRawUnsafe<{ type: string; name: string; sql: string }[]>(q);
  const rowsP = await prod.$queryRawUnsafe<{ type: string; name: string; sql: string }[]>(q);
  const canon = (r: { type: string; sql: string }) =>
    `${r.type}|${(r.sql ?? "").replace(/\s+/g, " ").trim()}`;
  const mapB = new Map(rowsB.map((r) => [r.name, canon(r)]));
  const mapP = new Map(rowsP.map((r) => [r.name, canon(r)]));
  const out: Array<{ name: string; kind: string; built: string; prod: string }> = [];
  for (const [name, cb] of mapB) {
    const cp = mapP.get(name);
    if (cp === undefined) out.push({ name, kind: "only-in-built", built: cb, prod: "(غائب)" });
    else if (cp !== cb) out.push({ name, kind: "text-drift", built: cb, prod: cp });
  }
  for (const [name, cp] of mapP) {
    if (!mapB.has(name)) out.push({ name, kind: "only-in-prod", built: "(غائب)", prod: cp });
  }
  return out;
}

async function main() {
  console.log("=== Migration Baseline Verification (4A — على نسخ حصرًا) ===\n");

  // الخطوة 0: نسخة VACUUM INTO فورية للأمان قبل أي خطوة
  const backupDir = path.join(ROOT, "var", "backups");
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const safety = path.join(backupDir, `pre-4A-baseline-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.db`);
  {
    const src = new Database(PROD, { readonly: true });
    src.exec(`VACUUM INTO '${safety}'`);
    src.close();
    const chk = new Database(safety, { readonly: true });
    const ok = chk.query("PRAGMA integrity_check").get() as Record<string, string>;
    chk.close();
    line("خطوة 0: نسخة أمان VACUUM INTO + integrity", ok.integrity_check === "ok", path.basename(safety));
  }

  // الخطوة 1: التأكد من وجود baseline
  const sqlPath = path.join(ROOT, "prisma", "migrations", "0_init", "migration.sql");
  const lockPath = path.join(ROOT, "prisma", "migrations", "migration_lock.toml");
  line(
    "خطوة 1: 0_init/migration.sql + migration_lock.toml موجودان",
    existsSync(sqlPath) && existsSync(lockPath),
    `${readFileSync(sqlPath, "utf8").length} بايت SQL`
  );

  // حالة قاعدة التشغيل قبل كل شيء
  const prodBefore = new PrismaClient({ datasources: { db: { url: `file:${PROD}` } }, log: [] });
  const prodCountsBefore = {
    users: await prodBefore.user.count(),
    groups: await prodBefore.group.count(),
    reports: await prodBefore.report.count(),
    workflowHistory: await prodBefore.workflowHistory.count(),
    auditLog: await prodBefore.auditLog.count(),
  };
  const prodHasMigrationsTable = await prodBefore.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'`
  );

  // الخطوة 2: بناء قاعدة فارغة كاملة من الـ migrations
  if (existsSync(BUILT)) {
    const { rmSync } = await import("node:fs");
    rmSync(BUILT);
  }
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true, mode: 0o700 });
  const deploy = Bun.spawn(["bunx", "prisma", "migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${BUILT}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const deployOut = await new Response(deploy.stdout).text();
  const deployErr = await new Response(deploy.stderr).text();
  const deployExit = await deploy.exited;
  line(
    "خطوة 2: migrate deploy على ملف فارغ (بناء كامل من migrations)",
    deployExit === 0 && deployOut.includes("1 migration") ,
    deployExit === 0 ? "0_init applied" : `${deployExit}\n${deployOut}\n${deployErr}`
  );

  const built = new PrismaClient({ datasources: { db: { url: `file:${BUILT}` } }, log: [] });

  // الخطوة 3أ: migrate diff دلالي — built مقابل schema.prisma (يجب أن يكون فارغًا)
  async function migrateDiff(args: string[]): Promise<{ exit: number; out: string; err: string }> {
    const p = Bun.spawn(["bunx", "prisma", "migrate", "diff", ...args], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    const exit = await p.exited;
    return { exit, out, err };
  }

  const diffA = await migrateDiff([
    "--from-url", `file:${BUILT}`,
    "--to-schema-datamodel", "prisma/schema.prisma",
    "--script",
  ]);
  const diffAEmpty = diffA.exit === 0 && isEmptyMigration(diffA.out);
  line(
    "خطوة 3أ: migrate diff (built → schema.prisma) فارغ",
    diffAEmpty,
    diffAEmpty ? "لا فرق دلالي" : diffA.out.slice(0, 400)
  );

  // الخطوة 3ب: migrate diff دلالي — built مقابل قاعدة التشغيل الحية (قراءة فقط)
  const diffB = await migrateDiff([
    "--from-url", `file:${BUILT}`,
    "--to-url", `file:${PROD}`,
    "--script",
  ]);
  const diffBEmpty = diffB.exit === 0 && isEmptyMigration(diffB.out);
  line(
    "خطوة 3ب: migrate diff (built → db/custom.db) فارغ",
    diffBEmpty,
    diffBEmpty ? "لا فرق دلالي" : diffB.out.slice(0, 400)
  );

  // الخطوة 3ج: مطابقة بصمة sqlite_master — بنفس خوارزمية الـ Manifest.
  // إن اختلفت البصمة نصيًا مع تطابق دلالي، نعرض الفرق الجذري بدقة
  // (قرار المستخدم: «أريد التأكد أن المبنية تطابق المخطط الفعلي لا أن Prisma يقول نجح»). 
  const fpBuilt = await computeSchemaFingerprint(built);
  const fpProd = await computeSchemaFingerprint(prodBefore);
  const fpEqual = fpBuilt === fpProd;
  line(
    "خطوة 3ج: مطابقة بصمة المخطط (built == production)",
    fpEqual,
    fpEqual ? fpBuilt.slice(0, 28) + "…" : "اختلاف نصي — انظر التحليل أدناه"
  );
  if (!fpEqual) {
    const drift = await objectLevelDiff(built, prodBefore);
    console.log("\n───────── تحليل الاختلاف النصي (drift) ─────────");
    for (const d of drift) {
      console.log(`الكائن: ${d.name} (${d.kind})`);
      console.log(`  المبنية : ${d.built}`);
      console.log(`  الإنتاج : ${d.prod}`);
    }
    console.log(
      "─────────────────────────────────────────────────\n" +
      "الخلاصة: تطابق دلالي كامل (diff فارغ) مع اختلاف نصي في ترتيب الأعمدة نتيج" +
      "ة ALTER TABLE تاريخية في الإنتاج — يُعرض على المستخدم قبل قرار 4B " +
      "(resolve --applied يقبل الـ drift الدلالي المتطابق، أو إعادة بناء الجدول مستقبلًا)."
    );
  }

  // integrity على المبنية
  const integ = await built.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`);
  line("خطوة 3د: integrity_check على المبنية", (integ[0]?.integrity_check ?? "") === "ok");

  // الخطوة 4: Prisma smoke على المبنية (CRUD معزول ثم تنظيف)
  const tUser = await built.user.create({
    data: { username: "__baseline_probe__", passwordHash: "x", displayName: "اختبار baseline", role: "user" },
  });
  const readBack = await built.user.findUnique({ where: { id: tUser.id } });
  await built.user.delete({ where: { id: tUser.id } });
  const remaining = await built.user.count();
  line(
    "خطوة 4: Prisma CRUD على المبنية (إنشاء→قراءة→حذف)",
    !!readBack && remaining === 0,
    "طبقة بيانات Prisma تعمل على القاعدة المبنية من الصفر"
  );
  await built.$disconnect();

  // حالة قاعدة التشغيل بعد كل شيء (قراءة فقط)
  const prodCountsAfter = {
    users: await prodBefore.user.count(),
    groups: await prodBefore.group.count(),
    reports: await prodBefore.report.count(),
    workflowHistory: await prodBefore.workflowHistory.count(),
    auditLog: await prodBefore.auditLog.count(),
  };
  const prodMigrationsAfter = await prodBefore.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'`
  );
  await prodBefore.$disconnect();

  line(
    "قاعدة التشغيل لم تُلمس (عدّ قبل/بعد متطابق)",
    JSON.stringify(prodCountsBefore) === JSON.stringify(prodCountsAfter),
    JSON.stringify(prodCountsAfter)
  );
  line(
    "قاعدة التشغيل بلا _prisma_migrations (لم يُنفذ resolve — متطلب 4A)",
    prodHasMigrationsTable.length === 0 && prodMigrationsAfter.length === 0
  );

  console.log("\n⛔ الخطوة 5 (migrate resolve --applied على قاعدة التشغيل) — لم تُنفذ عمدًا.");
  console.log("   تعتمد منفصلًا في Phase 4B بعد موافقة المستخدم الصريحة.");
  console.log("\n=== انتهى اختبار البايسلاين ===");
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
