// Phase 4A — Manifest v2: البنية، الحسابات من قاعدة/ملف، والتحقق الشكلي.
//
// قاعدة المستخدم الحرفية: الصلاحية تُشتق من المحتوى والـ Manifest — لا من
// اسم ZIP أو اسم الملف المرفوع (D-1). createdBy وصفية فقط ولا تُستخدم
// للتحقق الأمني أبدًا.
//
// ⚠️ القيد الموثق (طلب المستخدم الصريح): SHA-256 داخل الـ Manifest يكتشف
// فساد database.db لكنه لا يثبت أن الـ Manifest نفسه لم يُعدَّل (لا توقيع
// تشفيري في 4A). VALIDATED = تحقق سلامة واتساق، وليس إثبات أصالة تشفيرية.
// الحقل authenticity.manifestHmac محجوز null ليُضاف HMAC/Signature مستقبلًا
// دون تغيير جذري في الصيغة.

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { appVersion, REQUIRED_TABLE_COUNTS } from "@/lib/backup-config";
import { businessTzOffsetMinutes } from "@/lib/business-time";

/* ──────────────────────────────────────────────────────────────────────── */
/*  الأنواع                                                                 */
/* ──────────────────────────────────────────────────────────────────────── */

export type VerificationLevel = "CREATED" | "VALIDATED" | "RESTORE_VERIFIED";

export const LEVEL_RANK: Record<VerificationLevel, number> = {
  CREATED: 0,
  VALIDATED: 1,
  RESTORE_VERIFIED: 2,
};

export function maxLevel(a: VerificationLevel, b: VerificationLevel): VerificationLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

export type BackupType = "manual" | "pre-restore" | "replaced" | "upload";

/* ── Manifest v3 (4A.1): إضافة البصمة القاعدية الدلالية — بلا كسر v2 ──
 *
 * قرار الصيغة: formatVersion 3 لإضافة canonicalSchemaFingerprint حقل إلزامي
 * جديد، مع بقاء كل حقول v2 كما هي (schemaFingerprint = البصمة الفيزيائية
 * بنفس دلالتها القديمة) — فلا يتطابق manifestان بدلالات مختلفة تحت رقم واحد.
 *
 * التوافق مع النسخ الموجودة (formatVersion 2) — التعامل الموثق:
 *  - القارئ الحالي يقبل 2 و3 معًا (لا كسر صامت إطلاقًا).
 *  - نسخ v2 تُصنف "legacy-v2" في القائمة والتقارير وتبقى صالحة للتحقق/الDrill.
 *  - البصمة القاعدية للنسخ v2 تُستخرج من database.db نفسها أثناء التحقق
 *    (لا تُؤخذ من الـ Manifest أصلًا — القاعدة العامة: لا ثقة بقيمة مكتوبة
 *    دون مقابلتها بالمحتوى)، فلا تحتاج إعادة كتابة ولا ترقية صامتة.
 *  - لا تُرقى نسخ v2 إلى v3 إطلاقًا — تبقى كما هي (روح append-only)،
 *    والتحديث الوحيد المسموح يبقى حقول verification كما في 4A.
 */
export interface BackupManifestV2 {
  formatVersion: 2;
  backupId: string;
  backupType: BackupType;
  createdAt: string;
  /** وصفية فقط — لا تُستخدم للتحقق الأمني إطلاقًا (قرار المستخدم حرفيًا). */
  createdBy: { id: string | null; username: string };
  appVersion: string;
  schemaVersion: string;
  /** البصمة الفيزيائية (sqlite_master) — منذ 4A.1 تشخيصية فقط. */
  schemaFingerprint: string;
  database: {
    filename: "database.db";
    sha256: string;
    bytes: number;
    pageSize: number;
    integrityCheck: string;
    journalModeAtBackup: string;
  };
  counts: {
    users: number;
    groups: number;
    reports: number;
    workflowHistory: number;
    auditLog: number;
  };
  periodRange: { minPeriodEnd: string | null; maxPeriodEnd: string | null };
  dataRange: { oldestCreatedAt: string | null; newestUpdatedAt: string | null };
  environment: { businessTzOffsetMinutes: number; configFingerprint: string };
  verification: {
    level: VerificationLevel;
    validatedAt: string | null;
    drillAt: string | null;
    drillOperationId?: string | null;
    /**
     * 4A.1 — عدد تشغيلات Drill الناجحة التراكمية على هذه النسخة.
     * مع drillOperationId (آخر تشغيل) وأحداث DRILL_STARTED/VERIFIED ذات
     * operationId المستقل لكل تشغيل — لا يُقرأ تشغيلان كحدث واحد مكرر.
     * حقل اختياري إضافي — نسخ v2 القديمة بلا الحقل تبقى صالحة (توافق).
     */
    drillRuns?: number;
  };
  /** حقول الرفع — تُضاف فقط للنسخ المرفوعة (source=upload). */
  uploadInfo?: {
    originalNameSanitized: string;
    uploadedAt: string;
    uploadedByUsername: string;
  };
  /**
   * القيد الأمني الموثق + حقل محجوز لتوقيع مستقبلي دون تغيير الصيغة.
   * لا يحتوي أي سر إطلاقًا.
   */
  authenticity: {
    note: string;
    manifestHmac: null;
  };
}

