// Phase 6.2B — أساس ميزان المراجعة المحفوظ (وحدة نقية — client+server safe).
//
// الغرض: يُرفع ميزان المراجعة مرة واحدة للشركة/الفترة ثم تقرأ منه كل التقارير
// اللاحقة (6.2C/6.2D) — لا إعادة رفع Excel لكل تقرير.
//
// الضوابط المعتمدة:
//   - dataType صريح إلزامي من المستخدم — لا تخمين النوع من الملف إطلاقًا:
//       CUMULATIVE_YTD  = «الأرصدة/الحركات التراكمية من بداية السنة المالية حتى تاريخ نهاية الفترة»
//       PERIOD_MOVEMENT = «حركة الفترة المحددة فقط»
//   - لا افتراض يناير ولا سنة ميلادية: التهيئة الزمنية عبر FiscalYear/FiscalPeriod
//     الفعلية، وfromDate/toDate يجب أن يطابقا حدود فترات داخل نفس السنة المالية.
//   - الدقة: BigInt بوحدات secondary (amountMinor) — لا floating point في الحساب
//     المالي الأساسي. التحويل من النص العشري exact، ورفض قيم أدق من minorUnits
//     (لا تقريب صامت أبدًا). minorUnits من عملة الشركة الموثقة (currencies.ts)
//     أو الافتراضي الموثق 2 حتى تُضبط العملة — لا تخمين من اسم الشركة.
//   - fail-closed: أي صف غير مفسر/حساب مكرر/ملف فارغ ⇒ رفض واضح بترقيم الصفوف.

import { isSupportedCurrency, CURRENCIES } from "./currencies";
import type { MappingStatus, MappingSource } from "./account-nature";

/* ──────────────────────────────────────────────────────────────────────────
 * الثوابت والتسميات
 * ────────────────────────────────────────────────────────────────────────── */

export const TB_DATA_TYPES = {
  CUMULATIVE_YTD: "CUMULATIVE_YTD",
  PERIOD_MOVEMENT: "PERIOD_MOVEMENT",
} as const;

export type TrialBalanceDataType = (typeof TB_DATA_TYPES)[keyof typeof TB_DATA_TYPES];

export const TB_DATA_TYPE_LABELS: Record<TrialBalanceDataType, string> = {
  CUMULATIVE_YTD: "تراكمي من بداية السنة (YTD)",
  PERIOD_MOVEMENT: "حركة الفترة فقط",
};

export const TB_DATA_TYPE_DESCRIPTIONS: Record<TrialBalanceDataType, string> = {
  CUMULATIVE_YTD:
    "الأرصدة/الحركات التراكمية من بداية السنة المالية حتى تاريخ نهاية الفترة",
  PERIOD_MOVEMENT: "حركة الفترة المحددة فقط",
};

export const TB_STATUSES = {
  DRAFT: "DRAFT",
  UNBALANCED: "UNBALANCED",
  COMMITTED: "COMMITTED",
} as const;

export type TrialBalanceStatus = (typeof TB_STATUSES)[keyof typeof TB_STATUSES];

export const TB_STATUS_LABELS: Record<TrialBalanceStatus, string> = {
  DRAFT: "مسودة مُتحقق منها",
  UNBALANCED: "غير متوازن (مدين ≠ دائن) — لا يُعتمد",
  COMMITTED: "معتمد ومجمّد",
};

/** الافتراضي الموثق لوحدات secondary حتى تُضبط عملة الشركة (لا تخمين من الاسم). */
export const DEFAULT_MINOR_UNITS = 2;

/** minorUnits من عملة الشركة الموثقة حصرًا — وإلا الافتراضي الموثق. */
export function minorUnitsForCurrency(functionalCurrency: string | null | undefined): number {
  if (typeof functionalCurrency === "string" && isSupportedCurrency(functionalCurrency)) {
    return CURRENCIES[functionalCurrency].minorUnits;
  }
  return DEFAULT_MINOR_UNITS;
}

