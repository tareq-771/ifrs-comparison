"use client";

// شريط الفلاتر — كلها تُترجم خادميًا إلى WHERE فوق الرؤية.
// الفلاتر قابلة للتركيب (AND) وتُعرض كـ chips قابلة للإزالة + مسح الكل.

import * as React from "react";
import { Search, X, UserCheck } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BUSINESS_STAGE,
  BUSINESS_STAGE_LABELS,
  type BusinessStage,
} from "@/lib/reconciliation";
import { WORKFLOW_STATUS, WORKFLOW_STATUS_LABELS } from "@/lib/workflow";

export interface DashboardFacets {
  periods: string[];
  groups: { id: string; name: string }[];
  users: {
    preparers: { id: string; name: string }[];
    reviewers: { id: string; name: string }[];
    approvers: { id: string; name: string }[];
  };
}

export interface DashboardFilters {
  q: string;
  groupId: string | null;         // id | "__none__" (بدون مجموعة)
  period: string | null;          // date | "none"
  status: string | null;
  stage: BusinessStage | null;
  preparedById: string | null;
  reviewedById: string | null;
  approvedById: string | null;
  ownerRole: string | null;       // PREPARER|REVIEWER|APPROVER|NONE
  ownerMe: boolean;
  overdue: string | null;         // true|false|none
  cycle: string | null;           // N | ">1"
}

export const EMPTY_FILTERS: DashboardFilters = {
  q: "", groupId: null, period: null, status: null, stage: null,
  preparedById: null, reviewedById: null, approvedById: null,
  ownerRole: null, ownerMe: false, overdue: null, cycle: null,
};

function FilterSelect({
  label, value, onChange, children, minWidth = "w-[130px]",
}: {
  label: string; value: string | null; onChange: (v: string | null) => void; children: React.ReactNode; minWidth?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="block text-[10px] font-semibold text-slate-400 dark:text-slate-500">{label}</Label>
      <Select value={value ?? "__all__"} onValueChange={(v) => onChange(v === "__all__" ? null : v)}>
        <SelectTrigger className={`h-9 ${minWidth}`} size="sm"><SelectValue /></SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </div>
  );
}

