"use client";

// Phase 6.11 — المظهر والتخصيص (Appearance & Customization).
// مركز واحد: الثيم، الخطوط، الأحجام، الكثافة، التكبير، الرسوم، تخصيص لوحة
// المعلومات، واستعادة الافتراضيات. تفضيلات عرض محلية للمستخدم — لا تمنح
// ولا تسحب أي صلاحية بيانات (الإخفاء ليس تصريحًا).

import * as React from "react";
import {
  ArrowDown, ArrowUp, Check, Contrast, Laptop, Moon, Palette, RotateCcw, Type,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useAppearance } from "@/components/appearance/appearance-provider";
import {
  ARABIC_FONT_IDS, ARABIC_FONT_LABELS, DASHBOARD_WIDGET_IDS, DASHBOARD_WIDGET_LABELS,
  DENSITY_IDS, DENSITY_LABELS, ENGLISH_FONT_IDS, ENGLISH_FONT_LABELS, TABLE_FONT_SIZE_PX,
  THEME_LABELS, UI_FONT_SIZE_PX, ZOOM_PCT,
  type ArabicFontId, type AppearanceThemeId, type DashboardWidgetId, type DensityId, type EnglishFontId,
} from "@/lib/appearance";

/** عيّنات ألوان مصغّرة لكل ثيم (عرض توضيحي فقط). */
const THEME_SWATCHES: Record<AppearanceThemeId, string[]> = {
  "corporate-green": ["#059669", "#0d9488", "#f8fafc"],
  "financial-blue": ["#1d4ed8", "#0e7490", "#f8fafc"],
  "professional-gray": ["#3f3f46", "#a1a1aa", "#fafafa"],
  "high-contrast": ["#059669", "#0f172a", "#ffffff"],
  dark: ["#0f172a", "#334155", "#e2e8f0"],
  system: ["#059669", "#0f172a", "#f1f5f9"],
};

