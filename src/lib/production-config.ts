// Phase 5A — تحقق تهيئة الإنتاج (Fail-Closed) — خادم فقط.
//
// الغرض الحاكم (نص المستخدم 5A):
//   «Production configuration validation بنمط fail-closed لـ NEXTAUTH_SECRET,
//    DATABASE_URL, VAR_DIR, BACKUP_DIR, RESTORE_ENGINE_ENABLED — مع منع مسارات
//    البيانات داخل release/build tree وعدم وجود secret fallback عشوائي.»
//
// القواعد:
//   • تعمل حصرًا في NODE_ENV=production (بيئة التطوير الحالية بلا سر تعمل كما هي —
//     سلوك dev لا يتغير إطلاقًا؛ سقوط الإنتاج فوري وصريح لا صامت).
//   • كل إخفاق ⇒ أخطاء واضحة بأسماء المتغيرات وأسبابها فقط — لا قيم أسرار أبدًا.
//   • الإخفاق يمنع الإقلاع (instrumentation يستدعي process.exit(1)) — لا سر عشوائي،
//     لا إنشاء قاعدة في مسار خاطئ بصمت، لا بيانات داخل شجرة النشر.
//
// منع مسارات البيانات داخل شجرة النشر:
//   DATABASE_URL / VAR_DIR / BACKUP_DIR يجب أن تكون مطلقة وموجودة وخارج مجلد
//   العمل (release root) — إعادة نشر/حذف build tree لا يمس بيانات بنيويًا.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface ProductionConfigResult {
  ok: boolean;
  /** رموز إخفاق قصيرة غير حساسة (أسماء متغيرات/أسباب) — للتشخيص والـhealth. */
  errors: string[];
  warnings: string[];
}

/** قيم placeholder شائعة يُرفض قبولها كسر إنتاجي. */
const SECRET_PLACEHOLDERS = new Set([
  "changeme",
  "change-me",
  "secret",
  "my-secret",
  "your-secret-here",
  "replace-me",
  "placeholder",
  "nextauth_secret",
  "please-change-me",
  "12345678901234567890123456789012", // 32 حرفًا تافهة
]);

/** الحد الأدنى لطول NEXTAUTH_SECRET بالبايت (32 بايت = 256 بت إنتروبيا). */
const MIN_SECRET_BYTES = 32;

export function isProductionMode(): boolean {
  return process.env.NODE_ENV === "production";
}

/** التحقق من أن مسارًا ما داخل شجرة النشر/البناء (release root = cwd). */
function isInsideReleaseTree(absolutePath: string): boolean {
  let releaseRoot: string;
  try {
    releaseRoot = process.cwd();
  } catch {
    return false;
  }
  const rel = path.relative(releaseRoot, absolutePath);
  // يبدأ بـ ../ أو فارغ(نفس المجلد) ⇒ خارجي. "" يعني نفس مجلد release نفسه = داخلي.
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function checkSecret(value: string | undefined): string | null {
  if (!value || value.trim().length === 0) {
    return "NEXTAUTH_SECRET_MISSING";
  }
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf8") < MIN_SECRET_BYTES) {
    return "NEXTAUTH_SECRET_TOO_SHORT";
  }
  if (SECRET_PLACEHOLDERS.has(trimmed.toLowerCase())) {
    return "NEXTAUTH_SECRET_PLACEHOLDER";
  }
  if (/^[0-9]+$/.test(trimmed) || /^(.)\1+$/.test(trimmed)) {
    return "NEXTAUTH_SECRET_WEAK_PATTERN";
  }
  return null;
}

/** مسار القاعدة من DATABASE_URL — نفس دلالات backup-config دون استيراد دائري. */
function databaseFilePathFromUrl(): { path: string | null; error: string | null } {
  const url = process.env.DATABASE_URL?.trim() ?? "";
  if (!url) return { path: null, error: "DATABASE_URL_MISSING" };
  if (!url.startsWith("file:")) return { path: null, error: "DATABASE_URL_NOT_FILE_URL" };
  const p = url.slice(5).trim();
  if (!p) return { path: null, error: "DATABASE_URL_EMPTY_PATH" };
  if (!path.isAbsolute(p)) return { path: null, error: "DATABASE_URL_NOT_ABSOLUTE" };
  return { path: path.normalize(p), error: null };
}