export function FiltersBar({
  filters, setFilters, facets, onClearAll,
}: {
  filters: DashboardFilters;
  setFilters: (f: DashboardFilters) => void;
  facets: DashboardFacets | null;
  onClearAll: () => void;
}) {
  const set = (patch: Partial<DashboardFilters>) => setFilters({ ...filters, ...patch });
  const hasAny =
    Object.entries(filters).some(([k, v]) => v !== EMPTY_FILTERS[k as keyof DashboardFilters]);

  const chips: { label: string; clear: () => void }[] = [];
  if (filters.q) chips.push({ label: `بحث: ${filters.q}`, clear: () => set({ q: "" }) });
  if (filters.groupId === "__none__") chips.push({ label: "بدون مجموعة", clear: () => set({ groupId: null }) });
  else if (filters.groupId) chips.push({ label: `المجموعة: ${facets?.groups.find((g) => g.id === filters.groupId)?.name ?? filters.groupId}`, clear: () => set({ groupId: null }) });
  if (filters.period === "none") chips.push({ label: "بدون فترة", clear: () => set({ period: null }) });
  else if (filters.period) chips.push({ label: `الفترة: ${filters.period}`, clear: () => set({ period: null }) });
  if (filters.status) chips.push({ label: `الحالة: ${WORKFLOW_STATUS_LABELS[filters.status as keyof typeof WORKFLOW_STATUS_LABELS] ?? filters.status}`, clear: () => set({ status: null }) });
  if (filters.stage) chips.push({ label: `المرحلة: ${BUSINESS_STAGE_LABELS[filters.stage]}`, clear: () => set({ stage: null }) });
  if (filters.preparedById) chips.push({ label: `المعدّ: ${facets?.users.preparers.find((u) => u.id === filters.preparedById)?.name ?? ""}`, clear: () => set({ preparedById: null }) });
  if (filters.reviewedById) chips.push({ label: `المراجع: ${facets?.users.reviewers.find((u) => u.id === filters.reviewedById)?.name ?? ""}`, clear: () => set({ reviewedById: null }) });
  if (filters.approvedById) chips.push({ label: `المعتمد: ${facets?.users.approvers.find((u) => u.id === filters.approvedById)?.name ?? ""}`, clear: () => set({ approvedById: null }) });
  if (filters.ownerRole) chips.push({ label: `المسؤول: ${({ PREPARER: "المعدّ", REVIEWER: "المراجع", APPROVER: "المعتمد", NONE: "مقفولة" } as Record<string, string>)[filters.ownerRole]}`, clear: () => set({ ownerRole: null }) });
  if (filters.ownerMe) chips.push({ label: "المسؤول = أنا", clear: () => set({ ownerMe: false }) });
  if (filters.overdue === "true") chips.push({ label: "متأخرة", clear: () => set({ overdue: null }) });
  if (filters.overdue === "false") chips.push({ label: "غير متأخرة (ذات استحقاق)", clear: () => set({ overdue: null }) });
  if (filters.overdue === "none") chips.push({ label: "بدون استحقاق", clear: () => set({ overdue: null }) });
  if (filters.cycle === ">1") chips.push({ label: "الدورة > 1", clear: () => set({ cycle: null }) });
  else if (filters.cycle) chips.push({ label: `الدورة = ${filters.cycle}`, clear: () => set({ cycle: null }) });

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-4">
      <div className="flex flex-wrap items-end gap-2 sm:gap-3">
        {/* بحث بالاسم */}
        <div className="space-y-1">
          <Label className="block text-[10px] font-semibold text-slate-400 dark:text-slate-500">بحث بالاسم</Label>
          <div className="relative">
            <Search className="absolute top-1/2 size-3.5 -translate-y-1/2 text-slate-400 ltr:left-2.5 rtl:right-2.5" />
            <Input
              value={filters.q}
              onChange={(e) => set({ q: e.target.value })}
              placeholder="اسم المطابقة…"
              className="h-9 w-44 ps-8 text-sm sm:w-56"
            />
          </div>
        </div>

        <FilterSelect label="المجموعة" value={filters.groupId} onChange={(v) => set({ groupId: v })}>
          <SelectItem value="__all__">الكل</SelectItem>
          {facets?.groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
          <SelectItem value="__none__">— بدون مجموعة —</SelectItem>
        </FilterSelect>

        <FilterSelect label="الفترة" value={filters.period} onChange={(v) => set({ period: v })}>
          <SelectItem value="__all__">الكل</SelectItem>
          {facets?.periods.map((p) => <SelectItem key={p} value={p}><span dir="ltr">{p}</span></SelectItem>)}
          <SelectItem value="none">— بدون فترة —</SelectItem>
        </FilterSelect>

        <FilterSelect label="الحالة (workflow)" value={filters.status} onChange={(v) => set({ status: v })}>
          <SelectItem value="__all__">الكل</SelectItem>
          {Object.values(WORKFLOW_STATUS).map((s) => (
            <SelectItem key={s} value={s}>{WORKFLOW_STATUS_LABELS[s]}</SelectItem>
          ))}
        </FilterSelect>

        <FilterSelect label="مرحلة الأعمال" value={filters.stage} onChange={(v) => set({ stage: v as BusinessStage })}>
          <SelectItem value="__all__">الكل</SelectItem>
          {Object.values(BUSINESS_STAGE).map((s) => (
            <SelectItem key={s} value={s}>{BUSINESS_STAGE_LABELS[s]}</SelectItem>
          ))}
        </FilterSelect>

        <FilterSelect label="المعدّ" value={filters.preparedById} onChange={(v) => set({ preparedById: v })}>
          <SelectItem value="__all__">الكل</SelectItem>
          {facets?.users.preparers.map((u) => <SelectItem key={u.id} value={u.id}>{u.name || u.id}</SelectItem>)}
        </FilterSelect>

        <FilterSelect label="المراجع" value={filters.reviewedById} onChange={(v) => set({ reviewedById: v })}>
          <SelectItem value="__all__">الكل</SelectItem>
          {facets?.users.reviewers.map((u) => <SelectItem key={u.id} value={u.id}>{u.name || u.id}</SelectItem>)}
        </FilterSelect>

        <FilterSelect label="المعتمد" value={filters.approvedById} onChange={(v) => set({ approvedById: v })}>
          <SelectItem value="__all__">الكل</SelectItem>
          {facets?.users.approvers.map((u) => <SelectItem key={u.id} value={u.id}>{u.name || u.id}</SelectItem>)}
        </FilterSelect>

        <FilterSelect label="المسؤول الحالي" value={filters.ownerRole} onChange={(v) => set({ ownerRole: v })}>
          <SelectItem value="__all__">الكل</SelectItem>
          <SelectItem value="PREPARER">المعدّ</SelectItem>
          <SelectItem value="REVIEWER">المراجع</SelectItem>
          <SelectItem value="APPROVER">المعتمد</SelectItem>
          <SelectItem value="NONE">مقفولة — مكتملة</SelectItem>
        </FilterSelect>

        <FilterSelect label="التأخير" value={filters.overdue} onChange={(v) => set({ overdue: v })}>
          <SelectItem value="__all__">الكل</SelectItem>
          <SelectItem value="true">متأخرة فقط</SelectItem>
          <SelectItem value="false">غير متأخرة (ذات استحقاق)</SelectItem>
          <SelectItem value="none">بدون استحقاق</SelectItem>
        </FilterSelect>

        <FilterSelect label="الدورة" value={filters.cycle} onChange={(v) => set({ cycle: v })}>
          <SelectItem value="__all__">الكل</SelectItem>
          <SelectItem value=">1">أكثر من 1 (أعيد فتحها)</SelectItem>
          <SelectItem value="1">1</SelectItem>
          <SelectItem value="2">2</SelectItem>
          <SelectItem value="3">3</SelectItem>
        </FilterSelect>

        {/* المسؤول = أنا */}
        <div className="space-y-1">
          <Label className="block text-[10px] font-semibold text-slate-400 dark:text-slate-500">علىّ الكرة</Label>
          <Button
            type="button"
            variant={filters.ownerMe ? "default" : "outline"}
            size="sm"
            className={`h-9 gap-1.5 ${filters.ownerMe ? "bg-emerald-600 text-white hover:bg-emerald-700" : ""}`}
            onClick={() => set({ ownerMe: !filters.ownerMe })}
            aria-pressed={filters.ownerMe}
          >
            <UserCheck className="size-3.5" />
            المسؤول = أنا
          </Button>
        </div>
      </div>

      {/* chips + مسح الكل */}
      {hasAny && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3 dark:border-slate-800">
          {chips.map((c, i) => (
            <Badge key={i} variant="outline" className="gap-1 bg-slate-50 py-1 text-[11px] font-semibold text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
              {c.label}
              <button type="button" onClick={c.clear} aria-label={`إزالة فلتر ${c.label}`} className="rounded-full hover:text-rose-600">
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 text-[11px] text-rose-600 hover:text-rose-700" onClick={onClearAll}>
            <X className="size-3" /> مسح الكل
          </Button>
        </div>
      )}
    </div>
  );
}
