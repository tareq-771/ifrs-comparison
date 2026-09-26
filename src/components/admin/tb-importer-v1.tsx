"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Phase 7.0 (V1 closure) — مستورد ميزان المراجعة الموجّه (المستورد الجديد V1)
// نظام التقارير المالية الموحدة — مسار خمس خطوات:
//   1. الملف  2. الأعمدة/الإسناد  3. المراجعة (معاينة خادمية)  4. المسودة  5. الاعتماد
//
// العقد المقفل:
//  • الخادم هو السلطة الوحيدة: المعاينة عبر /api/tb-import-v2/preview، الحفظ عبر
//    /draft، والاعتماد عبر /commit — كلها تعيد إرسال المصدر الخام + القرارات
//    الصريحة، ولا تُرسل أي قيم محاسبية مُطبَّعة من العميل أبدًا.
//  • «حفظ المسودة» معطّل مع أي خطأ مانع في المعاينة؛ «الاعتماد» يتطلب مسودة
//    محفوظة + مصدرًا خامًا متاحًا + تأكيدًا صريحًا فوريًا.
//  • بعد تحديث الصفحة: المصدر الخام غير موجود ⇒ إعادة اختيار الملف إلزامية
//    (المصدر لا يُدّعى محفوظًا — الإثبات موجز حصرًا في AuditLog).
//  • المعاينة/المسودة/المعتمد حالات مميزة بصريًا — لا عرض للمسودة كبيانات نهائية.
// ═══════════════════════════════════════════════════════════════════════════