/* ──────────────────────────────────────────────────────────────────────────
 * الأخطاء
 * ────────────────────────────────────────────────────────────────────────── */

export type TrialBalanceErrorCode =
  | "INVALID_DATE_RANGE"
  | "DATE_OUTSIDE_FISCAL_YEAR"
  | "CROSSES_FISCAL_YEARS"
  | "DATE_NOT_PERIOD_ALIGNED"
  | "FISCAL_YEAR_NOT_FOUND"
  | "INVALID_DATA_TYPE"
  | "INVALID_LINE"
  | "DUPLICATE_ACCOUNT"
  | "EMPTY_FILE"
  | "COMPANY_REQUIRED"
  | "DUPLICATE_IMPORT"
  | "DUPLICATE_COMMITTED"
  | "NOT_BALANCED"
  | "FISCAL_LIFECYCLE"
  | "VERSION_CONFLICT"
  | "NOT_FOUND"
  | "COPY_UNAVAILABLE"
  // Phase 6.3 — حوكمة المراجعات
  | "INVALID_STATE"
  | "REASON_REQUIRED"
  | "REVISION_SOURCE_NOT_LATEST"
  | "REVISION_DRAFT_EXISTS"
  | "REVISION_STALE"
  // Phase 6.5 — الموازنات
  | "INCOMPLETE_DATA"
  | "INVALID_BUDGET_TYPE"
  | "INVALID_TRANSITION"
  | "INVALID_LINE";

export class TrialBalanceError extends Error {
  code: TrialBalanceErrorCode;
  detail?: Record<string, unknown>;
  constructor(code: TrialBalanceErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.name = "TrialBalanceError";
    this.detail = detail;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * الدقة المالية — تحويل عشري exact إلى minor units
 * ────────────────────────────────────────────────────────────────────────── */

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/**
 * تحويل قيمة مبلغ (رقم/نص) إلى BigInt بوحدات secondary بدقة تامة:
 *   - يقبل أرقامًا ونصوصًا (بفواصل عربية/إنجليزية وأرقام عربية).
 *   - المسار exact: نص عشري ⇒ عدد صحيح موسّع — لا parseFloat في أي خطوة حسابية.
 *   - يرفض أي قيمة أدق من minorUnits (لا تقريب صامت — قرار fail-closed).
 */
export function decimalToMinor(raw: unknown, minorUnits: number, fieldLabel = "المبلغ"): bigint {
  if (raw === null || raw === undefined || raw === "") return BigInt(0);
  let s: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new TrialBalanceError("INVALID_LINE", `${fieldLabel}: قيمة رقمية غير صالحة.`);
    }
    // أقصر تمثيل round-trip للرقم — بلا فقد يصل قيم ≤ 15 محرفًا معنويًا.
    s = String(raw);
  } else if (typeof raw === "string") {
    s = raw
      .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
      .replace(/[,\s،]/g, "")
      .trim();
  } else {
    throw new TrialBalanceError("INVALID_LINE", `${fieldLabel}: نوع قيمة غير مدعوم.`);
  }
  if (s.length === 0) return BigInt(0);
  const neg = s.startsWith("-") || s.startsWith("(");
  s = s.replace(/^[-+]/, "").replace(/[()]/g, "");
  const dot = s.indexOf(".");
  const intPart = dot >= 0 ? s.slice(0, dot) : s;
  const fracPart = dot >= 0 ? s.slice(dot + 1) : "";
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart) || (intPart === "" && fracPart === "")) {
    throw new TrialBalanceError("INVALID_LINE", `${fieldLabel}: «${String(raw)}» ليس مبلغًا صالحًا.`);
  }
  if (fracPart.length > minorUnits) {
    throw new TrialBalanceError(
      "INVALID_LINE",
      `${fieldLabel}: «${s}» أدق من ${minorUnits} خانة عشرية المسموحة — صحّح القيمة أو اضبط عملة الشركة (لا تقريب صامت).`,
      { value: String(raw), minorUnits }
    );
  }
  const padded = fracPart.padEnd(minorUnits, "0");
  const digits = (intPart === "" ? "0" : intPart) + padded;
  const value = BigInt(digits === "" ? "0" : digits);
  return neg ? -value : value;
}

