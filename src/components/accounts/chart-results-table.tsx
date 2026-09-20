"use client";

import * as React from "react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  type MatchedRow, type MatchStatus, type DiffSegment,
  diffStrings, fmtAmount,
} from "@/lib/accounts";

interface ChartResultsTableProps {
  rows: MatchedRow[];
  L1: string;
  L2: string;
}

/** Color classes per status badge. */
function statusClass(st: MatchStatus): string {
  switch (st) {
    case "مطابق":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "مطابق الاسم مختلف الرقم":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "تغير جوهري":
      return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
    case "في الملف الأول فقط":
      return "bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300";
    case "في الملف الثاني فقط":
      return "bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300";
    case "غير مطابق":
      return "bg-slate-100 text-slate-400 dark:bg-slate-800/30 dark:text-slate-500";
    default:
      return "bg-slate-100 text-slate-500 dark:bg-slate-800/50 dark:text-slate-400";
  }
}

/** Color for similarity percentage cell. */
function simClass(sim: number | null | undefined): string {
  if (sim == null) return "text-slate-300 dark:text-slate-600";
  if (sim === 100) return "text-emerald-600 dark:text-emerald-400 font-bold";
  if (sim >= 95) return "text-emerald-600 dark:text-emerald-400 font-semibold";
  if (sim >= 80) return "text-emerald-600 dark:text-emerald-400";
  if (sim >= 50) return "text-amber-600 dark:text-amber-400";
  return "text-slate-400 dark:text-slate-500";
}

/** Format amount with thousands separator, with — for null. */
function fmtAmt(v: number | null | undefined): string {
  if (v == null) return "—";
  return fmtAmount(v);
}

/** Format change percentage: +x.xx% / -x.xx% / — */
function fmtChangePct(v: number | null | undefined): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

/** Color for change cell: green for increase, red for decrease. */
function changeClass(v: number | null | undefined): string {
  if (v == null) return "text-slate-300 dark:text-slate-600";
  if (v > 0) return "text-emerald-600 dark:text-emerald-400 font-semibold";
  if (v < 0) return "text-red-600 dark:text-red-400 font-semibold";
  return "text-slate-500 dark:text-slate-400";
}

/** Filter tabs for the chart results table — 5 tabs matching the 4 sheets + All. */
type ChartFilter = "all" | "matched" | "nameMatchNumDiff" | "unmatched" | "fundamental";

interface FilterTab {
  key: ChartFilter;
  label: string;
  cls: string;
}

const TABS: FilterTab[] = [
  { key: "all", label: "الكل", cls: "border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-300" },
  { key: "matched", label: "مطابق الاسم والرقم", cls: "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300" },
  { key: "nameMatchNumDiff", label: "مطابق الاسم مختلف الرقم", cls: "border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300" },
  { key: "unmatched", label: "غير المطابق", cls: "border-slate-300 text-slate-500 dark:border-slate-700 dark:text-slate-400" },
  { key: "fundamental", label: "التغيرات الجوهرية", cls: "border-red-300 text-red-700 dark:border-red-700 dark:text-red-300" },
];

/** Render a single diff segment with appropriate styling per op. */
function DiffSegmentView({ seg }: { seg: DiffSegment }) {
  if (seg.op === "same") return <span className="text-slate-800 dark:text-slate-200">{seg.text}</span>;
  if (seg.op === "add") return (
    <span className="rounded bg-emerald-200/70 px-0.5 text-emerald-900 dark:bg-emerald-500/30 dark:text-emerald-100">
      {seg.text}
    </span>
  );
  return (
    <span className="rounded bg-red-200/70 px-0.5 text-red-900 line-through dark:bg-red-500/30 dark:text-red-100">
      {seg.text}
    </span>
  );
}

/** Render a name with optional diff highlighting vs the other name. */
function NameWithDiff({ name, diff, showDiff }: { name: string; diff: DiffSegment[]; showDiff: boolean }) {
  if (!name) return <span className="text-slate-300">—</span>;
  if (!showDiff || diff.length === 0) return <span>{name}</span>;
  return (
    <span className="leading-relaxed" dir="rtl">
      {diff.map((seg, i) => <DiffSegmentView key={i} seg={seg} />)}
    </span>
  );
}

