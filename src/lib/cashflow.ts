// Phase 6.4B — قائمة التدفقات النقدية IAS 7 (وحدة نقية — آمنة للعميل والخادم).
// خريطة مستقلة كلية عن Financial Statement Mapping (قرار 6.4B):
//   resolver: ACCOUNT_OVERRIDE → LONGEST PREFIX → UNCLASSIFIED (فشل مغلق — لا تخمين).
// قاعدة الإشارة المركزية الوحيدة (لا إشارات مبعثرة في الواجهة):
//   - BALANCE: الحركة = إقفال − افتتاح؛ أثر النقد = ASSET ⇒ −الحركة، LIABILITY/EQUITY ⇒ +الحركة
//   - FLOW: الحركة عبر الجسور الموحدة (تراكمي⇄حركات)؛ أثر النقد = بند تسوية غير نقدية ⇒ +الحركة، غير ذلك ⇒ −الحركة

export const CF_ACTIVITIES = {
  OPERATING: "OPERATING",
  INVESTING: "INVESTING",
  FINANCING: "FINANCING",
  CASH_AND_CASH_EQUIVALENTS: "CASH_AND_CASH_EQUIVALENTS",
  NON_CASH: "NON_CASH",
  UNCLASSIFIED: "UNCLASSIFIED",
} as const;

export type CashFlowActivity = (typeof CF_ACTIVITIES)[keyof typeof CF_ACTIVITIES];

export const CF_ACTIVITY_LABELS: Record<CashFlowActivity, string> = {
  OPERATING: "أنشطة تشغيلية",
  INVESTING: "أنشطة استثمارية",
  FINANCING: "أنشطة تمويلية",
  CASH_AND_CASH_EQUIVALENTS: "النقد وما يعادله",
  NON_CASH: "بنود غير نقدية",
  UNCLASSIFIED: "غير مصنّف",
};

export const CF_MAPPED_ACTIVITIES: readonly CashFlowActivity[] = [
  CF_ACTIVITIES.OPERATING,
  CF_ACTIVITIES.INVESTING,
  CF_ACTIVITIES.FINANCING,
  CF_ACTIVITIES.CASH_AND_CASH_EQUIVALENTS,
  CF_ACTIVITIES.NON_CASH,
];

export function isCashFlowActivity(v: unknown): v is CashFlowActivity {
  return typeof v === "string" && Object.values(CF_ACTIVITIES).includes(v as CashFlowActivity);
}

export interface CashFlowRuleLike {
  prefix: string;
  activity: string;
  lineCode: string | null;
  isActive: boolean;
}

export interface CashFlowOverrideLike {
  accountCode: string;
  activity: string;
  lineCode: string | null;
  isActive: boolean;
}

export interface ResolvedCashFlow {
  source: "ACCOUNT_OVERRIDE" | "LONGEST_PREFIX" | "UNCLASSIFIED";
  activity: CashFlowActivity;
  lineCode: string | null;
}

/** الحل المركزي الوحيد: تجاوز الحساب → أطول بادئة → UNCLASSIFIED (بلا أي تخمين من الطبيعة). */
export function resolveCashFlowMapping(args: {
  accountCode: string;
  rules: readonly CashFlowRuleLike[];
  overrides: readonly CashFlowOverrideLike[];
}): ResolvedCashFlow {
  const override = args.overrides.find((o) => o.isActive && o.accountCode === args.accountCode);
  if (override) {
    return {
      source: "ACCOUNT_OVERRIDE",
      activity: (isCashFlowActivity(override.activity) ? override.activity : CF_ACTIVITIES.UNCLASSIFIED) as CashFlowActivity,
      lineCode: override.lineCode,
    };
  }
  const matching = args.rules
    .filter((r) => r.isActive && args.accountCode.startsWith(r.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  if (matching.length > 0) {
    const best = matching[0]!;
    return {
      source: "LONGEST_PREFIX",
      activity: (isCashFlowActivity(best.activity) ? best.activity : CF_ACTIVITIES.UNCLASSIFIED) as CashFlowActivity,
      lineCode: best.lineCode,
    };
  }
  return { source: "UNCLASSIFIED", activity: CF_ACTIVITIES.UNCLASSIFIED, lineCode: null };
}

/** أثر النقد لحساب BALANCE — قاعدة مركزية موحدة: net = مدين−دائن ⇒ الزيادة الائتمانية (التزام/حقوق) حركة سالبة تعني تدفقًا داخلًا. */
export function cashEffectForBalance(_classification: string | null, movementMinor: bigint): bigint {
  return -movementMinor;
}

/** أثر النقد لحساب FLOW — التسويات غير النقدية تُضاف (+)، والبنود النقدية تُطرح (−) بإشارة net (مدين−دائن). */
export function cashEffectForFlow(netMinor: bigint, isAdjustment: boolean): bigint {
  return isAdjustment ? netMinor : -netMinor;
}
