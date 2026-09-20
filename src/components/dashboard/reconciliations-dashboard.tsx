"use client";

// لوحة متابعة المطابقات — الحاوية الرئيسية (المرحلة 3.5B).
// قراءة 100%: summary/list/facets كلها GET خادمية من نفس predicate الرؤية —
// الإجراءات في الصفوف تستدعي endpoints الحالية فقط (لا منطق Workflow موازٍ).

import * as React from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { KpiCards, type ActiveKpiFilter, type KpiCounts } from "@/components/dashboard/kpi-cards";
import { FiltersBar, EMPTY_FILTERS, type DashboardFacets, type DashboardFilters } from "@/components/dashboard/filters-bar";
import { ReconciliationsTable, type RowActionHandler } from "@/components/dashboard/reconciliations-table";
import type { DashboardRow } from "@/lib/reconciliation";
import type { WorkflowAction } from "@/lib/workflow";

export interface DashboardListResponse {
  success: boolean;
  data: {
    rows: DashboardRow[];
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
    sort: string;
    dir: "asc" | "desc";
    today: string;
  };
}

function buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    sp.set(k, String(v === true ? "true" : v));
  }
  return sp.toString();
}

export function ReconciliationsDashboard({
  onOpenReport,
  reloadKey = 0,
}: {
  /** فتح التقرير في مساحة العمل (بدل route جديد — التطبيق صفحة واحدة). */
  onOpenReport: (id: string) => void;
  /** مفتاح خارجي لإعادة التحديث (عند تغيّر الإسناد من مساحة العمل مثلًا). */
  reloadKey?: number;
}) {
  const { toast } = useToast();

  const [filters, setFiltersState] = React.useState<DashboardFilters>(EMPTY_FILTERS);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const [sort, setSort] = React.useState("updatedAt");
  const [dir, setDir] = React.useState<"asc" | "desc">("desc");

  const [summary, setSummary] = React.useState<KpiCounts | null>(null);
  const [today, setToday] = React.useState<string>("");
  const [list, setList] = React.useState<DashboardListResponse["data"] | null>(null);
  const [facets, setFacets] = React.useState<DashboardFacets | null>(null);
  const [loadingSummary, setLoadingSummary] = React.useState(true);
  const [loadingList, setLoadingList] = React.useState(true);
  const [loadingFacets, setLoadingFacets] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [errorState, setErrorState] = React.useState<string | null>(null);

  // تأخير البحث بالاسم 350ms
  const [qDebounced, setQDebounced] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setQDebounced(filters.q), 350);
    return () => clearTimeout(t);
  }, [filters.q]);

  const setFilters = (f: DashboardFilters) => {
    setFiltersState(f);
    setPage(1); // أي تغيير فلتر يعيد إلى الصفحة الأولى
  };

  const activeKpi: ActiveKpiFilter = {
    stage: filters.stage ?? undefined,
    overdue: filters.overdue === "true" ? "true" : undefined,
    cycleGt1: filters.cycle === ">1" || undefined,
  };
  const applyKpi = (f: ActiveKpiFilter) => {
    setFilters({
      ...filters,
      stage: f.stage ?? null,
      overdue: f.overdue ?? null,
      cycle: f.cycleGt1 ? ">1" : (filters.cycle === ">1" ? null : filters.cycle),
    });
  };

  const listQuery = React.useMemo(
    () =>
      buildQuery({
        page, pageSize, sort, dir,
        q: qDebounced || null,
        groupId: filters.groupId,
        period: filters.period,
        status: filters.status,
        stage: filters.stage,
        preparedById: filters.preparedById,
        reviewedById: filters.reviewedById,
        approvedById: filters.approvedById,
        ownerRole: filters.ownerRole,
        ownerMe: filters.ownerMe ? "true" : null,
        overdue: filters.overdue,
        cycle: filters.cycle,
      }),
    [page, pageSize, sort, dir, qDebounced, filters]
  );

  // summary: فلاتر النطاق فقط (قرار D-8)
  const scopeQuery = React.useMemo(
    () => buildQuery({ groupId: filters.groupId, period: filters.period }),
    [filters.groupId, filters.period]
  );

  const loadSummary = React.useCallback(async () => {
    setLoadingSummary(true);
    try {
      const res = await fetch(`/api/dashboard/summary?${scopeQuery}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "خطأ");
      setSummary(json.data.counts);
      setToday(json.data.today);
      setErrorState(null);
    } catch (e) {
      setErrorState(e instanceof Error ? e.message : "خطأ");
    } finally {
      setLoadingSummary(false);
    }
  }, [scopeQuery]);

  const loadList = React.useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch(`/api/dashboard/reconciliations?${listQuery}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "خطأ");
      setList(json.data);
      setToday(json.data.today);
      setErrorState(null);
    } catch (e) {
      setErrorState(e instanceof Error ? e.message : "خطأ");
    } finally {
      setLoadingList(false);
    }
  }, [listQuery]);

  const loadFacets = React.useCallback(async () => {
    setLoadingFacets(true);
    try {
      const res = await fetch(`/api/dashboard/facets?${scopeQuery}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "خطأ");
      setFacets(json.data);
    } catch {
      setFacets({ periods: [], groups: [], users: { preparers: [], reviewers: [], approvers: [] } });
    } finally {
      setLoadingFacets(false);
    }
  }, [scopeQuery]);

  React.useEffect(() => { void loadSummary(); }, [loadSummary, reloadKey]);
  React.useEffect(() => { void loadList(); }, [loadList, reloadKey]);
  React.useEffect(() => { void loadFacets(); }, [loadFacets, reloadKey]);

  async function refreshAll() {
    setRefreshing(true);
    try {
      await Promise.all([loadSummary(), loadList(), loadFacets()]);
    } finally {
      setRefreshing(false);
    }
  }

  // الإجراءات: نفس endpoints الحالية (POST workflow) — لا منطق موازٍ
  const handleRowAction: RowActionHandler = React.useCallback(
    async (row, action: WorkflowAction, payload) => {
      try {
        const res = await fetch(`/api/reports/${row.id}/workflow`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, version: row.version, ...payload }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast({ title: "تعذر تنفيذ العملية", description: data.error || "خطأ", variant: "destructive" });
          return false;
        }
        toast({
          title: ACTION_TITLES[action] || "تمت العملية",
          description: `«${row.name}» — الحالة الآن: ${data.workflow?.statusLabel ?? ""} · v${data.version ?? ""}`,
        });
        await Promise.all([loadSummary(), loadList()]);
        return true;
      } catch (e) {
        toast({ title: "خطأ", description: e instanceof Error ? e.message : "خطأ", variant: "destructive" });
        return false;
      }
    },
    [loadSummary, loadList, toast]
  );

  function onSort(field: string) {
    if (sort === field) {
      setDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSort(field);
      setDir("desc");
    }
    setPage(1);
  }

  return (
    <div className="space-y-4">
      {/* الرأس */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-extrabold text-slate-800 dark:text-slate-100">لوحة متابعة المطابقات</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            كل الأرقام والصفوف ضمن صلاحياتك — {today && <>يوم الأعمال: <span dir="ltr" className="font-semibold">{today}</span> من الخادم · </>}
            قراءة فقط والإجراءات عبر مساراتها المعتمدة.
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={refreshAll} disabled={refreshing}>
          {refreshing ? <RefreshCw className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          تحديث
        </Button>
      </div>

      {errorState && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
          تعذر تحميل بيانات اللوحة: {errorState}
          <Button variant="ghost" size="sm" className="ms-2 h-7 text-xs text-rose-700 underline" onClick={refreshAll}>
            إعادة المحاولة
          </Button>
        </div>
      )}

      <KpiCards counts={summary} loading={loadingSummary} active={activeKpi} onToggle={applyKpi} />
      <FiltersBar filters={filters} setFilters={setFilters} facets={facets} onClearAll={() => setFilters(EMPTY_FILTERS)} />
      <ReconciliationsTable
        rows={list?.rows ?? []}
        loading={loadingList}
        sort={sort}
        dir={dir}
        onSort={onSort}
        onOpenReport={onOpenReport}
        onAction={handleRowAction}
      />

      {/* الترقيم — خادمي بالكامل */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          الإجمالي: <span className="font-bold tabular-nums">{list?.pagination.total ?? "…"}</span> مطابقة
          {list && list.pagination.total > 0 && (
            <> · صفحة <span className="font-bold tabular-nums">{list.pagination.page}</span> من <span className="font-bold tabular-nums">{list.pagination.totalPages}</span></>
          )}
        </p>
        <div className="flex items-center gap-2">
          <select
            aria-label="عدد الصفوف لكل صفحة"
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-900"
          >
            {[20, 50, 100].map((s) => <option key={s} value={s}>{s} لكل صفحة</option>)}
          </select>
          <Button variant="outline" size="sm" className="h-9" disabled={page <= 1 || loadingList}
            onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="الصفحة السابقة">
            السابق
          </Button>
          <Button variant="outline" size="sm" className="h-9"
            disabled={!list || page >= list.pagination.totalPages || loadingList}
            onClick={() => setPage((p) => p + 1)} aria-label="الصفحة التالية">
            التالي
          </Button>
        </div>
      </div>
    </div>
  );
}

const ACTION_TITLES: Partial<Record<WorkflowAction, string>> = {
  SUBMIT: "تم الإرسال للمراجعة",
  START_REVIEW: "بدأت المراجعة",
  COMPLETE_REVIEW: "أُتمت المراجعة — بانتظار الاعتماد",
  RETURN: "أُرجع للتصحيح",
  APPROVE: "تم الاعتماد",
  RESUME_EDIT: "عاد إلى مسودة",
  REOPEN: "أُعيد فتحه — دورة جديدة",
};
