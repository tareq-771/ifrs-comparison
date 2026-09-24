// Phase 6.10 — أعمار الديون والتحصيل: النواة النقية (client-safe بلا اعتماديات)
// كل المبالغ BigInt بوحدات minor (نصوص)، كل التواريخ "YYYY-MM-DD"، النسب basis points
// بحساب BigInt صحيح — لا NaN ولا Infinity ولا float في أي مسار مالي.
// دلالة صارمة: missing != zero — القيمة الغائبة null ولا تُحسب صفرًا أبدًا.

import { decimalStringToMinorString } from "@/lib/money";

// ── الحقول القيانية للاستيراد ────────────────────────────────────────────────
export const AGING_CANONICAL_FIELDS = [
  "CUSTOMER_CODE",
  "CUSTOMER_NAME",
  "OUTSTANDING_BALANCE",
  "INVOICE_NUMBER",
  "INVOICE_DATE",
  "INVOICE_AMOUNT",
  "DUE_DATE",
  "AGE_DAYS",
  "LAST_SALE_DATE",
  "LAST_SALE_AMOUNT",
  "LAST_COLLECTION_DATE",
  "LAST_COLLECTION_AMOUNT",
  "CREDIT_LIMIT",
  "GUARANTEE_OR_INSURANCE",
  "SALESPERSON",
  "RESPONSIBLE_PERSON",
  "NOTES",
] as const;
export type AgingCanonicalField = (typeof AGING_CANONICAL_FIELDS)[number];

export const AGING_FIELD_LABELS: Record<AgingCanonicalField, { ar: string; en: string }> = {
  CUSTOMER_CODE: { ar: "كود العميل", en: "Customer Code" },
  CUSTOMER_NAME: { ar: "اسم العميل", en: "Customer Name" },
  OUTSTANDING_BALANCE: { ar: "الرصيد المستحق", en: "Outstanding Balance" },
  INVOICE_NUMBER: { ar: "رقم الفاتورة", en: "Invoice Number" },
  INVOICE_DATE: { ar: "تاريخ الفاتورة", en: "Invoice Date" },
  INVOICE_AMOUNT: { ar: "مبلغ الفاتورة", en: "Invoice Amount" },
  DUE_DATE: { ar: "تاريخ الاستحقاق", en: "Due Date" },
  AGE_DAYS: { ar: "عمر الدين (أيام)", en: "Age (Days)" },
  LAST_SALE_DATE: { ar: "تاريخ آخر بيع", en: "Last Sale Date" },
  LAST_SALE_AMOUNT: { ar: "مبلغ آخر بيع", en: "Last Sale Amount" },
  LAST_COLLECTION_DATE: { ar: "تاريخ آخر تحصيل", en: "Last Collection Date" },
  LAST_COLLECTION_AMOUNT: { ar: "مبلغ آخر تحصيل", en: "Last Collection Amount" },
  CREDIT_LIMIT: { ar: "حد الائتمان", en: "Credit Limit" },
  GUARANTEE_OR_INSURANCE: { ar: "ضمان / تأمين", en: "Guarantee / Insurance" },
  SALESPERSON: { ar: "المبيعات / البائع", en: "Salesperson" },
  RESPONSIBLE_PERSON: { ar: "المسؤول عن التحصيل", en: "Responsible Person" },
  NOTES: { ar: "ملاحظات", en: "Notes" },
};

