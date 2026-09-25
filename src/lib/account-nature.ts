// Phase 6.2A — دليل الحسابات وقواعد التصنيف (وحدة نقية — التصميم النهائي المعتمد).
//
// آمنة للاستيراد في العميل والخادم (نمط audit-actions/closing-policy): لا أي
// استيراد خادمي (Prisma/db) — الوصول للقاعدة عبر account-nature-server.ts.
//
// القرار المحاسبي النهائي المعتمد (تعليمات المستخدم المنقّحة):
//   LEVEL 1 — جذور نظامية ثابتة على مستوى النظام (تُقرأ فقط، لا تُدار عبر API):
//     1 = ASSETS              / BALANCE
//     2 = LIABILITIES_EQUITY  / BALANCE  (جذر مركّب — الفصل LIABILITY/EQUITY عبر
//                                   البادئات التفصيلية الخاصة بكل شركة 21/23…)
//     3 = EXPENSES            / FLOW
//     4 = REVENUE             / FLOW
//     لا جذور 5/6/7 كقواعد نظامية في المحرك الجديد — accounts.ts المجمد يبقى
//     للتوافق مع التقارير القديمة حصرًا ولا يُلمس.
//   LEVEL 2 — بادئات تفصيلية يُعدّها كل شركة مرة واحدة وتُعاد استخدامها في كل
//     الفترات والسنوات. لا seed عام لها إطلاقًا (11/1101/21/2101… أمثلة فقط).
//
// الفصل الحاكم: MainCategory (ASSETS/LIABILITIES_EQUITY/EXPENSES/REVENUE) ليس
// Detailed Classification (ASSET/LIABILITY/EQUITY/REVENUE/EXPENSE/OTHER):
//   البادئة 2  ⇒ LIABILITIES_EQUITY / BALANCE
//   البادئة 21 ⇒ LIABILITY          / البادئة 23 ⇒ EQUITY
//   وبذلك لا تُصنَّف كل حسابات «2» كخصوم.
//
// أولوية الحل الحاكمة (resolveAccountMapping):
//   1) Account-specific Override (استثناء حساب محدد — يفوز على كل شيء)
//   2) أطول بادئة تفصيلية للشركة (LONGEST PREFIX MATCH WINS — 1/11/1101)
//   3) الجذر النظامي 1/2/3/4
//   4) NEEDS_DETAILED_CLASSIFICATION إن كان الجذر وحده لا يكفي لتحديد التصنيف
//      (الجذر المركّب «2» بلا بادئة شركة تفصيلية)
//   5) NEEDS_CLASSIFICATION إن لم ينطبق حتى الجذر الرئيسي
//
// حدود الحل (fail-closed):
//   - الجذر النظامي يعرّف mainCategory/السلوك/التصنيف المحسوم (1/3/4) لكنه لا
//     يصدر بندًا ماليًا أبدًا: 110999 ⇒ نعلم أنه ASSET/BALANCE ولا نخمّن
//     Cash/Receivable/Inventory — الحالة ROOT_ONLY ولا تصلح لقائمة نهائية.
//   - mainCategory يأتي من الجذور النظامية حصرًا — بادئة شركة لا تولّده أبدًا.
//   - بند مالي غير موجود/غير نشط في المرجع ⇒ لا بند (لا FULLY_MAPPED بصمت).
//   - السلوك مخزّن صريحًا في قاعدة مراجَعة — لا تخمين من اسم الحساب مطلقًا.

/* ──────────────────────────────────────────────────────────────────────────
 * الثوابت والتسميات
 * ────────────────────────────────────────────────────────────────────────── */

export const ACCOUNT_CLASSIFICATIONS = {
  ASSET: "ASSET",
  LIABILITY: "LIABILITY",
  EQUITY: "EQUITY",
  REVENUE: "REVENUE",
  EXPENSE: "EXPENSE",
  OTHER: "OTHER",
} as const;

export type AccountClassification =
  (typeof ACCOUNT_CLASSIFICATIONS)[keyof typeof ACCOUNT_CLASSIFICATIONS];

export const ACCOUNT_CLASSIFICATION_LABELS: Record<AccountClassification, string> = {
  ASSET: "أصول",
  LIABILITY: "خصوم",
  EQUITY: "حقوق ملكية",
  REVENUE: "إيرادات",
  EXPENSE: "مصروفات",
  OTHER: "أخرى",
};

/** FLCATE-1 — الفئة الرئيسية (الجذور النظامية الثابتة) — منفصلة عن التصنيف التفصيلي. */
export const MAIN_CATEGORIES = {
  ASSETS: "ASSETS",
  LIABILITIES_EQUITY: "LIABILITIES_EQUITY",
  EXPENSES: "EXPENSES",
  REVENUE: "REVENUE",
} as const;

export type MainCategory = (typeof MAIN_CATEGORIES)[keyof typeof MAIN_CATEGORIES];

export const MAIN_CATEGORY_LABELS: Record<MainCategory, string> = {
  ASSETS: "الأصول (1)",
  LIABILITIES_EQUITY: "الخصوم وحقوق الملكية (2)",
  EXPENSES: "المصروفات (3)",
  REVENUE: "الإيرادات (4)",
};

