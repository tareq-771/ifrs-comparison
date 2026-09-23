"use client";

// Phase 6.2C — تبويب «تقارير البيانات المحفوظة» (Saved Actual Reporting Engine):
//   تنقل هرمي قابل للتوسع: الشركة → السنة المالية → الفترة → نوع التقرير.
//   - «الفترة الحالية مقابل الفترة السابقة»: الفترة السابقة يحددها النظام تلقائيًا
//     إن وُجدت — لا تُخترع (NO_PREVIOUS_PERIOD صريحة).
//   - «الشهر مقابل التراكمي»: FLOW = حركة الشهر + YTD (بلا جمع ملفات تراكمية)،
//     BALANCE = رصيد إقفال as-of فقط بلا صيغة جمع غير منطقية.
//   كل التقارير تقرأ من ميزان المراجعة المحفوظ — لا رفع Excel لكل تقرير.
//   الحسابات غير المكتملة (INCOMPLETE_DATA / غير مصنفة) تظهر بوضوح — لا صفر صامت.

import * as React from "react";
import { useSession } from "next-auth/react";
import { BarChart3, CheckCircle2, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  MAPPING_STATUS_LABELS,
  type MappingStatus,
} from "@/lib/account-nature";
import { canManageTrialBalances, parsePermissions } from "@/lib/permissions";

interface CompanyOption { id: string; code: string; nameAr: string; status: string; }
interface FiscalYearOption {
  id: string; code: string; displayNameAr: string; startDate: string; endDate: string; status: string; periodCount: number;
  periods: Array<{ id: string; ordinal: number; startDate: string; endDate: string; displayLabel: string; status: string }>;
}
type ReportType = "PERIOD_COMPARISON" | "MONTH_VS_CUMULATIVE" | "PROFIT_OR_LOSS" | "FINANCIAL_POSITION";

interface ComparisonRow {
  accountCode: string; accountName: string; mainCategory: string | null; classification: string | null;
  aggregationBehavior: string | null; statementLineCode: string | null; mappingStatus: string | null;
  currentStatus: string; currentMinor: string | null; previousStatus: string; previousMinor: string | null;
  varianceMinor: string | null; variancePct: string | null;
}
interface ComparisonResult {
  company: { code: string; nameAr: string };
  fiscalYear: { code: string; startDate: string; endDate: string };
  currentPeriod: { ordinal: number; startDate: string; endDate: string; displayLabel: string };
  previousPeriod: { ordinal: number; startDate: string; endDate: string; displayLabel: string } | null;
  rows: ComparisonRow[];
  summary: { total: number; currentComplete: number; currentIncomplete: number; unclassifiedAccounts: number };
}
interface MvcRow {
  accountCode: string; accountName: string; mainCategory: string | null; classification: string | null;
  aggregationBehavior: string | null; statementLineCode: string | null; mappingStatus: string | null;
  monthStatus: string; monthMinor: string | null; ytdStatus: string; ytdMinor: string | null;
}
interface MvcResult {
  company: { code: string; nameAr: string };
  fiscalYear: { code: string; startDate: string; endDate: string };
  period: { ordinal: number; startDate: string; endDate: string; displayLabel: string };
  rows: MvcRow[];
  summary: { total: number; complete: number; incomplete: number; unclassifiedAccounts: number };
}
interface StmtRow {
  kind: string; key: string; label: string; statementLineCode: string | null;
  valueMinor: string | null; valueStatus: string; previousValueMinor?: string | null; depth: number;
}
interface StmtSection { key: string; title: string; rows: StmtRow[]; totalMinor: string; }
interface PnlStmt {
  kind: string;
  revenue: StmtSection; expenses: StmtSection; netResultMinor: string;
  oci: { section: StmtSection; totalMinor: string } | null; ociStatus: string;
  totalComprehensiveIncomeMinor: string;
  completeness: { ready: boolean; incompleteAccounts: Array<{ accountCode: string; accountName: string; mappingStatus: string; valueMinor: string | null }> };
}
interface SfpStmt {
  kind: string;
  assets: StmtSection; liabilities: StmtSection; equity: StmtSection;
  netResultRowMinor: string | null; netResultRowStatus: string;
  equation: { assetsMinor: string; liabilitiesPlusEquityMinor: string; differenceMinor: string; balanced: boolean };
  unclassified: { rows: Array<{ accountCode: string; accountName: string; valueMinor: string | null }>; totalMinor: string };
  completeness: { ready: boolean; incompleteAccounts: Array<{ accountCode: string; accountName: string; mappingStatus: string; valueMinor: string | null }> };
}
interface StatementsResult {
  company: { code: string; nameAr: string; currency: string | null; currencyLabel: string | null };
  fiscalYear: { code: string; displayNameAr: string; startDate: string; endDate: string };
  period: { ordinal: number; startDate: string; endDate: string; displayLabel: string };
  basis: string;
  header: { systemName: string; pnl: { title: string; periodLabel: string }; sfp: { title: string; periodLabel: string } };
  profitOrLoss: PnlStmt;
  financialPosition: SfpStmt;
}