/** مرادفات ثنائية اللغة للترجيع التلقائي للأعمدة (مطابقة بعد التطبيع). */
export const AGING_FIELD_ALIASES: Record<AgingCanonicalField, string[]> = {
  CUSTOMER_CODE: ["customer code", "customer no", "customer id", "كود العميل", "رقم العميل", "الكود"],
  CUSTOMER_NAME: ["customer name", "customer", "client name", "اسم العميل", "العميل", "الاسم"],
  OUTSTANDING_BALANCE: ["outstanding balance", "outstanding", "balance due", "balance", "الرصيد المستحق", "الرصيد", "رصيد مستحق", "المبلغ المستحق"],
  INVOICE_NUMBER: ["invoice number", "invoice no", "invoice", "رقم الفاتورة", "الفاتورة"],
  INVOICE_DATE: ["invoice date", "تاريخ الفاتورة"],
  INVOICE_AMOUNT: ["invoice amount", "مبلغ الفاتورة", "قيمة الفاتورة"],
  DUE_DATE: ["due date", "maturity date", "تاريخ الاستحقاق", "الاستحقاق"],
  AGE_DAYS: ["age days", "age", "days overdue", "عمر الدين", "العمر", "أيام التأخر"],
  LAST_SALE_DATE: ["last sale date", "last invoice date", "تاريخ آخر بيع", "آخر بيع"],
  LAST_SALE_AMOUNT: ["last sale amount", "last invoice amount", "مبلغ آخر بيع"],
  LAST_COLLECTION_DATE: ["last collection date", "last payment date", "تاريخ آخر تحصيل", "آخر تحصيل"],
  LAST_COLLECTION_AMOUNT: ["last collection amount", "last payment amount", "مبلغ آخر تحصيل"],
  CREDIT_LIMIT: ["credit limit", "حد الائتمان", "سقف الائتمان"],
  GUARANTEE_OR_INSURANCE: ["guarantee", "insurance", "ضمان", "تأمين", "الضمان"],
  SALESPERSON: ["salesperson", "sales man", "sales rep", "المبيعات", "البائع", "مندوب المبيعات"],
  RESPONSIBLE_PERSON: ["responsible person", "responsible", "collector", "المسؤول", "مسؤول التحصيل"],
  NOTES: ["notes", "note", "remarks", "ملاحظات", "ملاحظة"],
};

export type AgingMapping = Partial<Record<AgingCanonicalField, string>>;

/** تطبيع اسم عمود: ترميم + توحيد مسافات + lowercase. */
export function normalizeHeader(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase();
}

/** ترجيع تلقائي حتمي: تطابق تام بالمرادفات أولًا ثم احتواء (أول فائز بترتيب الحقول القيانية). */
export function autoMapHeaders(headers: string[]): { mapping: AgingMapping; unmapped: string[] } {
  const mapping: AgingMapping = {};
  const used = new Set<number>();
  const unmapped: string[] = [];
  const normalized = headers.map((h) => normalizeHeader(h));
  for (const field of AGING_CANONICAL_FIELDS) {
    const aliases = AGING_FIELD_ALIASES[field].map((a) => normalizeHeader(a));
    let found = -1;
    for (let i = 0; i < normalized.length; i++) {
      if (used.has(i)) continue;
      if (aliases.includes(normalized[i])) { found = i; break; }
    }
    if (found < 0) {
      for (let i = 0; i < normalized.length; i++) {
        if (used.has(i) || normalized[i].length < 3) continue;
        if (aliases.some((a) => normalized[i].includes(a) || a.includes(normalized[i]))) { found = i; break; }
      }
    }
    if (found >= 0) {
      mapping[field] = headers[found];
      used.add(found);
    }
  }
  for (let i = 0; i < headers.length; i++) if (!used.has(i)) unmapped.push(headers[i]);
  return { mapping, unmapped };
}

// ── التواريخ ────────────────────────────────────────────────────────────────
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLASH_RE = /^(\d{1,2})[\/](\d{1,2})[\/](\d{4})$/;

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}

export type ParsedDate = { date: string; ambiguous: boolean } | null;

/**
 * تحليل تاريخ حتمي: ISO أولاً؛ ثم صيغة مائلة تُفسر يوم/شهر/سنة (اصطلاح المنطقة،
 * يُعلن في التعليمات) — وإذا كان التفسير يوم-أول غير صالح جرّب شهر-أول؛ وإذا كان
 * التفسيران صالحين اعتُمد يوم-أول مع علامة ambiguous (شفافية بلا تخمين خفي).
 */
export function parseAgingDate(raw: string | null | undefined): ParsedDate {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (ISO_RE.test(s)) {
    const [y, m, d] = s.split("-").map((x) => parseInt(x, 10));
    if (!isRealDate(y, m, d)) return null;
    return { date: s, ambiguous: false };
  }
  const mSlash = SLASH_RE.exec(s);
  if (mSlash) {
    const a = parseInt(mSlash[1], 10);
    const b = parseInt(mSlash[2], 10);
    const y = parseInt(mSlash[3], 10);
    const dmyOk = isRealDate(y, b, a);
    const mdyOk = isRealDate(y, a, b);
    if (dmyOk) {
      const dd = String(a).padStart(2, "0");
      const mm = String(b).padStart(2, "0");
      return { date: `${y}-${mm}-${dd}`, ambiguous: mdyOk && a <= 12 && b <= 12 && a !== b };
    }
    if (mdyOk) {
      const dd = String(b).padStart(2, "0");
      const mm = String(a).padStart(2, "0");
      return { date: `${y}-${mm}-${dd}`, ambiguous: false };
    }
    return null;
  }
  return null;
}