/* ──────────────────────────────────────────────────────────────────────
 * حاجز تناقض الجذر (التصحيح المحاسبي المعتمد):
 *   1 = ASSET حصرًا | 3 = EXPENSE حصرًا (3101 = EXPENSE ولا يجوز EQUITY أبدًا)
 *   | 4 = REVENUE حصرًا — والجذر 2 هو الجذر المركّب الوحيد: بادئاته
 *   التفصيلية هي ما يحدد LIABILITY مقابل EQUITY. أي بادئة/استثناء يخالف
 *   جذره يُرفض عند الإدخال ويُهمل عند الحل (لا OTHER صامت أبدًا).
 * ────────────────────────────────────────────────────────────────────── */

/** الجذر الرقمي الحاكم (أول محرف 1/2/3/4) — null لخرائط الأكواد القديمة بلا جذر نظامي (5/6/7). */
export function accountRootDigit(prefixOrCode: string): "1" | "2" | "3" | "4" | null {
  const first = typeof prefixOrCode === "string" ? prefixOrCode.trim().charAt(0) : "";
  return first === "1" || first === "2" || first === "3" || first === "4" ? first : null;
}

/** التصنيفات المسموحة تحت كل جذر نظامي — الجذر 2 وحده يقبل الاثنين (LIABILITY/EQUITY). */
export const ALLOWED_CLASSIFICATIONS_BY_ROOT: Record<"1" | "2" | "3" | "4", readonly AccountClassification[]> = {
  "1": ["ASSET"],
  "2": ["LIABILITY", "EQUITY"],
  "3": ["EXPENSE"],
  "4": ["REVENUE"],
};

/** هل التصنيف مسموح تحت الجذر؟ (بلا جذر نظامي ⇒ لا تناقض ممكن — خرائط قديمة 5/6/7). */
export function isClassificationAllowedForRoot(
  rootDigit: "1" | "2" | "3" | "4" | null,
  classification: string
): boolean {
  if (rootDigit === null) return true;
  return (ALLOWED_CLASSIFICATIONS_BY_ROOT[rootDigit] as readonly string[]).includes(classification);
}

/** العبارة المعتمدة للجذر المركّب 2 — كيف يُحدد LIABILITY/EQUITY (واجهة الإدارة والتقارير). */
export const ROOT2_CLASSIFICATION_HINT = {
  ar: "يُحدد حسب البادئة التفصيلية",
  en: "Determined by detailed prefix",
} as const;

/** حاجز تناقض الجذر لبادئة شركة — يمنع 31xx⇒EQUITY ونحوها قبل الحفظ. */
export function assertPrefixRootAlignment(prefix: string, classification: AccountClassification): void {
  if (classification === "OTHER") return; // «أخرى» صريحة غير حاسمة — الحل الجذري يبقى حاكمًا
  const rootDigit = accountRootDigit(prefix);
  if (rootDigit === null || isClassificationAllowedForRoot(rootDigit, classification)) return;
  throw new AccountNatureError(
    "PREFIX_ROOT_CONFLICT",
    `تناقض الجذر: البادئة «${prefix}» تحت الجذر ${rootDigit} تقبل ${ALLOWED_CLASSIFICATIONS_BY_ROOT[rootDigit].join(" أو ")} حصرًا — التصنيف ${classification} مرفوض (مثال: 31xx = EXPENSE ولا يجوز EQUITY أبدًا).`
  );
}

/** حاجز تناقض الجذر لاستثناء حساب — 3101 = EXPENSE ولا يجوز EQUITY أبدًا. */
export function assertOverrideRootAlignment(accountCode: string, classification: AccountClassification): void {
  if (classification === "OTHER") return; // «أخرى» صريحة غير حاسمة — الحل الجذري يبقى حاكمًا
  const rootDigit = accountRootDigit(accountCode);
  if (rootDigit === null || isClassificationAllowedForRoot(rootDigit, classification)) return;
  throw new AccountNatureError(
    "OVERRIDE_ROOT_CONFLICT",
    `تناقض الجذر: الحساب «${accountCode}» تحت الجذر ${rootDigit} يقبل ${ALLOWED_CLASSIFICATIONS_BY_ROOT[rootDigit].join(" أو ")} حصرًا — التصنيف ${classification} مرفوض للاستثناء.`
  );
}

export const AGGREGATION_BEHAVIORS = {
  FLOW: "FLOW",
  BALANCE: "BALANCE",
} as const;

export type AggregationBehavior =
  (typeof AGGREGATION_BEHAVIORS)[keyof typeof AGGREGATION_BEHAVIORS];

export const AGGREGATION_BEHAVIOR_LABELS: Record<AggregationBehavior, string> = {
  FLOW: "حركة فترة (YTD تجميعي)",
  BALANCE: "رصيد وقف الفترة (as-of)",
};

/** مصدر الحسم في الحل — بترتيب الأولوية: Override > بادئة شركة > الجذر النظامي. */
export const MAPPING_SOURCES = {
  ACCOUNT_OVERRIDE: "ACCOUNT_OVERRIDE",
  COMPANY_PREFIX: "COMPANY_PREFIX",
  SYSTEM_ROOT: "SYSTEM_ROOT",
} as const;

export type MappingSource = (typeof MAPPING_SOURCES)[keyof typeof MAPPING_SOURCES];

