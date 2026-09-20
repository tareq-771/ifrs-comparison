"use client";

/**
 * تقرير الرسوم البياني — طبقة العرض (View Layer)
 *
 * تقرير مالي ديناميكي: يختار المستخدم نوع التقرير ويتغير المحتوى فوراً
 * دون إعادة تحميل. كل البيانات تأتي من buildReportData (طبقة البيانات)
 * المشتقة حصراً من نتائج المطابقة الحقيقية.
 *
 * أنواع الرسوم المستخدمة: KPI Cards · Bar · Pie/Donut · Line · Area
 */

import * as React from "react";
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList,
  Line, LineChart, Pie, PieChart, XAxis, YAxis,
} from "recharts";
import {
  Activity, AlertOctagon, AlertTriangle, ArrowDownRight, ArrowUpRight,
  BarChart3, Calculator, CheckCircle2, Coins, Crown, Droplets, Gauge,
  Info, Landmark, Layers, LayoutGrid, Percent, PieChart as PieIcon,
  PiggyBank, RefreshCcw, Scale, ShieldCheck, Target, TrendingUp, Wallet, Zap,
} from "lucide-react";

import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  type BalanceSheetTotals, type Categorized, type MatchedRow, type RatioGroup,
  type Totals, computeChangePct, fmtAmount, fmtRatio, leafInfo, rowAmount,
} from "@/lib/accounts";
import {
  type ChartAlert, type KpiCardData, type KpiTone, type MoverItem,
  type ReportType, buildReportData,
} from "@/lib/chart-data";

interface ChartsViewProps {
  cat: Categorized;
  T: Totals;
  L1: string;
  L2: string;
  bs1: BalanceSheetTotals | null;
  bs2: BalanceSheetTotals | null;
  ratioGroups: RatioGroup[];
}

/* ── الألوان ────────────────────────────────────────────────────────── */

const C = {
  current: "#0d9488", // teal-600
  comparative: "#94a3b8", // slate-400
  positive: "#16a34a", // green-600
  negative: "#dc2626", // red-600
  revenue: "#0d9488",
  cost: "#dc2626",
  sell: "#f59e0b",
  admin: "#6366f1",
  other: "#8b5cf6",
  finance: "#ec4899",
  tax: "#f43f5e",
  amber: "#f59e0b",
  emerald: "#16a34a",
};

/** تنسيق مختصر لمحور القيم: 1.2م / 450ألف */
function fmtShort(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return (v / 1_000_000).toFixed(1) + "م";
  if (abs >= 1_000) return (v / 1_000).toFixed(0) + "ألف";
  return String(Math.round(v));
}

/* ── أنواع التقرير ──────────────────────────────────────────────────── */

const REPORT_TYPES: { value: ReportType; label: string; icon: React.ReactNode }[] = [
  { value: "pl", label: "قائمة الربح والخسارة", icon: <TrendingUp className="size-4" /> },
  { value: "bs", label: "قائمة المركز المالي", icon: <Landmark className="size-4" /> },
  { value: "fa", label: "التحليل المالي", icon: <Calculator className="size-4" /> },
  { value: "pl_bs", label: "قائمة الربح والخسارة + قائمة المركز المالي", icon: <Layers className="size-4" /> },
  { value: "all", label: "الكل", icon: <LayoutGrid className="size-4" /> },
];

/* ── أدوات عرض مشتركة ──────────────────────────────────────────────── */

const TONE_CARD: Record<KpiTone, { wrap: string; icon: string }> = {
  emerald: { wrap: "border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30", icon: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300" },
  rose: { wrap: "border-rose-200 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/30", icon: "bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300" },
  amber: { wrap: "border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30", icon: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300" },
  teal: { wrap: "border-teal-200 bg-teal-50 dark:border-teal-900/60 dark:bg-teal-950/30", icon: "bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300" },
  sky: { wrap: "border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/30", icon: "bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300" },
  violet: { wrap: "border-violet-200 bg-violet-50 dark:border-violet-900/60 dark:bg-violet-950/30", icon: "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300" },
};

const KPI_ICONS: Record<string, React.ReactNode> = {
  revenue: <Coins className="size-4" />,
  gross: <PiggyBank className="size-4" />,
  operating: <Activity className="size-4" />,
  net: <Wallet className="size-4" />,
  margin: <Percent className="size-4" />,
  assets: <Landmark className="size-4" />,
  liabilities: <Scale className="size-4" />,
  equity: <ShieldCheck className="size-4" />,
  wc: <Droplets className="size-4" />,
  ratio: <Gauge className="size-4" />,
  quick: <Zap className="size-4" />,
  roa: <Target className="size-4" />,
  roe: <Crown className="size-4" />,
  turnover: <RefreshCcw className="size-4" />,
  leverage: <Layers className="size-4" />,
};

function fmtKpi(v: number | null, format: "amount" | "ratio" | "percent"): string {
  if (format === "amount") return fmtAmount(v);
  if (format === "ratio") return v == null ? "—" : v.toFixed(2) + "×";
  return fmtRatio(v, "percent");
}

/** شارة التغير: نسبة مئوية أو نقاط مئوية أو فرق مضاعف. */
function DeltaChip({ delta, kind, positiveIsGood }: { delta: number | null; kind: "pct" | "pp" | "none"; positiveIsGood: boolean }) {
  if (delta == null) return null;
  const sign = delta > 0 ? "+" : "";
  const text =
    kind === "pct" ? `${sign}${(delta * 100).toFixed(1)}%`
    : kind === "pp" ? `${sign}${(delta * 100).toFixed(1)} ن.م`
    : `${sign}${delta.toFixed(2)}×`;
  const good = delta === 0 ? null : delta > 0 === positiveIsGood;
  return (
    <span
      className={cn(
        "tnum inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold",
        good === null
          ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
          : good
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
            : "bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300",
      )}
    >
      {delta > 0 ? <ArrowUpRight className="size-3" /> : delta < 0 ? <ArrowDownRight className="size-3" /> : null}
      {text}
    </span>
  );
}

/** بطاقة KPI */
function KpiCard({ item }: { item: KpiCardData }) {
  const tone = TONE_CARD[item.tone];
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border p-3 shadow-sm", tone.wrap)}>
      <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", tone.icon)}>
        {KPI_ICONS[item.icon] ?? <Gauge className="size-4" />}
      </div>
      <div className="min-w-0">
        <div className="tnum flex flex-wrap items-center gap-1 text-base font-extrabold leading-tight text-slate-800 dark:text-slate-100">
          {fmtKpi(item.value, item.format)}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[10px] text-slate-500 dark:text-slate-400">{item.label}</span>
          <DeltaChip delta={item.delta} kind={item.deltaKind} positiveIsGood={item.positiveIsGood} />
        </div>
      </div>
    </div>
  );
}

function KpiRow({ items }: { items: KpiCardData[] }) {
  if (items.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((k) => <KpiCard key={k.label} item={k} />)}
    </div>
  );
}

