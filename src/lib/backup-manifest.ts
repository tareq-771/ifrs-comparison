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

export interface BackupManifestV2 {
  formatVersion: 2;
  backupId: string;
  backupType: BackupType;
  createdAt: string;
  /** وصفية فقط — لا تُستخدم للتحقق الأمني إطلاقًا (قرار المستخدم حرفيًا). */
  createdBy: { id: string | null; username: string };
  appVersion: string;
  schemaVersion: string;
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

export const MANIFEST_FORMAT_VERSION = 2;

export const AUTHENTICITY_NOTE =
  "سلامة فقط لا أصالة: SHA-256 يكتشف فساد database.db لكنه لا يوقّع هذا الملف؛ " +
  "manifestHmac محجوز لتوقيع مستقبلي. VALIDATED/RESTORE_VERIFIED ليست إثبات أصالة تشفيرية.";

export type CountsKey = (typeof REQUIRED_TABLE_COUNTS)[number];

/* ──────────────────────────────────────────────────────────────────────── */
/*  الحسابات من أي قاعدة (حية أو نسخة مؤقتة عبر Prisma)                     */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * بصمة المخطط: جرد (type, name, sql) من sqlite_master مع استثناء
 * _prisma_migrations (كي لا تتغير البصمة بعد اعتماد migrations) وجداول
 * sqlite الداخلية. تجزئة SHA-256 على تمثيل قياسي.
 */
export async function computeSchemaFingerprint(client: PrismaClient): Promise<string> {
  const rows = await client.$queryRawUnsafe<{ type: string; name: string; sql: string }[]>(
    `SELECT type, name, sql FROM sqlite_master
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'
     ORDER BY type, name`
  );
  const canon = rows
    .map((r) => `${r.type}|${r.name}|${(r.sql ?? "").replace(/\s+/g, " ").trim()}`)
    .join("\n");
  return "sha256:" + createHash("sha256").update(canon).digest("hex");
}

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
  schemaFingerprint: string;
  database: BackupManifestV2["database"];
  counts: BackupManifestV2["counts"];
  periodRange: BackupManifestV2["periodRange"];
  dataRange: BackupManifestV2["dataRange"];
  level: VerificationLevel;
}): BackupManifestV2 {
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    backupId: input.backupId,
    backupType: input.backupType,
    createdAt: new Date().toISOString(),
    createdBy: { id: input.createdBy.id ?? null, username: input.createdBy.username ?? "" },
    appVersion: appVersion(),
    schemaVersion: input.schemaVersion,
    schemaFingerprint: input.schemaFingerprint,
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

/** تحقق شكلي صارم — لا ثقة بأي Manifest قبل اجتيازه. */
export function isManifestShape(x: unknown): x is BackupManifestV2 {
  if (!x || typeof x !== "object") return false;
  const m = x as Record<string, unknown>;
  if (m.formatVersion !== MANIFEST_FORMAT_VERSION) return false;
  if (typeof m.backupId !== "string" || m.backupId.length === 0) return false;
  if (typeof m.backupType !== "string") return false;
  if (typeof m.createdAt !== "string") return false;
  if (typeof m.appVersion !== "string") return false;
  if (typeof m.schemaVersion !== "string") return false;
  if (typeof m.schemaFingerprint !== "string" || !m.schemaFingerprint.startsWith("sha256:")) return false;
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

export function parseManifest(json: string): BackupManifestV2 | null {
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
