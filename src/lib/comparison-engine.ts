// Phase 6.9 — محرك المقارنة الموحد (وحدة نقية — client+server safe).
//
// الضوابط المعتمدة (تعليمات 6.9-7/8/9/10):
//   - كل الحسابية على bigint (minor) — يُمنع Number على المبالغ إطلاقًا؛
//     النسب المئوية تُحسب بتقسيم BigInt مُعايَر (بلا Infinity/NaN إطلاقًا).
//   - الحقائق الرقمية منفصلة عن التفسير الإداري — تفسير حتمي قابل للشرح
//     بلا LLM ولا أسباب غير مدعومة (لا «بسبب انخفاض المبيعات» إلخ).
//   - قاعدة ف/غ = الدالة المركزية الوحيدة favorabilityFor (lib/budget) حرفيًا —
//     أرصدة وبنود أخرى ⇒ بلا ف/غ. الفارق الرقمي منفصل عن الدلالة.
//   - عتبات المراجعة مركزية في تكوين واحد — لا أرقام سحرية موزعة في الواجهة.
//   - المقارنة الناقصة حالة معلنة (NO_COMPARISON_DATA إلخ) — لا أصفار مُختلقة.

import { favorabilityFor, type Favorability } from "./budget";
import {
  bilingual,
  type ReportLanguage,
  REPORT_LANGUAGES,
} from "./display-labels";

/* ──────────────────────────────────────────────────────────────────────────
 * أنواع العقد الموحدة (Normalized comparison row — عقد 6.9-14)
 * ────────────────────────────────────────────────────────────────────────── */

export type ComparisonDirection = "INCREASE" | "DECREASE" | "NO_CHANGE" | "NOT_COMPARABLE";

export type ComparisonValueStatus =
  | "OK"
  | "INCOMPLETE_DATA"
  | "NO_COMPARISON_DATA"
  | "NO_APPROVED_BUDGET"
  | "NOT_COMPARABLE";

export type ReviewFlag =
  | "LARGE_VARIANCE"
  | "LARGE_VARIANCE_PERCENT"
  | "MISSING_COMPARISON"
  | "UNCLASSIFIED_ACCOUNT"
  | "INCOMPLETE_DATA";

export const REVIEW_FLAG_LABELS: Record<ReviewFlag, string> = {
  LARGE_VARIANCE: "تغير مادي بالمبلغ",
  LARGE_VARIANCE_PERCENT: "تغير مادي بالنسبة",
  MISSING_COMPARISON: "بيانات مقارنة ناقصة",
  UNCLASSIFIED_ACCOUNT: "حساب غير مصنف بالكامل",
  INCOMPLETE_DATA: "بيانات غير مكتملة",
};

export const DIRECTION_LABELS: Record<ComparisonDirection, string> = {
  INCREASE: "ارتفاع",
  DECREASE: "انخفاض",
  NO_CHANGE: "دون تغير جوهري",
  NOT_COMPARABLE: "غير قابل للمقارنة",
};

/** تسميات حالة القيمة — عربية أساسية بلا أكواد تقنية في النص الأساسي
 *  (الكود التقني يبقى متاحًا للواجهة في title/details — جولة المراجعة D/G). */
export const COMPARISON_VALUE_STATUS_LABELS: Record<ComparisonValueStatus, string> = {
  OK: "متاح",
  INCOMPLETE_DATA: "بيانات غير مكتملة",
  NO_COMPARISON_DATA: "لا تتوفر بيانات للمقارنة",
  NO_APPROVED_BUDGET: "لا توجد موازنة معتمدة",
  NOT_COMPARABLE: "غير قابل للمقارنة بهذا العرض/الوضع",
};

/** تسمية مرجع المقارنة — تُستخدم في نص الحقيقة والترويسة. */
export const COMPARISON_BASIS_LABELS: Record<string, string> = {
  NONE: "بدون مقارنة",
  PRIOR_PERIOD: "الفترة السابقة",
  PRIOR_YEAR_PERIOD: "الفترة المناظرة من السنة السابقة",
  BUDGET: "الموازنة المعتمدة",
  YTD: "التراكمي حتى الفترة",
  YTD_AVERAGE: "متوسط التراكمي للفترات المنقضية",
};

