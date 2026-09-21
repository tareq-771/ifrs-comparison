// نظام سجل التدقيق المركزي (خادم فقط — لا يستورده العميل أبدًا).
//
// الضوابط:
//  1. Append-only: لا توجد أي API تعديل/حذف على AuditLog؛ الكتابة تتم حصرًا عبر writeAudit.
//  2. Sanitize مركزي إلزامي: كل بيانات before/after/metadata تمر عبر sanitizeAuditValue
//     قبل الكتابة (منع كلمات المرور والهاش والتوكنات والأسرار وheaders المصادقة).
//  3. Before/After مقتصد: لا تُخزن نسخ ضخمة من بيانات التقارير؛ تُسجل الحقول المتغيرة
//     فقط + أحجام الكتل الكبيرة في metadata.
//  4. Transactions: عند تعديل البيانات تُمرَّر معاملة Prisma (tx) إلى writeAudit
//     لضمان نجاح العملية وتسجيل أثرها معًا أو فشلهما معًا.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AUDIT_ACTION_LABELS } from "@/lib/audit-actions";

type TxClient = Prisma.TransactionClient;

/* ──────────────────────────────────────────────────────────────────────── */
/*  Sanitize / Redact — الآلية المركزية                                     */
/* ──────────────────────────────────────────────────────────────────────── */

// مفاتيح يمنع تخزين قيمها نهائيًا (كلمات مرور، توكنات، أسرار، headers مصادقة)
const SENSITIVE_KEY_RE =
  /pass(word|wd)?|pwd|secret|token|jwt|session|authorization|auth(?:oriz|enticate)?|cookie|credential|apikey|api[-_]?key|bearer|csrf/i;

const REDACTED = "[REDACTED]";
const MAX_VALUE_LEN = 2000; // حد طول القيمة النصية الواحدة
const MAX_JSON_LEN = 120_000; // حد الحجم الكلي لحقل JSON واحد قبل الاقتطاع الآمن

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/** تنظيف تكراري عميق: يحجب المفاتيح الحساسة ويقتطع النصوص الطويلة. */
export function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    // أمان الحجم: قص المصفوفات الضخمة (بيانات Excel الخام مثلًا)
    const max = 50;
    const out = value.slice(0, max).map((v) => sanitizeAuditValue(v, depth + 1));
    if (value.length > max) out.push(`[…${value.length - max} عنصر آخر مقطوع]`);
    return out;
  }

  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      // مفاتيح حساسة: تُحجب قيمها النصية/التركيبية بالكامل (قد تحمل أسرارًا)،
      // أما الأعلام المنطقية/الأرقام (مثل passwordChanged: true) فآمنة وتُحفظ.
      if (isSensitiveKey(k)) {
        if (typeof v === "boolean" || typeof v === "number") {
          out[k] = v;
        } else {
          out[k] = REDACTED;
        }
        continue;
      }
      out[k] = sanitizeAuditValue(v, depth + 1);
    }
    return out;
  }

  if (typeof value === "string" && value.length > MAX_VALUE_LEN) {
    return value.slice(0, MAX_VALUE_LEN) + `…[مقطوع: ${value.length - MAX_VALUE_LEN} حرف]`;
  }

  return value;
}

