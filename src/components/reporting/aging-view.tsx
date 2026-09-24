"use client";

// Phase 6.10 — وحدة «أعمار الديون والتحصيل» — عربية أولًا، سطح مكتب وموبايل،
// fail-closed: كل زر إدارة مقيد بصلاحيته، والبيانات الناقصة معلنة لا مصفّرة.
// لا ادعاءات احترافية: الرؤى استشارية (FACT/ANALYSIS/RECOMMENDATION) ولا ECL هنا.

import * as React from "react";
import * as XLSX from "xlsx-js-style";
import { useSession } from "next-auth/react";
import { toast } from "@/hooks/use-toast";
import { useCompanyPeriod } from "@/components/reporting/company-period-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PrintableReport, PrintButton } from "@/components/reporting/report-print";
import { exportReportCsv } from "@/lib/report-export";
import { formatMinor } from "@/lib/money";
import { parseCsv } from "@/lib/aging-csv";
import {
  AGING_CANONICAL_FIELDS,
  AGING_FIELD_LABELS,
  AGING_SNAPSHOT_STATUS_LABELS,
  DEFAULT_AGING_BUCKETS,
  INSIGHT_KIND_LABELS,
  RECONCILIATION_STATUS_LABELS,
  RISK_LEVEL_LABELS,
  SEVERITY_LABELS,
  autoMapHeaders,
  formatBp,
  type AgingCanonicalField,
  type AgingInsight,
  type AgingMapping,
  type AgingRiskRow,
  type AgingTotals,
  type BucketTotal,
} from "@/lib/aging";
import { parsePermissions, canUploadAging, canConfigureAging, canApproveAgingSnapshot, canDeleteDraftAging } from "@/lib/permissions";
import { AmountBarChartH, AmountDonutChart, AmountTrendChart } from "@/components/charts/amount-charts";
import { useAppearance } from "@/components/appearance/appearance-provider";
import { UploadCloud, Trash2, FileSpreadsheet, ShieldCheck, Lightbulb, TriangleAlert } from "lucide-react";

interface ImportRow {
  id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  asOfDate: string;
  periodLabel: string;
  status: string;
  mappingSource: string;
  rowCount: number;
  validRowCount: number;
  warningCount: number;
  createdByName: string;
  createdAt: string;
  snapshotCount: number;
}

interface SnapshotMeta {
  id: string;
  asOfDate: string;
  periodLabel: string;
  status: "DRAFT" | "APPROVED";
  currency: string;
  reconciliationStatus: keyof typeof RECONCILIATION_STATUS_LABELS;
  totals: AgingTotals;
  approvedByName?: string | null;
}

interface SnapshotDetail {
  snapshot: {
    id: string;
    asOfDate: string;
    periodLabel: string;
    status: "DRAFT" | "APPROVED";
    currency: string;
    reconciliationStatus: keyof typeof RECONCILIATION_STATUS_LABELS;
    totals: AgingTotals;
    bucketTotals: BucketTotal[];
    reconciliation: {
      tbTotalMinor?: string;
      agingTotalMinor?: string;
      differenceMinor?: string;
      accounts?: Array<{ accountCode: string; label: string; accountName: string; netMinor: string }>;
      fromDate?: string;
      toDate?: string;
      note?: string;
    };
    risk: { rows?: AgingRiskRow[]; customerCount?: number; highCount?: number; mediumCount?: number; lowCount?: number };
    insights: AgingInsight[] | null;
    insightsRestricted?: boolean;
    approvedByName?: string | null;
  };
  topRows: Array<{ customerKey: string; customerCode: string | null; customerName: string | null; balanceMinor: string; bucketCode: string; ageDays: number | null }>;
}

interface AgingConfig {
  buckets: Array<{ id: string; code: string; labelAr: string; labelEn: string; fromDays: number | null; toDays: number | null; isNotDue: boolean; order: number }>;
  receivableAccounts: Array<{ id: string; accountCode: string; label: string }>;
  insightRules: Array<{ id: string; code: string; enabled: boolean; thresholdBp: number | null; thresholdDays: number | null; thresholdCount: number | null; severity: string }>;
}