/** تسميات المرجع بالإنجليزية (أساس ثنائي اللغة — جولة المراجعة E). */
export const COMPARISON_BASIS_LABELS_EN: Record<string, string> = {
  NONE: "no comparison",
  PRIOR_PERIOD: "the prior period",
  PRIOR_YEAR_PERIOD: "the same period of the prior year",
  BUDGET: "the approved budget",
  YTD: "the year-to-date total",
  YTD_AVERAGE: "the YTD average",
};

/** تسمية مرجع المقارنة بلغة التقرير (null عند NONE). */
export function comparisonBasisLabel(mode: string | null | undefined, lang: ReportLanguage): string | null {
  if (!mode || mode === "NONE") return null;
  return bilingual(COMPARISON_BASIS_LABELS[mode] ?? mode, COMPARISON_BASIS_LABELS_EN[mode] ?? mode, lang);
}

/* ──────────────────────────────────────────────────────────────────────────
 * أوضاع العرض والمقارنة (6.9-2/4) — ثوابت مركزية تستهلكها الخدمة والواجهة
 * ────────────────────────────────────────────────────────────────────────── */

export const PRESENTATION_MODES = {
  ALL_ACCOUNTS: "ALL_ACCOUNTS",
  MAIN_ACCOUNTS: "MAIN_ACCOUNTS",
  LEAF_ACCOUNTS: "LEAF_ACCOUNTS",
  ACCOUNT_LEVEL: "ACCOUNT_LEVEL",
  STATEMENT_MAPPING: "STATEMENT_MAPPING",
} as const;

export type PresentationMode = (typeof PRESENTATION_MODES)[keyof typeof PRESENTATION_MODES];

export const PRESENTATION_MODE_LABELS: Record<PresentationMode, string> = {
  ALL_ACCOUNTS: "عرض كافة الحسابات",
  MAIN_ACCOUNTS: "الحسابات الرئيسية",
  LEAF_ACCOUNTS: "الحسابات الفرعية",
  ACCOUNT_LEVEL: "حسب مستوى الحساب",
  STATEMENT_MAPPING: "عرض حسب تصنيف القوائم المالية",
};

/** ملاحظة إلزامية للعرض حسب التصنيف — لا ادعاء IFRS تلقائيًا (تعليمات 6.9-2E). */
export const STATEMENT_MAPPING_DISCLAIMER =
  "عرض حسب تصنيف القوائم المالية — تجميع للحسابات وفق خريطة بنود القوائم المضبوطة للشركة؛ لا يعني هذا العرض بذاته امتثالًا تلقائيًا لمعايير IFRS (الامتثال يتطلب إطار عرض معتمدًا ومضبوطًا صراحة).";

export const COMPARISON_MODES = {
  NONE: "NONE",
  PRIOR_PERIOD: "PRIOR_PERIOD",
  PRIOR_YEAR_PERIOD: "PRIOR_YEAR_PERIOD",
  BUDGET: "BUDGET",
  YTD: "YTD",
  YTD_AVERAGE: "YTD_AVERAGE",
} as const;

export type ComparisonMode = (typeof COMPARISON_MODES)[keyof typeof COMPARISON_MODES];

export const COMPARISON_MODE_LABELS: Record<ComparisonMode, string> = {
  NONE: "بدون مقارنة",
  PRIOR_PERIOD: "الفترة الحالية مقابل الفترة السابقة",
  PRIOR_YEAR_PERIOD: "الفترة الحالية مقابل الفترة المناظرة من السنة السابقة",
  BUDGET: "الفعلي مقابل الموازنة",
  YTD: "الفترة الحالية مقابل التراكمي",
  YTD_AVERAGE: "الفترة الحالية مقابل متوسط التراكمي",
};

export const STATEMENT_SCOPES = {
  PROFIT_OR_LOSS: "PROFIT_OR_LOSS",
  STATEMENT_OF_FINANCIAL_POSITION: "STATEMENT_OF_FINANCIAL_POSITION",
} as const;

export type StatementScope = (typeof STATEMENT_SCOPES)[keyof typeof STATEMENT_SCOPES];

