"use client";

// Phase 6.2B — تبويب «ميزان المراجعة» (Trial Balance Per-period Data Foundation):
//   - رفع ميزان مراجعة مرة واحدة لكل (شركة، سنة مالية، مدى فترات، نوع بيانات صريح)
//     ثم تقرأ منه كل التقارير اللاحقة — لا إعادة رفع لكل تقرير.
//   - نوع البيانات صريح إلزامي (CUMULATIVE_YTD / PERIOD_MOVEMENT) — لا تخمين من الملف.
//   - معاينة/تحقق قبل أي حفظ: الإجماليات + الفرق + خلاصة حالات الحل + الحسابات
//     غير المكتملة مع اختصار إلى تبويب «دليل الحسابات وقواعد التصنيف».
//   - سياسة التكرار المحافظة + hash تحذيري + اعتماد مجمّد + إعادة تحقق للمسودات.
//   - الدقة: المبالغ تُحوَّل exact إلى minor units (BigInt) — لا تقريب صامت.
// تحليل Excel يعيد استخدام القارئ الحالي (readExcelFile من accounts.ts المجمدة —
// client-side كما هو) بلا أي مكتبة جديدة ولا تعديل للقديم.

import * as React from "react";
import { useSession } from "next-auth/react";
import {
  CheckCircle2, ClipboardCheck, Eye, FileSpreadsheet, GitBranch, Loader2, RefreshCw, ShieldCheck, Trash2, TriangleAlert, Upload,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { readExcelFile } from "@/lib/accounts";
import {
  TB_DATA_TYPES,
  TB_DATA_TYPE_DESCRIPTIONS,
  TB_DATA_TYPE_LABELS,
  TB_STATUS_LABELS,
  type TrialBalanceDataType,
} from "@/lib/trial-balance";
import { MAPPING_STATUS_LABELS, type MappingStatus } from "@/lib/account-nature";
import { canManageTrialBalances, parsePermissions } from "@/lib/permissions";

interface CompanyOption { id: string; code: string; nameAr: string; status: string; }
interface FiscalYearOption {
  id: string; code: string; displayNameAr: string; startDate: string; endDate: string; status: string;
  periods: Array<{ id: string; ordinal: number; code: string; startDate: string; endDate: string; status: string; displayLabel: string }>;
}
interface RawLine { accountCode: string; accountName: string; debit: unknown; credit: unknown; }
interface ImportRow {
  id: string; companyId: string; fiscalYearId: string; fromDate: string; toDate: string;
  startOrdinal: number; endOrdinal: number; dataType: string; status: string;
  // Phase 6.3 — حوكمة المراجعات
  revisionNumber: number; supersedesImportId: string | null; revisionReason: string;
  originalFileName: string; fileHash: string; payloadHash: string;
  totalDebitMinor: string; totalCreditMinor: string; lineCount: number; note: string; version: number;
  company?: { code: string; nameAr: string; functionalCurrency: string } | null;
  fiscalYear?: { code: string; displayNameAr: string; startDate: string; endDate: string; status: string } | null;
  committedAt: string | null; createdAt: string; updatedAt: string;
  // 6.7 — بيانات الحوكمة الظاهرة للمستخدم
  createdByName?: string | null;
  committedByName?: string | null;
}
interface PreviewResult {
  company: { code: string; nameAr: string };
  minorUnits: number;
  fiscalYear: { code: string; startDate: string; endDate: string; status: string };
  fromDate: string; toDate: string; startOrdinal: number; endOrdinal: number;
  coveredPeriodLabels: string[];
  dataType: string;
  totalDebitMinor: string; totalCreditMinor: string; differenceMinor: string; balanced: boolean;
  lineCount: number;
  mapping: {
    total: number; fullyMapped: number; rootOnly: number;
    needsDetailedClassification: number; needsClassification: number;
    incompleteAccounts: Array<{ accountCode: string; accountName: string; mappingStatus: string; statementLineCode: string | null }>;
  };
}

const STATUS_BADGE: Record<string, string> = {
  DRAFT: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  UNBALANCED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  COMMITTED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
};

function fmtMinor(minor: string, minorUnits = 2): string {
  const neg = minor.startsWith("-");
  const abs = (neg ? minor.slice(1) : minor).padStart(minorUnits + 1, "0");
  const int = abs.slice(0, abs.length - minorUnits);
  const frac = minorUnits > 0 ? abs.slice(abs.length - minorUnits) : "";
  return `${neg ? "-" : ""}${Number(int).toLocaleString("en-US")}${minorUnits > 0 ? `.${frac}` : ""}`;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function TrialBalanceTab() {
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
  const canManage = perms ? canManageTrialBalances(perms, role) : false;

  const [companies, setCompanies] = React.useState<CompanyOption[]>([]);
  const [companyId, setCompanyId] = React.useState("");
  const [fiscalYears, setFiscalYears] = React.useState<FiscalYearOption[]>([]);
  const [fiscalYearId, setFiscalYearId] = React.useState("");
  const [fromPeriodOrdinal, setFromPeriodOrdinal] = React.useState("");
  const [toPeriodOrdinal, setToPeriodOrdinal] = React.useState("");
  const [dataType, setDataType] = React.useState<TrialBalanceDataType | "">("");
  const [fileName, setFileName] = React.useState("");
  const [fileHash, setFileHash] = React.useState("");
  const [rawLines, setRawLines] = React.useState<RawLine[]>([]);
  const [skippedRows, setSkippedRows] = React.useState(0);
  const [parsing, setParsing] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [preview, setPreview] = React.useState<PreviewResult | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [replaceExisting, setReplaceExisting] = React.useState(false);
  const [imports, setImports] = React.useState<ImportRow[]>([]);
  const [detail, setDetail] = React.useState<ImportRow & { lines?: Array<Record<string, unknown>> } | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  // Phase 6.3 — حوار إنشاء مراجعة لميزان معتمد
  const [revisionTarget, setRevisionTarget] = React.useState<ImportRow | null>(null);
  const [revisionReason, setRevisionReason] = React.useState("");
  const [revisionOpen, setRevisionOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  // 6.7 — رفع ملف مصحح داخل مسودة مراجعة (سد فجوة 6.3 من الواجهة)
  const revisionFileRef = React.useRef<HTMLInputElement>(null);
  const [revisionUploadTarget, setRevisionUploadTarget] = React.useState<ImportRow | null>(null);
  const [uploadingRevision, setUploadingRevision] = React.useState(false);

  const fy = fiscalYears.find((f) => f.id === fiscalYearId) ?? null;
  const fromPeriod = fy?.periods.find((p) => String(p.ordinal) === fromPeriodOrdinal) ?? null;
  const toPeriod = fy?.periods.find((p) => String(p.ordinal) === toPeriodOrdinal) ?? null;

  const loadCompanies = React.useCallback(async () => {
    const res = await fetch("/api/companies", { cache: "no-store" });
    if (res.ok) {
      const list: CompanyOption[] = await res.json().catch(() => []);
      setCompanies(list);
      setCompanyId((prev) => (prev && list.some((c) => c.id === prev) ? prev : list[0]?.id ?? ""));
    }
  }, []);

  const loadImports = React.useCallback(async () => {
    const res = await fetch("/api/trial-balances", { cache: "no-store" });
    if (res.ok) setImports(await res.json().catch(() => []));
  }, []);

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadCompanies(), loadImports()]);
      setLoading(false);
    })();
  }, [loadCompanies, loadImports]);

  React.useEffect(() => {
    setFiscalYears([]);
    setFiscalYearId("");
    setFromPeriodOrdinal("");
    setToPeriodOrdinal("");
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
    setFromPeriodOrdinal("");
    setToPeriodOrdinal("");
  }, [fiscalYearId]);

  const onFile = async (file: File | null) => {
    setRawLines([]);
    setFileName("");
    setFileHash("");
    setSkippedRows(0);
    if (!file) return;
    setParsing(true);
    try {
      const [data, hash] = await Promise.all([readExcelFile(file), sha256Hex(await file.arrayBuffer())]);
      const lines: RawLine[] = [];
      let skipped = 0;
      for (const row of data.A) {
        if (!row.num || row.num.length === 0) { skipped += 1; continue; }
        lines.push({ accountCode: row.num, accountName: row.nm, debit: row.m, credit: row.d });
      }
      setRawLines(lines);
      setSkippedRows(skipped);
      setFileName(file.name);
      setFileHash(hash);
      toast({ title: `تم تحليل الملف: ${lines.length} سطرًا`, description: skipped > 0 ? `تخطي ${skipped} صفًا بلا كود حساب.` : undefined });
    } catch (e) {
      toast({ title: "فشل تحليل ملف Excel", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setParsing(false);
    }
  };

  const runPreview = async () => {
    if (!companyId || !fy || !fromPeriod || !toPeriod || !dataType || rawLines.length === 0) return;
    setPreviewing(true);
    setPreview(null);
    setReplaceExisting(false);
    try {
      const res = await fetch("/api/trial-balances/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          fiscalYearId: fy.id,
          fromDate: fromPeriod.startDate,
          toDate: toPeriod.endDate,
          dataType,
          lines: rawLines,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setPreview(data);
      setPreviewOpen(true);
    } catch (e) {
      toast({ title: "فشل التحقق", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  };

  const saveImport = async () => {
    if (!preview || !fy) return;
    setSaving(true);
    try {
      const res = await fetch("/api/trial-balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          fiscalYearId: fy.id,
          fromDate: preview.fromDate,
          toDate: preview.toDate,
          dataType: preview.dataType,
          originalFileName: fileName,
          fileHash,
          note,
          replaceExisting,
          reason: "حفظ ميزان مراجعة من الواجهة",
          lines: rawLines,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "حُفظ ميزان المراجعة", description: data?.duplicatePayloadWarning || (preview.balanced ? "حالة: مسودة مُتحقق منها — يمكن اعتمادها الآن." : "حالة: غير متوازن — لا يمكن اعتماده.") });
      setPreviewOpen(false);
      setPreview(null);
      setRawLines([]); setFileName(""); setFileHash(""); setSkippedRows(0); setNote("");
      await loadImports();
    } catch (e) {
      toast({ title: "فشل الحفظ", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const commitImport = async (row: ImportRow) => {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/trial-balances/${row.id}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: row.version, reason: "اعتماد من الواجهة" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "اعتُمد الميزان", description: "snapshot الخريطة مجمّد — لا تتأثر التقارير التاريخية بتعديلات لاحقة." });
      await loadImports();
    } catch (e) {
      toast({ title: "فشل الاعتماد", description: e instanceof Error ? e.message : "", variant: "destructive" });
      await loadImports();
    } finally {
      setBusyId(null);
    }
  };

  // Phase 6.3 — إنشاء مسودة مراجعة لميزان معتمد (بلا overwrite — النسخة السابقة تبقى سليمة)
  const createRevision = async () => {
    if (!revisionTarget) return;
    setBusyId(revisionTarget.id);
    try {
      const res = await fetch(`/api/trial-balances/${revisionTarget.id}/revision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: revisionReason.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "أُنشئت مسودة المراجعة", description: "السطور مبذورة من المعتمد — عدّل المحتوى ثم اعتمد لتصبح المراجعة الجديدة." });
      setRevisionOpen(false);
      setRevisionTarget(null);
      setRevisionReason("");
      await loadImports();
    } catch (e) {
      toast({ title: "فشل إنشاء المراجعة", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const revalidateImport = async (row: ImportRow) => {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/trial-balances/${row.id}/revalidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: row.version, reason: "إعادة تحقق بعد تصنيف حسابات" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "أُعيد حل الخريطة", description: `مصنفة بالكامل: ${data?.summary?.fullyMapped ?? "—"} — تحتاج اهتمامًا: ${data?.summary?.needsAttention ?? "—"}` });
      await loadImports();
    } catch (e) {
      toast({ title: "فشل إعادة التحقق", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const deleteImport = async (row: ImportRow) => {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/trial-balances/${row.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: row.version, reason: "حذف مسودة من الواجهة" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "حُذف الاستيراد" });
      await loadImports();
    } catch (e) {
      toast({ title: "فشل الحذف", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const openDetail = async (row: ImportRow) => {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/trial-balances/${row.id}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setDetail(data);
      setDetailOpen(true);
    } catch (e) {
      toast({ title: "فشل جلب التفاصيل", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  // 6.7 — رفع ملف مصحح داخل مسودة مراجعة: يستبدل سطور المسودة عبر مسار revisionTargetId
  // (المدى والنوع والسنة ثابتة من المصدر المعتمد — الخادم يفرض ذلك حرفيًا).
  const handleRevisionCorrectedFile = async (file: File | null) => {
    const target = revisionUploadTarget;
    if (!file || !target) return;
    setUploadingRevision(true);
    try {
      const [data, hash] = await Promise.all([readExcelFile(file), sha256Hex(await file.arrayBuffer())]);
      const lines: RawLine[] = [];
      let skipped = 0;
      for (const row of data.A) {
        if (!row.num || row.num.length === 0) { skipped += 1; continue; }
        lines.push({ accountCode: row.num, accountName: row.nm, debit: row.m, credit: row.d });
      }
      if (lines.length === 0) throw new Error("الملف لا يحتوي سطورًا صالحة (كود الحساب مطلوب).");
      const res = await fetch("/api/trial-balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revisionTargetId: target.id,
          version: target.version,
          companyId: target.companyId,
          fiscalYearId: target.fiscalYearId,
          fromDate: target.fromDate,
          toDate: target.toDate,
          dataType: target.dataType,
          lines,
          originalFileName: file.name,
          fileHash: hash,
          reason: `رفع ملف مصحح داخل مسودة المراجعة #${target.revisionNumber}`,
        }),
      });
      const resp = await res.json().catch(() => null);
      if (!res.ok) throw new Error(resp?.error || `HTTP ${res.status}`);
      toast({
        title: `استُبدلت سطور مسودة المراجعة #${target.revisionNumber}`,
        description: `${lines.length} سطرًا${skipped > 0 ? ` (تخطي ${skipped} بلا كود)` : ""} — راجع المعاينة عبر «عرض التفاصيل» ثم اعتمد.`,
      });
      await loadImports();
    } catch (e) {
      toast({ title: "فشل رفع الملف المصحح", description: e instanceof Error ? e.message : "", variant: "destructive" });
      await loadImports();
    } finally {
      setUploadingRevision(false);
      setRevisionUploadTarget(null);
      if (revisionFileRef.current) revisionFileRef.current.value = "";
    }
  };

  const canPreview = !!(companyId && fy && fromPeriod && toPeriod && dataType && rawLines.length > 0);
  const companyFilter = imports.filter((r) => !companyId || r.companyId === companyId);

  return (
    <div className="space-y-6" dir="rtl">
      {/* ── شاشة الرفع ── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileSpreadsheet className="size-4" />
              رفع ميزان المراجعة
            </CardTitle>
            <CardDescription>
              يُرفع ميزان المراجعة مرة واحدة للشركة والفترة، ثم تقرأ منه جميع التقارير اللاحقة — لا توجد إعادة رفع لكل تقرير.
              المعاينة إلزامية قبل الحفظ، والاعتماد يجمّد خريطة الحسابات نهائيًا.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); Promise.all([loadCompanies(), loadImports()]).finally(() => setLoading(false)); }} aria-label="تحديث">
            <RefreshCw className={"size-3.5" + (loading ? " animate-spin" : "")} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="tb-company">1. الشركة</Label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger id="tb-company" aria-label="الشركة"><SelectValue placeholder="اختر شركة" /></SelectTrigger>
                <SelectContent>
                  {companies.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} — {c.nameAr}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tb-fy">السنة المالية</Label>
              <Select value={fiscalYearId} onValueChange={setFiscalYearId} disabled={!companyId}>
                <SelectTrigger id="tb-fy" aria-label="السنة المالية"><SelectValue placeholder={fy ? undefined : "اختر سنة"} /></SelectTrigger>
                <SelectContent>
                  {fiscalYears.map((f) => (
                    <SelectItem key={f.id} value={f.id}>{f.code || f.displayNameAr} ({f.startDate} → {f.endDate})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fy && <p className="text-xs text-muted-foreground">حالة السنة: {fy.status}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tb-type">4. نوع بيانات ميزان المراجعة (صريح إلزامي)</Label>
              <Select value={dataType} onValueChange={(v) => setDataType(v as TrialBalanceDataType)}>
                <SelectTrigger id="tb-type" aria-label="نوع البيانات"><SelectValue placeholder="اختر النوع" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={TB_DATA_TYPES.CUMULATIVE_YTD}>{TB_DATA_TYPE_LABELS.CUMULATIVE_YTD} (CUMULATIVE_YTD)</SelectItem>
                  <SelectItem value={TB_DATA_TYPES.PERIOD_MOVEMENT}>{TB_DATA_TYPE_LABELS.PERIOD_MOVEMENT} (PERIOD_MOVEMENT)</SelectItem>
                </SelectContent>
              </Select>
              {dataType && <p className="text-xs text-muted-foreground">{TB_DATA_TYPE_DESCRIPTIONS[dataType]}</p>}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tb-from">2. من تاريخ (بداية فترة)</Label>
              <Select value={fromPeriodOrdinal} onValueChange={setFromPeriodOrdinal} disabled={!fy}>
                <SelectTrigger id="tb-from" aria-label="من فترة"><SelectValue placeholder="اختر فترة البداية" /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {(fy?.periods ?? []).map((p) => (
                    <SelectItem key={p.id} value={String(p.ordinal)}>{p.startDate} — {p.displayLabel || p.code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tb-to">إلى تاريخ (نهاية فترة)</Label>
              <Select value={toPeriodOrdinal} onValueChange={setToPeriodOrdinal} disabled={!fy}>
                <SelectTrigger id="tb-to" aria-label="إلى فترة"><SelectValue placeholder="اختر فترة النهاية" /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {(fy?.periods ?? []).map((p) => (
                    <SelectItem key={p.id} value={String(p.ordinal)}>{p.endDate} — {p.displayLabel || p.code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[1fr_260px] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="tb-file">5. ملف Excel (Account Code / Name / Debit / Credit)</Label>
              <Input
                id="tb-file" type="file" accept=".xlsx,.xls"
                onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                disabled={!canManage || parsing}
              />
              {fileName && (
                <p className="text-xs text-muted-foreground">
                  {fileName} — {rawLines.length} سطرًا{skippedRows > 0 ? ` (تخطي ${skippedRows} بلا كود)` : ""} — بصمة: <span className="font-mono">{fileHash.slice(0, 12)}…</span>
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tb-note">ملاحظة (اختياري)</Label>
              <Input id="tb-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={runPreview} disabled={!canPreview || previewing || !canManage}>
              {previewing ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
              6. معاينة / تحقق
            </Button>
            {!canPreview && <p className="text-xs text-muted-foreground">أكمل الحقول وارفع الملف لتفعيل المعاينة.</p>}
          </div>
        </CardContent>
      </Card>

      {/* ── قائمة الميزانيات المحفوظة ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="size-4" />
            ميزانيات المراجعة المحفوظة
          </CardTitle>
          <CardDescription>المعتمد (COMMITTED) مجمّد لا يُستبدل ولا يُحذف — أي تصحيح يمر عبر «مراجعة» مرقّمة (مسار 6.3) مع بقاء النسخ السابقة سليمة للتتبع.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">الشركة</TableHead>
                  <TableHead className="text-right">المدى</TableHead>
                  <TableHead className="text-right">النوع</TableHead>
                  <TableHead className="text-right">السطور</TableHead>
                  <TableHead className="text-right">مدين / دائن</TableHead>
                  <TableHead className="text-right">الحالة</TableHead>
                  <TableHead className="text-left">إجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {companyFilter.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm">{r.company?.code} — {r.company?.nameAr}</TableCell>
                    <TableCell className="text-sm font-mono" dir="ltr">{r.fromDate} → {r.toDate}</TableCell>
                    <TableCell className="text-xs">{r.dataType === TB_DATA_TYPES.CUMULATIVE_YTD ? TB_DATA_TYPE_LABELS.CUMULATIVE_YTD : TB_DATA_TYPE_LABELS.PERIOD_MOVEMENT}</TableCell>
                    <TableCell className="text-sm">{r.lineCount}</TableCell>
                    <TableCell className="text-sm font-mono" dir="ltr">
                      {fmtMinor(r.totalDebitMinor)} / {fmtMinor(r.totalCreditMinor)}
                      {r.status !== "COMMITTED" && r.totalDebitMinor !== r.totalCreditMinor && (
                        <TriangleAlert className="ms-1 inline size-3.5 text-rose-600" aria-label="غير متوازن" />
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge className={STATUS_BADGE[r.status] ?? ""}>{TB_STATUS_LABELS[r.status as keyof typeof TB_STATUS_LABELS] ?? r.status}</Badge>
                        <Badge
                          variant="outline"
                          className="font-mono text-[10px]"
                          title={[
                            r.revisionReason || "الاستيراد الأول",
                            r.supersedesImportId ? `يحل محل: ${r.supersedesImportId.slice(0, 8)}…` : null,
                            r.createdByName ? `أنشئ بواسطة: ${r.createdByName}` : null,
                            r.createdAt ? `بتاريخ: ${new Date(r.createdAt).toLocaleString("ar")}` : null,
                            r.committedAt ? `اعتُمد: ${new Date(r.committedAt).toLocaleString("ar")}` : null,
                          ].filter(Boolean).join(" — ")}
                        >
                          مراجعة #{r.revisionNumber}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-left">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" aria-label="عرض التفاصيل" onClick={() => openDetail(r)} disabled={busyId === r.id}>
                          <Eye className="size-3.5" />
                        </Button>
                        {canManage && r.status === "COMMITTED" && (
                          <Button variant="ghost" size="sm" aria-label="إنشاء مراجعة" onClick={() => { setRevisionTarget(r); setRevisionReason(""); setRevisionOpen(true); }} disabled={busyId === r.id}>
                            <GitBranch className="size-3.5 text-amber-600" />
                          </Button>
                        )}
                        {canManage && r.status === "DRAFT" && (
                          <>
                            <Button variant="ghost" size="sm" aria-label="إعادة تحقق الخريطة" onClick={() => revalidateImport(r)} disabled={busyId === r.id}>
                              <RefreshCw className="size-3.5" />
                            </Button>
                            {r.supersedesImportId && (
                              <Button
                                variant="ghost" size="sm"
                                aria-label="رفع ملف مصحح داخل المراجعة"
                                title="رفع ملف Excel مصحح ليستبدل سطور مسودة المراجعة (المدى والنوع ثابتان من المصدر المعتمد)"
                                onClick={() => { setRevisionUploadTarget(r); if (revisionFileRef.current) revisionFileRef.current.click(); }}
                                disabled={busyId === r.id || uploadingRevision}
                              >
                                {uploadingRevision && revisionUploadTarget?.id === r.id ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5 text-sky-600" />}
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" aria-label="اعتماد" onClick={() => commitImport(r)} disabled={busyId === r.id}>
                              <ShieldCheck className="size-3.5 text-emerald-600" />
                            </Button>
                            <Button variant="ghost" size="sm" aria-label="حذف" onClick={() => deleteImport(r)} disabled={busyId === r.id}>
                              <Trash2 className="size-3.5 text-rose-600" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {companyFilter.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="h-16 text-center text-sm text-muted-foreground">لا ميزانيات محفوظة بعد.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ── حوار المعاينة ── */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle>معاينة ميزان المراجعة — قبل الحفظ</DialogTitle>
            <DialogDescription>لا يُحفظ أي شيء قبل مراجعتك. الحسابات غير المكتملة تُعرض بوضوح ولا تمنع حفظ مسودة، لكن الاعتماد يتطلب التوازن.</DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="space-y-4 max-h-[60vh] overflow-y-auto">
              <div className="grid gap-2 rounded-md border p-3 text-sm">
                <p><span className="text-muted-foreground">الشركة:</span> {preview.company.code} — {preview.company.nameAr}</p>
                <p><span className="text-muted-foreground">السنة المالية:</span> {preview.fiscalYear.code} ({preview.fiscalYear.startDate} → {preview.fiscalYear.endDate}) — تبدأ الفترات من {preview.coveredPeriodLabels[0] ?? preview.fromDate}</p>
                <p><span className="text-muted-foreground">المدى:</span> <span className="font-mono" dir="ltr">{preview.fromDate} → {preview.toDate}</span> (فترات {preview.startOrdinal} إلى {preview.endOrdinal})</p>
                <p><span className="text-muted-foreground">النوع:</span> {preview.dataType} — {TB_DATA_TYPE_DESCRIPTIONS[preview.dataType as TrialBalanceDataType]}</p>
              </div>
              <div className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm md:grid-cols-4">
                <div><p className="text-xs text-muted-foreground">عدد الحسابات</p><p className="font-semibold">{preview.lineCount}</p></div>
                <div><p className="text-xs text-muted-foreground">إجمالي مدين</p><p className="font-mono">{fmtMinor(preview.totalDebitMinor)}</p></div>
                <div><p className="text-xs text-muted-foreground">إجمالي دائن</p><p className="font-mono">{fmtMinor(preview.totalCreditMinor)}</p></div>
                <div>
                  <p className="text-xs text-muted-foreground">الفرق</p>
                  <p className={"font-mono font-semibold " + (preview.balanced ? "text-emerald-600" : "text-rose-600")}>{fmtMinor(preview.differenceMinor)}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className={"rounded-md border p-2 " + (preview.balanced ? "border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20" : "border-rose-300 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/30")}>
                  <p className="text-xs text-muted-foreground">الأخطاء</p>
                  <p className={"font-semibold " + (preview.balanced ? "text-emerald-700" : "text-rose-700")}>
                    {preview.balanced ? 0 : 1} — {preview.balanced ? "لا أخطاء (متوازن)" : "اختلال التوازن: مدين ≠ دائن"}
                  </p>
                </div>
                <div className={"rounded-md border p-2 " + ((preview.mapping.needsClassification + preview.mapping.needsDetailedClassification) === 0 ? "border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20" : "border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30")}>
                  <p className="text-xs text-muted-foreground">التحذيرات (حسابات بلا تصنيف كافٍ)</p>
                  <p className={"font-semibold " + ((preview.mapping.needsClassification + preview.mapping.needsDetailedClassification) === 0 ? "text-emerald-700" : "text-amber-700")}>
                    {preview.mapping.needsClassification + preview.mapping.needsDetailedClassification}
                  </p>
                </div>
              </div>
              {!preview.balanced && (
                <p className="flex items-center gap-2 rounded-md bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
                  <TriangleAlert className="size-4" />
                  مدين ≠ دائن — سيُحفظ بحالة «غير متوازن» ولا يمكن اعتماده إطلاقًا ولا إصدار قوائم منه.
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">مصنّفة بالكامل</p><p className="font-semibold text-emerald-700">{preview.mapping.fullyMapped}</p></div>
                <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">من الجذر فقط (ROOT_ONLY)</p><p className="font-semibold text-amber-600">{preview.mapping.rootOnly}</p></div>
                <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">تحتاج تصنيفًا تفصيليًا</p><p className="font-semibold text-orange-600">{preview.mapping.needsDetailedClassification}</p></div>
                <div className="rounded-md border p-2"><p className="text-xs text-muted-foreground">غير مصنفة</p><p className="font-semibold text-rose-600">{preview.mapping.needsClassification}</p></div>
              </div>
              {preview.mapping.incompleteAccounts.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                  <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
                    <TriangleAlert className="size-4" />
                    حسابات تحتاج تصنيفًا ({preview.mapping.incompleteAccounts.length}) — صنّفها من تبويب «دليل الحسابات وقواعد التصنيف» ثم استخدم «إعادة تحقق الخريطة» بلا إعادة رفع الملف.
                  </p>
                  <div className="max-h-40 overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-right">الكود</TableHead>
                          <TableHead className="text-right">الاسم</TableHead>
                          <TableHead className="text-right">الحالة</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.mapping.incompleteAccounts.slice(0, 100).map((a) => (
                          <TableRow key={a.accountCode}>
                            <TableCell className="font-mono text-xs">{a.accountCode}</TableCell>
                            <TableCell className="text-xs">{a.accountName || "—"}</TableCell>
                            <TableCell className="text-xs">{MAPPING_STATUS_LABELS[a.mappingStatus as MappingStatus] ?? a.mappingStatus}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Checkbox id="tb-replace" checked={replaceExisting} onCheckedChange={(v) => setReplaceExisting(v === true)} />
                <Label htmlFor="tb-replace" className="font-normal">
                  استبدال استيراد قائم لنفس المدى/النوع إن وُجد (مسودة فقط — المعتمد لا يُستبدل أبدًا)
                </Label>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPreviewOpen(false)} disabled={saving}>إلغاء</Button>
            <Button onClick={saveImport} disabled={saving || !preview}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              7. اعتماد الحفظ (مسودة)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── حوار التفاصيل ── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              تفاصيل ميزان المراجعة
              {detail && <Badge variant="outline" className="font-mono text-[10px]">مراجعة #{detail.revisionNumber}</Badge>}
              {detail?.status && <Badge className={STATUS_BADGE[detail.status] ?? ""}>{TB_STATUS_LABELS[detail.status as keyof typeof TB_STATUS_LABELS] ?? detail.status}</Badge>}
            </DialogTitle>
            <DialogDescription>
              {detail?.company?.code} — <span className="font-mono" dir="ltr">{detail?.fromDate} → {detail?.toDate}</span> ({detail?.dataType})
              {detail?.originalFileName ? ` — ${detail.originalFileName}` : ""}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="grid gap-1.5 rounded-md border bg-muted/40 p-3 text-xs leading-5 sm:grid-cols-2">
              <p><span className="text-muted-foreground">السنة المالية:</span> {detail.fiscalYear?.code} ({detail.fiscalYear?.startDate} → {detail.fiscalYear?.endDate})</p>
              <p><span className="text-muted-foreground">أنشئ بواسطة:</span> {detail.createdByName || "—"} — <span className="tnum">{new Date(detail.createdAt).toLocaleString("ar")}</span></p>
              <p>
                <span className="text-muted-foreground">يحل محل:</span>{" "}
                {detail.supersedesImportId ? <span className="font-mono" dir="ltr">{detail.supersedesImportId.slice(0, 10)}…</span> : "— (الاستيراد الأول)"}
              </p>
              <p>
                <span className="text-muted-foreground">سبب المراجعة:</span> {detail.revisionReason || "—"}
              </p>
              <p>
                <span className="text-muted-foreground">الاعتماد:</span>{" "}
                {detail.committedAt ? <span className="tnum">اعتُمد {new Date(detail.committedAt).toLocaleString("ar")}{detail.committedByName ? ` بواسطة ${detail.committedByName}` : ""}</span> : "غير معتمد بعد"}
              </p>
              <p><span className="text-muted-foreground">بصمة المحتوى:</span> <span className="font-mono" dir="ltr">{detail.payloadHash?.slice(0, 16) || "—"}…</span></p>
            </div>
          )}
          <div className="max-h-[60vh] overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">الكود</TableHead>
                  <TableHead className="text-right">الاسم</TableHead>
                  <TableHead className="text-left">مدين</TableHead>
                  <TableHead className="text-left">دائن</TableHead>
                  <TableHead className="text-left">الصافي</TableHead>
                  <TableHead className="text-right">الحالة</TableHead>
                  <TableHead className="text-right">البند المالي</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(detail?.lines ?? []).map((l) => {
                  const row = l as { accountCode: string; accountName: string; debitMinor: string; creditMinor: string; netMinor: string; mappingStatus: string | null; statementLineCode: string | null };
                  return (
                    <TableRow key={String(row.accountCode)}>
                      <TableCell className="font-mono text-xs">{row.accountCode}</TableCell>
                      <TableCell className="text-xs">{row.accountName || "—"}</TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">{fmtMinor(row.debitMinor)}</TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">{fmtMinor(row.creditMinor)}</TableCell>
                      <TableCell className="font-mono text-xs" dir="ltr">{fmtMinor(row.netMinor)}</TableCell>
                      <TableCell className="text-xs">{row.mappingStatus ? (MAPPING_STATUS_LABELS[row.mappingStatus as MappingStatus] ?? row.mappingStatus) : "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{row.statementLineCode ?? "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailOpen(false)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Phase 6.3 — حوار إنشاء مراجعة لميزان معتمد ── */}
      <Dialog open={revisionOpen} onOpenChange={setRevisionOpen}>
        <DialogContent className="max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle>إنشاء مراجعة لميزان معتمد</DialogTitle>
            <DialogDescription>
              {revisionTarget?.company?.code} — <span className="font-mono" dir="ltr">{revisionTarget?.fromDate} → {revisionTarget?.toDate}</span> ({revisionTarget?.dataType}) — المراجعة الحالية #{revisionTarget?.revisionNumber}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="rounded-md bg-muted p-3 leading-6">
              ستُنشأ <span className="font-semibold">مسودة مراجعة جديدة (رقم {revisionTarget ? revisionTarget.revisionNumber + 1 : "—"})</span> مبذورة بسطور النسخة المعتمدة.
              النسخة المعتمدة الحالية تبقى سليمة تمامًا ولا تُعدّل ولا تُحذف، ولن تتأثر التقارير حتى تعتمد المراجعة الجديدة.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="tb-revision-reason">سبب المراجعة (إلزامي)</Label>
              <Input
                id="tb-revision-reason"
                value={revisionReason}
                onChange={(e) => setRevisionReason(e.target.value)}
                maxLength={300}
                placeholder="مثال: تصحيح مبلغ المبيعات بعد كشف خطأ إدخال"
              />
              {!revisionReason.trim() && <p className="text-xs text-muted-foreground">لا تُنشأ مراجعة بلا سبب موثق — السبب يُسجل في التدقيق.</p>}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRevisionOpen(false)} disabled={!!busyId}>إلغاء</Button>
            <Button onClick={createRevision} disabled={!!busyId || !revisionReason.trim()}>
              {busyId ? <Loader2 className="size-4 animate-spin" /> : <GitBranch className="size-4" />}
              إنشاء مسودة المراجعة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 6.7 — إدخال مخفي لرفع ملف مصحح داخل مسودة مراجعة */}
      <input
        ref={revisionFileRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => handleRevisionCorrectedFile(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}
