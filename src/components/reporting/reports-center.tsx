"use client";

// 6.8 — مركز التقارير: تنظيم الوصول على الهيكل الشركة ← السنة المالية ← الفترة ← نوع التقرير.
// أساس ملاحة/عرض فقط — لا يبتكر نموذج snapshots محاسبي: لقطات التقارير المعتمدة غير القابلة
// للتغيير (immutable approved snapshots) مرحلة لاحقة موثقة أدناه. الملاحة تفتح التقارير
// الحالية من خدماتها المعتمدة حصرًا عبر روابط عميقة ?view=... — الصلاحيات تبقى مفروضة من الخادم.

import * as React from "react";
import {
  ArrowLeftRight, FileBarChart, FileSpreadsheet, Layers, Landmark, Scale, Target, TrendingUp, Waves, Info,
} from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useCompanyPeriod } from "@/components/reporting/company-period-context";
import { canManageTrialBalances, parsePermissions, type Permissions } from "@/lib/permissions";
import type { HomeView } from "@/components/reporting/dashboard-view";
import { useSession } from "next-auth/react";

interface ReportTypeCard {
  key: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  /** باراميترات الرابط العميق داخل تبويب موجود (لا صفحات وهمية) */
  params: (ordinal: string) => Record<string, string | undefined>;
  /** يظهر فقط مع صلاحية عرض التقارير الفعلية؟ */
  requiresReportingPermission: boolean;
  orientation: "portrait" | "landscape";
}

const REPORT_TYPES: ReportTypeCard[] = [
  {
    key: "trial-balance",
    title: "ميزان المراجعة",
    description: "المصدر الأساسي للأرقام الفعلية — استيراد، تصنيف، اعتماد، طباعة A4 أفقي.",
    icon: <Scale className="size-4" />,
    params: () => ({}),
    requiresReportingPermission: true,
    orientation: "landscape",
  },
  {
    key: "pnl",
    title: "قائمة الربح أو الخسارة والدخل الشامل الآخر",
    description: "Profit or Loss & OCI — تراكمي أو حركة فترة، مع تفصيل الحسابات.",
    icon: <TrendingUp className="size-4" />,
    params: (v) => ({ stmt: "pnl", ordinal: v }),
    requiresReportingPermission: true,
    orientation: "portrait",
  },
  {
    key: "sfp",
    title: "قائمة المركز المالي",
    description: "Statement of Financial Position — as-of نهاية الفترة مع المعادلة المحاسبية.",
    icon: <Landmark className="size-4" />,
    params: (v) => ({ stmt: "sfp", ordinal: v }),
    requiresReportingPermission: true,
    orientation: "portrait",
  },
  {
    key: "socie",
    title: "قائمة التغيرات في حقوق الملكية",
    description: "SOCIE — افتتاحي/حركات/ختامي لكل مكوّن، بلا plug.",
    icon: <FileBarChart className="size-4" />,
    params: (v) => ({ stmt: "socie", endOrdinal: v }),
    requiresReportingPermission: true,
    orientation: "portrait",
  },
  {
    key: "cf",
    title: "قائمة التدفقات النقدية (IAS 7)",
    description: "طريقة غير مباشرة — أنشطة ثلاثة + مطابقة نقد ظاهرة.",
    icon: <Waves className="size-4" />,
    params: (v) => ({ stmt: "cf", endOrdinal: v }),
    requiresReportingPermission: true,
    orientation: "portrait",
  },
  {
    key: "avb",
    title: "فعلي مقابل موازنة",
    description: "Actual vs Budget — شهر/ربع/نصف/سنوي/YTD، فارق رقمي منفصل عن ف/غ.",
    icon: <Target className="size-4" />,
    params: (v) => ({ tab: "variance", ordinal: v }),
    requiresReportingPermission: true,
    orientation: "landscape",
  },
  {
    key: "consolidated",
    title: "التقارير الموحدة الأولية (Preliminary)",
    description: "ورقة عمل لكل شركة ← قبل الاستبعادات ← الاستبعادات ← الموحد — بلا NCI/شهرة.",
    icon: <Layers className="size-4" />,
    params: () => ({}),
    requiresReportingPermission: true,
    orientation: "landscape",
  },
];