export const MAPPING_SOURCE_LABELS: Record<MappingSource, string> = {
  ACCOUNT_OVERRIDE: "استثناء حساب محدد",
  COMPANY_PREFIX: "بادئة الشركة التفصيلية",
  SYSTEM_ROOT: "الجذر النظامي",
};

/** حالة اكتمال الحل — الاكتمال أساس الحالة، والمصدر (source) يوضح مِن حسمها. */
export const MAPPING_STATUSES = {
  FULLY_MAPPED: "FULLY_MAPPED",
  ROOT_ONLY: "ROOT_ONLY",
  NEEDS_DETAILED_CLASSIFICATION: "NEEDS_DETAILED_CLASSIFICATION",
  NEEDS_CLASSIFICATION: "NEEDS_CLASSIFICATION",
} as const;

export type MappingStatus = (typeof MAPPING_STATUSES)[keyof typeof MAPPING_STATUSES];

export const MAPPING_STATUS_LABELS: Record<MappingStatus, string> = {
  FULLY_MAPPED: "مصنّف بالكامل",
  ROOT_ONLY: "معروف من الجذر فقط — يحتاج بندًا ماليًا",
  NEEDS_DETAILED_CLASSIFICATION: "يحتاج تصنيفًا تفصيليًا (بادئة شركة)",
  NEEDS_CLASSIFICATION: "غير مصنّف",
};

export const STATEMENT_TYPES = {
  SFP: "STATEMENT_OF_FINANCIAL_POSITION",
  PNL: "PROFIT_OR_LOSS",
  OCI: "OTHER_COMPREHENSIVE_INCOME",
} as const;

export type StatementType = (typeof STATEMENT_TYPES)[keyof typeof STATEMENT_TYPES];

export const STATEMENT_TYPE_LABELS: Record<StatementType, string> = {
  STATEMENT_OF_FINANCIAL_POSITION: "قائمة المركز المالي",
  PROFIT_OR_LOSS: "قائمة الربح أو الخسارة",
  OTHER_COMPREHENSIVE_INCOME: "الدخل الشامل الآخر",
};

export const NATURE_SOURCE = {
  SYSTEM: "SYSTEM",
  MANUAL: "MANUAL",
} as const;

export type NatureSource = (typeof NATURE_SOURCE)[keyof typeof NATURE_SOURCE];

export const NATURE_SOURCE_LABELS: Record<NatureSource, string> = {
  SYSTEM: "نظامي (جذر ثابت)",
  MANUAL: "إداري (شركة)",
};

/** اقتراحات العرض الافتراضية — اقتراح فقط، ليس قاعدة تخزين ولا استنتاجًا آليًا. */
export const SUGGESTED_BEHAVIOR_BY_CLASSIFICATION: Record<
  AccountClassification,
  AggregationBehavior | null
> = {
  ASSET: "BALANCE",
  LIABILITY: "BALANCE",
  EQUITY: "BALANCE",
  REVENUE: "FLOW",
  EXPENSE: "FLOW",
  // OTHER لا يُفترض له FLOW أو BALANCE دون قاعدة واضحة (حرفيًا).
  OTHER: null,
};

/**
 * حاجز الاتساق (guardrail) بين التصنيف التفصيلي ونوع القائمة — يمنع أخطاء
 * الربط الفاضحة (أصل على قائمة الأرباح والخسائر) قبل الحفظ:
 *   ASSET/LIABILITY ⇒ قائمة المركز المالي حصرًا.
 *   EQUITY          ⇒ قائمة المركز المالي أو الدخل الشامل الآخر (إعادة تقييم).
 *   REVENUE/EXPENSE ⇒ الربح أو الخسارة أو الدخل الشامل الآخر.
 *   OTHER           ⇒ بلا قيد (يُحسم لاحقًا بقرار صريح).
 */
