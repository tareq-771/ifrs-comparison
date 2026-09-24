"use client";

// 6.7 — لوحة المعلومات: نقطة البداية بعد الدخول — حالة التقارير والاختصارات حسب الصلاحيات.
// كل الأرقام من APIs/الخدمات الحالية — بلا حسابات داخل الواجهة وبلا أرقام مختلقة.

import * as React from "react";
import Link from "next/link";
import {
  Activity, AlertTriangle, BadgeCheck, Building2, ChevronLeft, FileBarChart, FolderKanban,
  Landmark, Layers, Loader2, RefreshCw, Scale, Settings2, Target, TrendingUp, Wallet, Ban,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useCompanyPeriod } from "@/components/reporting/company-period-context";
import { TB_STATUS_LABELS, TB_STATUSES } from "@/lib/trial-balance";
import type { Permissions } from "@/lib/permissions";
import { canManageTrialBalances } from "@/lib/permissions";

export type HomeView = "dashboard" | "trial-balance" | "statements" | "budget" | "aging" | "consolidation" | "compare" | "reports";

interface TrialBalanceSummary {
  id: string;
  status: string;
  fromDate: string;
  toDate: string;
  dataType: string;
  revisionNumber: number;
  lineCount: number;
  totalDebitMinor: string;
  totalCreditMinor: string;
  committedAt: string | null;
  createdAt: string;
}

interface BudgetRow {
  id: string;
  status: string;
  versionNumber: number;
  scenario: string;
  budgetType: string;
  fiscalYearId: string;
  companyId: string;
}

interface ConsolidationGroupRow {
  id: string;
  code: string;
  nameAr: string;
  status: string;
  memberCount: number;
}

const dateFmt = new Intl.DateTimeFormat("ar", { dateStyle: "medium", numberingSystem: "latn" });

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return dateFmt.format(d);
  } catch {
    return iso;
  }
}

