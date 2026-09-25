// Phase 6.9R — أساس التسميات المعروضة الموحدة (وحدة نقية — آمنة للعميل والخادم).
//
// الغاية (تعليمات جولة المراجعة C/D/E):
//   - إخفاء الأكواد التقنية عن المستخدم (PNL-REVENUE / INCOMPLETE_DATA / REVENUE…) —
//     تظل معرفات داخلية، لكن النص المعروض أساسًا عربي/إنجليزي مقروء.
//   - مصطلحات سياقية بدل الترجمات الحرفية المحرجة (مواتٍ/غير مواتٍ/بلا دلالة ف/غ):
//     موازنة ⇒ أعلى/أقل من الموازنة (إيراد) و تجاوز/وفر عن الموازنة (مصروف) و ضمن الموازنة.
//     فترة⇄فترة ⇒ ارتفاع/انخفاض/دون تغير جوهري (محايد بلا حكم).
//     المركز المالي ⇒ لا تقييم زيادة/وفر تلقائيًا إطلاقًا.
//   - أساس ثنائي اللغة: لغة التقرير (ar | en | ar_en) مستقلة عن لغة واجهة النظام —
//     كل وحدات لاحقة (PDF/Excel/تنبيهات) تستهلك نفس المصدر الواحد.
//
// الضوابط:
//   - بلا اعتماديات إطلاقًا (نقية 100% — تعمل في الخادم والعميل والبوابات).
//   - تسميات بنود القوائم من المرآة المجمدة STATEMENT_LINE_SEED (lib/account-nature)
//     مع أولوية لما يعيده الخادم من قاعدة البيانات (nameAr/nameEn مضبوطة إداريًا).
//   - الأكواد الداخلية (enums) كما هي — ما تغيّر هو النص المعروض حصرًا.

import { STATEMENT_LINE_SEED } from "./account-nature";

/* ──────────────────────────────────────────────────────────────────────────
 * لغة التقرير (أساس E — ثنائية اللغة)
 * ────────────────────────────────────────────────────────────────────────── */

export const REPORT_LANGUAGES = {
  AR: "ar",
  EN: "en",
  AR_EN: "ar_en",
} as const;

export type ReportLanguage = (typeof REPORT_LANGUAGES)[keyof typeof REPORT_LANGUAGES];

/** تسميات محدد اللغة في واجهة النظام (العربية هي لغة الواجهة دائمًا). */
export const REPORT_LANGUAGE_LABELS: Record<ReportLanguage, string> = {
  ar: "العربية",
  en: "English",
  ar_en: "عربي + English",
};

export function normalizeReportLanguage(raw: unknown): ReportLanguage {
  return raw === REPORT_LANGUAGES.EN || raw === REPORT_LANGUAGES.AR_EN ? raw : REPORT_LANGUAGES.AR;
}

/** نص ثنائي اللغة وفق لغة التقرير: ar ⇒ عربي، en ⇒ إنجليزي، ar_en ⇒ «عربي — English». */
export function bilingual(ar: string, en: string, lang: ReportLanguage): string {
  if (lang === REPORT_LANGUAGES.EN) return en;
  if (lang === REPORT_LANGUAGES.AR_EN) return `${ar} — ${en}`;
  return ar;
}

/* ──────────────────────────────────────────────────────────────────────────
 * تسميات بنود القوائم المالية (أساس D — إخفاء الأكواد)
 * ────────────────────────────────────────────────────────────────────────── */

interface BilingualLabel {
  ar: string;
  en: string;
}

const seedLineByCode = new Map(STATEMENT_LINE_SEED.map((l) => [l.code, l]));

/**
 * التسمية المعروضة لبند قائمة مالية — أولوية: قاعدة البيانات (المضبوطة إداريًا)
 * ثم المرآة المجمدة للمرجع، والأخير الكود نفسه (شفافية بدل نص مفقود).
 */
export function statementLineLabel(
  code: string,
  lang: ReportLanguage,
  dbNameAr?: string | null,
  dbNameEn?: string | null
): string {
  const seed = seedLineByCode.get(code);
  const ar = (dbNameAr ?? "").trim() || seed?.nameAr || code;
  const en = (dbNameEn ?? "").trim() || seed?.nameEn || ar;
  return lang === REPORT_LANGUAGES.EN ? en : lang === REPORT_LANGUAGES.AR_EN ? `${ar} — ${en}` : ar;
}

/* ──────────────────────────────────────────────────────────────────────────
 * التصنيفات وحالات الخريطة (D)
 * ────────────────────────────────────────────────────────────────────────── */

