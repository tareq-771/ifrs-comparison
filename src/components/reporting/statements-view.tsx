"use client";

// 6.7 — القوائم المالية الموحدة: ربح وخسارة + دخل شامل آخر، مركز مالي، تغيرات حقوق الملكية، تدفقات نقدية.
// كل الأرقام من خدمات التقارير المعتمدة (أحدث مراجعة COMMITTED حصرًا) — لا إعادة حساب داخل الواجهة.
// البيانات الناقصة تُعرض كحالة INCOMPLETE_DATA صريحة — لا أصفار صامتة ولا plug.
// الدقة: المبالغ minor كنصوص BigInt عبر lib/money — لا فقد دقة.

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle, ChevronDown, ChevronLeft, FileBarChart, Landmark, Loader2, Scale, TrendingUp, Waves, Info,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatMinor } from "@/lib/money";
import { PrintableReport, PrintButton } from "@/components/reporting/report-print";
import { buildReportHeaderMeta } from "@/lib/report-header";
import { useCompanyPeriod } from "@/components/reporting/company-period-context";
import { canManageTrialBalances, parsePermissions, type Permissions } from "@/lib/permissions";
import { useSession } from "next-auth/react";

/* ── أنواع استجابات الخدمات (نفس DTOs الخادمية حرفيًا) ── */

interface AccountEntry { accountCode: string; accountName: string; valueMinor: string | null; }
interface StatementRowDTO {
  kind: string; key: string; label: string; statementLineCode: string | null;
  valueMinor: string | null; valueStatus: string; previousValueMinor?: string | null;
  depth: number; accounts?: AccountEntry[];
}
interface StatementSection { key: string; title: string; rows: StatementRowDTO[]; totalMinor: string; }
interface MappingCompleteness { ready: boolean; incompleteAccounts: Array<{ accountCode: string; accountName: string; mappingStatus: string; valueMinor: string | null }>; }
interface StatementsResponse {
  company: { code: string; nameAr: string; currency?: string; currencyLabel?: string };
  fiscalYear: { code: string; displayNameAr?: string };
  period: { ordinal?: number; displayLabel?: string; code?: string };
  basis?: string;
  header?: { systemName: string } | null;
  profitOrLoss: {
    revenue: StatementSection; expenses: StatementSection; netResultMinor: string;
    oci: { section: StatementSection; totalMinor: string } | null;
    ociStatus: "NO_DATA" | "PRESENT";
    totalComprehensiveIncomeMinor: string;
    completeness: MappingCompleteness;
  };
  financialPosition: {
    assets: StatementSection; liabilities: StatementSection; equity: StatementSection;
    netResultRowMinor: string | null; netResultRowStatus: string;
    equation: { assetsMinor: string; liabilitiesPlusEquityMinor: string; differenceMinor: string; balanced: boolean };
    unclassified: { rows: AccountEntry[]; totalMinor: string };
    completeness: MappingCompleteness;
  };
}
interface EquityRow {
  componentCode: string; label: string;
  openingMinor: string | null; openingStatus: string;
  closingMinor: string | null; closingStatus: string;
  movementMinor: string | null; movementStatus: string;
  accounts?: AccountEntry[];
}
interface EquityResponse {
  rows: EquityRow[];
  profitOrLossForPeriod: { valueMinor: string | null; status: string; label?: string } | null;
  totals: { openingMinor: string | null; movementsMinor: string | null; closingMinor: string | null; reconciled: boolean };
  status: string;
  unmappedAccounts: Array<{ accountCode: string; accountName: string }>;
}
interface CfLine { lineCode: string; label: string; effectMinor: string | null; effectStatus: string; accounts?: AccountEntry[]; }
interface CfActivity { activity: string; label: string; lines: CfLine[]; netMinor: string | null; netStatus: string; }
interface CashFlowResponse {
  startingMeasure?: { label?: string; valueMinor?: string | null; status?: string } | null;
  operating: CfActivity; investing: CfActivity; financing: CfActivity;
  nonCashDisclosure: Array<{ label: string; effectMinor?: string | null }>;
  netChangeMinor: string | null;
  cashOpeningMinor: string | null; cashOpeningStatus: string;
  cashClosingMinor: string | null; cashClosingStatus: string;
  cashMovementFromCashAccountsMinor: string | null;
  reconciliationDifferenceMinor: string | null;
  reconciled: boolean;
  status: string;
  unclassifiedAccounts: Array<{ accountCode: string; accountName: string; note: string }>;
}

const dateFmt = new Intl.DateTimeFormat("ar", { dateStyle: "medium", numberingSystem: "latn" });

function Money({ value, minorUnits, className }: { value: string | null | undefined; minorUnits: number; className?: string }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-muted-foreground" title="القيمة غير متاحة — بيانات ناقصة">غير متاح</span>;
  }
  return <span className={cn("tnum font-mono", className)} dir="ltr">{formatMinor(value, minorUnits)}</span>;
}