export function DashboardView({ onNavigate, perms, role }: {
  onNavigate: (view: HomeView) => void;
  perms: Permissions;
  role: string;
}) {
  const {
    companies, companiesLoading, companiesError, reloadCompanies,
    selectedCompanyId, setSelectedCompanyId, selectedCompany,
    fiscalYears, fiscalYearsLoading, selectedFiscalYear, selectedFiscalYearId, setSelectedFiscalYearId,
  } = useCompanyPeriod();

  const [tbList, setTbList] = React.useState<TrialBalanceSummary[] | null>(null);
  const [tbLoading, setTbLoading] = React.useState(false);
  const [unclassified, setUnclassified] = React.useState<number | null>(null);
  const [budgets, setBudgets] = React.useState<BudgetRow[] | null>(null);
  const [budgetsLoading, setBudgetsLoading] = React.useState(false);
  const [groups, setGroups] = React.useState<ConsolidationGroupRow[] | null>(null);
  const [groupsLoading, setGroupsLoading] = React.useState(false);

  const canTB = canManageTrialBalances(perms, role);

  // ميزان المراجعة — آخر الاستيرادات للشركة المختارة
  React.useEffect(() => {
    if (!selectedCompanyId || !canTB) { setTbList(null); setUnclassified(null); return; }
    let cancelled = false;
    (async () => {
      setTbLoading(true);
      try {
        const res = await fetch(`/api/trial-balances?companyId=${encodeURIComponent(selectedCompanyId)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = (await res.json()) as TrialBalanceSummary[];
        if (cancelled) return;
        setTbList(rows);
        const latestCommitted = rows.filter((r) => r.status === TB_STATUSES.COMMITTED)
          .sort((a, b) => (b.committedAt ?? "").localeCompare(a.committedAt ?? ""))[0]
          ?? rows.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
        if (latestCommitted) {
          const det = await fetch(`/api/trial-balances/${latestCommitted.id}`, { cache: "no-store" });
          if (det.ok && !cancelled) {
            const dto = (await det.json()) as { lines?: Array<{ mappingStatus?: string }>; mapping?: { needsClassification?: number } };
            if (typeof dto.mapping?.needsClassification === "number") {
              setUnclassified(dto.mapping.needsClassification);
            } else if (Array.isArray(dto.lines)) {
              setUnclassified(dto.lines.filter((l) => l.mappingStatus === "NEEDS_CLASSIFICATION" || l.mappingStatus === "NEEDS_DETAILED_CLASSIFICATION").length);
            } else {
              setUnclassified(null);
            }
          } else if (!cancelled) setUnclassified(null);
        } else if (!cancelled) setUnclassified(null);
      } catch {
        if (!cancelled) setTbList(null);
      } finally {
        if (!cancelled) setTbLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedCompanyId, canTB]);

  // الموازنات
  React.useEffect(() => {
    if (!selectedCompanyId) { setBudgets(null); return; }
    let cancelled = false;
    (async () => {
      setBudgetsLoading(true);
      try {
        const res = await fetch("/api/budgets", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = (await res.json()) as BudgetRow[];
        if (!cancelled) setBudgets(rows.filter((b) => b.companyId === selectedCompanyId));
      } catch {
        if (!cancelled) setBudgets(null);
      } finally {
        if (!cancelled) setBudgetsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedCompanyId]);

  // مجموعات التوحيد
  React.useEffect(() => {
    if (!canTB) { setGroups(null); return; }
    let cancelled = false;
    (async () => {
      setGroupsLoading(true);
      try {
        const res = await fetch("/api/consolidation/groups", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = (await res.json()) as ConsolidationGroupRow[];
        if (!cancelled) setGroups(rows);
      } catch {
        if (!cancelled) setGroups(null);
      } finally {
        if (!cancelled) setGroupsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canTB]);

  const latestCommitted = React.useMemo(
    () => (tbList ?? []).filter((r) => r.status === TB_STATUSES.COMMITTED)
      .sort((a, b) => (b.committedAt ?? "").localeCompare(a.committedAt ?? ""))[0] ?? null,
    [tbList]
  );
  const openDrafts = React.useMemo(() => (tbList ?? []).filter((r) => r.status !== TB_STATUSES.COMMITTED).length, [tbList]);
  const budgetCounts = React.useMemo(() => {
    const rows = budgets ?? [];
    return {
      total: rows.length,
      draft: rows.filter((b) => b.status === "DRAFT").length,
      submitted: rows.filter((b) => b.status === "SUBMITTED").length,
      approved: rows.filter((b) => b.status === "APPROVED").length,
      locked: rows.filter((b) => b.status === "LOCKED").length,
      forYear: rows.filter((b) => !selectedFiscalYearId || b.fiscalYearId === selectedFiscalYearId).length,
    };
  }, [budgets, selectedFiscalYearId]);

  return (
    <div className="space-y-6">
      {/* اختيار الشركة/السنة */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4 text-emerald-600 dark:text-emerald-400" />
            السياق الحالي — الشركة والسنة المالية
          </CardTitle>
          <CardDescription>
            المسار الوظيفي: الشركة ← السنة/الفترة ← ميزان المراجعة ← القوائم المالية ← الموازنة والمقارنات ← التقارير الموحدة
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">الشركة</label>
            {companiesLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : companiesError ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/20 dark:text-rose-400">
                <span className="flex items-center gap-1.5"><AlertTriangle className="size-3.5" />{companiesError}</span>
                <Button size="sm" variant="outline" onClick={() => void reloadCompanies()}><RefreshCw className="size-3" />إعادة</Button>
              </div>
            ) : companies.length === 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
                لا توجد شركات متاحة لحسابك. تواصل مع مدير النظام لمنحك نطاق شركات (company scope).
              </div>
            ) : (
              <Select value={selectedCompanyId ?? ""} onValueChange={(v) => setSelectedCompanyId(v)}>
                <SelectTrigger className="w-full" aria-label="اختيار الشركة"><SelectValue placeholder="اختر الشركة" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="tnum">{c.code}</span> — {c.nameAr}
                      {c.status !== "ACTIVE" && <Badge variant="outline" className="ms-2 px-1 py-0 text-[9px]">غير نشطة</Badge>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">السنة المالية</label>
            {!selectedCompanyId ? (
              <div className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-400 dark:border-slate-800">اختر شركة أولًا</div>
            ) : fiscalYearsLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : fiscalYears.length === 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
                لا سنوات مالية معرّفة لهذه الشركة — تُنشأ من <Link className="underline" href="/admin?tab=foundation">إدارة الشركات</Link>.
              </div>
            ) : (
              <Select value={selectedFiscalYearId ?? ""} onValueChange={(v) => setSelectedFiscalYearId(v)}>
                <SelectTrigger className="w-full" aria-label="اختيار السنة المالية"><SelectValue placeholder="اختر السنة" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {fiscalYears.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      <span className="tnum">{f.code}</span> — {f.displayNameAr}{" "}
                      <Badge variant="outline" className="ms-1 px-1 py-0 text-[9px]">{f.status}</Badge>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardContent>
      </Card>

      {/* حالة المختارات */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Scale className="size-4 text-emerald-600 dark:text-emerald-400" />آخر ميزان مراجعة</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-600 dark:text-slate-300">
            {tbLoading ? (
              <div className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" />جارٍ التحميل…</div>
            ) : !canTB ? (
              <p className="flex items-center gap-1.5 text-slate-400"><Ban className="size-3.5" />لا تملك صلاحية ميزان المراجعة</p>
            ) : !selectedCompanyId ? (
              <p className="text-slate-400">اختر شركة</p>
            ) : latestCommitted ? (
              <div className="space-y-1">
                <p className="flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-400">
                  <BadgeCheck className="size-3.5" />معتمد — {TB_STATUS_LABELS[latestCommitted.status] ?? latestCommitted.status}
                </p>
                <p className="tnum">{fmtDate(latestCommitted.fromDate)} ← {fmtDate(latestCommitted.toDate)}</p>
                <p className="tnum">{latestCommitted.lineCount} حساب · مراجعة {latestCommitted.revisionNumber}</p>
                {unclassified !== null && unclassified > 0 ? (
                  <p className="flex items-center gap-1.5 font-semibold text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="size-3.5" />{unclassified} حساب يحتاج تصنيفًا
                  </p>
                ) : unclassified === 0 ? (
                  <p className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400"><BadgeCheck className="size-3.5" />كل الحسابات مصنفة</p>
                ) : null}
                {openDrafts > 0 && <p className="text-amber-600 dark:text-amber-400">{openDrafts} مسودة/مراجعة قيد العمل</p>}
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-slate-400">لا يوجد ميزان مراجعة بعد</p>
                {openDrafts > 0 && <p className="text-amber-600 dark:text-amber-400">{openDrafts} مسودة قيد العمل</p>}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><FileBarChart className="size-4 text-emerald-600 dark:text-emerald-400" />القوائم المالية</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-600 dark:text-slate-300">
            {latestCommitted ? (
              <p className="flex items-start gap-1.5">
                <BadgeCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                مصدر البيانات: أحدث مراجعة معتمدة {latestCommitted ? `(${fmtDate(latestCommitted.toDate)})` : ""}
              </p>
            ) : (
              <p className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                لا بيانات معتمدة — تعرض القوائم حالة INCOMPLETE_DATA
              </p>
            )}
            <p className="mt-2 text-slate-400">ربح شامل · مركز مالي · حقوق ملكية · تدفقات نقدية</p>
            <Button size="sm" variant="outline" className="mt-3 gap-1" onClick={() => onNavigate("statements")}>
              عرض القوائم <ChevronLeft className="size-3" />
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Target className="size-4 text-emerald-600 dark:text-emerald-400" />الموازنة</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-600 dark:text-slate-300">
            {budgetsLoading ? (
              <div className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" />جارٍ التحميل…</div>
            ) : budgetCounts.total === 0 ? (
              <p className="text-slate-400">لا موازنات لهذه الشركة</p>
            ) : (
              <div className="grid grid-cols-2 gap-1 tnum">
                <span>الإجمالي: {budgetCounts.total}</span>
                <span>مسودة: {budgetCounts.draft}</span>
                <span>مقدمة: {budgetCounts.submitted}</span>
                <span>معتمدة: {budgetCounts.approved}</span>
                <span>مقفلة: {budgetCounts.locked}</span>
                <span>للسنة المختارة: {budgetCounts.forYear}</span>
              </div>
            )}
            <Button size="sm" variant="outline" className="mt-3 gap-1" onClick={() => onNavigate("budget")}>
              الموازنة والمقارنات <ChevronLeft className="size-3" />
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Layers className="size-4 text-emerald-600 dark:text-emerald-400" />مجموعات التوحيد</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-600 dark:text-slate-300">
            {groupsLoading ? (
              <div className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" />جارٍ التحميل…</div>
            ) : !canTB ? (
              <p className="flex items-center gap-1.5 text-slate-400"><Ban className="size-3.5" />لا تملك صلاحية التقارير الموحدة</p>
            ) : !groups || groups.length === 0 ? (
              <p className="text-slate-400">لا مجموعات توحيد بعد</p>
            ) : (
              <ul className="space-y-1">
                {groups.slice(0, 3).map((g) => (
                  <li key={g.id} className="flex items-center justify-between gap-2">
                    <span className="truncate"><span className="tnum">{g.code}</span> — {g.nameAr}</span>
                    <Badge variant="outline" className="px-1 py-0 text-[9px] tnum">{g.memberCount} شركة</Badge>
                  </li>
                ))}
                {groups.length > 3 && <li className="text-slate-400">+{groups.length - 3} أخرى…</li>}
              </ul>
            )}
            <Button size="sm" variant="outline" className="mt-3 gap-1" onClick={() => onNavigate("consolidation")}>
              التقارير الموحدة <ChevronLeft className="size-3" />
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* اختصارات سريعة */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">اختصارات مباشرة</CardTitle>
          <CardDescription>الوظائف متاحة حسب صلاحياتك — ما لا تملك صلاحيته لا يظهر كزر فعّال</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <ShortcutTile icon={<Scale className="size-5" />} label="استيراد ميزان مراجعة" disabled={!canTB} onClick={() => onNavigate("trial-balance")} />
          <ShortcutTile icon={<Settings2 className="size-5" />} label="إعدادات التصنيف" disabled={!perms.manageAccountNature} href="/admin?tab=nature" />
          <ShortcutTile icon={<FileBarChart className="size-5" />} label="القوائم المالية" onClick={() => onNavigate("statements")} />
          <ShortcutTile icon={<Target className="size-5" />} label="الموازنة" onClick={() => onNavigate("budget")} />
          <ShortcutTile icon={<Layers className="size-5" />} label="التقارير الموحدة" disabled={!canTB} onClick={() => onNavigate("consolidation")} />
          <ShortcutTile icon={<Landmark className="size-5" />} label="الإدارة" disabled={!perms.manageUsers && !perms.manageBackups && !perms.manageCompanies && !perms.manageFiscalYears} href="/admin" />
        </CardContent>
      </Card>

      {/* حالة الشركات المتاحة */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Building2 className="size-4 text-emerald-600 dark:text-emerald-400" />الشركات المتاحة لك</CardTitle>
        </CardHeader>
        <CardContent>
          {companiesLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : companies.length === 0 ? (
            <p className="text-sm text-slate-400">لا شركات ضمن نطاقك — النظام fail-closed ولا يعرض بيانات غير مصرح بها.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {companies.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCompanyId(c.id)}
                  className={cn(
                    "rounded-xl border p-3 text-right transition-colors",
                    selectedCompanyId === c.id
                      ? "border-emerald-400 bg-emerald-50/60 dark:border-emerald-700 dark:bg-emerald-950/20"
                      : "border-slate-200 hover:border-emerald-300 hover:bg-slate-50 dark:border-slate-800 dark:hover:border-emerald-800 dark:hover:bg-slate-900"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-slate-800 dark:text-slate-100">{c.nameAr}</span>
                    {selectedCompanyId === c.id && <Badge className="bg-emerald-600 px-1.5 py-0 text-[9px] text-white">المختارة</Badge>}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    <span className="tnum">{c.code}</span> · {c.functionalCurrency}
                    {c.status !== "ACTIVE" && <span className="ms-1 text-amber-600 dark:text-amber-400">· غير نشطة</span>}
                  </p>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ShortcutTile({ icon, label, onClick, href, disabled }: {
  icon: React.ReactNode; label: string; onClick?: () => void; href?: string; disabled?: boolean;
}) {
  const inner = (
    <>
      <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">{icon}</span>
      <span className="text-xs font-semibold leading-tight text-slate-700 dark:text-slate-200">{label}</span>
    </>
  );
  const cls = cn(
    "flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-xl border p-3 text-center transition-colors",
    disabled
      ? "cursor-not-allowed border-slate-200 opacity-50 dark:border-slate-800"
      : "border-slate-200 hover:border-emerald-400 hover:bg-emerald-50/50 dark:border-slate-800 dark:hover:border-emerald-700 dark:hover:bg-emerald-950/20"
  );
  if (disabled) {
    return <div className={cls} aria-disabled="true" title="غير متاح — لا تملك الصلاحية اللازمة">{inner}</div>;
  }
  if (href) {
    return <Link href={href} className={cls}>{inner}</Link>;
  }
  return <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}
