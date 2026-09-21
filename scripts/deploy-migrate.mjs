// Phase 5B.2 — بوابة الترحيل الإنتاجية الحتمية (Layer B — أدوات المشغّل على المضيف).
//
// الغرض (نص متابعات 5B.2 §6): migrate deploy حصرًا في الإنتاج — لا db push ولا
// reset ولا أي أمر Prisma آخر — بتحميل env حتمي صارم بدل استخراج PowerShell
// الهش (grep يدوي للسطر) الذي كان في runbook step 6 حتى 5B.1.
//
// الاستخدام (على المضيف، من شجرة المصدر عند الـTAG المعتمد):
//   node scripts\deploy-migrate.mjs --env-file D:\IFRS-Data\config\ifrs.env
// خيارات:
//   --env-file <path>   مصدر الأسرار/التهيئة (افتراضيًا: IFRS_ENV_FILE من البيئة)
//   --schema <dir>      مجلد prisma (افتراضيًا: ./prisma من cwd — شجرة المصدر عند TAG)
//   --dry-run           اطبع الخطة الكاملة دون تنفيذ أي شيء
//
// الضمانات:
//   • migrate deploy حصرًا — الأمر ثابت في الكود، لا استقبال أوامر من المستخدم.
//   • الأسرار عبر IFRS_ENV_FILE حصرًا (محلل scripts/env-file.mjs الصارم المشترك
//     مع prod-server.mjs — لا eval، لا shell، لا قيم في سطر الأوامر).
//   • DATABASE_URL: file: مطلق + الملف موجود فعلًا (لا إنشاء صامت لقاعدة جديدة
//     في مسار خاطئ — نفس دلالة production-config) + خارج شجرة العمل (cwd).
//   • Prisma CLI: PRISMA_CLI_HOME أو البحث تصاعديًا من cwd — عبر process.execPath
//     حصرًا (نفس دلالات src/lib/prisma-cli.ts — تُقارن في مصفوفة 5B.2).
//   • فشل أي شرط ⇒ exit 1 ورسالة واضحة — التبديل لا يجري أبدًا عند فشل الترحيل
//     (runbook: «فشل ⇒ لا تبديل — الخدمة القديمة تستمر»).
//   • التحقق النهائي للمخطط يبقى preflight الإقلاع مقابل الثابت المثبت
//     (canonical fingerprint) — أي انحراف ⇒ unhealthy ويُوقف التشغيل الآمن.
//
// Windows: يعمل عبر node.exe مباشرة (لا bun في وقت النشر/التشغيل).

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyEnvFile, EnvFileError } from "./env-file.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(`[deploy-migrate] FATAL: ${msg}`);
  process.exit(1);
}

/* ── 1) وسيطات سطر الأوامر (لا قيم أسرار هنا أبدًا) ── */
const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const dryRun = argv.includes("--dry-run");
const envFileArg = argValue("--env-file") ?? process.env.IFRS_ENV_FILE?.trim() ?? null;
const schemaDirArg = argValue("--schema");

/* ── 2) تحميل env الصارم (نفس محلل prod-server) ── */
if (!envFileArg) {
  fail(
    "--env-file غير محدد ولا IFRS_ENV_FILE في البيئة — مصدر التهيئة الوحيد هو ملف env صريح (فشل مغلق)"
  );
}
try {
  applyEnvFile(envFileArg, { log: (m) => console.log(`[deploy-migrate] ${m}`) });
} catch (e) {
  fail(e instanceof EnvFileError ? e.message : String(e));
}

/* ── 3) تحقق DATABASE_URL — نفس دلالات production-config (لا إنشاء صامت) ── */
const url = process.env.DATABASE_URL?.trim() ?? "";
if (!url) fail("DATABASE_URL_MISSING");
if (!url.startsWith("file:")) fail("DATABASE_URL_NOT_FILE_URL");
const dbPath = path.normalize(url.slice(5).trim());
if (!path.isAbsolute(dbPath)) fail("DATABASE_URL_NOT_ABSOLUTE");
if (!existsSync(dbPath)) {
  fail(`DATABASE_FILE_NOT_FOUND (${dbPath}) — migrate deploy لا ينشئ قاعدة إنتاج جديدة أبدًا`);
}
// خارج شجرة العمل (cwd = شجرة المصدر عند الـTAG على المضيف)
{
  const rel = path.relative(process.cwd(), dbPath);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    fail("DATABASE_URL_INSIDE_WORKTREE — قاعدة الإنتاج لا تقع داخل شجرة المصدر/النشر أبدًا");
  }
}

