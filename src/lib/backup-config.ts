// Phase 4A — إعدادات النسخ الاحتياطي: المسارات والحدود والسياسة (خادم فقط).
//
// الدلالة المعمارية الإلزامية (D-2 المعدل — قرار المستخدم):
//   مجلد التطبيق (كود) ≠ مجلد بيانات النسخ (BACKUP_DIR).
//   كل الوصول للنسخ يمر عبر resolveBackupDir() هنا — لا يوجد أي مسار كود
//   يفترض أن النسخ داخل source tree. النشر الإنتاجي قد يشير BACKUP_DIR إلى
//   /srv/ifrs-backups أو وسيط شبكة دون تعديل سطر واحد.
//
// الافتراضي في بيئة التطوير الحالية: <projectRoot>/var/backups — مساحة عمل
// دائمة خارج public/ وخارج Git (تجاهل للأمام فقط) — لكنه افتراضي قابل لل
// Override لا اعتماد معماري.
//
// لا أسرار هنا إطلاقًا: لا NEXTAUTH_SECRET ولا أي قيمة سرية تمر من هذا الملف.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/* ──────────────────────────────────────────────────────────────────────── */
/*  المسارات                                                                */
/* ──────────────────────────────────────────────────────────────────────── */

export const PROJECT_ROOT = process.cwd();

/** جذر الحالة التشغيلية خارج Git — قابل للتهيئة. */
export function resolveVarDir(): string {
  const configured = process.env.VAR_DIR?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(PROJECT_ROOT, "var");
}

/**
 * BACKUP_DIR — مجلد بيانات النسخ الرسمي (D-2).
 * افتراضيًا خارج public/ وخارج Git working tree للإضافات الجديدة.
 */
export function resolveBackupDir(): string {
  const configured = process.env.BACKUP_DIR?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(resolveVarDir(), "backups");
}

/** المرحل: رفع/تحقق/Drill — يُمسح دوريًا ولا يحمل أي نسخة رسمية. */
export function resolveStagingDir(): string {
  return path.join(resolveVarDir(), "restore-staging");
}

/** سجل الاسترجاع التشغيلي الخارجي — append-only، خارج قاعدة البيانات المستبدلة. */
export function resolveRecoveryLogDir(): string {
  return path.join(resolveVarDir(), "recovery");
}

export function recoveryLogFilePath(): string {
  return path.join(resolveRecoveryLogDir(), "recovery-log.jsonl");
}

/** ضمان وجود مجلد بأذونات 0700 (0600 للملفات تُضبط عند كل كتابة). */
export function ensurePrivateDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  الحدود (أمن رفع ZIP — القسم 16.2 من وثيقة التصميم)                      */
/* ──────────────────────────────────────────────────────────────────────── */

