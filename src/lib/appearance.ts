// Phase 6.11 — مركز المظهر والتخصيص: النواة الحتمية القابلة للاختبار.
// (Appearance & Customization — pure types/config/validator, no React, no DOM)
//
// القرارات المعمارية (V1 fast track):
//  - التخزين: تفضيلات عرض محلية على المتصفح (localStorage) — تفضيلات العرض
//    ليست بيانات صلاحيات إطلاقًا ولا تُثق بها للأمان (§5/§12 من نطاق 6.11).
//  - لا تغيير مخطط قاعدة البيانات لهذه المرحلة — لا حاجة له.
//  - الافتراضيات مستقرة ومهنية: بلا تفضيل محفوظ (أو تفضيل تالف) ⇒ المظهر
//    الحالي كما هو تمامًا (corporate-green/16px/comfortable/zoom 100).
//  - لا ملفات خطوط مدمجة — خطوط محمّلة في التطبيق (Tajawal/Geist) أو stacks النظام.
//  - كل قيمة تُتحقق حدًّا حدًّا؛ القيمة خارج الحدود ⇒ الافتراض (لا استثناءات).

// ── الثيمات ─────────────────────────────────────────────────────────────────
export type AppearanceThemeId =
  | "corporate-green" // الافتراضي — الهوية الحالية (زمردي/أردوازي)
  | "financial-blue"  // أزرق مالي (طلب صريح من المالك في نطاق 6.11)
  | "professional-gray"
  | "high-contrast"
  | "dark"
  | "system"; // يتبع نظام التشغيل عبر next-themes

export const APPEARANCE_THEME_IDS: readonly AppearanceThemeId[] = [
  "corporate-green",
  "financial-blue",
  "professional-gray",
  "high-contrast",
  "dark",
  "system",
];

export const DEFAULT_THEME: AppearanceThemeId = "corporate-green";

export const THEME_LABELS: Record<AppearanceThemeId, { ar: string; en: string }> = {
  "corporate-green": { ar: "الأخضر المؤسسي (الافتراضي)", en: "Corporate Green (default)" },
  "financial-blue": { ar: "الأزرق المالي", en: "Financial Blue" },
  "professional-gray": { ar: "الرمادي الاحترافي", en: "Professional Gray" },
  "high-contrast": { ar: "عالي التباين", en: "High Contrast" },
  dark: { ar: "الوضع الداكن", en: "Dark Mode" },
  system: { ar: "تلقائي حسب النظام", en: "System / Auto" },
};

/** الثيمات الفاتحة تُطبَّق عبر data-appearance؛ الداكن/النظام عبر next-themes. */
export function isLightColorTheme(theme: AppearanceThemeId): boolean {
  return (
    theme === "corporate-green" ||
    theme === "financial-blue" ||
    theme === "professional-gray" ||
    theme === "high-contrast"
  );
}

/** قيمة next-themes المقابلة (dark|light|system). */
export function nextThemeFor(theme: AppearanceThemeId): "dark" | "light" | "system" {
  if (theme === "dark") return "dark";
  if (theme === "system") return "system";
  return "light";
}

// ── الخطوط (بلا ملفات مدمجة) ────────────────────────────────────────────────
export type ArabicFontId = "tajawal" | "system";
export type EnglishFontId = "geist" | "system";

export const DEFAULT_ARABIC_FONT: ArabicFontId = "tajawal";
export const DEFAULT_ENGLISH_FONT: EnglishFontId = "geist";

export const ARABIC_FONT_IDS: readonly ArabicFontId[] = ["tajawal", "system"];
export const ENGLISH_FONT_IDS: readonly EnglishFontId[] = ["geist", "system"];

export const ARABIC_FONT_LABELS: Record<ArabicFontId, { ar: string; en: string }> = {
  tajawal: { ar: "Tajawal (خط التطبيق)", en: "Tajawal (app font)" },
  system: { ar: "خط النظام (Segoe UI/Tahoma…)", en: "System stack (Segoe UI/Tahoma…)" },
};

export const ENGLISH_FONT_LABELS: Record<EnglishFontId, { ar: string; en: string }> = {
  geist: { ar: "Geist (خط التطبيق)", en: "Geist (app font)" },
  system: { ar: "خط النظام (system-ui/Arial)", en: "System stack (system-ui/Arial)" },
};

// ── الأحجام والكثافة والتكبير (حدود آمنة مغلقة) ─────────────────────────────
export const UI_FONT_SIZE_PX = { min: 14, max: 18, default: 16, step: 1 } as const;
export const TABLE_FONT_SIZE_PX = { min: 11, max: 16, default: 14, step: 1 } as const;
export const ZOOM_PCT = { min: 90, max: 125, default: 100, step: 5 } as const;

export type DensityId = "comfortable" | "compact";
export const DENSITY_IDS: readonly DensityId[] = ["comfortable", "compact"];
export const DEFAULT_DENSITY: DensityId = "comfortable";
export const DENSITY_LABELS: Record<DensityId, { ar: string; en: string }> = {
  comfortable: { ar: "مريح", en: "Comfortable" },
  compact: { ar: "مضغوط", en: "Compact" },
};