export const STATEMENT_SCOPE_LABELS: Record<StatementScope, string> = {
  PROFIT_OR_LOSS: "قائمة الربح أو الخسارة (حسابات الحركة)",
  STATEMENT_OF_FINANCIAL_POSITION: "قائمة المركز المالي (حسابات الأرصدة)",
};

/** ملاحظة وضع YTD/YTD_AVERAGE — دلالة الوضع نفسها (حركة الفترة مقابل التراكمي). */
export const YTD_MODE_NOTE =
  "دلالة هذا الوضع: حركة الفترة الحالية (لحسابات الحركة) مقابل التراكمي/متوسط التراكمي منذ بداية السنة المالية. حسابات الأرصدة غير قابلة منطقيًا لهذه المقارنة وتُعلن صراحة.";

/* ──────────────────────────────────────────────────────────────────────────
 * صف المقارنة الموحد (عقد 6.9-14 — نقية بحيث تستهلكها الواجهة والخادم والتصدير)
 * المبالغ minor كسلاسل نصية حرفية — BigInt أصلًا في الخادم.
 * ────────────────────────────────────────────────────────────────────────── */

export interface ComparisonRowDTO {
  key: string;
  label: string;
  kind: "ACCOUNT" | "GROUP" | "LINE" | "UNATTACHED" | "NET_RESULT" | "TOTAL";
  depth: number;
  level: number | null;
  accountCode: string | null;
  statementLineCode: string | null;
  mappingStatus: string | null;
  lineNature: "REVENUE" | "EXPENSE" | "OTHER";
  currentAmount: string | null;
  currentStatus: ComparisonValueStatus;
  comparisonAmount: string | null;
  comparisonStatus: ComparisonValueStatus;
  varianceAmount: string | null;
  variancePercent: string | null;
  direction: string;
  favorability: string;
  factText: string | null;
  interpretationText: string | null;
  reviewGuidance: string | null;
  flags: ReviewFlag[];
  /** تتبع كامل: كل أكواد الحسابات المصدرية المساهمة في قيمة الصف (drill-down foundation). */
  sourceAccountCodes: string[];
  /** تفصيل الحسابات الفعلية للصف (حيث يمعنى — صفوف بنود القوائم). */
  accounts?: Array<{ accountCode: string; accountName: string; valueMinor: string | null }>;
}

/* ──────────────────────────────────────────────────────────────────────────
 * تكوين المراجعة المركزي (6.9-10) — العتبات هنا حصرًا (لا UI magic numbers)
 * ────────────────────────────────────────────────────────────────────────── */

export interface ComparisonReviewConfig {
  /** نسبة التغير الجوهري (%) — |النسبة| ≥ هذه القيمة ⇒ LARGE_VARIANCE_PERCENT. */
  largeVariancePercent: number;
  /** مبلغ جوهري مطلق بوحدات minor (bigint كنص) — null = معطّل افتراضيًا؛
   *  يُضبط لكل نشر حسب حجم أرقام المنشأة (لا قيمة عالمية مُفترضة). */
  largeVarianceMinor: string | null;
}

export const DEFAULT_REVIEW_CONFIG: ComparisonReviewConfig = {
  largeVariancePercent: 25,
  largeVarianceMinor: null,
};

/* ──────────────────────────────────────────────────────────────────────────
 * حسابية آمنة (BigInt حصرًا)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * نسبة مئوية كسلسلة عشرية بدقة 0.1% من تقسيم BigInt معايَر —
 * (variance × 1000) ÷ |base| ⇒ رقم واحد عشري. آمنة لأي حجم (>2^53 بالضبط).
 * ترجع null عند base صفر/غير صالح — لا Infinity ولا NaN إطلاقًا.
 * القسمة تقاطعية (truncation) — حتمية وموثقة.
 */
export function variancePercentString(variance: bigint, base: bigint | null): string | null {
  if (base === null || base === BigInt(0)) return null;
  const absBase = base < BigInt(0) ? base * BigInt(-1) : base;
  const scaled = (variance * BigInt(1000)) / absBase; // BigInt: تقريب نحو الصفر — حتمي
  const negative = scaled < BigInt(0);
  const absScaled = negative ? scaled * BigInt(-1) : scaled;
  const whole = absScaled / BigInt(10);
  const tenth = absScaled % BigInt(10);
  const body = `${whole.toString()}.${tenth.toString()}`;
  return negative ? `-${body}` : body;
}

