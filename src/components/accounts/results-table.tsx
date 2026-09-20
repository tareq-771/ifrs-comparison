"use client";

import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  type Categorized, type ChangeStatus, type CompareMode, type MatchedRow, type RowLeafInfo, type Totals,
  computeAvgCumulative, computeChangePct, computeChangeStatus, computeMonthAvgDiff, computeMonthAvgDiffPct, computeMonthRatio, computeMonthStatus, computeMonthToAvgRatio,
  fmtAmount, fmtPct, leafInfo, rowAmount,
} from "@/lib/accounts";

interface ResultsTableProps {
  cat: Categorized;
  T: Totals;
  L1: string;
  L2: string;
  netRow: MatchedRow | null;
  compareMode: CompareMode;
  numMonths: number;
}

type RenderRow =
  | { kind: "section"; label: string }
  | { kind: "data"; r: MatchedRow; info: RowLeafInfo; isRevenue: boolean }
  | { kind: "sub"; label: string; v1: number; v2: number; isRevenue: boolean }
  | { kind: "total"; label: string; v1: number; v2: number; isRevenue: boolean }
  | { kind: "memo"; label: string; v1: number | null; v2: number | null; ok: boolean };

export function ResultsTable({ cat, T, L1, L2, netRow, compareMode, numMonths }: ResultsTableProps) {
  const b1 = T.rev1;
  const b2 = T.rev2;
  const isMonthMode = compareMode === "monthCumulative";

  // Column labels depend on mode
  const col2Header = isMonthMode ? "الشهر الحالي" : L2;
  const col2Sub = isMonthMode ? "(الشهر)" : "(الحالية)";
  const col1Header = isMonthMode ? "التراكمي للسنة" : L1;
  const col1Sub = isMonthMode ? "(التراكمي)" : "(المقارنة)";

  const sectionData = (rows: MatchedRow[]): { r: MatchedRow; info: RowLeafInfo }[] => {
    const info = leafInfo(rows);
    return rows.map((r, i) => ({ r, info: info[i] }));
  };

  const rows: RenderRow[] = [];

  // Revenue
  rows.push({ kind: "section", label: "الإيرادات — Revenue" });
  for (const { r, info } of sectionData(cat.sales)) rows.push({ kind: "data", r, info, isRevenue: true });
  rows.push({ kind: "sub", label: "صافي الإيرادات (المبيعات − المردود)", v1: T.rev1, v2: T.rev2, isRevenue: true });

  // Cost of sales
  rows.push({ kind: "section", label: "تكلفة الإيرادات — Cost of Sales" });
  for (const { r, info } of sectionData(cat.cost)) rows.push({ kind: "data", r, info, isRevenue: false });
  rows.push({ kind: "sub", label: "صافي تكلفة الإيرادات", v1: T.cost1, v2: T.cost2, isRevenue: false });

  // Gross profit
  rows.push({ kind: "total", label: "مجمل الربح (الخسارة) — Gross Profit", v1: T.gross1, v2: T.gross2, isRevenue: true });

  // Operating expenses (function of expense)
  rows.push({ kind: "section", label: "مصاريف التشغيل — Operating Expenses" });

  rows.push({ kind: "section", label: "مصاريف البيع والتوزيع" });
  for (const { r, info } of sectionData(cat.sell)) rows.push({ kind: "data", r, info, isRevenue: false });
  rows.push({ kind: "sub", label: "إجمالي البيع والتوزيع", v1: T.sell1, v2: T.sell2, isRevenue: false });

  rows.push({ kind: "section", label: "المصاريف الإدارية والعمومية" });
  for (const { r, info } of sectionData(cat.adm)) rows.push({ kind: "data", r, info, isRevenue: false });
  rows.push({ kind: "sub", label: "إجمالي الإدارية والعمومية", v1: T.adm1, v2: T.adm2, isRevenue: false });

  rows.push({ kind: "section", label: "مصاريف تشغيلية أخرى" });
  for (const { r, info } of sectionData(cat.oth)) rows.push({ kind: "data", r, info, isRevenue: false });
  rows.push({ kind: "sub", label: "إجمالي التشغيلية الأخرى", v1: T.oth1, v2: T.oth2, isRevenue: false });

  rows.push({ kind: "sub", label: "إجمالي مصاريف التشغيل", v1: T.opex1, v2: T.opex2, isRevenue: false });
  rows.push({ kind: "total", label: "الربح (الخسارة) من العمليات التشغيلية — Operating Profit", v1: T.oper1, v2: T.oper2, isRevenue: true });

  // Other income
  if (cat.othRev.length) {
    rows.push({ kind: "section", label: "الدخل من مصادر أخرى — Other Income" });
    for (const { r, info } of sectionData(cat.othRev)) rows.push({ kind: "data", r, info, isRevenue: true });
    rows.push({ kind: "sub", label: "إجمالي الدخل من مصادر أخرى", v1: T.othRev1, v2: T.othRev2, isRevenue: true });
  }

  // Finance & tax
  if (cat.fin.length) {
    rows.push({ kind: "section", label: "تكاليف التمويل — Finance Costs" });
    for (const { r, info } of sectionData(cat.fin)) rows.push({ kind: "data", r, info, isRevenue: false });
    rows.push({ kind: "sub", label: "إجمالي تكاليف التمويل", v1: T.fin1, v2: T.fin2, isRevenue: false });
  }
  if (cat.fin.length || cat.tax.length) {
    rows.push({ kind: "sub", label: "الربح (الخسارة) قبل الضريبة", v1: T.pbt1, v2: T.pbt2, isRevenue: true });
  }
  if (cat.tax.length) {
    rows.push({ kind: "section", label: "ضريبة الدخل — Income Tax" });
    for (const { r, info } of sectionData(cat.tax)) rows.push({ kind: "data", r, info, isRevenue: false });
    rows.push({ kind: "sub", label: "إجمالي ضريبة الدخل", v1: T.tax1, v2: T.tax2, isRevenue: false });
  }

  // Net profit
  rows.push({ kind: "total", label: "صافي الربح (الخسارة) للفترة — Net Profit", v1: T.net1, v2: T.net2, isRevenue: true });

  // OCI
  if (cat.oci.length) {
    rows.push({ kind: "section", label: "الدخل الشامل الآخر — Other Comprehensive Income" });
    for (const { r, info } of sectionData(cat.oci)) rows.push({ kind: "data", r, info, isRevenue: true });
    rows.push({ kind: "sub", label: "إجمالي الدخل الشامل الآخر", v1: T.oci1, v2: T.oci2, isRevenue: true });
    rows.push({ kind: "total", label: "إجمالي الدخل الشامل للفترة — Total Comprehensive Income", v1: T.comp1, v2: T.comp2, isRevenue: true });
  }

  // Reconciliation
  if (netRow) {
    const n1 = netRow.a1 ? Math.round((netRow.a1.d - netRow.a1.m) * 100) / 100 : null;
    const n2 = netRow.a2 ? Math.round((netRow.a2.d - netRow.a2.m) * 100) / 100 : null;
    const ok = (n1 != null && Math.abs(n1 - T.net1) < 0.05) && (n2 != null && Math.abs(n2 - T.net2) < 0.05);
    rows.push({ kind: "memo", label: "التسوية: حساب صافي الدخل في دفتر الأستاذ", v1: n1, v2: n2, ok });
  }

  const pctOf = (v: number, base: number) => (base !== 0 ? v / base : null);

  const statusClass = (st: MatchedRow["st"]): string => {
    if (st === "مطابق") return "bg-emerald-50/60 dark:bg-emerald-950/20";
    if (st === "في الملف الأول فقط") return "bg-amber-50/60 dark:bg-amber-950/20";
    return "bg-orange-50/50 dark:bg-orange-950/20";
  };

  const changeStatusClass = (cs: ChangeStatus): string => {
    if (cs === "مرغوب نمو" || cs === "مرغوب وفرة") return "text-emerald-600 dark:text-emerald-400";
    if (cs === "غير مرغوب انخفاض" || cs === "غير مرغوب زيادة") return "text-rose-600 dark:text-rose-400";
    return "text-slate-400";
  };

  return (
    <div className="scroll-thin max-h-[65vh] overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <Table className="text-xs">
        <TableHeader className="sticky top-0 z-10">
          <TableRow className="border-slate-200 bg-slate-800 hover:bg-slate-800 dark:border-slate-700 dark:bg-slate-900">
            <TableHead className="h-9 w-12 text-center text-slate-50">رقم</TableHead>
            <TableHead className="h-9 text-slate-50">البند</TableHead>
            {isMonthMode ? (
              <>
                <TableHead className="h-9 text-center text-slate-50">{col2Header}<br /><span className="font-normal opacity-80">{col2Sub}</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">نسبة الشهر<br /><span className="font-normal opacity-80">من التراكمي</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">نسبة البند<br /><span className="font-normal opacity-80">لمبيعات الشهر</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">{col1Header}<br /><span className="font-normal opacity-80">{col1Sub}</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">% من<br /><span className="font-normal opacity-80">الإيرادات</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">المتوسط<br /><span className="font-normal opacity-80">للتراكمي</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">نسبة الشهر<br /><span className="font-normal opacity-80">من المتوسط</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">فرق الشهر<br /><span className="font-normal opacity-80">عن المتوسط</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">نسبة الفرق<br /><span className="font-normal opacity-80">عن المتوسط</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">حالة الشهر<br /><span className="font-normal opacity-80">مقابل المتوسط</span></TableHead>
              </>
            ) : (
              <>
                <TableHead className="h-9 text-center text-slate-50">{col2Header}<br /><span className="font-normal opacity-80">{col2Sub}</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">% من<br /><span className="font-normal opacity-80">الإيرادات</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">{col1Header}<br /><span className="font-normal opacity-80">{col1Sub}</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">% من<br /><span className="font-normal opacity-80">الإيرادات</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">التغير</TableHead>
                <TableHead className="h-9 text-center text-slate-50">نسبة<br /><span className="font-normal opacity-80">التغير</span></TableHead>
                <TableHead className="h-9 text-center text-slate-50">حالة<br /><span className="font-normal opacity-80">التغير</span></TableHead>
              </>
            )}
            <TableHead className="h-9 text-center text-slate-50">الحالة</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, idx) => {
            if (row.kind === "section") {
              const isMain = row.label.includes("—");
              return (
                <TableRow
                  key={`sec-${idx}`}
                  className={cn(
                    "border-slate-200 dark:border-slate-800",
                    isMain ? "bg-slate-100 dark:bg-slate-900/60" : "bg-slate-50 dark:bg-slate-900/30"
                  )}
                >
                  <TableCell colSpan={isMonthMode ? 13 : 10} className={cn("py-1.5", isMain ? "font-bold text-slate-800 dark:text-slate-100" : "font-semibold text-slate-600 dark:text-slate-300")}>
                    {row.label}
                  </TableCell>
                </TableRow>
              );
            }

            if (row.kind === "data") {
              const { r, info, isRevenue } = row;
              const a = r.a1 ?? r.a2!;
              const v1 = rowAmount(r, "a1", isRevenue);
              const v2 = rowAmount(r, "a2", isRevenue);
              const isParent = (r.a1 && !info.leaf1) || (r.a2 && !info.leaf2);

              if (isMonthMode) {
                // Month/cumulative mode columns (13 total):
                // رقم | البند | الشهر(v2) | نسبة الشهر من التراكمي(v2/v1) | نسبة البند لمبيعات الشهر(v2/b2) | التراكمي(v1) | % من الإيرادات(v1/b1) | المتوسط للتراكمي(v1/nm) | نسبة الشهر من المتوسط(v2/avg) | فرق الشهر عن المتوسط(v2-avg) | نسبة الفرق عن المتوسط((v2-avg)/avg) | حالة الشهر | الحالة
                const monthRatio = computeMonthRatio(v2, v1);
                const itemToMonthSales = b2 !== 0 && v2 != null ? v2 / b2 : null;
                const s1 = b1 !== 0 && v1 != null ? v1 / b1 : null;
                const avgCumulative = computeAvgCumulative(v1, numMonths);
                const monthToAvg = computeMonthToAvgRatio(v2, avgCumulative);
                const avgDiff = computeMonthAvgDiff(v2, avgCumulative);
                const avgDiffPct = computeMonthAvgDiffPct(v2, avgCumulative);
                const cs = computeMonthStatus(monthRatio, isRevenue, numMonths);
                return (
                  <TableRow
                    key={`d-${idx}`}
                    className={cn("border-slate-100 transition-colors dark:border-slate-800/60", statusClass(r.st), isParent && "font-bold")}
                  >
                    <TableCell className="text-center text-slate-500 dark:text-slate-400">{a.num ?? "—"}</TableCell>
                    <TableCell className={cn("text-slate-800 dark:text-slate-100", isParent && "font-bold")}>{a.nm}</TableCell>
                    <TableCell className={cn("tnum text-center", v2 != null && v2 < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-slate-200", isParent && "font-bold")}>{fmtAmount(v2)}</TableCell>
                    <TableCell className="tnum text-center font-semibold text-emerald-600 dark:text-emerald-400">{fmtPct(monthRatio)}</TableCell>
                    <TableCell className="tnum text-center text-slate-500 dark:text-slate-400">{fmtPct(itemToMonthSales)}</TableCell>
                    <TableCell className={cn("tnum text-center", v1 != null && v1 < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-slate-200", isParent && "font-bold")}>{fmtAmount(v1)}</TableCell>
                    <TableCell className="tnum text-center text-slate-500 dark:text-slate-400">{fmtPct(s1)}</TableCell>
                    <TableCell className="tnum text-center text-slate-600 dark:text-slate-300">{fmtAmount(avgCumulative)}</TableCell>
                    <TableCell className={cn("tnum text-center font-semibold", monthToAvg != null && monthToAvg > 1 ? "text-emerald-600 dark:text-emerald-400" : monthToAvg != null && monthToAvg < 1 ? "text-rose-600 dark:text-rose-400" : "text-slate-400")}>{fmtPct(monthToAvg)}</TableCell>
                    <TableCell className={cn("tnum text-center font-medium", avgDiff != null && avgDiff < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400")}>{fmtAmount(avgDiff)}</TableCell>
                    <TableCell className={cn("tnum text-center font-medium", avgDiffPct != null && avgDiffPct < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400")}>{fmtPct(avgDiffPct)}</TableCell>
                    <TableCell className={cn("text-center font-semibold", changeStatusClass(cs))}>{cs}</TableCell>
                    <TableCell className="text-center text-slate-500 dark:text-slate-400">{r.st}</TableCell>
                  </TableRow>
                );
              }

              // Period comparison mode (original)
              const s1 = b2 !== 0 && v2 != null ? v2 / b2 : null;
              const s2 = b1 !== 0 && v1 != null ? v1 / b1 : null;
              const chg = v1 != null && v2 != null ? Math.round((v2 - v1) * 100) / 100 : null;
              const cp = computeChangePct(chg, v1);
              const cs = computeChangeStatus(chg, isRevenue);
              return (
                <TableRow
                  key={`d-${idx}`}
                  className={cn("border-slate-100 transition-colors dark:border-slate-800/60", statusClass(r.st), isParent && "font-bold")}
                >
                  <TableCell className="text-center text-slate-500 dark:text-slate-400">{a.num ?? "—"}</TableCell>
                  <TableCell className={cn("text-slate-800 dark:text-slate-100", isParent && "font-bold")}>{a.nm}</TableCell>
                  <TableCell className={cn("tnum text-center", v2 != null && v2 < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-slate-200", isParent && "font-bold")}>{fmtAmount(v2)}</TableCell>
                  <TableCell className="tnum text-center text-slate-500 dark:text-slate-400">{fmtPct(s1)}</TableCell>
                  <TableCell className={cn("tnum text-center", v1 != null && v1 < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-slate-200", isParent && "font-bold")}>{fmtAmount(v1)}</TableCell>
                  <TableCell className="tnum text-center text-slate-500 dark:text-slate-400">{fmtPct(s2)}</TableCell>
                  <TableCell className={cn("tnum text-center font-medium", chg != null && chg < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-600 dark:text-slate-300")}>{fmtAmount(chg)}</TableCell>
                  <TableCell className="tnum text-center text-slate-500 dark:text-slate-400">{fmtPct(cp)}</TableCell>
                  <TableCell className={cn("text-center font-semibold", changeStatusClass(cs))}>{cs}</TableCell>
                  <TableCell className="text-center text-slate-500 dark:text-slate-400">{r.st}</TableCell>
                </TableRow>
              );
            }

            if (row.kind === "memo") {
              if (isMonthMode) {
                const monthRatio = computeMonthRatio(row.v2, row.v1);
                const itemToMonthSales = b2 !== 0 && row.v2 != null ? row.v2 / b2 : null;
                const s1 = b1 !== 0 && row.v1 != null ? row.v1 / b1 : null;
                const avgCumulative = computeAvgCumulative(row.v1, numMonths);
                const monthToAvg = computeMonthToAvgRatio(row.v2, avgCumulative);
                const avgDiff = computeMonthAvgDiff(row.v2, avgCumulative);
                const avgDiffPct = computeMonthAvgDiffPct(row.v2, avgCumulative);
                const cs = computeMonthStatus(monthRatio, true, numMonths);
                return (
                  <TableRow key={`memo-${idx}`} className="border-slate-200 bg-amber-50 dark:border-slate-800 dark:bg-amber-950/20">
                    <TableCell className="text-center text-slate-400">—</TableCell>
                    <TableCell className="font-bold text-slate-700 dark:text-slate-200">{row.label}</TableCell>
                    <TableCell className="tnum text-center font-bold text-slate-700 dark:text-slate-200">{fmtAmount(row.v2)}</TableCell>
                    <TableCell className="tnum text-center font-bold text-emerald-600 dark:text-emerald-400">{fmtPct(monthRatio)}</TableCell>
                    <TableCell className="tnum text-center text-slate-500 dark:text-slate-400">{fmtPct(itemToMonthSales)}</TableCell>
                    <TableCell className="tnum text-center font-bold text-slate-700 dark:text-slate-200">{fmtAmount(row.v1)}</TableCell>
                    <TableCell className="tnum text-center text-slate-500 dark:text-slate-400">{fmtPct(s1)}</TableCell>
                    <TableCell className="tnum text-center font-bold text-slate-600 dark:text-slate-300">{fmtAmount(avgCumulative)}</TableCell>
                    <TableCell className="tnum text-center font-bold text-slate-600 dark:text-slate-300">{fmtPct(monthToAvg)}</TableCell>
                    <TableCell className={cn("tnum text-center font-bold", avgDiff != null && avgDiff < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400")}>{fmtAmount(avgDiff)}</TableCell>
                    <TableCell className={cn("tnum text-center font-bold", avgDiffPct != null && avgDiffPct < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400")}>{fmtPct(avgDiffPct)}</TableCell>
                    <TableCell className={cn("text-center font-semibold", changeStatusClass(cs))}>{cs}</TableCell>
                    <TableCell className={cn("text-center font-bold", row.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>{row.ok ? "مطابق ✓" : "⚠ فرق"}</TableCell>
                  </TableRow>
                );
              }
              const chg = row.v1 != null && row.v2 != null ? Math.round((row.v2 - row.v1) * 100) / 100 : null;
              const cp = computeChangePct(chg, row.v1);
              const cs = computeChangeStatus(chg, true);
              return (
                <TableRow key={`memo-${idx}`} className="border-slate-200 bg-amber-50 dark:border-slate-800 dark:bg-amber-950/20">
                  <TableCell className="text-center text-slate-400">—</TableCell>
                  <TableCell className="font-bold text-slate-700 dark:text-slate-200">{row.label}</TableCell>
                  <TableCell className="tnum text-center font-bold text-slate-700 dark:text-slate-200">{fmtAmount(row.v2)}</TableCell>
                  <TableCell className="text-center text-slate-400">—</TableCell>
                  <TableCell className="tnum text-center font-bold text-slate-700 dark:text-slate-200">{fmtAmount(row.v1)}</TableCell>
                  <TableCell className="text-center text-slate-400">—</TableCell>
                  <TableCell className="tnum text-center font-bold text-slate-600 dark:text-slate-300">{fmtAmount(chg)}</TableCell>
                  <TableCell className="tnum text-center text-slate-500 dark:text-slate-400">{fmtPct(cp)}</TableCell>
                  <TableCell className={cn("text-center font-semibold", changeStatusClass(cs))}>{cs}</TableCell>
                  <TableCell className={cn("text-center font-bold", row.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400")}>{row.ok ? "مطابق ✓" : "⚠ فرق"}</TableCell>
                </TableRow>
              );
            }

            // sub or total
            const isTotal = row.kind === "total";
            const { v1, v2, label, isRevenue } = row;

            if (isMonthMode) {
              const monthRatio = computeMonthRatio(v2, v1);
              const itemToMonthSales = b2 !== 0 && v2 != null ? v2 / b2 : null;
              const s1 = pctOf(v1, b1);
              const avgCumulative = computeAvgCumulative(v1, numMonths);
              const monthToAvg = computeMonthToAvgRatio(v2, avgCumulative);
              const avgDiff = computeMonthAvgDiff(v2, avgCumulative);
              const avgDiffPct = computeMonthAvgDiffPct(v2, avgCumulative);
              const cs = computeMonthStatus(monthRatio, isRevenue, numMonths);
              const positive = v2 >= 0;
              return (
                <TableRow
                  key={`${row.kind}-${idx}`}
                  className={cn(
                    "border-slate-200 dark:border-slate-800",
                    isTotal
                      ? positive ? "bg-emerald-50 dark:bg-emerald-950/30" : "bg-rose-50 dark:bg-rose-950/30"
                      : "bg-slate-50 dark:bg-slate-900/40"
                  )}
                >
                  <TableCell className="text-center text-slate-400">—</TableCell>
                  <TableCell className={cn("text-slate-800 dark:text-slate-100", isTotal ? "text-sm font-extrabold" : "font-bold")}>{label}</TableCell>
                  <TableCell className={cn("tnum text-center", isTotal ? "text-sm font-extrabold" : "font-bold", v2 < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-slate-200")}>{fmtAmount(v2)}</TableCell>
                  <TableCell className="tnum text-center font-bold text-emerald-600 dark:text-emerald-400">{fmtPct(monthRatio)}</TableCell>
                  <TableCell className="tnum text-center text-slate-500 dark:text-slate-400">{fmtPct(itemToMonthSales)}</TableCell>
                  <TableCell className={cn("tnum text-center", isTotal ? "font-extrabold" : "font-bold", v1 < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-slate-200")}>{fmtAmount(v1)}</TableCell>
                  <TableCell className="tnum text-center text-slate-500 dark:text-slate-400">{fmtPct(s1)}</TableCell>
                  <TableCell className="tnum text-center font-bold text-slate-600 dark:text-slate-300">{fmtAmount(avgCumulative)}</TableCell>
                  <TableCell className={cn("tnum text-center font-bold", monthToAvg != null && monthToAvg > 1 ? "text-emerald-600 dark:text-emerald-400" : monthToAvg != null && monthToAvg < 1 ? "text-rose-600 dark:text-rose-400" : "text-slate-400")}>{fmtPct(monthToAvg)}</TableCell>
                  <TableCell className={cn("tnum text-center font-bold", avgDiff != null && avgDiff < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400")}>{fmtAmount(avgDiff)}</TableCell>
                  <TableCell className={cn("tnum text-center font-bold", avgDiffPct != null && avgDiffPct < 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400")}>{fmtPct(avgDiffPct)}</TableCell>
                  <TableCell className={cn("text-center font-semibold", changeStatusClass(cs))}>{cs}</TableCell>
                  <TableCell className="text-center text-slate-400">—</TableCell>
                </TableRow>
              );
            }

            // Period comparison mode (original)
            const s1 = pctOf(v1, b1);
            const s2 = pctOf(v2, b2);
            const chg = Math.round((v2 - v1) * 100) / 100;
            const cp = computeChangePct(chg, v1);
            const cs = computeChangeStatus(chg, isRevenue);
            const positive = v2 >= 0;
            return (
              <TableRow
                key={`${row.kind}-${idx}`}
                className={cn(
                  "border-slate-200 dark:border-slate-800",
                  isTotal
                    ? positive ? "bg-emerald-50 dark:bg-emerald-950/30" : "bg-rose-50 dark:bg-rose-950/30"
                    : "bg-slate-50 dark:bg-slate-900/40"
                )}
              >
                <TableCell className="text-center text-slate-400">—</TableCell>
                <TableCell className={cn("text-slate-800 dark:text-slate-100", isTotal ? "text-sm font-extrabold" : "font-bold")}>{label}</TableCell>
                <TableCell className={cn("tnum text-center", isTotal ? "text-sm font-extrabold" : "font-bold", v2 < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-slate-200")}>{fmtAmount(v2)}</TableCell>
                <TableCell className="tnum text-center text-slate-500 dark:text-slate-400">{fmtPct(s2)}</TableCell>
                <TableCell className={cn("tnum text-center", isTotal ? "font-extrabold" : "font-bold", v1 < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-700 dark:text-slate-200")}>{fmtAmount(v1)}</TableCell>
                <TableCell className="tnum text-center text-slate-500 dark:text-slate-400">{fmtPct(s1)}</TableCell>
                <TableCell className={cn("tnum text-center font-bold", chg < 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-600 dark:text-slate-300")}>{fmtAmount(chg)}</TableCell>
                <TableCell className="tnum text-center font-bold text-slate-600 dark:text-slate-300">{fmtPct(cp)}</TableCell>
                <TableCell className={cn("text-center font-semibold", changeStatusClass(cs))}>{cs}</TableCell>
                <TableCell className="text-center text-slate-400">—</TableCell>
              </TableRow>
            );
          })}
          {/* Footer note */}
          <TableRow className="border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/40">
            <TableCell colSpan={isMonthMode ? 13 : 10} className="py-2 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
              {isMonthMode ? (
                <>
                  قائمة الربح أو الخسارة{cat.oci.length ? " والدخل الشامل الآخر" : ""} وفق <b>IAS 1</b> —
                  مقارنة الشهر الحالي مع التراكمي ({numMonths} أشهر) · <b>نسبة الشهر من التراكمي</b> = قيمة الشهر ÷ القيمة التراكمية ·
                  <b> نسبة البند لمبيعات الشهر</b> = قيمة الشهر ÷ صافي مبيعات الشهر · <b>المتوسط للتراكمي</b> = التراكمي ÷ {numMonths} ·
                  <b> نسبة الشهر من المتوسط</b> = الشهر ÷ المتوسط (&gt;100% = فوق المتوسط) ·
                  <b> فرق الشهر عن المتوسط</b> = الشهر − المتوسط · <b>نسبة الفرق عن المتوسط</b> = (الشهر − المتوسط) ÷ المتوسط ·
                  <b>حالة الشهر</b>: مرغوب نمو (أخضر) = الشهر أعلى من المتوسط ({(100 / numMonths).toFixed(1)}%) · غير مرغوب انخفاض (أحمر) = العكس · الإجماليات من الأوراق فقط.
                </>
              ) : (
                <>
                  قائمة الربح أو الخسارة{cat.oci.length ? " والدخل الشامل الآخر" : ""} وفق <b>IAS 1</b> (طريقة الوظيفة) —
                  تُعرض الفترة الحالية ثم الفترة المقارنة · الخصومات (المردود) تُعرض سالبة بين قوسين ·
                  النسب من صافي إيرادات كل فترة · الإجماليات من الحسابات الفرعية (الأوراق) فقط ·
                  <b> حالة التغير</b>: مرغوب نمو (أخضر) = زيادة الإيراد أو وفرة في المصروف · غير مرغوب (أحمر) = انخفاض الإيراد أو زيادة المصروف.
                </>
              )}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