export const MANIFEST_FORMAT_VERSION = 3;
/** الإصدارات المقبولة قراءةً — v2 التاريخية لا تُكسر أبدًا (قرار 4A.1). */
export const SUPPORTED_MANIFEST_FORMAT_VERSIONS = [2, 3] as const;

export interface BackupManifestV3 extends Omit<BackupManifestV2, "formatVersion"> {
  formatVersion: 3;
  /** البصمة الحاكمة — من metadata دلالية مرتبة (canonical-v1). بادئة csha256:. */
  canonicalSchemaFingerprint: string;
}

export type AnyBackupManifest = BackupManifestV2 | BackupManifestV3;

export function manifestFormatVersion(m: AnyBackupManifest): 2 | 3 {
  return m.formatVersion === 3 ? 3 : 2;
}

/** تصنيف الـ Manifest للتشخيص والعرض: الحالي v3 أم إرث v2. */
export type ManifestClass = "v3" | "legacy-v2";
export function manifestClassOf(m: AnyBackupManifest): ManifestClass {
  return manifestFormatVersion(m) === 3 ? "v3" : "legacy-v2";
}

export const LEGACY_MANIFEST_NOTE =
  "Manifest من صيغة v2 (سابق 4A.1): بلا canonicalSchemaFingerprint — يُستخرج " +
  "من database.db نفسها عند كل تحقق، ويبقى التصنيف legacy-v2 دون أي ترقية صامتة.";

export const AUTHENTICITY_NOTE =
  "سلامة فقط لا أصالة: SHA-256 يكتشف فساد database.db لكنه لا يوقّع هذا الملف؛ " +
  "manifestHmac محجوز لتوقيع مستقبلي. VALIDATED/RESTORE_VERIFIED ليست إثبات أصالة تشفيرية.";

export type CountsKey = (typeof REQUIRED_TABLE_COUNTS)[number];

/* ──────────────────────────────────────────────────────────────────────── */
/*  الحسابات من أي قاعدة (حية أو نسخة مؤقتة عبر Prisma)                     */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * بصمة المخطط (الفيزيائية): جرد (type, name, sql) من sqlite_master مع استثناء
 * _prisma_migrations (كي لا تتغير البصمة بعد اعتماد migrations) وجداول
 * sqlite الداخلية. تجزئة SHA-256 على تمثيل قياسي.
 *
 * ⚠️ منذ 4A.1: هذه تشخيصية فقط — القرار الحاكم هو canonicalSchemaFingerprint
 * (من src/lib/schema-fingerprint.ts) المبنية من metadata دلالية مرتبة لا
 * تتأثر بترتيب الأعمدة الفيزيائي.
 */
export { computeSchemaFingerprint } from "@/lib/schema-fingerprint";

export function configFingerprint(): string {
  // بصمة إعدادات غير سرية فقط — لا أسرار تمر من هنا إطلاقًا
  const cfg = JSON.stringify({ businessTzOffsetMinutes: businessTzOffsetMinutes() });
  return "sha256:" + createHash("sha256").update(cfg).digest("hex");
}

/** عدّ الجداول الخمسة عبر Prisma فعليًا (فشل استعلام = MISSING_TABLES). */
export async function collectCounts(client: PrismaClient): Promise<{
  ok: true;
  counts: BackupManifestV2["counts"];
} | { ok: false; missingTable: string }> {
  try {
    const [users, groups, reports, workflowHistory, auditLog] = await Promise.all([
      client.user.count(),
      client.group.count(),
      client.report.count(),
      client.workflowHistory.count(),
      client.auditLog.count(),
    ]);
    return { ok: true, counts: { users, groups, reports, workflowHistory, auditLog } };
  } catch {
    return { ok: false, missingTable: "أحد الجداول الإلزامية غير موجود/غير متوافق مع Prisma" };
  }
}