const ALERT_STYLES: Record<ChartAlert["severity"], { wrap: string; icon: React.ReactNode }> = {
  danger: { wrap: "border-rose-200 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/30", icon: <AlertOctagon className="size-4 shrink-0 text-rose-600 dark:text-rose-400" /> },
  warning: { wrap: "border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30", icon: <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" /> },
  info: { wrap: "border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/30", icon: <Info className="size-4 shrink-0 text-sky-600 dark:text-sky-400" /> },
  success: { wrap: "border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30", icon: <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" /> },
};

/** لوحة التنبيهات المرئية للتغيرات غير الاعتيادية */
function AlertsPanel({ alerts }: { alerts: ChartAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {alerts.map((a, i) => {
        const s = ALERT_STYLES[a.severity];
        return (
          <div key={i} className={cn("flex items-start gap-2.5 rounded-xl border p-3", s.wrap)}>
            {s.icon}
            <div className="min-w-0">
              <p className="text-xs font-bold text-slate-800 dark:text-slate-100">{a.title}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">{a.detail}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** بطاقة حالة فارغة */
function EmptyCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white/50 py-10 text-center dark:border-slate-700 dark:bg-slate-900/30">
      <div className="flex size-10 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
        <BarChart3 className="size-5" />
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</p>
        <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{detail}</p>
      </div>
    </div>
  );
}

/** عنوان قسم (يظهر في وضع «الكل») */
function SectionHeading({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 pb-2 dark:border-slate-800">
      <span className="flex size-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{icon}</span>
      <div>
        <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">{title}</h3>
        <p className="text-[11px] text-slate-400 dark:text-slate-500">{description}</p>
      </div>
    </div>
  );
}

/* ── استخراج أوراق الحسابات (قائمة الدخل) ───────────────────────────── */

interface LeafItem {
  num: string | null;
  name: string;
  v1: number | null;
  v2: number | null;
  chg: number | null;
  cp: number | null;
}

function leafItems(rows: MatchedRow[], isRevenue: boolean): LeafItem[] {
  const info = leafInfo(rows);
  const items: LeafItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    const { leaf1, leaf2 } = info[i];
    if (!leaf1 && !leaf2) continue;
    const r = rows[i];
    const a = r.a1 ?? r.a2!;
    const v1 = rowAmount(r, "a1", isRevenue);
    const v2 = rowAmount(r, "a2", isRevenue);
    const chg = v1 != null && v2 != null ? Math.round((v2 - v1) * 100) / 100 : null;
    const cp = computeChangePct(chg, v1);
    items.push({ num: a.num, name: a.nm, v1, v2, chg, cp });
  }
  items.sort((a, b) => Math.abs(b.v2 ?? 0) - Math.abs(a.v2 ?? 0));
  return items;
}

/* ══════════════════════════════════════════════════════════════════════
 * رسوم قائمة الربح والخسارة
 * ══════════════════════════════════════════════════════════════════════ */

/* ── 1. مقارنة المؤشرات الرئيسية (أعمدة مجمعة) ── */

function KeyMetricsChart({ T, L1, L2 }: { T: Totals; L1: string; L2: string }) {
  const data = [
    { metric: "الإيرادات", current: T.rev2, comparative: T.rev1 },
    { metric: "تكلفة الإيرادات", current: T.cost2, comparative: T.cost1 },
    { metric: "مجمل الربح", current: T.gross2, comparative: T.gross1 },
    { metric: "مصاريف التشغيل", current: T.opex2, comparative: T.opex1 },
    { metric: "الربح التشغيلي", current: T.oper2, comparative: T.oper1 },
    { metric: "الربح قبل الضريبة", current: T.pbt2, comparative: T.pbt1 },
    { metric: "ضريبة الدخل", current: T.tax2, comparative: T.tax1 },
    { metric: "صافي الربح", current: T.net2, comparative: T.net1 },
  ];
  if (T.comp2 !== T.net2) data.push({ metric: "الدخل الشامل", current: T.comp2, comparative: T.comp1 });

  const cfg: ChartConfig = {
    current: { label: L2 + " (الحالية)", color: C.current },
    comparative: { label: L1 + " (المقارنة)", color: C.comparative },
  };

  return (
    <Card className="border-slate-200 shadow-sm dark:border-slate-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-100">
          <BarChart3 className="size-4 text-emerald-600 dark:text-emerald-400" />
          مقارنة المؤشرات الرئيسية
        </CardTitle>
        <CardDescription>الفترة الحالية مقابل المقارنة</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={cfg} className="h-[320px] w-full">
          <BarChart data={data} margin={{ top: 10, right: 8, left: 8, bottom: 20 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="metric"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: "#64748b" }}
              interval={0}
              angle={-25}
              textAnchor="end"
              height={60}
            />
            <YAxis
              tickFormatter={fmtShort}
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickLine={false}
              axisLine={false}
              width={50}
            />
            <ChartTooltip
              content={<ChartTooltipContent formatter={(value) => fmtAmount(Number(value))} />}
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="comparative" fill={C.comparative} radius={[4, 4, 0, 0]} maxBarSize={28} />
            <Bar dataKey="current" fill={C.current} radius={[4, 4, 0, 0]} maxBarSize={28} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/* ── 2. توزيع المصروفات (دائري) ── */

function ExpenseBreakdownChart({ T }: { T: Totals }) {
  const data = [
    { name: "تكلفة الإيرادات", value: T.cost2, fill: C.cost },
    { name: "البيع والتوزيع", value: T.sell2, fill: C.sell },
    { name: "الإدارية والعمومية", value: T.adm2, fill: C.admin },
    { name: "تشغيلية أخرى", value: T.oth2, fill: C.other },
    { name: "تكاليف التمويل", value: T.fin2, fill: C.finance },
    { name: "ضريبة الدخل", value: T.tax2, fill: C.tax },
  ].filter((d) => d.value > 0);

  const cfg: ChartConfig = Object.fromEntries(
    data.map((d) => [d.name, { label: d.name, color: d.fill }])
  );

  if (data.length === 0) {
    return <EmptyCard title="لا توجد مصروفات في الفترة الحالية" detail="سيظهر توزيع المصروفات عند توفر بيانات المصروفات" />;
  }

  return (
    <Card className="border-slate-200 shadow-sm dark:border-slate-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-100">
          <PieIcon className="size-4 text-amber-500" />
          توزيع المصروفات
        </CardTitle>
        <CardDescription>حصة كل بند من إجمالي المصروفات (الفترة الحالية)</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={cfg} className="mx-auto h-[300px]">
          <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <ChartTooltip
              content={<ChartTooltipContent nameKey="name" formatter={(value) => fmtAmount(Number(value))} />}
            />
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}>
              {data.map((d) => (
                <Cell key={d.name} fill={d.fill} />
              ))}
            </Pie>
            <ChartLegend content={<ChartLegendContent nameKey="name" />} verticalAlign="bottom" />
          </PieChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/* ── 3. اتجاه الأداء عبر الفترتين (مساحات مكدسة + خطوط) ── */

function TrendChart({
  trend, L1, L2,
}: {
  trend: { period: string; revenue: number; cost: number; sell: number; adm: number; other: number; finance: number; tax: number; net: number }[];
  L1: string;
  L2: string;
}) {
  const data = trend.map((p) => ({
    ...p,
    period: p.period === "__CURRENT__" ? L2 : p.period || L1,
  }));

  const seriesDefs: { key: "cost" | "sell" | "adm" | "other" | "finance" | "tax"; label: string; color: string }[] = [
    { key: "cost", label: "تكلفة الإيرادات", color: C.cost },
    { key: "sell", label: "البيع والتوزيع", color: C.sell },
    { key: "adm", label: "الإدارية والعمومية", color: C.admin },
    { key: "other", label: "تشغيلية أخرى", color: C.other },
    { key: "finance", label: "تكاليف التمويل", color: C.finance },
    { key: "tax", label: "ضريبة الدخل", color: C.tax },
  ];
  // إخفاء السلاسل الصفرية تماماً (تجنب رسوم غير مفيدة)
  const active = seriesDefs.filter((s) => data.some((d) => d[s.key] !== 0));
  const hasRevenue = data.some((d) => d.revenue !== 0);
  const hasNet = data.some((d) => d.net !== 0);

  if (!hasRevenue && !hasNet && active.length === 0) {
    return <EmptyCard title="لا توجد بيانات كافية لعرض الاتجاه" detail="جميع قيم الفترتين أصفار" />;
  }

  const cfg: ChartConfig = Object.fromEntries([
    ...active.map((s) => [s.key, { label: s.label, color: s.color }]),
    ...(hasRevenue ? [["revenue", { label: "الإيرادات", color: C.revenue }]] : []),
    ...(hasNet ? [["net", { label: "صافي الربح", color: C.positive }]] : []),
  ]);

  return (
    <Card className="border-slate-200 shadow-sm dark:border-slate-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-100">
          <Activity className="size-4 text-teal-600 dark:text-teal-400" />
          اتجاه الأداء عبر الزمن
        </CardTitle>
        <CardDescription>تكوين المصروفات (مساحات مكدسة) مقابل الإيرادات وصافي الربح — {L1} ← {L2}</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={cfg} className="h-[340px] w-full">
          <ComposedChart data={data} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="period"
              reversed
              tick={{ fontSize: 11, fill: "#475569", fontWeight: 600 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tickFormatter={fmtShort}
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickLine={false}
              axisLine={false}
              width={50}
            />
            <ChartTooltip content={<ChartTooltipContent formatter={(value) => fmtAmount(Number(value))} />} />
            <ChartLegend content={<ChartLegendContent />} />
            {active.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stackId="expenses"
                stroke={s.color}
                fill={s.color}
                fillOpacity={0.45}
                strokeOpacity={0.8}
                strokeWidth={1}
              />
            ))}
            {hasRevenue && (
              <Line type="monotone" dataKey="revenue" stroke={C.revenue} strokeWidth={2.5} dot={{ r: 4 }} />
            )}
            {hasNet && (
              <Line type="monotone" dataKey="net" stroke={C.positive} strokeWidth={2.5} strokeDasharray="6 3" dot={{ r: 4 }} />
            )}
          </ComposedChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/* ── 4. تفصيل البنود (أعمدة أفقية) ── */

function BreakdownBarChart({
  title, icon, items, L1, L2,
}: {
  title: string;
  icon: React.ReactNode;
  items: LeafItem[];
  L1: string;
  L2: string;
}) {
  const cfg: ChartConfig = {
    current: { label: L2, color: C.current },
    comparative: { label: L1, color: C.comparative },
  };

  if (items.length === 0) {
    return <EmptyCard title="لا توجد بنود تفصيلية" detail="لم تُطابق أي حسابات فرعية ضمن هذا البند" />;
  }

  const data = items.slice(0, 12).map((it) => ({
    name: (it.num ?? "") + " " + it.name,
    short: it.name.length > 18 ? it.name.slice(0, 18) + "…" : it.name,
    current: it.v2 ?? 0,
    comparative: it.v1 ?? 0,
  })).reverse();

  return (
    <Card className="border-slate-200 shadow-sm dark:border-slate-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-100">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>أكبر البنود قيمةً — مقارنة الفترتين</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={cfg} className="h-[320px] w-full">
          <BarChart layout="vertical" data={data} margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              type="number"
              tickFormatter={(v) => Math.abs(Number(v)) >= 1000 ? (Number(v) / 1000).toFixed(0) + "K" : String(v)}
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              type="category"
              dataKey="short"
              tick={{ fontSize: 10, fill: "#475569" }}
              tickLine={false}
              axisLine={false}
              width={120}
            />
            <ChartTooltip
              content={<ChartTooltipContent formatter={(value) => fmtAmount(Number(value))} />}
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="comparative" fill={C.comparative} radius={[0, 4, 4, 0]} maxBarSize={16} />
            <Bar dataKey="current" fill={C.current} radius={[0, 4, 4, 0]} maxBarSize={16} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/* ── 5. ترتيب التغيرات (أعمدة ملونة) ── */

function ChangeRankingChart({ cat }: { cat: Categorized }) {
  const all: { name: string; short: string; cp: number; isRevenue: boolean }[] = [];
  const collect = (rows: MatchedRow[], isRevenue: boolean) => {
    for (const it of leafItems(rows, isRevenue)) {
      if (it.cp != null && it.v1 != null && it.v1 !== 0) {
        all.push({
          name: it.name,
          short: it.name.length > 22 ? it.name.slice(0, 22) + "…" : it.name,
          cp: it.cp,
          isRevenue,
        });
      }
    }
  };
  collect(cat.sales, true);
  collect(cat.cost, false);
  collect(cat.sell, false);
  collect(cat.adm, false);
  collect(cat.oth, false);
  collect(cat.fin, false);
  collect(cat.othRev, true);

  if (all.length === 0) {
    return <EmptyCard title="لا توجد تغيرات قابلة للقياس" detail="تظهر نسب التغير عند توفر قيم للفترتين" />;
  }

  all.sort((a, b) => Math.abs(b.cp) - Math.abs(a.cp));
  const data = all.slice(0, 15).reverse().map((it) => ({
    name: it.short,
    cp: Math.round(it.cp * 1000) / 10,
    fill: it.cp > 0
      ? (it.isRevenue ? C.positive : C.negative)
      : (it.isRevenue ? C.negative : C.positive),
  }));

  const cfg: ChartConfig = {
    cp: { label: "نسبة التغير %", color: C.current },
  };

  return (
    <Card className="border-slate-200 shadow-sm dark:border-slate-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-100">
          <Layers className="size-4 text-violet-500" />
          أكثر الحسابات تغيراً — أعلى ١٥ حسابًا
        </CardTitle>
        <CardDescription>القيمة ونسبة التغير معاً — أخضر = مرغوب · أحمر = غير مرغوب</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={cfg} className="h-[360px] w-full">
          <BarChart layout="vertical" data={data} margin={{ top: 0, right: 32, left: 8, bottom: 0 }}>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              type="number"
              tickFormatter={(v) => v + "%"}
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 10, fill: "#475569" }}
              tickLine={false}
              axisLine={false}
              width={130}
            />
            <ChartTooltip
              content={<ChartTooltipContent formatter={(value) => Number(value).toFixed(1) + "%"} />}
            />
            <Bar dataKey="cp" radius={[0, 4, 4, 0]} maxBarSize={18}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.fill} />
              ))}
              <LabelList
                dataKey="cp"
                position="right"
                formatter={(v: number) => (v > 0 ? "+" : "") + v.toFixed(1) + "%"}
                style={{ fontSize: 9, fill: "#475569" }}
              />
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/* ── 6. أفضل وأسوأ العناصر ── */

function MoversPanel({ movers }: { movers: MoverItem[] }) {
  const best = movers
    .filter((m) => m.favorable === true)
    .sort((a, b) => (b.cp ?? Math.abs(b.chg)) - (a.cp ?? Math.abs(a.chg)))
    .slice(0, 5);
  const worst = movers
    .filter((m) => m.favorable === false)
    .sort((a, b) => Math.abs(b.cp ?? b.chg) - Math.abs(a.cp ?? a.chg))
    .slice(0, 5);

  if (best.length === 0 && worst.length === 0) return null;

  const Row = ({ m, good }: { m: MoverItem; good: boolean }) => (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 bg-white px-2.5 py-2 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold text-slate-700 dark:text-slate-200">
          {m.num ? <span className="tnum me-1 text-[10px] text-slate-400">{m.num}</span> : null}
          {m.name}
        </p>
        <p className="tnum text-[10px] text-slate-400 dark:text-slate-500">
          {fmtAmount(m.v1)} ← {fmtAmount(m.v2)}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className={cn(
          "tnum text-[11px] font-bold",
          good ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
        )}>
          {m.chg > 0 ? "+" : ""}{m.chg.toLocaleString("en-US")}
        </span>
        <span className={cn(
          "tnum rounded-full px-1.5 text-[10px] font-bold",
          good
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
            : "bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300",
        )}>
          {m.cp != null ? `${m.cp > 0 ? "+" : ""}${(m.cp * 100).toFixed(1)}%` : "—"}
        </span>
      </div>
    </div>
  );

  return (
    <Card className="border-slate-200 shadow-sm dark:border-slate-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-100">
          <Target className="size-4 text-emerald-600 dark:text-emerald-400" />
          أفضل وأسوأ العناصر من حيث التغير
        </CardTitle>
        <CardDescription>أعلى ٥ بنود مرغوبة و٥ غير مرغوبة حسب نسبة التغير</CardDescription>
      </CardHeader>
      <CardContent className="grid max-h-96 gap-4 overflow-y-auto pe-1 sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className="flex items-center gap-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-400">
            <ArrowUpRight className="size-3.5" /> أفضل العناصر (مرغوب)
          </p>
          {best.length === 0
            ? <p className="py-4 text-center text-[11px] text-slate-400">لا توجد بنود مرغوبة</p>
            : best.map((m, i) => <Row key={"b" + i} m={m} good />)}
        </div>
        <div className="space-y-1.5">
          <p className="flex items-center gap-1 text-[11px] font-bold text-rose-700 dark:text-rose-400">
            <ArrowDownRight className="size-3.5" /> أسوأ العناصر (غير مرغوب)
          </p>
          {worst.length === 0
            ? <p className="py-4 text-center text-[11px] text-slate-400">لا توجد بنود غير مرغوبة</p>
            : worst.map((m, i) => <Row key={"w" + i} m={m} good={false} />)}
        </div>
      </CardContent>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * رسوم قائمة المركز المالي
 * ══════════════════════════════════════════════════════════════════════ */

function DonutChart({
  title, icon, description, data, extraKey, extraLabel,
}: {
  title: string;
  icon: React.ReactNode;
  description: string;
  data: { name: string; value: number }[];
  extraKey?: string;
  extraLabel?: string;
}) {
  if (data.length === 0) {
    return <EmptyCard title="لا توجد بيانات لهذا الهيكل" detail="تحقق من بادئات التصنيف في إعدادات المركز المالي" />;
  }

  const cfg: ChartConfig = Object.fromEntries(
    data.map((d, i) => [d.name, { label: d.name, color: ["#0d9488", "#94a3b8", "#16a34a", "#f59e0b", "#dc2626"][i % 5] }])
  );

  return (
    <Card className="border-slate-200 shadow-sm dark:border-slate-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-100">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={cfg} className="mx-auto h-[300px]">
          <PieChart margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <ChartTooltip
              content={<ChartTooltipContent
                nameKey="name"
                formatter={(value) => {
                  const total = data.reduce((s, d) => s + d.value, 0);
                  const pct = total !== 0 ? ` — ${((Number(value) / total) * 100).toFixed(1)}%` : "";
                  return fmtAmount(Number(value)) + pct;
                }}
              />}
            />
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={55}
              outerRadius={95}
              paddingAngle={2}
            >
              {data.map((d, i) => (
                <Cell key={d.name} fill={["#0d9488", "#94a3b8", "#16a34a", "#f59e0b", "#dc2626"][i % 5]} />
              ))}
            </Pie>
            <ChartLegend content={<ChartLegendContent nameKey="name" />} verticalAlign="bottom" />
          </PieChart>
        </ChartContainer>
        {extraKey != null && (
          <p className="mt-1 text-center text-[11px] text-slate-500 dark:text-slate-400">
            {extraLabel}: <span className="tnum font-bold">{fmtAmount(Number(extraKey))}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** أعمدة مجمعة رأسية لمقارنة مكونات المركز المالي */
function BSComparisonChart({
  data, L1, L2, title, description, icon,
}: {
  data: { metric: string; v1: number | null; v2: number | null }[];
  L1: string;
  L2: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}) {
  if (data.length === 0) {
    return <EmptyCard title="لا توجد بيانات للمقارنة" detail="تحقق من بادئات التصنيف وملفات المركز المالي" />;
  }

  const chartData = data.map((d) => ({ metric: d.metric, current: d.v2 ?? 0, comparative: d.v1 ?? 0 }));
  const cfg: ChartConfig = {
    current: { label: L2 + " (الحالية)", color: C.current },
    comparative: { label: L1 + " (المقارنة)", color: C.comparative },
  };

  return (
    <Card className="border-slate-200 shadow-sm dark:border-slate-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-100">
          {icon}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={cfg} className="h-[340px] w-full">
          <BarChart data={chartData} margin={{ top: 10, right: 8, left: 8, bottom: 20 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="metric"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 10, fill: "#64748b" }}
              interval={0}
              angle={-20}
              textAnchor="end"
              height={56}
            />
            <YAxis
              tickFormatter={fmtShort}
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickLine={false}
              axisLine={false}
              width={50}
            />
            <ChartTooltip content={<ChartTooltipContent formatter={(value) => fmtAmount(Number(value))} />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="comparative" fill={C.comparative} radius={[4, 4, 0, 0]} maxBarSize={30} />
            <Bar dataKey="current" fill={C.current} radius={[4, 4, 0, 0]} maxBarSize={30} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * رسوم التحليل المالي
 * ══════════════════════════════════════════════════════════════════════ */

/** اتجاهات الهوامش عبر الفترتين (خطوط) */
function MarginsTrendChart({
  margins, L1, L2,
}: {
  margins: { name: string; v1: number | null; v2: number | null }[];
  L1: string;
  L2: string;
}) {
  const defs = [
    { key: "gross", label: "هامش مجمل الربح", color: C.revenue, v1: margins[0]?.v1, v2: margins[0]?.v2 },
    { key: "oper", label: "هامش الربح التشغيلي", color: C.amber, v1: margins[1]?.v1, v2: margins[1]?.v2 },
    { key: "net", label: "هامش صافي الربح", color: C.emerald, v1: margins[2]?.v1, v2: margins[2]?.v2 },
  ];
  const active = defs.filter((d) => d.v1 != null || d.v2 != null);

  if (active.length === 0) {
    return <EmptyCard title="الهوامش غير متاحة" detail="تُحسب الهوامش من الإيرادات — تحقق من وجود إيرادات غير صفرية" />;
  }

  const data = [
    { period: L1, ...Object.fromEntries(active.map((d) => [d.key, (d.v1 ?? 0) * 100])) },
    { period: L2, ...Object.fromEntries(active.map((d) => [d.key, (d.v2 ?? 0) * 100])) },
  ];

  const cfg: ChartConfig = Object.fromEntries(active.map((d) => [d.key, { label: d.label, color: d.color }]));

  return (
    <Card className="border-slate-200 shadow-sm dark:border-slate-800">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-100">
          <Activity className="size-4 text-emerald-600 dark:text-emerald-400" />
          اتجاهات هوامش الربحية
        </CardTitle>
        <CardDescription>نسب الهوامش من الإيرادات — {L1} (يمين) ← {L2} (يسار)</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={cfg} className="h-[300px] w-full">
          <LineChart data={data} margin={{ top: 10, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              dataKey="period"
              reversed
              tick={{ fontSize: 11, fill: "#475569", fontWeight: 600 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tickFormatter={(v) => Number(v).toFixed(0) + "%"}
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickLine={false}
              axisLine={false}
              width={50}
            />
            <ChartTooltip
              content={<ChartTooltipContent formatter={(value) => Number(value).toFixed(1) + "%"} />}
            />
            <ChartLegend content={<ChartLegendContent />} />
            {active.map((d) => (
              <Line
                key={d.key}
                type="monotone"
                dataKey={d.key}
                stroke={d.color}
                strokeWidth={2.5}
                dot={{ r: 4 }}
              />
            ))}
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/** مجموعة نسب كأعمدة أفقية مجمعة (فترتين) */
function RatioGroupChart({
  title, items, unit, L1, L2,
}: {
  title: string;
  items: { name: string; v1: number | null; v2: number | null; benchmark: string | null }[];
  unit: "ratio" | "percent" | "amount" | "days";
  L1: string;
  L2: string;
}) {
  // تحويل القيم المئوية (كسور) إلى مقياس 0-100 للعرض
  const scale = (v: number | null) => (unit === "percent" ? (v ?? 0) * 100 : v ?? 0);
  const fmtVal = (v: number | null): string => {
    if (v == null) return "—";
    if (unit === "percent") return (v * 100).toFixed(1) + "%";
    if (unit === "days") return v.toFixed(0) + " يوم";
    if (unit === "amount") return fmtAmount(v);
    return v.toFixed(2) + "×";
  };

  const data = items.map((it) => ({
    name: it.name,
    short: it.name.length > 20 ? it.name.slice(0, 20) + "…" : it.name,
    current: scale(it.v2),
    comparative: scale(it.v1),
  }));

  const cfg: ChartConfig = {
    current: { label: L2, color: C.current },
    comparative: { label: L1, color: C.comparative },
  };

  const height = 56 + items.length * 44;

  return (
    <Card className="border-slate-200 shadow-sm dark:border-slate-800">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-slate-800 dark:text-slate-100">{title}</CardTitle>
        <CardDescription>
          {L1} مقابل {L2} · {unit === "percent" ? "بالنسبة المئوية" : unit === "days" ? "بالأيام" : unit === "amount" ? "بالمبلغ" : "بالمضاعفات"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={cfg} className="w-full" style={{ height }}>
          <BarChart layout="vertical" data={data} margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              type="number"
              tickFormatter={(v) => (unit === "percent" ? Number(v).toFixed(0) + "%" : String(Math.round(Number(v))))}
              tick={{ fontSize: 10, fill: "#64748b" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              type="category"
              dataKey="short"
              tick={{ fontSize: 10, fill: "#475569" }}
              tickLine={false}
              axisLine={false}
              width={150}
            />
            <ChartTooltip content={<ChartTooltipContent formatter={(value) => fmtVal(Number(value) / (unit === "percent" ? 100 : 1))} />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="comparative" fill={C.comparative} radius={[0, 4, 4, 0]} maxBarSize={14} />
            <Bar dataKey="current" fill={C.current} radius={[0, 4, 4, 0]} maxBarSize={14} />
          </BarChart>
        </ChartContainer>
        {/* المعايير المرجعية */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {items.filter((it) => it.benchmark).map((it) => (
            <span key={it.name} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {it.name}: <span className="tnum font-semibold">{it.benchmark}</span>
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * التحليل المتكامل (قائمة الدخل + المركز المالي)
 * ══════════════════════════════════════════════════════════════════════ */

function DupontSection({
  dupont, L1, L2,
}: {
  dupont: { name: string; nameEn: string; v1: number | null; v2: number | null; format: "percent" | "ratio" }[];
  L1: string;
  L2: string;
}) {
  const fmt = (v: number | null, f: "percent" | "ratio") =>
    f === "percent" ? (v == null ? "—" : (v * 100).toFixed(1) + "%") : (v == null ? "—" : v.toFixed(2) + "×");

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {dupont.map((d) => {
        const cfg: ChartConfig = { value: { label: d.name, color: C.current } };
        const data = [
          { name: L1, value: d.format === "percent" ? (d.v1 ?? 0) * 100 : d.v1 ?? 0 },
          { name: L2, value: d.format === "percent" ? (d.v2 ?? 0) * 100 : d.v2 ?? 0 },
        ];
        return (
          <Card key={d.nameEn} className="border-slate-200 shadow-sm dark:border-slate-800">
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-bold text-slate-700 dark:text-slate-200">{d.name}</CardTitle>
              <CardDescription className="text-[10px]">
                {L1}: <span className="tnum">{fmt(d.v1, d.format)}</span> ← {L2}: <span className="tnum font-bold text-slate-700 dark:text-slate-200">{fmt(d.v2, d.format)}</span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer config={cfg} className="h-[80px] w-full">
                <BarChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: "#64748b" }} tickLine={false} axisLine={false} />
                  <YAxis hide domain={[0, "auto"]} />
                  <ChartTooltip
                    content={<ChartTooltipContent
                      formatter={(value) => d.format === "percent" ? Number(value).toFixed(1) + "%" : Number(value).toFixed(2) + "×"}
                    />}
                  />
                  <Bar dataKey="value" fill={C.current} radius={[4, 4, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * التقرير الرئيسي
 * ══════════════════════════════════════════════════════════════════════ */

export function ChartsView({ cat, T, L1, L2, bs1, bs2, ratioGroups }: ChartsViewProps) {
  const [type, setType] = React.useState<ReportType>("pl");

  const data = React.useMemo(
    () => buildReportData({ T, cat, L1, L2, bs1, bs2, ratioGroups }),
    [T, cat, L1, L2, bs1, bs2, ratioGroups],
  );

  const salesLeaves = React.useMemo(() => leafItems(cat.sales, true), [cat.sales]);
  const costLeaves = React.useMemo(() => leafItems(cat.cost, false), [cat.cost]);
  const expLeaves = React.useMemo(
    () => [...leafItems(cat.sell, false), ...leafItems(cat.adm, false), ...leafItems(cat.oth, false)]
      .sort((a, b) => Math.abs(b.v2 ?? 0) - Math.abs(a.v2 ?? 0)),
    [cat.sell, cat.adm, cat.oth],
  );

  const showPL = type === "pl" || type === "all";
  const showBS = type === "bs" || type === "all";
  const showFA = type === "fa" || type === "all";
  const showCombined = type === "pl_bs" || type === "all";
  const isAll = type === "all";

  const faGroups = data.fa.groups.filter((g) => g.items.length > 0);

  const typeMeta = REPORT_TYPES.find((t) => t.value === type)!;

  return (
    <div className="space-y-4">
      {/* ── رأس التقرير: محدد نوع التقرير ── */}
      <Card className="border-slate-200 shadow-sm dark:border-slate-800">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-slate-100">
              <BarChart3 className="size-4 text-emerald-600 dark:text-emerald-400" />
              تقرير الرسوم البياني
              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">ديناميكي</span>
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
              {L1} ← {L2} · يتغير المحتوى فوراً حسب نوع التقرير
            </p>
          </div>
          <div className="w-full sm:w-auto sm:min-w-72">
            <Select value={type} onValueChange={(v) => setType(v as ReportType)}>
              <SelectTrigger aria-label="نوع التقرير" className="w-full bg-white dark:bg-slate-900">
                <span className="flex items-center gap-2 text-sm">
                  {typeMeta.icon}
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                {REPORT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    <span className="flex items-center gap-2">
                      {t.icon}
                      {t.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* ═══ قسم قائمة الربح والخسارة ═══ */}
      {showPL && (
        <div className="space-y-4">
          {isAll && (
            <SectionHeading
              icon={<TrendingUp className="size-4" />}
              title="قائمة الربح والخسارة"
              description="الإيرادات والمصروفات وصافي الربح وهوامش الربحية"
            />
          )}
          <KpiRow items={data.pl.kpis} />
          <AlertsPanel alerts={data.pl.alerts} />
          <TrendChart trend={data.pl.trend} L1={L1} L2={L2} />
          <KeyMetricsChart T={T} L1={L1} L2={L2} />
          <div className="grid gap-4 lg:grid-cols-2">
            <ExpenseBreakdownChart T={T} />
            <MoversPanel movers={data.pl.movers} />
          </div>
          <ChangeRankingChart cat={cat} />
          <BreakdownBarChart
            title="تفصيل الإيرادات"
            icon={<TrendingUp className="size-4 text-emerald-600 dark:text-emerald-400" />}
            items={salesLeaves}
            L1={L1}
            L2={L2}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <BreakdownBarChart
              title="تفصيل تكلفة الإيرادات"
              icon={<BarChart3 className="size-4 text-rose-500" />}
              items={costLeaves}
              L1={L1}
              L2={L2}
            />
            <BreakdownBarChart
              title="تفصيل المصروفات التشغيلية"
              icon={<BarChart3 className="size-4 text-amber-500" />}
              items={expLeaves}
              L1={L1}
              L2={L2}
            />
          </div>
        </div>
      )}

      {/* ═══ قسم قائمة المركز المالي ═══ */}
      {showBS && (
        <div className="space-y-4">
          {isAll && (
            <SectionHeading
              icon={<Landmark className="size-4" />}
              title="قائمة المركز المالي"
              description="الأصول والالتزامات وحقوق الملكية"
            />
          )}
          {!data.bs.available ? (
            <EmptyCard
              title={data.bs.alerts[0]?.title ?? "قائمة المركز المالي غير متاحة"}
              detail={data.bs.alerts[0]?.detail ?? "ارفع ملف قائمة المركز المالي ثم أعد المطابقة"}
            />
          ) : (
            <>
              <KpiRow items={data.bs.kpis} />
              <AlertsPanel alerts={data.bs.alerts} />
              <div className="grid gap-4 lg:grid-cols-2">
                <DonutChart
                  title="هيكل الأصول"
                  icon={<Landmark className="size-4 text-teal-600 dark:text-teal-400" />}
                  description="توزيع الأصول متداولة/غير متداولة (الفترة الحالية)"
                  data={data.bs.assetStructure}
                />
                <DonutChart
                  title="هيكل التمويل"
                  icon={<Scale className="size-4 text-amber-500" />}
                  description="مصادر التمويل: خصوم وحقوق ملكية (الفترة الحالية)"
                  data={data.bs.financingStructure}
                />
              </div>
              <BSComparisonChart
                data={data.bs.comparison}
                L1={L1}
                L2={L2}
                title="مقارنة مكونات المركز المالي"
                description="الفترة الحالية مقابل المقارنة"
                icon={<BarChart3 className="size-4 text-emerald-600 dark:text-emerald-400" />}
              />
              {data.bs.details.length > 0 && (
                <BSComparisonChart
                  data={data.bs.details}
                  L1={L1}
                  L2={L2}
                  title="العناصر التفصيلية"
                  description="المخزون والنقدية والمدينون والدائنون والقروض"
                  icon={<Layers className="size-4 text-violet-500" />}
                />
              )}
            </>
          )}
        </div>
      )}

      {/* ═══ قسم التحليل المالي ═══ */}
      {showFA && (
        <div className="space-y-4">
          {isAll && (
            <SectionHeading
              icon={<Calculator className="size-4" />}
              title="التحليل المالي"
              description="السيولة والمديونية والربحية والكفاءة"
            />
          )}
          <KpiRow items={data.fa.kpis} />
          <AlertsPanel alerts={data.fa.alerts} />
          <MarginsTrendChart margins={data.fa.margins} L1={L1} L2={L2} />
          {faGroups.length === 0 ? (
            <EmptyCard
              title="النسب المالية غير محسوبة"
              detail="نسب السيولة والمديونية والكفاءة تتطلب بيانات قائمة المركز المالي — ارفع الملف ثم أعد المطابقة"
            />
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {faGroups.map((g) => (
                <RatioGroupChart key={g.titleEn} title={g.title} items={g.items} unit={g.unit} L1={L1} L2={L2} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══ قسم التحليل المتكامل ═══ */}
      {showCombined && (
        <div className="space-y-4">
          {isAll && (
            <SectionHeading
              icon={<Layers className="size-4" />}
              title="التحليل المتكامل"
              description="قائمة الربح والخسارة + قائمة المركز المالي"
            />
          )}
          {!data.combined.available ? (
            <EmptyCard
              title="التحليل المتكامل غير متاح"
              detail="يتطلب هذا القسم ملف قائمة المركز المالي — ارفعه ثم أعد المطابقة لعرض العلاقة بين القائمتين"
            />
          ) : (
            <>
              <KpiRow items={data.combined.kpis} />
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-600 dark:text-slate-300">تحليل دوپونت — مكونات العائد على حقوق الملكية</h4>
                  <span className="text-[10px] text-slate-400">ROE = الهامش × الدوران × المضاعف</span>
                </div>
                <DupontSection dupont={data.combined.dupont} L1={L1} L2={L2} />
              </div>
              <BSComparisonChart
                data={data.combined.cross}
                L1={L1}
                L2={L2}
                title="مؤشرات متقاطعة من القائمتين"
                description="الإيرادات مقابل الأصول · صافي الربح مقابل حقوق الملكية · رأس المال العامل"
                icon={<Layers className="size-4 text-sky-600 dark:text-sky-400" />}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
