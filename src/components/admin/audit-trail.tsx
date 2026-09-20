"use client";

// تبويب «سجل التدقيق» في لوحة الإدارة — عرض فقط (Append-Only).
// الفلاتر: المستخدم، العملية، نوع الكيان، Entity ID، بحث في الوصف، من/إلى تاريخ.
// Pagination كامل عبر الخادم — لا يُحمَّل السجل كاملًا في المتصفح.
// عرض الوقت: التوقيت المحلي للمتصفح + الطابع ISO-UTC الأصلية (غير ملتبسة).

import * as React from "react";
import {
  Download,
  Filter,
  Loader2,
  RotateCcw,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABELS,
  AUDIT_ENTITY_TYPES,
  AUDIT_ENTITY_LABELS,
} from "@/lib/audit-actions";

interface AuditRow {
  id: string;
  userId: string | null;
  username: string;
  action: string;
  entityType: string;
  entityId: string | null;
  description: string;
  beforeData: unknown;
  afterData: unknown;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: string;
}

interface AuditResponse {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

interface UserOption {
  id: string;
  username: string;
  displayName: string;
}

interface AppliedFilters {
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  q: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: AppliedFilters = {
  userId: "", action: "", entityType: "", entityId: "", q: "", from: "", to: "",
};

function actionTone(action: string): string {
  if (action.endsWith("_DELETED")) return "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300";
  if (action === "PERMISSIONS_CHANGED" || action === "ROLE_CHANGED") return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  if (action === "LOGIN_FAILED") return "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300";
  if (action === "LOGIN_SUCCEEDED") return "bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300";
  if (action.startsWith("GROUP_")) return "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300";
  if (action.startsWith("USER_")) return "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
}

const fmtLocal = new Intl.DateTimeFormat("ar", {
  calendar: "gregory",
  numberingSystem: "latn",
  dateStyle: "medium",
  timeStyle: "medium",
  hour12: false,
});

function prettyJson(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object" && Object.keys(v as object).length === 0) return "—";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function AuditTrailTab() {
  const { toast } = useToast();

  const [users, setUsers] = React.useState<UserOption[]>([]);
  const [draft, setDraft] = React.useState<AppliedFilters>({ ...EMPTY_FILTERS });
  const [applied, setApplied] = React.useState<AppliedFilters>({ ...EMPTY_FILTERS });
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const [data, setData] = React.useState<AuditResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [detail, setDetail] = React.useState<AuditRow | null>(null);
  const [exporting, setExporting] = React.useState(false);

  /* ── قائمة المستخدمين لفلتر المستخدم (مرة واحدة) ── */
  React.useEffect(() => {
    const raf = requestAnimationFrame(() => {
      void (async () => {
        try {
          const res = await fetch("/api/users", { cache: "no-store" });
          if (!res.ok) return;
          const list = (await res.json()) as UserOption[];
          setUsers(list.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName })));
        } catch {
          /* الفلتر اختياري — تجاهل */
        }
      })();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ── جلب صفحة السجل وفق الفلاتر المطبقة ── */
  React.useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const p = new URLSearchParams();
        p.set("page", String(page));
        p.set("pageSize", String(pageSize));
        if (applied.userId) p.set("userId", applied.userId);
        if (applied.action) p.set("action", applied.action);
        if (applied.entityType) p.set("entityType", applied.entityType);
        if (applied.entityId) p.set("entityId", applied.entityId);
        if (applied.q) p.set("q", applied.q);
        if (applied.from) p.set("from", applied.from);
        if (applied.to) p.set("to", applied.to);
        const res = await fetch(`/api/audit?${p.toString()}`, { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `فشل جلب السجل (${res.status})`);
        }
        const json = (await res.json()) as AuditResponse;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) {
          toast({
            title: "خطأ",
            description: err instanceof Error ? err.message : "خطأ غير متوقع",
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const raf = requestAnimationFrame(() => void run());
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [applied, page, pageSize, toast]);

  /* ── تطبيق/تصفير الفلاتر ── */
  function applyFilters(next?: Partial<AppliedFilters>) {
    setApplied((prev) => ({ ...prev, ...(next || {}) }));
    setPage(1);
  }
  function applyDrafts() {
    setApplied({ ...draft });
    setPage(1);
  }
  function resetFilters() {
    setDraft({ ...EMPTY_FILTERS });
    setApplied({ ...EMPTY_FILTERS });
    setPage(1);
  }

  /* ── تصدير CSV وفق الفلاتر المطبقة ── */
  function exportCsv() {
    try {
      setExporting(true);
      const p = new URLSearchParams();
      if (applied.userId) p.set("userId", applied.userId);
      if (applied.action) p.set("action", applied.action);
      if (applied.entityType) p.set("entityType", applied.entityType);
      if (applied.entityId) p.set("entityId", applied.entityId);
      if (applied.q) p.set("q", applied.q);
      if (applied.from) p.set("from", applied.from);
      if (applied.to) p.set("to", applied.to);
      const a = document.createElement("a");
      a.href = `/api/audit/export${p.toString() ? `?${p.toString()}` : ""}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      // المتصفح يدير التنزيل — نحرر الزر بعد لحظة
      window.setTimeout(() => setExporting(false), 800);
    }
  }

  const hasActiveFilters = Object.values(applied).some((v) => v !== "");

  return (
    <Card className="border-slate-200 shadow-sm dark:border-slate-800">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-slate-800 dark:text-slate-100">
            <ScrollText className="size-4 text-emerald-600 dark:text-emerald-400" />
            سجل التدقيق التطبيقي (Application Audit Trail)
          </CardTitle>
          <CardDescription className="flex items-center gap-1.5">
            <ShieldCheck className="size-3 text-emerald-600 dark:text-emerald-400" />
            سجل رقابي للقراءة فقط — لا يمكن تعديله أو حذفه من النظام
          </CardDescription>
          {/* Phase 4B.1 — التمييز الرقابي الإلزامي بين السجلين (قرار المستخدم) */}
          <p className="mt-2 max-w-3xl rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            هذا هو <strong>سجل التدقيق التطبيقي</strong> المخزّن داخل قاعدة البيانات. عند استعادة قاعدة
            التشغيل إلى نسخة أقدم، يرجع هذا السجل تاريخيًا مع القاعدة نفسها — وهذا متوقع وليس خطأ.
            أحداث الاستعادة والتشغيل الحاكمية تُسجل حصرًا في{" "}
            <strong>سجل عمليات الاسترجاع (Recovery Operations Log)</strong> الخارجي الموجود في تبويب
            «النسخ الاحتياطي» — ولا يُعتقد أبدًا أن هذا السجل وحده يمثل أحداث الاستعادة التي وقعت بعد
            تاريخ النسخة المستعادة.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={resetFilters}
            className="gap-1.5 border-slate-300 dark:border-slate-700"
          >
            <RotateCcw className="size-3.5" />
            <span className="hidden sm:inline">إعادة تعيين</span>
          </Button>
          <Button
            size="sm"
            onClick={exportCsv}
            disabled={exporting}
            className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
          >
            <Download className="size-3.5" />
            <span className="hidden sm:inline">تصدير CSV</span>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* الفلاتر */}
        <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-900/40">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              value={applied.action || "ALL"}
              onValueChange={(v) => applyFilters({ action: v === "ALL" ? "" : v })}
            >
              <SelectTrigger size="sm" className="w-full" aria-label="فلتر العملية">
                <SelectValue placeholder="كل العمليات" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">كل العمليات</SelectItem>
                {Object.values(AUDIT_ACTIONS).map((code) => (
                  <SelectItem key={code} value={code}>
                    {AUDIT_ACTION_LABELS[code] || code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={applied.entityType || "ALL"}
              onValueChange={(v) => applyFilters({ entityType: v === "ALL" ? "" : v })}
            >
              <SelectTrigger size="sm" className="w-full" aria-label="فلتر نوع الكيان">
                <SelectValue placeholder="كل الكيانات" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">كل الكيانات</SelectItem>
                {Object.values(AUDIT_ENTITY_TYPES).map((t) => (
                  <SelectItem key={t} value={t}>
                    {AUDIT_ENTITY_LABELS[t] || t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={applied.userId || "ALL"}
              onValueChange={(v) => applyFilters({ userId: v === "ALL" ? "" : v })}
            >
              <SelectTrigger size="sm" className="w-full" aria-label="فلتر المستخدم">
                <SelectValue placeholder="كل المستخدمين" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">كل المستخدمين</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.displayName || u.username} ({u.username})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Input
              type="text"
              placeholder="Entity ID"
              value={draft.entityId}
              onChange={(e) => setDraft((d) => ({ ...d, entityId: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && applyDrafts()}
              className="h-9 bg-white text-sm dark:bg-slate-950"
              dir="ltr"
            />
          </div>
          <div className="grid items-center gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <Input
              type="text"
              placeholder="بحث في الوصف…"
              value={draft.q}
              onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && applyDrafts()}
              className="h-9 bg-white text-sm dark:bg-slate-950"
            />
            <div className="flex items-center gap-1.5">
              <span className="whitespace-nowrap text-[11px] text-slate-500 dark:text-slate-400">من</span>
              <Input
                type="date"
                value={applied.from}
                onChange={(e) => applyFilters({ from: e.target.value })}
                className="h-9 bg-white text-sm dark:bg-slate-950"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="whitespace-nowrap text-[11px] text-slate-500 dark:text-slate-400">إلى</span>
              <Input
                type="date"
                value={applied.to}
                onChange={(e) => applyFilters({ to: e.target.value })}
                className="h-9 bg-white text-sm dark:bg-slate-950"
              />
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={applyDrafts}
              className="gap-1.5"
            >
              <Filter className="size-3.5" />
              تصفية
            </Button>
            {hasActiveFilters && (
              <Badge variant="outline" className="justify-center border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300">
                فلاتر مطبقة
              </Badge>
            )}
          </div>
        </div>

        {/* الجدول */}
        <div className="max-h-[520px] overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-800 scroll-thin">
          {loading ? (
            <div className="flex items-center justify-center gap-3 py-16 text-slate-400 dark:text-slate-500">
              <Loader2 className="size-5 animate-spin text-emerald-600" />
              <span className="text-sm">جارٍ تحميل السجل…</span>
            </div>
          ) : !data || data.rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                <ScrollText className="size-6" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">لا توجد سجلات</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {hasActiveFilters ? "جرّب تعديل الفلاتر أو إعادة تعيينها" : "ستظهر العمليات هنا تلقائيًا"}
                </p>
              </div>
            </div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-white dark:bg-slate-950">
                <TableRow className="border-slate-200 dark:border-slate-700">
                  <TableHead className="text-right">الوقت</TableHead>
                  <TableHead className="text-right">المستخدم</TableHead>
                  <TableHead className="text-right">العملية</TableHead>
                  <TableHead className="text-right">الكيان</TableHead>
                  <TableHead className="text-right">الوصف</TableHead>
                  <TableHead className="text-right">IP</TableHead>
                  <TableHead className="text-center">تفاصيل</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r) => {
                  const d = new Date(r.createdAt);
                  return (
                    <TableRow key={r.id} className="border-slate-100 dark:border-slate-800">
                      <TableCell className="whitespace-nowrap align-top">
                        <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                          {fmtLocal.format(d)}
                        </div>
                        <div className="text-[10px] text-slate-400 dark:text-slate-500" dir="ltr">
                          {r.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z")}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                          {r.username || "—"}
                        </div>
                        {r.userId && (
                          <div className="max-w-[110px] truncate text-[10px] text-slate-400" dir="ltr" title={r.userId}>
                            {r.userId}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge className={`border-transparent px-2 py-0.5 text-[10px] font-bold ${actionTone(r.action)}`}>
                          {AUDIT_ACTION_LABELS[r.action] || r.action}
                        </Badge>
                        <div className="mt-1 text-[10px] text-slate-400 dark:text-slate-500" dir="ltr">
                          {r.action}
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="text-xs text-slate-700 dark:text-slate-200">
                          {AUDIT_ENTITY_LABELS[r.entityType] || r.entityType}
                        </div>
                        {r.entityId && (
                          <div className="max-w-[110px] truncate text-[10px] text-slate-400" dir="ltr" title={r.entityId}>
                            {r.entityId}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[280px] align-top">
                        <p className="line-clamp-2 text-xs leading-5 text-slate-600 dark:text-slate-300" title={r.description}>
                          {r.description || "—"}
                        </p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap align-top text-[11px] text-slate-500 dark:text-slate-400" dir="ltr">
                        {r.ipAddress || "—"}
                      </TableCell>
                      <TableCell className="text-center align-top">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setDetail(r)}
                          className="h-7 border-slate-300 px-2 text-[11px] dark:border-slate-700"
                        >
                          عرض
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>

        {/* Pagination */}
        {data && data.rows.length > 0 && (
          <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              المجموع: <span className="font-bold text-slate-700 dark:text-slate-200">{data.total}</span> سجلًا · الصفحة{" "}
              <span className="font-bold text-slate-700 dark:text-slate-200">{data.page}</span> من {data.pages}
            </p>
            <div className="flex items-center gap-2">
              <Select
                value={String(pageSize)}
                onValueChange={(v) => {
                  setPageSize(parseInt(v, 10) || 20);
                  setPage(1);
                }}
              >
                <SelectTrigger size="sm" className="w-[110px]" aria-label="عدد الصفوف بالصفحة">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="20">20 بالصفحة</SelectItem>
                  <SelectItem value="50">50 بالصفحة</SelectItem>
                  <SelectItem value="100">100 بالصفحة</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="border-slate-300 dark:border-slate-700"
              >
                السابق
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={loading || page >= data.pages}
                onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
                className="border-slate-300 dark:border-slate-700"
              >
                التالي
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      {/* تفاصيل السجل */}
      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-base">
                  <Badge className={`border-transparent px-2 py-0.5 text-[10px] font-bold ${actionTone(detail.action)}`}>
                    {AUDIT_ACTION_LABELS[detail.action] || detail.action}
                  </Badge>
                  <span className="text-xs font-normal text-slate-400" dir="ltr">{detail.action}</span>
                </DialogTitle>
                <DialogDescription>{detail.description || "—"}</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-xs">
                <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                  <Info label="المستخدم" value={detail.username || "—"} />
                  <Info label="User ID" value={detail.userId || "—"} mono />
                  <Info label="الكيان" value={AUDIT_ENTITY_LABELS[detail.entityType] || detail.entityType} />
                  <Info label="Entity ID" value={detail.entityId || "—"} mono />
                  <Info
                    label="الوقت المحلي"
                    value={fmtLocal.format(new Date(detail.createdAt))}
                  />
                  <Info label="ISO-UTC (التوقيت الأصلي)" value={detail.createdAt} mono />
                  <Info label="IP" value={detail.ipAddress || "—"} mono />
                </div>
                <JsonBlock title="قبل التعديل (Before)" value={detail.beforeData} />
                <JsonBlock title="بعد التعديل (After)" value={detail.afterData} />
                <JsonBlock title="سياق إضافي (Metadata)" value={detail.metadata} />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] text-slate-400 dark:text-slate-500">{label}</div>
      <div
        className={`break-all font-semibold text-slate-700 dark:text-slate-200 ${mono ? "font-mono text-[11px]" : ""}`}
        dir={mono ? "ltr" : undefined}
      >
        {value}
      </div>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const text = prettyJson(value);
  return (
    <div>
      <div className="mb-1 text-[11px] font-bold text-slate-500 dark:text-slate-400">{title}</div>
      {text === "—" ? (
        <div className="text-slate-400">—</div>
      ) : (
        <pre
          className="max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 text-left font-mono text-[11px] leading-5 text-emerald-300 scroll-thin"
          dir="ltr"
        >
          {text}
        </pre>
      )}
    </div>
  );
}
