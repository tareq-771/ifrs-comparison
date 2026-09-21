// Phase 5B.2 — محلل ملف بيئة صارم مشترك — المصدر الوحيد لدلالات IFRS_ENV_FILE.
//
// المستخدمون:
//   • scripts/prod-server.mjs     (runtime الإنتاج — تحميل الأسرار عند الإقلاع)
//   • scripts/deploy-migrate.mjs  (بوابة الترحيل الإنتاجية — Layer B)
//
// الضمانات (نفس دلالات prod-server منذ 5B.1 — استُخرجت هنا لمنع الانحراف):
//   • تحليل KEY=VALUE حرفي — لا eval، لا shell expansion، لا اعتراض اقتباسات.
//   • أسطر # تعليقات؛ الأسطر الفارغة تُتجاهل؛ أي سطر آخر غير صالح ⇒ خطأ فوري
//     برقم السطر (فشل مغلق قبل أي تشغيل).
//   • اسم المتغير: [A-Za-z_][A-Za-z0-9_]* حصرًا.
//   • المفتاح IFRS_ENV_FILE نفسه يُتجاهل (مؤشر الملف لا يُ override من داخله).
//   • لا تُطبع أي قيم إطلاقًا — الأسماء والأعداد حصرًا.
//
// Windows ملاحظة: يقرأ النص utf8 ويتسامح مع CRLF (split(/\r?\n/)) — ومسارات
// القيم تُمر كما هي (DATABASE_URL=file:D:/... الشكل المعتمد في ifrs.env.windows.example).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export class EnvFileError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnvFileError";
  }
}

/**
 * تحليل ملف env صارم — يعيد {map, count} دون تعديل process.env.
 * يرمي EnvFileError عند أي سطر غير صالح أو ملف مفقود.
 */
export function parseEnvFile(envFile) {
  if (!envFile || typeof envFile !== "string" || !envFile.trim()) {
    throw new EnvFileError("IFRS_ENV_FILE غير محدد (لا قيم افتراضية — فشل مغلق)");
  }
  const p = envFile.trim();
  if (!existsSync(p)) {
    throw new EnvFileError(`IFRS_ENV_FILE غير موجود (${p}) — فشل مغلق، لا قيم افتراضية`);
  }
  const raw = readFileSync(p, "utf8");
  const lines = raw.split(/\r?\n/);
  const map = {};
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new EnvFileError(`سطر ${i + 1} غير صالح (متوقع KEY=VALUE)`);
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new EnvFileError(`سطر ${i + 1}: اسم متغير غير صالح`);
    }
    if (key === "IFRS_ENV_FILE") continue; // لا override لمؤشر الملف نفسه
    map[key] = value;
    count++;
  }
  return { map, count };
}

/** تحميل + تطبيق على process.env — يعيد عدد المتغيرات المطبقة. */
export function applyEnvFile(envFile, { log = () => {} } = {}) {
  const { map, count } = parseEnvFile(envFile);
  for (const [k, v] of Object.entries(map)) {
    process.env[k] = v;
  }
  log(`env file loaded: ${path.basename(envFile)} (${count} متغيرات)`);
  return count;
}
