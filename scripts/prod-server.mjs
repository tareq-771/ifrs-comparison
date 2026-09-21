// Phase 5B.1 — مُشغّل الإنتاج (release-root) — Node حصرًا، بلا shell ولا tee.
//
// الغرض (نص المستخدم §9 + §I):
//   • وقت التشغيل الإنتاجي = Node (قرار R3 المعتمد) — bun أداة بناء فقط.
//   • الأسرار تُحمّل من ملف env واحد خارج Git وخارج releases (D:\IFRS-Data\config\ifrs.env)
//     بمسار صريح من بيئة الخدمة (IFRS_ENV_FILE عبر WinSW) — لا أسرار في سطر
//     أوامر، لا في XML الخدمة، لا في شجرة الإصدار.
//   • تحليل صارم KEY=VALUE (لا eval، لا shell expansion) — أسطر # تعليقات
//     تُتجاهل، السطر غير الصالح ⇒ فشل مغلق قبل أي تشغيل.
//   • يُنسخ تلقائيًا إلى جذر كل release بواسطة scripts/assemble-release.mjs
//     ويحوّل cwd إلى جذر الإصدار (شرط PROJECT_ROOT في التطبيق).
//
// الاستخدام عبر الخدمة (WinSW):
//   executable = node.exe   arguments = prod-server.mjs
//   workingdirectory = <release-current>   env IFRS_ENV_FILE = <ifrs.env path>

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(`[prod-server] FATAL: ${msg}`);
  process.exit(1);
}

// 1) تحميل ملف البيئة الصريح (مصدر الأسرار الوحيد خارج Git/releases)
const envFile = process.env.IFRS_ENV_FILE?.trim() ?? "";
if (envFile) {
  if (!existsSync(envFile)) fail(`IFRS_ENV_FILE غير موجود (فشل مغلق — لا قيم افتراضية)`);
  const raw = readFileSync(envFile, "utf8");
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) fail(`IFRS_ENV_FILE سطر ${i + 1} غير صالح (متوقع KEY=VALUE)`);
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`IFRS_ENV_FILE سطر ${i + 1}: اسم متغير غير صالح`);
    if (key === "IFRS_ENV_FILE") continue; // لا تعديل مؤشر الملف نفسه
    process.env[key] = value;
  }
  console.log(`[prod-server] env file loaded: ${path.basename(envFile)} (${lines.filter((l) => l.trim() && !l.trim().startsWith("#")).length} أسطر)`);
}

// 2) NODE_ENV=production إلزاميًا (حارس أخير — instrumentation يعتمدها fail-closed)
if (process.env.NODE_ENV !== "production") {
  if (process.env.NODE_ENV) {
    fail(`NODE_ENV=${process.env.NODE_ENV} — المُشغّل الإنتاجي يقبل production حصرًا`);
  }
  process.env.NODE_ENV = "production";
}

// 3) cwd = جذر الإصدار (server.js والمسارات النسبية للمشروع)
process.chdir(HERE);

// 4) تشغيل خادم standalone داخل نفس العملية (require — CJS كمواصفات Next)
const require = createRequire(import.meta.url);
require(path.join(HERE, "server.js"));
