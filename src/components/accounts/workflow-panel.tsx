"use client";

// لوحة الحوكمة (Workflow) للتقرير المفتوح — المرحلة 3.
// كل الأزرار تُبنى من workflow.myActions القادمة من الخادم حصرًا —
// الواجهة تعرض ما يسمح به الخادم فقط (لا منطق صلاحيات محلي).

import * as React from "react";
import {
  Send, Eye, Undo2, CheckCircle2, RotateCcw, PencilLine, Users, History, Loader2,
  ShieldAlert, Info, ClipboardCheck, CalendarClock,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  WORKFLOW_STATUS_BADGE_CLASS, WORKFLOW_STATUS_LABELS, WORKFLOW_HISTORY_ACTION_LABELS,
  fmtWorkflowDateTime, workflowRoleLabel,
  type WorkflowInfo, type WorkflowAction, type WorkflowHistoryRow, type AssignmentCandidate,
} from "@/lib/workflow";

export type WorkflowActionHandler = (
  action: WorkflowAction,
  payload: { reason?: string; comment?: string }
) => Promise<boolean>;

/* ═══════════════════════════════════════════════════════════════════════ */
/*  اللوحة الرئيسية                                                          */
/* ═══════════════════════════════════════════════════════════════════════ */

export function WorkflowPanel({
  workflow,
  reportId,
  version,
  onAction,
  onAssign,
  onDueDate,
}: {
  workflow: WorkflowInfo;
  reportId: string;
  version: number;
  onAction: WorkflowActionHandler;
  onAssign: (updates: { preparedById?: string | null; reviewedById?: string | null; approvedById?: string | null; reason?: string }, version: number) => Promise<boolean>;
  /** المرحلة 3.5 — حوكمة تاريخ الاستحقاق (assignWorkflow) — PATCH /api/reports/[id]/due-date */
  onDueDate?: (dueDate: string | null, version: number) => Promise<boolean>;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [reasonDialog, setReasonDialog] = React.useState<"RETURN" | "REOPEN" | null>(null);
  const [confirmAction, setConfirmAction] = React.useState<WorkflowAction | null>(null);
  const [assignmentOpen, setAssignmentOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [dueDateOpen, setDueDateOpen] = React.useState(false);
  const a = workflow.myActions;

  async function run(action: WorkflowAction, payload?: { reason?: string; comment?: string }) {
    setBusy(action);
    try {
      const ok = await onAction(action, payload ?? {});
      if (ok) setConfirmAction(null);
      return ok;
    } finally {
      setBusy(null);
    }
  }

  const statusKey = (workflow.status as keyof typeof WORKFLOW_STATUS_BADGE_CLASS) || "DRAFT";

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-5">
      {/* الرأس: الحالة + الدورة + الفترة */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-slate-700 dark:text-slate-200">دورة الاعتماد:</span>
        <Badge className={cn("border-transparent px-2.5 text-xs font-bold", WORKFLOW_STATUS_BADGE_CLASS[statusKey] ?? WORKFLOW_STATUS_BADGE_CLASS.DRAFT)}>
          {workflow.statusLabel}
        </Badge>
        <Badge variant="outline" className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
          الدورة <span dir="ltr">{workflow.cycle}</span>
        </Badge>
        {workflow.periodEnd && (
          <Badge variant="outline" className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            نهاية الفترة المالية: <span dir="ltr">{workflow.periodEnd}</span>
          </Badge>
        )}
        {/* المرحلة 3.5 — تاريخ الاستحقاق (حقل رقابي): عرض + حوكمة عبر assignWorkflow */}
        {workflow.dueDate && (
          <Badge variant="outline" className="gap-1 border-slate-300 text-[11px] font-semibold text-slate-600 dark:border-slate-700 dark:text-slate-300">
            <CalendarClock className="size-3" />
            الاستحقاق: <span dir="ltr">{workflow.dueDate}</span>
          </Badge>
        )}
        <div className="ms-auto flex items-center gap-1.5">
          {a.canAssign && onDueDate && workflow.status !== "APPROVED" && (
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setDueDateOpen(true)}>
              <CalendarClock className="size-3.5" />
              {workflow.dueDate ? "تغيير الاستحقاق" : "ضبط الاستحقاق"}
            </Button>
          )}
          {a.canAssign && (
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setAssignmentOpen(true)}>
              <Users className="size-3.5" /> تغيير الإسناد
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs text-slate-500 dark:text-slate-400" onClick={() => setHistoryOpen(true)}>
            <History className="size-3.5" /> سجل الدورات
          </Button>
        </div>
      </div>

      {/* المشاركون */}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <ParticipantCard role="prepared" info={workflow.preparedBy} />
        <ParticipantCard role="reviewed" info={workflow.reviewedBy} reviewStartedAt={workflow.reviewStartedAt} />
        <ParticipantCard role="approved" info={workflow.approvedBy} />
      </div>

      {/* أسباب الإرجاع / إعادة الفتح (إرشاد للدورة الحالية) */}
      {workflow.returned?.reason && (
        <Alert className="mt-3 border-orange-200 bg-orange-50/70 text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/30 dark:text-orange-300">
          <ShieldAlert className="size-4" />
          <AlertDescription className="text-xs leading-relaxed">
            <strong>أُرجع للتصحيح بواسطة {workflow.returned.byName || "المراجع"} ({fmtWorkflowDateTime(workflow.returned.at)}):</strong> {workflow.returned.reason}
          </AlertDescription>
        </Alert>
      )}
      {workflow.reopened?.reason && (
        <Alert className="mt-3 border-purple-200 bg-purple-50/70 text-purple-800 dark:border-purple-900/60 dark:bg-purple-950/30 dark:text-purple-300">
          <Info className="size-4" />
          <AlertDescription className="text-xs leading-relaxed">
            <strong>أُعيد فتحه بواسطة {workflow.reopened.byName || "مستخدم مخوّل"} ({fmtWorkflowDateTime(workflow.reopened.at)}):</strong> {workflow.reopened.reason}
          </AlertDescription>
        </Alert>
      )}

      {/* أزرار الإجراءات المسموحة للمستخدم الحالي — من الخادم حصرًا */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
        {a.canResume && (
          <Button size="sm" variant="outline" className="h-9 gap-1.5" disabled={busy !== null}
            onClick={() => setConfirmAction("RESUME_EDIT")}>
            {busy === "RESUME_EDIT" ? <Loader2 className="size-4 animate-spin" /> : <PencilLine className="size-4" />}
            استئناف التعديل
          </Button>
        )}
        {a.canSubmit && (
          <Button size="sm" className="h-9 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy !== null}
            onClick={() => setConfirmAction("SUBMIT")}>
            {busy === "SUBMIT" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            إرسال للمراجعة
          </Button>
        )}
        {a.canStartReview && (
          <Button size="sm" className="h-9 gap-1.5 bg-violet-600 text-white hover:bg-violet-700" disabled={busy !== null}
            onClick={() => setConfirmAction("START_REVIEW")}>
            {busy === "START_REVIEW" ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
            بدء المراجعة
          </Button>
        )}
        {a.canCompleteReview && (
          <Button size="sm" className="h-9 gap-1.5 bg-rose-600 text-white hover:bg-rose-700" disabled={busy !== null}
            onClick={() => setConfirmAction("COMPLETE_REVIEW")}>
            {busy === "COMPLETE_REVIEW" ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCheck className="size-4" />}
            إتمام المراجعة (توقيع المراجع)
          </Button>
        )}
        {a.canReturn && (
          <Button size="sm" variant="outline" className="h-9 gap-1.5 border-orange-300 text-orange-700 hover:bg-orange-50 dark:border-orange-900/60 dark:text-orange-400 dark:hover:bg-orange-950/30"
            disabled={busy !== null} onClick={() => setReasonDialog("RETURN")}>
            <Undo2 className="size-4" />
            {workflow.status === "PENDING_APPROVAL" ? "إرجاع قبل الاعتماد" : "إرجاع للتصحيح"}
          </Button>
        )}
        {a.canApprove && (
          <Button size="sm" className="h-9 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy !== null}
            onClick={() => setConfirmAction("APPROVE")}>
            {busy === "APPROVE" ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            اعتماد التقرير
          </Button>
        )}
        {a.canReopen && (
          <Button size="sm" variant="outline" className="h-9 gap-1.5 border-purple-300 text-purple-700 hover:bg-purple-50 dark:border-purple-900/60 dark:text-purple-300 dark:hover:bg-purple-950/30"
            disabled={busy !== null} onClick={() => setReasonDialog("REOPEN")}>
            <RotateCcw className="size-4" />
            إعادة فتح
          </Button>
        )}
        {!a.canEdit && !a.canSubmit && !a.canStartReview && !a.canCompleteReview && !a.canReturn && !a.canApprove && !a.canReopen && !a.canResume && (
          <p className="text-xs text-slate-400 dark:text-slate-500">
            لا توجد إجراءات متاحة لك في الحالة الحالية — القراءة فقط.
          </p>
        )}
      </div>

      {/* حوارات الإجراءات */}
      <ReasonDialog
        open={reasonDialog === "RETURN"}
        mode="RETURN"
        fromPendingApproval={workflow.status === "PENDING_APPROVAL"}
        busy={busy === "RETURN"}
        onOpenChange={(o) => !o && setReasonDialog(null)}
        onConfirm={(reason) => run("RETURN", { reason })}
      />
      <ReasonDialog
        open={reasonDialog === "REOPEN"}
        mode="REOPEN"
        busy={busy === "REOPEN"}
        onOpenChange={(o) => !o && setReasonDialog(null)}
        onConfirm={(reason) => run("REOPEN", { reason })}
      />
      <ConfirmActionDialog
        action={confirmAction}
        workflow={workflow}
        busy={confirmAction ? busy === confirmAction : false}
        onOpenChange={(o) => !o && setConfirmAction(null)}
        onConfirm={(act) => run(act, act === "SUBMIT" ? {} : act === "APPROVE" ? {} : {})}
      />

      {/* حوار الإسناد + سجل الدورات */}
      <AssignmentDialog
        open={assignmentOpen}
        onOpenChange={setAssignmentOpen}
        workflow={workflow}
        onAssign={onAssign}
        version={version}
      />
      <WorkflowHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        reportId={reportId}
      />
      {onDueDate && (
        <DueDateDialog
          open={dueDateOpen}
          onOpenChange={setDueDateOpen}
          current={workflow.dueDate}
          version={version}
          onConfirm={onDueDate}
        />
      )}
    </div>
  );
}

/* ── بطاقة مشارك ── */
function ParticipantCard({ role, info, reviewStartedAt }: { role: "prepared" | "reviewed" | "approved"; info: { name: string; at: string | null } | null; reviewStartedAt?: string | null }) {
  const labels: Record<string, string> = { prepared: "المعدّ", reviewed: "المراجع", approved: "المعتمد" };
  const atLabels: Record<string, string> = { prepared: "تاريخ الإعداد", reviewed: "تاريخ إتمام المراجعة (التوقيع)", approved: "تاريخ الاعتماد" };
  return (
    <div className="rounded-lg border border-slate-150 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/40">
      <div className="text-[10px] font-semibold text-slate-400 dark:text-slate-500">{labels[role]}</div>
      <div className={cn("truncate text-sm font-bold", info?.name ? "text-slate-800 dark:text-slate-100" : "text-slate-400 dark:text-slate-500")}>
        {info?.name || "— غير معيّن —"}
      </div>
      <div className="text-[10px] text-slate-400 dark:text-slate-500">
        {atLabels[role]}: {info?.at ? fmtWorkflowDateTime(info.at) : "—"}
      </div>
      {role === "reviewed" && (
        <div className="text-[10px] text-slate-400 dark:text-slate-500">
          تاريخ بدء المراجعة: {reviewStartedAt ? fmtWorkflowDateTime(reviewStartedAt) : "—"}
        </div>
      )}
    </div>
  );
}

/* ── حوار السبب الإلزامي (RETURN / REOPEN) ── */
function ReasonDialog({
  open, mode, busy, onOpenChange, onConfirm, fromPendingApproval,
}: {
  open: boolean;
  mode: "RETURN" | "REOPEN";
  busy: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (reason: string) => Promise<boolean>;
  /** المرحلة 3.5 — الإرجاع من PENDING_APPROVAL بيد المعتمد */
  fromPendingApproval?: boolean;
}) {
  const [reason, setReason] = React.useState("");
  const [err, setErr] = React.useState("");
  React.useEffect(() => { if (open) { setReason(""); setErr(""); } }, [open]);
  const isReturn = mode === "RETURN";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isReturn ? "إرجاع التقرير للتصحيح" : "إعادة فتح التقرير المعتمد"}</DialogTitle>
          <DialogDescription>
            {isReturn
              ? fromPendingApproval
                ? "التقرير بانتظار الاعتماد — الإرجاع بيد المعتمد بسبب إلزامي ويعيد الكرة إلى المعدّ لتمر بالدورة من جديد (توقيع المراجع يُوثق في السجل وتبدأ مراجعة جديدة عند إعادة الإرسال)."
                : "سيُعاد التقرير إلى المعدّ للتصحيح — السبب إلزامي ويُحفظ في السجل الرقابي وسجل الدورات."
              : "إعادة الفتح تبدأ دورة اعتماد جديدة (تزداد الدورة 1) — السبب إلزامي ويُحفظ مع أرشفة الاعتماد السابق كاملًا."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            {isReturn ? "سبب الإرجاع" : "سبب إعادة الفتح"} <span className="text-rose-500">*</span>
          </Label>
          <Textarea
            value={reason}
            onChange={(e) => { setReason(e.target.value); if (e.target.value.trim()) setErr(""); }}
            placeholder={isReturn ? "مثال: أرقام الحسابات غير مكتملة — يرجى التصحيح" : "مثال: اكتشاف خطأ في التصنيف — يلزم إعادة الاعتماد"}
            rows={4}
            maxLength={2000}
            autoFocus
          />
          {err && <p className="text-xs font-semibold text-rose-600">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>إلغاء</Button>
          <Button
            className={isReturn ? "bg-orange-600 text-white hover:bg-orange-700" : "bg-purple-600 text-white hover:bg-purple-700"}
            disabled={busy}
            onClick={async () => {
              if (!reason.trim()) { setErr(isReturn ? "سبب الإرجاع إلزامي." : "سبب إعادة الفتح إلزامي."); return; }
              const ok = await onConfirm(reason.trim());
              if (ok) onOpenChange(false);
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {isReturn ? "تأكيد الإرجاع" : "تأكيد إعادة الفتح"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── حوار تأكيد الإجراء (SUBMIT / START_REVIEW / APPROVE / RESUME_EDIT) ── */
function ConfirmActionDialog({
  action, workflow, busy, onOpenChange, onConfirm,
}: {
  action: WorkflowAction | null;
  workflow: WorkflowInfo;
  busy: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (a: WorkflowAction) => Promise<boolean>;
}) {
  const meta: Record<string, { title: string; desc: string; confirm: string; cls: string }> = {
    SUBMIT: {
      title: "إرسال التقرير للمراجعة",
      desc: `سيرسل التقرير إلى المراجع${workflow.reviewedBy?.name ? ` «${workflow.reviewedBy.name}»` : ""} وتُقفل بيانات المطابقة ضد التعديل حتى المراجعة. تأكد من حفظ تعديلاتك أولًا.`,
      confirm: "إرسال",
      cls: "bg-emerald-600 text-white hover:bg-emerald-700",
    },
    START_REVIEW: {
      title: "بدء مراجعة التقرير",
      desc: "ستبدأ المراجعة الرسمية ويُثبت تاريخ بدئها. بعدها يمكنك إما إتمام المراجعة والتوقيع أو الإرجاع بسبب.",
      confirm: "بدء المراجعة",
      cls: "bg-violet-600 text-white hover:bg-violet-700",
    },
    COMPLETE_REVIEW: {
      title: "إتمام المراجعة (توقيع المراجع)",
      desc: `سيتوقّع المراجع اكتمال المراجعة وينتقل التقرير إلى «بانتظار الاعتماد» — تصبح بيانات المطابقة مقفولة نهائيًا وتنتقل المسؤولية إلى المعتمد${workflow.approvedBy?.name ? ` «${workflow.approvedBy.name}»` : ""} الذي يعتمد أو يُرجع بسبب.`,
      confirm: "توقيع وإتمام المراجعة",
      cls: "bg-rose-600 text-white hover:bg-rose-700",
    },
    APPROVE: {
      title: "اعتماد التقرير",
      desc: `الاعتماد النهائي للدورة ${workflow.cycle} بعد توقيع المراجع — سيُقفل التقرير كليًا ولا يمكن تعديله إلا عبر إعادة فتح بصلاحية خاصة وسبب موثّق.`,
      confirm: "اعتماد نهائي",
      cls: "bg-emerald-600 text-white hover:bg-emerald-700",
    },
    RESUME_EDIT: {
      title: "استئناف التعديل",
      desc: "سيعود التقرير إلى حالة «مسودة» لتتمكن من تعديل بيانات المطابقة قبل إعادة الإرسال.",
      confirm: "استئناف",
      cls: "bg-slate-700 text-white hover:bg-slate-800",
    },
  };
  const m = action ? meta[action] : null;
  return (
    <Dialog open={!!action} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{m?.title}</DialogTitle>
          <DialogDescription>{m?.desc}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>إلغاء</Button>
          <Button className={m?.cls} disabled={busy || !action} onClick={() => action && onConfirm(action)}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {m?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  حوار الإسناد (assignWorkflow)                                            */
/* ═══════════════════════════════════════════════════════════════════════ */

export function AssignmentDialog({
  open, onOpenChange, workflow, version, onAssign,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workflow: WorkflowInfo;
  version: number;
  onAssign: (updates: { preparedById?: string | null; reviewedById?: string | null; approvedById?: string | null; reason?: string }, version: number) => Promise<boolean>;
}) {
  const [users, setUsers] = React.useState<AssignmentCandidate[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [prep, setPrep] = React.useState<string>("__none__");
  const [rev, setRev] = React.useState<string>("__none__");
  const [appr, setAppl] = React.useState<string>("__none__");
  const [reason, setReason] = React.useState("");
  const [err, setErr] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setPrep(workflow.preparedBy?.id ?? "__none__");
    setRev(workflow.reviewedBy?.id ?? "__none__");
    setAppl(workflow.approvedBy?.id ?? "__none__");
    setReason(""); setErr("");
    setLoading(true);
    fetch("/api/users?for=assignment")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setUsers(d))
      .catch(() => setErr("تعذر جلب قائمة المستخدمين."))
      .finally(() => setLoading(false));
  }, [open, workflow.preparedBy?.id, workflow.reviewedBy?.id, workflow.approvedBy?.id]);

  // فحص SoD فوري في الواجهة (الخادم يعيد الفحص دائمًا)
  const trio = [
    ["المعدّ", prep] as const,
    ["المراجع", rev] as const,
    ["المعتمد", appr] as const,
  ].filter(([, v]) => v !== "__none__");
  const sodConflict = trio.some(([, v], i) => trio.slice(i + 1).some(([, v2]) => v === v2));

  async function save() {
    setErr("");
    if (sodConflict) { setErr("فصل المهام: لا يجوز أن يشغل نفس الشخص دورين في نفس التقرير."); return; }
    setSaving(true);
    try {
      const updates: Record<string, string | null> = {};
      if (prep !== (workflow.preparedBy?.id ?? "__none__")) updates.preparedById = prep === "__none__" ? null : prep;
      if (rev !== (workflow.reviewedBy?.id ?? "__none__")) updates.reviewedById = rev === "__none__" ? null : rev;
      if (appr !== (workflow.approvedBy?.id ?? "__none__")) updates.approvedById = appr === "__none__" ? null : appr;
      if (Object.keys(updates).length === 0) { setErr("لا يوجد تغيير فعلي."); return; }
      const ok = await onAssign({ ...updates, reason: reason.trim() || undefined }, version);
      if (ok) onOpenChange(false); else setErr("تعذر حفظ الإسناد — راجع الرسالة أعلى الصفحة.");
    } finally {
      setSaving(false);
    }
  }

  const activeUsers = users.filter((u) => u.active);
  const userLabel = (u: AssignmentCandidate) => u.displayName || u.username;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>إسناد أدوار التقرير</DialogTitle>
          <DialogDescription>
            المعد والمراجع والمعتمد لهذا التقرير تحديدًا — مع فصل مهام إلزامي (لا يجوز جمع دورين لشخص واحد).
            تغيير الإسناد يرفع نسخة التقرير ويُسجَّل في السجل الرقابي.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="size-5 animate-spin text-slate-400" /></div>
        ) : (
          <div className="space-y-3">
            <RoleSelect label="المعدّ" hint="يستطيع تعديل بيانات المطابقة في المسودة/المُرجَع/المُعاد فتحه" value={prep} onChange={setPrep} users={activeUsers} userLabel={userLabel} />
            <RoleSelect label="المراجع" hint="يبدأ المراجعة ويُرجع للتصحيح بسبب" value={rev} onChange={setRev} users={activeUsers} userLabel={userLabel} />
            <RoleSelect label="المعتمد" hint="يعتمد التقرير بعد اكتمال المراجعة (منفصل عن المراجع إلزاميًا)" value={appr} onChange={setAppl} users={activeUsers} userLabel={userLabel} />
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-slate-600 dark:text-slate-300">سبب التغيير (اختياري)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} placeholder="مثال: المراجع السابق في إجازة" />
            </div>
            {sodConflict && (
              <Alert className="border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
                <ShieldAlert className="size-4" />
                <AlertDescription className="text-xs font-semibold">
                  فصل المهام: لا يجوز أن يشغل نفس الشخص دورين في نفس التقرير.
                </AlertDescription>
              </Alert>
            )}
            {err && <p className="text-xs font-semibold text-rose-600">{err}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>إلغاء</Button>
          <Button onClick={save} disabled={saving || loading || sodConflict} className="bg-emerald-600 text-white hover:bg-emerald-700">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Users className="size-4" />}
            حفظ الإسناد
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoleSelect({
  label, hint, value, onChange, users, userLabel,
}: {
  label: string; hint: string; value: string; onChange: (v: string) => void;
  users: AssignmentCandidate[]; userLabel: (u: AssignmentCandidate) => string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold text-slate-600 dark:text-slate-300">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full" size="sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">— غير معيّن —</SelectItem>
          {users.map((u) => (
            <SelectItem key={u.id} value={u.id}>{userLabel(u)} <span dir="ltr" className="text-[10px] text-slate-400">({u.username})</span></SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[10px] text-slate-400 dark:text-slate-500">{hint}</p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  حوار سجل الدورات (WorkflowHistory — قراءة فقط)                           */
/* ═══════════════════════════════════════════════════════════════════════ */

export function WorkflowHistoryDialog({ open, onOpenChange, reportId }: { open: boolean; onOpenChange: (o: boolean) => void; reportId: string }) {
  const [rows, setRows] = React.useState<WorkflowHistoryRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open || !reportId) return;
    setLoading(true);
    fetch(`/api/reports/${reportId}/workflow-history`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setRows(d))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [open]);

  // تجميع حسب الدورة
  const cycles = React.useMemo(() => {
    if (!rows) return [];
    const map = new Map<number, WorkflowHistoryRow[]>();
    for (const r of rows) {
      const list = map.get(r.cycle) ?? [];
      list.push(r);
      map.set(r.cycle, list);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [rows]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>سجل دورات الاعتماد</DialogTitle>
          <DialogDescription>
            السجل التاريخي الكامل (للقراءة فقط) — يُحفظ كل حدث مع فاعله ووقته والسبب وأدوار التقرير لحظته.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="size-5 animate-spin text-slate-400" /></div>
        ) : !rows || rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">لا سجل بعد.</p>
        ) : (
          <div className="space-y-4">
            {cycles.map(([cycle, list]) => (
              <div key={cycle} className="rounded-lg border border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/70 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/40">
                  <Badge variant="outline" className="text-[11px] font-bold">الدورة {cycle}</Badge>
                  <span className="text-[11px] text-slate-400">{list.length} حدث</span>
                </div>
                <ol className="divide-y divide-slate-100 dark:divide-slate-800">
                  {list.map((r) => (
                    <li key={r.id} className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-xs font-bold text-slate-700 dark:text-slate-200">{WORKFLOW_HISTORY_ACTION_LABELS[r.action as keyof typeof WORKFLOW_HISTORY_ACTION_LABELS] ?? r.action}</span>
                        {r.fromStatus && r.toStatus && r.fromStatus !== r.toStatus && (
                          <span className="text-[10px] text-slate-400" dir="ltr">
                            {WORKFLOW_STATUS_LABELS[r.fromStatus as keyof typeof WORKFLOW_STATUS_LABELS] ?? r.fromStatus}
                            {" → "}
                            {WORKFLOW_STATUS_LABELS[r.toStatus as keyof typeof WORKFLOW_STATUS_LABELS] ?? r.toStatus}
                          </span>
                        )}
                        <span className="ms-auto text-[10px] text-slate-400">{fmtWorkflowDateTime(r.createdAt)}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                        بواسطة: <strong>{r.actorUsername || "—"}</strong>
                        {r.reason ? <> · السبب: {r.reason}</> : null}
                        {r.comment ? <> · ملاحظة: {r.comment}</> : null}
                      </div>
                      {r.action === "REOPENED" && (() => {
                        try {
                          const snap = JSON.parse(r.roleSnapshot || "{}");
                          const prev = snap?.previousApproval ?? snap?.roles?.previousApproval;
                          if (prev?.approvedBy) {
                            return (
                              <div className="mt-1 rounded bg-slate-50 px-2 py-1.5 text-[10px] leading-relaxed text-slate-500 dark:bg-slate-950/60 dark:text-slate-400">
                                الاعتماد السابق المؤرشف: اعتمده <strong>{String(prev.approvedBy)}</strong>
                                {prev.approvedAt ? ` في ${fmtWorkflowDateTime(prev.approvedAt)}` : ""}
                                {prev.reviewedBy ? ` · راجعه ${String(prev.reviewedBy)}` : ""}
                              </div>
                            );
                          }
                        } catch { /* ignore */ }
                        return null;
                      })()}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  حوار حوكمة تاريخ الاستحقاق (المرحلة 3.5 — قرار D-1)                       */
/*  يظهر لحائز assignWorkflow فقط — المسار PATCH /api/reports/[id]/due-date   */
/* ═══════════════════════════════════════════════════════════════════════ */
function DueDateDialog({
  open, onOpenChange, current, version, onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  current: string | null;
  version: number;
  onConfirm: (dueDate: string | null, version: number) => Promise<boolean>;
}) {
  const [value, setValue] = React.useState<string>("");
  const [err, setErr] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) { setValue(current ?? ""); setErr(""); } }, [open, current]);

  async function save() {
    setErr("");
    const next = value.trim() === "" ? null : value.trim();
    if (next === current) { setErr("لا يوجد تغيير في تاريخ الاستحقاق."); return; }
    setBusy(true);
    try {
      const ok = await onConfirm(next, version);
      if (ok) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>حوكمة تاريخ الاستحقاق</DialogTitle>
          <DialogDescription>
            حقل رقابي — تغييره يتطلب صلاحية خاصة ويسجّل في السجل الرقابي (DUE_DATE_CHANGED)
            مع القيمة القديمة والجديدة ورقم الدورة. الصيغة YYYY-MM-DD.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            تاريخ الاستحقاق
          </Label>
          <Input
            type="date"
            value={value}
            onChange={(e) => { setValue(e.target.value); setErr(""); }}
            className="w-full sm:w-56"
            dir="ltr"
          />
          <p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            اتركه فارغًا لإزالة الاستحقاق («غير محدد») — التقرير بلا استحقاق لا يدخل في المتأخرة أبدًا.
          </p>
          {err && <p className="text-xs font-semibold text-rose-600">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>إلغاء</Button>
          <Button onClick={save} disabled={busy} className="bg-slate-700 text-white hover:bg-slate-800">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <CalendarClock className="size-4" />}
            حفظ الاستحقاق
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
