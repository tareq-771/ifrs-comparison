// Phase 6.5 — الموازنات (وحدة نقية — آمنة للعميل والخادم).
// سير العمل: DRAFT → SUBMITTED → APPROVED → LOCKED (نهائي غير قابل للتعديل).
// لا Unlock الآن (قرار 6.5) — النسخ الجديدة عبر مسار revision (versionNumber+1 مع نسخ البنود).

export const BUDGET_STATUSES = {
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  APPROVED: "APPROVED",
  LOCKED: "LOCKED",
} as const;

export type BudgetStatus = (typeof BUDGET_STATUSES)[keyof typeof BUDGET_STATUSES];

export const BUDGET_STATUS_LABELS: Record<BudgetStatus, string> = {
  DRAFT: "مسودة",
  SUBMITTED: "مقدمة للاعتماد",
  APPROVED: "معتمدة",
  LOCKED: "مقفلة (نهائية)",
};

/** الانتقالات الشرعية فقط — أي شيء آخر يُرفض fail-closed. */
export const BUDGET_TRANSITIONS: Record<BudgetStatus, readonly BudgetStatus[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["APPROVED", "DRAFT"], // RFD: إرجاع للمسودة بقرار المعتمد
  APPROVED: ["LOCKED"],
  LOCKED: [],
};

export function isBudgetTransitionAllowed(from: string, to: string): boolean {
  const allowed = BUDGET_TRANSITIONS[from as BudgetStatus];
  return !!allowed && (allowed as readonly string[]).includes(to);
}

export const BUDGET_TYPES = {
  ANNUAL: "ANNUAL",
  MONTHLY: "MONTHLY",
  QUARTERLY: "QUARTERLY",
  SEMI_ANNUAL: "SEMI_ANNUAL",
} as const;

export type BudgetType = (typeof BUDGET_TYPES)[keyof typeof BUDGET_TYPES];

export const BUDGET_TYPE_LABELS: Record<BudgetType, string> = {
  ANNUAL: "سنوية",
  MONTHLY: "شهرية",
  QUARTERLY: "ربع سنوية",
  SEMI_ANNUAL: "نصف سنوية",
};

export const BUDGET_SCENARIOS = {
  BASE: "BASE",
  CONSERVATIVE: "CONSERVATIVE",
  OPTIMISTIC: "OPTIMISTIC",
} as const;

export type BudgetScenario = (typeof BUDGET_SCENARIOS)[keyof typeof BUDGET_SCENARIOS];

export const BUDGET_SCENARIO_LABELS: Record<BudgetScenario, string> = {
  BASE: "الأساس",
  CONSERVATIVE: "المتحفظ",
  OPTIMISTIC: "المتائل",
};

/** توزيع متساوٍ محافظ: القسمة الصحيحة والباقي يذهب للفترة الأخيرة — بلا فقد minor واحد. */
export function distributeEqual(amountMinor: bigint, periods: number): bigint[] {
  if (!Number.isInteger(periods) || periods < 1) throw new Error("عدد فترات التوزيع غير صالح");
  const base = amountMinor / BigInt(periods);
  const remainder = amountMinor - base * BigInt(periods);
  return Array.from({ length: periods }, (_, i) => (i === periods - 1 ? base + remainder : base));
}

export const BUDGET_PROPOSAL_METHODS = {
  GROWTH_PERCENTAGE: "GROWTH_PERCENTAGE",
  PERCENT_OF_SALES: "PERCENT_OF_SALES",
  FIXED_AMOUNT: "FIXED_AMOUNT",
  INDEPENDENT_GROWTH: "INDEPENDENT_GROWTH",
  MANUAL_OVERRIDE: "MANUAL_OVERRIDE",
} as const;

export type BudgetProposalMethod = (typeof BUDGET_PROPOSAL_METHODS)[keyof typeof BUDGET_PROPOSAL_METHODS];

export const BUDGET_PROPOSAL_METHOD_LABELS: Record<BudgetProposalMethod, string> = {
  GROWTH_PERCENTAGE: "نمو نسبة مئوية عن خط الأساس",
  PERCENT_OF_SALES: "نسبة من المبيعات",
  FIXED_AMOUNT: "مبلغ ثابت",
  INDEPENDENT_GROWTH: "نمو مستقل لكل بند",
  MANUAL_OVERRIDE: "إدخال يدوي",
};

/** قاعدة Favorable/Unfavorable المركزية الوحيدة (قرار 6.5-AA):
 *  REVENUE: فعلي > موازنة ⇒ FAVORABLE | EXPENSE: فعلي < موازنة ⇒ FAVORABLE
 *  غير ذلك (أرصدة/بنود أخرى): NO_FAVORABLE_UNFAVORABLE — الفارق الرقمي منفصل عن التفسير. */
export type Favorability = "FAVORABLE" | "UNFAVORABLE" | "NO_FAVORABLE_UNFAVORABLE";

export function favorabilityFor(lineNature: "REVENUE" | "EXPENSE" | "OTHER", actualMinor: bigint | null, budgetMinor: bigint | null): Favorability {
  if (lineNature === "OTHER" || actualMinor === null || budgetMinor === null) return "NO_FAVORABLE_UNFAVORABLE";
  if (lineNature === "REVENUE") return actualMinor > budgetMinor ? "FAVORABLE" : actualMinor < budgetMinor ? "UNFAVORABLE" : "NO_FAVORABLE_UNFAVORABLE";
  return actualMinor < budgetMinor ? "FAVORABLE" : actualMinor > budgetMinor ? "UNFAVORABLE" : "NO_FAVORABLE_UNFAVORABLE";
}

export const FAVORABILITY_LABELS: Record<Favorability, string> = {
  FAVORABLE: "مؤاتٍ",
  UNFAVORABLE: "غير مؤاتٍ",
  NO_FAVORABLE_UNFAVORABLE: "بلا دلالة ف/غ (بند رصيد أو بلا بيانات)",
};

/** مدى ordinals لgranularity: MONTH = الفترة نفسها؛ QUARTER/SEMI_ANNUAL = مجموعات ثلاثية/سداسية ترتيبية؛ ANNUAL = السنة كاملة؛ YTD = 1..ordinal. */
export function ordinalRangeForGranularity(
  granularity: "MONTH" | "QUARTER" | "SEMI_ANNUAL" | "ANNUAL" | "YTD",
  ordinal: number,
  periodCount: number
): { startOrdinal: number; endOrdinal: number } {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > periodCount) {
    throw new Error(`الفترة ${ordinal} خارج مدى السنة (1..${periodCount})`);
  }
  switch (granularity) {
    case "MONTH":
      return { startOrdinal: ordinal, endOrdinal: ordinal };
    case "QUARTER": {
      const q = Math.ceil(ordinal / 3);
      const end = Math.min(q * 3, periodCount);
      return { startOrdinal: (q - 1) * 3 + 1, endOrdinal: end };
    }
    case "SEMI_ANNUAL": {
      const h = Math.ceil(ordinal / 6);
      const end = Math.min(h * 6, periodCount);
      return { startOrdinal: (h - 1) * 6 + 1, endOrdinal: end };
    }
    case "ANNUAL":
      return { startOrdinal: 1, endOrdinal: periodCount };
    case "YTD":
      return { startOrdinal: 1, endOrdinal: ordinal };
  }
}
