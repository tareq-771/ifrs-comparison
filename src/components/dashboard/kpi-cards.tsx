"use client";

// بطاقات KPI — كل بطاقة تُطبق فلترها الخادمي الثابت عند النقر (قرار المستخدم:
// فصل الحالة النظامية عن مرحلة الأعمال؛ «متأخرة» و«أعيد فتحها» علمان متراكبان).

import * as React from "react";
import { AlertTriangle, RotateCcw, Layers, Inbox, Eye, PenLine, Undo2, CheckCircle2, ClipboardCheck } from "lucide-react";

import { cn } from "@/lib/utils";
import { BUSINESS_STAGE, type BusinessStage } from "@/lib/reconciliation";

export interface KpiCounts {
  total: number;
  newDraft: number;
  submitted: number;
  underReview: number;
  returned: number;
  pendingApproval: number;
  approved: number;
  reopenedAwaiting: number;
  overdue: number;
  everReopened: number;
}

export interface ActiveKpiFilter {
  stage?: BusinessStage;
  overdue?: "true";
  cycleGt1?: boolean;
}

function cardMeta(key: string): { icon: React.ReactNode; cls: string; activeCls: string } {
  switch (key) {
    case "total":
      return { icon: <Layers className="size-4" />, cls: "border-slate-200 dark:border-slate-800", activeCls: "ring-2 ring-slate-400 bg-slate-100 dark:bg-slate-800" };
    case "newDraft":
      return { icon: <PenLine className="size-4" />, cls: "border-slate-200 dark:border-slate-800", activeCls: "ring-2 ring-slate-400 bg-slate-100 dark:bg-slate-800" };
    case "submitted":
      return { icon: <Inbox className="size-4" />, cls: "border-amber-200 dark:border-amber-900/60", activeCls: "ring-2 ring-amber-400 bg-amber-50 dark:bg-amber-950/40" };
    case "underReview":
      return { icon: <Eye className="size-4" />, cls: "border-violet-200 dark:border-violet-900/60", activeCls: "ring-2 ring-violet-400 bg-violet-50 dark:bg-violet-950/40" };
    case "returned":
      return { icon: <Undo2 className="size-4" />, cls: "border-orange-200 dark:border-orange-900/60", activeCls: "ring-2 ring-orange-400 bg-orange-50 dark:bg-orange-950/40" };
    case "pendingApproval":
      return { icon: <ClipboardCheck className="size-4" />, cls: "border-rose-200 dark:border-rose-900/60", activeCls: "ring-2 ring-rose-400 bg-rose-50 dark:bg-rose-950/40" };
    case "approved":
      return { icon: <CheckCircle2 className="size-4" />, cls: "border-emerald-200 dark:border-emerald-900/60", activeCls: "ring-2 ring-emerald-400 bg-emerald-50 dark:bg-emerald-950/40" };
    case "reopenedAwaiting":
      return { icon: <RotateCcw className="size-4" />, cls: "border-purple-200 dark:border-purple-900/60", activeCls: "ring-2 ring-purple-400 bg-purple-50 dark:bg-purple-950/40" };
    case "overdue":
      return { icon: <AlertTriangle className="size-4" />, cls: "border-red-200 dark:border-red-900/60", activeCls: "ring-2 ring-red-400 bg-red-50 dark:bg-red-950/40" };
    case "everReopened":
      return { icon: <RotateCcw className="size-4" />, cls: "border-slate-200 dark:border-slate-800", activeCls: "ring-2 ring-slate-400 bg-slate-100 dark:bg-slate-800" };
    default:
      return { icon: <Layers className="size-4" />, cls: "", activeCls: "" };
  }
}

function Card({
  label, value, icon, cls, activeCls, active, onClick, hint,
}: {
  label: string; value: number | "…"; icon: React.ReactNode; cls: string; activeCls: string;
  active: boolean; onClick: () => void; hint?: string;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={hint}
      aria-pressed={onClick ? active : undefined}
      className={cn(
        "flex min-h-[44px] flex-col items-start gap-1 rounded-xl border bg-white px-3 py-2.5 text-start shadow-sm transition-all dark:bg-slate-900",
        cls,
        active ? activeCls : onClick ? "hover:-translate-y-0.5 hover:shadow-md" : "",
        active && "font-bold"
      )}
    >
      <span className="flex w-full items-center gap-1.5 text-[11px] font-semibold leading-tight text-slate-500 dark:text-slate-400">
        {icon}
        {label}
      </span>
      <span className={cn("text-xl font-extrabold tabular-nums", active ? "text-slate-900 dark:text-white" : "text-slate-700 dark:text-slate-200")}>
        {value}
      </span>
    </Comp>
  );
}

export function KpiCards({
  counts,
  loading,
  active,
  onToggle,
}: {
  counts: KpiCounts | null;
  loading: boolean;
  active: ActiveKpiFilter;
  onToggle: (f: ActiveKpiFilter) => void;
}) {
  const v = (n: number | undefined) => (loading || counts === null ? "…" : n);
  const isStageActive = (s: BusinessStage) => active.stage === s;
  const stageCard = (
    key: keyof KpiCounts, stage: BusinessStage, label: string
  ) => (
    <Card
      label={label}
      value={v(counts?.[key] as number)}
      active={isStageActive(stage)}
      onClick={() => onToggle(isStageActive(stage) ? {} : { stage })}
      hint={`انقر لتصفية الجدول على: ${label}`}
      {...cardMeta(key)}
    />
  );

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" role="group" aria-label="بطاقات مؤشرات لوحة المتابعة">
      <Card
        label="إجمالي المطابقات"
        value={v(counts?.total)}
        active={Object.keys(active).length === 0}
        onClick={() => onToggle({})}
        hint="كل المطابقات ضمن صلاحياتك"
        {...cardMeta("total")}
      />
      {stageCard("newDraft", BUSINESS_STAGE.NEW_DRAFT, "مسودة")}
      {stageCard("submitted", BUSINESS_STAGE.SUBMITTED, "بانتظار المراجعة")}
      {stageCard("underReview", BUSINESS_STAGE.UNDER_REVIEW, "قيد المراجعة")}
      {stageCard("returned", BUSINESS_STAGE.RETURNED, "معادة للتعديل")}
      {stageCard("pendingApproval", BUSINESS_STAGE.PENDING_APPROVAL, "بانتظار الاعتماد")}
      {stageCard("approved", BUSINESS_STAGE.APPROVED, "معتمدة")}
      {stageCard("reopenedAwaiting", BUSINESS_STAGE.REOPENED, "معاد فتحها")}
      {/* علما متراكبان — لا يدخلان التقسيم الحصري للمراحل */}
      <Card
        label="متأخرة (علم متراكب)"
        value={v(counts?.overdue)}
        active={active.overdue === "true"}
        onClick={() => onToggle(active.overdue === "true" ? {} : { overdue: "true" })}
        hint="استحقاق تجاوز ويجري العمل عليها — تتراكب مع أي مرحلة"
        {...cardMeta("overdue")}
      />
      <Card
        label="أعيد فتحها بعد الاعتماد (د>1)"
        value={v(counts?.everReopened)}
        active={active.cycleGt1 === true}
        onClick={() => onToggle(active.cycleGt1 === true ? {} : { cycleGt1: true })}
        hint="تراكمي: كل ما فُتح بعد اعتماده (الدورة أكبر من 1)"
        {...cardMeta("everReopened")}
      />
    </div>
  );
}