import * as React from "react";
import { useSession } from "next-auth/react";
import {
  CheckCircle2, Download, Eye, FileSpreadsheet, FileUp, GitBranch, Layers,
  Loader2, Lock, RefreshCw, ShieldCheck, Table2, TriangleAlert,
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
import {
  extractTbSourceRows,
  flagSuspectedSubtotalRows,
  mapTbHeaders,
  requiredFieldsForShape,
  suggestTbShape,
  TB_CANONICAL_FIELDS,
  TB_FIELD_LABELS,
  TB_SHAPE_DESCRIPTORS,
  type TbCanonicalField,
  type TbGrid,
  type TbImportShape,
} from "@/lib/tb-import";
import { readTbWorkbookGrid, parseCsvGrid, TbGridReaderError } from "@/lib/excel-grid";
import { CURRENCIES } from "@/lib/currencies";
import { canManageTrialBalances, parsePermissions } from "@/lib/permissions";
import {
  canCommitDraft,
  canSaveDraft,
  requiresSourceReselection,
  tbImportErrorLabel,
  TB_WIZARD_STATUS_LABELS,
  type TbPreviewLike,
} from "@/lib/tb-import-ui";

/* ── أنواع العرض ─────────────────────────────────────────────────────────── */

interface CompanyOption { id: string; code: string; nameAr: string; status: string; functionalCurrency?: string | null; }
interface FiscalYearOption {
  id: string; code: string; displayNameAr: string; startDate: string; endDate: string; status: string;
  periods: Array<{ id: string; ordinal: number; code: string; startDate: string; endDate: string; status: string; displayLabel: string }>;
}
interface ParsedFile {
  name: string;
  hash: string;
  sheetName: string;
  grid: TbGrid;
  rowCount: number;
  colCount: number;
}
interface ServerIssue { code: string; message: string; }
interface ServerPreview {
  schemaVersion: string;
  confirmedShape: TbImportShape;
  suggestedShape: { suggestion: TbImportShape; reason: string } | null;
  mapping: { byField: Record<string, { index: number; tier: string; rawHeader: string }>; };
  company: { id: string; code: string; nameAr: string; functionalCurrency: string | null };
  fiscalYear: { id: string; code: string; displayNameAr: string };
  period: { ordinal: number; startDate: string; endDate: string; displayLabel: string };
  sourceCurrency: string | null;
  functionalCurrency: string | null;
  minorUnits: number;
  completeness: string;
  sourceRowCount: number;
  acceptedDetailRowCount: number;
  excludedSubtotalRowCount: number;
  unresolvedSubtotalRows: number[];
  duplicateAccounts: Array<{ accountCode: string; count: number; sourceRowNumbers: number[] }>;
  numericSourceCodeCount: number;
  formulaCellWarningCount: number;
  classificationSummary: Record<string, number>;
  classificationErrors: Array<{ sourceRowNumber: number; accountCode: string; mappingStatus: string }>;
  controlTotals: Record<string, { debitMinor: string; creditMinor: string; differenceMinor: string }>;
  rowEquationFailureCount: number;
  rowEquationFailures: Array<{ sourceRowNumber: number; accountCode: string; differenceMinor: string }>;
  normalizedConsumedLineCount: number;
  canonicalLineHash: string | null;
  sourcePayloadHash: string | null;
  derivedDataType: string | null;
  blockingErrors: ServerIssue[];
  warnings: ServerIssue[];
  priorAsOfDisclosure: {
    hasPriorData: boolean;
    comparedCount: number;
    differenceCount: number;
    differences: Array<{ accountCode: string; sourceOpeningNetMinor: string; priorNetMinor: string; differenceMinor: string }>;
  } | null;
  validationStatus: "VALID" | "BLOCKED";
  persistenceReady: boolean;
}
interface DraftRow {
  id: string; companyId: string; fromDate: string; toDate: string; dataType: string; status: string;
  revisionNumber: number; originalFileName: string; payloadHash: string; version: number;
  lineCount: number; totalDebitMinor: string; totalCreditMinor: string;
  company?: { code: string; nameAr: string } | null;
  createdAt: string;
}
interface DraftDetail {
  id: string; status: string; dataType: string; revisionNumber: number; version: number;
  fromDate: string; toDate: string; originalFileName: string; payloadHash: string; fileHash: string;
  lineCount: number; totalDebitMinor: string; totalCreditMinor: string; note: string;
  company?: { code: string; nameAr: string } | null;
  lines: Array<Record<string, unknown>>;
}

const STEPS: Array<{ n: number; label: string }> = [
  { n: 1, label: "الملف" },
  { n: 2, label: "الأعمدة / الإسناد" },
  { n: 3, label: "المراجعة" },
  { n: 4, label: "المسودة" },
  { n: 5, label: "الاعتماد" },
];

const SHAPE_LABELS: Record<TbImportShape, string> = {
  FULL_MOVEMENT: "حركة كاملة (افتتاح + فترة + إقفال)",
  CLOSING_ONLY: "أرصدة إقفال فقط",
  MOVEMENT_ONLY: "حركة الفترة فقط",
  LEGACY: "إرث (غير متاح للمستورد الجديد)",
};

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fmtMinor(minor: string, minorUnits = 2): string {
  const neg = minor.startsWith("-");
  const abs = (neg ? minor.slice(1) : minor).padStart(minorUnits + 1, "0");
  const int = abs.slice(0, abs.length - minorUnits);
  const frac = minorUnits > 0 ? abs.slice(abs.length - minorUnits) : "";
  return `${neg ? "-" : ""}${Number(int).toLocaleString("en-US")}${minorUnits > 0 ? `.${frac}` : ""}`;
}

export function TbImporterV1() {
  const { data: session } = useSession();
  const { toast } = useToast();

  const perms = React.useMemo(() => {
    if (!session?.user) return null;
    const raw = (session.user as unknown as { permissions?: unknown }).permissions;
    if (typeof raw === "string") return parsePermissions(raw);
    if (raw && typeof raw === "object") return parsePermissions(JSON.stringify(raw));
    return null;
  }, [session]);
  const role = ((session?.user as unknown as { role?: string })?.role as string) || "user";
  const canManage = perms ? canManageTrialBalances(perms, role) : false;

  /* ── الحالة ── */
  const [step, setStep] = React.useState(1);
  const [companies, setCompanies] = React.useState<CompanyOption[]>([]);
  const [companyId, setCompanyId] = React.useState("");
  const [fiscalYears, setFiscalYears] = React.useState<FiscalYearOption[]>([]);
  const [fiscalYearId, setFiscalYearId] = React.useState("");
  const [periodOrdinal, setPeriodOrdinal] = React.useState("");
  const [file, setFile] = React.useState<ParsedFile | null>(null);
  const [parsing, setParsing] = React.useState(false);
  const [fileInputKey, setFileInputKey] = React.useState(0);

  const [mapping, setMapping] = React.useState<Record<number, TbCanonicalField>>({});
  const [shape, setShape] = React.useState<TbImportShape | "">("");
  const [flowDeclared, setFlowDeclared] = React.useState(false);
  const [sourceCurrency, setSourceCurrency] = React.useState("");
  const [completeness, setCompleteness] = React.useState<"COMPLETE" | "SUBSET" | "">("");
  const [subsetAck, setSubsetAck] = React.useState(false);
  const [subtotalResolutions, setSubtotalResolutions] = React.useState<Record<number, "KEPT" | "EXCLUDED">>({});
  const [note, setNote] = React.useState("");
  const [replaceExisting, setReplaceExisting] = React.useState(false);

  const [preview, setPreview] = React.useState<ServerPreview | null>(null);
  const [previewedSignature, setPreviewedSignature] = React.useState("");
  const [previewing, setPreviewing] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  const [saving, setSaving] = React.useState(false);
  const [savedDraft, setSavedDraft] = React.useState<DraftRow | null>(null);
  const [drafts, setDrafts] = React.useState<DraftRow[]>([]);
  const [loadingDrafts, setLoadingDrafts] = React.useState(false);
  const [detail, setDetail] = React.useState<DraftDetail | null>(null);
  const [detailProvenance, setDetailProvenance] = React.useState<Array<Record<string, unknown>>>([]);
  const [detailOpen, setDetailOpen] = React.useState(false);

  const [selectedDraft, setSelectedDraft] = React.useState<DraftRow | null>(null);
  const [commitReason, setCommitReason] = React.useState("");
  const [commitDialogOpen, setCommitDialogOpen] = React.useState(false);
  const [committing, setCommitting] = React.useState(false);
  const [commitResult, setCommitResult] = React.useState<{ importId: string; committedAt: string; revalidated: boolean } | null>(null);

  /* ── التحميلات ── */
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/companies", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (alive && Array.isArray(data)) setCompanies(data as CompanyOption[]);
      } catch { /* fail-closed — لا شركات ⇒ لا بدء */ }
    })();
    return () => { alive = false; };
  }, []);

  React.useEffect(() => {
    if (!companyId) { setFiscalYears([]); setFiscalYearId(""); setPeriodOrdinal(""); return; }
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/fiscal-years?companyId=${encodeURIComponent(companyId)}`, { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (alive && Array.isArray(data)) {
          setFiscalYears(data as FiscalYearOption[]);
          setFiscalYearId("");
          setPeriodOrdinal("");
        }
      } catch { /* fail-closed */ }
    })();
    return () => { alive = false; };
  }, [companyId]);

  const loadDrafts = React.useCallback(async () => {
    setLoadingDrafts(true);
    try {
      const res = await fetch("/api/trial-balances", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (Array.isArray(data)) {
        setDrafts((data as DraftRow[]).filter((r) => r.status === "DRAFT"));
      }
    } catch { /* عرض لاحق */ } finally {
      setLoadingDrafts(false);
    }
  }, []);

  React.useEffect(() => { void loadDrafts(); }, [loadDrafts]);

  /* ── مشتقات ── */
  const fy = fiscalYears.find((f) => f.id === fiscalYearId) ?? null;
  const period = fy?.periods.find((p) => String(p.ordinal) === periodOrdinal) ?? null;
  const company = companies.find((c) => c.id === companyId) ?? null;

  const headerTexts = React.useMemo(() => (file?.grid[0] ?? []).map((c) => c.text), [file]);
  const clientMapping = React.useMemo(
    () => mapTbHeaders(headerTexts, { userMappings: mapping }),
    [headerTexts, mapping],
  );
  const requiredFields = React.useMemo(
    () => (shape ? requiredFieldsForShape(shape) : []),
    [shape],
  );
  const missingFields = React.useMemo(
    () => (shape ? requiredFields.filter((f) => clientMapping.byField[f] === undefined) : []),
    [shape, requiredFields, clientMapping],
  );
  const shapeSuggestion = React.useMemo(() => suggestTbShape(clientMapping), [clientMapping]);

  const flaggedRows = React.useMemo(() => {
    if (!file || Object.keys(clientMapping.byField).length === 0) return [];
    const rows = extractTbSourceRows(file.grid, { mapping: clientMapping, headerRowIndex: 0, headerRowCount: 1 });
    return flagSuspectedSubtotalRows(rows);
  }, [file, clientMapping]);

  const signature = React.useMemo(
    () => JSON.stringify([file?.hash ?? "", shape, mapping, flowDeclared, sourceCurrency, completeness, subsetAck, subtotalResolutions, companyId, fiscalYearId, periodOrdinal]),
    [file, shape, mapping, flowDeclared, sourceCurrency, completeness, subsetAck, subtotalResolutions, companyId, fiscalYearId, periodOrdinal],
  );
  const previewStale = preview !== null && signature !== previewedSignature;
  const previewLike: TbPreviewLike | null = preview
    ? { validationStatus: preview.validationStatus, persistenceReady: preview.persistenceReady }
    : null;
  const saveEnabled = canSaveDraft(previewLike, previewStale) && canManage;
  const hasRawSource = file !== null;
  const commitEnabled = canCommitDraft(selectedDraft, hasRawSource) && canManage && !committing;
  const sourceReselectionNeeded = requiresSourceReselectionAdapter(hasRawSource, selectedDraft !== null);

  /* ── بناء الحمولة المشتركة (معاينة/حفظ = نفس القرارات الصريحة) ── */
  function buildPayload(): Record<string, unknown> {
    if (!file || !period) return {};
    return {
      companyId,
      fiscalYearId,
      fromDate: period.startDate,
      toDate: period.endDate,
      shape,
      grid: file.grid,
      mapping,
      sourceCurrency,
      completeness,
      subsetAcknowledged: completeness === "SUBSET" ? subsetAck : false,
      flowClosingSemantics: shape === "CLOSING_ONLY" && flowDeclared ? "CUMULATIVE_YTD" : null,
      subtotalResolutions,
      originalFileName: file.name,
      fileHash: file.hash,
      note,
    };
  }

  /* ── المعالجات ── */
  async function onFile(f: File | null) {
    if (!f) return;
    setParsing(true);
    setPreview(null);
    setPreviewError(null);
    setSubtotalResolutions({});
    try {
      const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
      const buf = await f.arrayBuffer();
      const hash = await sha256Hex(buf);
      let parsed: { sheetName: string; grid: TbGrid };
      if (ext === ".csv") {
        const text = new TextDecoder("utf-8").decode(buf);
        parsed = { sheetName: "CSV", grid: parseCsvGrid(text) };
      } else if (ext === ".xlsx") {
        parsed = readTbWorkbookGrid(new Uint8Array(buf), f.name);
      } else {
        throw new TbGridReaderError(
          ext === ".xls"
            ? "UNSUPPORTED_LEGACY_XLS: ملفات .xls القديمة مرفوضة — استخدم .xlsx أو .csv"
            : `UNSUPPORTED_TB_FILE_EXTENSION: «${ext}» — المدعوم .xlsx/.csv فقط`,
        );
      }
      if (parsed.grid.length === 0) throw new TbGridReaderError("EMPTY_TB_FILE: ملف فارغ");
      const headers = (parsed.grid[0] ?? []).map((c) => c.text);
      const auto = mapTbHeaders(headers, {});
      const autoUser: Record<number, TbCanonicalField> = {};
      for (const [field, idx] of Object.entries(auto.byField)) {
        autoUser[idx] = field as TbCanonicalField;
      }
      setFile({
        name: f.name,
        hash,
        sheetName: parsed.sheetName,
        grid: parsed.grid,
        rowCount: parsed.grid.length,
        colCount: parsed.grid[0]?.length ?? 0,
      });
      setMapping(autoUser);
      toast({
        title: "تم تحليل الملف محليًا",
        description: `${parsed.grid.length - 1} صفًا — ${parsed.grid[0]?.length ?? 0} عمودًا — الصيغ لا تُنفَّذ والأكواد النصية تُحفظ كما هي.`,
      });
    } catch (e) {
      setFile(null);
      toast({
        title: "فشل تحليل الملف",
        description: e instanceof Error ? e.message : "خطأ غير معروف",
        variant: "destructive",
      });
    } finally {
      setParsing(false);
      setFileInputKey((k) => k + 1);
    }
  }

  async function runPreview() {
    if (!file || !period) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch("/api/tb-import-v2/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const resp = await res.json().catch(() => null);
      if (!res.ok) {
        const code = typeof resp?.code === "string" ? resp.code : "";
        setPreview(null);
        setPreviewError(code ? tbImportErrorLabel(code, resp?.error) : String(resp?.error ?? `HTTP ${res.status}`));
        return;
      }
      setPreview(resp as ServerPreview);
      setPreviewedSignature(signature);
      setStep(3);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "خطأ");
    } finally {
      setPreviewing(false);
    }
  }

  async function saveDraft() {
    if (!saveEnabled || !preview) return;
    setSaving(true);
    try {
      const res = await fetch("/api/tb-import-v2/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const resp = await res.json().catch(() => null);
      if (!res.ok) {
        const code = typeof resp?.code === "string" ? resp.code : "";
        toast({
          title: "فشل حفظ المسودة",
          description: code ? tbImportErrorLabel(code, resp?.error) : String(resp?.error ?? `HTTP ${res.status}`),
          variant: "destructive",
        });
        return;
      }
      // جلب التفاصيل القيانية (version للقفل المتفائل + عرض كامل)
      const detailRes = await fetch(`/api/trial-balances/${encodeURIComponent(resp.importId)}`, { cache: "no-store" });
      const detailData = await detailRes.json().catch(() => null);
      const row: DraftRow | null = detailData && typeof detailData === "object"
        ? {
            id: detailData.id as string,
            companyId: detailData.companyId as string,
            fromDate: detailData.fromDate as string,
            toDate: detailData.toDate as string,
            dataType: detailData.dataType as string,
            status: detailData.status as string,
            revisionNumber: detailData.revisionNumber as number,
            originalFileName: detailData.originalFileName as string,
            payloadHash: detailData.payloadHash as string,
            version: detailData.version as number,
            lineCount: detailData.lineCount as number,
            totalDebitMinor: detailData.totalDebitMinor as string,
            totalCreditMinor: detailData.totalCreditMinor as string,
            company: (detailData.company as DraftRow["company"]) ?? null,
            createdAt: detailData.createdAt as string,
          }
        : null;
      if (row) {
        setSavedDraft(row);
        setSelectedDraft(row);
      }
      await loadDrafts();
      toast({
        title: `حُفظت المسودة ${resp.importId.slice(0, 8)}…`,
        description: `${resp.lineCount} سطرًا — ${resp.status} — تحقق خادمي كامل من المصدر الخام.`,
      });
      setStep(4);
    } catch (e) {
      toast({ title: "فشل حفظ المسودة", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(id: string) {
    try {
      const res = await fetch(`/api/trial-balances/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error(String(data?.error ?? `HTTP ${res.status}`));
      const provRes = await fetch(`/api/tb-import-v2/draft?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const provData = await provRes.json().catch(() => null);
      setDetail(data as DraftDetail);
      setDetailProvenance(
        Array.isArray(provData?.provenance) ? (provData.provenance as Array<Record<string, unknown>>) : [],
      );
      setDetailOpen(true);
    } catch (e) {
      toast({ title: "فشل فتح المسودة", description: e instanceof Error ? e.message : "", variant: "destructive" });
    }
  }

  async function runCommit() {
    if (!commitEnabled || !selectedDraft || !file) return;
    setCommitting(true);
    try {
      const res = await fetch("/api/tb-import-v2/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          importId: selectedDraft.id,
          version: selectedDraft.version,
          reason: commitReason,
          grid: file.grid,
        }),
      });
      const resp = await res.json().catch(() => null);
      if (!res.ok) {
        const code = typeof resp?.code === "string" ? resp.code : "";
        toast({
          title: "فُضل الاعتماد — لم يُعتمد شيء",
          description: code ? tbImportErrorLabel(code, resp?.error) : String(resp?.error ?? `HTTP ${res.status}`),
          variant: "destructive",
        });
        return;
      }
      setCommitResult({
        importId: resp.import.id as string,
        committedAt: resp.import.committedAt as string,
        revalidated: resp.provenanceCommitEventWritten === true,
      });
      setSavedDraft(null);
      setSelectedDraft(null);
      setCommitDialogOpen(false);
      await loadDrafts();
      toast({
        title: "اعتُمد ميزان المراجعة",
        description: "إعادة تحقق كاملة من المصدر الخام: تطابق هاش المصدر والسطور والمسودة المخزنة — المعتمد الآن مجمّد.",
      });
      setStep(5);
    } catch (e) {
      toast({ title: "فشل الاعتماد", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setCommitting(false);
    }
  }

  function setFieldMapping(colIndex: number, field: TbCanonicalField | "") {
    setMapping((prev) => {
      const next: Record<number, TbCanonicalField> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (v !== field) next[Number(k)] = v; // منع هدف مكرر: سحب الحقل من عمود آخر
      }
      if (field !== "") next[colIndex] = field;
      return next;
    });
  }

  const canPreview =
    !!file && !!period && shape !== "" && missingFields.length === 0 &&
    sourceCurrency !== "" && completeness !== "" && (completeness !== "SUBSET" || subsetAck) && canManage && !previewing;

  /* ═══ العرض ═══ */
  return (
    <div className="space-y-4" dir="rtl">
      {/* شريط الخطوات */}
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="خطوات المستورد">
        {STEPS.map((s) => (
          <button
            key={s.n}
            role="tab"
            aria-selected={step === s.n}
            onClick={() => setStep(s.n)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              step === s.n
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
            }`}
          >
            {s.n}. {s.label}
          </button>
        ))}
        <span className="ms-auto flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{TB_WIZARD_STATUS_LABELS.PREVIEW}</Badge>
          <Badge className="bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300">{TB_WIZARD_STATUS_LABELS.DRAFT}</Badge>
          <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">{TB_WIZARD_STATUS_LABELS.COMMITTED}</Badge>
        </span>
      </div>

      {/* ══ 1. الملف ══ */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><FileUp className="size-4" />1. الملف والإطار الزمني</CardTitle>
            <CardDescription>
              اختر الشركة والسنة والفترة (فترة واحدة حصرًا)، ثم ارفع ملف .xlsx أو .csv — يُحلَّل محليًا في متصفحك
              (النص الظاهر هو الحاكم، الصيغ لا تُنفَّذ، وأكواد الحسابات تُحفظ نصيًا مع أصفارها الرائدة).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="v1-company">الشركة</Label>
                <Select value={companyId} onValueChange={setCompanyId}>
                  <SelectTrigger id="v1-company" aria-label="الشركة"><SelectValue placeholder="اختر شركة" /></SelectTrigger>
                  <SelectContent>
                    {companies.map((c) => <SelectItem key={c.id} value={c.id}>{c.code} — {c.nameAr}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="v1-fy">السنة المالية</Label>
                <Select value={fiscalYearId} onValueChange={setFiscalYearId} disabled={!companyId}>
                  <SelectTrigger id="v1-fy" aria-label="السنة المالية"><SelectValue placeholder={fy ? undefined : "اختر سنة"} /></SelectTrigger>
                  <SelectContent>
                    {fiscalYears.map((f) => (
                      <SelectItem key={f.id} value={f.id}>{f.code || f.displayNameAr} ({f.startDate} → {f.endDate})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="v1-period">الفترة (فترة واحدة حصرًا)</Label>
                <Select value={periodOrdinal} onValueChange={setPeriodOrdinal} disabled={!fy}>
                  <SelectTrigger id="v1-period" aria-label="الفترة"><SelectValue placeholder="اختر فترة" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {(fy?.periods ?? []).map((p) => (
                      <SelectItem key={p.id} value={String(p.ordinal)}>{p.startDate} → {p.endDate} — {p.displayLabel || p.code}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="v1-file">ملف المصدر (.xlsx / .csv — يُرفض .xls)</Label>
                <Input
                  key={fileInputKey}
                  id="v1-file"
                  type="file"
                  accept=".xlsx,.csv"
                  onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
                  disabled={!canManage || parsing}
                />
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <a href="/api/tb-import-v2/template?format=xlsx" download aria-label="تنزيل قالب Excel">
                    <Button type="button" variant="outline" size="sm"><Download className="size-3.5" />قالب Excel</Button>
                  </a>
                  <a href="/api/tb-import-v2/template?format=csv" download aria-label="تنزيل مثال CSV">
                    <Button type="button" variant="outline" size="sm"><Download className="size-3.5" />مثال CSV</Button>
                  </a>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="v1-currency">عملة المصدر (صريحة إلزامية)</Label>
                <Select value={sourceCurrency} onValueChange={setSourceCurrency}>
                  <SelectTrigger id="v1-currency" aria-label="عملة المصدر"><SelectValue placeholder="اختر العملة" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {Object.keys(CURRENCIES).map((code) => (
                      <SelectItem key={code} value={code}>{code}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  العملة الوظيفية للشركة: <span className="font-mono">{company?.functionalCurrency || "غير مهيأة"}</span>
                  {" "}— إذا اختلفت عن عملة المصدر فالتحويل غير مدعوم في هذا الإصدار.
                </p>
              </div>
            </div>

            {file && (
              <div className="rounded-md border bg-muted/40 p-3 text-xs" dir="rtl">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="flex items-center gap-1 font-medium"><FileSpreadsheet className="size-3.5" />{file.name}</span>
                  <span>{file.sheetName !== "CSV" ? `الورقة: ${file.sheetName}` : "CSV"}</span>
                  <span>{Math.max(0, file.rowCount - 1)} صف بيانات × {file.colCount} عمود</span>
                  <span className="font-mono" dir="ltr">SHA-256: {file.hash.slice(0, 12)}…</span>
                  {file.rowCount - 1 > 5000 && (
                    <span className="flex items-center gap-1 text-rose-700 dark:text-rose-300">
                      <TriangleAlert className="size-3.5" />يتجاوز حد المستورد الخادمي (5000 صف) — سيُرفض.
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button onClick={() => setStep(2)} disabled={!file || !period || !shapeConfirmableLater()}>
                متابعة: الأعمدة والإسناد
              </Button>
              {!file && <p className="text-xs text-muted-foreground">ارفع الملف أولًا لتفعيل المتابعة.</p>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ══ 2. الأعمدة/الإسناد ══ */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Table2 className="size-4" />2. إسناد الأعمدة + تأكيد الشكل</CardTitle>
            <CardDescription>
              الإسناد التلقائي اقتراح قابل للتصحيح — الحقول المطلوبة للشكل يجب أن تُسند كلها بلا التباس ولا هدف مكرر.
              الشكل تأكيد صريح منك ولا يُخمَّن أبدًا (لا يُختار LEGACY تلقائيًا).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">الحقل القياني</TableHead>
                    <TableHead className="text-right">العمود المُسند</TableHead>
                    <TableHead className="text-right">الترويسة المكتشفة</TableHead>
                    <TableHead className="text-right">مصدر الإسناد</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {TB_CANONICAL_FIELDS.map((field) => {
                    const mappedIndex = clientMapping.byField[field];
                    const col = clientMapping.columns.find((c) => c.sourceColumnIndex === mappedIndex);
                    const usedElsewhere = Object.entries(mapping).find(([k, v]) => v === field);
                    return (
                      <TableRow key={field}>
                        <TableCell className="text-sm font-medium">
                          {TB_FIELD_LABELS[field].ar}
                          <span className="block text-[10px] text-muted-foreground" dir="ltr">{field} / {TB_FIELD_LABELS[field].en}</span>
                        </TableCell>
                        <TableCell className="w-44">
                          <Select
                            value={mappedIndex === undefined ? "__none__" : String(mappedIndex)}
                            onValueChange={(v) => setFieldMapping(Number(v), field)}
                          >
                            <SelectTrigger aria-label={`إسناد ${field}`}><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent className="max-h-64">
                              <SelectItem value="__none__">(بلا إسناد)</SelectItem>
                              {(file?.grid[0] ?? []).map((cell, idx) => {
                                const currentField = mapping[idx];
                                const takenByOther = currentField !== undefined && currentField !== field;
                                return (
                                  <SelectItem key={idx} value={String(idx)} disabled={takenByOther}>
                                    عمود {idx + 1}: {(cell.text || "(فارغ)").slice(0, 30)}
                                  </SelectItem>
                                );
                              })}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-xs" title={col?.rawHeader ?? ""}>{col?.rawHeader ?? "—"}</TableCell>
                        <TableCell>
                          {mappedIndex === undefined ? (
                            usedElsewhere ? (
                              <Badge variant="outline" className="text-rose-700 dark:text-rose-300">مُسند لعمود آخر</Badge>
                            ) : (
                              <Badge variant="outline">غير مُسند</Badge>
                            )
                          ) : (
                            <Badge variant="outline" className="font-mono text-[10px]">{col?.tier ?? "USER"}</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <div className="space-y-2">
              <Label>الشكل (تأكيد صريح إلزامي)</Label>
              <div className="grid gap-2 md:grid-cols-3">
                {(["FULL_MOVEMENT", "CLOSING_ONLY", "MOVEMENT_ONLY"] as const).map((s) => (
                  <label
                    key={s}
                    className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition-colors ${
                      shape === s ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                    }`}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <input
                        type="radio"
                        name="tb-shape"
                        value={s}
                        checked={shape === s}
                        onChange={() => { setShape(s); setFlowDeclared(false); }}
                        aria-label={SHAPE_LABELS[s]}
                      />
                      {SHAPE_LABELS[s]}
                    </span>
                    <span className="text-xs text-muted-foreground" dir="ltr">{s}</span>
                    <span className="text-[11px] leading-4 text-muted-foreground">{TB_SHAPE_DESCRIPTORS[s].notes[0]}</span>
                  </label>
                ))}
              </div>
              {shapeSuggestion.suggestion && (
                <p className="text-xs text-muted-foreground">
                  اقتراح المحرك من الترويسات: <span className="font-mono">{shapeSuggestion.suggestion}</span> — الاقتراح لا يغيّر تأكيدك أبدًا.
                </p>
              )}
              {shape === "CLOSING_ONLY" && (
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
                  <Checkbox
                    id="v1-flow-ytd"
                    checked={flowDeclared}
                    onCheckedChange={(v) => setFlowDeclared(v === true)}
                    aria-label="إقرار التراكمي"
                  />
                  <div>
                    <Label htmlFor="v1-flow-ytd" className="cursor-pointer">أقرّ أن أرصدة حسابات قائمة الدخل (إن وُجدت) في عمودَي الإقفال تمثل أرصدة تراكمية حتى نهاية الفترة (YTD)</Label>
                    <p className="mt-1 text-xs text-muted-foreground">
                      إذا وُجدت حسابات قائمة الدخل (FLOW) بلا هذا الإقراض فسيرفض الخادم الاعتماد برمز FLOW_CLOSING_SEMANTICS_UNDECLARED.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>اكتمال الملف</Label>
                <div className="flex flex-wrap gap-3">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="radio" name="tb-completeness" checked={completeness === "COMPLETE"} onChange={() => setCompleteness("COMPLETE")} aria-label="COMPLETE" />
                    كامل (COMPLETE)
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="radio" name="tb-completeness" checked={completeness === "SUBSET"} onChange={() => setCompleteness("SUBSET")} aria-label="SUBSET" />
                    جزئي (SUBSET)
                  </label>
                </div>
                {completeness === "SUBSET" && (
                  <div className="flex items-start gap-2 rounded-md border p-3 text-sm">
                    <Checkbox id="v1-subset" checked={subsetAck} onCheckedChange={(v) => setSubsetAck(v === true)} aria-label="إقرار الجزئية" />
                    <Label htmlFor="v1-subset" className="cursor-pointer leading-5">
                      أقرّ صراحةً أن هذا الملف ليس ميزان المراجعة الكامل للشركة — مجاميعه لا تثبت توازن ميزان الشركة الكامل.
                    </Label>
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="v1-note">ملاحظة (اختياري)</Label>
                <Input id="v1-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
              </div>
            </div>

            {missingFields.length > 0 && (
              <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
                حقول مطلوبة للشكل {shape} غير مُسندة: {missingFields.map((f) => TB_FIELD_LABELS[f].ar).join("، ")}.
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setStep(1)}>رجوع</Button>
              <Button onClick={() => setStep(3)} disabled={!canPreview}>متابعة: المراجعة والمعاينة الخادمية</Button>
              {completeness === "SUBSET" && !subsetAck && <p className="text-xs text-muted-foreground">إقرار الجزئية مطلوب.</p>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ══ 3. المراجعة ══ */}
      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Eye className="size-4" />3. المراجعة — المعاينة الخادمية الحاكمة</CardTitle>
            <CardDescription>
              المعاينة تُشتق حصريًا على الخادم من المصدر الخام وقراراتك — قيم العرض هنا استنتاج خادمي لا حساب متصفح.
              أي خطأ مانع يمنع الحفظ؛ التحذيرات لا تمنع.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void runPreview()} disabled={!canPreview}>
                {previewing ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
                طلب معاينة خادمية
              </Button>
              <Button variant="outline" onClick={() => setStep(2)}>رجوع للإسناد</Button>
              {preview && previewStale && (
                <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                  تغيّرت القرارات — المعاينة قديمة، أعد الطلب
                </Badge>
              )}
              {preview && !previewStale && (
                <Badge className={preview.validationStatus === "VALID"
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                  : "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300"}>
                  {preview.validationStatus === "VALID" ? "صالحة — جاهزة للحفظ كمسودة" : "مرفوضة — أخطاء مانعة"}
                </Badge>
              )}
            </div>

            {previewError && (
              <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
                {previewError}
              </div>
            )}

            {preview && (
              <div className="space-y-4">
                {/* ملخص الدلالة */}
                <div className="grid gap-2 rounded-md border p-3 text-xs md:grid-cols-4">
                  <div><span className="text-muted-foreground">الشكل:</span> <span className="font-mono">{preview.confirmedShape}</span></div>
                  <div><span className="text-muted-foreground">dataType مشتق:</span> <span className="font-mono">{preview.derivedDataType ?? "—"}</span></div>
                  <div><span className="text-muted-foreground">الاكتمال:</span> <span className="font-mono">{preview.completeness}</span></div>
                  <div><span className="text-muted-foreground">العملة:</span> <span className="font-mono">{preview.sourceCurrency} → {preview.functionalCurrency}</span> (دقة {preview.minorUnits})</div>
                  <div><span className="text-muted-foreground">صفوف المصدر:</span> {preview.sourceRowCount}</div>
                  <div><span className="text-muted-foreground">صفوف مقبولة:</span> {preview.acceptedDetailRowCount}</div>
                  <div><span className="text-muted-foreground">مجاميع مستبعدة:</span> {preview.excludedSubtotalRowCount}</div>
                  <div><span className="text-muted-foreground">سطور ستُخزَّن:</span> {preview.normalizedConsumedLineCount}</div>
                </div>

                {/* أخطاء مانعة */}
                {preview.blockingErrors.length > 0 && (
                  <div className="rounded-md border border-rose-300 bg-rose-50 p-3 dark:border-rose-900 dark:bg-rose-950/40">
                    <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-rose-800 dark:text-rose-300">
                      <TriangleAlert className="size-4" />أخطاء مانعة ({preview.blockingErrors.length}) — تمنع الحفظ والاعتماد
                    </p>
                    <ul className="space-y-1 text-xs">
                      {preview.blockingErrors.map((e, i) => (
                        <li key={i} className="text-rose-800 dark:text-rose-300">{tbImportErrorLabel(e.code, e.message)}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* تحذيرات */}
                {preview.warnings.length > 0 && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                    <p className="mb-2 text-sm font-medium text-amber-800 dark:text-amber-300">تحذيرات ({preview.warnings.length}) — لا تمنع</p>
                    <ul className="space-y-1 text-xs text-amber-800 dark:text-amber-200">
                      {preview.warnings.map((w, i) => (
                        <li key={i}>{w.message} <span className="font-mono text-[10px]" dir="ltr">[{w.code}]</span></li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* حسم المجاميع */}
                {flaggedRows.length > 0 && (
                  <div className="rounded-md border p-3">
                    <p className="mb-2 text-sm font-medium">صفوف مجاميع مشتبهة — يلزم حسم صريح (إبقاء/استبعاد) لكل صف</p>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-right">الصف</TableHead>
                            <TableHead className="text-right">الكود</TableHead>
                            <TableHead className="text-right">الاسم</TableHead>
                            <TableHead className="text-right">سبب الاشتباه</TableHead>
                            <TableHead className="text-right">الحسم</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {flaggedRows.map((flag) => {
                            const row = file?.grid[flag.sourceRowNumber - 1] ?? [];
                            const codeIdx = clientMapping.byField.ACCOUNT_CODE;
                            const nameIdx = clientMapping.byField.ACCOUNT_NAME;
                            const res = subtotalResolutions[flag.sourceRowNumber];
                            return (
                              <TableRow key={flag.sourceRowNumber}>
                                <TableCell className="text-xs">{flag.sourceRowNumber}</TableCell>
                                <TableCell className="font-mono text-xs">{codeIdx === undefined ? "" : row[codeIdx]?.text}</TableCell>
                                <TableCell className="max-w-40 truncate text-xs">{nameIdx === undefined ? "" : row[nameIdx]?.text}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {flag.matchedIn === "CODE" ? "الكود" : "الاسم"} يحوي «{flag.matchedKeyword}»
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-3 text-xs">
                                    <label className="flex items-center gap-1">
                                      <input
                                        type="radio"
                                        name={`sub-${flag.sourceRowNumber}`}
                                        checked={res === "KEPT"}
                                        onChange={() => setSubtotalResolutions((p) => ({ ...p, [flag.sourceRowNumber]: "KEPT" }))}
                                        aria-label={`إبقاء الصف ${flag.sourceRowNumber}`}
                                      />
                                      إبقاء (KEPT)
                                    </label>
                                    <label className="flex items-center gap-1">
                                      <input
                                        type="radio"
                                        name={`sub-${flag.sourceRowNumber}`}
                                        checked={res === "EXCLUDED"}
                                        onChange={() => setSubtotalResolutions((p) => ({ ...p, [flag.sourceRowNumber]: "EXCLUDED" }))}
                                        aria-label={`استبعاد الصف ${flag.sourceRowNumber}`}
                                      />
                                      استبعاد (EXCLUDED)
                                    </label>
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}

                {/* تكرار الأكواد */}
                {preview.duplicateAccounts.length > 0 && (
                  <div className="rounded-md border border-rose-300 bg-rose-50 p-3 dark:border-rose-900 dark:bg-rose-950/40">
                    <p className="mb-2 text-sm font-medium text-rose-800 dark:text-rose-300">أكواد حسابات مكررة — تمنع الحفظ (لا تجميع ولا استبدال)</p>
                    <ul className="space-y-1 text-xs text-rose-800 dark:text-rose-300">
                      {preview.duplicateAccounts.map((d) => (
                        <li key={d.accountCode} className="font-mono" dir="ltr">
                          {d.accountCode} × {d.count} — rows {d.sourceRowNumbers.join(", ")}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* مجاميع الضبط */}
                {Object.keys(preview.controlTotals).length > 0 && (
                  <div className="rounded-md border p-3">
                    <p className="mb-2 text-sm font-medium">مجاميع الضبط من المصدر (وحدات صغرى)</p>
                    <div className="grid gap-2 text-xs md:grid-cols-3">
                      {Object.entries(preview.controlTotals).map(([group, t]) => (
                        <div key={group} className="rounded border p-2 font-mono" dir="ltr">
                          <div className="font-sans font-medium">{group}</div>
                          <div>Dr {t.debitMinor} / Cr {t.creditMinor}</div>
                          <div className={t.differenceMinor === "0" ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}>
                            Δ {t.differenceMinor}
                          </div>
                        </div>
                      ))}
                    </div>
                    {preview.completeness === "SUBSET" && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        ملف جزئي (SUBSET): هذه المجاميع تخص الملف فقط ولا تثبت توازن ميزان الشركة الكامل.
                      </p>
                    )}
                  </div>
                )}

                {/* إفصاح الفترة السابقة */}
                {preview.priorAsOfDisclosure && (
                  <div className="rounded-md border p-3 text-xs">
                    <p className="mb-1 text-sm font-medium">إفصاح مقارنة الافتتاحي مع المعتمد السابق (إفصاح فقط — لا يمنع)</p>
                    {!preview.priorAsOfDisclosure.hasPriorData ? (
                      <p className="text-muted-foreground">لا توجد بيانات فترة سابقة معتمدة للمقارنة.</p>
                    ) : (
                      <p className="text-muted-foreground">
                        قورنت {preview.priorAsOfDisclosure.comparedCount} حسابًا — اختلافات: {preview.priorAsOfDisclosure.differenceCount}
                        {preview.priorAsOfDisclosure.differences.length > 0 && (
                          <span className="ms-2 font-mono" dir="ltr">
                            ({preview.priorAsOfDisclosure.differences.slice(0, 5).map((d) => `${d.accountCode}: Δ${d.differenceMinor}`).join(", ")})
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                )}

                {/* الهاشتان */}
                {preview.sourcePayloadHash && preview.canonicalLineHash && (
                  <div className="rounded-md border bg-muted/40 p-3 text-xs">
                    <p className="font-medium">بصمات الخادم (تُقارن حرفيًا عند الاعتماد)</p>
                    <p className="mt-1 font-mono" dir="ltr">sourcePayloadHash: {preview.sourcePayloadHash.slice(0, 24)}…</p>
                    <p className="font-mono" dir="ltr">canonicalLineHash: {preview.canonicalLineHash.slice(0, 24)}…</p>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setStep(2)}>رجوع</Button>
              <Button onClick={() => void saveDraft()} disabled={!saveEnabled || saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Layers className="size-4" />}
                حفظ كمسودة (إعادة تحقق خادمية كاملة)
              </Button>
              {preview && !saveEnabled && !previewStale && preview.validationStatus === "BLOCKED" && (
                <p className="text-xs text-rose-700 dark:text-rose-300">حفظ المسودة معطّل: توجد أخطاء مانعة.</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ══ 4. المسودة ══ */}
      {step === 4 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Layers className="size-4" />4. المسودة — فتح ومراجعة واختيار للاعتماد</CardTitle>
            <CardDescription>
              المسودة بيانات مُتحقق منها غير نهائية — لا تُعرض أبدًا كمعتمدة. الإثبات المحفوظ موجز (بلا شبكة مصدر)،
              واعتماد أي مسودة بعد تحديث الصفحة يتطلب إعادة اختيار ملف المصدر لإعادة التحقق.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {savedDraft && (
              <div className="rounded-md border border-sky-300 bg-sky-50 p-3 text-xs dark:border-sky-900 dark:bg-sky-950/40">
                <p className="mb-1 flex items-center gap-1.5 text-sm font-medium text-sky-900 dark:text-sky-200">
                  <CheckCircle2 className="size-4" />آخر مسودة محفوظة في هذه الجلسة
                </p>
                <div className="grid gap-1 md:grid-cols-3">
                  <span>المعرف: <span className="font-mono" dir="ltr">{savedDraft.id.slice(0, 10)}…</span></span>
                  <span>الحالة: {savedDraft.status} — مراجعة #{savedDraft.revisionNumber} — نسخة {savedDraft.version}</span>
                  <span>النوع: <span className="font-mono">{savedDraft.dataType}</span></span>
                  <span>المدى: <span className="font-mono" dir="ltr">{savedDraft.fromDate} → {savedDraft.toDate}</span></span>
                  <span>السطور: {savedDraft.lineCount}</span>
                  <span>بصمة السطور: <span className="font-mono" dir="ltr">{savedDraft.payloadHash.slice(0, 12)}…</span></span>
                </div>
              </div>
            )}

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">مسودات قائمة (مرئية لك)</p>
                <Button variant="ghost" size="sm" onClick={() => void loadDrafts()} aria-label="تحديث المسودات">
                  <RefreshCw className={"size-3.5" + (loadingDrafts ? " animate-spin" : "")} />
                </Button>
              </div>
              <div className="max-h-96 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-right">الشركة</TableHead>
                      <TableHead className="text-right">المدى</TableHead>
                      <TableHead className="text-right">النوع</TableHead>
                      <TableHead className="text-right">الملف</TableHead>
                      <TableHead className="text-left">إجراءات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {drafts.length === 0 && (
                      <TableRow><TableCell colSpan={5} className="text-center text-xs text-muted-foreground">لا مسودات.</TableCell></TableRow>
                    )}
                    {drafts.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="text-xs">{d.company?.code} — {d.company?.nameAr}</TableCell>
                        <TableCell className="font-mono text-xs" dir="ltr">{d.fromDate} → {d.toDate}</TableCell>
                        <TableCell className="font-mono text-[10px]">{d.dataType}</TableCell>
                        <TableCell className="max-w-32 truncate text-xs">{d.originalFileName || "—"}</TableCell>
                        <TableCell className="text-left">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" aria-label="عرض" onClick={() => void openDetail(d.id)}><Eye className="size-3.5" /></Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label="اختيار للاعتماد"
                              onClick={() => { setSelectedDraft(d); setCommitResult(null); setStep(5); }}
                            ><GitBranch className="size-3.5" /></Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setStep(3)}>رجوع للمراجعة</Button>
              <Button onClick={() => setStep(5)} disabled={!selectedDraft}>متابعة: الاعتماد</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ══ 5. الاعتماد ══ */}
      {step === 5 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4" />5. الاعتماد — إعادة تحقق إلزامية من المصدر الخام</CardTitle>
            <CardDescription>
              الاعتماد يعيد إرسال المصدر الخام إلى الخادم فيعيد تشغيل التحقق الكامل ويطابق الهاشتين والسطور المخزنة حرفيًا،
              ثم يستخدم دورة الاعتماد القائمة (المعتمد يصبح مجمّدًا نهائيًا).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {commitResult ? (
              <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/40">
                <p className="flex items-center gap-1.5 font-medium text-emerald-900 dark:text-emerald-200">
                  <Lock className="size-4" />اعتُمد وسُجّل — {TB_WIZARD_STATUS_LABELS.COMMITTED}
                </p>
                <div className="mt-2 space-y-1 text-xs text-emerald-900 dark:text-emerald-200">
                  <p>المعرف: <span className="font-mono" dir="ltr">{commitResult.importId}</span></p>
                  <p>تاريخ الاعتماد: <span className="font-mono" dir="ltr">{commitResult.committedAt}</span></p>
                  <p>إعادة تحقق الاعتماد موثقة في الإثبات: {commitResult.revalidated ? "نعم" : "لم يُكتب حدث الإثبات (الاعتماد نفسه ناجح)"}</p>
                </div>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => { setCommitResult(null); setStep(1); }}>استيراد جديد</Button>
              </div>
            ) : (
              <>
                {!selectedDraft && (
                  <div className="rounded-md border p-3 text-sm text-muted-foreground">
                    اختر مسودة من الخطوة 4 أولًا — الاعتماد يتطلب مسودة محفوظة بإثبات مستورد.
                  </div>
                )}
                {selectedDraft && (
                  <div className="space-y-3">
                    <div className="rounded-md border p-3 text-xs">
                      <p className="mb-1 text-sm font-medium">المسودة المختارة</p>
                      <div className="grid gap-1 md:grid-cols-3">
                        <span>المعرف: <span className="font-mono" dir="ltr">{selectedDraft.id.slice(0, 10)}…</span></span>
                        <span>المدى: <span className="font-mono" dir="ltr">{selectedDraft.fromDate} → {selectedDraft.toDate}</span></span>
                        <span>النسخة (version): {selectedDraft.version}</span>
                      </div>
                    </div>

                    {sourceReselectionNeeded ? (
                      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
                        <p className="font-medium text-amber-900 dark:text-amber-200">يلزم إعادة اختيار ملف المصدر</p>
                        <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                          المصدر الخام لا يُخزَّن على الخادم — أعد اختيار نفس الملف ليعيد الخادم التحقق منه قبل الاعتماد
                          (SOURCE_REVALIDATION_REQUIRED).
                        </p>
                        <Input
                          className="mt-2"
                          type="file"
                          accept=".xlsx,.csv"
                          onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
                          disabled={!canManage || parsing}
                          aria-label="إعادة اختيار ملف المصدر"
                        />
                      </div>
                    ) : (
                      file && (
                        <div className="rounded-md border bg-muted/40 p-3 text-xs">
                          ملف الجلسة الحالي: <span className="font-medium">{file.name}</span> — بصمة <span className="font-mono" dir="ltr">{file.hash.slice(0, 12)}…</span>
                          <span className="ms-2 text-muted-foreground">(سيُعاد إرساله خامًا للتحقق — إن كان ملفًا مختلفًا سيرفض الخادم الاعتماد)</span>
                        </div>
                      )
                    )}

                    <div className="space-y-1.5">
                      <Label htmlFor="v1-commit-reason">سبب الاعتماد (اختياري)</Label>
                      <Input id="v1-commit-reason" value={commitReason} onChange={(e) => setCommitReason(e.target.value)} maxLength={300} />
                    </div>

                    <div className="flex items-center gap-2">
                      <Button variant="outline" onClick={() => setStep(4)}>رجوع</Button>
                      <Button
                        onClick={() => setCommitDialogOpen(true)}
                        disabled={!commitEnabled}
                      >
                        <ShieldCheck className="size-4" />اعتماد نهائي…
                      </Button>
                      {selectedDraft && !hasRawSource && (
                        <p className="text-xs text-rose-700 dark:text-rose-300">الاعتماد معطّل: أعد اختيار ملف المصدر.</p>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* حوار تأكيد الاعتماد */}
      <Dialog open={commitDialogOpen} onOpenChange={setCommitDialogOpen}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>تأكيد الاعتماد النهائي</DialogTitle>
            <DialogDescription>
              سيُعاد إرسال المصدر الخام لإعادة التحقق الكامل، وعند النجاح تصبح المسودة معتمدة مجمّدة لا تُعدل ولا تُحذف —
              التصحيح اللاحق يمر عبر مسار المراجعات المرقّمة حصرًا. هل تريد المتابعة؟
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCommitDialogOpen(false)}>إلغاء</Button>
            <Button onClick={() => void runCommit()} disabled={committing}>
              {committing ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
              تأكيد الاعتماد
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار تفاصيل المسودة */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl" dir="rtl">
          <DialogHeader>
            <DialogTitle>تفاصيل المسودة المحفوظة</DialogTitle>
            <DialogDescription>
              السطور المخزنة والإثبات الموجز — المسودة ليست بيانات نهائية.
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="grid gap-1 rounded-md border p-3 text-xs md:grid-cols-3">
                <span>الحالة: <Badge variant="outline">{detail.status}</Badge></span>
                <span>النوع: <span className="font-mono">{detail.dataType}</span></span>
                <span>مراجعة #{detail.revisionNumber} — نسخة {detail.version}</span>
                <span>المدى: <span className="font-mono" dir="ltr">{detail.fromDate} → {detail.toDate}</span></span>
                <span>السطور: {detail.lineCount}</span>
                <span>الملف: {detail.originalFileName || "—"}</span>
                <span className="font-mono" dir="ltr">payloadHash: {detail.payloadHash.slice(0, 16)}…</span>
                <span className="font-mono" dir="ltr">fileHash: {detail.fileHash ? detail.fileHash.slice(0, 16) + "…" : "—"}</span>
                <span>ملاحظة: {detail.note || "—"}</span>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">السطور المخزنة (معاينة محدودة)</p>
                <div className="max-h-64 overflow-y-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">الصف</TableHead>
                        <TableHead className="text-right">الكود</TableHead>
                        <TableHead className="text-right">الاسم</TableHead>
                        <TableHead className="text-right">مدين</TableHead>
                        <TableHead className="text-right">دائن</TableHead>
                        <TableHead className="text-right">التصنيف</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(detail.lines ?? []).slice(0, 200).map((l, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{String(l.rowIndex ?? "")}</TableCell>
                          <TableCell className="font-mono text-xs">{String(l.accountCode ?? "")}</TableCell>
                          <TableCell className="max-w-32 truncate text-xs">{String(l.accountName ?? "")}</TableCell>
                          <TableCell className="font-mono text-xs" dir="ltr">{String(l.debitMinor ?? "")}</TableCell>
                          <TableCell className="font-mono text-xs" dir="ltr">{String(l.creditMinor ?? "")}</TableCell>
                          <TableCell className="text-[10px]">{String(l.classification ?? "")}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">الإثبات المحفوظ (موجز محدود الحدود — بلا شبكة مصدر)</p>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/40 p-2 text-[10px]">
                  {detailProvenance.length === 0 && <p className="text-muted-foreground">لا إثبات (مسودة خارج المستورد V1).</p>}
                  {detailProvenance.map((p, i) => (
                    <p key={i} className="font-mono" dir="ltr">
                      {String(p.createdAt ?? "")} — {String((p.metadata as Record<string, unknown>)?.schemaVersion ?? "")}
                      {" — "}src:{String((p.metadata as Record<string, unknown>)?.sourcePayloadHash ?? "").slice(0, 12)}…
                      {" — "}lines:{String((p.metadata as Record<string, unknown>)?.canonicalLineHash ?? "").slice(0, 12)}…
                      {((p.metadata as Record<string, unknown>)?.phase ?? "") === "COMMIT_REVALIDATION" ? " — COMMIT-REVALIDATED" : ""}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailOpen(false)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** تكيّف عرضي: هل يلزم إعادة اختيار المصدر؟ (يبقي الاستدعاء الموحد في مكان واحد) */
function requiresSourceReselectionAdapter(hasRawSource: boolean, draftExists: boolean): boolean {
  return requiresSourceReselection(hasRawSource, draftExists);
}

/** شرط إتاحة زر «متابعة» من خطوة الملف (شكل مؤكد لاحقًا في الخطوة 2) */
function shapeConfirmableLater(): boolean {
  return true;
}