export function isStatementLineConsistent(
  classification: AccountClassification,
  statementType: string
): boolean {
  switch (classification) {
    case "ASSET":
    case "LIABILITY":
      return statementType === STATEMENT_TYPES.SFP;
    case "EQUITY":
      return statementType === STATEMENT_TYPES.SFP || statementType === STATEMENT_TYPES.OCI;
    case "REVENUE":
    case "EXPENSE":
      return statementType === STATEMENT_TYPES.PNL || statementType === STATEMENT_TYPES.OCI;
    default:
      return true; // OTHER — بلا قيد
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * الـ Seed النظامي — مرآة الـ migration حرفيًا (مصدر واحد للدلالة، والمرآة
 * للاختبارات النقية والعرض). المصدر الحاكم للقيم: migration.sql.
 * ────────────────────────────────────────────────────────────────────────── */

export interface SystemRootSeed {
  id: string;
  prefix: string;
  mainCategory: MainCategory;
  /** null للجذر المركّب «2» حصرًا — يحتاج بادئة شركة تفصيلية (21/23…). */
  classification: AccountClassification | null;
  aggregationBehavior: AggregationBehavior;
  note: string;
}

export const SYSTEM_ROOT_SEED: readonly SystemRootSeed[] = [
  {
    id: "anr-sys-01",
    prefix: "1",
    mainCategory: "ASSETS",
    classification: "ASSET",
    aggregationBehavior: "BALANCE",
    note: "جذر نظامي ثابت: 1 = الأصول (ASSETS) — BALANCE. الفصل التفصيلي (نقدية/ذمم/مخزون…) عبر بادئات كل شركة",
  },
  {
    id: "anr-sys-02",
    prefix: "2",
    mainCategory: "LIABILITIES_EQUITY",
    classification: null,
    aggregationBehavior: "BALANCE",
    note: "جذر نظامي ثابت: 2 = الخصوم وحقوق الملكية (LIABILITIES AND EQUITY) — BALANCE. الفصل LIABILITY/EQUITY عبر بادئات كل شركة (21/23 أمثلة لا قواعد عامة)",
  },
  {
    id: "anr-sys-03",
    prefix: "3",
    mainCategory: "EXPENSES",
    classification: "EXPENSE",
    aggregationBehavior: "FLOW",
    note: "جذر نظامي ثابت: 3 = المصروفات (EXPENSES) — FLOW. (الدليل المجمد القديم اعتبر 3 مصروفات — per user request — وهذا القرار يبقى كما هو)",
  },
  {
    id: "anr-sys-04",
    prefix: "4",
    mainCategory: "REVENUE",
    classification: "REVENUE",
    aggregationBehavior: "FLOW",
    note: "جذر نظامي ثابت: 4 = الإيرادات (REVENUE) — FLOW. البادئات القديمة 5/6/7 ليست قواعد نظامية في المحرك الجديد",
  },
];

/** البادئات النظامية المسموحة للجذور — لا جذور جديدة تُنشأ إطلاقًا (قرار معتمد). */
export const SYSTEM_ROOT_PREFIXES: readonly string[] = SYSTEM_ROOT_SEED.map((r) => r.prefix);

export interface StatementLineSeed {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  statementType: StatementType;
  parentCode: string | null;
  displayOrder: number;
  isSubtotal: boolean;
}

/** مرآة seed بنود القوائم المالية في migration.sql (للاختبارات النقية والتوثيق). */
export const STATEMENT_LINE_SEED: readonly StatementLineSeed[] = [
  { id: "fsl-sfp-nca",      code: "SFP-ASSET-NCA",    nameAr: "الأصول غير المتداولة",       nameEn: "Non-current Assets",                  statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: null,          displayOrder: 1, isSubtotal: false },
  { id: "fsl-sfp-ca",       code: "SFP-ASSET-CA",     nameAr: "الأصول المتداولة",           nameEn: "Current Assets",                      statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: null,          displayOrder: 2, isSubtotal: false },
  { id: "fsl-sfp-ncl",      code: "SFP-LIA-NCL",      nameAr: "الالتزامات غير المتداولة",   nameEn: "Non-current Liabilities",             statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: null,          displayOrder: 3, isSubtotal: false },
  { id: "fsl-sfp-cl",       code: "SFP-LIA-CL",       nameAr: "الالتزامات المتداولة",       nameEn: "Current Liabilities",                 statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: null,          displayOrder: 4, isSubtotal: false },
  { id: "fsl-sfp-eq",       code: "SFP-EQUITY",       nameAr: "حقوق الملكية",               nameEn: "Equity",                              statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: null,          displayOrder: 5, isSubtotal: false },
  { id: "fsl-sfp-ppe",      code: "SFP-PPE",          nameAr: "الممتلكات والآلات والمعدات", nameEn: "Property, Plant and Equipment",       statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-ASSET-NCA", displayOrder: 1, isSubtotal: false },
  { id: "fsl-sfp-intang",   code: "SFP-INTANGIBLE",   nameAr: "الأصول غير الملموسة",        nameEn: "Intangible Assets",                   statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-ASSET-NCA", displayOrder: 2, isSubtotal: false },
  { id: "fsl-sfp-lt-inv",   code: "SFP-LT-INVEST",    nameAr: "استثمارات طويلة الأجل",      nameEn: "Long-term Investments",               statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-ASSET-NCA", displayOrder: 3, isSubtotal: false },
  { id: "fsl-sfp-cash",     code: "SFP-CASH",         nameAr: "النقدية وما في حكمها",       nameEn: "Cash and Cash Equivalents",           statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-ASSET-CA",  displayOrder: 1, isSubtotal: false },
  { id: "fsl-sfp-receiv",   code: "SFP-RECEIVABLES",  nameAr: "الذمم المدينة والمستحقات",   nameEn: "Trade and Other Receivables",         statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-ASSET-CA",  displayOrder: 2, isSubtotal: false },
  { id: "fsl-sfp-invent",   code: "SFP-INVENTORY",    nameAr: "المخزون",                    nameEn: "Inventories",                         statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-ASSET-CA",  displayOrder: 3, isSubtotal: false },
  { id: "fsl-sfp-st-inv",   code: "SFP-ST-INVEST",    nameAr: "استثمارات قصيرة الأجل",      nameEn: "Short-term Investments",              statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-ASSET-CA",  displayOrder: 4, isSubtotal: false },
  { id: "fsl-sfp-prepaid",  code: "SFP-PREPAID",      nameAr: "مصروفات مدفوعة مقدماً",      nameEn: "Prepaid Expenses",                    statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-ASSET-CA",  displayOrder: 5, isSubtotal: false },
  { id: "fsl-sfp-lt-loans", code: "SFP-LT-LOANS",     nameAr: "قروض طويلة الأجل",           nameEn: "Long-term Borrowings",                statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-LIA-NCL",   displayOrder: 1, isSubtotal: false },
  { id: "fsl-sfp-eos",      code: "SFP-EOS-BENEFIT",  nameAr: "مخصصات نهاية الخدمة",        nameEn: "End-of-Service Benefits Obligation",  statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-LIA-NCL",   displayOrder: 2, isSubtotal: false },
  { id: "fsl-sfp-payab",    code: "SFP-PAYABLES",     nameAr: "الدائنون والمستحقات",        nameEn: "Trade and Other Payables",            statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-LIA-CL",    displayOrder: 1, isSubtotal: false },
  { id: "fsl-sfp-st-loans", code: "SFP-ST-LOANS",     nameAr: "قروض قصيرة الأجل",           nameEn: "Short-term Borrowings",               statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-LIA-CL",    displayOrder: 2, isSubtotal: false },
  { id: "fsl-sfp-accrued",  code: "SFP-ACCRUED",      nameAr: "مصروفات مستحقة",             nameEn: "Accrued Expenses",                    statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-LIA-CL",    displayOrder: 3, isSubtotal: false },
  { id: "fsl-sfp-tax-pay",  code: "SFP-TAX-PAYABLE",  nameAr: "ضرائب مستحقة",               nameEn: "Taxes Payable",                       statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-LIA-CL",    displayOrder: 4, isSubtotal: false },
  { id: "fsl-sfp-capital",  code: "SFP-CAPITAL",      nameAr: "رأس المال",                  nameEn: "Share Capital",                       statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-EQUITY",    displayOrder: 1, isSubtotal: false },
  { id: "fsl-sfp-reserves", code: "SFP-RESERVES",     nameAr: "الاحتياطيات",                nameEn: "Reserves",                            statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-EQUITY",    displayOrder: 2, isSubtotal: false },
  { id: "fsl-sfp-retained", code: "SFP-RETAINED",     nameAr: "الأرباح المحتجزة",           nameEn: "Retained Earnings",                   statementType: "STATEMENT_OF_FINANCIAL_POSITION", parentCode: "SFP-EQUITY",    displayOrder: 3, isSubtotal: false },
  { id: "fsl-pnl-revenue",  code: "PNL-REVENUE",          nameAr: "إيرادات النشاط الرئيسي", nameEn: "Revenue from Ordinary Activities",    statementType: "PROFIT_OR_LOSS", parentCode: null, displayOrder: 1, isSubtotal: false },
  { id: "fsl-pnl-otherinc", code: "PNL-OTHER-INCOME",     nameAr: "إيرادات أخرى",           nameEn: "Other Income",                        statementType: "PROFIT_OR_LOSS", parentCode: null, displayOrder: 2, isSubtotal: false },
  { id: "fsl-pnl-cos",      code: "PNL-COST-OF-SALES",    nameAr: "تكلفة المبيعات",         nameEn: "Cost of Sales",                       statementType: "PROFIT_OR_LOSS", parentCode: null, displayOrder: 3, isSubtotal: false },
  { id: "fsl-pnl-admin",    code: "PNL-ADMIN-EXPENSES",   nameAr: "مصروفات إدارية وعمومية", nameEn: "General and Administrative Expenses", statementType: "PROFIT_OR_LOSS", parentCode: null, displayOrder: 4, isSubtotal: false },
  { id: "fsl-pnl-selling",  code: "PNL-SELLING-EXPENSES", nameAr: "مصروفات البيع والتوزيع", nameEn: "Selling and Distribution Expenses",   statementType: "PROFIT_OR_LOSS", parentCode: null, displayOrder: 5, isSubtotal: false },
  { id: "fsl-pnl-finance",  code: "PNL-FINANCE-COSTS",    nameAr: "تكاليف التمويل",         nameEn: "Finance Costs",                       statementType: "PROFIT_OR_LOSS", parentCode: null, displayOrder: 6, isSubtotal: false },
  { id: "fsl-pnl-otherexp", code: "PNL-OTHER-EXPENSES",   nameAr: "مصروفات أخرى",           nameEn: "Other Expenses",                      statementType: "PROFIT_OR_LOSS", parentCode: null, displayOrder: 7, isSubtotal: false },
  { id: "fsl-pnl-tax",      code: "PNL-INCOME-TAX",       nameAr: "مصروف ضريبة الدخل",      nameEn: "Income Tax Expense",                  statementType: "PROFIT_OR_LOSS", parentCode: null, displayOrder: 8, isSubtotal: false },
  { id: "fsl-oci-reval",    code: "OCI-REVALUATION",      nameAr: "فائض إعادة التقييم",     nameEn: "Revaluation Surplus",                 statementType: "OTHER_COMPREHENSIVE_INCOME", parentCode: null, displayOrder: 1, isSubtotal: false },
  { id: "fsl-oci-fx",       code: "OCI-FX-DIFFERENCES",   nameAr: "فروق التحويل للعملات الأجنبية", nameEn: "Exchange Differences on Translation", statementType: "OTHER_COMPREHENSIVE_INCOME", parentCode: null, displayOrder: 2, isSubtotal: false },
];

/* ──────────────────────────────────────────────────────────────────────────
 * الأخطاء والتحقق
 * ────────────────────────────────────────────────────────────────────────── */

export type AccountNatureErrorCode =
  | "INVALID_PREFIX"
  | "INVALID_CLASSIFICATION"
  | "INVALID_BEHAVIOR"
  | "INVALID_NOTE"
  | "INVALID_ACCOUNT_CODE"
  | "INVALID_STATEMENT_LINE"
  | "STATEMENT_LINE_MISMATCH"
  | "COMPANY_REQUIRED"
  | "SYSTEM_IMMUTABLE"
  | "RULE_PREFIX_DUPLICATE"
  | "RULE_NOT_FOUND"
  | "OVERRIDE_DUPLICATE"
  | "OVERRIDE_NOT_FOUND"
  | "COPY_NOT_ALLOWED"
  | "VERSION_CONFLICT"
  | "NEEDS_CLASSIFICATION"
  | "PREFIX_ROOT_CONFLICT"
  | "OVERRIDE_ROOT_CONFLICT";

export class AccountNatureError extends Error {
  code: AccountNatureErrorCode;
  constructor(code: AccountNatureErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "AccountNatureError";
  }
}

/** بادئة كود الحساب: 1..12 محرفًا من أرقام/أحرف لاتينية/شرطة — بلا فراغات. */
export function normalizeNaturePrefix(raw: unknown): string {
  if (typeof raw !== "string") throw new AccountNatureError("INVALID_PREFIX", "بادئة كود الحساب مطلوبة.");
  const p = raw.trim();
  if (p.length < 1 || p.length > 12) {
    throw new AccountNatureError("INVALID_PREFIX", "بادئة كود الحساب يجب أن تكون بين 1 و 12 محرفًا.");
  }
  if (!/^[0-9A-Za-z-]+$/.test(p)) {
    throw new AccountNatureError("INVALID_PREFIX", "بادئة كود الحساب تقبل أرقامًا وأحرفًا لاتينية وشرطة فقط.");
  }
  return p;
}

/** كود حساب مطلوب حله: نص غير فارغ بعد التنظيف (حد أقصى 64 محرفًا). */
export function normalizeAccountCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim();
  if (c.length < 1 || c.length > 64) return null;
  return c;
}

/** كود حساب لاستثناء صريح — إلزامي (نقي، يرمي بدل إعادة null). */
export function requireAccountCode(raw: unknown): string {
  const c = normalizeAccountCode(raw);
  if (!c) {
    throw new AccountNatureError("INVALID_ACCOUNT_CODE", "كود الحساب للاستثناء مطلوب (1..64 محرفًا).");
  }
  return c;
}

function isClassification(v: unknown): v is AccountClassification {
  return typeof v === "string" && (ACCOUNT_CLASSIFICATIONS as Record<string, string>)[v] === v;
}

function isBehavior(v: unknown): v is AggregationBehavior {
  return typeof v === "string" && (AGGREGATION_BEHAVIORS as Record<string, string>)[v] === v;
}

/** مدخل إنشاء/تعديل بادئة شركة تفصيلية — تحقق مركزي صارم (الخادم والاختبارات). */
export interface CompanyPrefixInput {
  prefix: string;
  classification: AccountClassification;
  aggregationBehavior: AggregationBehavior;
  statementLineCode: string | null;
  note: string;
}

export function validateCompanyPrefixInput(raw: unknown): CompanyPrefixInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const prefix = normalizeNaturePrefix(body.prefix);
  if (!isClassification(body.classification)) {
    throw new AccountNatureError("INVALID_CLASSIFICATION", "التصنيف التفصيلي إلزامي لبادئة الشركة.");
  }
  if (!isBehavior(body.aggregationBehavior)) {
    throw new AccountNatureError("INVALID_BEHAVIOR", "سلوك التجميع الزمني غير صالح (FLOW أو BALANCE حصرًا).");
  }
  // حاجز تناقض الجذر — البادئة التفصيلية لا تناقض جذورها النظامية أبدًا (31xx⇒EQUITY مرفوض).
  assertPrefixRootAlignment(prefix, body.classification);
  const statementLineCode =
    typeof body.statementLineCode === "string" && body.statementLineCode.trim().length > 0
      ? body.statementLineCode.trim()
      : null;
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 300) {
    throw new AccountNatureError("INVALID_NOTE", "ملاحظة القاعدة تتجاوز 300 محرف.");
  }
  return { prefix, classification: body.classification, aggregationBehavior: body.aggregationBehavior, statementLineCode, note };
}

/** مدخل إنشاء/تعديل استثناء حساب محدد — تحقق مركزي صارم. */
export interface MappingOverrideInput {
  accountCode: string;
  classification: AccountClassification;
  aggregationBehavior: AggregationBehavior;
  statementLineCode: string | null;
  note: string;
}

export function validateMappingOverrideInput(raw: unknown): MappingOverrideInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const accountCode = requireAccountCode(body.accountCode);
  if (!isClassification(body.classification)) {
    throw new AccountNatureError("INVALID_CLASSIFICATION", "التصنيف التفصيلي إلزامي للاستثناء.");
  }
  if (!isBehavior(body.aggregationBehavior)) {
    throw new AccountNatureError("INVALID_BEHAVIOR", "سلوك التجميع الزمني غير صالح (FLOW أو BALANCE حصرًا).");
  }
  // حاجز تناقض الجذر — 3101 = EXPENSE ولا يجوز EQUITY أبدًا في الاستثناءات كذلك.
  assertOverrideRootAlignment(accountCode, body.classification);
  const statementLineCode =
    typeof body.statementLineCode === "string" && body.statementLineCode.trim().length > 0
      ? body.statementLineCode.trim()
      : null;
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 300) {
    throw new AccountNatureError("INVALID_NOTE", "ملاحظة الاستثناء تتجاوز 300 محرف.");
  }
  return { accountCode, classification: body.classification, aggregationBehavior: body.aggregationBehavior, statementLineCode, note };
}

/* ──────────────────────────────────────────────────────────────────────────
 * الحل المركزي (resolution) — Override > أطول بادئة شركة > الجذر النظامي
 * ────────────────────────────────────────────────────────────────────────── */

/** قاعدة كما تُمرَّر للحل النقي (البادئات التفصيلية محمّلة ببند القائمة ككود). */
export interface MappingRuleLike {
  id: string;
  companyId: string | null;
  prefix: string;
  mainCategory: string | null;
  classification: string | null;
  aggregationBehavior: string;
  statementLineCode: string | null;
  source: string;
  isActive: boolean;
}

/** استثناء كما يُمرَّر للحل النقي. */
export interface MappingOverrideLike {
  id: string;
  companyId: string | null;
  accountCode: string;
  classification: string;
  aggregationBehavior: string;
  statementLineCode: string | null;
  isActive: boolean;
}

/** بند قائمة مالية كما يُمرَّر للحل النقي (المرجع كاملًا — تُبنى خريطة داخلية). */
export interface StatementLineLike {
  code: string;
  nameAr: string;
  statementType: string;
  isActive: boolean;
}

export interface ResolvedAccountMapping {
  accountCode: string;
  mainCategory: MainCategory | null;
  classification: AccountClassification | null;
  aggregationBehavior: AggregationBehavior | null;
  statementType: string | null;
  statementLineCode: string | null;
  statementLineNameAr: string | null;
  source: MappingSource | null;
  /** الكود/البادئة الفائزة بالحسم: كود الحساب نفسه للاستثناء، وإلا البادئة الفائزة. */
  matchedPrefix: string | null;
  /** الجذر النظامي المطابق (شفافية — قد يطابق دون أن يحسم). */
  rootPrefix: string | null;
  /** بادئة الشركة المطابقة (شفافية). */
  companyPrefix: string | null;
  mappingStatus: MappingStatus;
}

export interface ResolveAccountMappingInput {
  accountCode: string;
  /** الجذور النظامية + بادئات الشركة المستهدفة حصرًا (يُفلتر أيضًا داخليًا). */
  rules: readonly MappingRuleLike[];
  /** استثناءات الشركة المستهدفة حصرًا (يُفلتر أيضًا داخليًا). */
  overrides?: readonly MappingOverrideLike[];
  /** مرجع بنود القوائم المالية كاملًا (تُقبل النشطة حصرًا في الحسم). */
  lines?: readonly StatementLineLike[];
  /** نطاق الشركة — null = النظام فقط (بلا بادئات شركات ولا استثناءات). */
  companyId?: string | null;
}

function longestPrefixMatch(
  rules: readonly MappingRuleLike[],
  code: string,
  scope: "SYSTEM" | "COMPANY",
  companyId: string | null
): MappingRuleLike | null {
  let best: MappingRuleLike | null = null;
  for (const rule of rules) {
    if (!rule.isActive) continue;
    const prefix = typeof rule.prefix === "string" ? rule.prefix.trim() : "";
    if (prefix.length === 0 || !code.startsWith(prefix)) continue;
    const isSystem = rule.companyId === null;
    if (scope === "SYSTEM" && !isSystem) continue;
    if (scope === "COMPANY" && (isSystem || rule.companyId !== companyId)) continue;
    if (
      best === null ||
      prefix.length > best.prefix.length ||
      (prefix.length === best.prefix.length && rule.id < best.id)
    ) {
      best = rule;
    }
  }
  return best;
}

/**
 * الحل المركزي لخريطة حساب واحد — الوحدة الوحيدة المعتمدة لأي استهلاك لاحق
 * (Monthly/YTD/Actual-vs-Budget/القوائم المالية). نقية — بلا DB.
 *
 * دلالة الحالات (موثقة ومراجَعة):
 *   FULLY_MAPPED                    — التصنيف والسلوك والبند المالي كلها محسومة.
 *   ROOT_ONLY                       — mainCategory+التصنيف+السلوك معلومة لكن لا بند
 *                                     مالي (الجذر وحده أو بادئة بلا بند) — لا تصلح
 *                                     لإصدار قائمة نهائية (H/I من الاختبارات).
 *   NEEDS_DETAILED_CLASSIFICATION   — الجذر مطابق لكن التصنيف التفصيلي غير محسوم
 *                                     (الجذر المركّب «2» بلا بادئة شركة 21/23…).
 *   NEEDS_CLASSIFICATION            — الجذر الرئيسي نفسه لم ينطبق (أكواد خارج 1-4).
 */
export function resolveAccountMapping(input: ResolveAccountMappingInput): ResolvedAccountMapping {
  const code = normalizeAccountCode(input.accountCode);
  const empty: ResolvedAccountMapping = {
    accountCode: code ?? "",
    mainCategory: null,
    classification: null,
    aggregationBehavior: null,
    statementType: null,
    statementLineCode: null,
    statementLineNameAr: null,
    source: null,
    matchedPrefix: null,
    rootPrefix: null,
    companyPrefix: null,
    mappingStatus: "NEEDS_CLASSIFICATION",
  };
  if (!code) return empty;

  const companyId = typeof input.companyId === "string" && input.companyId.length > 0 ? input.companyId : null;
  const rules = Array.isArray(input.rules) ? input.rules : [];
  const overrides = Array.isArray(input.overrides) ? input.overrides : [];

  const root = longestPrefixMatch(rules, code, "SYSTEM", null);
  const companyRule = companyId ? longestPrefixMatch(rules, code, "COMPANY", companyId) : null;
  const override =
    overrides.find(
      (o) => o.isActive && o.accountCode === code && o.companyId !== null && o.companyId === companyId
    ) ?? null;

  // أولوية الحسم: Override > بادئة الشركة > الجذر النظامي — مع حاجز تناقض الجذر
  // (دفاع عميق ضد قواعد قديمة فاسدة): مصدر يخالف جذره النظامي لا يحسم إطلاقًا،
  // فبقى 3101 = EXPENSE من الجذر حتى مع قاعدة 31⇒EQUITY قديمة، والجذر 2 ببادئة
  // فاسدة يبقى NEEDS_DETAILED_CLASSIFICATION — لا OTHER صامت أبدًا.
  const overrideOk =
    override !== null &&
    isClassificationAllowedForRoot(accountRootDigit(override.accountCode), override.classification);
  const companyOk =
    companyRule !== null &&
    isClassificationAllowedForRoot(accountRootDigit(companyRule.prefix), companyRule.classification);
  const effOverride = overrideOk ? override : null;
  const effCompany = companyOk ? companyRule : null;

  const classification =
    (effOverride?.classification ?? effCompany?.classification ?? root?.classification ?? null) as AccountClassification | null;
  const behavior =
    (effOverride?.aggregationBehavior ?? effCompany?.aggregationBehavior ?? root?.aggregationBehavior ?? null) as AggregationBehavior | null;
  // البند المالي لا يصدر من الجذر النظامي أبدًا (قرار fail-closed — لا تخمين).
  const wantedLineCode = effOverride?.statementLineCode ?? effCompany?.statementLineCode ?? null;

  const source: MappingSource | null = effOverride
    ? "ACCOUNT_OVERRIDE"
    : effCompany
      ? "COMPANY_PREFIX"
      : root
        ? "SYSTEM_ROOT"
        : null;
  const matchedPrefix = effOverride ? code : (effCompany?.prefix ?? root?.prefix ?? null);

  // خريطة البنود النشطة — كود غير موجود/غير نشط ⇒ لا بند (لا FULLY_MAPPED بصمت).
  let statementType: string | null = null;
  let statementLineNameAr: string | null = null;
  if (wantedLineCode) {
    const line = (input.lines ?? []).find((l) => l.code === wantedLineCode && l.isActive);
    if (line) {
      statementType = line.statementType;
      statementLineNameAr = line.nameAr;
    }
  }
  const statementLineCode = statementType !== null ? wantedLineCode : null;

  const mainCategory = (root?.mainCategory ?? null) as MainCategory | null;

  let mappingStatus: MappingStatus;
  if (!root) {
    mappingStatus = "NEEDS_CLASSIFICATION"; // الجذر الرئيسي نفسه لم ينطبق
  } else if (!classification) {
    mappingStatus = "NEEDS_DETAILED_CLASSIFICATION"; // الجذر المركّب بلا بادئة تفصيلية
  } else if (statementLineCode !== null) {
    mappingStatus = "FULLY_MAPPED";
  } else {
    mappingStatus = "ROOT_ONLY";
  }

  return {
    accountCode: code,
    mainCategory,
    classification,
    aggregationBehavior: behavior,
    statementType,
    statementLineCode,
    statementLineNameAr,
    source,
    matchedPrefix,
    rootPrefix: root?.prefix ?? null,
    companyPrefix: effCompany?.prefix ?? null,
    mappingStatus,
  };
}

/** خلاصة تغطية مجموعة أكواد حسب حالات الحل (لواجهة الإدارة و6.2B لاحقًا). */
export interface MappingCoverageSummary {
  total: number;
  byStatus: Record<MappingStatus, number>;
  fullyMapped: number;
  needsAttention: number; // ROOT_ONLY + NEEDS_DETAILED_CLASSIFICATION
  unclassified: number;   // NEEDS_CLASSIFICATION
}

export function summarizeMapping(results: readonly ResolvedAccountMapping[]): MappingCoverageSummary {
  const byStatus: Record<MappingStatus, number> = {
    FULLY_MAPPED: 0,
    ROOT_ONLY: 0,
    NEEDS_DETAILED_CLASSIFICATION: 0,
    NEEDS_CLASSIFICATION: 0,
  };
  for (const r of results) byStatus[r.mappingStatus] += 1;
  return {
    total: results.length,
    byStatus,
    fullyMapped: byStatus.FULLY_MAPPED,
    needsAttention: byStatus.ROOT_ONLY + byStatus.NEEDS_DETAILED_CLASSIFICATION,
    unclassified: byStatus.NEEDS_CLASSIFICATION,
  };
}
