"use client";

// Phase 6.11 — لوحة التنبيهات والتحليلات الذكية (Smart Alerts & Insights).
// سطح عرض خفيف: عدّ الخطورة + تصفية + رؤى من مصادر يملكها المستخدم أصلًا.
// كل رؤية تُميّز واقعة/تحليل/توصية — والتوصية استشارية لا حكمًا.
// العرض يرث صلاحيات المصدر من الخادم؛ هذه اللوحة لا تمنح أي وصول.

import * as React from "react";
import { BellRing, ChevronLeft, Filter, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCompanyPeriod } from "@/components/reporting/company-period-context";
import { canViewAging, canManageTrialBalances, type Permissions } from "@/lib/permissions";
import { INSIGHT_KIND_LABELS, SEVERITY_LABELS, type AgingSeverity } from "@/lib/aging";
import { INSIGHT_MODULE_LABELS, type UnifiedInsight } from "@/lib/insights";
import { cn } from "@/lib/utils";

const SEVERITY_STYLE: Record<AgingSeverity, string> = {
  INFO: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  ATTENTION: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  IMPORTANT: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
  CRITICAL: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

const SEVERITY_ORDER: AgingSeverity[] = ["CRITICAL", "IMPORTANT", "ATTENTION", "INFO"];

interface InsightsResponse {
  counts: Record<AgingSeverity, number>;
  total: number;
  insights: UnifiedInsight[];
  sources: Record<string, string>;
}

export function InsightsPanel({ perms, role, onNavigate }: {
  perms: Permissions;
  role: string;
  onNavigate: (view: "aging" | "budget" | "trial-balance") => void;
}) {
  const { selectedCompanyId, selectedFiscalYearId } = useCompanyPeriod();
  const [data, setData] = React.useState<InsightsResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [severityFilter, setSeverityFilter] = React.useState<string>("ALL");

  const canView = role === "admin" || perms.viewInsights === true;

  const load = React.useCallback(async () => {
    if (!selectedCompanyId || !canView) { setData(null); return; }
    setLoading(true);
    try {
      const q = new URLSearchParams({ companyId: selectedCompanyId });
      if (selectedFiscalYearId) q.set("fiscalYearId", selectedFiscalYearId);
      const res = await fetch(`/api/insights?${q.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as InsightsResponse;
      setData(body);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [selectedCompanyId, selectedFiscalYearId, canView]);

  React.useEffect(() => { void load(); }, [load]);

  if (!canView) return null; // بلا صلاحية — العنصر لا يُعرض أصلًا (لا وعاء فارغ مضلل)

  const filtered = (data?.insights ?? []).filter((i) => severityFilter === "ALL" || i.severity === severityFilter);
  const shown = filtered.slice(0, 12);

  const moduleTarget = (m: UnifiedInsight["module"]): "aging" | "budget" | "trial-balance" => {
    if (m === "AGING") return "aging";
    if (m === "BUDGET") return "budget";
    return "trial-balance";
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="size-4 text-emerald-600 dark:text-emerald-400" />
          التنبيهات والتحليلات الذكية
        </CardTitle>
        <CardDescription>
          رؤى حتمية من ميزان المراجعة والموازنة والأعمار — واقعة/تحليل/توصية، والفرق المعلن لا يُخفى.
          التوصيات استشارية ولا تُعد حكمًا أو رأي تدقيق.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!selectedCompanyId ? (
          <p className="text-xs text-slate-400">اختر شركة لعرض الرؤى الخاصة بها.</p>
        ) : loading && !data ? (
          <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="size-3.5 animate-spin" />جارٍ جمع الرؤى…</div>
        ) : !data ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-slate-400">تعذّر جلب الرؤى.</p>
            <Button size="sm" variant="outline" onClick={() => void load()} className="gap-1">
              <RefreshCw className="size-3" />إعادة
            </Button>
          </div>
        ) : (
          <>
            {/* عدّ الخطورة + تصفية */}
            <div className="flex flex-wrap items-center gap-2">
              {SEVERITY_ORDER.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverityFilter(severityFilter === s ? "ALL" : s)}
                  aria-pressed={severityFilter === s}
                  className={cn(
                    "flex min-h-[32px] items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-bold transition-colors",
                    severityFilter === s ? "border-slate-400 dark:border-slate-500" : "border-transparent"
                  )}
                >
                  <Badge className={cn("px-1.5 py-0 text-[10px]", SEVERITY_STYLE[s])}>{SEVERITY_LABELS[s].ar}</Badge>
                  <span className="tnum">{data.counts[s] ?? 0}</span>
                </button>
              ))}
              <span className="text-[11px] text-slate-400">الإجمالي: <span className="tnum">{data.total}</span></span>
              <div className="ms-auto flex items-center gap-1.5">
                <Filter className="size-3 text-slate-400" />
                <Select value={severityFilter} onValueChange={setSeverityFilter}>
                  <SelectTrigger aria-label="تصفية حسب الخطورة" className="h-8 w-[150px] text-[11px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">كل الخطورات</SelectItem>
                    {SEVERITY_ORDER.map((s) => (
                      <SelectItem key={s} value={s}>{SEVERITY_LABELS[s].ar}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* الرؤى */}
            {shown.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-center text-xs text-slate-400">
                {severityFilter === "ALL" ? "لا رؤى حالية — البيانات المستوردة تُحلَّل تلقائيًا هنا." : "لا رؤى بهذه الخطورة بعد."}
              </p>
            ) : (
              <ul className="max-h-96 space-y-2 overflow-y-auto pe-1 scroll-thin">
                {shown.map((ins) => (
                  <li key={`${ins.module}-${ins.code}-${ins.titleAr}`} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge className={cn("px-1.5 py-0 text-[10px]", SEVERITY_STYLE[ins.severity])}>
                        {SEVERITY_LABELS[ins.severity]?.ar ?? ins.severity}
                      </Badge>
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{INSIGHT_KIND_LABELS[ins.kind].ar}</Badge>
                      <span className="text-[10px] text-slate-400">{INSIGHT_MODULE_LABELS[ins.module].ar}</span>
                    </div>
                    <p className="mt-1.5 text-xs font-bold text-slate-800 dark:text-slate-100">{ins.titleAr}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">{ins.detailAr}</p>
                    {ins.suggestedActionAr && (
                      <p className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-400">{ins.suggestedActionAr}</p>
                    )}
                    {(canViewAging(perms, role) || canManageTrialBalances(perms, role)) && (
                      <Button
                        size="sm" variant="ghost"
                        className="mt-1 h-7 gap-1 px-2 text-[11px] text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                        onClick={() => onNavigate(moduleTarget(ins.module))}
                      >
                        الانتقال للوحدة <ChevronLeft className="size-3" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {data.total > shown.length && (
              <p className="text-[11px] text-slate-400">تُعرض أول {shown.length} من {data.total} — صفِّ بالخطورة لعرض المزيد.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