/** |variance| ≥ |base| × pct/100 دون أي Number — مقارنة صحيحة تمامًا.
 *  الرياضيات: variance/base×100 ≥ pct ⇔ variance×1000 ≥ base×(pct×10) — دقة 0.1%. */
export function absPercentAtLeast(variance: bigint, base: bigint | null, pct: number): boolean {
  if (base === null || base === BigInt(0)) return false;
  const absV = variance < BigInt(0) ? variance * BigInt(-1) : variance;
  const absB = base < BigInt(0) ? base * BigInt(-1) : base;
  // absV*100 ≥ absB*pct  (pct عدد عشري بمستوى 0.1 — يُضرب في 10 لصحة التقريب)
  const pctTenths = BigInt(Math.round(pct * 10));
  return absV * BigInt(1000) >= absB * pctTenths;
}

/** |amount| ≥ threshold (threshold نص minor أو null ⇒ false). */
export function absAmountAtLeast(amount: bigint, thresholdMinor: string | null): boolean {
  if (thresholdMinor === null) return false;
  let t: bigint;
  try {
    t = BigInt(thresholdMinor.trim());
  } catch {
    return false;
  }
  if (t < BigInt(0)) t = t * BigInt(-1);
  const absA = amount < BigInt(0) ? amount * BigInt(-1) : amount;
  return absA >= t;
}

/**
 * متوسط التراكمي مقرّبًا لأقرب minor (نصف بعيدًا عن الصفر) — BigInt حصرًا.
 * يُستخدم في وضع YTD_AVERAGE؛ يُذكر في النص أن المتوسط مقرّب عند عدم القابلية.
 */
export function averageRounded(totalMinor: bigint, count: number): bigint {
  if (!Number.isInteger(count) || count < 1) throw new Error("عدد فترات المتوسط غير صالح");
  const negative = totalMinor < BigInt(0);
  const abs = negative ? totalMinor * BigInt(-1) : totalMinor;
  const q = abs / BigInt(count);
  const r = abs % BigInt(count);
  const roundUp = r * BigInt(2) >= BigInt(count);
  const rounded = roundUp ? q + BigInt(1) : q;
  return negative ? rounded * BigInt(-1) : rounded;
}

/* ──────────────────────────────────────────────────────────────────────────
 * الاتجاه والتفسير الحتمي
 * ────────────────────────────────────────────────────────────────────────── */

export function directionOf(variance: bigint | null): ComparisonDirection {
  if (variance === null) return "NOT_COMPARABLE";
  if (variance > BigInt(0)) return "INCREASE";
  if (variance < BigInt(0)) return "DECREASE";
  return "NO_CHANGE";
}

export interface InterpretationInput {
  direction: ComparisonDirection;
  favorability: Favorability;
  lineNature: "REVENUE" | "EXPENSE" | "OTHER";
  /** سياق المرجع: BUDGET ⇒ مصطلح الموازنة السياقي، PERIOD ⇒ محايد فترة⇄فترة. */
  basisKind: "BUDGET" | "PERIOD" | null;
  /** اسم البند/الصف ليظهر في الجملة (مثل «الإيرادات») — بلا hard-code محاسبي. */
  rowNoun?: string | null;
  /** المبلغ المنسّق جاهزًا (منسّق العملة في الخادم) — يظهر في جملة الموازنة. */
  formattedVariance?: string | null;
  formattedPercent?: string | null;
  lang?: ReportLanguage;
}

/**
 * تفسير إداري حتمي من الحقائق المعروفة فقط (6.9-8 + جولة المراجعة C/H):
 *   - الموازنة: مصطلح سياقي (أعلى/أقل من الموازنة للإيراد، تجاوز/وفر للمصروف،
 *     ضمن الموازنة عند التعادل) — لا «مواتٍ/غير مواتٍ» إطلاقًا.
 *   - فترة⇄فترة: محايد (ارتفاع/انخفاض/دون تغير جوهري) بلا حكم أداء.
 *   - الأرصدة وبنود المركز المالي: لا تقييم زيادة/وفر تلقائي — جملة صريحة.
 *   - بلا بيانات مقارنة: «لا تتوفر بيانات للمقارنة» (لا «بلا دلالة ف/غ»).
 */