function fmtMinor(minor: string | null, minorUnits = 2): string {
  if (minor === null) return "—";
  const neg = minor.startsWith("-");
  const abs = (neg ? minor.slice(1) : minor).padStart(minorUnits + 1, "0");
  const int = abs.slice(0, abs.length - minorUnits);
  const frac = minorUnits > 0 ? abs.slice(abs.length - minorUnits) : "";
  return `${neg ? "(" : ""}${Number(int).toLocaleString("en-US")}${minorUnits > 0 ? `.${frac}` : ""}${neg ? ")" : ""}`;
}

const BEHAVIOR_LABEL: Record<string, string> = {
  FLOW: "حركة (FLOW)",
  BALANCE: "رصيد (BALANCE)",
};


/* ════════════════════ مكونات عرض القوائم (6.2D) ════════════════════ */

function StmtRowView({ row, comparative }: { row: StmtRow; comparative: boolean }) {
  const bold = row.kind === "TOTAL" || row.kind === "GRAND_TOTAL" || row.kind === "NET_RESULT";
  const cls = bold ? "font-semibold" : "";
  const neg = row.valueMinor?.startsWith("-") ?? false;
  return (
    <TableRow className={bold ? "bg-muted/50" : undefined}>
      <TableCell className={"text-sm " + cls} style={{ paddingInlineStart: `${row.depth * 18 + 12}px` }}>
        {row.label}
        {row.kind === "ACCOUNT_GROUP" ? null : null}
      </TableCell>
      <TableCell className={"font-mono text-xs " + cls} dir="ltr">
        {row.valueStatus !== "OK" ? <span className="text-amber-600">غير متاح</span> : `${neg ? "(" : ""}${fmtMinor(neg ? row.valueMinor!.slice(1) : row.valueMinor)}${neg ? ")" : ""}`}
      </TableCell>
      {comparative && (
        <TableCell className="font-mono text-xs text-muted-foreground" dir="ltr">
          {row.previousValueMinor ? fmtMinor(row.previousValueMinor) : "—"}
        </TableCell>
      )}
    </TableRow>
  );
}