// ── الرسوم البيانية ─────────────────────────────────────────────────────────
export const DEFAULT_CHARTS_VISIBLE = true;

// ── تخصيص لوحة المعلومات ────────────────────────────────────────────────────
export type DashboardWidgetId =
  | "context" // السياق الحالي (الشركة/السنة)
  | "insights" // التنبيهات والتحليلات الذكية (6.11)
  | "statusCards" // بطاقات الحالة الأربع (ميزان/قوائم/موازنة/توحيد)
  | "shortcuts" // اختصارات مباشرة
  | "companies"; // الشركات المتاحة

export const DASHBOARD_WIDGET_IDS: readonly DashboardWidgetId[] = [
  "context",
  "insights",
  "statusCards",
  "shortcuts",
  "companies",
];

/** الترتيب الافتراضي الحتمي — يطابق ترتيب العرض قبل 6.11. */
export const DEFAULT_DASHBOARD_ORDER: readonly DashboardWidgetId[] = [
  "context",
  "insights",
  "statusCards",
  "shortcuts",
  "companies",
];

export const DASHBOARD_WIDGET_LABELS: Record<DashboardWidgetId, { ar: string; en: string }> = {
  context: { ar: "السياق الحالي — الشركة والسنة", en: "Current context (company/year)" },
  insights: { ar: "التنبيهات والتحليلات الذكية", en: "Smart Alerts & Insights" },
  statusCards: { ar: "بطاقات الحالة (ميزان · قوائم · موازنة · توحيد)", en: "Status cards (TB · statements · budget · groups)" },
  shortcuts: { ar: "اختصارات مباشرة", en: "Quick shortcuts" },
  companies: { ar: "الشركات المتاحة لك", en: "Companies available to you" },
};

export interface DashboardPrefs {
  /** عنصر مخفي = false (الافتراضي ظاهر). الإخفاء لا يمنح/يسحب أي صلاحية بيانات. */
  hidden: DashboardWidgetId[];
  /** ترتيب حتمي — يُطبَّع دائمًا ضد DASHBOARD_WIDGET_IDS (مجهول يُسقط، ناقص يُلحق بالنهاية). */
  order: DashboardWidgetId[];
}

export const DEFAULT_DASHBOARD_PREFS: DashboardPrefs = {
  hidden: [],
  order: [...DEFAULT_DASHBOARD_ORDER],
};

// ── التفضيلات الكاملة ───────────────────────────────────────────────────────
export interface AppearancePrefs {
  theme: AppearanceThemeId;
  arabicFont: ArabicFontId;
  englishFont: EnglishFontId;
  uiFontSizePx: number;
  tableFontSizePx: number;
  density: DensityId;
  zoomPct: number;
  chartsVisible: boolean;
  dashboard: DashboardPrefs;
}

export const DEFAULT_APPEARANCE_PREFS: AppearancePrefs = {
  theme: DEFAULT_THEME,
  arabicFont: DEFAULT_ARABIC_FONT,
  englishFont: DEFAULT_ENGLISH_FONT,
  uiFontSizePx: UI_FONT_SIZE_PX.default,
  tableFontSizePx: TABLE_FONT_SIZE_PX.default,
  density: DEFAULT_DENSITY,
  zoomPct: ZOOM_PCT.default,
  chartsVisible: DEFAULT_CHARTS_VISIBLE,
  dashboard: { ...DEFAULT_DASHBOARD_PREFS, hidden: [], order: [...DEFAULT_DASHBOARD_ORDER] },
};

export const APPEARANCE_STORAGE_KEY = "ifrs.appearance.prefs.v1";