export function interpretationTextOf(input: InterpretationInput): string {
  const { direction, favorability, lineNature, basisKind } = input;
  const lang = input.lang ?? REPORT_LANGUAGES.AR;
  const noun = (input.rowNoun ?? "").trim();
  const amountPart =
    input.formattedVariance
      ? lang === REPORT_LANGUAGES.EN
        ? ` by ${input.formattedVariance}`
        : ` بمبلغ ${input.formattedVariance}`
      : "";
  const pctPart =
    input.formattedPercent
      ? lang === REPORT_LANGUAGES.EN
        ? ` (${input.formattedPercent}%)`
        : `، بنسبة ${input.formattedPercent}%`
      : "";
  const nounEn = noun && lang === REPORT_LANGUAGES.EN ? `${noun} ` : "";
  const nounAr = noun && lang !== REPORT_LANGUAGES.EN ? `${noun} ` : "";

  if (direction === "NOT_COMPARABLE") {
    return bilingual("لا تتوفر بيانات للمقارنة.", "Comparison data is unavailable.", lang);
  }

  if (basisKind === "BUDGET") {
    const onBudget = bilingual(`${nounAr}ضمن الموازنة.`, `${nounEn || "The line "}`.trim() + ` is on budget.`, lang);
    if (favorability === "NO_FAVORABLE_UNFAVORABLE" && lineNature !== "OTHER") {
      return onBudget;
    }
    if (lineNature === "OTHER") {
      return bilingual(
        `${nounAr}لا ينطبق تقييم الزيادة/الوفر على هذا البند.`,
        `${nounEn || "For this line, "}increase/saving assessment is not applicable.`,
        lang
      );
    }
    if (direction === "NO_CHANGE") {
      return onBudget;
    }
    if (lineNature === "REVENUE") {
      return direction === "INCREASE"
        ? bilingual(
            `${nounAr}أعلى من الموازنة${amountPart}${pctPart}.`,
            `${nounEn || "The line "}is above the budget${amountPart}${pctPart}.`,
            lang
          )
        : bilingual(
            `${nounAr}أقل من الموازنة${amountPart}${pctPart}.`,
            `${nounEn || "The line "}is below the budget${amountPart}${pctPart}.`,
            lang
          );
    }
    // مصروف
    return direction === "INCREASE"
      ? bilingual(
          `${nounAr}تجاوز الموازنة${amountPart}${pctPart}.`,
          `${nounEn || "The line "}is over the budget (overrun)${amountPart}${pctPart}.`,
          lang
        )
      : bilingual(
          `${nounAr}وفر عن الموازنة${amountPart}${pctPart}.`,
          `${nounEn || "The line "}is under the budget (saving)${amountPart}${pctPart}.`,
          lang
        );
  }

  // فترة⇄فترة (أو بلا سياق) — محايد بلا حكم أداء (ارتفاع/انخفاض/دون تغير جوهري)
  const sfpSuffix =
    lineNature === "OTHER"
      ? bilingual(" — لا ينطبق تقييم الزيادة/الوفر على هذا البند.", " — Increase/saving assessment is not applicable to this line.", lang)
      : "";
  switch (direction) {
    case "NO_CHANGE":
      return (
        bilingual(
          `${nounAr}دون تغير جوهري عن المرجع.`,
          `${nounEn || "The line "}shows no material change versus the reference.`,
          lang
        ) + sfpSuffix
      );
    case "INCREASE":
      return (
        bilingual(
          `${noun ? `ارتفاع في ${noun}` : "ارتفاع عن المرجع"}${amountPart}${pctPart} مقارنة بالمرجع.`,
          `${nounEn ? `Increase in ${noun.trim()}` : "Increased"}${amountPart}${pctPart} versus the reference.`,
          lang
        ) + sfpSuffix
      );
    case "DECREASE":
      return (
        bilingual(
          `${noun ? `انخفاض في ${noun}` : "انخفاض عن المرجع"}${amountPart}${pctPart} مقارنة بالمرجع.`,
          `${nounEn ? `Decrease in ${noun.trim()}` : "Decreased"}${amountPart}${pctPart} versus the reference.`,
          lang
        ) + sfpSuffix
      );
  }
}