const RECON_BADGE: Record<string, string> = {
  RECONCILED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  DIFFERENCE: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  NO_TB_DATA: "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  NO_RECEIVABLE_MAPPING: "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  INCOMPLETE_DATA: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

const SEVERITY_STYLE: Record<string, string> = {
  INFO: "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
  ATTENTION: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  IMPORTANT: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
  CRITICAL: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** قراءة الملف محليًا إلى شبكة نصية خام (قيم فقط — لا تنفيذ صيغ)؛ الخادم يعيد التحقق. */
async function readAgingFile(file: File): Promise<{ fileType: "CSV" | "XLSX"; grid: { headers: string[]; rows: string[][] } }> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const text = await file.text();
    const grid = parseCsv(text);
    if (grid.headers.length === 0) throw new Error("الملف فارغ أو بلا ترويسات");
    return { fileType: "CSV", grid };
  }
  if (name.endsWith(".xlsx")) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rowsRaw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
    if (rowsRaw.length === 0) throw new Error("الورقة الأولى فارغة");
    const toCell = (v: unknown): string => {
      if (v instanceof Date) {
        const y = v.getFullYear();
        const m = String(v.getMonth() + 1).padStart(2, "0");
        const d = String(v.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      }
      if (v == null) return "";
      if (typeof v === "object") return "";
      return String(v);
    };
    const grid = {
      headers: (rowsRaw[0] as unknown[]).map(toCell),
      rows: rowsRaw.slice(1).map((r) => (r as unknown[]).map(toCell)),
    };
    return { fileType: "XLSX", grid };
  }
  throw new Error("صيغة غير مدعومة — المدعوم: .xlsx و .csv (ملفات .xls القديمة تُرفض لأسباب أمنية)");
}