/** تحويل قيمة إلى JSON نصي منقّي وآمن الحجم للتخزين في AuditLog. */
export function serializeAuditField(value: unknown): string {
  try {
    const safe = sanitizeAuditValue(value ?? {});
    const json = JSON.stringify(safe ?? {});
    if (json.length <= MAX_JSON_LEN) return json;
    // اقتطاع آمن: لا نكسر بنية JSON — نحفظ معاينة فقط
    const preview = json.slice(0, MAX_JSON_LEN);
    return JSON.stringify({
      __truncated: true,
      originalLength: json.length,
      preview,
    });
  } catch {
    return JSON.stringify({ __error: "تعذر تسلسل القيمة" });
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  IP — best-effort                                                        */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * استخراج IP العميل — نظام الثقة (5B.2):
 *   • البوابة الوحيدة (Caddy) تستبدل X-Forwarded-For بقيمة الاتصال المباشر
 *     {remote_host} (header_up استبدال لا إلحاق — deploy/Caddyfile.windows) —
 *     فأي XFF يصل التطبيق صدر عن البوابة حصرًا، وأي XFF ادّعاه العميل يُمسح عندها.
 *   • دفاع إضافي بالعمق (5B.2): يُعتمد آخر عنصر (rightmost) لا الأول — الأول هو
 *     ما يدّعيه العميل ويمكن انتحاله لو سُمح يومًا بتمرير XFF عبر وسيط؛ الأخير
 *     هو ما ألحقه آخر وسيط موثوق فعليًا (اتجاه الإلحاق القياسي لـXFF).
 *   • x-real-ip احتياط ثانوي (تضبطه البوابة أيضًا بـ{remote_host}).
 *   • الوصول المباشر loopback بلا بوابة ⇒ null غالبًا (يُسجل فارغًا — لا ادعاء IP).
 */
export function getClientIp(req: Request | { headers: unknown } | null | undefined): string | null {
  try {
    const h = req?.headers as
      | Headers
      | Record<string, string | string[] | undefined>
      | undefined;
    if (!h) return null;
    const get = (name: string): string | null => {
      if (typeof (h as Headers).get === "function") {
        return (h as Headers).get(name);
      }
      const v = (h as Record<string, string | string[] | undefined>)[name];
      return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
    };
    const xff = get("x-forwarded-for");
    if (xff) {
      // 5B.2: آخر عنصر = ما ألحقه آخر وسيط موثوق (الأول قابل للانتحال من العميل)
      const parts = xff
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const last = parts[parts.length - 1];
      if (last) return last.slice(0, 64);
    }
    const real = get("x-real-ip");
    if (real) return real.slice(0, 64);
    return null;
  } catch {
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  الكاتب المركزي                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

export interface AuditUser {
  id?: string | null;
  username?: string | null;
  name?: string | null;
}

export interface AuditInput {
  user?: AuditUser | null;
  /** تجاوز صريح لاسم المستخدم في الـ snapshot (لأحداث المصادقة حيث لا توجد جلسة) */
  username?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  description?: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  ip?: string | null;
}

/**
 * كتابة سجل تدقيق واحد.
 * - مرّر `tx` (معاملة Prisma) داخل عمليات التعديل لضمان الذرية مع العملية نفسها.
 * - بدون tx تكتب مباشرة (للأحداث المستقلة مثل أحداث تسجيل الدخول).
 */
export async function writeAudit(tx: TxClient | null | undefined, input: AuditInput): Promise<void> {
  const client = tx ?? db;
  const label = AUDIT_ACTION_LABELS[input.action] ?? input.action;
  await client.auditLog.create({
    data: {
      userId: input.user?.id ?? null,
      username: (
        input.username ??
        input.user?.username ??
        input.user?.name ??
        ""
      ).slice(0, 120),
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      description: (input.description || label).slice(0, 500),
      beforeData: serializeAuditField(input.before ?? {}),
      afterData: serializeAuditField(input.after ?? {}),
      metadata: serializeAuditField(input.metadata ?? {}),
      ipAddress: input.ip ?? null,
    },
  });
}

/** كتابة حدث تدقيق مستقل مع أمان كامل من الفشل (لا تعطل المسار أبدًا) — لأحداث المصادقة. */
export async function writeAuditSafe(input: AuditInput): Promise<void> {
  try {
    await writeAudit(null, input);
  } catch (error) {
    // السجل الرقابي مهم، لكن يجب ألا يكسر تسجيل الدخول أبدًا — يُسجل في سجل الخادم
    console.error("[audit] فشل كتابة حدث تدقيق:", input.action, error);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  مساعدات Before/After المقتصدة للتقارير                                  */
/* ──────────────────────────────────────────────────────────────────────── */

/** الحقول القياسية للتقرير التي تُسجل قيمتها قبل/بعد عند تغيّرها. */
export const REPORT_SCALAR_FIELDS = [
  "name",
  "label1",
  "label2",
  "compareMode",
  "numMonths",
  "groupId",
  "periodEnd",
] as const;

/** كتل JSON الكبيرة — تُسجل إشارة تغيرها وأحجامها فقط (لا محتواها). */
export const REPORT_BLOB_FIELDS = [
  "isSettings",
  "bsSettings",
  "isFile1Data",
  "isFile2Data",
  "isFile1Headers",
  "isFile2Headers",
  "isFile1Cols",
  "isFile2Cols",
  "bsFileData",
  "bsFileHeaders",
  "bsFileCols",
  "bsFile2Data",
  "bsFile2Headers",
  "bsFile2Cols",
] as const;

function canon(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function parseSafe(json: string | null | undefined): unknown {
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return json;
  }
}

/**
 * مقارنة تقرير محفوظ مع الجسم الجديد قبل التحديث.
 * تعيد: قيم الحقول القياسية المتغيرة (قبل/بعد) + إشارات تغير الكتل مع الأحجام.
 */
export function diffReportForAudit(
  existing: {
    name: string;
    label1: string;
    label2: string;
    compareMode: string;
    numMonths: number;
    groupId: string | null;
  } & Record<string, unknown>,
  body: Record<string, unknown>
): {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changedFields: string[];
  blobChanges: Record<string, { changed: boolean; sizeBefore: number; sizeAfter: number }>;
} {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const changedFields: string[] = [];
  const blobChanges: Record<string, { changed: boolean; sizeBefore: number; sizeAfter: number }> = {};

  // الحقول القياسية: قيمة قديمة/جديدة عند التغير فقط
  for (const f of REPORT_SCALAR_FIELDS) {
    if (!(f in body)) continue;
    const oldVal = (existing as Record<string, unknown>)[f] ?? null;
    const newVal = body[f] ?? null;
    if (canon(oldVal) !== canon(newVal)) {
      before[f] = oldVal;
      after[f] = newVal;
      changedFields.push(f);
    }
  }

  // الكتل: إشارة تغير + أحجام فقط
  for (const f of REPORT_BLOB_FIELDS) {
    if (!(f in body)) continue;
    const oldStr = typeof existing[f] === "string" ? (existing[f] as string) : "[]";
    const newStr = canon(body[f] ?? []);
    const changed = parseSafe(oldStr) === undefined ? true : canon(parseSafe(oldStr)) !== newStr;
    if (changed) {
      changedFields.push(f);
      blobChanges[f] = {
        changed: true,
        sizeBefore: oldStr.length,
        sizeAfter: newStr.length,
      };
    }
  }

  return { before, after, changedFields, blobChanges };
}

/** ملخص أحجام كتل التقرير (للإنشاء/الحذف) — أرقام فقط. */
export function reportBlobSizes(report: Record<string, unknown>): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const f of REPORT_BLOB_FIELDS) {
    const v = report[f];
    if (typeof v === "string") sizes[f] = v.length;
  }
  return sizes;
}