/**
 * التحقق الكامل لتهيئة الإنتاج. يُستدعى مرة واحدة عند الإقلاع (instrumentation).
 * لا يطبع ولا يعيد أي قيمة سرية — أسماء متغيرات ورموز أخطاء فقط.
 */
export function validateProductionConfig(): ProductionConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  /* ── NEXTAUTH_SECRET ── */
  const secretErr = checkSecret(process.env.NEXTAUTH_SECRET);
  if (secretErr) errors.push(secretErr);

  /* ── NEXTAUTH_URL (مطلوب لصحّة NextAuth الإنتاجية خلف بروكسي) ── */
  const nextauthUrl = process.env.NEXTAUTH_URL?.trim() ?? "";
  if (!nextauthUrl) {
    errors.push("NEXTAUTH_URL_MISSING");
  } else if (!/^https?:\/\//.test(nextauthUrl)) {
    errors.push("NEXTAUTH_URL_INVALID");
  }

  /* ── DATABASE_URL ── */
  const db = databaseFilePathFromUrl();
  if (db.error) {
    errors.push(db.error);
  } else if (db.path) {
    if (!existsSync(db.path)) {
      // لا إنشاء صامت لقاعدة في مسار خاطئ — الإنتاج يرفض الإقلاع
      errors.push("DATABASE_FILE_NOT_FOUND");
    } else if (isInsideReleaseTree(db.path)) {
      errors.push("DATABASE_URL_INSIDE_RELEASE_TREE");
    }
  }

  /* ── VAR_DIR (جذر الحالة التشغيلية: epoch/maintenance/recovery/staging) ── */
  const varDir = process.env.VAR_DIR?.trim() ?? "";
  if (!varDir) {
    errors.push("VAR_DIR_MISSING");
  } else if (!path.isAbsolute(varDir)) {
    errors.push("VAR_DIR_NOT_ABSOLUTE");
  } else if (!existsSync(varDir) || !statSync(varDir).isDirectory()) {
    errors.push("VAR_DIR_NOT_FOUND");
  } else if (isInsideReleaseTree(path.resolve(varDir))) {
    errors.push("VAR_DIR_INSIDE_RELEASE_TREE");
  }

  /* ── BACKUP_DIR ── */
  const backupDir = process.env.BACKUP_DIR?.trim() ?? "";
  if (!backupDir) {
    errors.push("BACKUP_DIR_MISSING");
  } else if (!path.isAbsolute(backupDir)) {
    errors.push("BACKUP_DIR_NOT_ABSOLUTE");
  } else if (!existsSync(backupDir) || !statSync(backupDir).isDirectory()) {
    errors.push("BACKUP_DIR_NOT_FOUND");
  } else if (isInsideReleaseTree(path.resolve(backupDir))) {
    errors.push("BACKUP_DIR_INSIDE_RELEASE_TREE");
  }

  /* ── RESTORE_ENGINE_ENABLED: يجب أن يكون صريحًا ("0" أو "1") في الإنتاج ── */
  const engine = process.env.RESTORE_ENGINE_ENABLED?.trim() ?? "";
  if (engine === "") {
    errors.push("RESTORE_ENGINE_ENABLED_MISSING");
  } else if (engine !== "0" && engine !== "1") {
    errors.push("RESTORE_ENGINE_ENABLED_INVALID");
  } else if (engine === "1") {
    warnings.push("RESTORE_ENGINE_ENABLED_1");
  }

  /* ── تحذيرات غير قاتلة ── */
  if (!errors.some((e) => e.startsWith("NEXTAUTH_SECRET"))) {
    // لا نقرأ القيمة — فقط نتحقق من مصدرها الوحيد: بيئة العملية (لا ملف .env بالشجرة)
    try {
      const envFile = path.join(process.cwd(), ".env");
      if (existsSync(envFile)) {
        const raw = readFileSync(envFile, "utf8");
        if (/^\s*NEXTAUTH_SECRET\s*=/m.test(raw)) {
          warnings.push("ENV_FILE_HAS_NEXTAUTH_SECRET_LINE");
        }
      }
    } catch {
      /* قراءة اختيارية — لا تؤثر */
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