export async function collectPeriodRange(client: PrismaClient): Promise<BackupManifestV2["periodRange"]> {
  const agg = await client.report.aggregate({ _min: { periodEnd: true }, _max: { periodEnd: true } });
  return { minPeriodEnd: agg._min.periodEnd ?? null, maxPeriodEnd: agg._max.periodEnd ?? null };
}

export async function collectDataRange(client: PrismaClient): Promise<BackupManifestV2["dataRange"]> {
  const [oldC, newU] = await Promise.all([
    client.report.aggregate({ _min: { createdAt: true } }),
    client.report.aggregate({ _max: { updatedAt: true } }),
  ]);
  return {
    oldestCreatedAt: oldC._min.createdAt?.toISOString() ?? null,
    newestUpdatedAt: newU._max.updatedAt?.toISOString() ?? null,
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  البناء والتحقق الشكلي                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

export function buildManifest(input: {
  backupId: string;
  backupType: BackupType;
  createdBy: { id: string | null; username: string };
  schemaVersion: string;
  /** البصمة الفيزيائية (تشخيصية). */
  schemaFingerprint: string;
  /** البصمة القاعدية الدلالية الحاكمة — إلزامية في v3. */
  canonicalSchemaFingerprint: string;
  database: BackupManifestV2["database"];
  counts: BackupManifestV2["counts"];
  periodRange: BackupManifestV2["periodRange"];
  dataRange: BackupManifestV2["dataRange"];
  level: VerificationLevel;
}): BackupManifestV3 {
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    backupId: input.backupId,
    backupType: input.backupType,
    createdAt: new Date().toISOString(),
    createdBy: { id: input.createdBy.id ?? null, username: input.createdBy.username ?? "" },
    appVersion: appVersion(),
    schemaVersion: input.schemaVersion,
    schemaFingerprint: input.schemaFingerprint,
    canonicalSchemaFingerprint: input.canonicalSchemaFingerprint,
    database: input.database,
    counts: input.counts,
    periodRange: input.periodRange,
    dataRange: input.dataRange,
    environment: {
      businessTzOffsetMinutes: businessTzOffsetMinutes(),
      configFingerprint: configFingerprint(),
    },
    verification: { level: input.level, validatedAt: null, drillAt: null, drillOperationId: null },
    authenticity: { note: AUTHENTICITY_NOTE, manifestHmac: null },
  };
}

/**
 * تحقق شكلي صارم — لا ثقة بأي Manifest قبل اجتيازه.
 * يقبل formatVersion 2 و3 (توافق legacy موثق — لا كسر صامت للنسخ القائمة).
 */
export function isManifestShape(x: unknown): x is AnyBackupManifest {
  if (!x || typeof x !== "object") return false;
  const m = x as Record<string, unknown>;
  if (m.formatVersion !== 2 && m.formatVersion !== 3) return false;
  if (typeof m.backupId !== "string" || m.backupId.length === 0) return false;
  if (typeof m.backupType !== "string") return false;
  if (typeof m.createdAt !== "string") return false;
  if (typeof m.appVersion !== "string") return false;
  if (typeof m.schemaVersion !== "string") return false;
  if (typeof m.schemaFingerprint !== "string" || !m.schemaFingerprint.startsWith("sha256:")) return false;
  if (m.formatVersion === 3) {
    if (typeof m.canonicalSchemaFingerprint !== "string") return false;
    if (!m.canonicalSchemaFingerprint.startsWith("csha256:")) return false;
  }
  const db = m.database as Record<string, unknown> | undefined;
  if (!db || db.filename !== "database.db") return false;
  if (typeof db.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(db.sha256)) return false;
  if (typeof db.bytes !== "number" || db.bytes <= 0) return false;
  if (typeof m.counts !== "object" || m.counts === null) return false;
  if (typeof m.periodRange !== "object" || m.periodRange === null) return false;
  if (typeof m.verification !== "object" || m.verification === null) return false;
  const v = m.verification as Record<string, unknown>;
  if (!["CREATED", "VALIDATED", "RESTORE_VERIFIED"].includes(String(v.level))) return false;
  if (typeof m.authenticity !== "object" || m.authenticity === null) return false;
  return true;
}

export function parseManifest(json: string): AnyBackupManifest | null {
  try {
    const obj = JSON.parse(json);
    if (isManifestShape(obj)) return obj;
    return null;
  } catch {
    return null;
  }
}

/** تسمية إصدار المخطط الحالي في الكود. */
export const CURRENT_SCHEMA_LABEL = "v4-phase3.5B";
