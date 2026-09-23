// Phase 6.4A — مفاهيم قائمة التغيرات في حقوق الملكية (وحدة نقية — آمنة للعميل والخادم).
// المفاهيم reporting concepts وليست أكواد حسابات: كل شركة تربط بادئات حساباتها
// لأي مفهوم عبر EquityComponentMapping — أطول بادئة تفوز — بلا أي hard-code.

export const EQUITY_COMPONENTS = {
  SHARE_CAPITAL: "SHARE_CAPITAL",
  SHARE_PREMIUM: "SHARE_PREMIUM",
  STATUTORY_RESERVE: "STATUTORY_RESERVE",
  OTHER_RESERVES: "OTHER_RESERVES",
  RETAINED_EARNINGS: "RETAINED_EARNINGS",
  ACCUMULATED_LOSSES: "ACCUMULATED_LOSSES",
  OCI_COMPONENTS: "OCI_COMPONENTS",
  DIVIDENDS_DISTRIBUTIONS: "DIVIDENDS_DISTRIBUTIONS",
  OTHER_EQUITY_MOVEMENTS: "OTHER_EQUITY_MOVEMENTS",
} as const;

export type EquityComponent = (typeof EQUITY_COMPONENTS)[keyof typeof EQUITY_COMPONENTS];

export const EQUITY_COMPONENT_LABELS: Record<EquityComponent, string> = {
  SHARE_CAPITAL: "رأس المال المصرّف",
  SHARE_PREMIUM: "علاوة الإصدار",
  STATUTORY_RESERVE: "الاحتياطي النظامي/القانوني",
  OTHER_RESERVES: "احتياطيات أخرى",
  RETAINED_EARNINGS: "الأرباح المبقاة",
  ACCUMULATED_LOSSES: "الخسائر المتراكمة",
  OCI_COMPONENTS: "مكونات الدخل الشامل الآخر",
  DIVIDENDS_DISTRIBUTIONS: "التوزيعات/حصص الملكية المدفوعة",
  OTHER_EQUITY_MOVEMENTS: "حركات حقوق ملكية أخرى",
};

export const EQUITY_COMPONENT_CODES: readonly EquityComponent[] = Object.values(EQUITY_COMPONENTS);

export function isEquityComponent(v: unknown): v is EquityComponent {
  return typeof v === "string" && (EQUITY_COMPONENT_CODES as readonly string[]).includes(v);
}

/** تطبيع بادئة ربط حقوق الملكية: أرقام لاتينية فقط، بلا فواصل — نفس قواعد 6.2A. */
export function normalizeEquityPrefix(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\s\u066C]/g, "").replace(/[^\d]/g, "");
}