/** بذرة الرابط العميق الصحيحة حسب حالة الملاحة (لا صفحات وهمية — كلها تبويبات موجودة). */
export function ReportsCenter({ onNavigate }: { onNavigate: (view: HomeView, params?: Record<string, string | undefined>) => void }) {
  const { data: session } = useSession();
  const {
    companies, companiesLoading, selectedCompanyId, setSelectedCompanyId, selectedCompany,
    fiscalYears, fiscalYearsLoading, selectedFiscalYearId, setSelectedFiscalYearId, selectedFiscalYear,
  } = useCompanyPeriod();

  const perms = React.useMemo<Permissions>(() => {
    if (!session?.user) return parsePermissions(null);
    const raw = (session.user as { permissions?: unknown }).permissions;
    if (typeof raw === "string") return parsePermissions(raw);
    if (raw && typeof raw === "object") return parsePermissions(JSON.stringify(raw));
    return parsePermissions(null);
  }, [session]);
  const role = ((session?.user as { role?: string } | undefined)?.role) ?? "user";
  const canView = canManageTrialBalances(perms, role);

  const periods = selectedFiscalYear?.periods ?? [];
  const [ordinal, setOrdinal] = React.useState<string>("");
  React.useEffect(() => {
    setOrdinal((p) => {
      if (p && periods.some((x) => String(x.ordinal) === p)) return p;
      return periods.length > 0 ? String(periods[periods.length - 1].ordinal) : "";
    });
  }, [periods]);

  const period = periods.find((p) => String(p.ordinal) === ordinal) ?? null;

  return (
    <div className="space-y-6" dir="rtl">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="size-4 text-emerald-600 dark:text-emerald-400" />
            مركز التقارير — الشركة ← السنة المالية ← الفترة ← نوع التقرير
          </CardTitle>
          <CardDescription>
            ملاحة موحدة لكل التقارير المتاحة. كل تقرير يُفتح من مصدره المعتمد حصرًا مع ترويسة موحدة وزر طباعة A4.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label>الشركة</Label>
            <Select value={selectedCompanyId ?? ""} onValueChange={setSelectedCompanyId}>
              <SelectTrigger aria-label="الشركة">
                <SelectValue placeholder={companiesLoading ? "…" : "اختر شركة"} />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="tnum">{c.code}</span> — {c.nameAr}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>السنة المالية</Label>
            <Select value={selectedFiscalYearId ?? ""} onValueChange={setSelectedFiscalYearId} disabled={!selectedCompanyId}>
              <SelectTrigger aria-label="السنة المالية">
                <SelectValue placeholder={fiscalYearsLoading ? "…" : "اختر سنة"} />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {fiscalYears.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    <span className="tnum">{f.code}</span> ({f.startDate} → {f.endDate})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>الفترة</Label>
            <Select value={ordinal} onValueChange={setOrdinal} disabled={periods.length === 0}>
              <SelectTrigger aria-label="الفترة">
                <SelectValue placeholder={periods.length === 0 ? "لا فترات" : "اختر فترة"} />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {periods.map((p) => (
                  <SelectItem key={p.id} value={String(p.ordinal)}>
                    {p.ordinal} — {p.displayLabel || p.code} ({p.startDate} → {p.endDate})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {period && (
            <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
              الفترة المحددة: <span className="tnum" dir="ltr">{period.startDate} → {period.endDate}</span> — {period.status}
              {selectedCompany ? ` · العملة: ${selectedCompany.functionalCurrency}` : ""}
            </p>
          )}
        </CardContent>
      </Card>

      {!canView ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            لا تملك صلاحية عرض التقارير الفعلية — تواصل مع مدير النظام.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {REPORT_TYPES.map((r) => (
            <Card key={r.key} className="flex flex-col transition-colors hover:border-emerald-400/60">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <span className="text-emerald-600 dark:text-emerald-400">{r.icon}</span>
                  {r.title}
                </CardTitle>
                <CardDescription className="text-xs leading-5">{r.description}</CardDescription>
              </CardHeader>
              <CardContent className="mt-auto flex items-center justify-between gap-2">
                <Badge variant="outline" className="text-[10px]">
                  طباعة A4 {r.orientation === "landscape" ? "أفقي" : "رأسي"}
                </Badge>
                <button
                  type="button"
                  onClick={() => onNavigate(r.key === "trial-balance" ? "trial-balance" : r.key === "consolidated" ? "consolidation" : r.key === "avb" ? "budget" : "statements", r.params(ordinal))}
                  aria-label={`فتح ${r.title}`}
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50/60 px-3 text-xs font-bold text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-400 dark:hover:bg-emerald-950/50"
                >
                  فتح التقرير <ArrowLeftRight className="size-3 rotate-180" />
                </button>
              </CardContent>
            </Card>
          ))}
          <Card className="border-dashed sm:col-span-2 lg:col-span-3">
            <CardContent className="flex flex-wrap items-start gap-2 p-4 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>أداة مقارنة القوائم السابقة متاحة كأداة مستقلة:</span>
              <button type="button" onClick={() => onNavigate("compare")} className="underline">أدوات المقارنة (مقارنة Excel)</button>.
              <span>لقطات التقارير المعتمدة غير القابلة للتغيير (immutable approved snapshots) مرحلة لاحقة —
              العرض الحالي يقرأ دائمًا من أحدث مراجعة معتمدة ومن الموازنة المعتمدة حصرًا.</span>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