/** إعادة المبلغ إلى نص عشري مقروء من minor units (للعرض فقط — لا حساب). */
export function minorToDecimalString(minor: bigint, minorUnits: number): string {
  const neg = minor < BigInt(0);
  const abs = neg ? -minor : minor;
  const s = abs.toString().padStart(minorUnits + 1, "0");
  const intPart = s.slice(0, s.length - minorUnits);
  const fracPart = minorUnits > 0 ? s.slice(s.length - minorUnits) : "";
  return `${neg ? "-" : ""}${intPart}${minorUnits > 0 ? `.${fracPart}` : ""}`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * الحل الزمني — Company → FiscalYear → FiscalPeriod (بلا يناير صلب)
 * ────────────────────────────────────────────────────────────────────────── */

export interface FiscalYearLike {
  id: string;
  startDate: string; // date-only YYYY-MM-DD
  endDate: string;
  status: string; // OPEN | CLOSED | LOCKED
  code: string;
  displayNameAr: string;
}

export interface FiscalPeriodLike {
  id: string;
  ordinal: number;
  startDate: string;
  endDate: string;
  status: string; // OPEN | CLOSED
  displayLabel: string;
}

export interface ResolvedFiscalContext {
  fiscalYear: FiscalYearLike;
  startPeriod: FiscalPeriodLike;
  endPeriod: FiscalPeriodLike;
  /** كل الفترات المغطاة (start..end) مرتبة — للحارس الدوري عند الاعتماد. */
  coveredPeriods: FiscalPeriodLike[];
}

/** مقارنة date-only strings = ترتيب زمني صحيح (YYYY-MM-DD). */
function isDateOnly(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * حل السياق المالي لمدى تواريخ داخل سنة مالية واحدة (بلا افتراض يناير):
 *   - From ≤ To، كلاهما داخل FiscalYear واحدة،
 *   - fromDate = بداية فترة الابتداء بالضبط، toDate = نهاية فترة الانتهاء بالضبط
 *     (محاذاة فترات صارمة — منع المدى النصفي الغامض).
 *   - مثال معتمد: FY 2027-07-01→2028-06-30 ورفع 2027-07-01→2027-09-30
 *     ⇒ startOrdinal=1 وendOrdinal=3 ويبدأ YTD من يوليو.
 */
export function resolveFiscalContext(
  fiscalYear: FiscalYearLike,
  periods: readonly FiscalPeriodLike[],
  fromDateRaw: unknown,
  toDateRaw: unknown
): ResolvedFiscalContext {
  const fromDate = typeof fromDateRaw === "string" ? fromDateRaw.trim() : "";
  const toDate = typeof toDateRaw === "string" ? toDateRaw.trim() : "";
  if (!isDateOnly(fromDate) || !isDateOnly(toDate)) {
    throw new TrialBalanceError("INVALID_DATE_RANGE", "التواريخ إلزامية بصيغة YYYY-MM-DD.");
  }
  if (fromDate > toDate) {
    throw new TrialBalanceError("INVALID_DATE_RANGE", `من تاريخ (${fromDate}) بعد إلى تاريخ (${toDate}) — المدى غير صالح.`);
  }
  if (fromDate < fiscalYear.startDate || toDate > fiscalYear.endDate) {
    throw new TrialBalanceError(
      "DATE_OUTSIDE_FISCAL_YEAR",
      `المدى ${fromDate} → ${toDate} خارج السنة المالية ${fiscalYear.startDate} → ${fiscalYear.endDate}.`
    );
  }
  const startPeriod = periods.find((p) => p.startDate === fromDate);
  const endPeriod = periods.find((p) => p.endDate === toDate);
  if (!startPeriod || !endPeriod) {
    throw new TrialBalanceError(
      "DATE_NOT_PERIOD_ALIGNED",
      !startPeriod
        ? `من تاريخ (${fromDate}) لا يطابق بداية أي فترة — الرفع يجب أن يغطي فترات كاملة (${periods[0]?.startDate ?? "—"} أول فترة).`
        : `إلى تاريخ (${toDate}) لا يطابق نهاية أي فترة — الرفع يجب أن يغطي فترات كاملة.`
    );
  }
  if (endPeriod.ordinal < startPeriod.ordinal) {
    throw new TrialBalanceError("INVALID_DATE_RANGE", "فترة الانتهاء قبل فترة الابتداء.");
  }
  const coveredPeriods = periods
    .filter((p) => p.ordinal >= startPeriod.ordinal && p.ordinal <= endPeriod.ordinal)
    .sort((a, b) => a.ordinal - b.ordinal);
  if (coveredPeriods.length !== endPeriod.ordinal - startPeriod.ordinal + 1) {
    throw new TrialBalanceError("DATE_NOT_PERIOD_ALIGNED", "هناك فترات ناقصة داخل المدى المحدد.");
  }
  return { fiscalYear, startPeriod, endPeriod, coveredPeriods };
}

/* ──────────────────────────────────────────────────────────────────────────
 * تطبيع السطور والتحقق (قبل أي حفظ)
 * ────────────────────────────────────────────────────────────────────────── */

export interface RawTrialBalanceLine {
  accountCode: unknown;
  accountName?: unknown;
  debit: unknown;
  credit: unknown;
}

export interface NormalizedTrialBalanceLine {
  rowIndex: number; // 1-based داخل الملف
  accountCode: string;
  accountName: string;
  debitMinor: bigint;
  creditMinor: bigint;
  netMinor: bigint; // debit − credit
}

export interface NormalizedTrialBalance {
  lines: NormalizedTrialBalanceLine[];
  totalDebitMinor: bigint;
  totalCreditMinor: bigint;
  differenceMinor: bigint; // debit − credit (0 = متوازن)
  balanced: boolean;
  lineCount: number;
}

/** كود حساب مطلوب في سطر TB: 1..64 محرفًا بعد التنظيف. */
function requireLineCode(raw: unknown, rowIndex: number): string {
  const c = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (c.length < 1 || c.length > 64) {
    throw new TrialBalanceError(
      "INVALID_LINE",
      `الصف ${rowIndex}: كود الحساب مفقود أو غير صالح — الصفوف بلا كود تُرفض (لا صف فارغ غير مفسر).`
    );
  }
  return c;
}

/**
 * تطبيع سطور ميزان المراجعة والتحقق الكامل قبل الحفظ:
 *   - كود موجود لكل صف (صف بلا كود ⇒ رفض بترقيم الصف).
 *   - لا صف بلا مبالغ إطلاقًا (0/0 ⇒ رفض كصف فارغ غير مفسر).
 *   - مبالغ ≥ 0 بالتحويل exact (مدين/دائن منفصلان — لا سالب في عمود).
 *   - منع تكرار كود الحساب داخل نفس الميزان (سياسة محافظة — لا تجميع صامت).
 *   - ملف غير فارغ.
 */
export function normalizeTrialBalanceLines(
  rawLines: readonly RawTrialBalanceLine[],
  minorUnits: number
): NormalizedTrialBalance {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    throw new TrialBalanceError("EMPTY_FILE", "ميزان المراجعة فارغ — لا أساس لأي حفظ.");
  }
  if (rawLines.length > 20000) {
    throw new TrialBalanceError("INVALID_LINE", `عدد السطور ${rawLines.length} يتجاوز الحد (20000).`);
  }
  const seen = new Map<string, number>();
  const lines: NormalizedTrialBalanceLine[] = [];
  let totalDebit = BigInt(0);
  let totalCredit = BigInt(0);
  rawLines.forEach((raw, idx) => {
    const rowIndex = idx + 1;
    const accountCode = requireLineCode(raw?.accountCode, rowIndex);
    const prev = seen.get(accountCode);
    if (prev !== undefined) {
      throw new TrialBalanceError(
        "DUPLICATE_ACCOUNT",
        `كود الحساب «${accountCode}» مكرر (الصفان ${prev} و${rowIndex}) — وحّد أو احذف التكرار (لا تجميع صامت).`,
        { accountCode }
      );
    }
    seen.set(accountCode, rowIndex);
    const debitMinor = decimalToMinor(raw?.debit, minorUnits, `الصف ${rowIndex} (مدين)`);
    const creditMinor = decimalToMinor(raw?.credit, minorUnits, `الصف ${rowIndex} (دائن)`);
    if (debitMinor < BigInt(0) || creditMinor < BigInt(0)) {
      throw new TrialBalanceError(
        "INVALID_LINE",
        `الصف ${rowIndex}: قيم سالبة في عمود مدين/دائن غير مقبولة — الصوّب الإشارة أو استخدم العمود المقابل.`
      );
    }
    if (debitMinor === BigInt(0) && creditMinor === BigInt(0)) {
      throw new TrialBalanceError(
        "INVALID_LINE",
        `الصف ${rowIndex} (حساب ${accountCode}): صف فارغ غير مفسر (مدين=دائن=0) — احذفه أو صحّحه.`
      );
    }
    const netMinor = debitMinor - creditMinor;
    totalDebit += debitMinor;
    totalCredit += creditMinor;
    lines.push({
      rowIndex,
      accountCode,
      accountName: typeof raw?.accountName === "string" ? raw.accountName.trim().slice(0, 300) : "",
      debitMinor,
      creditMinor,
      netMinor,
    });
  });
  const differenceMinor = totalDebit - totalCredit;
  return {
    lines,
    totalDebitMinor: totalDebit,
    totalCreditMinor: totalCredit,
    differenceMinor,
    balanced: differenceMinor === BigInt(0),
    lineCount: lines.length,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * خلاصة المعاينة (Preview) — قبل أي حفظ
 * ────────────────────────────────────────────────────────────────────────── */

export interface MappingSnapshotLike {
  mappingStatus: MappingStatus | string | null;
  mappingSource: MappingSource | string | null;
  mainCategory: string | null;
  classification: string | null;
  aggregationBehavior: string | null;
  statementLineCode: string | null;
}

export interface TrialBalancePreviewSummary {
  total: number;
  fullyMapped: number;
  rootOnly: number;
  needsDetailedClassification: number;
  needsClassification: number;
  /** الحسابات غير المكتملة (كل ما ليس FULLY_MAPPED) — تُعرض بوضوح. */
  incompleteAccounts: Array<{
    accountCode: string;
    accountName: string;
    mappingStatus: string;
    statementLineCode: string | null;
  }>;
}

export function summarizePreview(
  lines: readonly NormalizedTrialBalanceLine[],
  mappings: readonly MappingSnapshotLike[]
): TrialBalancePreviewSummary {
  const byStatus: Record<string, number> = {
    FULLY_MAPPED: 0,
    ROOT_ONLY: 0,
    NEEDS_DETAILED_CLASSIFICATION: 0,
    NEEDS_CLASSIFICATION: 0,
  };
  const incompleteAccounts: TrialBalancePreviewSummary["incompleteAccounts"] = [];
  lines.forEach((line, i) => {
    const m = mappings[i];
    const status = String(m?.mappingStatus ?? "NEEDS_CLASSIFICATION");
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (status !== "FULLY_MAPPED") {
      incompleteAccounts.push({
        accountCode: line.accountCode,
        accountName: line.accountName,
        mappingStatus: status,
        statementLineCode: m?.statementLineCode ?? null,
      });
    }
  });
  return {
    total: lines.length,
    fullyMapped: byStatus.FULLY_MAPPED ?? 0,
    rootOnly: byStatus.ROOT_ONLY ?? 0,
    needsDetailedClassification: byStatus.NEEDS_DETAILED_CLASSIFICATION ?? 0,
    needsClassification: byStatus.NEEDS_CLASSIFICATION ?? 0,
    incompleteAccounts,
  };
}
