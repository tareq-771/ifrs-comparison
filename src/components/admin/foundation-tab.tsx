"use client";

// Phase 6.1 — تبويب «الشركات والسنوات المالية» (واجهة إدارية دنيا — الحد الأدنى
// لتشغيل الأساس المالي والتحقق منه، تعليمات 6.1 §19):
//   - الشركات: قائمة/إنشاء/تعديل/إبطال-تفعيل + حقول العملة — حسب الصلاحية.
//   - السنوات المالية: لكل شركة + إنشاء سنة + إنشاء جماعي (خطة → تأكيد → تنفيذ)
//     + إغلاق/قفل/فك/إعادة فتح حسب الصلاحية.
//   - الفترات المولّدة تُعرض بحالاتها + إعلان «لا حركة».
//   - سياسة الإقفال: اختيار المكوّنات المطلوبة (القائمة المبيّضة) + تقييم صادق.
//   - ملخص الربط الخلفي (مدير فقط — قراءة فقط).
// تصميم RTL عربي متسق مع بقية التطبيق — بلا إعادة تصميم تنقل التطبيق.

import * as React from "react";
import { useSession } from "next-auth/react";
import { Building2, CalendarDays, Loader2, Pencil, Plus, Power, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
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
import { canManageCompanies, canManageFiscalYears, canManagePeriods, canLockFiscalYears, canReopenFiscalYears, parsePermissions } from "@/lib/permissions";

interface CompanyRow {
  id: string; code: string; nameAr: string; nameEn: string; status: string;
  functionalCurrency: string; reportingCurrency: string; notes: string; legacyGroupId: string | null;
  reportsLinked?: number; fiscalYears?: number;
}
interface PeriodRow {
  id: string; ordinal: number; code: string; startDate: string; endDate: string;
  status: string; displayLabel: string; zeroActivityDeclared: boolean;
}
interface FiscalYearRow {
  id: string; code: string; displayNameAr: string; startDate: string; endDate: string; periodCount: number;
  status: string; origin: string; periods: PeriodRow[];
}
interface BackfillSummary {
  totalReports: number;
  statusCounts: Record<string, number>;
  quarantine: { noCompany: Array<{ id: string; name: string }>; noPeriod: Array<{ id: string; name: string; periodEnd: string | null }>; pending: Array<{ id: string; name: string }> };
  legacyCompanies: Array<{ id: string; code: string; nameAr: string; status: string }>;
  provisionalFiscalYears: number;
  note: string;
}

const FY_STATUS_BADGE: Record<string, string> = {
  OPEN: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  CLOSED: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  LOCKED: "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
};
const COMPONENTS = [
  { key: "TRIAL_BALANCE", label: "ميزان المراجعة" },
  { key: "INCOME_STATEMENT", label: "قائمة الدخل" },
  { key: "BALANCE_SHEET", label: "قائمة المركز المالي" },
];

export function FoundationTab() {
  const { toast } = useToast();
  const { data: session } = useSession();
  const perms = React.useMemo(() => {
    const raw = (session?.user as { permissions?: unknown })?.permissions;
    if (typeof raw === "string") return parsePermissions(raw);
    if (raw && typeof raw === "object") return parsePermissions(JSON.stringify(raw));
    return parsePermissions("{}");
  }, [session]);
  const role = ((session?.user as { role?: string })?.role as string) || "user";

  const canManage = canManageCompanies(perms, role);
  const canFY = canManageFiscalYears(perms, role);
  const canPeriods = canManagePeriods(perms, role);
  const canLock = canLockFiscalYears(perms, role);
  const canReopen = canReopenFiscalYears(perms, role);
  const isAdmin = role === "admin";

  const [companies, setCompanies] = React.useState<CompanyRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [baseUnavailable, setBaseUnavailable] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [years, setYears] = React.useState<FiscalYearRow[]>([]);
  const [loadingYears, setLoadingYears] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [backfill, setBackfill] = React.useState<BackfillSummary | null>(null);

  const selected = companies.find((c) => c.id === selectedId) ?? null;

  const loadCompanies = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/companies?counts=1", { cache: "no-store" });
      if (res.status === 500) {
        // قاعدة غير مرحَّلة (طبقة الأساس غير مهيأة) — رسالة واضحة بدل انهيار
        setBaseUnavailable(true);
        setCompanies([]);
        return;
      }
      if (!res.ok) throw new Error("فشل جلب الشركات");
      const data = (await res.json()) as CompanyRow[];
      setCompanies(data);
      setBaseUnavailable(false);
      setSelectedId((prev) => (data.some((c) => c.id === prev) ? prev : data[0]?.id ?? null));
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadYears = React.useCallback(async (companyId: string) => {
    setLoadingYears(true);
    try {
      const res = await fetch(`/api/fiscal-years?companyId=${companyId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("فشل جلب السنوات المالية");
      setYears((await res.json()) as FiscalYearRow[]);
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setLoadingYears(false);
    }
  }, []);

  const loadBackfill = React.useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch("/api/backfill/summary", { cache: "no-store" });
      if (!res.ok) return;
      setBackfill((await res.json()) as BackfillSummary);
    } catch {
      /* الملخص قراءة فقط — الفشل لا يعطّل التبويب */
    }
  }, [isAdmin]);

  React.useEffect(() => {
    void loadCompanies();
    void loadBackfill();
  }, [loadCompanies, loadBackfill]);
  React.useEffect(() => {
    if (selectedId) void loadYears(selectedId);
    else setYears([]);
  }, [selectedId, loadYears]);

  /* ── إنشاء/تعديل شركة ── */
  const [companyDialog, setCompanyDialog] = React.useState<"create" | "edit" | null>(null);
  const emptyCompany = { code: "", nameAr: "", nameEn: "", functionalCurrency: "", reportingCurrency: "", notes: "" };
  const [companyForm, setCompanyForm] = React.useState(emptyCompany);

  async function submitCompany() {
    if (!companyForm.code.trim() || !companyForm.nameAr.trim()) {
      toast({ title: "الكود والاسم العربي إلزاميان", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const editing = companyDialog === "edit" && selected;
      const res = await fetch(editing ? `/api/companies/${selected!.id}` : "/api/companies", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(companyForm),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "فشل الحفظ");
      toast({ title: editing ? "تم تحديث الشركة" : "تم إنشاء الشركة" });
      setCompanyDialog(null);
      await loadCompanies();
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleCompanyStatus(c: CompanyRow) {
    setBusy(true);
    try {
      const res = await fetch(`/api/companies/${c.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: c.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "فشل تغيير الحالة");
      toast({ title: c.status === "ACTIVE" ? "تم إيقاف الشركة — الرؤية التاريخية محفوظة" : "تم تفعيل الشركة" });
      await loadCompanies();
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function deleteCompany(c: CompanyRow) {
    if (!confirm(`حذف شركة «${c.nameAr}» صلبًا؟ يُسمح فقط لشركة غير مستخدمة تمامًا.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/companies/${c.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "الرفض — استخدم الإيقاف");
      toast({ title: "تم حذف الشركة الفارغة" });
      await loadCompanies();
    } catch (err) {
      toast({ title: "الحذف مرفوض", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  /* ── إنشاء سنة مالية ── */
  const [fyDialog, setFyDialog] = React.useState(false);
  const emptyFY = { code: "", displayNameAr: "", startDate: "", endDate: "" };
  const [fyForm, setFyForm] = React.useState(emptyFY);

  async function submitFY() {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await fetch("/api/fiscal-years", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: selected.id, ...fyForm }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "فشل الإنشاء");
      toast({ title: "تم إنشاء السنة المالية وفتراتها الشهرية" });
      setFyDialog(false);
      setFyForm(emptyFY);
      await loadYears(selected.id);
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  /* ── إنشاء جماعي: خطة → تأكيد → تنفيذ ── */
  const [bulkDialog, setBulkDialog] = React.useState(false);
  const [bulkStart, setBulkStart] = React.useState("");
  const [bulkEnd, setBulkEnd] = React.useState("");
  const [bulkCode, setBulkCode] = React.useState("");
  const [bulkPlan, setBulkPlan] = React.useState<{ plan: Array<{ companyId: string; companyNameAr: string; willCreate: boolean; alreadyExists: boolean; reason?: string; proposedPeriods?: number }>; executableCount: number; alreadyExistsCount: number; failedCount: number } | null>(null);

  async function runBulkPlan() {
    setBusy(true);
    try {
      const items = companies
        .filter((c) => c.status === "ACTIVE")
        .map((c) => ({ companyId: c.id, code: bulkCode.trim(), startDate: bulkStart, endDate: bulkEnd }));
      if (items.length === 0) throw new Error("لا توجد شركات نشطة للإنشاء الجماعي");
      const res = await fetch("/api/fiscal-years/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "plan", items }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error || "فشل بناء الخطة");
      setBulkPlan(data);
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function runBulkExecute() {
    setBusy(true);
    try {
      const items = companies
        .filter((c) => c.status === "ACTIVE")
        .map((c) => ({ companyId: c.id, code: bulkCode.trim(), startDate: bulkStart, endDate: bulkEnd }));
      const res = await fetch("/api/fiscal-years/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "execute", confirmed: true, items }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data as { error?: string }).error || "فشل التنفيذ");
      toast({
        title: `النتيجة: أُنشئت ${data.created.length} · موجودة ${data.alreadyExists.length} · فشلت ${data.failed.length}`,
        description: data.failed.length > 0 ? "راجع أسباب الفشل في السجل" : "كل الشركات نجحت",
        variant: data.failed.length > 0 ? "destructive" : "default",
      });
      setBulkDialog(false);
      setBulkPlan(null);
      await loadCompanies();
      if (selectedId) await loadYears(selectedId);
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  /* ── انتقالات حالة السنة ── */
  async function fyTransition(fy: FiscalYearRow, action: "close" | "lock" | "unlock" | "reopen" | "confirm-provisional") {
    let reason = "";
    if (action === "reopen" || action === "unlock") {
      reason = prompt("السبب إلزامي (يُسجل في التدقيق):") ?? "";
      if (reason.trim().length < 3) {
        toast({ title: "السبب إلزامي (3 أحرف فأكثر)", variant: "destructive" });
        return;
      }
    }
    const labels: Record<string, string> = {
      close: "إغلاق السنة المالية؟",
      lock: "قفل السنة المالية؟ (يمنع أي تغيير على فتراتها)",
      unlock: "فك قفل السنة المالية؟",
      reopen: "إعادة فتح السنة المالية؟",
      "confirm-provisional": "تأكيد الحاوية المؤقتة كسنة موثقة؟",
    };
    if (!confirm(labels[action])) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/fiscal-years/${fy.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(reason ? { reason } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "الانتقال مرفوض");
      toast({ title: "تم التنفيذ" });
      if (selectedId) await loadYears(selectedId);
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function togglePeriod(p: PeriodRow) {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/fiscal-periods/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: p.status === "OPEN" ? "CLOSED" : "OPEN" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "مرفوض");
      if (selectedId) await loadYears(selectedId);
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  /* ── سياسة الإقفال ── */
  const [policyComponents, setPolicyComponents] = React.useState<string[]>([]);
  const [policyLoaded, setPolicyLoaded] = React.useState(false);
  React.useEffect(() => {
    if (!selected) return;
    setPolicyLoaded(false);
    void (async () => {
      try {
        const res = await fetch(`/api/companies/${selected.id}/closing-policy`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        setPolicyComponents(data.requiredComponents ?? []);
      } finally {
        setPolicyLoaded(true);
      }
    })();
  }, [selected]);

  async function savePolicy() {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/companies/${selected.id}/closing-policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requiredComponents: policyComponents }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "مرفوض");
      toast({ title: "تم حفظ سياسة الإقفال" });
    } catch (err) {
      toast({ title: "خطأ", description: err instanceof Error ? err.message : "خطأ", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  if (baseUnavailable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Building2 className="size-4" /> الأساس المالي (Phase 6.1)</CardTitle>
          <CardDescription>
            طبقة الأساس المالي غير مهيأة لهذه قاعدة البيانات — يلزم تنفيذ الترحيل
            <code dir="ltr" className="mx-1 rounded bg-slate-100 px-1 text-[11px] dark:bg-slate-800">prisma migrate deploy</code>
            على نسخة البيانات المعتمدة ثم إعادة المحاولة.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── الشركات ── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2"><Building2 className="size-4" /> الشركات</CardTitle>
            <CardDescription>الهوية الآلية = الكود — الأسماء عرض فقط · الإبطال يحفظ الرؤية التاريخية</CardDescription>
          </div>
          {canManage && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void loadCompanies()} disabled={loading}>
                <RefreshCw className="size-3.5" /> تحديث
              </Button>
              <Button size="sm" className="bg-emerald-600 text-white hover:bg-emerald-700"
                onClick={() => { setCompanyForm(emptyCompany); setCompanyDialog("create"); }}>
                <Plus className="size-3.5" /> شركة جديدة
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-slate-400"><Loader2 className="ml-2 size-4 animate-spin" /> جارٍ التحميل…</div>
          ) : companies.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400 dark:border-slate-700">
              لا توجد شركات — أنشئ شركة أو شغّل أداة الربط الخلفي (scripts/phase61-backfill.ts).
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-lg border dark:border-slate-700">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-[11px] text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2 text-right">الكود</th>
                    <th className="px-3 py-2 text-right">الاسم</th>
                    <th className="px-3 py-2 text-right">الحالة</th>
                    <th className="px-3 py-2 text-right">العملة (وظيفية/إبلاغ)</th>
                    <th className="px-3 py-2 text-right">سنوات/تقارير</th>
                    {canManage && <th className="px-3 py-2 text-right">إجراءات</th>}
                  </tr>
                </thead>
                <tbody>
                  {companies.map((c) => (
                    <tr key={c.id}
                      className={`cursor-pointer border-t transition-colors dark:border-slate-800 ${selectedId === c.id ? "bg-emerald-50/60 dark:bg-emerald-950/20" : "hover:bg-slate-50 dark:hover:bg-slate-800/40"}`}
                      onClick={() => setSelectedId(c.id)}>
                      <td className="px-3 py-2 font-mono text-xs" dir="ltr">{c.code}</td>
                      <td className="px-3 py-2 font-semibold">{c.nameAr}</td>
                      <td className="px-3 py-2">
                        <Badge className={c.status === "ACTIVE" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"}>
                          {c.status === "ACTIVE" ? "نشطة" : "موقوفة"}
                        </Badge>
                        {c.legacyGroupId && <Badge className="mr-1 bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">legacy</Badge>}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500" dir="ltr">
                        {c.functionalCurrency || "—"} / {c.reportingCurrency || "—"}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">{c.fiscalYears ?? 0} / {c.reportsLinked ?? 0}</td>
                      {canManage && (
                        <td className="px-3 py-2">
                          <div className="flex gap-1">
                            <Button size="icon" variant="ghost" className="size-7" title="تعديل" aria-label="تعديل"
                              onClick={(e) => { e.stopPropagation(); setSelectedId(c.id); setCompanyForm({ code: c.code, nameAr: c.nameAr, nameEn: c.nameEn, functionalCurrency: c.functionalCurrency, reportingCurrency: c.reportingCurrency, notes: c.notes }); setCompanyDialog("edit"); }}>
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" className="size-7" title={c.status === "ACTIVE" ? "إيقاف (يحفظ الرؤية)" : "تفعيل"} aria-label={c.status === "ACTIVE" ? "إيقاف (يحفظ الرؤية)" : "تفعيل"}
                              onClick={(e) => { e.stopPropagation(); void toggleCompanyStatus(c); }} disabled={busy}>
                              <Power className={`size-3.5 ${c.status === "ACTIVE" ? "text-amber-500" : "text-emerald-500"}`} />
                            </Button>
                            <Button size="icon" variant="ghost" className="size-7 text-rose-500" title="حذف (فارغة تمامًا فقط)" aria-label="حذف (فارغة تمامًا فقط)"
                              onClick={(e) => { e.stopPropagation(); void deleteCompany(c); }} disabled={busy}>
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── السنوات المالية للشركة المحددة ── */}
      {selected && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2"><CalendarDays className="size-4" /> السنوات المالية — {selected.nameAr}</CardTitle>
              <CardDescription>فترات شهرية متتالية بلا فجوات/تداخلات · ربع/نصف/YTD تُشتق ولا تُخزَّن</CardDescription>
            </div>
            {canFY && selected.status === "ACTIVE" && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => { setBulkStart(""); setBulkEnd(""); setBulkCode(""); setBulkPlan(null); setBulkDialog(true); }}>
                  إنشاء جماعي
                </Button>
                <Button size="sm" className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => { setFyForm(emptyFY); setFyDialog(true); }}>
                  <Plus className="size-3.5" /> سنة مالية
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {loadingYears ? (
              <div className="flex items-center justify-center py-6 text-sm text-slate-400"><Loader2 className="ml-2 size-4 animate-spin" /> جارٍ التحميل…</div>
            ) : years.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 py-6 text-center text-sm text-slate-400 dark:border-slate-700">لا سنوات مالية بعد.</div>
            ) : (
              <div className="max-h-96 space-y-3 overflow-y-auto">
                {years.map((fy) => (
                  <div key={fy.id} className="rounded-lg border p-3 dark:border-slate-700">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-bold" dir="ltr">{fy.code}</span>
                        <Badge className={FY_STATUS_BADGE[fy.status] ?? ""}>
                          {fy.status === "OPEN" ? "مفتوحة" : fy.status === "CLOSED" ? "مغلقة" : "مقفلة"}
                        </Badge>
                        {fy.origin === "PROVISIONAL_IMPORTED" && (
                          <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">مؤقتة — تتطلب تأكيد</Badge>
                        )}
                        <span className="text-[11px] text-slate-400" dir="ltr">{fy.startDate} → {fy.endDate} · {fy.periodCount} فترة</span>
                      </div>
                      {canFY && (
                        <div className="flex flex-wrap gap-1">
                          {fy.origin === "PROVISIONAL_IMPORTED" && (
                            <Button size="sm" variant="outline" onClick={() => void fyTransition(fy, "confirm-provisional")} disabled={busy}>تأكيد</Button>
                          )}
                          {fy.status === "OPEN" && (
                            <Button size="sm" variant="outline" onClick={() => void fyTransition(fy, "close")} disabled={busy}>إغلاق</Button>
                          )}
                          {fy.status === "CLOSED" && canLock && (
                            <Button size="sm" variant="outline" onClick={() => void fyTransition(fy, "lock")} disabled={busy}>قفل</Button>
                          )}
                          {fy.status === "CLOSED" && canReopen && (
                            <Button size="sm" variant="outline" onClick={() => void fyTransition(fy, "reopen")} disabled={busy}>إعادة فتح</Button>
                          )}
                          {fy.status === "LOCKED" && canLock && (
                            <Button size="sm" variant="outline" onClick={() => void fyTransition(fy, "unlock")} disabled={busy}>فك القفل</Button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {fy.periods.map((p) => (
                        <button key={p.id}
                          onClick={() => canPeriods && fy.status !== "LOCKED" && void togglePeriod(p)}
                          disabled={!canPeriods || fy.status === "LOCKED" || busy}
                          title={canPeriods && fy.status !== "LOCKED" ? "نقر لتغيير حالة الفترة" : "الحالة تُدار عبر الصلاحية managePeriods والسنة غير المقفلة"}
                          className={`rounded px-2 py-1 text-[10px] font-semibold transition-colors ${p.status === "OPEN"
                            ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300"
                            : "bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-950/60 dark:text-amber-300"} ${p.zeroActivityDeclared ? "ring-1 ring-teal-400" : ""}`}>
                          {p.displayLabel || p.code}
                          {p.zeroActivityDeclared && " · لا حركة"}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── سياسة الإقفال ── */}
      {selected && canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" /> سياسة الإقفال — {selected.nameAr}</CardTitle>
            <CardDescription>
              المكوّنات المطلوبة قبل إقفال السنوات (التنفيذ الكامل في Phase 6.2 — الطبقة المالية غير مبنية بعد، والتقييم يُبلغها غير متاحة بصدق).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!policyLoaded ? (
              <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" /> جارٍ التحميل…</div>
            ) : (
              <>
                <div className="flex flex-wrap gap-4">
                  {COMPONENTS.map((c) => (
                    <label key={c.key} className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={policyComponents.includes(c.key)}
                        onCheckedChange={(v) => setPolicyComponents((prev) => (v === true ? [...prev, c.key] : prev.filter((k) => k !== c.key)))}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
                <Button size="sm" className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => void savePolicy()} disabled={busy}>
                  حفظ السياسة
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── ملخص الربط الخلفي (مدير فقط — قراءة فقط) ── */}
      {isAdmin && backfill && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><RefreshCw className="size-4" /> ملخص الربط الخلفي (Backfill)</CardTitle>
            <CardDescription>{backfill.note}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">MAPPED: {backfill.statusCounts.MAPPED ?? 0}</Badge>
              <Badge className="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">بدون ربط: {backfill.statusCounts.UNSET ?? 0}</Badge>
              <Badge className="bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">NO_COMPANY: {backfill.statusCounts.NO_COMPANY ?? 0}</Badge>
              <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">NO_PERIOD: {backfill.statusCounts.NO_PERIOD ?? 0}</Badge>
              <Badge className="bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">PENDING: {backfill.statusCounts.PENDING ?? 0}</Badge>
              <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">سنوات مؤقتة: {backfill.provisionalFiscalYears}</Badge>
            </div>
            <p className="text-[11px] text-slate-400">
              الإجمالي: {backfill.totalReports} تقرير · عينات العزل تُعرض أعلاه بالأكواد — التنفيذ عبر الأداة الخادمية مع dry-run إلزامي.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── حوار إنشاء/تعديل شركة ── */}
      <Dialog open={companyDialog !== null} onOpenChange={(o) => !o && setCompanyDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{companyDialog === "edit" ? "تعديل شركة" : "شركة جديدة"}</DialogTitle>
            <DialogDescription>الكود هوية آلية وحيدة — الأسماء عرض فقط. العملة اختيارية حتى أول استخدام مالي.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1">
              <Label htmlFor="c-code">الكود (لاتيني/أرقام)</Label>
              <Input id="c-code" dir="ltr" value={companyForm.code} onChange={(e) => setCompanyForm((f) => ({ ...f, code: e.target.value }))} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="c-namear">الاسم العربي *</Label>
              <Input id="c-namear" value={companyForm.nameAr} onChange={(e) => setCompanyForm((f) => ({ ...f, nameAr: e.target.value }))} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="c-nameen">الاسم الإنجليزي</Label>
              <Input id="c-nameen" dir="ltr" value={companyForm.nameEn} onChange={(e) => setCompanyForm((f) => ({ ...f, nameEn: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1">
                <Label>العملة الوظيفية</Label>
                <Select value={companyForm.functionalCurrency || "none"} onValueChange={(v) => setCompanyForm((f) => ({ ...f, functionalCurrency: v === "none" ? "" : v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— غير محددة —</SelectItem>
                    <SelectItem value="YER">YER — ريال يمني</SelectItem>
                    <SelectItem value="SAR">SAR — ريال سعودي</SelectItem>
                    <SelectItem value="USD">USD — دولار أمريكي</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1">
                <Label>عملة الإبلاغ</Label>
                <Select value={companyForm.reportingCurrency || "none"} onValueChange={(v) => setCompanyForm((f) => ({ ...f, reportingCurrency: v === "none" ? "" : v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— تُشتق من الوظيفية —</SelectItem>
                    <SelectItem value="YER">YER</SelectItem>
                    <SelectItem value="SAR">SAR</SelectItem>
                    <SelectItem value="USD">USD</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="c-notes">ملاحظات</Label>
              <Input id="c-notes" value={companyForm.notes} onChange={(e) => setCompanyForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompanyDialog(null)} disabled={busy}>إلغاء</Button>
            <Button onClick={() => void submitCompany()} disabled={busy} className="bg-emerald-600 text-white hover:bg-emerald-700">
              {busy ? <Loader2 className="size-4 animate-spin" /> : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── حوار إنشاء سنة مالية ── */}
      <Dialog open={fyDialog} onOpenChange={setFyDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>سنة مالية جديدة — {selected?.nameAr}</DialogTitle>
            <DialogDescription>
              القاعدة: تبدأ أول الشهر وتنتهي آخر الشهر — تُولَّد فترات شهرية متتالية بلا فجوات.
              أمثلة: 2026-01-01→2026-12-31 (12) · 2026-07-01→2027-06-30 (12) · 2026-01-01→2026-03-31 (3).
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1">
                <Label htmlFor="fy-start">البداية (YYYY-MM-01)</Label>
                <Input id="fy-start" dir="ltr" placeholder="2026-01-01" value={fyForm.startDate} onChange={(e) => setFyForm((f) => ({ ...f, startDate: e.target.value }))} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="fy-end">النهاية (آخر يوم شهر)</Label>
                <Input id="fy-end" dir="ltr" placeholder="2026-12-31" value={fyForm.endDate} onChange={(e) => setFyForm((f) => ({ ...f, endDate: e.target.value }))} />
              </div>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="fy-code">الكود (وحيد داخل الشركة)</Label>
              <Input id="fy-code" dir="ltr" placeholder="FY2026" value={fyForm.code} onChange={(e) => setFyForm((f) => ({ ...f, code: e.target.value }))} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="fy-name">اسم العرض (اختياري)</Label>
              <Input id="fy-name" value={fyForm.displayNameAr} onChange={(e) => setFyForm((f) => ({ ...f, displayNameAr: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFyDialog(false)} disabled={busy}>إلغاء</Button>
            <Button onClick={() => void submitFY()} disabled={busy} className="bg-emerald-600 text-white hover:bg-emerald-700">
              {busy ? <Loader2 className="size-4 animate-spin" /> : "إنشاء + توليد الفترات"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── حوار الإنشاء الجماعي (خطة → تأكيد → تنفيذ) ── */}
      <Dialog open={bulkDialog} onOpenChange={setBulkDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>إنشاء سنوات مالية جماعي</DialogTitle>
            <DialogDescription>معاينة إلزامية ثم تأكيد صريح — لا إنشاء صامت جزئي أبدًا.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="grid gap-1">
                <Label htmlFor="b-start">البداية</Label>
                <Input id="b-start" dir="ltr" placeholder="2026-01-01" value={bulkStart} onChange={(e) => setBulkStart(e.target.value)} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="b-end">النهاية</Label>
                <Input id="b-end" dir="ltr" placeholder="2026-12-31" value={bulkEnd} onChange={(e) => setBulkEnd(e.target.value)} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="b-code">الكود</Label>
                <Input id="b-code" dir="ltr" placeholder="FY2026" value={bulkCode} onChange={(e) => setBulkCode(e.target.value)} />
              </div>
            </div>
            {!bulkPlan ? (
              <Button onClick={() => void runBulkPlan()} disabled={busy || !bulkStart || !bulkEnd || !bulkCode} className="bg-emerald-600 text-white hover:bg-emerald-700">
                {busy ? <Loader2 className="size-4 animate-spin" /> : "معاينة الخطة"}
              </Button>
            ) : (
              <div className="space-y-2">
                <div className="max-h-56 overflow-y-auto rounded-lg border p-2 text-xs dark:border-slate-700">
                  {bulkPlan.plan.map((e, i) => (
                    <div key={i} className="flex items-center justify-between border-b py-1 last:border-0 dark:border-slate-800">
                      <span className="font-semibold">{e.companyNameAr}</span>
                      <span className={e.willCreate ? "text-emerald-600 dark:text-emerald-400" : e.alreadyExists ? "text-slate-400" : "text-rose-600 dark:text-rose-400"}>
                        {e.willCreate ? `سيُنشأ (${e.proposedPeriods} فترة)` : e.alreadyExists ? "موجودة مسبقًا (تُتجاهل)" : "فشل: " + (e.reason ?? "")}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setBulkPlan(null)} disabled={busy}>إعادة المعاينة</Button>
                  <Button onClick={() => void runBulkExecute()} disabled={busy || bulkPlan.executableCount === 0} className="bg-emerald-600 text-white hover:bg-emerald-700">
                    {busy ? <Loader2 className="size-4 animate-spin" /> : `تأكيد وتنفيذ (${bulkPlan.executableCount})`}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
