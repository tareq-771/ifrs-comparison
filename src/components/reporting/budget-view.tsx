"use client";

// 6.7 — الموازنة وفعلي مقابل موازنة فوق خدمات 6.5 الحالية حصرًا.
// Workflow: DRAFT → SUBMITTED → APPROVED → LOCKED (بلا Unlock).
// الدقة: المبالغ minor كسلاسل BigInt — الإدخال العشري يتحول عبر lib/money بلا فقد دقة.

import * as React from "react";
import {
  AlertTriangle, CheckCircle2, Copy, FileDown, FileSpreadsheet, Loader2, Lock, Plus, Send, Target, Trash2, Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { decimalStringToMinorString, formatMinor } from "@/lib/money";
import { useCompanyPeriod } from "@/components/reporting/company-period-context";
import {
  BUDGET_STATUS_LABELS, BUDGET_TYPE_LABELS, BUDGET_SCENARIO_LABELS,
} from "@/lib/budget";
import { budgetVarianceBadge, classificationLabel, comparisonStatusLabel } from "@/lib/display-labels";
import { canManageTrialBalances, parsePermissions, type Permissions } from "@/lib/permissions";
import { PrintableReport, PrintButton } from "@/components/reporting/report-print";
import { buildReportHeaderMeta } from "@/lib/report-header";
import { exportReportCsv, safeExportFilename, type ExportColumn } from "@/lib/report-export";
import { useSession } from "next-auth/react";

interface StatementLineRef { id: string; code: string; nameAr: string; statementType: string; isActive: boolean; isSubtotal: boolean; }
interface BudgetLineRow { id: string; statementLineCode: string; fiscalPeriodId: string | null; amountMinor: string; note?: string; }
interface BudgetRow {
  id: string; companyId: string; fiscalYearId: string; budgetType: string; scenario: string;
  name?: string | null; note?: string | null; versionNumber: number; status: string;
  startOrdinal: number; endOrdinal: number; version: number;
  lines?: BudgetLineRow[];
  fiscalYear?: { code: string; displayNameAr: string; periodCount: number };
}
interface VarianceRow {
  statementLineCode: string;
  lineNameAr?: string | null;
  lineNameEn?: string | null;
  lineNature: string;
  budgetMinor: string | null; actualMinor: string | null; actualStatus: string;
  varianceMinor: string | null; variancePct: string | null; favorability: string;
}
interface VarianceResponse {
  budget: { id: string; versionNumber: number; scenario: string; status: string; budgetType: string } | null;
  granularity: string;
  range: { startOrdinal: number; endOrdinal: number };
  rows: VarianceRow[];
  status: string;
}

const BUDGET_STATUS_BADGE: Record<string, string> = {
  DRAFT: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  SUBMITTED: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  LOCKED: "bg-stone-200 text-stone-800 dark:bg-stone-800 dark:text-stone-300",
};

function fmt(minor: string | null | undefined, minorUnits: number): string {
  if (minor === null || minor === undefined) return "—";
  return formatMinor(minor, minorUnits);
}

export function BudgetView() {
  const { toast } = useToast();
  const { data: session } = useSession();
  const {
    companies, companiesLoading, selectedCompanyId, setSelectedCompanyId, selectedCompany,
    fiscalYears, fiscalYearsLoading, selectedFiscalYearId, setSelectedFiscalYearId, selectedFiscalYear,
    minorUnits,
  } = useCompanyPeriod();

  const perms = React.useMemo<Permissions>(() => {
    if (!session?.user) return parsePermissions(null);
    const raw = (session.user as { permissions?: unknown }).permissions;
    if (typeof raw === "string") return parsePermissions(raw);
    if (raw && typeof raw === "object") return parsePermissions(JSON.stringify(raw));
    return parsePermissions(null);
  }, [session]);
  const role = ((session?.user as { role?: string } | undefined)?.role) ?? "user";
  const canManage = canManageTrialBalances(perms, role);

  const [tab, setTab] = React.useState("budgets");

  // 6.8 — رابط عميق من مركز التقارير: ?view=budget&tab=variance&ordinal=2 (بعد الترطيب)
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tab");
    if (t === "budgets" || t === "variance") setTab(t);
    // ordinal تقرأه لوحة المقارنة مباشرة (مكوّن مستقل)
  }, []);
  const [budgets, setBudgets] = React.useState<BudgetRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createSaving, setCreateSaving] = React.useState(false);
  const [createType, setCreateType] = React.useState("ANNUAL");
  const [createScenario, setCreateScenario] = React.useState("BASE");
  const [createName, setCreateName] = React.useState("");
  const [createNote, setCreateNote] = React.useState("");
  const [createStart, setCreateStart] = React.useState("1");
  const [createEnd, setCreateEnd] = React.useState("12");
  const [lineDrafts, setLineDrafts] = React.useState<Array<{ code: string; amount: string; distribute: boolean }>>([]);
  const [stmtLines, setStmtLines] = React.useState<StatementLineRef[]>([]);

  // Edit lines dialog (DRAFT فقط)
  const [editTarget, setEditTarget] = React.useState<BudgetRow | null>(null);
  const [editLines, setEditLines] = React.useState<Array<{ code: string; periodId: string; amount: string }>>([]);
  const [editSaving, setEditSaving] = React.useState(false);

  // Reason dialog (transitions + revision)
  const [reasonTarget, setReasonTarget] = React.useState<{ budget: BudgetRow; action: string } | null>(null);
  const [reasonText, setReasonText] = React.useState("");

  const periods = selectedFiscalYear?.periods ?? [];
  const periodCount = selectedFiscalYear?.periodCount ?? periods.length ?? 0;

  const loadBudgets = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/budgets", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as BudgetRow[];
      setBudgets(Array.isArray(rows) ? rows : []);
    } catch (e) {
      toast({ title: "فشل جلب الموازنات", description: e instanceof Error ? e.message : "", variant: "destructive" });
      setBudgets([]);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadStmtLines = React.useCallback(async () => {
    try {
      const res = await fetch("/api/account-nature/statement-lines", { cache: "no-store" });
      if (res.ok) {
        const rows = (await res.json()) as StatementLineRef[];
        setStmtLines(rows.filter((l) => l.isActive && !l.isSubtotal));
      }
    } catch {
      setStmtLines([]);
    }
  }, []);

  React.useEffect(() => {
    void loadBudgets();
    void loadStmtLines();
  }, [loadBudgets, loadStmtLines]);

  const companyBudgets = budgets.filter((b) => b.companyId === selectedCompanyId);
  const fyBudgets = companyBudgets.filter((b) => !selectedFiscalYearId || b.fiscalYearId === selectedFiscalYearId);

  React.useEffect(() => {
    const last = String(Math.max(1, periodCount || 1));
    setCreateEnd(last);
  }, [selectedFiscalYearId]);

  /* ── إنشاء موازنة ── */
  const buildCreateLines = (): Array<{ statementLineCode: string; fiscalPeriodId: string | null; amountMinor: string }> | null => {
    const out: Array<{ statementLineCode: string; fiscalPeriodId: string | null; amountMinor: string }> = [];
    const from = Math.max(1, Number(createStart) || 1);
    const to = Math.min(periodCount || 12, Number(createEnd) || periodCount || 12);
    for (const d of lineDrafts) {
      const minor = decimalStringToMinorString(d.amount, minorUnits);
      if (minor === null) {
        toast({ title: "مبلغ غير صالح", description: `البند ${d.code}: أدخل رقمًا عشريًا صالحًا (مثال 1250000.50).`, variant: "destructive" });
        return null;
      }
      if (d.distribute && createType !== "ANNUAL") {
        const n = to - from + 1;
        // توزيع متساوٍ بلا فقد minor — عبر المساعد النقي نفسه في الخادم
        const total = BigInt(minor);
        const base = total / BigInt(n);
        let rem = total % BigInt(n);
        for (let i = 0; i < n; i++) {
          const p = periods.find((x) => x.ordinal === from + i);
          let amt = base;
          if (rem > BigInt(0)) { amt = amt + BigInt(1); rem = rem - BigInt(1); }
          out.push({ statementLineCode: d.code, fiscalPeriodId: p?.id ?? null, amountMinor: amt.toString() });
        }
      } else {
        out.push({ statementLineCode: d.code, fiscalPeriodId: null, amountMinor: minor });
      }
    }
    return out;
  };

  const submitCreate = async () => {
    if (!selectedCompanyId || !selectedFiscalYearId) return;
    const lines = buildCreateLines();
    if (!lines || lines.length === 0) {
      toast({ title: "أضف بندًا واحدًا على الأقل بمبلغ صالح", variant: "destructive" });
      return;
    }
    setCreateSaving(true);
    try {
      const res = await fetch("/api/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          fiscalYearId: selectedFiscalYearId,
          budgetType: createType,
          scenario: createScenario,
          name: createName.trim() || undefined,
          note: createNote.trim() || undefined,
          startOrdinal: Number(createStart) || 1,
          endOrdinal: Number(createEnd) || periodCount || 12,
          lines,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "أُنشئت الموازنة (مسودة)", description: `نسخة #${data?.versionNumber ?? 1} — أرسلها للاعتماد عند الجاهزية.` });
      setCreateOpen(false);
      setLineDrafts([]);
      setCreateName(""); setCreateNote("");
      await loadBudgets();
    } catch (e) {
      toast({ title: "فشل إنشاء الموازنة", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setCreateSaving(false);
    }
  };

  /* ── تعديل بنود مسودة ── */
  const openEdit = (b: BudgetRow) => {
    setEditTarget(b);
    setEditLines((b.lines ?? []).map((l) => ({
      code: l.statementLineCode,
      periodId: l.fiscalPeriodId ?? "",
      amount: l.amountMinor,
    })));
  };

  const submitEdit = async () => {
    if (!editTarget) return;
    const lines: Array<{ statementLineCode: string; fiscalPeriodId: string | null; amountMinor: string }> = [];
    for (const l of editLines) {
      // المبالغ المجلوبة تبقى minor نصية؛ الجديدة تتحول من الإدخال العشري
      const minor = /^\d+$/.test(l.amount.trim()) ? l.amount.trim() : decimalStringToMinorString(l.amount, minorUnits);
      if (minor === null) {
        toast({ title: "مبلغ غير صالح للبند " + l.code, variant: "destructive" });
        return;
      }
      lines.push({ statementLineCode: l.code, fiscalPeriodId: l.periodId || null, amountMinor: minor });
    }
    if (lines.length === 0) {
      toast({ title: "لا يمكن حفظ موازنة بلا بنود", variant: "destructive" });
      return;
    }
    setEditSaving(true);
    try {
      const res = await fetch(`/api/budgets/${editTarget.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: editTarget.version, lines }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "حُفظت البنود" });
      setEditTarget(null);
      await loadBudgets();
    } catch (e) {
      toast({ title: "فشل حفظ البنود", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setEditSaving(false);
    }
  };

  /* ── الانتقالات + النسخ (بسبب إلزامي) ── */
  const submitReasonAction = async () => {
    if (!reasonTarget) return;
    const { budget, action } = reasonTarget;
    setBusyId(budget.id);
    try {
      let res: Response;
      if (action === "revision") {
        res = await fetch(`/api/budgets/${budget.id}/revision`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reasonText.trim() }),
        });
      } else {
        res = await fetch(`/api/budgets/${budget.id}/transition`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, version: budget.version, reason: reasonText.trim() || undefined }),
        });
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: action === "revision" ? "أُنشئت نسخة جديدة" : "تم تحديث حالة الموازنة" });
      setReasonTarget(null);
      setReasonText("");
      await loadBudgets();
    } catch (e) {
      toast({ title: "فشل الإجراء", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const deleteBudget = async (b: BudgetRow) => {
    setBusyId(b.id);
    try {
      const res = await fetch(`/api/budgets/${b.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: b.version }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "حُذفت المسودة" });
      await loadBudgets();
    } catch (e) {
      toast({ title: "فشل الحذف", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6" dir="rtl">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="size-4 text-emerald-600 dark:text-emerald-400" />
            الموازنة والمقارنات
          </CardTitle>
          <CardDescription>
            نسخ موازنة محكومة (DRAFT → SUBMITTED → APPROVED → LOCKED) — المقفلة غير قابلة للتعديل ولا يوجد Unlock.
            فعلي مقابل موازنة يقرأ أحدث مراجعة معتمدة من ميزان المراجعة.
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
              <SelectTrigger aria-label="السنة"><SelectValue placeholder={fiscalYearsLoading ? "…" : "اختر سنة"} /></SelectTrigger>
              <SelectContent className="max-h-64">
                {fiscalYears.map((f) => <SelectItem key={f.id} value={f.id}><span className="tnum">{f.code}</span></SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {canManage && (
            <div className="flex items-end">
              <Button onClick={() => setCreateOpen(true)} disabled={!selectedCompanyId || !selectedFiscalYearId} className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700">
                <Plus className="size-4" /> موازنة جديدة
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex w-full flex-wrap sm:w-fit">
          <TabsTrigger value="budgets">الموازنات ({fyBudgets.length})</TabsTrigger>
          <TabsTrigger value="variance">فعلي مقابل موازنة</TabsTrigger>
        </TabsList>

        {/* ── قائمة الموازنات ── */}
        <TabsContent value="budgets" className="mt-4">
          <Card>
            <CardContent className="pt-4">
              {loading ? (
                <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />جارٍ التحميل…</div>
              ) : !selectedCompanyId ? (
                <p className="p-6 text-center text-sm text-muted-foreground">اختر شركة أولًا.</p>
              ) : fyBudgets.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">لا موازنات لهذه الشركة/السنة بعد.</p>
              ) : (
                <div className="max-h-96 overflow-y-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">الاسم</TableHead>
                        <TableHead className="text-right">النوع</TableHead>
                        <TableHead className="text-right">السيناريو</TableHead>
                        <TableHead className="text-right">النسخة</TableHead>
                        <TableHead className="text-right">المدى</TableHead>
                        <TableHead className="text-right">البنود</TableHead>
                        <TableHead className="text-right">الحالة</TableHead>
                        <TableHead className="text-left">إجراءات</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fyBudgets.map((b) => (
                        <TableRow key={b.id}>
                          <TableCell className="text-sm">{b.name || "—"}</TableCell>
                          <TableCell className="text-xs">{BUDGET_TYPE_LABELS[b.budgetType as keyof typeof BUDGET_TYPE_LABELS] ?? b.budgetType}</TableCell>
                          <TableCell className="text-xs">{BUDGET_SCENARIO_LABELS[b.scenario as keyof typeof BUDGET_SCENARIO_LABELS] ?? b.scenario}</TableCell>
                          <TableCell className="text-sm tnum">#{b.versionNumber}</TableCell>
                          <TableCell className="text-xs tnum">{b.startOrdinal}–{b.endOrdinal}</TableCell>
                          <TableCell className="text-sm tnum">{b.lines?.length ?? 0}</TableCell>
                          <TableCell><Badge className={BUDGET_STATUS_BADGE[b.status] ?? ""}>{BUDGET_STATUS_LABELS[b.status as keyof typeof BUDGET_STATUS_LABELS] ?? b.status}</Badge></TableCell>
                          <TableCell className="text-left">
                            <div className="flex items-center justify-end gap-1">
                              {canManage && b.status === "DRAFT" && (
                                <>
                                  <Button variant="ghost" size="sm" aria-label="تعديل البنود" onClick={() => openEdit(b)} disabled={busyId === b.id}><FileSpreadsheet className="size-3.5" /></Button>
                                  <Button variant="ghost" size="sm" aria-label="إرسال للاعتماد" title="SUBMITTED" onClick={() => setReasonTarget({ budget: b, action: "SUBMIT" })} disabled={busyId === b.id}><Send className="size-3.5" /></Button>
                                  <Button variant="ghost" size="sm" aria-label="حذف المسودة" onClick={() => deleteBudget(b)} disabled={busyId === b.id}><Trash2 className="size-3.5 text-rose-600" /></Button>
                                </>
                              )}
                              {canManage && b.status === "SUBMITTED" && (
                                <>
                                  <Button variant="ghost" size="sm" aria-label="اعتماد" title="APPROVED" onClick={() => setReasonTarget({ budget: b, action: "APPROVE" })} disabled={busyId === b.id}><CheckCircle2 className="size-3.5 text-emerald-600" /></Button>
                                  <Button variant="ghost" size="sm" aria-label="إعادة كمسودة" title="RETURN" onClick={() => setReasonTarget({ budget: b, action: "RETURN" })} disabled={busyId === b.id}><Undo2 className="size-3.5 text-amber-600" /></Button>
                                </>
                              )}
                              {canManage && b.status === "APPROVED" && (
                                <Button variant="ghost" size="sm" aria-label="إقفال" title="LOCK — نهائي بلا Unlock" onClick={() => setReasonTarget({ budget: b, action: "LOCK" })} disabled={busyId === b.id}><Lock className="size-3.5 text-stone-600" /></Button>
                              )}
                              {canManage && b.status !== "DRAFT" && (
                                <Button variant="ghost" size="sm" aria-label="نسخة جديدة" title="نسخة جديدة versionNumber+1 مع نسخ البنود — بسبب موثق" onClick={() => setReasonTarget({ budget: b, action: "revision" })} disabled={busyId === b.id}><Copy className="size-3.5" /></Button>
                              )}
                              {b.status === "LOCKED" && (
                                <span className="text-[10px] text-muted-foreground" title="LOCKED غير قابل للتعديل — لا Unlock في هذه المرحلة">مقفلة نهائيًا</span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── فعلي مقابل موازنة ── */}
        <TabsContent value="variance" className="mt-4">
          <VariancePanel canView={canManage} minorUnits={minorUnits} />
        </TabsContent>
      </Tabs>

      {/* ── حوار إنشاء موازنة ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle>موازنة جديدة</DialogTitle>
            <DialogDescription>
              تُنشأ كمسودة. المبالغ بوحدة العملة ({selectedCompany?.functionalCurrency ?? "—"}) — تُخزن بدقة minor units.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>نوع الموازنة</Label>
                <Select value={createType} onValueChange={setCreateType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(BUDGET_TYPE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>السيناريو</Label>
                <Select value={createScenario} onValueChange={setCreateScenario}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(BUDGET_SCENARIO_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>الاسم (اختياري)</Label>
                <Input value={createName} onChange={(e) => setCreateName(e.target.value)} maxLength={120} placeholder="موازنة السنة" />
              </div>
              <div className="space-y-1.5">
                <Label>المدى (فترات)</Label>
                <div className="flex items-center gap-2">
                  <Input type="number" min={1} max={periodCount || 12} value={createStart} onChange={(e) => setCreateStart(e.target.value)} className="tnum" dir="ltr" />
                  <span>إلى</span>
                  <Input type="number" min={Number(createStart) || 1} max={periodCount || 12} value={createEnd} onChange={(e) => setCreateEnd(e.target.value)} className="tnum" dir="ltr" />
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>ملاحظة (اختياري)</Label>
              <Input value={createNote} onChange={(e) => setCreateNote(e.target.value)} maxLength={500} />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>البنود</Label>
                <Button
                  variant="outline" size="sm"
                  onClick={() => setLineDrafts((d) => [...d, { code: "", amount: "", distribute: createType !== "ANNUAL" }])}
                >
                  <Plus className="size-3.5" /> إضافة بند
                </Button>
              </div>
              {lineDrafts.length === 0 && (
                <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                  أضف بندًا: اختر بند القائمة المالية وأدخل المبلغ.
                </p>
              )}
              {lineDrafts.map((d, i) => (
                <div key={i} className="grid grid-cols-[1fr_140px_auto] items-end gap-2 rounded-md border p-2">
                  <div className="space-y-1">
                    <Label className="text-[10px]">بند القائمة</Label>
                    <Select value={d.code} onValueChange={(v) => setLineDrafts((arr) => arr.map((x, j) => (j === i ? { ...x, code: v } : x)))}>
                      <SelectTrigger><SelectValue placeholder="اختر بندًا" /></SelectTrigger>
                      <SelectContent className="max-h-56">
                        {stmtLines.map((l) => <SelectItem key={l.id} value={l.code}><span className="font-mono text-[10px]">{l.code}</span> — {l.nameAr}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">المبلغ الإجمالي</Label>
                    <Input
                      value={d.amount} dir="ltr" className="tnum"
                      placeholder="0.00"
                      onChange={(e) => setLineDrafts((arr) => arr.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                    />
                  </div>
                  <div className="flex flex-col items-start gap-1 pb-1">
                    {createType !== "ANNUAL" && (
                      <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={d.distribute}
                          onChange={(e) => setLineDrafts((arr) => arr.map((x, j) => (j === i ? { ...x, distribute: e.target.checked } : x)))}
                        />
                        توزيع متساوٍ على الفترات
                      </label>
                    )}
                    <Button variant="ghost" size="icon" className="size-8 text-rose-600" aria-label="إزالة البند" onClick={() => setLineDrafts((arr) => arr.filter((_, j) => j !== i))}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={createSaving}>إلغاء</Button>
            <Button onClick={submitCreate} disabled={createSaving || lineDrafts.length === 0 || lineDrafts.every((d) => !d.code)}>
              {createSaving ? <Loader2 className="size-4 animate-spin" /> : null}
              إنشاء (مسودة)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── حوار تعديل بنود مسودة ── */}
      <Dialog open={!!editTarget} onOpenChange={(v) => !v && setEditTarget(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle>تعديل بنود الموازنة (مسودة #{editTarget?.versionNumber})</DialogTitle>
            <DialogDescription>المبالغ المعروضة بوحدة minor المخزنة — أي تعديل يُحفظ بنفس الدقة. التعديل متاح للمسودة حصرًا.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {editLines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_130px_130px_auto] items-end gap-2 rounded-md border p-2">
                <div className="space-y-1">
                  <Label className="text-[10px]">البند</Label>
                  <Select value={l.code} onValueChange={(v) => setEditLines((arr) => arr.map((x, j) => (j === i ? { ...x, code: v } : x)))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-56">
                      {stmtLines.map((sl) => <SelectItem key={sl.id} value={sl.code}><span className="font-mono text-[10px]">{sl.code}</span> — {sl.nameAr}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px]">الفترة (اختياري)</Label>
                  <Select value={l.periodId || "__null__"} onValueChange={(v) => setEditLines((arr) => arr.map((x, j) => (j === i ? { ...x, periodId: v === "__null__" ? "" : v } : x)))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-56">
                      <SelectItem value="__null__">كل المدى</SelectItem>
                      {periods.map((p) => <SelectItem key={p.id} value={p.id}>{p.ordinal} — {p.displayLabel}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px]">المبلغ (minor أو عشري)</Label>
                  <Input
                    value={l.amount} dir="ltr" className="tnum"
                    onChange={(e) => setEditLines((arr) => arr.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  />
                </div>
                <Button variant="ghost" size="icon" className="size-8 text-rose-600" aria-label="إزالة" onClick={() => setEditLines((arr) => arr.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setEditLines((arr) => [...arr, { code: "", periodId: "", amount: "" }])}>
              <Plus className="size-3.5" /> إضافة بند
            </Button>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditTarget(null)} disabled={editSaving}>إلغاء</Button>
            <Button onClick={submitEdit} disabled={editSaving}>
              {editSaving ? <Loader2 className="size-4 animate-spin" /> : null}
              حفظ البنود
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── حوار السبب (انتقالات + نسخة جديدة) ── */}
      <Dialog open={!!reasonTarget} onOpenChange={(v) => { if (!v) { setReasonTarget(null); setReasonText(""); } }}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>
              {reasonTarget?.action === "revision" ? "إنشاء نسخة جديدة (versionNumber+1)" :
                reasonTarget?.action === "SUBMIT" ? "إرسال للاعتماد" :
                reasonTarget?.action === "APPROVE" ? "اعتماد الموازنة" :
                reasonTarget?.action === "LOCK" ? "إقفال نهائي (LOCK)" : "إعادة كمسودة"}
            </DialogTitle>
            <DialogDescription>
              {reasonTarget?.action === "LOCK" ? "الموازنة المقفلة غير قابلة للتعديل نهائيًا — لا يوجد Unlock في هذه المرحلة." :
                reasonTarget?.action === "revision" ? "تُنسخ البنود كنقطة بداية لنسخة جديدة برقم أعلى." :
                "السبب يُدوّن في سجل التدقيق."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>السبب {reasonTarget?.action !== "SUBMIT" && reasonTarget?.action !== "APPROVE" ? "(إلزامي)" : "(اختياري — يفضل التدوين)"}</Label>
            <Textarea value={reasonText} onChange={(e) => setReasonText(e.target.value)} rows={3} maxLength={300} />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setReasonTarget(null); setReasonText(""); }} disabled={busyId !== null}>إلغاء</Button>
            <Button
              onClick={submitReasonAction}
              disabled={busyId !== null || (reasonTarget?.action !== "SUBMIT" && reasonTarget?.action !== "APPROVE" && !reasonText.trim())}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {busyId !== null ? <Loader2 className="size-4 animate-spin" /> : null}
              تنفيذ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── فعلي مقابل موازنة ── */
/** تسميات التفصيل الزمني (6.8 — ترويسة التقرير، بلا تغيير منطق 6.5). */
const GRANULARITY_LABELS: Record<string, string> = {
  MONTH: "شهري",
  QUARTER: "ربع سنوي",
  SEMI_ANNUAL: "نصف سنوي",
  ANNUAL: "سنوي كامل",
  YTD: "تراكمي (YTD)",
};

function VariancePanel({ canView, minorUnits }: { canView: boolean; minorUnits: number }) {
  const { toast } = useToast();
  const { selectedCompanyId, selectedFiscalYearId, selectedCompany, selectedFiscalYear } = useCompanyPeriod();
  const [granularity, setGranularity] = React.useState("MONTH");
  const [ordinal, setOrdinal] = React.useState("");

  // 6.8 — رابط عميق: ?view=budget&tab=variance&granularity=QUARTER&ordinal=2 (بعد الترطيب)
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const g = q.get("granularity");
    if (g === "MONTH" || g === "QUARTER" || g === "SEMI_ANNUAL" || g === "ANNUAL" || g === "YTD") setGranularity(g);
    const o = q.get("ordinal");
    if (o && /^\d+$/.test(o)) setOrdinal(o);
  }, []);
  const [data, setData] = React.useState<VarianceResponse | null>(null);
  const [loading, setLoading] = React.useState(false);

  const periodsCount = 12;

  // 6.8 — تصدير CSV (طبقة report-export) — القيم minor تبقى سلاسل نصية بلا تحويل رقمي
  const exportVarianceCsv = React.useCallback(() => {
    if (!data) return;
    const columns: ExportColumn<VarianceRow>[] = [
      { key: "line", label: "البند", value: (r) => `${r.lineNameAr ?? r.statementLineCode} — ${r.statementLineCode} (${classificationLabel(r.lineNature, "ar")})` },
      { key: "budget", label: "الموازنة (minor)", numeric: true, value: (r) => r.budgetMinor ?? "" },
      { key: "actual", label: "الفعلي (minor)", numeric: true, value: (r) => r.actualMinor ?? "" },
      { key: "variance", label: "الفارق (minor)", numeric: true, value: (r) => r.varianceMinor ?? "" },
      { key: "pct", label: "الفارق %", value: (r) => r.variancePct ?? "" },
      {
        key: "fav", label: "تفسير الموازنة",
        value: (r) =>
          budgetVarianceBadge(
            {
              lineNature: (r.lineNature === "REVENUE" || r.lineNature === "EXPENSE" ? r.lineNature : "OTHER"),
              favorability: r.favorability,
              hasData: r.actualMinor !== null && r.budgetMinor !== null,
            },
            "ar"
          ),
      },
    ];
    exportReportCsv(
      columns,
      data.rows,
      safeExportFilename("actual-vs-budget", selectedCompany?.code, selectedFiscalYear?.code, data.granularity),
    );
  }, [data, selectedCompany, selectedFiscalYear]);

  const load = React.useCallback(async () => {
    if (!selectedCompanyId || !selectedFiscalYearId) { setData(null); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/budgets/variance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: selectedCompanyId,
          fiscalYearId: selectedFiscalYearId,
          granularity,
          ...(ordinal ? { ordinal: Number(ordinal) } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setData(body);
    } catch (e) {
      setData(null);
      toast({ title: "فشل جلب المقارنة", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [selectedCompanyId, selectedFiscalYearId, granularity, ordinal, toast]);

  React.useEffect(() => { void load(); }, [load]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">فعلي مقابل موازنة</CardTitle>
        <CardDescription>
          الفعلي: أحدث مراجعة معتمدة. الموازنة: أحدث نسخة APPROVED/LOCKED.
          الفارق رقمي منفصل عن التفسير السياقي للموازنة — الأصول والالتزامات بلا تقييم زيادة/وفر افتراضيًا.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!canView ? (
          <p className="p-4 text-center text-sm text-muted-foreground">لا تملك صلاحية عرض المقارنة (manageTrialBalances).</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>الفترات</Label>
                <Select value={granularity} onValueChange={setGranularity}>
                  <SelectTrigger aria-label="الفترات"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MONTH">شهري</SelectItem>
                    <SelectItem value="QUARTER">ربع سنوي</SelectItem>
                    <SelectItem value="SEMI_ANNUAL">نصف سنوي</SelectItem>
                    <SelectItem value="ANNUAL">سنوي كامل</SelectItem>
                    <SelectItem value="YTD">تراكمي (YTD)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(granularity === "MONTH" || granularity === "QUARTER" || granularity === "SEMI_ANNUAL") && (
                <div className="space-y-1.5">
                  <Label>الرقم التسلسلي</Label>
                  <Input type="number" min={1} max={periodsCount} value={ordinal} onChange={(e) => setOrdinal(e.target.value)} className="tnum" dir="ltr" placeholder="مثال: 1" />
                </div>
              )}
              <div className="flex items-end">
                <Button variant="outline" onClick={() => void load()} disabled={loading} className="gap-1.5">
                  {loading ? <Loader2 className="size-3.5 animate-spin" /> : null} تحديث
                </Button>
              </div>
            </div>

            {loading && !data ? (
              <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />جارٍ الحساب…</div>
            ) : !data ? (
              <p className="p-6 text-center text-sm text-muted-foreground">اختر الشركة والسنة ثم حدّث.</p>
            ) : data.rows.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">لا بنود قابلة للمقارنة — تأكد من وجود موازنة معتمدة وبيانات فعلية معتمدة.</p>
            ) : (
              <PrintableReport
                orientation="landscape"
                toolbar={
                  <>
                    <Button variant="outline" onClick={exportVarianceCsv} className="no-print gap-1.5" aria-label="تصدير CSV">
                      <FileDown className="size-3.5" /> تصدير CSV
                    </Button>
                    <PrintButton orientation="landscape" />
                  </>
                }
                meta={(() => {
                  const vp = selectedFiscalYear?.periods.find((p) => p.ordinal === data.range.startOrdinal) ?? null;
                  const vpEnd = selectedFiscalYear?.periods.find((p) => p.ordinal === data.range.endOrdinal) ?? null;
                  return buildReportHeaderMeta({
                    companyCode: selectedCompany?.code,
                    companyName: selectedCompany?.nameAr,
                    reportTitle: "تقرير فعلي مقابل موازنة (Actual vs Budget)",
                    fiscalYearCode: selectedFiscalYear?.code,
                    fiscalYearLabel: selectedFiscalYear?.displayNameAr,
                    periodLabel: `الفترات ${data.range.startOrdinal} إلى ${data.range.endOrdinal} — ${GRANULARITY_LABELS[data.granularity] ?? data.granularity}`,
                    fromDate: vp?.startDate ?? null,
                    toDate: vpEnd?.endDate ?? null,
                    currency: selectedCompany?.functionalCurrency,
                    dataType: data.granularity === "YTD" ? "CUMULATIVE_YTD" : "PERIOD_MOVEMENT",
                    status: data.status === "INCOMPLETE_DATA" ? "INCOMPLETE_DATA" : "APPROVED",
                    statusNotice: data.budget
                      ? `الموازنة المعتمدة للمقارنة: نسخة #${data.budget.versionNumber} (${BUDGET_SCENARIO_LABELS[data.budget.scenario as keyof typeof BUDGET_SCENARIO_LABELS] ?? data.budget.scenario})`
                      : "لا موازنة معتمدة للمقارنة — العمود الموازن فارغ ولا يُخترع رقم.",
                  });
                })()}
              >
                {data.status === "INCOMPLETE_DATA" && (
                  <p className="flex items-center gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                    <AlertTriangle className="size-4" /> بيانات غير مكتملة — بعض القيم ناقصة وتُعرض كما هي.
                  </p>
                )}
                {data.budget && (
                  <p className="text-xs text-muted-foreground">
                    الموازنة المعتمدة للمقارنة: نسخة #{data.budget.versionNumber} ({BUDGET_SCENARIO_LABELS[data.budget.scenario as keyof typeof BUDGET_SCENARIO_LABELS] ?? data.budget.scenario} · {BUDGET_STATUS_LABELS[data.budget.status as keyof typeof BUDGET_STATUS_LABELS] ?? data.budget.status})
                  </p>
                )}
                <div className="max-h-96 overflow-y-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">البند</TableHead>
                        <TableHead className="text-left">الموازنة</TableHead>
                        <TableHead className="text-left">الفعلي</TableHead>
                        <TableHead className="text-left">الفارق</TableHead>
                        <TableHead className="text-left">الفارق %</TableHead>
                        <TableHead className="text-right">التفسير الإداري</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.rows.map((r) => (
                        <TableRow key={r.statementLineCode}>
                          <TableCell className="text-xs">
                            <div className="font-medium">{r.lineNameAr ?? r.statementLineCode}</div>
                            <div className="text-[10px] text-muted-foreground"><span className="font-mono">{r.statementLineCode}</span> · {classificationLabel(r.lineNature, "ar")}</div>
                          </TableCell>
                          <TableCell className="text-left tnum">{fmt(r.budgetMinor, minorUnits)}</TableCell>
                          <TableCell className="text-left tnum">
                            {r.actualMinor === null ? (
                              <span className="text-xs text-muted-foreground" title={r.actualStatus}>
                                {r.actualStatus === "INCOMPLETE_DATA" ? comparisonStatusLabel("INCOMPLETE_DATA", "ar") : "غير متاح"}
                              </span>
                            ) : fmt(r.actualMinor, minorUnits)}
                          </TableCell>
                          <TableCell className="text-left tnum">{fmt(r.varianceMinor, minorUnits)}</TableCell>
                          <TableCell className="text-left tnum" dir="ltr">
                            {r.variancePct === null ? "—" : `${Number(r.variancePct).toFixed(1)}%`}
                          </TableCell>
                          <TableCell>
                            {r.favorability === "FAVORABLE" ? (
                              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                                {budgetVarianceBadge({ lineNature: r.lineNature === "REVENUE" || r.lineNature === "EXPENSE" ? r.lineNature : "OTHER", favorability: r.favorability, hasData: r.actualMinor !== null && r.budgetMinor !== null }, "ar")}
                              </Badge>
                            ) : r.favorability === "UNFAVORABLE" ? (
                              <Badge className="bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">
                                {budgetVarianceBadge({ lineNature: r.lineNature === "REVENUE" || r.lineNature === "EXPENSE" ? r.lineNature : "OTHER", favorability: r.favorability, hasData: r.actualMinor !== null && r.budgetMinor !== null }, "ar")}
                              </Badge>
                            ) : (
                              <Badge variant="secondary">
                                {budgetVarianceBadge({ lineNature: r.lineNature === "REVENUE" || r.lineNature === "EXPENSE" ? r.lineNature : "OTHER", favorability: r.favorability, hasData: r.actualMinor !== null && r.budgetMinor !== null }, "ar")}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </PrintableReport>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
