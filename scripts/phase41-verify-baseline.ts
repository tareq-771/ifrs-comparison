// Phase 4A.1 — إغلاق Migration Baseline: إثبات التكافؤ الدلالي الثلاثي.
//
// قرار المستخدم (4A.1): الاختلاف الحالي في ترتيب عمودي Report.dueDate و
// Report.reviewStartedAt يُقبل Physical/Textual Drift موثقًا — وليس Semantic
// Schema Drift — بشرط إعادة إثبات أن prisma migrate diff بين الثلاثة فارغ:
//   1) Production ↔ schema.prisma
//   2) Fresh-migrated DB ↔ schema.prisma
//   3) Production ↔ Fresh-migrated DB
// ولا يُعاد بناء جدول Report فقط لتغيير ترتيب الأعمدة.
//
// ويثبت السكربت جوهر canonical schema identity:
//   canonicalFingerprint(fresh) == canonicalFingerprint(production)
//   حتى لو physicalFingerprint(fresh) != physicalFingerprint(production)
// — هذه بالضبط الحالة المطلوبة: هوية دلالية واحدة رغم اختلاف فيزيائي موثق.
//
// هذا السكربت قراءة على الإنتاج حصرًا (VACUUM INTO أمان + fingerprint + عدّ) —
// كل البناء والكتابة على نسخ مؤقتة في var/tmp-41.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { canonicalSchemaFingerprint, physicalSchemaFingerprint } from "@/lib/schema-fingerprint";

const ROOT = "/home/z/my-project";
const TMP = path.join(ROOT, "var", "tmp-41");
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

/** مواقع أعمدة Report الفعلية في كل قاعدة — توثيق الـdrift الفيزيائي بدقة. */
function reportColumnPositions(dbPath: string, names: string[]): Map<string, number> {
  const d = new Database(dbPath, { readonly: true });
  const cols = d.query("PRAGMA table_info(Report)").all() as Array<{ name: string }>;
  d.close();
  const map = new Map<string, number>();
  cols.forEach((c, i) => map.set(c.name, i));
  return new Map(names.map((n) => [n, map.get(n) ?? -1]));
}