const ARABIC_INDIC = /[٠-٩]/g;

/** مبلغ BigInt-آمن: يطبّع الأرقام العربية-الهندية ثم يعتمد المحوّل المركزي؛ null = غير صالح/غائب. */
export function parseAgingMoney(raw: string | null | undefined, minorUnits = 2): bigint | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(ARABIC_INDIC, (ch) => String("٠١٢٣٤٥٦٧٨٩".indexOf(ch)));
  const minor = decimalStringToMinorString(s, minorUnits);
  if (minor == null) return null;
  try {
    return BigInt(minor);
  } catch {
    return null;
  }
}

/** فرق أيام UTC بين تاريخين "YYYY-MM-DD" (to - from). */
export function daysBetween(fromDate: string, toDate: string): number | null {
  if (!ISO_RE.test(fromDate) || !ISO_RE.test(toDate)) return null;
  const a = Date.UTC(+fromDate.slice(0, 4), +fromDate.slice(5, 7) - 1, +fromDate.slice(8, 10));
  const b = Date.UTC(+toDate.slice(0, 4), +toDate.slice(5, 7) - 1, +toDate.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

// ── الشرائط ─────────────────────────────────────────────────────────────────
export interface AgingBucketDef {
  code: string;
  labelAr: string;
  labelEn: string;
  fromDays: number | null;
  toDays: number | null;
  isNotDue: boolean;
  order: number;
}

export const DEFAULT_AGING_BUCKETS: AgingBucketDef[] = [
  { code: "NOT_DUE", labelAr: "غير مستحق", labelEn: "Not Due", fromDays: null, toDays: 0, isNotDue: true, order: 1 },
  { code: "D1_30", labelAr: "1–30", labelEn: "1–30", fromDays: 1, toDays: 30, isNotDue: false, order: 2 },
  { code: "D31_60", labelAr: "31–60", labelEn: "31–60", fromDays: 31, toDays: 60, isNotDue: false, order: 3 },
  { code: "D61_90", labelAr: "61–90", labelEn: "61–90", fromDays: 61, toDays: 90, isNotDue: false, order: 4 },
  { code: "D91_180", labelAr: "91–180", labelEn: "91–180", fromDays: 91, toDays: 180, isNotDue: false, order: 5 },
  { code: "D181_365", labelAr: "181–365", labelEn: "181–365", fromDays: 181, toDays: 365, isNotDue: false, order: 6 },
  { code: "D365_PLUS", labelAr: "أكثر من 365", labelEn: ">365", fromDays: 366, toDays: null, isNotDue: false, order: 7 },
];

export const UNDETERMINED_BUCKET = {
  code: "UNDETERMINED",
  labelAr: "غير محدد الأساس",
  labelEn: "Undetermined Basis",
};

/** إسناد الشريط حتميًا: NOT_DUE بالأيام ≤ 0 بأساس الاستحقاق؛ والتقسيم الرقمي شامل الحدود. */
export function assignBucket(
  buckets: AgingBucketDef[],
  basis: AgingAgeBasis,
  daysValue: number | null
): string {
  if (basis === "NONE" || daysValue == null) return UNDETERMINED_BUCKET.code;
  if (basis === "DUE_DATE" && daysValue <= 0) {
    const notDue = buckets.find((b) => b.isNotDue);
    return notDue ? notDue.code : UNDETERMINED_BUCKET.code;
  }
  // أساس غير الاستحقاق: العمر 0 يومًا يسقط في أدنى شريط رقمي (1-30) — لا "غير محدد"
  const v = Math.max(daysValue, 1);
  for (const b of buckets) {
    if (b.isNotDue) continue;
    const fromOk = b.fromDays == null || v >= b.fromDays;
    const toOk = b.toDays == null || v <= b.toDays;
    if (fromOk && toOk) return b.code;
  }
  return UNDETERMINED_BUCKET.code;
}

export type AgingAgeBasis = "EXPLICIT" | "DUE_DATE" | "INVOICE_DATE" | "NONE";

export const AGING_BASIS_LABELS: Record<AgingAgeBasis, { ar: string; en: string }> = {
  EXPLICIT: { ar: "عمر صريح من الملف", en: "Explicit age from file" },
  DUE_DATE: { ar: "محسوب من تاريخ الاستحقاق", en: "Derived from due date" },
  INVOICE_DATE: { ar: "محسوب من تاريخ الفاتورة (تقريب معلن)", en: "Derived from invoice date (disclosed approximation)" },
  NONE: { ar: "لا يوجد أساس", en: "No basis" },
};

// ── أنواع النتائج ───────────────────────────────────────────────────────────
export interface BucketTotal {
  code: string;
  labelAr: string;
  labelEn: string;
  amountMinor: string; // "0" عندما لا مبالغ — الشريط نفسه معلن دائمًا
  count: number;
  pctBp: number; // من إجمالي الأرصدة الصالحة (BigInt → bp)
  isUndetermined?: boolean;
}

export interface AgingTotals {
  totalMinor: string | null; // null = لا صفوف صالحة إطلاقًا (INCOMPLETE_DATA)
  overdueMinor: string | null; // أساس الاستحقاق المتأخر فقط — لا مبالغة
  overduePctBp: number | null;
  validRowCount: number;
  customerCount: number;
  missingBalanceCount: number;
  missingDueDateCount: number;
  undeterminedCount: number;
  undeterminedMinor: string;
  creditBreachCount: number;
  negativeBalanceCount: number;
  weightedAvgAgeDays: number | null; // مرجّح بالرصيد (صفوف ذات عمر معلوم فقط)
  staleCollectionCount: number; // آخر تحصيل أقدم من العتبة أو لا تحصيل مع رصيد قائم
  largestDebtorKey: string | null;
  largestDebtorMinor: string | null;
  top5ConcentrationBp: number | null;
  asOfDate: string;
}

export type AgingSeverity = "INFO" | "ATTENTION" | "IMPORTANT" | "CRITICAL";
export type InsightKind = "FACT" | "ANALYSIS" | "RECOMMENDATION";

export interface AgingInsight {
  code: string;
  severity: AgingSeverity;
  kind: InsightKind;
  titleAr: string;
  titleEn: string;
  detailAr: string;
  detailEn: string;
  amountMinor?: string;
  pctBp?: number;
  affectedCount?: number;
  suggestedActionAr?: string;
  suggestedActionEn?: string;
}

export interface AgingRiskRow {
  customerKey: string;
  customerCode: string | null;
  customerName: string | null;
  balanceMinor: string;
  maxAgeDays: number | null;
  bucketCode: string;
  lastSaleDate: string | null;
  lastCollectionDate: string | null;
  creditLimitMinor: string | null;
  overCreditLimit: boolean;
  score: number; // 0..100 حتمي
  level: "HIGH" | "MEDIUM" | "LOW";
  reasonsAr: string[];
  reasonsEn: string[];
  suggestedActionAr: string;
  suggestedActionEn: string;
}

export const RISK_LEVEL_LABELS: Record<AgingRiskRow["level"], { ar: string; en: string }> = {
  HIGH: { ar: "مرتفع", en: "High" },
  MEDIUM: { ar: "متوسط", en: "Medium" },
  LOW: { ar: "منخفض", en: "Low" },
};

export const SEVERITY_LABELS: Record<AgingSeverity, { ar: string; en: string }> = {
  INFO: { ar: "معلومة", en: "Info" },
  ATTENTION: { ar: "انتباه", en: "Attention" },
  IMPORTANT: { ar: "مهم", en: "Important" },
  CRITICAL: { ar: "حرج", en: "Critical" },
};

export const INSIGHT_KIND_LABELS: Record<InsightKind, { ar: string; en: string }> = {
  FACT: { ar: "واقعة", en: "Fact" },
  ANALYSIS: { ar: "تحليل", en: "Analysis" },
  RECOMMENDATION: { ar: "توصية استشارية", en: "Recommendation" },
};

export const RECONCILIATION_STATUS_LABELS: Record<
  "RECONCILED" | "DIFFERENCE" | "NO_TB_DATA" | "NO_RECEIVABLE_MAPPING" | "INCOMPLETE_DATA",
  { ar: string; en: string }
> = {
  RECONCILED: { ar: "مطابق لميزان المراجعة", en: "Reconciled to trial balance" },
  DIFFERENCE: { ar: "فرق غير مطابق (معلن)", en: "Difference disclosed" },
  NO_TB_DATA: { ar: "لا يوجد ميزان مراجعة معتمد للمقارنة", en: "No committed trial balance" },
  NO_RECEIVABLE_MAPPING: { ar: "لم تُربط حسابات المدينين بعد", en: "No receivable accounts mapped" },
  INCOMPLETE_DATA: { ar: "بيانات غير مكتملة", en: "Incomplete data" },
};

export const AGING_SNAPSHOT_STATUS_LABELS: Record<"DRAFT" | "APPROVED", { ar: string; en: string }> = {
  DRAFT: { ar: "مسودة", en: "Draft" },
  APPROVED: { ar: "معتمدة", en: "Approved" },
};

// ── قواعد الرؤى الافتراضية ──────────────────────────────────────────────────
export type AgingInsightRuleCode =
  | "OVERDUE_RATIO_HIGH"
  | "TOP5_CONCENTRATION"
  | "CREDIT_LIMIT_BREACHES"
  | "STALE_COLLECTIONS"
  | "NEGATIVE_BALANCES"
  | "MISSING_DATA"
  | "VERY_OLD_RECEIVABLES"
  | "AGING_TREND";

export interface AgingInsightRuleDef {
  code: AgingInsightRuleCode;
  thresholdBp: number | null;
  thresholdDays: number | null;
  thresholdCount: number | null;
  severity: AgingSeverity;
}

export const DEFAULT_INSIGHT_RULES: AgingInsightRuleDef[] = [
  { code: "OVERDUE_RATIO_HIGH", thresholdBp: 2500, thresholdDays: null, thresholdCount: null, severity: "IMPORTANT" },
  { code: "TOP5_CONCENTRATION", thresholdBp: 6000, thresholdDays: null, thresholdCount: null, severity: "ATTENTION" },
  { code: "CREDIT_LIMIT_BREACHES", thresholdBp: null, thresholdDays: null, thresholdCount: 1, severity: "ATTENTION" },
  { code: "STALE_COLLECTIONS", thresholdBp: null, thresholdDays: 180, thresholdCount: null, severity: "ATTENTION" },
  { code: "NEGATIVE_BALANCES", thresholdBp: null, thresholdDays: null, thresholdCount: 1, severity: "INFO" },
  { code: "MISSING_DATA", thresholdBp: null, thresholdDays: null, thresholdCount: 1, severity: "INFO" },
  { code: "VERY_OLD_RECEIVABLES", thresholdBp: null, thresholdDays: null, thresholdCount: 1, severity: "IMPORTANT" },
  { code: "AGING_TREND", thresholdBp: 2000, thresholdDays: null, thresholdCount: null, severity: "ATTENTION" },
];

// ── رياضيات النسب (BigInt حتمية) ────────────────────────────────────────────
/** نسبة من عشرة آلاف: amount*10000/total بأرضية صحيحة — null عند مقام صفر. */
export function pctBpOf(amount: bigint, total: bigint): number | null {
  if (total === BigInt(0)) return null;
  return Number((amount * BigInt(10000)) / total);
}

/** عرض نسبة من bp: "12.3%" — تقريب لأرضية منزلة عشرية واحدة بلا float متراكم. */
export function formatBp(bp: number | null | undefined): string {
  if (bp == null) return "—";
  const sign = bp < 0 ? "-" : "";
  const abs = Math.abs(bp);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(Math.floor(frac / 10))}%`;
}

// ── حدود الاستيراد والأمان ──────────────────────────────────────────────────
export const AGING_IMPORT_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024, // 10MB للملف الأصلي
  maxPayloadBytes: 14 * 1024 * 1024, // سقف جسم الطلب JSON
  maxRows: 20000,
  maxCols: 64,
  maxCellChars: 500,
  maxErrorsStored: 200,
  batchSize: 400,
} as const;

export const AGING_CANONICAL_FIELD_LIST: readonly string[] = AGING_CANONICAL_FIELDS;