export const CLASSIFICATION_LABELS: Record<string, BilingualLabel> = {
  REVENUE: { ar: "إيراد", en: "Revenue" },
  EXPENSE: { ar: "مصروف", en: "Expense" },
  ASSET: { ar: "أصل", en: "Asset" },
  LIABILITY: { ar: "التزام", en: "Liability" },
  EQUITY: { ar: "حقوق ملكية", en: "Equity" },
  OTHER: { ar: "أخرى", en: "Other" },
};

export function classificationLabel(classification: string | null | undefined, lang: ReportLanguage): string {
  const key = typeof classification === "string" && classification.length > 0 ? classification : "OTHER";
  const l = CLASSIFICATION_LABELS[key] ?? { ar: key, en: key };
  return bilingual(l.ar, l.en, lang);
}

/** العبارة المعتمدة للجذر المركّب 2 — كيف يُحدد LIABILITY/EQUITY (مرآة ROOT2_CLASSIFICATION_HINT). */
export const ROOT2_PREFIX_HINT: BilingualLabel = {
  ar: "يُحدد حسب البادئة التفصيلية",
  en: "Determined by detailed prefix",
};

export function root2PrefixHint(lang: ReportLanguage): string {
  return bilingual(ROOT2_PREFIX_HINT.ar, ROOT2_PREFIX_HINT.en, lang);
}

export const MAPPING_STATUS_LABELS: Record<string, BilingualLabel> = {
  FULLY_MAPPED: { ar: "مصنّف بالكامل", en: "Fully mapped" },
  ROOT_ONLY: { ar: "تصنيف جذري بلا بند قائمة", en: "Root classification without statement line" },
  NEEDS_DETAILED_CLASSIFICATION: { ar: "يلزم تصنيف تفصيلي", en: "Needs detailed classification" },
  NEEDS_CLASSIFICATION: { ar: "غير مصنّف", en: "Unclassified" },
  PARTIAL: { ar: "تصنيف جزئي", en: "Partially classified" },
};

export function mappingStatusLabel(status: string | null | undefined, lang: ReportLanguage): string {
  if (!status) return bilingual("غير محسوم", "Undetermined", lang);
  const l = MAPPING_STATUS_LABELS[status];
  if (l) return bilingual(l.ar, l.en, lang);
  return bilingual("حالة خريطة غير معروفة", "Unknown mapping status", lang);
}

/* ──────────────────────────────────────────────────────────────────────────
 * حالات قيمة المقارنة (D/G — الكود التقني ثانوي لا أساسي)
 * ────────────────────────────────────────────────────────────────────────── */

export const COMPARISON_STATUS_TEXTS: Record<string, BilingualLabel> = {
  OK: { ar: "متاح", en: "Available" },
  INCOMPLETE_DATA: { ar: "بيانات غير مكتملة", en: "Incomplete Data" },
  NO_COMPARISON_DATA: { ar: "لا تتوفر بيانات للمقارنة", en: "No comparison data" },
  NO_APPROVED_BUDGET: { ar: "لا توجد موازنة معتمدة", en: "No approved budget" },
  NOT_COMPARABLE: { ar: "غير قابل للمقارنة", en: "Not comparable" },
};

export function comparisonStatusLabel(status: string | null | undefined, lang: ReportLanguage): string {
  const key = typeof status === "string" && status.length > 0 ? status : "NOT_COMPARABLE";
  const l = COMPARISON_STATUS_TEXTS[key] ?? { ar: key, en: key };
  return bilingual(l.ar, l.en, lang);
}

/* ──────────────────────────────────────────────────────────────────────────
 * الاتجاه المحايد (C — فترة⇄فترة بلا حكم أداء)
 * ────────────────────────────────────────────────────────────────────────── */

export const NEUTRAL_DIRECTION_TEXTS: Record<string, BilingualLabel> = {
  INCREASE: { ar: "ارتفاع", en: "Increase" },
  DECREASE: { ar: "انخفاض", en: "Decrease" },
  NO_CHANGE: { ar: "دون تغير جوهري", en: "No Material Change" },
  NOT_COMPARABLE: { ar: "غير قابل للمقارنة", en: "Not Comparable" },
};

export function directionLabel(direction: string | null | undefined, lang: ReportLanguage): string {
  const key = typeof direction === "string" && direction.length > 0 ? direction : "NOT_COMPARABLE";
  const l = NEUTRAL_DIRECTION_TEXTS[key] ?? { ar: key, en: key };
  return bilingual(l.ar, l.en, lang);
}

/* ──────────────────────────────────────────────────────────────────────────
 * المصطلح السياقي للفعلي مقابل الموازنة (C/H)
 * ────────────────────────────────────────────────────────────────────────── */

