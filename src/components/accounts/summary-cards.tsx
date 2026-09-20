"use client";

import { CheckCircle2, FilePlus, FileMinus, TrendingUp, PiggyBank, Wallet } from "lucide-react";
import { type CompareMode, type Totals, fmtAmount } from "@/lib/accounts";
import { cn } from "@/lib/utils";

interface SummaryCardsProps {
  counts: { matched: number; firstOnly: number; secondOnly: number };
  T: Totals;
  compareMode: CompareMode;
}

interface CardDef {
  icon: React.ReactNode;
  value: string;
  label: string;
  className: string;
  iconWrap: string;
}

export function SummaryCards({ counts, T, compareMode }: SummaryCardsProps) {
  const isMonthMode = compareMode === "monthCumulative";
  const cards: CardDef[] = [
    {
      icon: <CheckCircle2 className="size-5" />,
      value: String(counts.matched),
      label: "مطابق",
      className: "border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30",
      iconWrap: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300",
    },
    {
      icon: <FilePlus className="size-5" />,
      value: String(counts.firstOnly),
      label: isMonthMode ? "التراكمي فقط" : "المقارنة فقط",
      className: "border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30",
      iconWrap: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
    },
    {
      icon: <FileMinus className="size-5" />,
      value: String(counts.secondOnly),
      label: isMonthMode ? "الشهر فقط" : "الحالية فقط",
      className: "border-orange-200 bg-orange-50 dark:border-orange-900/60 dark:bg-orange-950/30",
      iconWrap: "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300",
    },
    {
      icon: <TrendingUp className="size-5" />,
      value: fmtAmount(T.gross2),
      label: isMonthMode ? "مجمل الربح (الشهر)" : "مجمل الربح",
      className: "border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30",
      iconWrap: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300",
    },
    {
      icon: <PiggyBank className="size-5" />,
      value: fmtAmount(isMonthMode ? T.net1 : T.oper2),
      label: isMonthMode ? "صافي الربح (التراكمي)" : "الربح التشغيلي",
      className: cn((isMonthMode ? T.net1 : T.oper2) >= 0 ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30" : "border-rose-200 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/30"),
      iconWrap: (isMonthMode ? T.net1 : T.oper2) >= 0 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300" : "bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300",
    },
    {
      icon: <Wallet className="size-5" />,
      value: fmtAmount(T.net2),
      label: isMonthMode ? "صافي الربح (الشهر)" : "صافي الربح للفترة",
      className: cn(T.net2 >= 0 ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30" : "border-rose-200 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/30"),
      iconWrap: T.net2 >= 0 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300" : "bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c, i) => (
        <div key={i} className={cn("flex items-center gap-3 rounded-xl border p-3 shadow-sm", c.className)}>
          <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", c.iconWrap)}>{c.icon}</div>
          <div className="min-w-0">
            <div className="tnum text-base font-extrabold leading-tight text-slate-800 dark:text-slate-100">{c.value}</div>
            <div className="truncate text-[10px] text-slate-500 dark:text-slate-400">{c.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