// ── أدوات التحقق الحتمية (تُستخدم في البوابة) ───────────────────────────────
export function clampInt(value: unknown, bounds: { min: number; max: number; default: number }): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return bounds.default;
  const i = Math.round(n);
  if (i < bounds.min) return bounds.default;
  if (i > bounds.max) return bounds.default;
  return i;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function stringArray(value: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string" && allowed.includes(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * تطبيع ترتيب عناصر لوحة المعلومات: بلا تكرار، المجهول يُسقط، الناقص يُلحق
 * بالترتيب الافتراضي في نهايته — حتمي بالكامل (نفس المدخل ⇒ نفس الناتج).
 */
export function normalizeDashboardOrder(
  order: unknown,
  allowed: readonly DashboardWidgetId[] = DASHBOARD_WIDGET_IDS
): DashboardWidgetId[] {
  const cleaned = stringArray(order, allowed) as DashboardWidgetId[];
  const seen = new Set(cleaned);
  const missing = allowed.filter((id) => !seen.has(id));
  return [...cleaned, ...missing];
}

/** التحقق الشامل: أي حقل تالف/غائب ⇒ قيمته الافتراضية. لا استثناءات أبدًا. */
export function parseAppearancePrefs(raw: unknown): AppearancePrefs {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return structuredCopyDefaults();
  }
  const obj = raw as Record<string, unknown>;
  const dashRaw = (obj.dashboard ?? null) as Record<string, unknown> | null;
  const dashboard: DashboardPrefs = dashRaw && typeof dashRaw === "object" && !Array.isArray(dashRaw)
    ? {
        hidden: stringArray(dashRaw.hidden, DASHBOARD_WIDGET_IDS) as DashboardWidgetId[],
        order: normalizeDashboardOrder(dashRaw.order),
      }
    : { hidden: [], order: [...DEFAULT_DASHBOARD_ORDER] };
  return {
    theme: oneOf(obj.theme, APPEARANCE_THEME_IDS, DEFAULT_THEME),
    arabicFont: oneOf(obj.arabicFont, ARABIC_FONT_IDS, DEFAULT_ARABIC_FONT),
    englishFont: oneOf(obj.englishFont, ENGLISH_FONT_IDS, DEFAULT_ENGLISH_FONT),
    uiFontSizePx: clampInt(obj.uiFontSizePx, UI_FONT_SIZE_PX),
    tableFontSizePx: clampInt(obj.tableFontSizePx, TABLE_FONT_SIZE_PX),
    density: oneOf(obj.density, DENSITY_IDS, DEFAULT_DENSITY),
    zoomPct: clampInt(obj.zoomPct, ZOOM_PCT),
    chartsVisible: typeof obj.chartsVisible === "boolean" ? obj.chartsVisible : DEFAULT_CHARTS_VISIBLE,
    dashboard,
  };
}

/** تحويل آمن للتخزين (نفس الشكل — بلا حقول غريبة). */
export function serializeAppearancePrefs(prefs: AppearancePrefs): string {
  const clean = parseAppearancePrefs(prefs);
  return JSON.stringify(clean);
}

/** هل التفضيل = الافتراضي بالكامل؟ (لتجنب الكتابة غير الضرورية) */
export function isDefaultPrefs(prefs: AppearancePrefs): boolean {
  const d = DEFAULT_APPEARANCE_PREFS;
  return (
    prefs.theme === d.theme &&
    prefs.arabicFont === d.arabicFont &&
    prefs.englishFont === d.englishFont &&
    prefs.uiFontSizePx === d.uiFontSizePx &&
    prefs.tableFontSizePx === d.tableFontSizePx &&
    prefs.density === d.density &&
    prefs.zoomPct === d.zoomPct &&
    prefs.chartsVisible === d.chartsVisible &&
    prefs.dashboard.hidden.length === 0 &&
    prefs.dashboard.order.join("|") === d.dashboard.order.join("|")
  );
}

function structuredCopyDefaults(): AppearancePrefs {
  return {
    ...DEFAULT_APPEARANCE_PREFS,
    dashboard: { hidden: [], order: [...DEFAULT_DASHBOARD_ORDER] },
  };
}

// ── تطبيق التفضيلات على DOM (نقطة واحدة مركزية — تُستخدم من المزوّد) ─────────
export interface AppliedAppearance {
  /** data-appearance على <html> — فقط للثيمات الفاتحة غير الافتراضية. */
  appearanceAttr: string | null;
  densityAttr: DensityId | null;
  /** px جذر (zoom) — null = الافتراضي بلا لمس. */
  rootFontSizePx: number | null;
  uiFontSizePx: number | null;
  tableFontSizePx: number | null;
  fontArStack: string | null;
  fontEnStack: string | null;
}

export const SYSTEM_ARABIC_STACK = 'system-ui, "Segoe UI", Tahoma, Arial, sans-serif';
export const SYSTEM_ENGLISH_STACK = "system-ui, Arial, sans-serif";
export const APP_ARABIC_STACK = 'var(--font-tajawal, system-ui)';
export const APP_ENGLISH_STACK = "var(--font-geist-sans, system-ui)";

export function computeAppliedAppearance(prefs: AppearancePrefs): AppliedAppearance {
  const d = DEFAULT_APPEARANCE_PREFS;
  return {
    appearanceAttr: isLightColorTheme(prefs.theme) && prefs.theme !== d.theme ? prefs.theme : null,
    densityAttr: prefs.density !== d.density ? prefs.density : null,
    rootFontSizePx: prefs.zoomPct !== d.zoomPct ? Math.round((16 * prefs.zoomPct) / 100 * 100) / 100 : null,
    uiFontSizePx: prefs.uiFontSizePx !== d.uiFontSizePx ? prefs.uiFontSizePx : null,
    tableFontSizePx: prefs.tableFontSizePx !== d.tableFontSizePx ? prefs.tableFontSizePx : null,
    fontArStack: prefs.arabicFont === "system" ? SYSTEM_ARABIC_STACK : null,
    fontEnStack: prefs.englishFont === "system" ? SYSTEM_ENGLISH_STACK : null,
  };
}