export interface BudgetTermInput {
  lineNature: "REVENUE" | "EXPENSE" | "OTHER";
  favorability: string; // FAVORABLE | UNFAVORABLE | NO_FAVORABLE_UNFAVORABLE (enums مركزية كما هي)
  /** هل بيانات الفعلي والموازنة كلتاهما متاحة؟ (غيابهما ⇒ «لا تتوفر بيانات للمقارنة»). */
  hasData: boolean;
}

export interface BudgetTerm {
  /** شارة قصيرة للجدول. */
  badge: BilingualLabel;
  /** جملة تفسيرية كاملة تذكر المبلغ (تُبنى في المحرك — هنا القالب). */
  sentencePattern: BilingualLabel;
}

/**
 * المصطلح السياقي الوحيد للفعلي مقابل الموازنة (قرار جولة المراجعة C):
 *   إيراد:  أعلى من الموازنة / أقل من الموازنة / ضمن الموازنة
 *   مصروف:  تجاوز الموازنة / وفر عن الموازنة / ضمن الموازنة
 *   أرصدة/أخرى: لا ينطبق تقييم الزيادة/الوفر على هذا البند
 *   بلا بيانات: لا تتوفر بيانات للمقارنة
 * الأكواد الداخلية (FAVORABLE…) تبقى كما هي — هذا النص للعرض حصرًا.
 */
export function budgetVarianceTerm(input: BudgetTermInput): BudgetTerm {
  if (!input.hasData) {
    const noData: BilingualLabel = { ar: "لا تتوفر بيانات للمقارنة", en: "Comparison data unavailable" };
    return { badge: noData, sentencePattern: noData };
  }
  if (input.lineNature === "OTHER") {
    const na: BilingualLabel = {
      ar: "لا ينطبق تقييم الزيادة/الوفر على هذا البند",
      en: "Increase/saving assessment is not applicable to this line",
    };
    return { badge: na, sentencePattern: na };
  }
  // ضمن الموازنة: بلا فارق (favorability يصبح NO عند المساواة)
  if (input.favorability === "NO_FAVORABLE_UNFAVORABLE") {
    const on: BilingualLabel = { ar: "ضمن الموازنة", en: "On Budget" };
    return { badge: on, sentencePattern: on };
  }
  if (input.lineNature === "REVENUE") {
    return input.favorability === "FAVORABLE"
      ? {
          badge: { ar: "أعلى من الموازنة", en: "Above Budget" },
          sentencePattern: { ar: "أعلى من الموازنة", en: "above the budget" },
        }
      : {
          badge: { ar: "أقل من الموازنة", en: "Below Budget" },
          sentencePattern: { ar: "أقل من الموازنة", en: "below the budget" },
        };
  }
  return input.favorability === "FAVORABLE"
    ? {
        badge: { ar: "وفر عن الموازنة", en: "Budget Saving" },
        sentencePattern: { ar: "أقل من الموازنة (وفر)", en: "below the budget (saving)" },
      }
    : {
        badge: { ar: "تجاوز الموازنة", en: "Over Budget" },
        sentencePattern: { ar: "أعلى من الموازنة (تجاوز)", en: "above the budget (overrun)" },
      };
}

/** شارة المصطلح السياقي بلغة التقرير. */
export function budgetVarianceBadge(input: BudgetTermInput, lang: ReportLanguage): string {
  const t = budgetVarianceTerm(input);
  return bilingual(t.badge.ar, t.badge.en, lang);
}

/* ──────────────────────────────────────────────────────────────────────────
 * تسميات تقارير النظام (أساس ثنائي اللغة للترويسات لاحقًا)
 * ────────────────────────────────────────────────────────────────────────── */

export const REPORT_TITLE_LABELS: Record<string, BilingualLabel> = {
  PROFIT_OR_LOSS: { ar: "قائمة الربح أو الخسارة", en: "Statement of Profit or Loss" },
  OTHER_COMPREHENSIVE_INCOME: { ar: "الدخل الشامل الآخر", en: "Other Comprehensive Income" },
  STATEMENT_OF_FINANCIAL_POSITION: { ar: "قائمة المركز المالي", en: "Statement of Financial Position" },
  SOCIE: { ar: "قائمة التغيرات في حقوق الملكية", en: "Statement of Changes in Equity" },
  CASH_FLOW: { ar: "قائمة التدفقات النقدية", en: "Statement of Cash Flows" },
};

export function reportTitleLabel(kind: string, lang: ReportLanguage): string {
  const l = REPORT_TITLE_LABELS[kind] ?? { ar: kind, en: kind };
  return bilingual(l.ar, l.en, lang);
}