/** صف بند قابل للتوسيع — التفصيل من الحسابات الفعلية التي تعيدها الخدمة (drill-down حقيقي). */
function StmtRowView({ row, minorUnits, showPrevious }: { row: StatementRowDTO; minorUnits: number; showPrevious: boolean }) {
  const [open, setOpen] = React.useState(false);
  const hasAccounts = (row.accounts?.length ?? 0) > 0;
  const incomplete = row.valueStatus !== "OK";
  return (
    <>
      <TableRow className={cn(row.kind === "NET_RESULT" || row.kind === "GRAND_TOTAL" || row.kind === "TOTAL" ? "font-semibold" : undefined)}>
        <TableCell style={{ paddingInlineStart: `${row.depth * 18 + 10}px` }}>
          <div className="flex items-center gap-1">
            {hasAccounts ? (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-label={open ? "إخفاء تفاصيل الحسابات" : "عرض تفاصيل الحسابات"}
                className="flex items-center gap-1 text-left hover:text-emerald-700 dark:hover:text-emerald-400"
              >
                <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
                <span>{row.label}</span>
              </button>
            ) : (
              <span>{row.label}</span>
            )}
          </div>
        </TableCell>
        <TableCell className={cn("text-left", incomplete && "opacity-60")}>
          <Money value={row.valueMinor} minorUnits={minorUnits} />
        </TableCell>
        {showPrevious && (
          <TableCell className="text-left">
            <Money value={row.previousValueMinor ?? null} minorUnits={minorUnits} />
          </TableCell>
        )}
      </TableRow>
      {open && hasAccounts && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={showPrevious ? 3 : 2} className="px-0 py-0">
            <div className="max-h-56 overflow-y-auto px-4 py-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right text-[10px]">كود الحساب</TableHead>
                    <TableHead className="text-right text-[10px]">اسم الحساب</TableHead>
                    <TableHead className="text-left text-[10px]">المبلغ</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(row.accounts ?? []).map((a) => (
                    <TableRow key={a.accountCode}>
                      <TableCell className="font-mono text-[11px]">{a.accountCode}</TableCell>
                      <TableCell className="text-[11px]">{a.accountName || "—"}</TableCell>
                      <TableCell className="text-left text-[11px]"><Money value={a.valueMinor} minorUnits={minorUnits} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function CompletenessBanner({ completeness, hint }: { completeness: MappingCompleteness; hint?: string }) {
  if (completeness.ready) {
    return (
      <p className="flex items-center gap-2 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
        ✓ اكتملت خريطة الحسابات — كل الحسابات ذات قيمة مصنّفة بالكامل.
      </p>
    );
  }
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
      <p className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
        <AlertTriangle className="size-4" />
        بيانات غير مكتملة (INCOMPLETE_DATA) — {completeness.incompleteAccounts.length} حسابًا بقيمة مادية بلا تصنيف كافٍ.
      </p>
      {hint && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{hint}</p>}
      <div className="scroll-thin mt-2 max-h-32 overflow-y-auto">
        <ul className="space-y-0.5 text-[11px] text-amber-800 dark:text-amber-300">
          {completeness.incompleteAccounts.slice(0, 50).map((a) => (
            <li key={a.accountCode} className="flex items-center justify-between gap-2">
              <span><span className="font-mono">{a.accountCode}</span> — {a.accountName || "—"}</span>
              <span>{a.mappingStatus}</span>
            </li>
          ))}
          {completeness.incompleteAccounts.length > 50 && <li>… +{completeness.incompleteAccounts.length - 50}</li>}
        </ul>
      </div>
      <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
        صنّفها من{" "}
        <Link href="/admin?tab=nature" className="underline">دليل الحسابات والتصنيف</Link>{" "}
        ثم أعد التحقق — لا تُكتمل القوائم بصمت.
      </p>
    </div>
  );
}

export function StatementsView() {
  const { toast } = useToast();
  const { data: session } = useSession();
  const {
    companies, companiesLoading, selectedCompanyId, setSelectedCompanyId, selectedCompany,
    fiscalYears, fiscalYearsLoading, selectedFiscalYearId, setSelectedFiscalYearId, selectedFiscalYear,
    minorUnits,
  } = useCompanyPeriod();

  const perms = React.useMemo<Permissions>(() => {
    if (!session?.user) return { ...parsePermissions(null) } as unknown as Permissions;
    const raw = (session.user as { permissions?: unknown }).permissions;
    if (typeof raw === "string") return parsePermissions(raw);
    if (raw && typeof raw === "object") return parsePermissions(JSON.stringify(raw));
    return parsePermissions(null);
  }, [session]);
  const role = ((session?.user as { role?: string } | undefined)?.role) ?? "user";
  const canView = canManageTrialBalances(perms, role);

  const [stmtTab, setStmtTab] = React.useState<"pnl" | "sfp" | "socie" | "cf">("pnl");
  const [ordinal, setOrdinal] = React.useState("");
  const [basis, setBasis] = React.useState<"YTD" | "PERIOD">("YTD");
  const [socieStart, setSocieStart] = React.useState("");
  const [socieEnd, setSocieEnd] = React.useState("");
  const [cfStart, setCfStart] = React.useState("");
  const [cfEnd, setCfEnd] = React.useState("");

  // 6.8 — روابط عميقة من مركز التقارير: ?stmt=socie&ordinal=3&startOrdinal=1&endOrdinal=5
  // تُقرأ مرة عند الترطيب وتُخزَّن في ref — تُستهلك عند توفر فترات السنة (السياق يُحمَّل async).
  const deepLinkRef = React.useRef<{ ordinal?: string; start?: string; end?: string }>({});
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const stmt = q.get("stmt");
    if (stmt === "pnl" || stmt === "sfp" || stmt === "socie" || stmt === "cf") setStmtTab(stmt);
    const o = q.get("ordinal");
    if (o && /^\d+$/.test(o)) deepLinkRef.current.ordinal = o;
    const endO = q.get("endOrdinal");
    if (endO && /^\d+$/.test(endO)) {
      deepLinkRef.current.end = endO;
      const startO = q.get("startOrdinal");
      if (startO && /^\d+$/.test(startO)) deepLinkRef.current.start = startO;
    }
  }, []);

  const [statements, setStatements] = React.useState<StatementsResponse | null>(null);
  const [stmtLoading, setStmtLoading] = React.useState(false);
  const [equity, setEquity] = React.useState<EquityResponse | null>(null);
  const [equityLoading, setEquityLoading] = React.useState(false);
  const [cashflow, setCashflow] = React.useState<CashFlowResponse | null>(null);
  const [cfLoading, setCfLoading] = React.useState(false);

  const periods = selectedFiscalYear?.periods ?? [];

  // 6.8 — بيانات الترويسة الموحدة: تواريخ الفترات من السنة المالية الفعلية (بلا افتراض تقويمي)
  const periodByOrdinal = React.useCallback(
    (o: string) => periods.find((p) => String(p.ordinal) === o) ?? null,
    [periods],
  );

  // تهيئة الفترات عند تغير السنة — تستهلك قيم الرابط العميق عند توفر الفترات أول مرة
  React.useEffect(() => {
    if (periods.length === 0) {
      setOrdinal(""); setSocieStart(""); setSocieEnd(""); setCfStart(""); setCfEnd("");
      return;
    }
    const last = String(periods[periods.length - 1].ordinal);
    const valid = (v: string) => periods.some((x) => String(x.ordinal) === v);
    const dl = deepLinkRef.current;
    setOrdinal((p) => (dl.ordinal && valid(dl.ordinal) ? dl.ordinal : p && valid(p) ? p : last));
    setSocieStart((p) => ((dl.start ?? "1") && valid(dl.start ?? "1") ? dl.start ?? "1" : p && valid(p) ? p : "1"));
    setSocieEnd((p) => (dl.end && valid(dl.end) ? dl.end : p && valid(p) ? p : last));
    setCfStart((p) => ((dl.start ?? "1") && valid(dl.start ?? "1") ? dl.start ?? "1" : p && valid(p) ? p : "1"));
    setCfEnd((p) => (dl.end && valid(dl.end) ? dl.end : p && valid(p) ? p : last));
    // الاستهلاك مرة واحدة بعد التطبيق الأول للفترات
    delete dl.ordinal; delete dl.start; delete dl.end;
  }, [selectedFiscalYearId, periods.length]);

  const loadStatements = React.useCallback(async () => {
    if (!selectedCompanyId || !selectedFiscalYearId || !ordinal) { setStatements(null); return; }
    setStmtLoading(true);
    try {
      const res = await fetch("/api/reports/actual/statements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: selectedCompanyId, fiscalYearId: selectedFiscalYearId, ordinal: Number(ordinal), basis }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setStatements(data);
    } catch (e) {
      setStatements(null);
      toast({ title: "فشل جلب القوائم", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setStmtLoading(false);
    }
  }, [selectedCompanyId, selectedFiscalYearId, ordinal, basis, toast]);

  const loadEquity = React.useCallback(async () => {
    if (!selectedCompanyId || !selectedFiscalYearId || !socieStart || !socieEnd) { setEquity(null); return; }
    setEquityLoading(true);
    try {
      const res = await fetch("/api/reports/actual/equity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: selectedCompanyId, fiscalYearId: selectedFiscalYearId, startOrdinal: Number(socieStart), endOrdinal: Number(socieEnd) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setEquity(data);
    } catch (e) {
      setEquity(null);
      toast({ title: "فشل جلب قائمة حقوق الملكية", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setEquityLoading(false);
    }
  }, [selectedCompanyId, selectedFiscalYearId, socieStart, socieEnd, toast]);

  const loadCashflow = React.useCallback(async () => {
    if (!selectedCompanyId || !selectedFiscalYearId || !cfStart || !cfEnd) { setCashflow(null); return; }
    setCfLoading(true);
    try {
      const res = await fetch("/api/reports/actual/cashflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: selectedCompanyId, fiscalYearId: selectedFiscalYearId, startOrdinal: Number(cfStart), endOrdinal: Number(cfEnd) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setCashflow(data);
    } catch (e) {
      setCashflow(null);
      toast({ title: "فشل جلب قائمة التدفقات", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setCfLoading(false);
    }
  }, [selectedCompanyId, selectedFiscalYearId, cfStart, cfEnd, toast]);

  // تحميل تلقائي للتبويب النشط
  React.useEffect(() => {
    if (stmtTab === "pnl" || stmtTab === "sfp") void loadStatements();
    else if (stmtTab === "socie") void loadEquity();
    else void loadCashflow();
  }, [stmtTab, loadStatements, loadEquity, loadCashflow]);

  const currencyLabel = selectedCompany?.functionalCurrency ?? "";

  return (
    <div className="space-y-6" dir="rtl">
      {/* السياق والمحددات */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileBarChart className="size-4 text-emerald-600 dark:text-emerald-400" />
            القوائم المالية — من المصدر المعتمد حصرًا
          </CardTitle>
          <CardDescription>
            المصدر: أحدث مراجعة معتمدة (COMMITTED) لميزان المراجعة لكل مدى. البيانات الناقصة تُعلن ولا تُخفى.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label>الشركة</Label>
            <Select value={selectedCompanyId ?? ""} onValueChange={setSelectedCompanyId}>
              <SelectTrigger aria-label="الشركة"><SelectValue placeholder={companiesLoading ? "…" : "اختر شركة"} /></SelectTrigger>
              <SelectContent className="max-h-64">
                {companies.map((c) => <SelectItem key={c.id} value={c.id}><span className="tnum">{c.code}</span> — {c.nameAr}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>السنة المالية</Label>
            <Select value={selectedFiscalYearId ?? ""} onValueChange={setSelectedFiscalYearId} disabled={!selectedCompanyId}>
              <SelectTrigger aria-label="السنة المالية"><SelectValue placeholder={fiscalYearsLoading ? "…" : "اختر سنة"} /></SelectTrigger>
              <SelectContent className="max-h-64">
                {fiscalYears.map((f) => <SelectItem key={f.id} value={f.id}><span className="tnum">{f.code}</span> ({f.startDate} → {f.endDate})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {(stmtTab === "pnl" || stmtTab === "sfp") && (
            <div className="space-y-1.5">
              <Label>حتى نهاية الفترة</Label>
              <Select value={ordinal} onValueChange={setOrdinal} disabled={periods.length === 0}>
                <SelectTrigger aria-label="الفترة"><SelectValue placeholder="اختر فترة" /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {periods.map((p) => <SelectItem key={p.id} value={String(p.ordinal)}>{p.ordinal} — {p.displayLabel || p.code}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          {stmtTab === "pnl" && (
            <div className="space-y-1.5">
              <Label>أساس العرض</Label>
              <Select value={basis} onValueChange={(v) => setBasis(v as "YTD" | "PERIOD")}>
                <SelectTrigger aria-label="أساس العرض"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="YTD">تراكمي من بداية السنة (YTD)</SelectItem>
                  <SelectItem value="PERIOD">حركة الفترة فقط</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {stmtTab === "socie" && (
            <div className="grid grid-cols-2 gap-2 sm:col-span-2 lg:col-span-2">
              <div className="space-y-1.5">
                <Label>من فترة</Label>
                <Select value={socieStart} onValueChange={setSocieStart} disabled={periods.length === 0}>
                  <SelectTrigger aria-label="من فترة"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {periods.map((p) => <SelectItem key={p.id} value={String(p.ordinal)}>{p.ordinal} — {p.displayLabel}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>إلى فترة</Label>
                <Select value={socieEnd} onValueChange={setSocieEnd} disabled={periods.length === 0}>
                  <SelectTrigger aria-label="إلى فترة"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {periods.map((p) => <SelectItem key={p.id} value={String(p.ordinal)}>{p.ordinal} — {p.displayLabel}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {stmtTab === "cf" && (
            <div className="grid grid-cols-2 gap-2 sm:col-span-2 lg:col-span-2">
              <div className="space-y-1.5">
                <Label>من فترة</Label>
                <Select value={cfStart} onValueChange={setCfStart} disabled={periods.length === 0}>
                  <SelectTrigger aria-label="من فترة"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {periods.map((p) => <SelectItem key={p.id} value={String(p.ordinal)}>{p.ordinal} — {p.displayLabel}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>إلى فترة</Label>
                <Select value={cfEnd} onValueChange={setCfEnd} disabled={periods.length === 0}>
                  <SelectTrigger aria-label="إلى فترة"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {periods.map((p) => <SelectItem key={p.id} value={String(p.ordinal)}>{p.ordinal} — {p.displayLabel}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {!canView && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            لا تملك صلاحية عرض التقارير الفعلية (manageTrialBalances) — تواصل مع مدير النظام.
          </CardContent>
        </Card>
      )}

      {canView && (
        <Tabs value={stmtTab} onValueChange={(v) => setStmtTab(v as typeof stmtTab)}>
          <TabsList className="flex w-full flex-wrap sm:w-fit">
            <TabsTrigger value="pnl" className="gap-1.5"><TrendingUp className="size-3.5" />ربح وشامل</TabsTrigger>
            <TabsTrigger value="sfp" className="gap-1.5"><Scale className="size-3.5" />المركز المالي</TabsTrigger>
            <TabsTrigger value="socie" className="gap-1.5"><Landmark className="size-3.5" />حقوق الملكية</TabsTrigger>
            <TabsTrigger value="cf" className="gap-1.5"><Waves className="size-3.5" />التدفقات النقدية</TabsTrigger>
          </TabsList>

          {/* ── P&L + OCI ── */}
          <TabsContent value="pnl" className="mt-4 space-y-4">
            {stmtLoading ? (
              <div className="flex items-center gap-2 rounded-lg border p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />جارٍ البناء من المصدر المعتمد…</div>
            ) : !statements ? (
              <EmptyState companyPicked={!!selectedCompanyId && !!selectedFiscalYearId && !!ordinal} />
            ) : (
              <PrintableReport
                orientation="portrait"
                toolbar={<PrintButton orientation="portrait" />}
                meta={buildReportHeaderMeta({
                  companyCode: statements.company.code,
                  companyName: statements.company.nameAr,
                  reportTitle: "قائمة الربح أو الخسارة والدخل الشامل الآخر",
                  fiscalYearCode: statements.fiscalYear.code,
                  fiscalYearLabel: statements.fiscalYear.displayNameAr,
                  periodLabel: `حتى نهاية فترة ${statements.period.ordinal ?? ordinal} — ${statements.period.displayLabel ?? statements.period.code ?? ""}`,
                  fromDate: periodByOrdinal(ordinal)?.startDate ?? null,
                  toDate: periodByOrdinal(ordinal)?.endDate ?? null,
                  currency: currencyLabel,
                  dataType: statements.basis ?? null,
                  status: statements.profitOrLoss.completeness.ready ? "APPROVED" : "INCOMPLETE_DATA",
                })}
              >
                <CompletenessBanner completeness={statements.profitOrLoss.completeness} />
                <Card>
                  <CardContent className="pt-4">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-right">البند</TableHead>
                          <TableHead className="text-left">{currencyLabel}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {statements.profitOrLoss.revenue.rows.map((r) => <StmtRowView key={r.key} row={r} minorUnits={minorUnits} showPrevious={false} />)}
                        <TableRow className="border-t-2 font-bold">
                          <TableCell>إجمالي الإيرادات</TableCell>
                          <TableCell className="text-left"><Money value={statements.profitOrLoss.revenue.totalMinor} minorUnits={minorUnits} /></TableCell>
                        </TableRow>
                        {statements.profitOrLoss.expenses.rows.map((r) => <StmtRowView key={r.key} row={r} minorUnits={minorUnits} showPrevious={false} />)}
                        <TableRow className="border-t-2 font-bold">
                          <TableCell>(إجمالي المصروفات) المعروض بالسالب</TableCell>
                          <TableCell className="text-left"><Money value={statements.profitOrLoss.expenses.totalMinor} minorUnits={minorUnits} /></TableCell>
                        </TableRow>
                        <TableRow className="bg-emerald-50/60 font-extrabold dark:bg-emerald-950/20">
                          <TableCell>صافي الربح أو الخسارة</TableCell>
                          <TableCell className="text-left"><Money value={statements.profitOrLoss.netResultMinor} minorUnits={minorUnits} /></TableCell>
                        </TableRow>
                        {statements.profitOrLoss.oci ? (
                          <>
                            <TableRow className="bg-muted/50"><TableCell colSpan={2} className="text-sm font-bold">الدخل الشامل الآخر (OCI)</TableCell></TableRow>
                            {statements.profitOrLoss.oci.section.rows.map((r) => <StmtRowView key={r.key} row={r} minorUnits={minorUnits} showPrevious={false} />)}
                            <TableRow className="font-semibold">
                              <TableCell>إجمالي الدخل الشامل الآخر</TableCell>
                              <TableCell className="text-left"><Money value={statements.profitOrLoss.oci.totalMinor} minorUnits={minorUnits} /></TableCell>
                            </TableRow>
                          </>
                        ) : (
                          <TableRow>
                            <TableCell colSpan={2} className="text-xs text-muted-foreground">
                              لا بنود دخل شامل آخر مرتبطة بحسابات لهذه الفترة (ociStatus = NO_DATA) — لا يُختلق صفر مؤكد.
                            </TableCell>
                          </TableRow>
                        )}
                        <TableRow className="bg-sky-50/60 font-extrabold dark:bg-sky-950/20">
                          <TableCell>مجموع الدخل الشامل</TableCell>
                          <TableCell className="text-left"><Money value={statements.profitOrLoss.totalComprehensiveIncomeMinor} minorUnits={minorUnits} /></TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </PrintableReport>
            )}
          </TabsContent>

          {/* ── SFP ── */}
          <TabsContent value="sfp" className="mt-4 space-y-4">
            {stmtLoading ? (
              <div className="flex items-center gap-2 rounded-lg border p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />جارٍ البناء…</div>
            ) : !statements ? (
              <EmptyState companyPicked={!!selectedCompanyId && !!selectedFiscalYearId && !!ordinal} />
            ) : (
              <PrintableReport
                orientation="portrait"
                toolbar={<PrintButton orientation="portrait" />}
                meta={buildReportHeaderMeta({
                  companyCode: statements.company.code,
                  companyName: statements.company.nameAr,
                  reportTitle: "قائمة المركز المالي",
                  fiscalYearCode: statements.fiscalYear.code,
                  fiscalYearLabel: statements.fiscalYear.displayNameAr,
                  periodLabel: `حتى نهاية ${statements.period.displayLabel ?? statements.period.code ?? ""}`,
                  fromDate: periodByOrdinal(ordinal)?.startDate ?? null,
                  toDate: periodByOrdinal(ordinal)?.endDate ?? null,
                  currency: currencyLabel,
                  status: statements.financialPosition.completeness.ready ? "APPROVED" : "INCOMPLETE_DATA",
                  statusNotice: !statements.financialPosition.equation.balanced
                    ? `المعادلة المحاسبية غير متوازنة — الفرق ${statements.financialPosition.equation.differenceMinor} minor معروض ولا يُصحح ولا يُخفى.`
                    : null,
                })}
              >
                <CompletenessBanner completeness={statements.financialPosition.completeness} />
                <Card>
                  <CardContent className="pt-4">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-right">البند</TableHead>
                          <TableHead className="text-left">{currencyLabel}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        <TableRow className="bg-muted/50"><TableCell colSpan={2} className="text-sm font-bold">الأصول</TableCell></TableRow>
                        {statements.financialPosition.assets.rows.map((r) => <StmtRowView key={r.key} row={r} minorUnits={minorUnits} showPrevious={false} />)}
                        <TableRow className="border-t-2 font-bold">
                          <TableCell>إجمالي الأصول</TableCell>
                          <TableCell className="text-left"><Money value={statements.financialPosition.equation.assetsMinor} minorUnits={minorUnits} /></TableCell>
                        </TableRow>
                        <TableRow className="bg-muted/50"><TableCell colSpan={2} className="text-sm font-bold">الالتزامات</TableCell></TableRow>
                        {statements.financialPosition.liabilities.rows.map((r) => <StmtRowView key={r.key} row={r} minorUnits={minorUnits} showPrevious={false} />)}
                        <TableRow className="font-bold">
                          <TableCell>إجمالي الالتزامات</TableCell>
                          <TableCell className="text-left"><Money value={statements.financialPosition.liabilities.totalMinor} minorUnits={minorUnits} /></TableCell>
                        </TableRow>
                        <TableRow className="bg-muted/50"><TableCell colSpan={2} className="text-sm font-bold">حقوق الملكية</TableCell></TableRow>
                        {statements.financialPosition.equity.rows.map((r) => <StmtRowView key={r.key} row={r} minorUnits={minorUnits} showPrevious={false} />)}
                        {statements.financialPosition.netResultRowMinor !== null && (
                          <TableRow>
                            <TableCell>صافي نتيجة الفترة (ضمن حقوق الملكية)</TableCell>
                            <TableCell className="text-left"><Money value={statements.financialPosition.netResultRowMinor} minorUnits={minorUnits} /></TableCell>
                          </TableRow>
                        )}
                        <TableRow className="font-bold">
                          <TableCell>إجمالي حقوق الملكية</TableCell>
                          <TableCell className="text-left"><Money value={statements.financialPosition.equity.totalMinor} minorUnits={minorUnits} /></TableCell>
                        </TableRow>
                        <TableRow className="border-t-2 font-extrabold">
                          <TableCell>إجمالي الالتزامات وحقوق الملكية</TableCell>
                          <TableCell className="text-left"><Money value={statements.financialPosition.equation.liabilitiesPlusEquityMinor} minorUnits={minorUnits} /></TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
                <div className={cn("grid gap-2 rounded-lg border p-3 text-sm sm:grid-cols-3", statements.financialPosition.equation.balanced ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20" : "border-rose-300 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/30")}>
                  <p className="flex items-center gap-2 font-semibold sm:col-span-3">
                    {statements.financialPosition.equation.balanced
                      ? "✓ المعادلة المحاسبية متوازنة: الأصول = الالتزامات + حقوق الملكية"
                      : "⚠ المعادلة المحاسبية غير متوازنة — الفرق معروض ولا يُصحح تلقائيًا ولا يُخفى"}
                  </p>
                  <p className="tnum">الأصول: <Money value={statements.financialPosition.equation.assetsMinor} minorUnits={minorUnits} /></p>
                  <p className="tnum">الالتزامات + حقوق الملكية: <Money value={statements.financialPosition.equation.liabilitiesPlusEquityMinor} minorUnits={minorUnits} /></p>
                  <p className="tnum">الفرق: <Money value={statements.financialPosition.equation.differenceMinor} minorUnits={minorUnits} className={statements.financialPosition.equation.balanced ? "" : "font-bold text-rose-700 dark:text-rose-400"} /></p>
                </div>
                {statements.financialPosition.unclassified.rows.length > 0 && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
                    <p className="font-semibold text-amber-800 dark:text-amber-300">حسابات غير مصنفة ضمن المركز المالي: {statements.financialPosition.unclassified.rows.length}</p>
                    <ul className="mt-1 space-y-0.5 text-[11px]">
                      {statements.financialPosition.unclassified.rows.slice(0, 30).map((a) => (
                        <li key={a.accountCode} className="flex items-center justify-between gap-2">
                          <span><span className="font-mono">{a.accountCode}</span> — {a.accountName || "—"}</span>
                          <Money value={a.valueMinor} minorUnits={minorUnits} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </PrintableReport>
            )}
          </TabsContent>

          {/* ── SOCIE ── */}
          <TabsContent value="socie" className="mt-4 space-y-4">
            {equityLoading ? (
              <div className="flex items-center gap-2 rounded-lg border p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />جارٍ البناء…</div>
            ) : !equity ? (
              <EmptyState companyPicked={!!selectedCompanyId && !!selectedFiscalYearId && !!socieStart && !!socieEnd} />
            ) : (
              <PrintableReport
                orientation="portrait"
                toolbar={<PrintButton orientation="portrait" />}
                meta={buildReportHeaderMeta({
                  companyCode: selectedCompany?.code,
                  companyName: selectedCompany?.nameAr,
                  reportTitle: "قائمة التغيرات في حقوق الملكية",
                  fiscalYearCode: selectedFiscalYear?.code,
                  fiscalYearLabel: selectedFiscalYear?.displayNameAr,
                  periodLabel: `الفترات ${socieStart} إلى ${socieEnd}`,
                  fromDate: periodByOrdinal(socieStart)?.startDate ?? null,
                  toDate: periodByOrdinal(socieEnd)?.endDate ?? null,
                  currency: currencyLabel,
                  status: equity.status === "INCOMPLETE_DATA" ? "INCOMPLETE_DATA" : "APPROVED",
                  statusNotice: !equity.totals.reconciled
                    ? "فشل مطابقة الإجماليات (الافتتاحي + الحركات ≠ الختامي) — الفرق معروض ولا يُجبر التوازن."
                    : null,
                })}
              >
                {equity.status === "INCOMPLETE_DATA" && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                    <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" />INCOMPLETE_DATA — مكونات أو فترات ناقصة معلنة أدناه (لا plug لفرض التوازن).</p>
                  </div>
                )}
                {equity.unmappedAccounts.length > 0 && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
                    <p className="font-semibold text-amber-800 dark:text-amber-300">حسابات حقوق ملكية غير مرتبطة بمكون معروف: {equity.unmappedAccounts.length}</p>
                    <ul className="mt-1 space-y-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                      {equity.unmappedAccounts.slice(0, 30).map((a) => (
                        <li key={a.accountCode}><span className="font-mono">{a.accountCode}</span> — {a.accountName || "—"}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <Card>
                  <CardContent className="pt-4">
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-right">المكوّن</TableHead>
                            <TableHead className="text-left">الرصيد الافتتاحي</TableHead>
                            <TableHead className="text-left">حركات الفترة</TableHead>
                            <TableHead className="text-left">الرصيد الختامي</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {equity.rows.map((r) => (
                            <TableRow key={r.componentCode}>
                              <TableCell className="text-sm">{r.label}</TableCell>
                              <TableCell className="text-left"><Money value={r.openingMinor} minorUnits={minorUnits} /></TableCell>
                              <TableCell className="text-left"><Money value={r.movementMinor} minorUnits={minorUnits} /></TableCell>
                              <TableCell className="text-left"><Money value={r.closingMinor} minorUnits={minorUnits} /></TableCell>
                            </TableRow>
                          ))}
                          {equity.profitOrLossForPeriod && (
                            <TableRow>
                              <TableCell className="text-sm">{equity.profitOrLossForPeriod.label ?? "صافي ربح/خسارة الفترة"}</TableCell>
                              <TableCell className="text-left text-muted-foreground">—</TableCell>
                              <TableCell className="text-left"><Money value={equity.profitOrLossForPeriod.valueMinor} minorUnits={minorUnits} /></TableCell>
                              <TableCell className="text-left text-muted-foreground">—</TableCell>
                            </TableRow>
                          )}
                          <TableRow className="border-t-2 font-bold">
                            <TableCell>الإجمالي</TableCell>
                            <TableCell className="text-left"><Money value={equity.totals.openingMinor} minorUnits={minorUnits} /></TableCell>
                            <TableCell className="text-left"><Money value={equity.totals.movementsMinor} minorUnits={minorUnits} /></TableCell>
                            <TableCell className="text-left"><Money value={equity.totals.closingMinor} minorUnits={minorUnits} /></TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
                <p className={cn("rounded-md p-3 text-sm", equity.totals.reconciled ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300" : "bg-rose-50 text-rose-800 dark:bg-rose-950/30 dark:text-rose-300")}>
                  {equity.totals.reconciled ? "✓ المطابقة ناجحة: الافتتاحي + الحركات = الختامي" : "⚠ فشل مطابقة الإجماليات (الافتتاحي + الحركات ≠ الختامي) — الفرق معروض ولا يُجبر التوازن."}
                </p>
              </PrintableReport>
            )}
          </TabsContent>

          {/* ── Cash Flow ── */}
          <TabsContent value="cf" className="mt-4 space-y-4">
            {cfLoading ? (
              <div className="flex items-center gap-2 rounded-lg border p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />جارٍ البناء…</div>
            ) : !cashflow ? (
              <EmptyState companyPicked={!!selectedCompanyId && !!selectedFiscalYearId && !!cfStart && !!cfEnd} />
            ) : (
              <PrintableReport
                orientation="portrait"
                toolbar={<PrintButton orientation="portrait" />}
                meta={buildReportHeaderMeta({
                  companyCode: selectedCompany?.code,
                  companyName: selectedCompany?.nameAr,
                  reportTitle: "قائمة التدفقات النقدية (IAS 7 — طريقة غير مباشرة)",
                  fiscalYearCode: selectedFiscalYear?.code,
                  fiscalYearLabel: selectedFiscalYear?.displayNameAr,
                  periodLabel: `الفترات ${cfStart} إلى ${cfEnd}`,
                  fromDate: periodByOrdinal(cfStart)?.startDate ?? null,
                  toDate: periodByOrdinal(cfEnd)?.endDate ?? null,
                  currency: currencyLabel,
                  status: cashflow.status === "INCOMPLETE_DATA" ? "INCOMPLETE_DATA" : "APPROVED",
                  statusNotice:
                    cashflow.reconciliationDifferenceMinor !== null && cashflow.reconciliationDifferenceMinor !== "0"
                      ? `فرق مطابقة النقد ${cashflow.reconciliationDifferenceMinor} minor معروض ولا يُخفى ولا يُسدّ بـ plug.`
                      : null,
                })}
              >
                <p className="flex items-start gap-2 rounded-md bg-muted p-3 text-xs leading-5 text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  دقة التدفقات تعتمد على اكتمال Cash Flow Mapping (خريطة الأنشطة على مستوى الشركة) واكتمال بيانات ميزان المراجعة المعتمد.
                  الحسابات غير المصنفة تُعلن أدناه ولا تُخمَّن أنشطتها من تصنيفها المحاسبي.
                </p>
                {[cashflow.operating, cashflow.investing, cashflow.financing].map((act) => (
                  <Card key={act.activity}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{act.label}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Table>
                        <TableBody>
                          {act.lines.length === 0 ? (
                            <TableRow><TableCell className="text-xs text-muted-foreground">لا بنود مرتبطة بهذا النشاط.</TableCell></TableRow>
                          ) : (
                            act.lines.map((l) => <CfLineRow key={l.lineCode} line={l} minorUnits={minorUnits} />)
                          )}
                          <TableRow className="font-semibold">
                            <TableCell>صافي {act.label}</TableCell>
                            <TableCell className="text-left"><Money value={act.netMinor} minorUnits={minorUnits} /></TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                ))}
                <Card>
                  <CardContent className="pt-4">
                    <Table>
                      <TableBody>
                        <TableRow className="font-extrabold"><TableCell>صافي التغير في النقد وما في حكمه</TableCell><TableCell className="text-left"><Money value={cashflow.netChangeMinor} minorUnits={minorUnits} /></TableCell></TableRow>
                        <TableRow><TableCell>النقد الافتتاحي</TableCell><TableCell className="text-left"><Money value={cashflow.cashOpeningMinor} minorUnits={minorUnits} /></TableCell></TableRow>
                        <TableRow className="font-extrabold"><TableCell>النقد الختامي</TableCell><TableCell className="text-left"><Money value={cashflow.cashClosingMinor} minorUnits={minorUnits} /></TableCell></TableRow>
                        <TableRow><TableCell className="text-sm text-muted-foreground">حركة حسابات النقد الفعلية (للمطابقة)</TableCell><TableCell className="text-left"><Money value={cashflow.cashMovementFromCashAccountsMinor} minorUnits={minorUnits} /></TableCell></TableRow>
                        <TableRow className={cn(cashflow.reconciliationDifferenceMinor === null || cashflow.reconciliationDifferenceMinor === "0" ? "" : "bg-rose-50 font-bold dark:bg-rose-950/30")}>
                          <TableCell>
                            فرق المطابقة (النقد المحتسب − حركة حسابات النقد)
                            {cashflow.reconciliationDifferenceMinor !== null && cashflow.reconciliationDifferenceMinor !== "0" && (
                              <span className="ms-2 text-rose-700 dark:text-rose-400">— يُعرض ولا يُخفى ولا يُسدّ بplug</span>
                            )}
                          </TableCell>
                          <TableCell className="text-left">
                            <Money value={cashflow.reconciliationDifferenceMinor} minorUnits={minorUnits} className={cashflow.reconciliationDifferenceMinor !== null && cashflow.reconciliationDifferenceMinor !== "0" ? "font-bold text-rose-700 dark:text-rose-400" : ""} />
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
                {cashflow.nonCashDisclosure.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm">إفصاح المعاملات غير النقدية (NON_CASH — منفصلة)</CardTitle></CardHeader>
                    <CardContent>
                      <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                        {cashflow.nonCashDisclosure.map((n, i) => <li key={i}>{n.label}</li>)}
                      </ul>
                    </CardContent>
                  </Card>
                )}
                {cashflow.unclassifiedAccounts.length > 0 && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
                    <p className="font-semibold text-amber-800 dark:text-amber-300">حسابات غير مرتبطة بخريطة تدفقات: {cashflow.unclassifiedAccounts.length}</p>
                    <ul className="mt-1 space-y-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                      {cashflow.unclassifiedAccounts.slice(0, 30).map((a) => (
                        <li key={a.accountCode}><span className="font-mono">{a.accountCode}</span> — {a.accountName || "—"} {a.note ? `(${a.note})` : ""}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {cashflow.status === "INCOMPLETE_DATA" && (
                  <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                    <AlertTriangle className="me-1 inline size-4" /> INCOMPLETE_DATA — عناصر ناقصة معلنة أعلاه.
                  </p>
                )}
              </PrintableReport>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function CfLineRow({ line, minorUnits }: { line: CfLine; minorUnits: number }) {
  const [open, setOpen] = React.useState(false);
  const hasAccounts = (line.accounts?.length ?? 0) > 0;
  return (
    <>
      <TableRow>
        <TableCell>
          {hasAccounts ? (
            <button type="button" className="flex items-center gap-1 hover:text-emerald-700 dark:hover:text-emerald-400" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
              <span className="text-sm">{line.label}</span>
            </button>
          ) : (
            <span className="text-sm">{line.label}</span>
          )}
        </TableCell>
        <TableCell className="text-left"><Money value={line.effectMinor} minorUnits={minorUnits} /></TableCell>
      </TableRow>
      {open && hasAccounts && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={2} className="px-4 py-2">
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">
              {(line.accounts ?? []).map((a) => (
                <li key={a.accountCode} className="flex items-center justify-between gap-2">
                  <span><span className="font-mono">{a.accountCode}</span> — {a.accountName || "—"}</span>
                  <Money value={a.valueMinor} minorUnits={minorUnits} />
                </li>
              ))}
            </ul>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function EmptyState({ companyPicked }: { companyPicked: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-8 text-center dark:border-slate-700 dark:bg-slate-900/40">
      <FileBarChart className="mx-auto size-8 text-slate-400" />
      <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
        {companyPicked
          ? "لا بيانات معتمدة للعرض — استورد واعتمد ميزان مراجعة أولًا (المصدر: أحدث مراجعة معتمدة حصرًا)."
          : "اختر الشركة والسنة المالية والفترة لعرض القائمة."}
      </p>
      <Button variant="outline" size="sm" asChild className="mt-3 gap-1">
        <Link href="/?view=trial-balance">ميزان المراجعة <ChevronLeft className="size-3" /></Link>
      </Button>
    </div>
  );
}
