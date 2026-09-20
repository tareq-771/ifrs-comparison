"use client";

// جدول المتابعة — الأعمدة كلها خادمية (القسم 7 من التصميم المعتمد) والإجراءات
// من myActions الخادمية حصرًا وتستدعي endpoints الحالية (لا منطق Workflow موازٍ).
// الاستثناء الموثق: «تغيير الإسناد» يفتح التقرير في مساحة العمل (لوحة الإسناد
// الكاملة هناك) بدل إعادة تنفيذ حواره هنا.

import * as React from "react";
import {
  Eye, Send, Undo2, CheckCircle2, RotateCcw, PencilLine, ClipboardCheck, Loader2, ArrowUpDown, ExternalLink,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  WORKFLOW_STATUS_BADGE_CLASS,
  WORKFLOW_STATUS_LABELS,
  fmtWorkflowDateTime,
  type WorkflowAction,
} from "@/lib/workflow";
import type { DashboardRow } from "@/lib/reconciliation";

export type RowActionHandler = (
  row: DashboardRow,
  action: WorkflowAction,
  payload: { reason?: string; comment?: string }
) => Promise<boolean>;

const COLUMNS: { key: string; label: string; sortable?: boolean; cls?: string }[] = [
  { key: "name", label: "الاسم", sortable: true },
  { key: "groupName", label: "المجموعة" },
  { key: "periodEnd", label: "الفترة", sortable: true, cls: "whitespace-nowrap" },
  { key: "status", label: "الحالة", sortable: true },
  { key: "stage", label: "مرحلة الأعمال" },
  { key: "cycle", label: "د", sortable: true, cls: "text-center" },
  { key: "preparedBy", label: "المعدّ" },
  { key: "reviewedBy", label: "المراجع" },
  { key: "approvedBy", label: "المعتمد" },
  { key: "owner", label: "المسؤول الحالي" },
  { key: "dueDate", label: "الاستحقاق", sortable: true, cls: "whitespace-nowrap" },
  { key: "daysOverdue", label: "التأخير", cls: "text-center" },
  { key: "updatedAt", label: "آخر تعديل", sortable: true, cls: "whitespace-nowrap" },
  { key: "submittedAt", label: "الإرسال", sortable: true, cls: "whitespace-nowrap" },
  { key: "reviewStartedAt", label: "بدء المراجعة", sortable: true, cls: "whitespace-nowrap" },
  { key: "reviewedAt", label: "توقيع المراجع", sortable: true, cls: "whitespace-nowrap" },
  { key: "approvedAt", label: "الاعتماد", sortable: true, cls: "whitespace-nowrap" },
  { key: "actions", label: "إجراءات" },
];