/* ── 4) مجلد prisma (schema + migrations) من شجرة المصدر عند الـTAG ── */
const schemaDir = path.resolve(schemaDirArg ?? path.join(process.cwd(), "prisma"));
const schemaFile = path.join(schemaDir, "schema.prisma");
const migrationsDir = path.join(schemaDir, "migrations");
if (!existsSync(schemaFile) || !statSync(schemaFile).isFile()) {
  fail(`SCHEMA_NOT_FOUND (${schemaFile}) — شغّل من شجرة المصدر عند الـTAG المعتمد`);
}
if (!existsSync(migrationsDir) || !statSync(migrationsDir).isDirectory()) {
  fail(`MIGRATIONS_DIR_NOT_FOUND (${migrationsDir})`);
}

/* ── 5) حل Prisma CLI — process.execPath حصرًا (لا bunx/npx/shell) ──
 *    دلالات صارمة مطابقة لـsrc/lib/prisma-cli.ts: PRISMA_CLI_HOME صريح
 *    لا يتراجع للبحث أبدًا — إن حُدد ولم يُحل ⇒ UNRESOLVED فشل مغلق. */
function resolvePrismaEntry() {
  const home = process.env.PRISMA_CLI_HOME?.trim();
  if (home) {
    const entry = path.join(path.resolve(home), "node_modules", "prisma", "build", "index.js");
    if (existsSync(entry)) return { entry, source: "PRISMA_CLI_HOME" };
    return null; // صريح ومفقود ⇒ لا fallback (نفس دلالة prisma-cli.ts)
  }
  // البحث تصاعديًا من cwd (بلا PRISMA_CLI_HOME فقط — dev/اختبار معزول)
  let dir = process.cwd();
  for (;;) {
    const entry = path.join(dir, "node_modules", "prisma", "build", "index.js");
    if (existsSync(entry)) return { entry, source: "CWD_NODE_MODULES" };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const resolved = resolvePrismaEntry();
if (!resolved) {
  fail(
    "PRISMA_CLI_UNRESOLVED — ثبّت أدوات المشغّل مرة واحدة (Layer B): " +
      "npm install prisma@<نفس إصدار @prisma/client> في C:\\Apps\\ifrs-comparison\\tools\\prisma-cli واضبط PRISMA_CLI_HOME في ifrs.env"
  );
}

/* ── 6) الخطة ── */
const childEnv = { ...process.env }; // يتضمن DATABASE_URL من env file — لا سطر أوامر
const cmd = [resolved.entry, "migrate", "deploy", "--schema", schemaFile];
console.log("[deploy-migrate] خطة التنفيذ:");
console.log(`  runtime   : ${process.execPath}`);
console.log(`  prismaCLI : ${resolved.entry} (${resolved.source})`);
console.log(`  command   : migrate deploy --schema ${schemaFile}`);
console.log(`  database  : ${dbPath}`);
if (dryRun) {
  console.log("[deploy-migrate] --dry-run: لا تنفيذ — الخطة أعلاه فقط.");
  process.exit(0);
}

/* ── 7) التنفيذ — migrate deploy حصرًا؛ exit code الطفل هو القرار ── */
console.log("[deploy-migrate] تنفيذ migrate deploy…");
const child = spawn(process.execPath, cmd, {
  env: childEnv,
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (e) => fail(`فشل بدء عملية Prisma: ${e.message}`));
child.on("exit", (code, signal) => {
  if (signal) fail(`أُنهيت العملية بالإشارة ${signal} — لا تبديل إصدار`);
  if (code === 0) {
    console.log(
      "[deploy-migrate] OK — الترحيلات مطبقة. التحقق النهائي للمخطط = preflight الإقلاع مقابل الثابت المثبت (canonical fingerprint)."
    );
    process.exit(0);
  }
  fail(`migrate deploy فشل (exit=${code}) — لا تبديل إصدار؛ الخدمة القديمة تستمر (ترحيل SQLite معاملة)`);
});
