"use client";

// Phase 6.11 — مزوّد المظهر: تطبيق مركزي للتخصيصات على <html> + تخزين محلي.
// - SSR-آمن: الحالة الابتدائية = الافتراضات؛ التطبيق في useEffect فقط
//   (لا اختلاف hydration — HTML السيرفر والعميل متطابقان).
// - التخزين: localStorage بمفتاح ثابت — تفضيلات عرض فقط، ليست بيانات
//   صلاحيات، ولا تُثق بها للأمان إطلاقًا (انظر §5/§12 من نطاق 6.11).
// - القيم التالفة تُتجاهل صمتًا وتُعاد الافتراضات (parseAppearancePrefs).
// - التكبير عبر font-size للجذر (rem-based) — الطباعة تُعاد ضبطها بالـCSS.

import * as React from "react";
import { useTheme } from "next-themes";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE_PREFS,
  computeAppliedAppearance,
  isDefaultPrefs,
  nextThemeFor,
  parseAppearancePrefs,
  serializeAppearancePrefs,
  type AppearancePrefs,
} from "@/lib/appearance";

interface AppearanceContextValue {
  prefs: AppearancePrefs;
  /** دمج جزئي آمن + حفظ فوري. */
  update: (patch: Partial<AppearancePrefs>) => void;
  resetDefaults: () => void;
  /** true بعد أول قراءة من التخزين (لتجنب وميض الواجهة قبل الترطيب). */
  hydrated: boolean;
}

const AppearanceContext = React.createContext<AppearanceContextValue | null>(null);

function freshDefaults(): AppearancePrefs {
  return { ...DEFAULT_APPEARANCE_PREFS, dashboard: { hidden: [], order: [...DEFAULT_APPEARANCE_PREFS.dashboard.order] } };
}

function readStoredPrefs(): AppearancePrefs {
  if (typeof window === "undefined") return freshDefaults();
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return freshDefaults();
    return parseAppearancePrefs(JSON.parse(raw));
  } catch {
    return freshDefaults();
  }
}

function applyToDocument(prefs: AppearancePrefs): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  const applied = computeAppliedAppearance(prefs);

  // الثيمات الفاتحة عبر data-appearance (corporate-green الافتراضي بلا سمة)
  if (applied.appearanceAttr) el.setAttribute("data-appearance", applied.appearanceAttr);
  else el.removeAttribute("data-appearance");

  // الكثافة
  if (applied.densityAttr) el.setAttribute("data-density", applied.densityAttr);
  else el.removeAttribute("data-density");

  // حجم خط الجداول
  if (applied.tableFontSizePx != null) {
    el.setAttribute("data-table-font", "custom");
    el.style.setProperty("--app-table-font-size", `${applied.tableFontSizePx}px`);
  } else {
    el.removeAttribute("data-table-font");
    el.style.removeProperty("--app-table-font-size");
  }

  // حجم خط الواجهة الأساسي
  if (applied.uiFontSizePx != null) el.style.setProperty("--app-ui-font-size", `${applied.uiFontSizePx}px`);
  else el.style.removeProperty("--app-ui-font-size");

  // التكبير عبر الجذر
  if (applied.rootFontSizePx != null) el.style.fontSize = `${applied.rootFontSizePx}px`;
  else el.style.removeProperty("font-size");

  // الخطوط
  if (applied.fontArStack) el.style.setProperty("--app-font-ar", applied.fontArStack);
  else el.style.removeProperty("--app-font-ar");
  if (applied.fontEnStack) el.style.setProperty("--app-font-en", applied.fontEnStack);
  else el.style.removeProperty("--app-font-en");
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = React.useState<AppearancePrefs>(freshDefaults);
  const [hydrated, setHydrated] = React.useState(false);
  const { setTheme } = useTheme();

  // ترطيب أولي من التخزين ثم تطبيق + مزامنة next-themes
  React.useEffect(() => {
    const stored = readStoredPrefs();
    setPrefs(stored);
    setHydrated(true);
    applyToDocument(stored);
  }, []);

  // تطبيق أي تغيير لاحق (بما فيه مزامنة الوضع الداكن/النظام)
  React.useEffect(() => {
    if (!hydrated) return;
    applyToDocument(prefs);
    setTheme(nextThemeFor(prefs.theme));
  }, [prefs, hydrated, setTheme]);

  const update = React.useCallback((patch: Partial<AppearancePrefs>) => {
    setPrefs((prev) => {
      const next: AppearancePrefs = {
        ...prev,
        ...patch,
        dashboard: patch.dashboard ? { ...prev.dashboard, ...patch.dashboard } : prev.dashboard,
      };
      try {
        if (isDefaultPrefs(next)) window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
        else window.localStorage.setItem(APPEARANCE_STORAGE_KEY, serializeAppearancePrefs(next));
      } catch {
        // تخزين غير متاح (وضع خصوصي) — التفضيل يعمل للجلسة فقط بلا أخطاء
      }
      return next;
    });
  }, []);

  const resetDefaults = React.useCallback(() => {
    setPrefs(freshDefaults());
    try {
      window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
    } catch {
      // تجاهل
    }
  }, []);

  const value = React.useMemo<AppearanceContextValue>(
    () => ({ prefs, update, resetDefaults, hydrated }),
    [prefs, update, resetDefaults, hydrated]
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const ctx = React.useContext(AppearanceContext);
  if (!ctx) throw new Error("useAppearance must be used within AppearanceProvider");
  return ctx;
}