export function ChartResultsTable({ rows, L1, L2 }: ChartResultsTableProps) {
  const [filter, setFilter] = React.useState<ChartFilter>("all");

  const counts = React.useMemo(() => {
    const c = { matched: 0, nameMatchNumDiff: 0, fundamental: 0, unmatched: 0 };
    for (const r of rows) {
      switch (r.st) {
        case "مطابق": c.matched++; break;
        case "مطابق الاسم مختلف الرقم": c.nameMatchNumDiff++; break;
        case "تغير جوهري": c.fundamental++; break;
        case "في الملف الأول فقط":
        case "في الملف الثاني فقط":
        case "غير مطابق": c.unmatched++; break;
      }
    }
    return c;
  }, [rows]);

  const filteredRows = React.useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "matched") return rows.filter((r) => r.st === "مطابق");
    if (filter === "nameMatchNumDiff") return rows.filter((r) => r.st === "مطابق الاسم مختلف الرقم");
    if (filter === "fundamental") return rows.filter((r) => r.st === "تغير جوهري");
    if (filter === "unmatched") return rows.filter((r) => r.st === "في الملف الأول فقط" || r.st === "في الملف الثاني فقط" || r.st === "غير مطابق");
    return rows;
  }, [rows, filter]);

  return (
    <div className="space-y-4">
      {/* Summary chips */}
      <div className="flex flex-wrap gap-2">
        <Chip label="مطابق الاسم والرقم" value={counts.matched} cls="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" />
        <Chip label="مطابق الاسم مختلف الرقم" value={counts.nameMatchNumDiff} cls="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" />
        <Chip label="غير المطابق" value={counts.unmatched} cls="bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300" />
        <Chip label="التغيرات الجوهرية" value={counts.fundamental} cls="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" />
      </div>

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => {
          const count =
            t.key === "all" ? rows.length :
            t.key === "matched" ? counts.matched :
            t.key === "nameMatchNumDiff" ? counts.nameMatchNumDiff :
            t.key === "fundamental" ? counts.fundamental :
            counts.unmatched;
          const isActive = filter === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setFilter(t.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-[11px] font-semibold transition-colors",
                isActive
                  ? cn(t.cls, "bg-slate-100 dark:bg-slate-800")
                  : "border-transparent text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/50"
              )}
            >
              <span>{t.label}</span>
              <span className={cn(
                "tnum rounded-full px-1.5 text-[10px]",
                isActive ? "bg-slate-200 dark:bg-slate-700" : "bg-slate-100 dark:bg-slate-800"
              )}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 scroll-thin">
        <Table className="text-[11px]">
          <TableHeader className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900">
            <TableRow className="border-slate-200 dark:border-slate-800">
              <TableHead className="w-[80px] text-center font-bold text-slate-700 dark:text-slate-200">رقم ({L1})</TableHead>
              <TableHead className="font-bold text-slate-600 dark:text-slate-300">اسم الحساب ({L1})</TableHead>
              <TableHead className="w-[80px] text-center font-bold text-slate-700 dark:text-slate-200">رقم ({L2})</TableHead>
              <TableHead className="font-bold text-slate-600 dark:text-slate-300">اسم الحساب ({L2})</TableHead>
              <TableHead className="w-[60px] text-center font-bold text-slate-600 dark:text-slate-300">التطابق</TableHead>
              <TableHead className="w-[90px] text-center font-bold text-slate-600 dark:text-slate-300">رصيد {L1}</TableHead>
              <TableHead className="w-[90px] text-center font-bold text-slate-600 dark:text-slate-300">رصيد {L2}</TableHead>
              <TableHead className="w-[90px] text-center font-bold text-slate-600 dark:text-slate-300">التغير</TableHead>
              <TableHead className="w-[80px] text-center font-bold text-slate-600 dark:text-slate-300">نسبة التغير</TableHead>
              <TableHead className="w-[140px] text-center font-bold text-slate-600 dark:text-slate-300">الحالة</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-slate-400">
                  لا توجد نتائج في هذا التصنيف
                </TableCell>
              </TableRow>
            )}
            {filteredRows.map((r, i) => {
              const a1 = r.a1, a2 = r.a2;
              const name1 = a1?.nm ?? "";
              const name2 = a2?.nm ?? "";
              const showDiff = !!a1 && !!a2 && r.sim != null && r.sim < 100;
              const diff = showDiff ? diffStrings(name1, name2) : [];
              return (
                <TableRow
                  key={i}
                  className={cn(
                    "border-slate-100 dark:border-slate-800/60",
                    r.st === "تغير جوهري" && "bg-red-50/40 dark:bg-red-950/10",
                    r.st === "مطابق الاسم مختلف الرقم" && "bg-amber-50/40 dark:bg-amber-950/10"
                  )}
                >
                  <TableCell className={cn(
                    "tnum text-center font-semibold",
                    r.numChanged ? "bg-amber-100/60 text-amber-900 dark:bg-amber-900/20 dark:text-amber-300" : "text-slate-700 dark:text-slate-300"
                  )} dir="ltr">
                    {a1?.num ?? <span className="text-slate-300">—</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <NameWithDiff name={name1} diff={diff} showDiff={showDiff} />
                  </TableCell>
                  <TableCell className={cn(
                    "tnum text-center font-semibold",
                    r.numChanged ? "bg-amber-100/60 text-amber-900 dark:bg-amber-900/20 dark:text-amber-300" : "text-slate-700 dark:text-slate-300"
                  )} dir="ltr">
                    {a2?.num ?? <span className="text-slate-300">—</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <NameWithDiff name={name2} diff={diff} showDiff={showDiff} />
                  </TableCell>
                  <TableCell className={cn("tnum text-center", simClass(r.sim))} dir="ltr">
                    {r.sim != null ? `${r.sim}%` : "—"}
                  </TableCell>
                  <TableCell className="tnum text-center text-slate-600 dark:text-slate-300" dir="ltr">
                    {fmtAmt(r.amt1)}
                  </TableCell>
                  <TableCell className="tnum text-center text-slate-600 dark:text-slate-300" dir="ltr">
                    {fmtAmt(r.amt2)}
                  </TableCell>
                  <TableCell className={cn("tnum text-center", changeClass(r.amtChange))} dir="ltr">
                    {fmtAmt(r.amtChange)}
                  </TableCell>
                  <TableCell className={cn("tnum text-center", changeClass(r.amtChangePct))} dir="ltr">
                    {fmtChangePct(r.amtChangePct)}
                  </TableCell>
                  <TableCell className="text-center">
                    <span className={cn(
                      "inline-block rounded-full px-2 py-0.5 text-[10px] font-bold whitespace-nowrap",
                      statusClass(r.st)
                    )}>
                      {r.st}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <p className="text-[11px] text-slate-500 dark:text-slate-400">
        التصنيفات: <strong>أصول</strong> (1) · <strong>خصوم</strong> (2) · <strong>مصروفات</strong> (3، 5، 6) · <strong>إيرادات</strong> (4، 7).
        التغير الجوهري = تغير تصنيف الحساب (مثل أصول → خصوم أو مصروفات → إيرادات).
        تمت المطابقة بالاسم (≥ 90%) أو برقم الحساب (تطابق تام) — الأولوية للاسم.
        الأرقام المظللة بالأصفر = تغيرت بين الدليلين.
        التغير: <span className="text-emerald-600 dark:text-emerald-400">أخضر = زيادة</span> · <span className="text-red-600 dark:text-red-400">أحمر = نقصان</span>.
        الصفوف المظللة بالأصفر = مطابق الاسم مختلف الرقم · المظللة بالأحمر = تغيرات جوهرية.
      </p>
    </div>
  );
}

function Chip({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold",
      cls
    )}>
      <span>{label}</span>
      <span className="tnum rounded-full bg-white/50 px-1.5 dark:bg-black/20">{value}</span>
    </span>
  );
}