/** نص الحقيقة الرقمية — أرقام minor نصية؛ تُنسّق عبر منسّق العملة إن مُمرِّر. */
export interface FactInput {
  direction: ComparisonDirection;
  varianceMinor: string | null;
  variancePercent: string | null;
  basisLabel: string | null;
  /** منسّق مبلغ اختياري (formatMinor + العملة) — يُستخدم للنص المعروض حصرًا. */
  formatAmount?: (minor: string) => string;
  lang?: ReportLanguage;
}

export function factTextOf(input: FactInput): string | null {
  const { direction, varianceMinor, variancePercent, basisLabel } = input;
  const lang = input.lang ?? REPORT_LANGUAGES.AR;
  const fmt = (v: string): string => (input.formatAmount ? input.formatAmount(v) : v);
  const basisAr = basisLabel ?? "المرجع";
  const basisEn = basisLabel ?? "the reference";
  if (direction === "NOT_COMPARABLE") {
    return bilingual(
      basisLabel
        ? `لا تتوفر بيانات ${basisAr} أو لا تنطبق المقارنة، لذلك لم يتم احتساب نسبة التغير.`
        : "لا تتوفر بيانات المقارنة، لذلك لم يتم احتساب نسبة التغير.",
      basisLabel
        ? `Data for ${basisEn} is unavailable or the comparison does not apply; no change percentage was computed.`
        : "Comparison data is unavailable; no change percentage was computed.",
      lang
    );
  }
  if (direction === "NO_CHANGE") {
    return bilingual(`لا تغير عن ${basisAr}.`, `No change versus ${basisEn}.`, lang);
  }
  if (lang === REPORT_LANGUAGES.EN) {
    const pct = variancePercent !== null ? ` (${variancePercent}%)` : " (percentage undetermined — zero or missing base)";
    const amt = varianceMinor !== null ? ` by ${fmt(varianceMinor)}` : "";
    return direction === "INCREASE"
      ? `The line increased${amt}${pct} compared to ${basisEn}.`
      : `The line decreased${amt}${pct} compared to ${basisEn}.`;
  }
  const pct = variancePercent !== null ? ` وبنسبة ${variancePercent}%` : " (النسبة غير محسومة — مرجع صفر أو ناقص)";
  const amt = varianceMinor !== null ? ` بمبلغ ${fmt(varianceMinor)}` : "";
  return direction === "INCREASE"
    ? `ارتفع البند${amt}${pct} مقارنة بـ${basisAr}.`
    : `انخفض البند${amt}${pct} مقارنة بـ${basisAr}.`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * حساب صف مقارنة موحد
 * ────────────────────────────────────────────────────────────────────────── */

export interface CompareRowCoreInput {
  currentMinor: bigint | null;
  currentStatus: ComparisonValueStatus;
  comparisonMinor: bigint | null;
  comparisonStatus: ComparisonValueStatus;
  /** طبيعة البند لقاعدة ف/غ (إيراد/مصروف/أخرى) — من التصنيف الفعلي للحسابات. */
  lineNature: "REVENUE" | "EXPENSE" | "OTHER";
  mappingStatus: string | null;
  /** مرجع المقارنة للتسمية (الفترة السابقة/الموازنة…). */
  basisLabel: string | null;
  /** سياق المرجع للمصطلح السياقي: الموازنة ⇒ صياغة الموازنة، غيره ⇒ محايد. */
  basisKind?: "BUDGET" | "PERIOD" | null;
  /** اسم الصف للجملة التفسيرية (مثل اسم بند القائمة). */
  rowNoun?: string | null;
  /** لغة التقرير (أساس ثنائي اللغة — افتراضي عربي). */
  lang?: ReportLanguage;
  /** منسّق المبالغ للنصوص المعروضة (formatMinor + عملة) — لا يمس الحسابية إطلاقًا. */
  formatAmount?: (minor: string) => string;
  reviewConfig?: ComparisonReviewConfig;
}

export interface CompareRowCore {
  varianceMinor: string | null;
  variancePercent: string | null;
  direction: ComparisonDirection;
  favorability: Favorability;
  factText: string | null;
  interpretationText: string | null;
  reviewGuidance: string | null;
  flags: ReviewFlag[];
}

/**
 * حساب نواة صف المقارنة: الفارق ثم النسبة ثم الاتجاه ثم ف/غ ثم التفسير والعلامات.
 * مسار واحد مركزي — تستهلكه كل أوضاع العرض والمقارنة (بلا حساب مقارنة في الواجهة).
 */
export function compareRowCore(input: CompareRowCoreInput): CompareRowCore {
  const cfg = input.reviewConfig ?? DEFAULT_REVIEW_CONFIG;
  const lang = input.lang ?? REPORT_LANGUAGES.AR;
  const basisKind = input.basisKind ?? (input.basisLabel === COMPARISON_BASIS_LABELS.BUDGET ? "BUDGET" : "PERIOD");
  const bothOk = input.currentStatus === "OK" && input.comparisonStatus === "OK" &&
    input.currentMinor !== null && input.comparisonMinor !== null;

  const variance = bothOk ? input.currentMinor! - input.comparisonMinor! : null;
  const varianceMinor = variance === null ? null : variance.toString();
  const variancePercent = bothOk && input.comparisonMinor !== null
    ? variancePercentString(variance!, input.comparisonMinor)
    : null;
  const direction = directionOf(variance);
  const favorability = favorabilityFor(input.lineNature, input.currentMinor, input.comparisonMinor);

  const flags: ReviewFlag[] = [];
  if (input.mappingStatus !== null && input.mappingStatus !== "FULLY_MAPPED") flags.push("UNCLASSIFIED_ACCOUNT");
  if (input.currentStatus !== "OK" && input.currentStatus !== "NOT_COMPARABLE") flags.push("INCOMPLETE_DATA");
  if (input.currentStatus === "OK" && input.comparisonStatus !== "OK") flags.push("MISSING_COMPARISON");
  if (variance !== null && absPercentAtLeast(variance, input.comparisonMinor, cfg.largeVariancePercent)) {
    flags.push("LARGE_VARIANCE_PERCENT");
  }
  if (variance !== null && absAmountAtLeast(variance, cfg.largeVarianceMinor)) flags.push("LARGE_VARIANCE");

  const guidance: string[] = [];
  if (flags.includes("LARGE_VARIANCE_PERCENT") || flags.includes("LARGE_VARIANCE")) {
    guidance.push(bilingual("يوصى بمراجعة أسباب التغير الجوهري.", "It is advisable to review the causes of the material change.", lang));
  }
  if (flags.includes("UNCLASSIFIED_ACCOUNT")) {
    guidance.push(bilingual("يوصى استكمال تصنيف الحساب من دليل الحسابات والتصنيف.", "It is advisable to complete the account classification in the chart of accounts.", lang));
  }
  if (flags.includes("MISSING_COMPARISON")) {
    guidance.push(bilingual("لا تتوفر بيانات الفترة المقارنة — لم تُحتسب نسبة التغير ولا يُصدر حكم.", "Comparison-period data is unavailable — no change percentage was computed and no judgment is issued.", lang));
  }

  const fmtVariance = varianceMinor !== null && input.formatAmount ? input.formatAmount(varianceMinor) : varianceMinor;

  return {
    varianceMinor,
    variancePercent,
    direction,
    favorability,
    factText: factTextOf({ direction, varianceMinor, variancePercent, basisLabel: input.basisLabel, formatAmount: input.formatAmount, lang }),
    interpretationText: interpretationTextOf({
      direction,
      favorability,
      lineNature: input.lineNature,
      basisKind,
      rowNoun: input.rowNoun ?? null,
      formattedVariance: fmtVariance,
      formattedPercent: variancePercent,
      lang,
    }),
    reviewGuidance: guidance.length > 0 ? guidance.join(" ") : null,
    flags,
  };
}

/** طبيعة البند من تصنيف الحسابات (بيانات محركة — لا hard-code). */
export function lineNatureFromClassification(classification: string | null | undefined): "REVENUE" | "EXPENSE" | "OTHER" {
  if (classification === "REVENUE") return "REVENUE";
  if (classification === "EXPENSE") return "EXPENSE";
  return "OTHER";
}