export function AppearanceView() {
  const { toast } = useToast();
  const { prefs, update, resetDefaults, hydrated } = useAppearance();

  const applyTheme = (t: AppearanceThemeId) => update({ theme: t });
  const moveWidget = (id: DashboardWidgetId, dir: -1 | 1) => {
    const order = [...prefs.dashboard.order];
    const i = order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    update({ dashboard: { ...prefs.dashboard, order } });
  };
  const toggleWidget = (id: DashboardWidgetId, visible: boolean) => {
    const hidden = new Set(prefs.dashboard.hidden);
    if (visible) hidden.delete(id);
    else hidden.add(id);
    update({ dashboard: { ...prefs.dashboard, hidden: [...hidden] } });
  };

  const onReset = () => {
    resetDefaults();
    toast({ title: "استُعيدت الافتراضيات", description: "عادت كل تفضيلات العرض إلى الحالة الافتراضية المهنية." });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="size-4 text-emerald-600 dark:text-emerald-400" />
            المظهر والتخصيص
          </CardTitle>
          <CardDescription>
            Appearance &amp; Customization — تُطبَّق التغييرات فورًا وتُحفظ على هذا المتصفح لهذا الجهاز.
            تفضيلات العرض تخص طريقة العرض فقط ولا تمنح أي صلاحية على البيانات.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* الثيمات */}
          <section aria-label="الثيم" className="space-y-2">
            <Label className="text-sm font-semibold">الثيم</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {(Object.keys(THEME_LABELS) as AppearanceThemeId[]).map((t) => {
                const active = prefs.theme === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => applyTheme(t)}
                    aria-pressed={active}
                    className={cn(
                      "flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-xl border p-3 text-center transition-colors",
                      active
                        ? "border-emerald-500 bg-emerald-50/60 dark:border-emerald-500 dark:bg-emerald-950/30"
                        : "border-slate-200 hover:border-emerald-300 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900"
                    )}
                  >
                    <span className="flex items-center gap-1">
                      {THEME_SWATCHES[t].map((c, i) => (
                        <span key={i} className="inline-block size-4 rounded-full border border-black/10" style={{ background: c }} />
                      ))}
                    </span>
                    <span className="flex items-center gap-1 text-[11px] font-semibold leading-tight text-slate-700 dark:text-slate-200">
                      {t === "dark" ? <Moon className="size-3" /> : t === "system" ? <Laptop className="size-3" /> : t === "high-contrast" ? <Contrast className="size-3" /> : null}
                      {THEME_LABELS[t].ar}
                    </span>
                    {active && <Check className="size-3 text-emerald-600 dark:text-emerald-400" />}
                  </button>
                );
              })}
            </div>
          </section>

          <Separator />

          {/* الخطوط */}
          <section aria-label="الخطوط" className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-sm font-semibold">الخط العربي</Label>
              <Select value={prefs.arabicFont} onValueChange={(v) => update({ arabicFont: v as ArabicFontId })}>
                <SelectTrigger aria-label="الخط العربي"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ARABIC_FONT_IDS.map((f) => (
                    <SelectItem key={f} value={f}>{ARABIC_FONT_LABELS[f].ar}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-slate-400">بلا ملفات خطوط مدمجة — خطوط التطبيق أو خطوط النظام.</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm font-semibold">الخط الإنجليزي</Label>
              <Select value={prefs.englishFont} onValueChange={(v) => update({ englishFont: v as EnglishFontId })}>
                <SelectTrigger aria-label="الخط الإنجليزي"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ENGLISH_FONT_IDS.map((f) => (
                    <SelectItem key={f} value={f}>{ENGLISH_FONT_LABELS[f].ar}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </section>

          <Separator />

          {/* الأحجام */}
          <section aria-label="أحجام الخطوط" className="grid gap-4 sm:grid-cols-2">
            <StepperField
              icon={<Type className="size-3.5" />}
              label="حجم خط الواجهة"
              hint={`العناصر الأساسية بلا أحجام صريحة (${UI_FONT_SIZE_PX.min}–${UI_FONT_SIZE_PX.max}px)`}
              value={prefs.uiFontSizePx}
              bounds={UI_FONT_SIZE_PX}
              onChange={(v) => update({ uiFontSizePx: v })}
            />
            <StepperField
              icon={<Type className="size-3.5" />}
              label="حجم خط الجداول والتقارير"
              hint={`ينطبق على خلايا الجداول (${TABLE_FONT_SIZE_PX.min}–${TABLE_FONT_SIZE_PX.max}px)`}
              value={prefs.tableFontSizePx}
              bounds={TABLE_FONT_SIZE_PX}
              onChange={(v) => update({ tableFontSizePx: v })}
            />
          </section>

          <Separator />

          {/* الكثافة والتكبير */}
          <section aria-label="الكثافة والتكبير" className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-sm font-semibold">كثافة الواجهة</Label>
              <div className="flex gap-2">
                {DENSITY_IDS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => update({ density: d as DensityId })}
                    aria-pressed={prefs.density === d}
                    className={cn(
                      "min-h-[40px] flex-1 rounded-lg border px-3 text-xs font-semibold transition-colors",
                      prefs.density === d
                        ? "border-emerald-500 bg-emerald-50/60 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                        : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900"
                    )}
                  >
                    {DENSITY_LABELS[d].ar}
                  </button>
                ))}
              </div>
            </div>
            <StepperField
              icon={<span className="font-mono text-[10px]">%</span>}
              label="تكبير الواجهة"
              hint={`مقياس عام آمن (${ZOOM_PCT.min}%–${ZOOM_PCT.max}%) — الطباعة تُعاد ضبطها تلقائيًا`}
              value={prefs.zoomPct}
              bounds={ZOOM_PCT}
              unit="%"
              onChange={(v) => update({ zoomPct: v })}
            />
          </section>

          <Separator />

          {/* الرسوم البيانية */}
          <section aria-label="الرسوم البيانية" className="flex items-center justify-between gap-4">
            <div>
              <Label className="text-sm font-semibold">إظهار الرسوم البيانية</Label>
              <p className="text-[11px] text-slate-400">إخفاؤها لا يغيّر أي رقم — الجداول النصية تبقى المرجع الدقيق دائمًا.</p>
            </div>
            <Switch
              aria-label="إظهار الرسوم البيانية"
              checked={prefs.chartsVisible}
              onCheckedChange={(v) => update({ chartsVisible: v })}
            />
          </section>
        </CardContent>
      </Card>

      {/* تخصيص لوحة المعلومات */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">تخصيص لوحة المعلومات</CardTitle>
          <CardDescription>
            إظهار/إخفاء عناصر لوحة المعلومات وترتيبها. الإخفاء لا يمنح أي وصول — ما لا تملك صلاحيته لا يظهر أصلًا
            بغضّ النظر عن هذه التفضيلات.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {prefs.dashboard.order.map((id, idx) => (
              <li
                key={id}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant="outline" className="tnum shrink-0 px-1.5 text-[10px]">{idx + 1}</Badge>
                  <span className="truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
                    {DASHBOARD_WIDGET_LABELS[id].ar}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost" size="icon" className="size-8" aria-label={`تحريك ${DASHBOARD_WIDGET_LABELS[id].ar} لأعلى`}
                    disabled={idx === 0} onClick={() => moveWidget(id, -1)}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost" size="icon" className="size-8" aria-label={`تحريك ${DASHBOARD_WIDGET_LABELS[id].ar} لأسفل`}
                    disabled={idx === prefs.dashboard.order.length - 1} onClick={() => moveWidget(id, 1)}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Switch
                    aria-label={`إظهار ${DASHBOARD_WIDGET_LABELS[id].ar}`}
                    checked={!prefs.dashboard.hidden.includes(id)}
                    onCheckedChange={(v) => toggleWidget(id, v)}
                  />
                </div>
              </li>
            ))}
          </ul>
          {DASHBOARD_WIDGET_IDS.length !== prefs.dashboard.order.length && (
            <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
              يوجد اختلاف عن القائمة الافتراضية — سيُطبَّع الترتيب تلقائيًا عند الحفظ.
            </p>
          )}
        </CardContent>
      </Card>

      {/* استعادة الافتراضيات */}
      <Card>
        <CardContent className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-semibold">استعادة الافتراضيات</p>
            <p className="text-[11px] text-slate-400">يعيد الثيم والخطوط والأحجام والكثافة والتكبير وتخصيص اللوحة إلى الحالة الافتراضية.</p>
          </div>
          <Button variant="outline" onClick={onReset} disabled={!hydrated} className="gap-1.5">
            <RotateCcw className="size-3.5" /> استعادة الافتراضيات
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function StepperField({ icon, label, hint, value, bounds, unit, onChange }: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  value: number;
  bounds: { min: number; max: number; step: number };
  unit?: string;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(bounds.max, Math.max(bounds.min, v));
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-sm font-semibold">{icon}{label}</Label>
      <div className="flex items-center gap-2">
        <Button
          variant="outline" size="icon" className="size-9" aria-label={`إنقاص ${label}`}
          disabled={value <= bounds.min} onClick={() => onChange(clamp(value - bounds.step))}
        >
          −
        </Button>
        <span className="tnum min-w-[64px] rounded-lg border px-3 py-2 text-center text-sm font-semibold" dir="ltr">
          {value}{unit ?? "px"}
        </span>
        <Button
          variant="outline" size="icon" className="size-9" aria-label={`زيادة ${label}`}
          disabled={value >= bounds.max} onClick={() => onChange(clamp(value + bounds.step))}
        >
          +
        </Button>
      </div>
      <p className="text-[11px] text-slate-400">{hint}</p>
    </div>
  );
}