export function ReconciliationsTable({
  rows, loading, sort, dir, onSort, onOpenReport, onAction,
}: {
  rows: DashboardRow[];
  loading: boolean;
  sort: string;
  dir: "asc" | "desc";
  onSort: (field: string) => void;
  onOpenReport: (id: string) => void;
  onAction: RowActionHandler;
}) {
  const [busyRow, setBusyRow] = React.useState<string | null>(null);
  const [reasonTarget, setReasonTarget] = React.useState<{ row: DashboardRow; action: "RETURN" | "REOPEN" } | null>(null);
  const [confirmTarget, setConfirmTarget] = React.useState<{ row: DashboardRow; action: WorkflowAction } | null>(null);

  async function run(row: DashboardRow, action: WorkflowAction, payload?: { reason?: string; comment?: string }) {
    setBusyRow(row.id);
    try {
      return await onAction(row, action, payload ?? {});
    } finally {
      setBusyRow(null);
    }
  }

  const cell = (r: DashboardRow, key: string) => {
    switch (key) {
      case "name":
        return (
          <button
            type="button"
            onClick={() => onOpenReport(r.id)}
            className="max-w-[220px] truncate text-start text-sm font-bold text-emerald-700 hover:underline dark:text-emerald-400"
            title={`فتح «${r.name}» في مساحة العمل`}
          >
            {r.name}
          </button>
        );
      case "groupName":
        return <span className="text-xs text-slate-500 dark:text-slate-400">{r.groupName ?? "بدون مجموعة"}</span>;
      case "periodEnd":
        return <span dir="ltr" className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.periodEnd ?? "—"}</span>;
      case "status": {
        const badgeCls = WORKFLOW_STATUS_BADGE_CLASS[r.status as keyof typeof WORKFLOW_STATUS_BADGE_CLASS] ?? WORKFLOW_STATUS_BADGE_CLASS.DRAFT;
        return <Badge className={cn("border-transparent px-2 text-[10px] font-bold", badgeCls)}>{r.statusLabel}</Badge>;
      }
      case "stage":
        return <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">{r.stageLabel}</span>;
      case "cycle":
        return r.cycle > 1
          ? <Badge variant="outline" className="px-1.5 text-[10px] font-bold text-purple-600 dark:text-purple-400" dir="ltr">د{r.cycle}</Badge>
          : <span className="text-xs tabular-nums text-slate-400">1</span>;
      case "preparedBy":
      case "reviewedBy":
      case "approvedBy":
        return <span className="text-xs text-slate-600 dark:text-slate-300">{r[key]?.name || "—"}</span>;
      case "owner":
        return (
          <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">
            {r.currentOwner?.role === "NONE" ? "مقفولة" : `${r.currentOwner?.roleLabel ?? "—"}: ${r.currentOwner?.name || "غير معيّن"}`}
          </span>
        );
      case "dueDate":
        return <span dir="ltr" className="text-xs tabular-nums text-slate-600 dark:text-slate-300">{r.dueDate ?? "—"}</span>;
      case "daysOverdue":
        return r.overdue
          ? <Badge className="border-transparent bg-red-100 px-1.5 text-[10px] font-bold text-red-700 dark:bg-red-950/60 dark:text-red-400" dir="ltr">{r.daysOverdue} ي</Badge>
          : <span className="text-xs text-slate-300 dark:text-slate-600">—</span>;
      case "updatedAt":
      case "submittedAt":
      case "reviewStartedAt":
      case "reviewedAt":
      case "approvedAt":
        return (
          <span className="text-[11px] text-slate-500 dark:text-slate-400" title={r[key] ? new Date(r[key] as string).toISOString() : undefined}>
            {r[key] ? fmtWorkflowDateTime(r[key]) : "—"}
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="overflow-x-auto">
        <Table className="min-w-[1250px]">
          <TableHeader>
            <TableRow className="bg-slate-50/70 dark:bg-slate-950/40">
              {COLUMNS.map((c) => (
                <TableHead key={c.key} className={cn("text-[11px] font-bold text-slate-500 dark:text-slate-400", c.cls)}>
                  {c.sortable ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-emerald-700 dark:hover:text-emerald-400"
                      onClick={() => onSort(c.key)}
                      aria-label={`ترتيب حسب ${c.label}`}
                    >
                      {c.label}
                      <ArrowUpDown className={cn("size-3", sort === c.key ? "text-emerald-600 dark:text-emerald-400" : "text-slate-300")} />
                    </button>
                  ) : c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {COLUMNS.map((c) => (
                    <TableCell key={c.key}><Skeleton className="h-4 w-full max-w-[110px]" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMNS.length} className="py-10 text-center text-sm text-slate-400 dark:text-slate-500">
                  لا توجد مطابقات ضمن صلاحياتك بهذه الفلاتر.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const a = r.myActions;
                const actions: { action: WorkflowAction; label: string; icon: React.ReactNode; reason?: boolean; cls?: string }[] = [];
                if (a.canSubmit) actions.push({ action: "SUBMIT", label: "إرسال", icon: <Send className="size-3.5" /> });
                if (a.canStartReview) actions.push({ action: "START_REVIEW", label: "بدء مراجعة", icon: <Eye className="size-3.5" /> });
                if (a.canCompleteReview) actions.push({ action: "COMPLETE_REVIEW", label: "إتمام مراجعة", icon: <ClipboardCheck className="size-3.5" /> });
                if (a.canReturn) actions.push({ action: "RETURN", label: "إرجاع", icon: <Undo2 className="size-3.5" />, reason: true });
                if (a.canApprove) actions.push({ action: "APPROVE", label: "اعتماد", icon: <CheckCircle2 className="size-3.5" /> });
                if (a.canResume) actions.push({ action: "RESUME_EDIT", label: "استئناف", icon: <PencilLine className="size-3.5" /> });
                if (a.canReopen) actions.push({ action: "REOPEN", label: "إعادة فتح", icon: <RotateCcw className="size-3.5" />, reason: true });

                return (
                  <TableRow key={r.id} className={cn(r.overdue && "bg-red-50/40 dark:bg-red-950/10")}>
                    {COLUMNS.map((c) => (
                      <TableCell key={c.key} className={cn("py-2.5", c.cls)}>
                        {c.key === "actions" ? (
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm" variant="outline"
                              className="h-7 gap-1 px-2 text-[11px]"
                              onClick={() => onOpenReport(r.id)}
                              title="فتح التقرير في مساحة العمل"
                            >
                              <ExternalLink className="size-3" />
                              عرض
                            </Button>
                            {actions.slice(0, 2).map((x) => (
                              <Button
                                key={x.action}
                                size="sm"
                                variant={x.action === "RETURN" || x.action === "REOPEN" ? "outline" : "default"}
                                className={cn(
                                  "h-7 gap-1 px-2 text-[11px]",
                                  x.action === "RETURN" || x.action === "REOPEN"
                                    ? "border-orange-300 text-orange-700 hover:bg-orange-50 dark:border-orange-900/60 dark:text-orange-400 dark:hover:bg-orange-950/30"
                                    : "bg-emerald-600 text-white hover:bg-emerald-700"
                                )}
                                disabled={busyRow === r.id}
                                onClick={() => (x.reason ? setReasonTarget({ row: r, action: x.action as "RETURN" | "REOPEN" }) : setConfirmTarget({ row: r, action: x.action }))}
                              >
                                {busyRow === r.id ? <Loader2 className="size-3 animate-spin" /> : x.icon}
                                {x.label}
                              </Button>
                            ))}
                          </div>
                        ) : (
                          cell(r, c.key)
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* حوار السبب الإلزامي (إرجاع/إعادة فتح) — نفس endpoint الانتقالات الحالي */}
      <RowReasonDialog
        target={reasonTarget}
        onClose={() => setReasonTarget(null)}
        onConfirm={async (row, action, reason) => run(row, action, { reason })}
      />
      {/* حوار تأكيد الانتقالات المباشرة */}
      <RowConfirmDialog
        target={confirmTarget}
        onClose={() => setConfirmTarget(null)}
        onConfirm={async (row, action) => run(row, action)}
      />
    </div>
  );
}

function RowReasonDialog({
  target, onClose, onConfirm,
}: {
  target: { row: DashboardRow; action: "RETURN" | "REOPEN" } | null;
  onClose: () => void;
  onConfirm: (row: DashboardRow, action: "RETURN" | "REOPEN", reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = React.useState("");
  const [err, setErr] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (target) { setReason(""); setErr(""); } }, [target]);
  if (!target) return null;
  const isReturn = target.action === "RETURN";
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isReturn ? "إرجاع التقرير للتصحيح" : "إعادة فتح التقرير المعتمد"}</DialogTitle>
          <DialogDescription>
            «{target.row.name}» — {isReturn ? "السبب إلزامي ويُحفظ في السجل الرقابي وسجل الدورات." : "تبدأ دورة اعتماد جديدة (الدورة +1) — السبب إلزامي."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            السبب <span className="text-rose-500">*</span>
          </Label>
          <Textarea value={reason} onChange={(e) => { setReason(e.target.value); setErr(""); }} rows={4} maxLength={2000} autoFocus />
          {err && <p className="text-xs font-semibold text-rose-600">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>إلغاء</Button>
          <Button
            className={isReturn ? "bg-orange-600 text-white hover:bg-orange-700" : "bg-purple-600 text-white hover:bg-purple-700"}
            disabled={busy}
            onClick={async () => {
              if (!reason.trim()) { setErr("السبب إلزامي."); return; }
              setBusy(true);
              try {
                const ok = await onConfirm(target.row, target.action, reason.trim());
                if (ok) onClose();
              } finally { setBusy(false); }
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            تأكيد
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowConfirmDialog({
  target, onClose, onConfirm,
}: {
  target: { row: DashboardRow; action: WorkflowAction } | null;
  onClose: () => void;
  onConfirm: (row: DashboardRow, action: WorkflowAction) => Promise<boolean>;
}) {
  const [busy, setBusy] = React.useState(false);
  if (!target) return null;
  const meta: Record<string, { title: string; desc: string; confirm: string; cls: string }> = {
    SUBMIT: { title: "إرسال التقرير للمراجعة", desc: `«${target.row.name}» — تُقفل بيانات المطابقة حتى المراجعة.`, confirm: "إرسال", cls: "bg-emerald-600 text-white hover:bg-emerald-700" },
    START_REVIEW: { title: "بدء مراجعة التقرير", desc: `«${target.row.name}» — يُثبت تاريخ بدء المراجعة.`, confirm: "بدء المراجعة", cls: "bg-violet-600 text-white hover:bg-violet-700" },
    COMPLETE_REVIEW: { title: "إتمام المراجعة (توقيع المراجع)", desc: `«${target.row.name}» — ينتقل إلى «بانتظار الاعتماد» وتُقفل البيانات نهائيًا.`, confirm: "توقيع", cls: "bg-rose-600 text-white hover:bg-rose-700" },
    APPROVE: { title: "اعتماد التقرير", desc: `«${target.row.name}» — الاعتماد النهائي للدورة ${target.row.cycle}.`, confirm: "اعتماد نهائي", cls: "bg-emerald-600 text-white hover:bg-emerald-700" },
    RESUME_EDIT: { title: "استئناف التعديل", desc: `«${target.row.name}» — يعود إلى مسودة للتعديل قبل إعادة الإرسال.`, confirm: "استئناف", cls: "bg-slate-700 text-white hover:bg-slate-800" },
  };
  const m = meta[target.action];
  if (!m) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m.title}</DialogTitle>
          <DialogDescription>{m.desc}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>إلغاء</Button>
          <Button
            className={m.cls}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const ok = await onConfirm(target.row, target.action);
                if (ok) onClose();
              } finally { setBusy(false); }
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {m.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