function intEnv(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const UPLOAD_LIMITS = {
  /** الحد المضغوط (حجم الملف المرفوع) — MB */
  maxUploadMB: intEnv("BACKUP_MAX_UPLOAD_MB", 200),
  /** الحد غير المضغوط (مجموع المداخل) — MB */
  maxUncompressedMB: intEnv("BACKUP_MAX_UNCOMPRESSED_MB", 500),
  /** نسبة الانضغاط القصوى uncompressed/compressed — صدّ ZIP bomb */
  maxCompressionRatio: 200,
  /** أقصى عدد مداخل في الـ ZIP (المقبول فعليًا: اثنان بالضبط) */
  maxZipEntries: 4,
  /** أقصى حجم لـ manifest.json */
  maxManifestBytes: 1_000_000,
} as const;

/** فترة التهدئة بين إنشاء نسختين (صدّ استنزاف القرص) — القسم 17#7. */
export const BACKUP_CREATE_COOLDOWN_MS = 60_000;

/** المحتوى المقبول في الإصدار الأول — قرار المستخدم حرفيًا. */
export const ALLOWED_ZIP_ENTRIES: readonly string[] = ["database.db", "manifest.json"];

/** الجداول الإلزامية الخمسة (تُتحقق عبر استعلامات Prisma الفعلية). */
export const REQUIRED_TABLE_COUNTS = ["user", "group", "report", "workflowHistory", "auditLog"] as const;

/* ──────────────────────────────────────────────────────────────────────── */
/*  الهوية: إصدار التطبيق والمخطط                                           */
/* ──────────────────────────────────────────────────────────────────────── */

let cachedAppVersion: string | null = null;

/** إصدار التطبيق من package.json (وصفي — ليس آلية تحقق أمني). */
export function appVersion(): string {
  if (cachedAppVersion) return cachedAppVersion;
  try {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
    cachedAppVersion = typeof pkg?.version === "string" ? pkg.version : "1.0.0";
  } catch {
    cachedAppVersion = "1.0.0";
  }
  return cachedAppVersion;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  سجل المخططات المعروفة (القسم 8.1 — D-3)                                 */
/*                                                                          */
/*  4A: المخطط الحالي فقط (يُحتسب من قاعدة التشغيل عند الطلب ويُخزّن).      */
/*  لا توجد إصدارات أقدم مسجلة بعد — baseline الـ migrations يُحضّر ويُختبر  */
/*  في 4A (على نسخ حصرًا) دون تسجيل أي إصدار أقدم.                          */
/*  كل مخطط ≠ الحالي ⇒ SCHEMA_UNKNOWN — رفض (يشمل «الأحدث» — لا downgrade). */
/*  في 4B تُسجّل الإصدارات الأقدم مع تسلسل migrations لكل منها.            */
/* ──────────────────────────────────────────────────────────────────────── */

export interface KnownSchema {
  id: string;
  label: string;
  /**
   * منذ 4A.1: البصمة القاعدية الدلالية (canonical، بادئة csha256:) — الحاكمة.
   * (قبل 4A.1 كانت بصمة sqlite_master الفيزيائية — لا توجد إصدارات مسجلة قديمة).
   * null = يحتسب من قاعدة التشغيل عند أول استدعاء (إلا إن وُجد pin أدناه).
   */
  fingerprint: string | null;
  kind: "current" | "older";
  /** تسلسل migrations من هذا الإصدار إلى الحالي (فارغ في 4A/4A.1). */
  migrations: string[];
}

const KNOWN_SCHEMAS: KnownSchema[] = [
  {
    id: "v4-phase3.5B",
    label: "المخطط الحالي — Phase 3.5B (5 جداول + فهارس)",
    fingerprint: null, // يُثبّت أدناه بعد إثبات canonical(fresh)==canonical(production)
    kind: "current",
    migrations: [], // الـ baseline عُولج في 4A.1 عبر resolve --applied (لا ترحيلات دلالية أحدث)
  },
];

/**
 * 4A.1 — التثبيت الدلالي: بعد إثبات التطابق ثلاثي (production↔schema.prisma↔fresh)
 * يُثبّت هنا الـ canonical fingerprint المتوقع لمخطط v4-phase3.5B. إذا خالفت
 * قاعدة التشغيل الحية هذا الثابت ⇒ فشل مغلق (SCHEMA_UNKNOWN) لكل تحقق/Drill —
 * أي انحراف مخطط غير معلن يُوقف خط النسخ فورًا بدل المرور بصمت.
 * أي migration شرعية مستقبلًا (4B+) تعني تحديث هذا الثابت في نفس الـ commit.
 */
export const PINNED_CURRENT_CANONICAL_FINGERPRINT: string | null =
  "csha256:bffa026102bcb2419b68af50654ce806c22dc08e069dd3a1203b184db4b4af3f";

interface SchemaIdentity {
  canonical: string;
  physical: string;
}

let cachedCurrentIdentity: SchemaIdentity | null = null;

export function setCurrentSchemaIdentity(identity: SchemaIdentity): void {
  // يُستدعى قبل كل عملية تحقق/Drill/إنشاء — يعيد الاكتساب من قاعدة التشغيل
  // الحية حتى لا تصبح الهوية قديمة بعد أي تغيير مخطط معتمد.
  cachedCurrentIdentity = identity;
}

export function getCurrentSchemaIdentity(): SchemaIdentity | null {
  return cachedCurrentIdentity;
}

/** الهوية الحاكمة الحالية: الثابت المثبّت إن وجد وإلا المحتسب من قاعدة التشغيل. */
export function getCurrentCanonicalSchemaFingerprint(): string | null {
  return PINNED_CURRENT_CANONICAL_FINGERPRINT ?? cachedCurrentIdentity?.canonical ?? null;
}

/** البصمة الفيزيائية الحالية (تشخيصية حصرًا). */
export function getCurrentPhysicalSchemaFingerprint(): string | null {
  return cachedCurrentIdentity?.physical ?? null;
}

/**
 * تصنيف بصمة مخطط نسخة ما — منذ 4A.1 على البصمة القاعدية الدلالية (canonical)
 * لا الفيزيائية: النسخة المبنية من migrations بترتيب أعمدة مختلف تُقبل،
 * وأي فرق دلالي (عمود/فهرس/FK/نوع/افتراض) يُرفض.
 * في 4A.1: إما مطابق للحالي أو «غير معروف» (يشمل الأحدث — الرفض في الحالتين).
 */
export type SchemaClass = "current" | "older-known" | "unknown";

export function classifySchemaFingerprint(fp: string): { schemaClass: SchemaClass; known?: KnownSchema } {
  const current = getCurrentCanonicalSchemaFingerprint();
  if (current && fp === current) {
    return { schemaClass: "current", known: KNOWN_SCHEMAS.find((k) => k.kind === "current") };
  }
  for (const k of KNOWN_SCHEMAS) {
    if (k.kind === "older" && k.fingerprint && k.fingerprint === fp) {
      return { schemaClass: "older-known", known: k };
    }
  }
  return { schemaClass: "unknown" };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  المعرفات                                                                */
/* ──────────────────────────────────────────────────────────────────────── */

function utcCompact(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function rand6(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

/** معرف نسخة: bk-<UTC>-<rand> — الصلاحية من المحتوى لا من الاسم (D-1). */
export function newBackupId(): string {
  return `bk-${utcCompact()}-${rand6()}`;
}

/** معرف عملية يربط كل أحداثها في سجل الاسترجاع من البداية للنهاية. */
export function newOperationId(prefix: "backup" | "validate" | "drill" | "upload"): string {
  return `op-${prefix}-${utcCompact()}-${rand6()}`;
}

/** معرف رفع (يُستخدم اسم ملف على القرص — لا يُستخدم للتحقق). */
export function newUploadId(): string {
  return `up-${utcCompact()}-${rand6()}`;
}

/** تجاوز اسم ملف مرفوع (عرض فقط — لا ثقة به إطلاقًا). */
export function sanitizeDisplayName(name: string): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\x00-\x1f]/g, "").slice(0, 120);
  return clean || "(بدون اسم)";
}