async function main() {
  console.log("=== Phase 4A.1 — Migration Baseline Closure & Canonical Schema Identity ===\n");

  // الخطوة 0: نسخة أمان VACUUM INTO فورية
  const backupDir = path.join(ROOT, "var", "backups");
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const safety = path.join(backupDir, `pre-4A1-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.db`);
  {
    const src = new Database(PROD, { readonly: true });
    src.exec(`VACUUM INTO '${safety}'`);
    src.close();
    const chk = new Database(safety, { readonly: true });
    const ok = (chk.query("PRAGMA integrity_check").get() as Record<string, string>).integrity_check;
    chk.close();
    line("خطوة 0: نسخة أمان VACUUM INTO + integrity", ok === "ok", path.basename(safety));
  }

  // حالة الإنتاج قبل كل شيء
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true, mode: 0o700 });
  const prod = new PrismaClient({ datasources: { db: { url: `file:${PROD}` } }, log: [] });
  const prodCountsBefore = {
    users: await prod.user.count(),
    groups: await prod.group.count(),
    reports: await prod.report.count(),
    workflowHistory: await prod.workflowHistory.count(),
    auditLog: await prod.auditLog.count(),
  };

  // الخطوة 1: بناء قاعدة فارغة كاملة من prisma/migrations/0_init
  if (existsSync(BUILT)) rmSync(BUILT);
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
    "خطوة 1: قاعدة فارغة ← prisma migrate deploy (بناء كامل من 0_init)",
    deployExit === 0 && deployOut.includes("1 migration"),
    deployExit === 0 ? path.basename(BUILT) : `${deployExit}\n${deployOut}\n${deployErr}`
  );

  const fresh = new PrismaClient({ datasources: { db: { url: `file:${BUILT}` } }, log: [] });

  // الخطوة 2: الفروق الدلالية الثلاثة (يجب أن تكون فارغة كلها)
  const diff1 = await migrateDiff(["--from-url", `file:${PROD}`, "--to-schema-datamodel", "prisma/schema.prisma", "--script"]);
  const d1Empty = diff1.exit === 0 && isEmptyMigration(diff1.out);
  line("خطوة 2أ: migrate diff (Production → schema.prisma) فارغ", d1Empty, d1Empty ? "لا فرق دلالي" : diff1.out.slice(0, 500));

  const diff2 = await migrateDiff(["--from-url", `file:${BUILT}`, "--to-schema-datamodel", "prisma/schema.prisma", "--script"]);
  const d2Empty = diff2.exit === 0 && isEmptyMigration(diff2.out);
  line("خطوة 2ب: migrate diff (Fresh-migrated → schema.prisma) فارغ", d2Empty, d2Empty ? "لا فرق دلالي" : diff2.out.slice(0, 500));

  const diff3 = await migrateDiff(["--from-url", `file:${PROD}`, "--to-url", `file:${BUILT}`, "--script"]);
  const d3Empty = diff3.exit === 0 && isEmptyMigration(diff3.out);
  line("خطوة 2ج: migrate diff (Production → Fresh-migrated) فارغ", d3Empty, d3Empty ? "لا فرق دلالي" : diff3.out.slice(0, 500));

  // الخطوة 3: البصمة القاعدية الدلالية — جوهر 4A.1
  const canonicalProd = await canonicalSchemaFingerprint(prod);
  const canonicalFresh = await canonicalSchemaFingerprint(fresh);
  const canonicalEqual = canonicalProd === canonicalFresh;
  line(
    "خطوة 3أ: canonicalFingerprint(fresh) == canonicalFingerprint(production)",
    canonicalEqual,
    canonicalEqual ? canonicalProd : `${canonicalFresh} ≠ ${canonicalProd}`
  );

  // الخطوة 4: البصمة الفيزيائية — متوقع اختلافها (تشخيصية فقط، لا تدخل في أي قرار)
  const physicalProd = await physicalSchemaFingerprint(prod);
  const physicalFresh = await physicalSchemaFingerprint(fresh);
  console.log(`ℹ️  physicalFingerprint(production) = ${physicalProd}`);
  console.log(`ℹ️  physicalFingerprint(fresh)      = ${physicalFresh}`);
  if (physicalProd !== physicalFresh) {
    console.log("ℹ️  اختلاف فيزيائي متوقع وموثق — انظر توثيق drift الأعمدة أدناه (لا يؤثر على أي قرار).");
    line("خطوة 4أ: physical(fresh) ≠ physical(production) كما هو متوقع (drift الترتيب)", true, "تشخيصي فقط");
  } else {
    console.log("ℹ️  البصمة الفيزيائية متطابقة أيضًا (لا drift فيزيائي حاليًا) — مقبول أيضًا.");
  }

  // توثيق drift الترتيب الفيزيائي لعمودي Report حرفيًا
  const posProd = reportColumnPositions(PROD, ["dueDate", "reviewStartedAt"]);
  const posFresh = reportColumnPositions(BUILT, ["dueDate", "reviewStartedAt"]);
  console.log(
    `ℹ️  Report.dueDate        — موقع فيزيائي: production=${posProd.get("dueDate")} ، fresh=${posFresh.get("dueDate")}`
  );
  console.log(
    `ℹ️  Report.reviewStartedAt — موقع فيزيائي: production=${posProd.get("reviewStartedAt")} ، fresh=${posFresh.get("reviewStartedAt")}`
  );
  console.log("ℹ️  القرار المعتمد (4A.1): Physical/Textual Drift موثق — لا إعادة بناء لجدول Report لتغيير ترتيب الأعمدة.");

  // الخطوة 5: integrity على الطرفين
  const integProd = await prod.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`);
  const integFresh = await fresh.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`);
  line(
    "خطوة 5: integrity_check على الإنتاج والمبنية",
    (integProd[0]?.integrity_check ?? "") === "ok" && (integFresh[0]?.integrity_check ?? "") === "ok",
    `production=${integProd[0]?.integrity_check} · fresh=${integFresh[0]?.integrity_check}`
  );

  // الخطوة 6: Prisma CRUD smoke على المبنية (طبقة البيانات تعمل من الصفر)
  const probeUser = await fresh.user.create({
    data: { username: "__41_baseline_probe__", passwordHash: "x", displayName: "فحص 4A.1", role: "user" },
  });
  const readBack = await fresh.user.findUnique({ where: { id: probeUser.id } });
  await fresh.user.delete({ where: { id: probeUser.id } });
  const remainingUsers = await fresh.user.count();
  line("خطوة 6: Prisma CRUD على المبنية (إنشاء→قراءة→حذف)", !!readBack && remainingUsers === 0, "طبقة بيانات Prisma حية على قاعدة migrations");
  await fresh.$disconnect();

  // الخطوة 7: الإنتاج لم يُلمس
  const prodCountsAfter = {
    users: await prod.user.count(),
    groups: await prod.group.count(),
    reports: await prod.report.count(),
    workflowHistory: await prod.workflowHistory.count(),
    auditLog: await prod.auditLog.count(),
  };
  await prod.$disconnect();
  line(
    "خطوة 7: قاعدة التشغيل لم تُلمس (عدّ قبل/بعد متطابق)",
    JSON.stringify(prodCountsBefore) === JSON.stringify(prodCountsAfter),
    JSON.stringify(prodCountsAfter)
  );

  // قيمة canonical للتثبيت في الكود (backup-config.ts → PINNED_CURRENT_CANONICAL_FINGERPRINT)
  console.log("\n───────── canonical fingerprint (للتثبيت) ─────────");
  console.log(canonicalProd);
  console.log("───────────────────────────────────────────────────");
  console.log("\n=== انتهى إثبات إغلاق Baseline — الخطوة التالية: التثبيت ثم بوابة resolve ===");
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