export function AgingView() {
  const { data: session } = useSession();
  const { companies, selectedCompanyId, minorUnits } = useCompanyPeriod();
  const { prefs } = useAppearance(); // 6.11 — إظهار/إخفاء الرسوم تفضيل عرض لا صلاحية
  const role = ((session?.user as { role?: string } | undefined)?.role) ?? "user";
  const perms = parsePermissions(((session?.user as { permissions?: string | null } | undefined)?.permissions) ?? "{}");
  const canView = role === "admin" || perms.viewAging === true;
  const canUpload = canUploadAging(perms, role);
  const canConfigure = canConfigureAging(perms, role);
  const canApprove = canApproveAgingSnapshot(perms, role);
  const canDelete = canDeleteDraftAging(perms, role);

  const [tab, setTab] = React.useState<string>(() => {
    if (typeof window === "undefined") return "analysis";
    return new URLSearchParams(window.location.search).get("tab") ?? "analysis";
  });

  const [imports, setImports] = React.useState<ImportRow[]>([]);
  const [snapshots, setSnapshots] = React.useState<SnapshotMeta[]>([]);
  const [trend, setTrend] = React.useState<Array<{ snapshotId: string; asOfDate: string; totalMinor: string | null; overdueMinor: string | null }>>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = React.useState<string>("");
  const [detail, setDetail] = React.useState<SnapshotDetail | null>(null);
  const [config, setConfig] = React.useState<AgingConfig | null>(null);
  const [loading, setLoading] = React.useState(false);

  // ── حالة الرفع ──
  const [pendingFile, setPendingFile] = React.useState<{ fileName: string; fileType: "CSV" | "XLSX"; fileSize: number; fileSha256: string; grid: { headers: string[]; rows: string[][] } } | null>(null);
  const [mapping, setMapping] = React.useState<AgingMapping>({});
  const [asOfDate, setAsOfDate] = React.useState<string>("");
  const [periodLabel, setPeriodLabel] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);

  const loadImports = React.useCallback(async (companyId: string) => {
    if (!companyId) return;
    const res = await fetch(`/api/aging/imports?companyId=${encodeURIComponent(companyId)}`, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.imports) setImports(data.imports);
  }, []);

  const loadSnapshots = React.useCallback(async (companyId: string) => {
    if (!companyId) return;
    const res = await fetch(`/api/aging/snapshots?companyId=${encodeURIComponent(companyId)}`, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.snapshots) {
      setSnapshots(data.snapshots);
      setTrend(data.trend ?? []);
      setSelectedSnapshotId((prev) => prev || data.snapshots[0]?.id || "");
    }
  }, []);

  const loadDetail = React.useCallback(async (snapshotId: string) => {
    if (!snapshotId) { setDetail(null); return; }
    const res = await fetch(`/api/aging/snapshots/${encodeURIComponent(snapshotId)}`, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.snapshot) setDetail(data);
    else setDetail(null);
  }, []);

  const loadConfig = React.useCallback(async (companyId: string) => {
    if (!companyId) return;
    const res = await fetch(`/api/aging/config?companyId=${encodeURIComponent(companyId)}`, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (res.ok) setConfig({ buckets: data.buckets ?? [], receivableAccounts: data.receivableAccounts ?? [], insightRules: data.insightRules ?? [] });
  }, []);

  React.useEffect(() => {
    if (!selectedCompanyId) return;
    setLoading(true);
    Promise.all([loadImports(selectedCompanyId), loadSnapshots(selectedCompanyId), loadConfig(selectedCompanyId)])
      .finally(() => setLoading(false));
  }, [selectedCompanyId, loadImports, loadSnapshots, loadConfig]);

  React.useEffect(() => {
    if (selectedSnapshotId) void loadDetail(selectedSnapshotId);
  }, [selectedSnapshotId, loadDetail]);

  const onFileChosen = async (file: File) => {
    try {
      const parsed = await readAgingFile(file);
      const sha = await sha256Hex(await file.arrayBuffer());
      setPendingFile({ fileName: file.name, fileType: parsed.fileType, fileSize: file.size, fileSha256: sha, grid: parsed.grid });
      setMapping(autoMapHeaders(parsed.grid.headers).mapping);
    } catch (e) {
      toast({ title: "فشل قراءة الملف", description: e instanceof Error ? e.message : "", variant: "destructive" });
    }
  };

  const submitImport = async () => {
    if (!pendingFile || !selectedCompanyId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/aging/imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          fileName: pendingFile.fileName,
          fileType: pendingFile.fileType,
          fileSize: pendingFile.fileSize,
          fileSha256: pendingFile.fileSha256,
          asOfDate,
          periodLabel,
          grid: pendingFile.grid,
          ...(Object.keys(mapping).some((k) => (mapping as Record<string, unknown>)[k]) ? { mappingOverride: mapping } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({
        title: "تم الرفع",
        description: `صفوف صالحة: ${data.validRowCount} من ${data.rowCount} — مرفوضة: ${data.rejectedCount} — تحذيرات: ${data.warningCount}`,
      });
      setPendingFile(null);
      setAsOfDate("");
      setPeriodLabel("");
      await loadImports(selectedCompanyId);
    } catch (e) {
      toast({ title: "فشل الرفع", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const createSnapshot = async (importId: string, acknowledgeApprovedDuplicate = false) => {
    try {
      const res = await fetch("/api/aging/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importId, acknowledgeApprovedDuplicate }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 409 && data?.code === "EXISTING_APPROVED_SNAPSHOT") {
        if (window.confirm("توجد لقطة معتمدة لنفس تاريخ الأساس. إنشاء لقطة جديدة بجانبها (دون استبدال)؟")) {
          await createSnapshot(importId, true);
        }
        return;
      }
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "تم إنشاء اللقطة (مسودة)", description: `المطابقة: ${RECONCILIATION_STATUS_LABELS[data.reconciliationStatus as keyof typeof RECONCILIATION_STATUS_LABELS]?.ar ?? data.reconciliationStatus}` });
      if (selectedCompanyId) await loadSnapshots(selectedCompanyId);
      if (data.snapshotId) setSelectedSnapshotId(data.snapshotId);
    } catch (e) {
      toast({ title: "فشل إنشاء اللقطة", description: e instanceof Error ? e.message : "", variant: "destructive" });
    }
  };

  const approveSnapshot = async (snapshotId: string) => {
    try {
      const res = await fetch(`/api/aging/snapshots/${encodeURIComponent(snapshotId)}/approve`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "تم الاعتماد" });
      if (selectedCompanyId) await loadSnapshots(selectedCompanyId);
      await loadDetail(snapshotId);
    } catch (e) {
      toast({ title: "فشل الاعتماد", description: e instanceof Error ? e.message : "", variant: "destructive" });
    }
  };

  const deleteImport = async (importId: string) => {
    if (!window.confirm("حذف هذا الاستيراد؟ (المسموح فقط للاستيراد بلا لقطات)")) return;
    try {
      const res = await fetch(`/api/aging/imports/${encodeURIComponent(importId)}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "تم الحذف" });
      if (selectedCompanyId) await loadImports(selectedCompanyId);
    } catch (e) {
      toast({ title: "فشل الحذف", description: e instanceof Error ? e.message : "", variant: "destructive" });
    }
  };

  if (!canView) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-muted-foreground">لا تملك الصلاحية اللازمة لعرض أعمار الديون.</CardContent>
      </Card>
    );
  }

  const snap = detail?.snapshot;
  const totals = snap?.totals;
  const bucketTotals = snap?.bucketTotals ?? [];
  const chartBuckets = bucketTotals.filter((b) => b.amountMinor !== "0" || b.count > 0);
  const recon = snap?.reconciliation ?? {};
  const riskRows = snap?.risk?.rows ?? [];
  const csvBuckets = () =>
    exportReportCsv(
      [
        { key: "code", label: "Code" },
        { key: "label", label: "الشريط" },
        { key: "amount", label: "المبلغ (minor)", numeric: true },
        { key: "count", label: "العملاء", numeric: true },
        { key: "pct", label: "النسبة (bp)", numeric: true },
      ],
      bucketTotals.map((b) => ({ code: b.code, label: b.labelAr, amount: b.amountMinor, count: b.count, pct: b.pctBp })),
      `aging-buckets-${snap?.asOfDate ?? "export"}`
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold">أعمار الديون والتحصيل</h2>
          <p className="text-sm text-muted-foreground">Receivables Aging &amp; Collections — وحدة تحليلية استشارية مستقلة نطاق الشركة</p>
        </div>
        {tab === "analysis" && snap ? <PrintButton orientation="landscape" /> : null}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex w-full flex-wrap">
          <TabsTrigger value="analysis">التحليل</TabsTrigger>
          <TabsTrigger value="import">الاستيراد</TabsTrigger>
          <TabsTrigger value="insights">الرؤى الذكية</TabsTrigger>
          <TabsTrigger value="risk">أولويات المخاطر</TabsTrigger>
          {canConfigure ? <TabsTrigger value="config">الإعدادات</TabsTrigger> : null}
        </TabsList>

        {/* ── التحليل ── */}
        <TabsContent value="analysis" className="space-y-4">
          {snapshots.length === 0 ? (
            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>لا توجد لقطات أعمار بعد</AlertTitle>
              <AlertDescription>ابدأ من تبويب «الاستيراد»: ارفع ملفًا ثم أنشئ لقطة أعمار.</AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Label className="text-sm">اللقطة:</Label>
                <Select value={selectedSnapshotId} onValueChange={setSelectedSnapshotId}>
                  <SelectTrigger className="w-[320px]"><SelectValue placeholder="اختر لقطة" /></SelectTrigger>
                  <SelectContent>
                    {snapshots.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.asOfDate} {s.periodLabel ? `— ${s.periodLabel}` : ""} — {AGING_SNAPSHOT_STATUS_LABELS[s.status].ar}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {snap && totals ? (
                <PrintableReport
                  orientation="landscape"
                  meta={{
                    companyAr: companies.find((c) => c.id === selectedCompanyId)?.nameAr ?? "",
                    reportTitleAr: "أعمار الديون والتحصيل",
                    reportTitleEn: "Receivables Aging & Collections",
                    fiscalYearLabel: snap.periodLabel || snap.asOfDate,
                    periodLabel: `بتاريخ ${snap.asOfDate}`,
                    currency: snap.currency,
                    status: snap.status === "APPROVED" ? "APPROVED" : "DRAFT",
                  } as never}
                >
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                      <KpiCard label="إجمالي المستحقات" value={<Money minor={totals.totalMinor} minorUnits={minorUnits} />} />
                      <KpiCard label="المتأخر (بأساس الاستحقاق)" value={<Money minor={totals.overdueMinor} minorUnits={minorUnits} />} hint={formatBp(totals.overduePctBp)} />
                      <KpiCard label="عدد العملاء" value={<span className="tnum">{totals.customerCount}</span>} />
                      <KpiCard label="متوسط العمر المرجّح" value={<span className="tnum">{totals.weightedAvgAgeDays != null ? `${totals.weightedAvgAgeDays} يومًا` : "—"}</span>} />
                      <KpiCard label="تركّز أكبر 5" value={<span className="tnum">{formatBp(totals.top5ConcentrationBp)}</span>} />
                      <KpiCard label="بيانات ناقصة / غير محددة" value={<span className="tnum">{totals.missingBalanceCount + totals.undeterminedCount}</span>} hint="لا تُعامل صفرًا" />
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={RECON_BADGE[snap.reconciliationStatus] ?? ""}>{RECONCILIATION_STATUS_LABELS[snap.reconciliationStatus]?.ar ?? snap.reconciliationStatus}</Badge>
                      {snap.status === "APPROVED" ? (
                        <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">معتمدة{snap.approvedByName ? ` — ${snap.approvedByName}` : ""}</Badge>
                      ) : (
                        canApprove ? <Button size="sm" onClick={() => approveSnapshot(snap.id)}>اعتماد اللقطة</Button> : null
                      )}
                      <Button size="sm" variant="outline" onClick={csvBuckets}>تصدير الشرائط CSV</Button>
                    </div>

                    {snap.reconciliationStatus === "DIFFERENCE" ? (
                      <Alert variant="destructive">
                        <TriangleAlert className="h-4 w-4" />
                        <AlertTitle>فرق غير مطابق — معلن لا مُخفى</AlertTitle>
                        <AlertDescription>
                          <span className="tnum font-mono" dir="ltr">TB = {String(recon.tbTotalMinor ?? "—")} · الأعمار = {String(recon.agingTotalMinor ?? "—")} · الفرق = {String(recon.differenceMinor ?? "—")}</span>
                          <div className="mt-1 text-xs">أساس المطابقة: {recon.fromDate ?? "—"} ← {recon.toDate ?? "—"} — لا يُجرى أي تسوية آلية.</div>
                        </AlertDescription>
                      </Alert>
                    ) : null}

                    {prefs.chartsVisible ? (
                      <div className="grid gap-4 lg:grid-cols-2">
                        <AmountDonutChart title="توزيع الشرائط" minorUnits={minorUnits} data={chartBuckets.map((b) => ({ label: b.labelAr, valueMinor: b.amountMinor, count: b.count }))} />
                        <AmountBarChartH title="أكبر المدينين (أعلى 20)" minorUnits={minorUnits} countLabel="—" data={(detail?.topRows ?? []).map((r) => ({ label: r.customerName ?? r.customerCode ?? r.customerKey, valueMinor: r.balanceMinor }))} />
                      </div>
                    ) : null}
                    {prefs.chartsVisible && trend.length > 1 ? (
                      <AmountTrendChart title="اتجاه اللقطات المعتمدة" minorUnits={minorUnits} points={trend.map((t) => ({ label: t.asOfDate, totalMinor: t.totalMinor, overdueMinor: t.overdueMinor }))} />
                    ) : null}

                    <div className="overflow-x-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>الشريط</TableHead>
                            <TableHead>المبلغ</TableHead>
                            <TableHead>العملاء</TableHead>
                            <TableHead>النسبة</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {bucketTotals.map((b) => (
                            <TableRow key={b.code} className={b.isUndetermined ? "text-muted-foreground" : ""}>
                              <TableCell>{b.labelAr}{b.isUndetermined ? " (معلن)" : ""}</TableCell>
                              <TableCell><Money minor={b.amountMinor} minorUnits={minorUnits} /></TableCell>
                              <TableCell className="tnum">{b.count}</TableCell>
                              <TableCell className="tnum">{formatBp(b.pctBp)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>

                    <p className="text-xs text-muted-foreground">
                      هذه مخرجات تحليلية استشارية لأغراض الإدارة — لا تعد حكمًا على قابلية التحصيل ولا رأيًا مهنيًا، ولا تحسب أي خسائر ائتمانية متوقعة (ECL مرحلة مستقلة لاحقًا).
                    </p>
                  </div>
                </PrintableReport>
              ) : (
                <p className="text-sm text-muted-foreground">جارِ التحميل…</p>
              )}
            </>
          )}
        </TabsContent>

        {/* ── الاستيراد ── */}
        <TabsContent value="import" className="space-y-4">
          {canUpload ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">رفع ملف أعمار (Excel/CSV)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md border border-dashed px-4 py-3 text-sm hover:border-emerald-400">
                  <UploadCloud className="h-4 w-4 text-emerald-600" />
                  اختر ملفًا (.xlsx أو .csv — الحد 10MB)
                  <input
                    type="file"
                    accept=".xlsx,.csv"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void onFileChosen(f);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
                {pendingFile ? (
                  <div className="flex flex-wrap items-end gap-3 text-sm">
                    <div className="flex items-center gap-2"><FileSpreadsheet className="h-4 w-4 text-emerald-600" />{pendingFile.fileName} ({pendingFile.fileType})</div>
                    <div>
                      <Label className="text-xs">تاريخ الأساس (as-of)</Label>
                      <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} className="w-[180px]" />
                    </div>
                    <div>
                      <Label className="text-xs">وسم الفترة (اختياري)</Label>
                      <Input value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} placeholder="مثال: الربع الثالث 2026" className="w-[220px]" />
                    </div>
                    <Button onClick={() => setTab("mapping")} disabled={!asOfDate}>تعيين الأعمدة والمتابعة</Button>
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground">الحد الأدنى ذو المعنى: هوية العميل + الرصيد المستحق + أساس عمر متاح. الأعمدة غير المطلوبة تُترك بلا تعيين، والبيانات الناقصة تُعلن ولا تُصفر.</p>
              </CardContent>
            </Card>
          ) : (
            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>الرفع يتطلب صلاحية</AlertTitle>
              <AlertDescription>لا تملك صلاحية uploadAging — يمكنك الاستعراض فقط.</AlertDescription>
            </Alert>
          )}

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>الملف</TableHead>
                  <TableHead>تاريخ الأساس</TableHead>
                  <TableHead>الصفوف (صالح/كلي)</TableHead>
                  <TableHead>تحذيرات</TableHead>
                  <TableHead>التعيين</TableHead>
                  <TableHead>أُنشئ بواسطة</TableHead>
                  <TableHead>إجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {imports.map((im) => (
                  <TableRow key={im.id}>
                    <TableCell>{im.fileName} <Badge variant="outline">{im.fileType}</Badge></TableCell>
                    <TableCell className="tnum" dir="ltr">{im.asOfDate}{im.periodLabel ? ` — ${im.periodLabel}` : ""}</TableCell>
                    <TableCell className="tnum">{im.validRowCount} / {im.rowCount}</TableCell>
                    <TableCell className="tnum">{im.warningCount}</TableCell>
                    <TableCell>{im.mappingSource === "USER" ? "يدوي" : "تلقائي"}</TableCell>
                    <TableCell>{im.createdByName}</TableCell>
                    <TableCell className="flex flex-wrap gap-1">
                      <Button size="sm" variant="outline" disabled={!canUpload} onClick={() => createSnapshot(im.id)}>إنشاء لقطة</Button>
                      {canDelete && im.snapshotCount === 0 ? (
                        <Button size="sm" variant="ghost" onClick={() => deleteImport(im.id)} aria-label="حذف"><Trash2 className="h-4 w-4" /></Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
                {imports.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">لا استيرادات بعد.</TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* ── الرؤى ── */}
        <TabsContent value="insights" className="space-y-3">
          {snap == null ? (
            <p className="text-sm text-muted-foreground">اختر لقطة من تبويب التحليل أولًا.</p>
          ) : snap.insightsRestricted ? (
            <Alert>
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>الرؤى مقيدة</AlertTitle>
              <AlertDescription>تتطلب صلاحية viewInsights.</AlertDescription>
            </Alert>
          ) : (snap.insights ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">لا رؤى مفعّلة لهذه اللقطة.</p>
          ) : (
            (snap.insights ?? []).map((ins) => (
              <Alert key={ins.code}>
                <Lightbulb className="h-4 w-4" />
                <AlertTitle className="flex flex-wrap items-center gap-2">
                  {ins.titleAr}
                  <Badge className={SEVERITY_STYLE[ins.severity] ?? ""}>{SEVERITY_LABELS[ins.severity]?.ar ?? ins.severity}</Badge>
                  <Badge variant="outline">{INSIGHT_KIND_LABELS[ins.kind]?.ar ?? ins.kind}</Badge>
                </AlertTitle>
                <AlertDescription>
                  <div>{ins.detailAr}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{ins.suggestedActionAr}</div>
                </AlertDescription>
              </Alert>
            ))
          )}
        </TabsContent>

        {/* ── المخاطر ── */}
        <TabsContent value="risk" className="space-y-3">
          {snap == null ? (
            <p className="text-sm text-muted-foreground">اختر لقطة من تبويب التحليل أولًا.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge variant="outline">مرتفع: {snap.risk.highCount ?? 0}</Badge>
                <Badge variant="outline">متوسط: {snap.risk.mediumCount ?? 0}</Badge>
                <Badge variant="outline">منخفض: {snap.risk.lowCount ?? 0}</Badge>
              </div>
              <div className="max-h-96 overflow-y-auto overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>العميل</TableHead>
                      <TableHead>الرصيد</TableHead>
                      <TableHead>العمر/الشريط</TableHead>
                      <TableHead>آخر بيع</TableHead>
                      <TableHead>آخر تحصيل</TableHead>
                      <TableHead>المستوى</TableHead>
                      <TableHead>الأسباب</TableHead>
                      <TableHead>إجراء مقترح</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {riskRows.map((r) => (
                      <TableRow key={r.customerKey}>
                        <TableCell>{r.customerName ?? r.customerCode ?? r.customerKey}</TableCell>
                        <TableCell><Money minor={r.balanceMinor} minorUnits={minorUnits} /></TableCell>
                        <TableCell className="tnum">{r.maxAgeDays != null ? `${r.maxAgeDays} يوم` : "—"} · {r.bucketCode}</TableCell>
                        <TableCell className="tnum" dir="ltr">{r.lastSaleDate ?? "—"}</TableCell>
                        <TableCell className="tnum" dir="ltr">{r.lastCollectionDate ?? "—"}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{RISK_LEVEL_LABELS[r.level].ar} ({r.score})</Badge>
                        </TableCell>
                        <TableCell className="max-w-[240px] text-xs">{r.reasonsAr.join(" · ") || "—"}</TableCell>
                        <TableCell className="text-xs">{r.suggestedActionAr}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground">ترتيب حتمي مبني على عوامل متاحة — استشاري فقط ولا يدّعي يقين قابلية التحصيل ولا يُصدر رأيًا.</p>
            </>
          )}
        </TabsContent>

        {/* ── الإعدادات ── */}
        {canConfigure ? (
          <TabsContent value="config" className="space-y-4">
            <ConfigEditor config={config} setConfig={setConfig} companyId={selectedCompanyId ?? ""} />
          </TabsContent>
        ) : null}
      </Tabs>

      {/* ── حوار تعيين الأعمدة ── */}
      <Dialog open={tab === "mapping" && pendingFile != null} onOpenChange={(open) => { if (!open) setTab("import"); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>تعيين أعمدة الملف إلى الحقول القيانية</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">الترجيع التلقائي مطبق — عدّل ما تشاء. المطلوب: هوية عميل (كود أو اسم) + الرصيد المستحق.</p>
            {AGING_CANONICAL_FIELDS.map((field) => (
              <div key={field} className="grid grid-cols-[1fr_2fr] items-center gap-2">
                <Label className="text-xs">{AGING_FIELD_LABELS[field].ar} <span dir="ltr" className="text-muted-foreground">({field})</span></Label>
                <Select
                  value={mapping[field] ?? "__none__"}
                  onValueChange={(v) => setMapping((m) => ({ ...m, [field]: v === "__none__" ? undefined : v }))}
                >
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— بلا تعيين —</SelectItem>
                    {pendingFile?.grid.headers.map((h) => (
                      <SelectItem key={h} value={h}>{h}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setTab("import"); }}>إلغاء</Button>
            <Button
              disabled={busy || !asOfDate || ((mapping.CUSTOMER_CODE == null) && (mapping.CUSTOMER_NAME == null)) || mapping.OUTSTANDING_BALANCE == null}
              onClick={submitImport}
            >
              {busy ? "جارٍ الرفع…" : "رفع الاستيراد"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function KpiCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-base font-semibold">{value}</div>
        {hint ? <div className="tnum text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

/** عرض مبلغ minor بنفس نمط النظام (tabular-nums، LTR معزول). */
function Money({ minor, minorUnits }: { minor: string | null; minorUnits: number }) {
  return <span className="tnum font-mono" dir="ltr">{formatMinor(minor, minorUnits)}</span>;
}

function ConfigEditor({
  config,
  setConfig,
  companyId,
}: {
  config: AgingConfig | null;
  setConfig: (c: AgingConfig | null) => void;
  companyId: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [draftBuckets, setDraftBuckets] = React.useState<AgingConfig["buckets"]>([]);
  const [accounts, setAccounts] = React.useState<AgingConfig["receivableAccounts"]>([]);
  const [newAccountCode, setNewAccountCode] = React.useState("");
  const [newAccountLabel, setNewAccountLabel] = React.useState("");

  React.useEffect(() => {
    if (config) {
      setDraftBuckets(config.buckets.map((b) => ({ ...b })));
      setAccounts(config.receivableAccounts.map((a) => ({ ...a })));
    }
  }, [config]);

  if (!config) return null;
  const save = async (section: "buckets" | "receivableAccounts" | "insightRules", payload: unknown) => {
    setBusy(true);
    try {
      const res = await fetch("/api/aging/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, [section]: payload }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "تم الحفظ" });
    } catch (e) {
      toast({ title: "فشل الحفظ", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">شرائط الأعمار (قابلة للتخصيص — لا تداخل ولا احتساب مزدوج)</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="max-h-96 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>الكود</TableHead>
                  <TableHead>عربي</TableHead>
                  <TableHead>English</TableHead>
                  <TableHead>من (يوم)</TableHead>
                  <TableHead>إلى (يوم)</TableHead>
                  <TableHead>غير مستحق؟</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {draftBuckets.map((b, i) => (
                  <TableRow key={b.id}>
                    <TableCell className="text-xs">{b.code}</TableCell>
                    <TableCell><Input className="h-8 w-28" value={b.labelAr} onChange={(e) => setDraftBuckets((d) => d.map((x, j) => (j === i ? { ...x, labelAr: e.target.value } : x)))} /></TableCell>
                    <TableCell><Input className="h-8 w-28" value={b.labelEn} onChange={(e) => setDraftBuckets((d) => d.map((x, j) => (j === i ? { ...x, labelEn: e.target.value } : x)))} /></TableCell>
                    <TableCell><Input className="h-8 w-20" type="number" value={b.fromDays ?? ""} onChange={(e) => setDraftBuckets((d) => d.map((x, j) => (j === i ? { ...x, fromDays: e.target.value === "" ? null : Number(e.target.value) } : x)))} /></TableCell>
                    <TableCell><Input className="h-8 w-20" type="number" value={b.toDays ?? ""} onChange={(e) => setDraftBuckets((d) => d.map((x, j) => (j === i ? { ...x, toDays: e.target.value === "" ? null : Number(e.target.value) } : x)))} /></TableCell>
                    <TableCell><Switch checked={b.isNotDue} onCheckedChange={(v) => setDraftBuckets((d) => d.map((x, j) => (j === i ? { ...x, isNotDue: v } : x)))} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDraftBuckets((d) => [...d, { id: `new-${d.length}`, code: `CUSTOM_${d.length + 1}`, labelAr: "جديد", labelEn: "Custom", fromDays: null, toDays: null, isNotDue: false, order: d.length + 1 }])}
          >
            إضافة شريط
          </Button>{" "}
          <Button size="sm" disabled={busy} onClick={() => save("buckets", draftBuckets.map(({ id, ...rest }, i) => ({ ...rest, order: i + 1 })))}>
            حفظ الشرائط
          </Button>{" "}
          <Button size="sm" variant="ghost" onClick={() => setDraftBuckets(DEFAULT_AGING_BUCKETS.map((b, i) => ({ id: `def-${i}`, ...b })))}>
            استعادة الافتراضي
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">حسابات المدينين للمطابقة مع ميزان المراجعة</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <div><Label className="text-xs">كود الحساب</Label><Input className="h-8 w-32" value={newAccountCode} onChange={(e) => setNewAccountCode(e.target.value)} /></div>
            <div><Label className="text-xs">وصف (اختياري)</Label><Input className="h-8 w-48" value={newAccountLabel} onChange={(e) => setNewAccountLabel(e.target.value)} /></div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!newAccountCode.trim()) return;
                setAccounts((a) => [...a, { id: `new-${a.length}`, accountCode: newAccountCode.trim(), label: newAccountLabel.trim() }]);
                setNewAccountCode("");
                setNewAccountLabel("");
              }}
            >
              إضافة
            </Button>
          </div>
          <div className="flex flex-wrap gap-1">
            {accounts.map((a) => (
              <Badge key={a.id} variant="outline" className="gap-1">
                <span className="tnum" dir="ltr">{a.accountCode}</span>{a.label ? ` — ${a.label}` : ""}
                <button className="text-red-600" aria-label={`إزالة ${a.accountCode}`} onClick={() => setAccounts((list) => list.filter((x) => x.id !== a.id))}>×</button>
              </Badge>
            ))}
            {accounts.length === 0 ? <span className="text-xs text-muted-foreground">لا حسابات مربوطة — ستكون حالة المطابقة «لم تُربط حسابات المدينين بعد».</span> : null}
          </div>
          <Button size="sm" disabled={busy} onClick={() => save("receivableAccounts", accounts.map(({ id, ...rest }) => rest))}>حفظ الحسابات</Button>
        </CardContent>
      </Card>
    </div>
  );
}
