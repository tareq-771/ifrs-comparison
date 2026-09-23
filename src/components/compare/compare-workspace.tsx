"use client";

import * as React from "react";
import { useSession } from "next-auth/react";
import { motion } from "framer-motion";
import { ArrowLeftRight, Download, Play, Settings2, FileSpreadsheet, Info, BarChart3, Table2, Calculator, ChevronDown, Scale, Save, FolderOpen, Trash2, BookCheck, FolderPlus, Pencil, FolderX, Loader2, ShieldCheck, AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { FileDropzone, type FileStatus } from "@/components/accounts/file-dropzone";
import { SummaryCards } from "@/components/accounts/summary-cards";
import { ResultsTable } from "@/components/accounts/results-table";
import { WorkflowPanel } from "@/components/accounts/workflow-panel";
import { ReconciliationsDashboard } from "@/components/dashboard/reconciliations-dashboard";
import { WORKFLOW_STATUS_LABELS, WORKFLOW_STATUS_BADGE_CLASS, type WorkflowInfo } from "@/lib/workflow";
import { ChartResultsTable } from "@/components/accounts/chart-results-table";
import { ChartsView } from "@/components/accounts/charts-view";
import { FinancialAnalysis } from "@/components/accounts/financial-analysis";
import { BsPrefixSelect } from "@/components/accounts/bs-prefix-select";
import { AccountSelect } from "@/components/accounts/account-select";
import { parsePermissions, DEFAULT_USER_PERMISSIONS, type Permissions } from "@/lib/permissions";
import {
  type FileData, type MatchedRow, type CategorySettings, type CompareMode,
  type BalanceSheetSettings, type BalanceSheetTotals, type RatioGroup,
  calcTotals, categorize, categorizeBalanceSheet, collectBaseOptions, computeRatios,
  exportToExcel, exportChartToExcel, findNetRow, fmtAmount,
  matchFiles, matchChartOfAccounts, readExcelFile, reExtract,
} from "@/lib/accounts";

/* ── Column-select helper ──────────────────────────────────────────────── */

function ColumnSelect({ headers, value, onChange, placeholder }: {
  headers: string[]; value: number | null; onChange: (v: number) => void; placeholder: string;
}) {
  return (
    <Select value={value == null ? "" : String(value)} onValueChange={(v) => onChange(Number(v))} disabled={headers.length === 0}>
      <SelectTrigger className="w-full" size="sm"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent className="max-h-72">
        {headers.map((h, j) => (
          <SelectItem key={j} value={String(j)}>
            <span className="text-muted-foreground">{j}</span>{" — "}<span className="truncate">{h || `(فارغ ${j})`}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* ── Prefix input helper ──────────────────────────────────────────────── */

function PrefixInput({ id, label, value, onChange, disabled }: {
  id: string; label: string; value: string; onChange: (v: string) => void; disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} className="tnum w-full" dir="ltr" placeholder="—" disabled={disabled} />
    </div>
  );
}

/* ── Server-time formatting (عرض «آخر تعديل» من بيانات الخادم لا ساعة الجهاز) ── */

const serverTimeFmt = new Intl.DateTimeFormat("ar", {
  dateStyle: "medium",
  timeStyle: "medium",
  numberingSystem: "latn",
});

/** تنسيق وقت قادم من الخادم (ISO) — وقت محلي منسق + ISO-UTC للدقة بلا التباس. */
function fmtServerDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${serverTimeFmt.format(d)} · ${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
  } catch {
    return iso;
  }
}

/* ── Page ──────────────────────────────────────────────────────────────── */

export function CompareWorkspace() {
  const { toast } = useToast();
  const { data: session } = useSession();

  // Parse current user permissions from session (stored as JSON string)
  const perms = React.useMemo<Permissions>(() => {
    if (!session?.user) return { ...DEFAULT_USER_PERMISSIONS };
    const raw = (session.user as any).permissions;
    if (typeof raw === "string") return parsePermissions(raw);
    if (raw && typeof raw === "object") return { ...DEFAULT_USER_PERMISSIONS, ...raw };
    return { ...DEFAULT_USER_PERMISSIONS };
  }, [session]);

  const canAdd = perms.add;
  const canDelete = perms.delete;
  const canExport = perms.export;
  const canManageGroups = perms.groups;
  const canManageUsers = perms.manageUsers;
  const settingsLocked = !perms.settings;
  const currentUserId = (session?.user as any)?.id as string | undefined;
  // المرحلة 3.5 — حوكمة الاستحقاق (المدير يمتلكها ضمنيًا بالدور)
  const canAssignWorkflowFlag = (session?.user as any)?.role === "admin" || perms.assignWorkflow === true;

  // المرحلة 3.5 — مفتاح العرض: مساحة العمل | لوحة المتابعة (بلا route جديد — بلا فقد لجلسة العمل)
  const [mainView, setMainView] = React.useState<"workspace" | "dashboard">("workspace");

  const [raw1, setRaw1] = React.useState<FileData | null>(null);
  const [raw2, setRaw2] = React.useState<FileData | null>(null);
  const [cn1, setCn1] = React.useState<number | null>(null);
  const [cd1, setCd1] = React.useState<number | null>(null);
  const [cn2, setCn2] = React.useState<number | null>(null);
  const [cd2, setCd2] = React.useState<number | null>(null);
  const [status1, setStatus1] = React.useState<FileStatus>({ kind: "idle" });
  const [status2, setStatus2] = React.useState<FileStatus>({ kind: "idle" });

  // Balance sheet files (optional — 2 files in period mode: comparative + current,
  // 1 file in month mode: cumulative only; hidden entirely in chart mode)
  const [bsRaw1, setBsRaw1] = React.useState<FileData | null>(null);
  const [bsCn1, setBsCn1] = React.useState<number | null>(null);
  const [bsCd1, setBsCd1] = React.useState<number | null>(null);
  const [bsStatus1, setBsStatus1] = React.useState<FileStatus>({ kind: "idle" });
  const [bsRaw2, setBsRaw2] = React.useState<FileData | null>(null);
  const [bsCn2, setBsCn2] = React.useState<number | null>(null);
  const [bsCd2, setBsCd2] = React.useState<number | null>(null);
  const [bsStatus2, setBsStatus2] = React.useState<FileStatus>({ kind: "idle" });
  const [bsOpen, setBsOpen] = React.useState(false);

  // Comparison mode: "period" = current vs previous, "monthCumulative" = month vs year
  const [compareMode, setCompareMode] = React.useState<CompareMode>("period");
  const [numMonths, setNumMonths] = React.useState(12);

  const [l1, setL1] = React.useState("");
  const [l2, setL2] = React.useState("");
  const [base, setBase] = React.useState<string | null>(null);

  // 7 IFRS prefixes
  const [costPrefix, setCostPrefix] = React.useState("31101");
  const [sellPrefix, setSellPrefix] = React.useState("31103");
  const [adminPrefix, setAdminPrefix] = React.useState("312");
  const [otherOpPrefix, setOtherOpPrefix] = React.useState("313");
  const [financePrefix, setFinancePrefix] = React.useState("321");
  const [taxPrefix, setTaxPrefix] = React.useState("61");
  const [ociPrefix, setOciPrefix] = React.useState("72");

  // 5 Balance sheet prefixes (defaults)
  const [caPrefix, setCaPrefix] = React.useState("11");     // current assets
  const [ncaPrefix, setNcaPrefix] = React.useState("12");    // non-current assets
  const [clPrefix, setClPrefix] = React.useState("21");      // current liabilities
  const [nclPrefix, setNclPrefix] = React.useState("22");    // non-current liabilities
  const [eqPrefix, setEqPrefix] = React.useState("3");        // equity
  // Detailed BS item prefixes (optional — empty = keyword fallback)
  const [invPrefix, setInvPrefix] = React.useState("");       // inventory
  const [cashPrefix, setCashPrefix] = React.useState("");     // cash & equivalents
  const [recPrefix, setRecPrefix] = React.useState("");       // receivables
  const [faPrefix, setFaPrefix] = React.useState("");          // fixed assets
  const [payPrefix, setPayPrefix] = React.useState("");        // payables
  const [stdPrefix, setStdPrefix] = React.useState("");       // short-term debt
  const [ltdPrefix, setLtdPrefix] = React.useState("");       // long-term debt

  const [result, setResult] = React.useState<MatchedRow[] | null>(null);

  const effF1 = React.useMemo<FileData | null>(() => {
    if (!raw1 || cn1 == null || cd1 == null) return raw1;
    return { ...raw1, A: reExtract(raw1, cn1, cd1), nameCol: cn1, debitCol: cd1 };
  }, [raw1, cn1, cd1]);

  const effF2 = React.useMemo<FileData | null>(() => {
    if (!raw2 || cn2 == null || cd2 == null) return raw2;
    return { ...raw2, A: reExtract(raw2, cn2, cd2), nameCol: cn2, debitCol: cd2 };
  }, [raw2, cn2, cd2]);

  // Effective BS files (with re-extracted account rows if columns customized)
  const effBs1 = React.useMemo<FileData | null>(() => {
    if (!bsRaw1 || bsCn1 == null || bsCd1 == null) return bsRaw1;
    return { ...bsRaw1, A: reExtract(bsRaw1, bsCn1, bsCd1), nameCol: bsCn1, debitCol: bsCd1 };
  }, [bsRaw1, bsCn1, bsCd1]);
  const effBs2 = React.useMemo<FileData | null>(() => {
    if (!bsRaw2 || bsCn2 == null || bsCd2 == null) return bsRaw2;
    return { ...bsRaw2, A: reExtract(bsRaw2, bsCn2, bsCd2), nameCol: bsCn2, debitCol: bsCd2 };
  }, [bsRaw2, bsCn2, bsCd2]);

  const baseOptions = React.useMemo(() => collectBaseOptions([effF1, effF2]), [effF1, effF2]);

  React.useEffect(() => {
    if (baseOptions.length === 0) { if (base !== null) setBase(null); return; }
    if (!baseOptions.some((o) => o.nk === base)) setBase(baseOptions[0].nk);
  }, [baseOptions, base]);

  const bsSettings: BalanceSheetSettings = React.useMemo(() => ({
    currentAssetsPrefix: caPrefix.trim(),
    nonCurrentAssetsPrefix: ncaPrefix.trim(),
    currentLiabPrefix: clPrefix.trim(),
    nonCurrentLiabPrefix: nclPrefix.trim(),
    equityPrefix: eqPrefix.trim(),
    inventoryPrefix: invPrefix.trim(),
    cashPrefix: cashPrefix.trim(),
    receivablesPrefix: recPrefix.trim(),
    fixedAssetsPrefix: faPrefix.trim(),
    payablesPrefix: payPrefix.trim(),
    shortTermDebtPrefix: stdPrefix.trim(),
    longTermDebtPrefix: ltdPrefix.trim(),
  }), [caPrefix, ncaPrefix, clPrefix, nclPrefix, eqPrefix, invPrefix, cashPrefix, recPrefix, faPrefix, payPrefix, stdPrefix, ltdPrefix]);

  // BS totals — period mode: both files; month mode: single file (bs1) for both periods
  const bsTotals1: BalanceSheetTotals | null = React.useMemo(
    () => (effBs1 ? categorizeBalanceSheet(effBs1, bsSettings) : null),
    [effBs1, bsSettings]
  );
  const bsTotals2: BalanceSheetTotals | null = React.useMemo(
    () => (effBs2 ? categorizeBalanceSheet(effBs2, bsSettings) : null),
    [effBs2, bsSettings]
  );

  const hasBsData = !!(bsTotals1 || bsTotals2);

  const settings: CategorySettings = React.useMemo(() => ({
    base, costPrefix: costPrefix.trim(), sellPrefix: sellPrefix.trim(),
    adminPrefix: adminPrefix.trim(), otherOpPrefix: otherOpPrefix.trim(),
    financePrefix: financePrefix.trim(), taxPrefix: taxPrefix.trim(), ociPrefix: ociPrefix.trim(),
  }), [base, costPrefix, sellPrefix, adminPrefix, otherOpPrefix, financePrefix, taxPrefix, ociPrefix]);

  const cat = React.useMemo(() => (result ? categorize(result, settings) : null), [result, settings]);

  const baseRow = React.useMemo(() => (result && base ? result.find((r) => r.nk === base) ?? null : null), [result, base]);
  const netRow = React.useMemo(() => (result ? findNetRow(result) : null), [result]);

  const T = React.useMemo(() => (result && cat ? calcTotals(cat, baseRow) : null), [result, cat, baseRow]);

  // Ratios — period mode: compare BS1 vs BS2; month mode: use BS1 for both periods
  const ratioGroups: RatioGroup[] = React.useMemo(
    () => (T ? computeRatios(T, compareMode === "monthCumulative" ? bsTotals1 : bsTotals1, compareMode === "monthCumulative" ? bsTotals1 : bsTotals2) : []),
    [T, bsTotals1, bsTotals2, compareMode]
  );

  const counts = React.useMemo(() => {
    const c = { matched: 0, firstOnly: 0, secondOnly: 0 };
    if (result) for (const r of result) {
      if (r.st === "مطابق") c.matched++;
      else if (r.st === "في الملف الأول فقط") c.firstOnly++;
      else c.secondOnly++;
    }
    return c;
  }, [result]);

  const bothReady = !!(effF1 && effF2);

  async function handleFile(file: File, num: 1 | 2) {
    const setStatus = num === 1 ? setStatus1 : setStatus2;
    const setRaw = num === 1 ? setRaw1 : setRaw2;
    const setCn = num === 1 ? setCn1 : setCn2;
    const setCd = num === 1 ? setCd1 : setCd2;
    setStatus({ kind: "loading" });
    try {
      const data = await readExcelFile(file);
      setRaw(data); setCn(data.nameCol); setCd(data.debitCol);
      setStatus({ kind: "ok", count: data.A.length, filename: file.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : "خطأ غير معروف";
      setStatus({ kind: "error", message }); setRaw(null);
      toast({ title: "تعذّرت قراءة الملف", description: message, variant: "destructive" });
    }
  }

  async function handleBsFile(file: File, num: 1 | 2) {
    const setStatus = num === 1 ? setBsStatus1 : setBsStatus2;
    const setRaw = num === 1 ? setBsRaw1 : setBsRaw2;
    const setCn = num === 1 ? setBsCn1 : setBsCn2;
    const setCd = num === 1 ? setBsCd1 : setBsCd2;
    setStatus({ kind: "loading" });
    try {
      const data = await readExcelFile(file);
      setRaw(data); setCn(data.nameCol); setCd(data.debitCol);
      setStatus({ kind: "ok", count: data.A.length, filename: file.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : "خطأ غير معروف";
      setStatus({ kind: "error", message }); setRaw(null);
      toast({ title: "تعذّرت قراءة ملف المركز المالي", description: message, variant: "destructive" });
    }
  }

  function handleMatch() {
    if (!effF1 || !effF2) return;
    try {
      if (compareMode === "chart") {
        const out = matchChartOfAccounts(effF1, effF2);
        setResult(out);
        const matched = out.filter((r) => r.st === "مطابق").length;
        const nameMatchNumDiff = out.filter((r) => r.st === "مطابق الاسم مختلف الرقم").length;
        const fundamental = out.filter((r) => r.st === "تغير جوهري").length;
        const unmatched = out.filter((r) => r.st === "في الملف الأول فقط" || r.st === "في الملف الثاني فقط" || r.st === "غير مطابق").length;
        toast({
          title: "اكتملت مطابقة دليل الحسابات",
          description: `${out.length} حساب — ${matched} مطابق الاسم والرقم · ${nameMatchNumDiff} مطابق الاسم مختلف الرقم · ${unmatched} غير مطابق · ${fundamental} تغير جوهري`,
        });
        return;
      }
      const out = matchFiles(effF1, effF2);
      setResult(out);
      toast({ title: "اكتملت المطابقة", description: `${out.length} حساب — ${out.filter((r) => r.st === "مطابق").length} مطابق` });
    } catch (err) {
      toast({ title: "خطأ أثناء المطابقة", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    }
  }

  async function handleExport() {
    if (!result) return;
    // Chart-of-accounts mode — separate 3-sheet export
    if (compareMode === "chart") {
      const L1 = l1.trim() || "الدليل الأول";
      const L2 = l2.trim() || "الدليل الثاني";
      await exportChartToExcel(result, { L1, L2 });
      toast({
        title: "تم التصدير",
        description: "مطابقة_دليل_الحسابات.xlsx (يشمل 4 شيتات: مطابق الاسم والرقم + مطابق الاسم مختلف الرقم + غير المطابق + التغيرات الجوهرية)",
      });
      return;
    }
    if (!cat || !T) return;
    const L1 = l1.trim() || (compareMode === "monthCumulative" ? "التراكمي" : "الفترة المقارنة");
    const L2 = l2.trim() || (compareMode === "monthCumulative" ? "الشهر الحالي" : "الفترة الحالية");
    // BS export: period mode = both, month mode = single BS (bs1) for both periods
    const exportBs1 = bsTotals1;
    const exportBs2 = compareMode === "monthCumulative" ? bsTotals1 : bsTotals2;
    await exportToExcel(cat, T, { L1, L2 }, baseRow, netRow, compareMode, numMonths, exportBs1, exportBs2);
    toast({
      title: "تم التصدير",
      description: hasBsData ? "قائمة_الربح_والخسارة_IFRS.xlsx (يشمل الرسوم والتحليل المالي)" : "قائمة_الربح_والخسارة_IFRS.xlsx",
    });
  }

  /* ── Save / Load reports + groups ─────────────────────────────────────── */
  const [saveDialogOpen, setSaveDialogOpen] = React.useState(false);
  const [loadDialogOpen, setLoadDialogOpen] = React.useState(false);
  const [reportName, setReportName] = React.useState("");
  const [savedReports, setSavedReports] = React.useState<{ id: string; name: string; label1: string; label2: string; updatedAt: string; groupId: string | null; userId: string | null; version?: number; status?: string; cycle?: number; preparedById?: string | null; reviewedById?: string | null; approvedById?: string | null }[]>([]);

  // ── القفل التفاؤلي (المرحلة 2) ──
  // التقرير المفتوح حاليًا (المحمّل من قاعدة البيانات): هويته + النسخة version التي
  // فتحها العميل + وقت آخر تعديل من الخادم. عند الحفظ كـ«تحديث» تُرسل هذه النسخة
  // للخادم، ويرفض الخادم الحفظ بـ 409 إذا تغيرت النسخة في قاعدة البيانات.
  const [openReport, setOpenReport] = React.useState<{
    id: string; name: string; groupId: string | null; version: number; updatedAt: string; canUpdate: boolean;
  } | null>(null);
  // ── دورة الاعتماد (المرحلة 3) — من الخادم حصرًا (workflow.myActions) ──
  const [openWorkflow, setOpenWorkflow] = React.useState<WorkflowInfo | null>(null);
  const [saveMode, setSaveMode] = React.useState<"update" | "copy">("update");
  const [saving, setSaving] = React.useState(false);
  // نهاية الفترة المالية — date-only "YYYY-MM-DD" بلا timezone
  const [periodEndDraft, setPeriodEndDraft] = React.useState<string>("");
  // المرحلة 3.5 — تاريخ الاستحقاق (حقل رقابي): يُضبط عند الإنشاء لحائز assignWorkflow فقط
  const [dueDateDraft, setDueDateDraft] = React.useState<string>("");
  // معلومات تعارض النسخ (HTTP 409 VERSION_CONFLICT) — لا تمس تعديلات المستخدم تلقائيًا
  const [conflictInfo, setConflictInfo] = React.useState<{
    reportId: string; reportName: string; clientVersion: number;
    currentVersion: number | null; updatedAt: string | null;
    lastModifiedBy: string | null; lastModifiedAt: string | null;
  } | null>(null);
  const [confirmReplace, setConfirmReplace] = React.useState(false);
  const [reloadingLatest, setReloadingLatest] = React.useState(false);

  // Groups
  const [groups, setGroups] = React.useState<{ id: string; name: string; userId?: string; ownerName?: string; reportCount: number; createdAt: string; updatedAt: string }[]>([]);
  const [selectedGroupId, setSelectedGroupId] = React.useState<string | null>(null); // group chosen in save dialog
  // Group management UI state
  const [newGroupName, setNewGroupName] = React.useState("");
  const [creatingGroup, setCreatingGroup] = React.useState(false);
  const [renamingGroupId, setRenamingGroupId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [deleteGroupTarget, setDeleteGroupTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [groupBusyId, setGroupBusyId] = React.useState<string | null>(null);

  async function handleSave() {
    if (!effF1 || !effF2) {
      toast({ title: "لا يمكن الحفظ", description: "ارفع الملفين أولاً", variant: "destructive" });
      return;
    }
    const target = openReport;
    const isUpdate = saveMode === "update" && !!target?.canUpdate;
    const name = reportName.trim() || (isUpdate && target ? target.name : `تقرير ${new Date().toLocaleDateString("ar")}`);
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name,
        label1: l1, label2: l2,
        compareMode, numMonths,
        // في وضع التحديث: من لا يدير المجموعات لا يرسل groupId إطلاقًا (يبقى دون تغيير)
        groupId: canManageGroups ? selectedGroupId : (isUpdate ? undefined : null),
        isSettings: {
          base, costPrefix, sellPrefix, adminPrefix, otherOpPrefix,
          financePrefix, taxPrefix, ociPrefix,
        },
        bsSettings: {
          caPrefix, ncaPrefix, clPrefix, nclPrefix, eqPrefix,
          invPrefix, cashPrefix, recPrefix, faPrefix, payPrefix, stdPrefix, ltdPrefix,
        },
        isFile1Data: effF1.A,
        isFile2Data: effF2.A,
        isFile1Headers: effF1.headers,
        isFile2Headers: effF2.headers,
        isFile1Cols: { nameCol: cn1, numCol: effF1.numCol, debitCol: cd1 },
        isFile2Cols: { nameCol: cn2, numCol: effF2.numCol, debitCol: cd2 },
        bsFile1Data: effBs1?.A ?? [],
        bsFile1Headers: effBs1?.headers ?? [],
        bsFile1Cols: { nameCol: bsCn1, numCol: effBs1?.numCol ?? 0, debitCol: bsCd1 },
        bsFile2Data: effBs2?.A ?? [],
        bsFile2Headers: effBs2?.headers ?? [],
        bsFile2Cols: { nameCol: bsCn2, numCol: effBs2?.numCol ?? 0, debitCol: bsCd2 },
        // نهاية الفترة المالية — date-only (بلا timezone)
        periodEnd: periodEndDraft ? periodEndDraft : null,
        // المرحلة 3.5 — الاستحقاق عند الإنشاء فقط لحائز الحوكمة (الخادم يفرض الصلاحية):
        // في وضع التحديث لا يُرسل الحقل إطلاقًا (مساره PATCH due-date وليس PUT)
        ...(isUpdate ? {} : { dueDate: canAssignWorkflowFlag ? (dueDateDraft ? dueDateDraft : null) : undefined }),
      };

      if (isUpdate && target) {
        /* ── تحديث التقرير المفتوح — القفل التفاؤلي: نرسل النسخة التي فتحها العميل ── */
        const res = await fetch(`/api/reports/${target.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, version: target.version }),
        });
        if (res.status === 409) {
          const c = await res.json().catch(() => ({})) as Record<string, unknown>;
          // تعارض: لا نمسح تعديلات المستخدم ولا نعيد تحميل الصفحة — نعرض تفاصيل الخادم
          setSaveDialogOpen(false);
          setConflictInfo({
            reportId: target.id,
            reportName: target.name,
            clientVersion: typeof c.clientVersion === "number" ? c.clientVersion : target.version,
            currentVersion: typeof c.currentVersion === "number" ? c.currentVersion : null,
            updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : null,
            lastModifiedBy: typeof c.lastModifiedBy === "string" ? c.lastModifiedBy : null,
            lastModifiedAt: typeof c.lastModifiedAt === "string" ? c.lastModifiedAt : null,
          });
          return;
        }
        if (!res.ok) {
          const e = await res.json().catch(() => ({})) as { error?: string; code?: string; currentStatus?: string };
          if (e.code === "WORKFLOW_LOCKED" || e.code === "NOT_ASSIGNED" || e.code === "FORBIDDEN") {
            setSaveDialogOpen(false);
            toast({ title: "لا يمكن الحفظ", description: e.error || "التقرير مقفل في الحالة الحالية.", variant: "destructive" });
            return;
          }
          throw new Error(e.error || "فشل الحفظ");
        }
        const updated = await res.json();
        // نجاح الحفظ: حدّث النسخة وworkflow لدى العميل فورًا من استجابة الخادم
        setOpenReport({ id: updated.id, name: updated.name, groupId: updated.groupId ?? null, version: updated.version, updatedAt: updated.updatedAt, canUpdate: updated.workflow?.myActions?.canEdit ?? true });
        if (updated.workflow) setOpenWorkflow(updated.workflow);
        toast({ title: "تم تحديث التقرير", description: `${updated.name} · النسخة الحالية v${updated.version}` });
        setSaveDialogOpen(false);
      } else {
        /* ── حفظ كنسخة جديدة ── */
        const res = await fetch("/api/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error("فشل الحفظ");
        const created = await res.json();
        // النسخة الجديدة تصبح التقرير المفتوح (المُنشئ = المعدّ تلقائيًا)
        setOpenReport({ id: created.id, name: created.name, groupId: created.groupId ?? null, version: created.version, updatedAt: created.updatedAt, canUpdate: created.workflow?.myActions?.canEdit ?? true });
        if (created.workflow) setOpenWorkflow(created.workflow);
        toast({ title: "تم الحفظ", description: `${name} · النسخة v${created.version}` });
        setSaveDialogOpen(false);
        setReportName("");
        setSelectedGroupId(null);
        setSaveMode("update");
        setDueDateDraft("");
      }
    } catch (err) {
      toast({ title: "خطأ في الحفظ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleLoadList() {
    try {
      const [reportsRes, groupsRes] = await Promise.all([
        fetch("/api/reports", { cache: "no-store" }),
        canManageGroups ? fetch("/api/groups", { cache: "no-store" }) : Promise.resolve(null),
      ]);
      if (!reportsRes.ok) throw new Error("فشل جلب التقارير");
      const data = await reportsRes.json();
      setSavedReports(data);
      if (groupsRes && groupsRes.ok) {
        const gData = await groupsRes.json();
        setGroups(gData);
      } else if (!groupsRes) {
        setGroups([]);
      }
    } catch (err) {
      toast({ title: "خطأ في جلب القائمة", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    }
  }

  // Group CRUD
  async function handleCreateGroup() {
    const name = newGroupName.trim();
    if (!name) {
      toast({ title: "اسم المجموعة مطلوب", variant: "destructive" });
      return;
    }
    // Case-insensitive duplicate check (client-side, before hitting the server)
    const dup = groups.some((g) => g.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) {
      toast({ title: "يوجد مجموعة بنفس الاسم", variant: "destructive" });
      return;
    }
    setCreatingGroup(true);
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "فشل الإنشاء");
      toast({ title: "تم إنشاء المجموعة", description: name });
      setNewGroupName("");
      // Refresh groups
      const gRes = await fetch("/api/groups", { cache: "no-store" });
      if (gRes.ok) setGroups(await gRes.json());
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setCreatingGroup(false);
    }
  }

  async function handleRenameGroup(id: string) {
    const name = renameValue.trim();
    if (!name) {
      toast({ title: "اسم المجموعة مطلوب", variant: "destructive" });
      return;
    }
    // Case-insensitive duplicate check (excluding the group being renamed)
    const dup = groups.some((g) => g.id !== id && g.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) {
      toast({ title: "يوجد مجموعة بنفس الاسم", variant: "destructive" });
      return;
    }
    setGroupBusyId(id);
    try {
      const res = await fetch(`/api/groups/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "فشل التحديث");
      toast({ title: "تم تحديث المجموعة", description: name });
      setRenamingGroupId(null);
      setRenameValue("");
      const gRes = await fetch("/api/groups", { cache: "no-store" });
      if (gRes.ok) setGroups(await gRes.json());
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setGroupBusyId(null);
    }
  }

  async function handleDeleteGroup(id: string) {
    setGroupBusyId(id);
    try {
      const res = await fetch(`/api/groups/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "فشل الحذف");
      toast({ title: "تم حذف المجموعة", description: "نُقلت تقاريرها إلى «بدون مجموعة»" });
      setDeleteGroupTarget(null);
      // Refresh both groups and reports (report counts changed)
      await handleLoadList();
      // Clear selectedGroupId if it was the deleted group
      setSelectedGroupId((cur) => (cur === id ? null : cur));
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setGroupBusyId(null);
    }
  }

  /** تطبيق بيانات التقرير القادمة من الخادم على حالة الجلسة — دون إعادة تحميل الصفحة. */
  function applyReportToSession(data: any) {
    // Restore labels and mode
    setL1(data.label1 || ""); setL2(data.label2 || "");
    setCompareMode(data.compareMode || "period");
    setNumMonths(data.numMonths || 12);
    // Restore IS settings
    const isSet = JSON.parse(data.isSettings || "{}");
    if (isSet.base !== undefined) setBase(isSet.base);
    if (isSet.costPrefix) setCostPrefix(isSet.costPrefix);
    if (isSet.sellPrefix) setSellPrefix(isSet.sellPrefix);
    if (isSet.adminPrefix) setAdminPrefix(isSet.adminPrefix);
    if (isSet.otherOpPrefix) setOtherOpPrefix(isSet.otherOpPrefix);
    if (isSet.financePrefix) setFinancePrefix(isSet.financePrefix);
    if (isSet.taxPrefix) setTaxPrefix(isSet.taxPrefix);
    if (isSet.ociPrefix) setOciPrefix(isSet.ociPrefix);
    // Restore BS settings
    const bsSet = JSON.parse(data.bsSettings || "{}");
    if (bsSet.caPrefix !== undefined) setCaPrefix(bsSet.caPrefix);
    if (bsSet.ncaPrefix !== undefined) setNcaPrefix(bsSet.ncaPrefix);
    if (bsSet.clPrefix !== undefined) setClPrefix(bsSet.clPrefix);
    if (bsSet.nclPrefix !== undefined) setNclPrefix(bsSet.nclPrefix);
    if (bsSet.eqPrefix !== undefined) setEqPrefix(bsSet.eqPrefix);
    if (bsSet.invPrefix !== undefined) setInvPrefix(bsSet.invPrefix);
    if (bsSet.cashPrefix !== undefined) setCashPrefix(bsSet.cashPrefix);
    if (bsSet.recPrefix !== undefined) setRecPrefix(bsSet.recPrefix);
    if (bsSet.faPrefix !== undefined) setFaPrefix(bsSet.faPrefix);
    if (bsSet.payPrefix !== undefined) setPayPrefix(bsSet.payPrefix);
    if (bsSet.stdPrefix !== undefined) setStdPrefix(bsSet.stdPrefix);
    if (bsSet.ltdPrefix !== undefined) setLtdPrefix(bsSet.ltdPrefix);
    // Restore IS file data
    const f1Data = JSON.parse(data.isFile1Data || "[]");
    const f1Headers = JSON.parse(data.isFile1Headers || "[]");
    const f1Cols = JSON.parse(data.isFile1Cols || "{}");
    if (f1Data.length > 0) {
      setRaw1({ A: f1Data, headers: f1Headers, nameCol: f1Cols.nameCol ?? 1, numCol: f1Cols.numCol ?? 0, debitCol: f1Cols.debitCol ?? 2, headerRow: 0, rawRows: [] });
      setCn1(f1Cols.nameCol ?? null);
      setCd1(f1Cols.debitCol ?? null);
      setStatus1({ kind: "ok", count: f1Data.length, filename: data.label1 || "ملف 1" });
    }
    const f2Data = JSON.parse(data.isFile2Data || "[]");
    const f2Headers = JSON.parse(data.isFile2Headers || "[]");
    const f2Cols = JSON.parse(data.isFile2Cols || "{}");
    if (f2Data.length > 0) {
      setRaw2({ A: f2Data, headers: f2Headers, nameCol: f2Cols.nameCol ?? 1, numCol: f2Cols.numCol ?? 0, debitCol: f2Cols.debitCol ?? 2, headerRow: 0, rawRows: [] });
      setCn2(f2Cols.nameCol ?? null);
      setCd2(f2Cols.debitCol ?? null);
      setStatus2({ kind: "ok", count: f2Data.length, filename: data.label2 || "ملف 2" });
    }
    // Restore BS file data (2 files: bs1 = comparative/cumulative, bs2 = current)
    const bs1Data = JSON.parse(data.bsFile1Data || data.bsFileData || "[]");
    const bs1Headers = JSON.parse(data.bsFile1Headers || data.bsFileHeaders || "[]");
    const bs1Cols = JSON.parse(data.bsFile1Cols || data.bsFileCols || "{}");
    if (bs1Data.length > 0) {
      setBsRaw1({ A: bs1Data, headers: bs1Headers, nameCol: bs1Cols.nameCol ?? 1, numCol: bs1Cols.numCol ?? 0, debitCol: bs1Cols.debitCol ?? 2, headerRow: 0, rawRows: [] });
      setBsCn1(bs1Cols.nameCol ?? null);
      setBsCd1(bs1Cols.debitCol ?? null);
      setBsStatus1({ kind: "ok", count: bs1Data.length, filename: "مركز مالي 1" });
    }
    const bs2Data = JSON.parse(data.bsFile2Data || "[]");
    const bs2Headers = JSON.parse(data.bsFile2Headers || "[]");
    const bs2Cols = JSON.parse(data.bsFile2Cols || "{}");
    if (bs2Data.length > 0) {
      setBsRaw2({ A: bs2Data, headers: bs2Headers, nameCol: bs2Cols.nameCol ?? 1, numCol: bs2Cols.numCol ?? 0, debitCol: bs2Cols.debitCol ?? 2, headerRow: 0, rawRows: [] });
      setBsCn2(bs2Cols.nameCol ?? null);
      setBsCd2(bs2Cols.debitCol ?? null);
      setBsStatus2({ kind: "ok", count: bs2Data.length, filename: "مركز مالي 2" });
    }
  }

  /** تتبع التقرير المفتوح بعد تحميله/تحديثه: الهوية + النسخة + workflow (من الخادم حصرًا). */
  function trackOpenReport(data: any) {
    const wf = (data.workflow ?? null) as WorkflowInfo | null;
    const gid = (data.groupId as string | null) ?? null;
    // canUpdate الآن من قاعدة workflow (المعدّ المعيّن + الحالة) — مع fallback للقاعدة القديمة
    const canUpdate = wf
      ? wf.myActions.canEdit
      : data.userId === currentUserId || (gid != null && (Array.isArray(perms.groupIds) ? perms.groupIds : []).includes(gid));
    setOpenReport({
      id: data.id as string,
      name: (data.name as string) || "",
      groupId: gid,
      version: typeof data.version === "number" ? data.version : 1,
      updatedAt: (data.updatedAt as string) || "",
      canUpdate,
    });
    setOpenWorkflow(wf);
    setPeriodEndDraft(typeof data.periodEnd === "string" ? data.periodEnd : "");
    setReportName((data.name as string) || "");
    setSelectedGroupId(gid);
    setSaveMode("update");
  }

  async function handleLoadReport(id: string) {
    try {
      const res = await fetch(`/api/reports/${id}`);
      if (!res.ok) throw new Error("فشل التحميل");
      const data = await res.json();
      applyReportToSession(data);
      trackOpenReport(data);
      setLoadDialogOpen(false);
      toast({ title: "تم تحميل التقرير", description: `${data.name} · النسخة v${data.version ?? 1}` });
    } catch (err) {
      toast({ title: "خطأ في التحميل", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    }
  }

  /** تحميل أحدث نسخة من الخادم بعد تعارض (بعد تأكيد المستخدم) — يستبدل التعديلات غير المحفوظة، دون إعادة تحميل الصفحة. */
  async function reloadLatestReport() {
    if (!conflictInfo) return;
    setReloadingLatest(true);
    try {
      const res = await fetch(`/api/reports/${conflictInfo.reportId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("فشل تحميل أحدث نسخة");
      const data = await res.json();
      applyReportToSession(data);
      trackOpenReport(data);
      setConfirmReplace(false);
      setConflictInfo(null);
      toast({ title: "تم تحميل أحدث نسخة", description: `${data.name} · النسخة الحالية v${data.version ?? 1}` });
    } catch (err) {
      toast({ title: "خطأ في التحميل", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setReloadingLatest(false);
    }
  }

  async function handleDeleteReport(id: string) {
    try {
      const res = await fetch(`/api/reports/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as { error?: string }).error || "فشل الحذف — الحذف متاح للمسودة فقط.");
      }
      setSavedReports(prev => prev.filter(r => r.id !== id));
      // إذا كان المحذوف هو التقرير المفتوح، أزل تتبعه (يعود الحفظ إلى «نسخة جديدة»)
      if (openReport?.id === id) {
        setOpenReport(null);
        setOpenWorkflow(null);
      }
      toast({ title: "تم الحذف" });
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    }
  }

  /* ── دورة الاعتماد (المرحلة 3) ─────────────────────────────────── */

  /** تنفيذ انتقال workflow من أزرار اللوحة — يحدّث الجلسة كاملة من استجابة الخادم. */
  async function handleWorkflowAction(
    action: string,
    payload: { reason?: string; comment?: string }
  ): Promise<boolean> {
    if (!openReport) return false;
    try {
      const res = await fetch(`/api/reports/${openReport.id}/workflow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, version: openReport.version, ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === "VERSION_CONFLICT") {
        setConflictInfo({
          reportId: openReport.id,
          reportName: openReport.name,
          clientVersion: typeof data.clientVersion === "number" ? data.clientVersion : openReport.version,
          currentVersion: typeof data.currentVersion === "number" ? data.currentVersion : null,
          updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
          lastModifiedBy: null,
          lastModifiedAt: null,
        });
        return false;
      }
      if (!res.ok) {
        toast({ title: "تعذر تنفيذ العملية", description: (data as { error?: string }).error || "خطأ", variant: "destructive" });
        return false;
      }
      applyReportToSession(data);
      trackOpenReport(data);
      const actionTitles: Record<string, string> = {
        SUBMIT: "تم إرسال التقرير للمراجعة",
        START_REVIEW: "بدأت المراجعة",
        COMPLETE_REVIEW: "أُتمّت المراجعة وتوقّع المراجع — بانتظار الاعتماد",
        RETURN: "أُرجع التقرير للتصحيح",
        APPROVE: "تم اعتماد التقرير — مقفل كليًا",
        REOPEN: "أُعيد فتح التقرير — دورة جديدة",
        RESUME_EDIT: "عاد التقرير إلى مسودة",
      };
      toast({ title: actionTitles[action] || "تمت العملية", description: `الحالة الآن: ${data.workflow?.statusLabel ?? ""} · v${data.version ?? ""}` });
      return true;
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
      return false;
    }
  }

  /** المرحلة 3.5 — حوكمة تاريخ الاستحقاق (assignWorkflow) — PATCH /api/reports/[id]/due-date.
   *  مسار مستقل عن PUT: الحقل رقابي لا بيانات مطابقة، والتدقيق DUE_DATE_CHANGED من الخادم. */
  async function handleDueDate(dueDate: string | null, version: number): Promise<boolean> {
    if (!openReport) return false;
    try {
      const res = await fetch(`/api/reports/${openReport.id}/due-date`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dueDate, version }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === "VERSION_CONFLICT") {
        setConflictInfo({
          reportId: openReport.id,
          reportName: openReport.name,
          clientVersion: version,
          currentVersion: typeof data.currentVersion === "number" ? data.currentVersion : null,
          updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
          lastModifiedBy: null,
          lastModifiedAt: null,
        });
        return false;
      }
      if (!res.ok) {
        toast({ title: "تعذر تغيير الاستحقاق", description: (data as { error?: string }).error || "خطأ", variant: "destructive" });
        return false;
      }
      applyReportToSession(data);
      trackOpenReport(data);
      toast({ title: "تم تحديث تاريخ الاستحقاق", description: `${data.dueDate ? "الاستحقاق: " + data.dueDate : "أُزيل الاستحقاق (غير محدد)"} · v${data.version ?? ""}` });
      return true;
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
      return false;
    }
  }

  /** تغيير إسناد الأدوار من حوار الإسناد — يتطلب assignWorkflow (يفرضه الخادم). */
  async function handleAssign(
    updates: { preparedById?: string | null; reviewedById?: string | null; approvedById?: string | null; reason?: string },
    version: number
  ): Promise<boolean> {
    if (!openReport) return false;
    try {
      const res = await fetch(`/api/reports/${openReport.id}/assignments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...updates, version }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === "VERSION_CONFLICT") {
        setConflictInfo({
          reportId: openReport.id,
          reportName: openReport.name,
          clientVersion: version,
          currentVersion: typeof data.currentVersion === "number" ? data.currentVersion : null,
          updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
          lastModifiedBy: null,
          lastModifiedAt: null,
        });
        return false;
      }
      if (!res.ok) {
        toast({ title: "تعذر تغيير الإسناد", description: (data as { error?: string }).error || "خطأ", variant: "destructive" });
        return false;
      }
      applyReportToSession(data);
      trackOpenReport(data);
      toast({ title: "تم تحديث الإسناد", description: `النسخة الحالية v${data.version ?? ""}` });
      return true;
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
      return false;
    }
  }

  const L1 = l1.trim() || (compareMode === "monthCumulative" ? "التراكمي" : compareMode === "chart" ? "الدليل القديم" : "الفترة المقارنة");
  const L2 = l2.trim() || (compareMode === "monthCumulative" ? "الشهر الحالي" : compareMode === "chart" ? "الدليل الجديد" : "الفترة الحالية");

  return (
    <div className="flex w-full flex-col">
      {/* Header — أداة المقارنة (ضمن هيكل النظام الموحد 6.7) */}
      <header className="border-b border-slate-200 bg-white/60 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-950/40">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-600 to-teal-700 text-white shadow-md">
              <ArrowLeftRight className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-extrabold leading-tight text-slate-800 dark:text-slate-100 sm:text-lg">
                أداة مقارنة القوائم (Excel)
              </h1>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 sm:text-xs">
                مقارنة فترتين وفق IFRS (IAS 1 — طريقة الوظيفة) — تُجرى المعالجة محليًا في المتصفح
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* المرحلة 3.5 — مفتاح العرض: مساحة العمل | لوحة المتابعة */}
            <div className="flex overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700" role="tablist" aria-label="عرض التطبيق">
              <button
                type="button" role="tab" aria-selected={mainView === "workspace"}
                onClick={() => setMainView("workspace")}
                className={cn(
                  "min-h-[36px] px-3 text-xs font-bold transition-colors",
                  mainView === "workspace"
                    ? "bg-emerald-600 text-white"
                    : "bg-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                )}
              >
                مساحة العمل
              </button>
              <button
                type="button" role="tab" aria-selected={mainView === "dashboard"}
                onClick={() => setMainView("dashboard")}
                className={cn(
                  "min-h-[36px] px-3 text-xs font-bold transition-colors",
                  mainView === "dashboard"
                    ? "bg-emerald-600 text-white"
                    : "bg-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                )}
              >
                لوحة المتابعة
              </button>
            </div>
            {/* Save button */}
            {canAdd && (
            <Dialog open={saveDialogOpen} onOpenChange={(open) => {
              if (!open) setSelectedGroupId(null);
              setSaveDialogOpen(open);
            }}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 border-slate-300 dark:border-slate-700" disabled={!bothReady}>
                  <Save className="size-3.5" />
                  <span className="hidden sm:inline">حفظ</span>
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>حفظ التقرير</DialogTitle>
                  <DialogDescription>أدخل اسماً للتقرير لحفظه في قاعدة البيانات</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  {/* قفل workflow: إن كان التقرير المفتوح غير قابل للتعديل → تنبيه + إخفاء خيار التحديث */}
                  {openReport && !openReport.canUpdate && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                      <strong>التقرير المفتوح مقفل</strong> — الحالة: «{openWorkflow?.statusLabel ?? "غير قابلة للتعديل"}».
                      تعديل بيانات المطابقة متاح للمعدّ المعيّن في الحالات القابلة للتعديل فقط.
                      يمكنك الحفظ كنسخة جديدة.
                    </div>
                  )}
                  {openReport?.canUpdate && (
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-slate-600 dark:text-slate-300">وجهة الحفظ</Label>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className={cn(
                          "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                          saveMode === "update"
                            ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
                            : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/50"
                        )}>
                          <input
                            type="radio" name="saveMode"
                            className="mt-1 size-3.5 accent-emerald-600"
                            checked={saveMode === "update"}
                            onChange={() => { setSaveMode("update"); setReportName(openReport.name); setSelectedGroupId(openReport.groupId ?? null); }}
                          />
                          <span>
                            <span className="block font-semibold">تحديث التقرير المفتوح</span>
                            <span className="block text-[11px] text-slate-500 dark:text-slate-400" dir="ltr">«{openReport.name}» · v{openReport.version}</span>
                          </span>
                        </label>
                        <label className={cn(
                          "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                          saveMode === "copy"
                            ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
                            : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/50"
                        )}>
                          <input
                            type="radio" name="saveMode"
                            className="mt-1 size-3.5 accent-emerald-600"
                            checked={saveMode === "copy"}
                            onChange={() => { setSaveMode("copy"); setReportName(""); setSelectedGroupId(null); }}
                          />
                          <span>
                            <span className="block font-semibold">حفظ كنسخة جديدة</span>
                            <span className="block text-[11px] text-slate-500 dark:text-slate-400">ينشئ تقريرًا منفصلًا دون تعديل المفتوح</span>
                          </span>
                        </label>
                      </div>
                      {saveMode === "update" && (
                        <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                          آخر تعديل (من الخادم): <span className="font-semibold text-slate-600 dark:text-slate-300">{fmtServerDateTime(openReport.updatedAt)}</span>
                          — إذا عدّل التقرير مستخدم آخر بعد فتحه لديك سيُرفض الحفظ بتعارض نسخ ولن تفقد تعديلاتك.
                        </p>
                      )}
                    </div>
                  )}
                  <Input
                    value={reportName}
                    onChange={(e) => setReportName(e.target.value)}
                    placeholder="مثلاً: مقارنة يونيو ٢٠٢٦"
                    autoFocus
                  />
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                      نهاية الفترة المالية (اختياري)
                    </Label>
                    <Input
                      type="date"
                      value={periodEndDraft}
                      onChange={(e) => setPeriodEndDraft(e.target.value)}
                      className="w-full sm:w-56"
                      dir="ltr"
                    />
                    <p className="text-[10px] text-slate-400">تُحفظ كتاريخ أعمال (YYYY-MM-DD) دون أي تأثر بتوقيت الجهاز أو المنطقة الزمنية.</p>
                  </div>
                  {/* المرحلة 3.5 — الاستحقاق عند إنشاء نسخة جديدة: حقل رقابي لحائز assignWorkflow فقط.
                      تحديث تقرير قائم يتم عبر لوحة دورة الاعتماد (PATCH due-date) وليس من هنا. */}
                  {canAssignWorkflowFlag && !(saveMode === "update" && openReport?.canUpdate) && (
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                        تاريخ الاستحقاق (اختياري — رقابي)
                      </Label>
                      <Input
                        type="date"
                        value={dueDateDraft}
                        onChange={(e) => setDueDateDraft(e.target.value)}
                        className="w-full sm:w-56"
                        dir="ltr"
                      />
                      <p className="text-[10px] text-slate-400">
                        يُضبط هنا عند الإنشاء فقط — تغييره لاحقًا من لوحة دورة الاعتماد بصلاحية الحوكمة ويُسجّل في السجل الرقابي.
                      </p>
                    </div>
                  )}
                  {canManageGroups && (
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                        المجموعة (اختياري)
                      </Label>
                      <Select
                        value={selectedGroupId ?? "__none__"}
                        onValueChange={(v) => setSelectedGroupId(v === "__none__" ? null : v)}
                      >
                        <SelectTrigger className="w-full" size="sm">
                          <SelectValue placeholder="— بدون مجموعة —" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">— بدون مجموعة —</SelectItem>
                          {groups.map((g) => (
                            <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {groups.length === 0 && (
                        <p className="text-[11px] text-slate-400">
                          لا توجد مجموعات بعد. يمكنك إنشاء مجموعة من نافذة «فتح».
                        </p>
                      )}
                    </div>
                  )}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => {
                    setSaveDialogOpen(false);
                    setSelectedGroupId(null);
                  }}>إلغاء</Button>
                  <Button onClick={handleSave} disabled={saving} className="bg-emerald-600 text-white hover:bg-emerald-700">
                    {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                    {saveMode === "update" && openReport?.canUpdate ? "تحديث التقرير" : "حفظ"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            )}
            {/* Load button */}
            <Dialog open={loadDialogOpen} onOpenChange={(open) => {
              setLoadDialogOpen(open);
              if (open) {
                void handleLoadList();
              } else {
                setRenamingGroupId(null);
                setRenameValue("");
                setNewGroupName("");
              }
            }}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 border-slate-300 dark:border-slate-700">
                  <FolderOpen className="size-3.5" />
                  <span className="hidden sm:inline">فتح</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>التقارير المحفوظة</DialogTitle>
                  <DialogDescription>
                    اختر تقريراً لتحميله{canManageGroups ? " · نُظّمت حسب المجموعة" : ""}
                  </DialogDescription>
                </DialogHeader>

                {/* Group creation (only if user has groups permission) */}
                {canManageGroups && (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2 dark:border-slate-700 dark:bg-slate-900/40">
                    <FolderPlus className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <Input
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      placeholder="اسم مجموعة جديدة"
                      className="h-8"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !creatingGroup) {
                          e.preventDefault();
                          void handleCreateGroup();
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      onClick={handleCreateGroup}
                      disabled={creatingGroup || !newGroupName.trim()}
                      className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                    >
                      {creatingGroup ? <Loader2 className="size-3.5 animate-spin" /> : <FolderPlus className="size-3.5" />}
                      <span className="hidden sm:inline">إنشاء</span>
                    </Button>
                  </div>
                )}

                {savedReports.length === 0 && groups.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-400">لا توجد تقارير محفوظة</p>
                ) : (
                  <div className="space-y-3">
                    {/* Grouped reports — one section per group */}
                    {canManageGroups && groups.map((g) => {
                      const reports = savedReports.filter((r) => r.groupId === g.id);
                      const isOwnGroup = !g.userId || g.userId === currentUserId;
                      return (
                        <div key={g.id} className="rounded-lg border border-slate-200 dark:border-slate-700">
                          <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/70 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/40">
                            <div className="flex items-center gap-2">
                              <FolderOpen className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                              {renamingGroupId === g.id ? (
                                <div className="flex items-center gap-1">
                                  <Input
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    className="h-7 w-40 text-sm"
                                    autoFocus
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" && groupBusyId !== g.id) {
                                        e.preventDefault();
                                        void handleRenameGroup(g.id);
                                      }
                                      if (e.key === "Escape") {
                                        setRenamingGroupId(null);
                                        setRenameValue("");
                                      }
                                    }}
                                  />
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="size-7 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                                    onClick={() => void handleRenameGroup(g.id)}
                                    disabled={groupBusyId === g.id}
                                  >
                                    {groupBusyId === g.id ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                                  </Button>
                                </div>
                              ) : (
                                <span className="text-sm font-bold text-slate-700 dark:text-slate-200">
                                  {g.name}
                                  {!isOwnGroup && g.ownerName && (
                                    <span className="ms-1.5 text-[10px] font-semibold text-slate-400 dark:text-slate-500">(مجموعة: {g.ownerName})</span>
                                  )}
                                </span>
                              )}
                              <Badge variant="outline" className="border-slate-300 px-1.5 py-0 text-[9px] text-slate-500 dark:border-slate-600 dark:text-slate-400">
                                {reports.length} تقرير
                              </Badge>
                            </div>
                            {renamingGroupId !== g.id && isOwnGroup && (
                              <div className="flex items-center gap-0.5">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-7 text-slate-500 hover:bg-slate-100 hover:text-emerald-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-emerald-400"
                                  onClick={() => {
                                    setRenamingGroupId(g.id);
                                    setRenameValue(g.name);
                                  }}
                                  aria-label="تعديل الاسم"
                                  title="تعديل الاسم"
                                  disabled={!!groupBusyId}
                                >
                                  <Pencil className="size-3.5" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-7 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                                  onClick={() => setDeleteGroupTarget({ id: g.id, name: g.name })}
                                  aria-label="حذف المجموعة"
                                  title="حذف المجموعة"
                                  disabled={!!groupBusyId}
                                >
                                  <FolderX className="size-3.5" />
                                </Button>
                              </div>
                            )}
                          </div>
                          {reports.length === 0 ? (
                            <p className="px-3 py-3 text-center text-[11px] text-slate-400">لا توجد تقارير في هذه المجموعة</p>
                          ) : (
                            <div className="divide-y divide-slate-100 dark:divide-slate-800">
                              {reports.map((r) => (
                                <ReportRow key={r.id} r={r} onLoad={handleLoadReport} onDelete={handleDeleteReport} canDelete={canDelete} isOwner={!currentUserId || r.userId === currentUserId} isOpen={openReport?.id === r.id} currentUserId={currentUserId} />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Ungrouped reports */}
                    {(() => {
                      const ungrouped = savedReports.filter((r) => r.groupId === null || r.groupId === undefined);
                      if (ungrouped.length === 0 && groups.length > 0) return null;
                      const showHeader = canManageGroups && groups.length > 0;
                      return (
                        <div className={cn("rounded-lg", showHeader && "border border-slate-200 dark:border-slate-700")}>
                          {showHeader && (
                            <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50/70 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/40">
                              <FolderX className="size-3.5 text-slate-500" />
                              <span className="text-sm font-bold text-slate-600 dark:text-slate-300">بدون مجموعة</span>
                              <Badge variant="outline" className="border-slate-300 px-1.5 py-0 text-[9px] text-slate-500 dark:border-slate-600 dark:text-slate-400">
                                {ungrouped.length} تقرير
                              </Badge>
                            </div>
                          )}
                          {ungrouped.length === 0 ? (
                            <p className="px-3 py-3 text-center text-[11px] text-slate-400">لا توجد تقارير</p>
                          ) : (
                            <div className={cn("divide-y divide-slate-100 dark:divide-slate-800", showHeader && "")}>
                              {ungrouped.map((r) => (
                                <ReportRow key={r.id} r={r} onLoad={handleLoadReport} onDelete={handleDeleteReport} canDelete={canDelete} isOwner={!currentUserId || r.userId === currentUserId} isOpen={openReport?.id === r.id} currentUserId={currentUserId} />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </DialogContent>
            </Dialog>

          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {/* المرحلة 3.5 — لوحة المتابعة: عرض داخل نفس الصفحة (بلا route جديد)؛
            حالة مساحة العمل (التقرير المفتوح) تبقى محفوظة عند العودة */}
        {mainView === "dashboard" && (
          <ReconciliationsDashboard
            onOpenReport={(id) => {
              setMainView("workspace");
              void handleLoadReport(id);
            }}
          />
        )}

        {mainView === "workspace" && (<>
        {/* Intro */}
        <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="mb-6">
          <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/20">
            <Info className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              {compareMode === "period" ? (
                <>ارفع ملفَي أرصدة الحسابات (Excel) — <strong>الفترة المقارنة (السابقة)</strong> ثم
                <strong> الفترة الحالية</strong> — وحدّد بادئات بنود القائمة وفق IAS 1. تُعرض
                <strong> الفترة الحالية أولاً</strong> ثم المقارنة، والخصومات سالبة بين قوسين،
                والإجماليات من الحسابات الفرعية (الأوراق) فقط. حالة التغير:
                <strong>مرغوب نمو</strong> (أخضر) = زيادة الإيراد ·
                <strong>غير مرغوب انخفاض</strong> (أحمر) = نقصان الإيراد ·
                <strong>مرغوب وفرة</strong> (أخضر) = نقصان المصروف ·
                <strong>غير مرغوب زيادة</strong> (أحمر) = زيادة المصروف.</>
              ) : compareMode === "monthCumulative" ? (
                <>ارفع ملفين — <strong>التراكمي للسنة</strong> ثم <strong>الشهر الحالي</strong> —
                لمعرفة نسبة الشهر من التراكمي لكل بند. يُعرض <strong>الشهر الحالي</strong> أولاً ثم التراكمي،
                مع <strong>نسبة الشهر من التراكمي</strong> و<strong>نسبة البند لمبيعات الشهر</strong> و<strong>المتوسط للتراكمي</strong>
                و<strong>نسبة الشهر من المتوسط</strong> و<strong>فرق الشهر عن المتوسط</strong> و<strong>نسبة الفرق عن المتوسط</strong>
                وحالة الشهر:
                <strong>مرغوب نمو</strong> (أخضر) = الشهر أعلى من المتوسط ({(100 / numMonths).toFixed(1)}%) ·
                <strong>غير مرغوب انخفاض</strong> (أحمر) = الشهر أقل من المتوسط ·
                <strong>مرغوب وفرة</strong> (أخضر) = مصروف الشهر أقل من المتوسط ·
                <strong>غير مرغوب زيادة</strong> (أحمر) = مصروف الشهر أعلى من المتوسط.</>
              ) : (
                <>ارفع ملفَي <strong>دليل الحسابات</strong> — <strong>الدليل القديم</strong> ثم
                <strong> الدليل الجديد</strong> — لمطابقة الحسابات <strong>بالاسم (≥ 90%) أو برقم الحساب</strong>.
                يُظهر لك: (1) المطابقة الكاملة بنسبة التطابق، (2) الحسابات التي تغير <strong>رقمها</strong> في شيت مستقل،
                (3) الحسابات التي تغيرت <strong>جوهريًا في موقعها</strong> (من أصول إلى خصوم، أو من مصروف إلى إيراد…) في شيت ثالث.
                يُصدّر إلى Excel بـ 3 شيتات منفصلة.</>
              )}
            </p>
          </div>
        </motion.section>

        {/* لوحة دورة الاعتماد (المرحلة 3) — للتقرير المفتوح فقط */}
        {openReport && openWorkflow && (
          <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="mb-6">
            <WorkflowPanel
              workflow={openWorkflow}
              reportId={openReport.id}
              version={openReport.version}
              onAction={handleWorkflowAction}
              onAssign={handleAssign}
              onDueDate={canAssignWorkflowFlag ? handleDueDate : undefined}
            />
          </motion.section>
        )}

        {/* Settings */}
        <Card className="mb-6 border-slate-200 shadow-sm dark:border-slate-800">
          <CardHeader className="pb-0">
            <CardTitle className="flex items-center gap-2 text-slate-800 dark:text-slate-100">
              <Settings2 className="size-4 text-emerald-600 dark:text-emerald-400" />
              إعدادات المطابقة
            </CardTitle>
            <CardDescription>ارفع الملفات واضبط الأعمدة والبادئات</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 pt-4">
            {/* Comparison mode selector */}
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                نمط المقارنة
              </Label>
              <div className="flex flex-wrap items-center gap-3">
                <label className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm transition-colors",
                  compareMode === "period"
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/50"
                )}>
                  <input
                    type="radio" name="compareMode" value="period"
                    checked={compareMode === "period"}
                    onChange={() => setCompareMode("period")}
                    className="size-3.5 accent-emerald-600"
                  />
                  <span className="font-semibold">الفترة الحالية مقابل السابقة</span>
                </label>
                <label className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm transition-colors",
                  compareMode === "monthCumulative"
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/50"
                )}>
                  <input
                    type="radio" name="compareMode" value="monthCumulative"
                    checked={compareMode === "monthCumulative"}
                    onChange={() => setCompareMode("monthCumulative")}
                    className="size-3.5 accent-emerald-600"
                  />
                  <span className="font-semibold">الشهر مقابل التراكمي (نسبة الشهر من السنة)</span>
                </label>
                <label className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2 text-sm transition-colors",
                  compareMode === "chart"
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/50"
                )}>
                  <input
                    type="radio" name="compareMode" value="chart"
                    checked={compareMode === "chart"}
                    onChange={() => setCompareMode("chart")}
                    className="size-3.5 accent-emerald-600"
                  />
                  <BookCheck className="size-3.5 text-emerald-500" />
                  <span className="font-semibold">مطابقة دليل الحسابات (بالاسم أو الرقم)</span>
                </label>
                {compareMode === "monthCumulative" && (
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs font-semibold text-slate-500">عدد أشهر التراكمي:</Label>
                    <Input
                      type="number" min={1} max={24} value={numMonths}
                      onChange={(e) => setNumMonths(Math.max(1, Math.min(24, Number(e.target.value) || 12)))}
                      className="tnum w-16" dir="ltr"
                    />
                  </div>
                )}
              </div>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                {compareMode === "period"
                  ? "المقارنة بين فترتين متساويتين (شهر مقابل شهر، أو سنة مقابل سنة) — يُعرض التغير ونسبته وحالة التغير."
                  : compareMode === "monthCumulative"
                    ? "المقارنة بين الشهر الحالي والتراكمي السنوي — يُعرض نسبة الشهر من التراكمي والمتبقي وحالة الشهر."
                    : "مطابقة دليل الحسابات بالاسم (≥ 90%) أو برقم الحساب — التصنيفات: أصول (1) · خصوم (2) · مصروفات (3، 5، 6) · إيرادات (4، 7). التغير الجوهري = تغير تصنيف الحساب."}
              </p>
            </div>

            {/* Files */}
            <div className="grid gap-4 lg:grid-cols-2">
              <FileSlot num={1} accent="amber" status={status1} label={l1} onLabel={setL1}
                onFile={(f) => handleFile(f, 1)} headers={raw1?.headers ?? []}
                cn={cn1} cd={cd1} setCn={setCn1} setCd={setCd1}
                periodLabel={compareMode === "monthCumulative" ? "التراكمي للسنة" : compareMode === "chart" ? "الدليل القديم" : "الفترة المقارنة (السابقة)"}
                labelPlaceholder={compareMode === "monthCumulative" ? "السنة 2026م" : compareMode === "chart" ? "الدليل القديم" : "يونيو 2025م"}
              />
              <FileSlot num={2} accent="emerald" status={status2} label={l2} onLabel={setL2}
                onFile={(f) => handleFile(f, 2)} headers={raw2?.headers ?? []}
                cn={cn2} cd={cd2} setCn={setCn2} setCd={setCd2}
                periodLabel={compareMode === "monthCumulative" ? "الشهر الحالي" : compareMode === "chart" ? "الدليل الجديد" : "الفترة الحالية"}
                labelPlaceholder={compareMode === "monthCumulative" ? "يونيو 2026م" : compareMode === "chart" ? "الدليل الجديد" : "يونيو 2026م"}
              />
            </div>

            {/* Base account + prefixes — hidden in chart mode */}
            {compareMode !== "chart" && (
            <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-900/40">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                  حساب صافي الإيرادات (الأساس)
                </Label>
                <AccountSelect
                  value={base}
                  onValueChange={(v) => setBase(v)}
                  options={baseOptions}
                  disabled={baseOptions.length === 0 || settingsLocked}
                  placeholder="— اختر الحساب —"
                />
              </div>

              <div>
                <p className="mb-2 text-xs font-bold text-slate-700 dark:text-slate-200">
                  بادئات بنود القائمة (IAS 1 — طريقة الوظيفة)
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                  <PrefixInput id="cp" label="تكلفة الإيرادات" value={costPrefix} onChange={setCostPrefix} disabled={settingsLocked} />
                  <PrefixInput id="sp" label="البيع والتوزيع" value={sellPrefix} onChange={setSellPrefix} disabled={settingsLocked} />
                  <PrefixInput id="gp" label="الإدارية والعمومية" value={adminPrefix} onChange={setAdminPrefix} disabled={settingsLocked} />
                  <PrefixInput id="op" label="تشغيلية أخرى" value={otherOpPrefix} onChange={setOtherOpPrefix} disabled={settingsLocked} />
                  <PrefixInput id="fp" label="التمويل" value={financePrefix} onChange={setFinancePrefix} disabled={settingsLocked} />
                  <PrefixInput id="tp" label="ضريبة الدخل" value={taxPrefix} onChange={setTaxPrefix} disabled={settingsLocked} />
                  <PrefixInput id="ocip" label="الدخل الشامل الآخر" value={ociPrefix} onChange={setOciPrefix} disabled={settingsLocked} />
                </div>
                <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
                  ⚠ الإجماليات من الحسابات الفرعية (الأوراق) فقط — الرئيسية تُعرض عريضة ·
                  البنود غير المصنفة تحت البادئة <b>3</b> تظهر ضمن «تشغيلية أخرى».
                  {settingsLocked && <span className="text-amber-600 dark:text-amber-400"> · الصلاحيات مطلوبة لتعديل البادئات.</span>}
                </p>
              </div>
            </div>
            )}

            {/* Balance sheet (optional) — collapsible. Hidden in chart mode */}
            {compareMode !== "chart" && (
            <Collapsible open={bsOpen} onOpenChange={setBsOpen} className="rounded-xl border border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/40">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-4 py-3 text-right transition-colors",
                    "hover:bg-slate-100/70 dark:hover:bg-slate-800/40",
                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40"
                  )}
                  aria-expanded={bsOpen}
                >
                  <span className="flex items-center gap-2">
                    <Scale className="size-4 text-emerald-600 dark:text-emerald-400" />
                    <span className="text-sm font-bold text-slate-700 dark:text-slate-200">قائمة المركز المالي</span>
                    <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                      اختياري
                    </span>
                    {hasBsData && (
                      <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                        ✓ مُفعّل — للتحليل المالي
                      </span>
                    )}
                  </span>
                  <ChevronDown
                    className={cn(
                      "size-4 text-slate-500 transition-transform",
                      bsOpen && "rotate-180"
                    )}
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 border-t border-slate-200 p-4 dark:border-slate-800">
                <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                  {compareMode === "period"
                    ? "ارفع ملفي أرصدة قائمة المركز المالي (مقارنة + حالي) لتفعيل"
                    : "ارفع ملف أرصدة قائمة المركز المالي (للتراكمي) لتفعيل"}
                  <strong className="font-semibold text-slate-700 dark:text-slate-200"> التحليل المالي</strong> —
                  نسب السيولة والمديونية والربحية والكفاءة. تُحسب الأصول بـ«مدين − دائن» والخصوم وحقوق الملكية بـ«دائن − مدين».
                </p>

                {/* BS Files — dynamic: 2 files in period mode, 1 file in month mode */}
                {compareMode === "period" ? (
                  <div className="grid gap-4 lg:grid-cols-2">
                    <FileSlot num={1} accent="amber" status={bsStatus1} label="" onLabel={() => {}}
                      onFile={(f) => handleBsFile(f, 1)} headers={bsRaw1?.headers ?? []}
                      cn={bsCn1} cd={bsCd1} setCn={setBsCn1} setCd={setBsCd1}
                      periodLabel="مركز مالي — مقارنة (سابقة)"
                      labelPlaceholder=""
                    />
                    <FileSlot num={2} accent="emerald" status={bsStatus2} label="" onLabel={() => {}}
                      onFile={(f) => handleBsFile(f, 2)} headers={bsRaw2?.headers ?? []}
                      cn={bsCn2} cd={bsCd2} setCn={setBsCn2} setCd={setBsCd2}
                      periodLabel="مركز مالي — حالي"
                      labelPlaceholder=""
                    />
                  </div>
                ) : (
                  <FileSlot num={1} accent="amber" status={bsStatus1} label="" onLabel={() => {}}
                    onFile={(f) => handleBsFile(f, 1)} headers={bsRaw1?.headers ?? []}
                    cn={bsCn1} cd={bsCd1} setCn={setBsCn1} setCd={setBsCd1}
                    periodLabel="مركز مالي — للتراكمي"
                    labelPlaceholder=""
                  />
                )}

                {/* BS Prefixes — Main categories */}
                <div>
                  <p className="mb-2 text-xs font-bold text-slate-700 dark:text-slate-200">
                    بادئات البنود الرئيسية لقائمة المركز المالي
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                    <BsPrefixSelect id="bsca" label="أصول متداولة" value={caPrefix} onChange={setCaPrefix} accounts={effBs1?.A ?? effBs2?.A ?? []} />
                    <BsPrefixSelect id="bsnca" label="أصول غير متداولة" value={ncaPrefix} onChange={setNcaPrefix} accounts={effBs1?.A ?? effBs2?.A ?? []} />
                    <BsPrefixSelect id="bscl" label="خصوم متداولة" value={clPrefix} onChange={setClPrefix} accounts={effBs1?.A ?? effBs2?.A ?? []} />
                    <BsPrefixSelect id="bsncl" label="خصوم غير متداولة" value={nclPrefix} onChange={setNclPrefix} accounts={effBs1?.A ?? effBs2?.A ?? []} />
                    <BsPrefixSelect id="bseq" label="حقوق الملكية" value={eqPrefix} onChange={setEqPrefix} accounts={effBs1?.A ?? effBs2?.A ?? []} />
                  </div>
                </div>

                {/* BS Prefixes — Detailed items */}
                <div>
                  <p className="mb-2 text-xs font-bold text-slate-700 dark:text-slate-200">
                    بادئات البنود التفصيلية (اختياري — يُكتشف بالاسم عند التركيب فارغاً)
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    <BsPrefixSelect id="bsinv" label="المخزون" value={invPrefix} onChange={setInvPrefix} accounts={effBs1?.A ?? effBs2?.A ?? []} />
                    <BsPrefixSelect id="bscash" label="النقدية" value={cashPrefix} onChange={setCashPrefix} accounts={effBs1?.A ?? effBs2?.A ?? []} />
                    <BsPrefixSelect id="bsrec" label="المدينون" value={recPrefix} onChange={setRecPrefix} accounts={effBs1?.A ?? effBs2?.A ?? []} />
                    <BsPrefixSelect id="bsfa" label="أصول ثابتة" value={faPrefix} onChange={setFaPrefix} accounts={effBs1?.A ?? effBs2?.A ?? []} />
                    <BsPrefixSelect id="bspay" label="الدائنون" value={payPrefix} onChange={setPayPrefix} accounts={effBs1?.A ?? effBs2?.A ?? []} />
                    <BsPrefixSelect id="bsstd" label="قروض قصيرة" value={stdPrefix} onChange={setStdPrefix} accounts={effBs1?.A ?? effBs2?.A ?? []} />
                    <BsPrefixSelect id="bsltd" label="قروض طويلة" value={ltdPrefix} onChange={setLtdPrefix} accounts={effBs1?.A ?? effBs2?.A ?? []} />
                  </div>
                  <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
                    ⚠ يمكنك تحديد <strong className="font-semibold text-slate-600 dark:text-slate-300">أكثر من حساب أب</strong> لكل بند: اكتب البادئة ثم اضغط Enter أو الفاصلة لإضافتها كـ chip، ثم أضف بادئة أخرى. اضغط × على الـ chip لإزالتها. اترك الحقل فارغًا لاكتشاف البند بالاسم تلقائيًا (للبنود التفصيلية فقط).
                  </p>
                </div>

                {/* BS Quick stats */}
                {hasBsData && (
                  <div className="grid grid-cols-2 gap-2 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 dark:border-emerald-900/50 dark:bg-emerald-950/20 sm:grid-cols-3 lg:grid-cols-5">
                    <BsStat label="إجمالي الأصول (مقارنة)" value={bsTotals1?.totalAssets ?? null} />
                    <BsStat label="إجمالي الأصول (حالي)" value={bsTotals2?.totalAssets ?? bsTotals1?.totalAssets ?? null} />
                    <BsStat label="حقوق الملكية (حالي)" value={bsTotals2?.equity ?? bsTotals1?.equity ?? null} />
                    <BsStat label="إجمالي الخصوم (حالي)" value={bsTotals2?.totalLiabilities ?? bsTotals1?.totalLiabilities ?? null} />
                    <BsStat label="رأس المال العامل (حالي)" value={bsTotals2 ? bsTotals2.currentAssets - bsTotals2.currentLiabilities : bsTotals1 ? bsTotals1.currentAssets - bsTotals1.currentLiabilities : null} />
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
            )}

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-3">
              {canAdd ? (
                <Button onClick={handleMatch} disabled={!bothReady} className="bg-emerald-600 text-white shadow-sm hover:bg-emerald-700">
                  <Play className="size-4" /> {compareMode === "chart" ? "بدء مطابقة الدليل" : "بدء المطابقة"}
                </Button>
              ) : (
                <span className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
                  ⚠ صلاحية «إضافة» مطلوبة لتشغيل المطابقة
                </span>
              )}
              {canExport && (
                <Button onClick={handleExport} disabled={!result} variant="outline" className="border-slate-300 dark:border-slate-700">
                  <Download className="size-4" /> تنزيل Excel
                </Button>
              )}
              {!bothReady && canAdd && <span className="text-xs text-slate-400 dark:text-slate-500">ارفع الملفين لتفعيل المطابقة</span>}
            </div>
          </CardContent>
        </Card>

        {/* Results — Chart-of-accounts mode */}
        {result && compareMode === "chart" && (
          <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200">
                <BookCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                مطابقة دليل الحسابات
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">بالاسم أو الرقم</span>
              </h2>
              <span className="text-xs text-slate-400 dark:text-slate-500">{L1} ← {L2}</span>
            </div>
            <ChartResultsTable rows={result} L1={L1} L2={L2} />
          </motion.section>
        )}

        {/* Results — Period/Month modes */}
        {result && cat && T && compareMode !== "chart" && (
          <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="space-y-4">
            <SummaryCards counts={counts} T={T} compareMode={compareMode} />
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200">
                  <FileSpreadsheet className="size-4 text-emerald-600 dark:text-emerald-400" />
                  قائمة الربح أو الخسارة والدخل الشامل
                  <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">IFRS · IAS 1</span>
                </h2>
                <span className="text-xs text-slate-400 dark:text-slate-500">{L1} ← {L2}</span>
              </div>
              <Tabs defaultValue="table" className="w-full">
                <TabsList className="h-auto min-h-9 flex-wrap justify-start bg-slate-100 dark:bg-slate-800">
                  <TabsTrigger value="table" className="gap-1.5">
                    <Table2 className="size-3.5" />
                    قائمة الربح والخسارة والدخل الشامل الآخر
                  </TabsTrigger>
                  <TabsTrigger value="charts" className="gap-1.5">
                    <BarChart3 className="size-3.5" />
                    تقرير الرسوم البياني
                  </TabsTrigger>
                  <TabsTrigger value="analysis" className="gap-1.5">
                    <Calculator className="size-3.5" />
                    التحليل المالي
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="table" className="mt-3">
                  <ResultsTable cat={cat} T={T} L1={L1} L2={L2} netRow={netRow} compareMode={compareMode} numMonths={numMonths} />
                </TabsContent>
                <TabsContent value="charts" className="mt-3">
                  <ChartsView
                    cat={cat}
                    T={T}
                    L1={L1}
                    L2={L2}
                    bs1={bsTotals1}
                    bs2={compareMode === "monthCumulative" ? bsTotals1 : bsTotals2}
                    ratioGroups={ratioGroups}
                  />
                </TabsContent>
                <TabsContent value="analysis" className="mt-3">
                  {hasBsData ? (
                    <FinancialAnalysis ratioGroups={ratioGroups} L1={L1} L2={L2} />
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-amber-300 bg-amber-50/40 py-14 text-center dark:border-amber-900/50 dark:bg-amber-950/20">
                      <div className="flex size-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
                        <Scale className="size-6" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">التحليل المالي غير متاح</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          ارفع ملف قائمة المركز المالي لعرض التحليل المالي
                        </p>
                      </div>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          </motion.section>
        )}

        {!result && (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white/50 py-16 text-center dark:border-slate-700 dark:bg-slate-900/30">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
              <FileSpreadsheet className="size-7" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">لم تُنتج المطابقة بعد</p>
              <p className="text-xs text-slate-400 dark:text-slate-500">ارفع الملفين واضبط البادئات ثم اضغط «بدء المطابقة»</p>
            </div>
          </div>
        )}
        </>)}
      </main>

      {/* Delete-group confirmation */}

      <AlertDialog open={!!deleteGroupTarget} onOpenChange={(open) => {
        if (!open && groupBusyId !== deleteGroupTarget?.id) setDeleteGroupTarget(null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <FolderX className="size-5 text-rose-600" />
              حذف المجموعة
            </AlertDialogTitle>
            <AlertDialogDescription>
              سيتم حذف المجموعة <strong className="text-slate-800 dark:text-slate-100">{deleteGroupTarget?.name}</strong>.
              التقارير بداخلها لن تُحذف — ستنتقل تلقائياً إلى «بدون مجموعة».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!groupBusyId}>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (deleteGroupTarget) void handleDeleteGroup(deleteGroupTarget.id);
              }}
              disabled={!!groupBusyId}
              className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700"
            >
              {groupBusyId ? (
                <><Loader2 className="size-4 animate-spin" /> جارٍ الحذف…</>
              ) : (
                <><FolderX className="size-4" /> حذف المجموعة</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* حوار تعارض النسخ (HTTP 409 VERSION_CONFLICT) — لا يمس تعديلات المستخدم تلقائيًا */}
      <AlertDialog
        open={!!conflictInfo}
        onOpenChange={(open) => {
          if (!open && !confirmReplace) setConflictInfo(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-500" />
              تعذر حفظ التغييرات
            </AlertDialogTitle>
            <AlertDialogDescription>
              تعذر حفظ التغييرات لأن هذا التقرير تم تعديله من مستخدم آخر بعد فتحه لديك.
              لم يُعدَّل أي شيء في الخادم، وتعديلاتك غير المحفوظة ما زالت موجودة في هذه الصفحة.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-slate-700 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-slate-200">
            <p>التقرير: <strong>{conflictInfo?.reportName}</strong></p>
            <p>
              النسخة لديك: <strong dir="ltr">v{conflictInfo?.clientVersion}</strong>
              {" "}· النسخة الحالية في الخادم: <strong dir="ltr">v{conflictInfo?.currentVersion ?? "؟"}</strong>
            </p>
            {conflictInfo?.updatedAt && (
              <p>آخر تعديل (من الخادم): <strong>{fmtServerDateTime(conflictInfo.updatedAt)}</strong></p>
            )}
            {conflictInfo?.lastModifiedBy && (
              <p>آخر تعديل بواسطة: <strong>{conflictInfo.lastModifiedBy}</strong></p>
            )}
          </div>
          <p className="text-xs font-semibold leading-relaxed text-amber-700 dark:text-amber-400">
            ⚠ تحميل أحدث نسخة سيستبدل تعديلاتك غير المحفوظة في هذه الصفحة. يمكنك أيضًا الإبقاء على تعديلاتك ثم حفظها كنسخة جديدة.
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel>إبقاء تعديلاتي</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setConfirmReplace(true);
              }}
              className="gap-1.5 bg-amber-600 text-white hover:bg-amber-700"
            >
              <RefreshCw className="size-4" />
              تحميل أحدث نسخة
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* تأكيد الاستبدال قبل تحميل أحدث نسخة (خطوة تأكيد إلزامية قبل فقد التعديلات) */}
      <AlertDialog
        open={confirmReplace}
        onOpenChange={(open) => {
          if (!reloadingLatest) setConfirmReplace(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>تأكيد تحميل أحدث نسخة</AlertDialogTitle>
            <AlertDialogDescription>
              سيتم استبدال جميع تعديلاتك غير المحفوظة في هذه الصفحة بآخر نسخة من الخادم
              {conflictInfo?.currentVersion ? (
                <> (النسخة <span dir="ltr">v{conflictInfo.currentVersion}</span>)</>
              ) : null}
              . هذا الإجراء لا يمكن التراجع عنه.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reloadingLatest}>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void reloadLatestReport();
              }}
              disabled={reloadingLatest}
              className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {reloadingLatest ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              نعم، استبدال بآخر نسخة
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ── FileSlot component ──────────────────────────────────────────────── */

function FileSlot({ num, accent, status, label, onLabel, onFile, headers, cn, cd, setCn, setCd, periodLabel, labelPlaceholder }: {
  num: 1 | 2; accent: "emerald" | "amber"; status: FileStatus; label: string; onLabel: (v: string) => void;
  onFile: (f: File) => void; headers: string[]; cn: number | null; cd: number | null;
  setCn: (v: number) => void; setCd: (v: number) => void; periodLabel: string; labelPlaceholder: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={"flex size-6 items-center justify-center rounded-md text-xs font-bold text-white " + (accent === "emerald" ? "bg-emerald-600" : "bg-amber-500")}>{num}</span>
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">الملف {num === 1 ? "الأول" : "الثاني"}</span>
        </div>
        <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500">{periodLabel}</span>
      </div>
      <FileDropzone status={status} onFile={onFile} accent={accent} />
      <div className="mt-3 space-y-1.5">
        <Label className="text-xs font-semibold text-slate-600 dark:text-slate-300">التسمية</Label>
        <Input value={label} onChange={(e) => onLabel(e.target.value)}
          placeholder={labelPlaceholder} className="w-full" />
      </div>
      {headers.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">عمود الاسم</Label>
            <ColumnSelect headers={headers} value={cn} onChange={setCn} placeholder="الاسم" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">عمود المدين</Label>
            <ColumnSelect headers={headers} value={cd} onChange={setCd} placeholder="المدين" />
          </div>
        </div>
      )}
    </div>
  );
}

/* ── BsStat component (small inline stat for BS quick preview) ────────── */

function BsStat({ label, value }: { label: string; value: number | null }) {
  const display = value == null ? "—" : fmtAmount(value);
  const isNeg = value != null && value < 0;
  return (
    <div className="flex flex-col gap-0.5 rounded-md bg-white/70 px-2.5 py-1.5 dark:bg-slate-900/50">
      <span className="text-[10px] text-slate-500 dark:text-slate-400">{label}</span>
      <span className={cn(
        "tnum text-xs font-bold leading-tight",
        isNeg ? "text-rose-600 dark:text-rose-400" : "text-slate-800 dark:text-slate-100"
      )}>{display}</span>
    </div>
  );
}

/* ── ReportRow (single saved report entry inside the load dialog) ─────── */

function ReportRow({
  r, onLoad, onDelete, canDelete, isOwner, isOpen, currentUserId,
}: {
  r: { id: string; name: string; label1: string; label2: string; updatedAt: string; groupId: string | null; userId: string | null; version?: number; status?: string; cycle?: number; preparedById?: string | null; reviewedById?: string | null; approvedById?: string | null };
  onLoad: (id: string) => void;
  onDelete: (id: string) => void;
  canDelete: boolean;
  /**
   * Whether the current user owns this report. Reports in linked groups (shared
   * by another admin) are read-only — the delete button is hidden for them.
   */
  isOwner: boolean;
  /** هل هذا التقرير مفتوح حاليًا في الجلسة (يُحدَّث عند الحفظ) */
  isOpen?: boolean;
  currentUserId?: string;
}) {
  const statusKey = (r.status as keyof typeof WORKFLOW_STATUS_BADGE_CLASS) || "DRAFT";
  const isMyRole = !!currentUserId && (r.preparedById === currentUserId || r.reviewedById === currentUserId || r.approvedById === currentUserId);
  return (
    <div className={cn(
      "flex items-center justify-between gap-2 px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/40",
      isOpen && "bg-emerald-50/60 dark:bg-emerald-950/20"
    )}>
      <button
        onClick={() => onLoad(r.id)}
        className="flex-1 text-right transition-colors"
      >
        <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
          <span className="truncate">{r.name}</span>
          {typeof r.version === "number" && (
            <span dir="ltr" className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400">v{r.version}</span>
          )}
          {r.status && (
            <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold", WORKFLOW_STATUS_BADGE_CLASS[statusKey] ?? WORKFLOW_STATUS_BADGE_CLASS.DRAFT)}>
              {WORKFLOW_STATUS_LABELS[statusKey] ?? r.status}
            </span>
          )}
          {isMyRole && (
            <span className="shrink-0 rounded bg-teal-100 px-1.5 py-0.5 text-[9px] font-bold text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">دوري</span>
          )}
          {isOpen && (
            <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400">مفتوح</span>
          )}
        </div>
        <div className="text-[11px] text-slate-400">
          {r.label1 || "—"} ← {r.label2 || "—"} · آخر تعديل: {new Date(r.updatedAt).toLocaleDateString("ar")}
        </div>
      </button>
      {canDelete && isOwner && r.status === "DRAFT" && (
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30"
          onClick={() => onDelete(r.id)}
          aria-label="حذف التقرير"
          title="حذف التقرير (المسودة فقط)"
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