function CompletenessBanner({ c }: { c: { ready: boolean; incompleteAccounts: Array<{ accountCode: string; accountName: string; mappingStatus: string; valueMinor: string | null }> } }) {
  if (c.ready) {
    return (
      <p className="flex items-center gap-2 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
        <CheckCircle2 className="size-4" />
        جميع الحسابات ذات الأرصدة المادية مصنفة بالكامل — القائمة جاهزة (READY).
      </p>
    );
  }
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
      <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
        <TriangleAlert className="size-4" />
        القائمة غير مكتملة — توجد حسابات تحتاج تصنيفًا ({c.incompleteAccounts.length}) — صنّفها من تبويب «دليل الحسابات وقواعد التصنيف».
      </p>
      <div className="flex flex-wrap gap-1">
        {c.incompleteAccounts.slice(0, 20).map((a) => (
          <Badge key={a.accountCode} variant="outline" className="font-mono text-xs">
            {a.accountCode} — {MAPPING_STATUS_LABELS[a.mappingStatus as MappingStatus] ?? a.mappingStatus}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function PnlStatementView({ s }: { s: StatementsResult }) {
  const p = s.profitOrLoss;
  const comparative = p.revenue.rows.some((r) => r.previousValueMinor !== undefined);
  const sec = (title: string, section: StmtSection) => (
    <div className="space-y-1">
      <p className="text-sm font-semibold">{title}</p>
      <Table>
        <TableBody>
          {section.rows.map((r) => <StmtRowView key={r.key} row={r} comparative={comparative} />)}
        </TableBody>
      </Table>
    </div>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{s.header.pnl.title} — {s.company.nameAr}</CardTitle>
        <CardDescription>
          {s.header.systemName} · {s.fiscalYear.code} · {s.header.pnl.periodLabel}
          {s.company.currency ? ` · ${s.company.currency} (${s.company.currencyLabel})` : ""}
          {s.basis === "YTD" ? " · أساس: تراكمي من بداية السنة" : " · أساس: حركة الفترة"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CompletenessBanner c={p.completeness} />
        {sec("الإيرادات", p.revenue)}
        {sec("المصروفات", p.expenses)}
        <Table>
          <TableBody>
            <TableRow className="bg-emerald-50 dark:bg-emerald-950/30">
              <TableCell className="font-bold text-sm">صافي الربح أو الخسارة</TableCell>
              <TableCell className="font-mono font-bold text-xs" dir="ltr">{fmtMinor(p.netResultMinor)}</TableCell>
              {comparative && <TableCell />}
            </TableRow>
          </TableBody>
        </Table>
        {p.oci ? (
          sec("الدخل الشامل الآخر", p.oci.section)
        ) : (
          <p className="text-xs text-muted-foreground">
            الدخل الشامل الآخر: لا توجد حسابات مرتبطة ببنود OCI في البيانات الحالية — لا يُختلق قسم فارغ كبيان مؤكد.
          </p>
        )}
        <Table>
          <TableBody>
            <TableRow className="bg-muted">
              <TableCell className="font-bold text-sm">إجمالي الدخل الشامل</TableCell>
              <TableCell className="font-mono font-bold text-xs" dir="ltr">{fmtMinor(p.totalComprehensiveIncomeMinor)}</TableCell>
              {comparative && <TableCell />}
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SfpStatementView({ s }: { s: StatementsResult }) {
  const f = s.financialPosition;
  const sec = (title: string, section: StmtSection) => (
    <div className="space-y-1">
      <p className="text-sm font-semibold">{title}</p>
      <Table>
        <TableBody>
          {section.rows.map((r) => <StmtRowView key={r.key} row={{ ...r, previousValueMinor: undefined }} comparative={false} />)}
        </TableBody>
      </Table>
    </div>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{s.header.sfp.title} — {s.company.nameAr}</CardTitle>
        <CardDescription>
          {s.header.systemName} · {s.fiscalYear.code} · {s.header.sfp.periodLabel}
          {s.company.currency ? ` · ${s.company.currency} (${s.company.currencyLabel})` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CompletenessBanner c={f.completeness} />
        {sec("الأصول", f.assets)}
        {sec("الالتزامات", f.liabilities)}
        {sec("حقوق الملكية", f.equity)}
        {f.unclassified.rows.length > 0 && (
          <div className="rounded-md border p-3">
            <p className="mb-2 text-sm font-semibold text-rose-700">حسابات غير مصنفة (خارج أقسام القائمة — تفسّر جزءًا من فرق المعادلة):</p>
            <Table>
              <TableBody>
                {f.unclassified.rows.map((a) => (
                  <TableRow key={a.accountCode}>
                    <TableCell className="font-mono text-xs">{a.accountCode} — {a.accountName}</TableCell>
                    <TableCell className="font-mono text-xs" dir="ltr">{a.valueMinor === null ? "غير متاح" : fmtMinor(a.valueMinor)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <div className={"rounded-md border p-3 text-sm " + (f.equation.balanced ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300")}>
          <p className="font-semibold">
            تحقق المعادلة المحاسبية: الأصول = الالتزامات + حقوق الملكية
            {f.equation.balanced ? " — متوازنة ✓" : " — يوجد فرق (تحذير — لا يُصحح تلقائيًا)"}
          </p>
          <p className="font-mono text-xs mt-1" dir="ltr">
            Assets {fmtMinor(f.equation.assetsMinor)} vs L+E {fmtMinor(f.equation.liabilitiesPlusEquityMinor)} — Δ {fmtMinor(f.equation.differenceMinor)}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function SavedReportsTab() {
  const { data: session } = useSession();
  const { toast } = useToast();

  const perms = React.useMemo(() => {
    if (!session?.user) return null;
    const raw = (session.user as any).permissions;
    if (typeof raw === "string") return parsePermissions(raw);
    if (raw && typeof raw === "object") return parsePermissions(JSON.stringify(raw));
    return null;
  }, [session]);
  const role = ((session?.user as any)?.role as string) || "user";
  const canView = perms ? canManageTrialBalances(perms, role) : false;

  const [companies, setCompanies] = React.useState<CompanyOption[]>([]);
  const [companyId, setCompanyId] = React.useState("");
  const [fiscalYears, setFiscalYears] = React.useState<FiscalYearOption[]>([]);
  const [fiscalYearId, setFiscalYearId] = React.useState("");
  const [ordinal, setOrdinal] = React.useState("");
  const [reportType, setReportType] = React.useState<ReportType>("PERIOD_COMPARISON");
  const [comparison, setComparison] = React.useState<ComparisonResult | null>(null);
  const [mvc, setMvc] = React.useState<MvcResult | null>(null);
  const [statements, setStatements] = React.useState<StatementsResult | null>(null);
  const [basis, setBasis] = React.useState<"YTD" | "PERIOD">("YTD");
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      const res = await fetch("/api/companies", { cache: "no-store" });
      if (res.ok) {
        const list: CompanyOption[] = await res.json().catch(() => []);
        setCompanies(list);
        setCompanyId((prev) => (prev && list.some((c) => c.id === prev) ? prev : list[0]?.id ?? ""));
      }
    })();
  }, []);

  React.useEffect(() => {
    setFiscalYears([]); setFiscalYearId(""); setOrdinal(""); setComparison(null); setMvc(null);
    if (!companyId) return;
    (async () => {
      const res = await fetch(`/api/fiscal-years?companyId=${encodeURIComponent(companyId)}`, { cache: "no-store" });
      if (res.ok) {
        const list: FiscalYearOption[] = await res.json().catch(() => []);
        setFiscalYears(list);
        setFiscalYearId(list[0]?.id ?? "");
      }
    })();
  }, [companyId]);

  React.useEffect(() => {
    setOrdinal(""); setComparison(null); setMvc(null); setStatements(null);
  }, [fiscalYearId]);

  const runReport = async () => {
    if (!companyId || !fiscalYearId || !ordinal) return;
    setLoading(true);
    setComparison(null);
    setMvc(null);
    setStatements(null);
    try {
      if (reportType === "PERIOD_COMPARISON") {
        const res = await fetch("/api/reports/actual/period-comparison", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId, fiscalYearId, currentOrdinal: Number(ordinal) }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        setComparison(data);
      } else if (reportType === "MONTH_VS_CUMULATIVE") {
        const res = await fetch("/api/reports/actual/month-vs-cumulative", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId, fiscalYearId, ordinal: Number(ordinal) }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        setMvc(data);
      } else {
        const res = await fetch("/api/reports/actual/statements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId, fiscalYearId, ordinal: Number(ordinal), basis }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        setStatements(data);
      }
    } catch (e) {
      toast({ title: "فشل التقرير", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const fy = fiscalYears.find((f) => f.id === fiscalYearId) ?? null;
  const periodLabel = (o: number) => fy?.periods.find((p) => p.ordinal === o)?.displayLabel ?? `فترة ${o}`;

  return (
    <div className="space-y-6" dir="rtl">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="size-4" />
              تقارير البيانات المحفوظة
            </CardTitle>
            <CardDescription>
              تُبنى التقارير من ميزان المراجعة المحفوظ مباشرة — لا رفع ملف لكل تقرير.
              التنقل: الشركة → السنة المالية → الفترة → نوع التقرير.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => canView && runReport()} aria-label="تحديث التقرير" disabled={loading || !ordinal}>
            <RefreshCw className={"size-3.5" + (loading ? " animate-spin" : "")} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-5 md:items-end">
            <div className="space-y-1.5">
              <Label>الشركة</Label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger aria-label="الشركة"><SelectValue placeholder="اختر شركة" /></SelectTrigger>
                <SelectContent>
                  {companies.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} — {c.nameAr}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>السنة المالية</Label>
              <Select value={fiscalYearId} onValueChange={setFiscalYearId} disabled={!companyId}>
                <SelectTrigger aria-label="السنة المالية"><SelectValue placeholder="اختر سنة" /></SelectTrigger>
                <SelectContent>
                  {fiscalYears.map((f) => <SelectItem key={f.id} value={f.id}>{f.code} ({f.startDate} → {f.endDate})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>الفترة</Label>
              <Select value={ordinal} onValueChange={setOrdinal} disabled={!fy}>
                <SelectTrigger aria-label="الفترة"><SelectValue placeholder="اختر فترة" /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {(fy?.periods ?? []).map((p) => (
                    <SelectItem key={p.id} value={String(p.ordinal)}>{p.ordinal}: {p.displayLabel || p.startDate}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>أساس القائمة</Label>
              <Select value={basis} onValueChange={(v) => setBasis(v as "YTD" | "PERIOD")} disabled={reportType !== "PROFIT_OR_LOSS"}>
                <SelectTrigger aria-label="أساس القائمة"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="YTD">تراكمي (YTD)</SelectItem>
                  <SelectItem value="PERIOD">حركة الفترة</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>نوع التقرير</Label>
              <Select value={reportType} onValueChange={(v) => setReportType(v as ReportType)}>
                <SelectTrigger aria-label="نوع التقرير"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PERIOD_COMPARISON">الفترة الحالية مقابل السابقة</SelectItem>
                  <SelectItem value="MONTH_VS_CUMULATIVE">الشهر مقابل التراكمي</SelectItem>
                  <SelectItem value="PROFIT_OR_LOSS">قائمة الربح أو الخسارة</SelectItem>
                  <SelectItem value="FINANCIAL_POSITION">قائمة المركز المالي</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={runReport} disabled={loading || !companyId || !fiscalYearId || !ordinal || !canView}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <BarChart3 className="size-4" />}
              عرض التقرير
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── تقرير مقارنة الفترات ── */}
      {comparison && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">الفترة الحالية مقابل الفترة السابقة</CardTitle>
            <CardDescription>
              {comparison.company.code} — {comparison.fiscalYear.code} ({comparison.fiscalYear.startDate} → {comparison.fiscalYear.endDate}) —
              الحالية: فترة {comparison.currentPeriod.ordinal} ({comparison.currentPeriod.startDate} → {comparison.currentPeriod.endDate})
              {" — "}السابقة: {comparison.previousPeriod ? `فترة ${comparison.previousPeriod.ordinal} (${comparison.previousPeriod.startDate} → ${comparison.previousPeriod.endDate})` : "لا توجد فترة سابقة في نفس السنة المالية"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">الحسابات: {comparison.summary.total}</Badge>
              <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">حالية مكتملة: {comparison.summary.currentComplete}</Badge>
              <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">حالية ناقصة: {comparison.summary.currentIncomplete}</Badge>
              <Badge className="bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">غير مصنفة: {comparison.summary.unclassifiedAccounts}</Badge>
            </div>
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">الحساب</TableHead>
                    <TableHead className="text-right">السلوك</TableHead>
                    <TableHead className="text-left">الحالية</TableHead>
                    <TableHead className="text-left">السابقة</TableHead>
                    <TableHead className="text-left">الفرق</TableHead>
                    <TableHead className="text-left">الفرق %</TableHead>
                    <TableHead className="text-right">الحالة</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {comparison.rows.map((r) => (
                    <TableRow key={r.accountCode} className={r.currentStatus !== "OK" || r.previousStatus === "INCOMPLETE_DATA" ? "bg-amber-50/60 dark:bg-amber-950/20" : undefined}>
                      <TableCell className="text-sm"><span className="font-mono">{r.accountCode}</span> — {r.accountName || "—"}</TableCell>
                      <TableCell className="text-xs">{BEHAVIOR_LABEL[r.aggregationBehavior ?? ""] ?? r.aggregationBehavior ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">{fmtMinor(r.currentMinor)}{r.currentStatus !== "OK" ? " (ناقصة)" : ""}</TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">{fmtMinor(r.previousMinor)}{r.previousStatus === "NO_PREVIOUS_PERIOD" ? " (لا سابقة)" : r.previousStatus !== "OK" ? " (ناقصة)" : ""}</TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">{fmtMinor(r.varianceMinor)}</TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">{r.variancePct ? `${r.variancePct}%` : "—"}</TableCell>
                      <TableCell className="text-xs">{r.mappingStatus ? (MAPPING_STATUS_LABELS[r.mappingStatus as MappingStatus] ?? r.mappingStatus) : "—"}</TableCell>
                    </TableRow>
                  ))}
                  {comparison.rows.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="h-16 text-center text-sm text-muted-foreground">لا بيانات معتمدة لهذه الفترة — ارفع واعتمد ميزان المراجعة أولًا.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── تقرير الشهر مقابل التراكمي ── */}
      {mvc && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">الشهر مقابل التراكمي</CardTitle>
            <CardDescription>
              {mvc.company.code} — {mvc.fiscalYear.code} — فترة {mvc.period.ordinal} ({mvc.period.startDate} → {mvc.period.endDate}).
              حسابات الأرصدة (BALANCE) تُعرض كرصيد إقفال حتى نهاية الفترة (As-of) — لا تُجمع الأرصدة أبدًا.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">الحسابات: {mvc.summary.total}</Badge>
              <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">مكتملة: {mvc.summary.complete}</Badge>
              <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">ناقصة: {mvc.summary.incomplete}</Badge>
              <Badge className="bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">غير مصنفة: {mvc.summary.unclassifiedAccounts}</Badge>
            </div>
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">الحساب</TableHead>
                    <TableHead className="text-right">السلوك</TableHead>
                    <TableHead className="text-left">الشهر / الحالية</TableHead>
                    <TableHead className="text-left">التراكمي / As-of</TableHead>
                    <TableHead className="text-right">الحالة</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mvc.rows.map((r) => (
                    <TableRow key={r.accountCode} className={r.monthStatus !== "OK" || r.ytdStatus !== "OK" ? "bg-amber-50/60 dark:bg-amber-950/20" : undefined}>
                      <TableCell className="text-sm"><span className="font-mono">{r.accountCode}</span> — {r.accountName || "—"}</TableCell>
                      <TableCell className="text-xs">{BEHAVIOR_LABEL[r.aggregationBehavior ?? ""] ?? r.aggregationBehavior ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">
                        {r.aggregationBehavior === "BALANCE" ? <span className="text-muted-foreground">—</span> : fmtMinor(r.monthMinor)}
                        {r.monthStatus === "INCOMPLETE_DATA" ? " (ناقصة)" : ""}
                      </TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">{fmtMinor(r.ytdMinor)}{r.ytdStatus === "INCOMPLETE_DATA" ? " (ناقصة)" : ""}</TableCell>
                      <TableCell className="text-xs">{r.mappingStatus ? (MAPPING_STATUS_LABELS[r.mappingStatus as MappingStatus] ?? r.mappingStatus) : "—"}</TableCell>
                    </TableRow>
                  ))}
                  {mvc.rows.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="h-16 text-center text-sm text-muted-foreground">لا بيانات معتمدة لهذه الفترة.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── القوائم المالية (6.2D) ── */}
      {statements && <PnlStatementView s={statements} />}
      {statements && <SfpStatementView s={statements} />}
    </div>
  );
}
