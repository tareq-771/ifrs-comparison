"use client";

// Phase 6.10 — أساس الرسوم البيانية القابل لإعادة الاستخدام (N.8: غير مقيّد بالأعمار).
// قواعد صريحة: القيمة الدقيقة نصًا على كل عنصر وفي التلميحات (formatMinor — بلا
// تحويل float للنص المعروض)، محور القيم يبدأ من الصفر (لا مقاييس مضللة)،
// استجابة، تسميات عربية/إنجليزية، ألوان ثابتة بلا أزرق/بنفسجي.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { formatMinor } from "@/lib/money";

const PALETTE = ["#059669", "#0d9488", "#65a30d", "#ca8a04", "#d97706", "#b45309", "#7c2d12", "#57534e", "#a8a29e", "#78716c"];

export interface AmountDatum {
  label: string;
  valueMinor: string | null;
  count?: number;
}

export interface TrendPoint {
  label: string;
  totalMinor: string | null;
  overdueMinor: string | null;
}

/** هندسة العمود: عدد مضمون الدقة حتى 9e15 وحدة رئيسية (لكل 2 منازل عشرية) —
 *  النص المعروض يبقى formatMinor الدقيق دائمًا. */
function toChartNumber(valueMinor: string | null): number {
  if (valueMinor == null) return 0;
  try {
    return Number(BigInt(valueMinor)) / 100;
  } catch {
    return 0;
  }
}

function ExactTooltip({
  active,
  payload,
  minorUnits,
  countLabel,
}: {
  active?: boolean;
  payload?: Array<{ payload: AmountDatum }>;
  minorUnits: number;
  countLabel?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-md" dir="rtl">
      <div className="font-semibold">{d.label}</div>
      <div className="tnum font-mono" dir="ltr">{formatMinor(d.valueMinor, minorUnits)}</div>
      {typeof d.count === "number" ? <div className="text-muted-foreground">{countLabel ?? "العدد"}: {d.count}</div> : null}
    </div>
  );
}

function TrendTooltip({
  active,
  payload,
  minorUnits,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; payload: TrendPoint }>;
  minorUnits: number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-md" dir="rtl">
      <div className="font-semibold">{p.label}</div>
      <div className="tnum font-mono" dir="ltr">الإجمالي: {formatMinor(p.totalMinor, minorUnits)}</div>
      <div className="tnum font-mono" dir="ltr">المتأخر: {formatMinor(p.overdueMinor, minorUnits)}</div>
    </div>
  );
}

/** أعمدة أفقية — النص الدقيق على كل عمود؛ محور القيم مخفي والنص هو المرجع. */
export function AmountBarChartH({
  title,
  data,
  minorUnits,
  heightClass = "h-[320px]",
  countLabel,
}: {
  title: string;
  data: AmountDatum[];
  minorUnits: number;
  heightClass?: string;
  countLabel?: string;
}) {
  const chartData = data.map((d, i) => ({
    ...d,
    chartValue: toChartNumber(d.valueMinor),
    valueLabel: formatMinor(d.valueMinor, minorUnits),
    fill: PALETTE[i % PALETTE.length],
  }));
  const config = { chartValue: { label: title } } satisfies ChartConfig;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className={heightClass + " w-full"}>
          <BarChart data={chartData} layout="vertical" margin={{ right: 100, left: 8 }}>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" />
            <XAxis type="number" hide domain={[0, "dataMax"]} />
            <YAxis type="category" dataKey="label" width={140} tickLine={false} axisLine={false} />
            <ChartTooltip cursor={false} content={<ExactTooltip minorUnits={minorUnits} countLabel={countLabel} />} />
            <Bar dataKey="chartValue" radius={4} isAnimationActive={false}>
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.fill} />
              ))}
              <LabelList dataKey="valueLabel" position="right" className="fill-foreground" fontSize={11} />
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/** دونات التوزيع — وسيلة إيضاح نصية بالقيم الدقيقة (لا اعتماد على الزوايا وحدها). */
export function AmountDonutChart({
  title,
  data,
  minorUnits,
  heightClass = "h-[300px]",
}: {
  title: string;
  data: AmountDatum[];
  minorUnits: number;
  heightClass?: string;
}) {
  const chartData = data
    .filter((d) => d.valueMinor != null)
    .map((d, i) => ({
      ...d,
      chartValue: toChartNumber(d.valueMinor),
      valueLabel: formatMinor(d.valueMinor, minorUnits),
      fill: PALETTE[i % PALETTE.length],
    }));
  const config = { chartValue: { label: title } } satisfies ChartConfig;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className={heightClass + " w-full"}>
          <PieChart>
            <ChartTooltip cursor={false} content={<ExactTooltip minorUnits={minorUnits} countLabel="العملاء" />} />
            <Pie data={chartData} dataKey="chartValue" nameKey="label" innerRadius={60} outerRadius={95} paddingAngle={2} isAnimationActive={false}>
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.fill} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
        <ul className="mt-2 space-y-1 text-xs">
          {chartData.map((d) => (
            <li key={d.label} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: d.fill }} />
                {d.label}
              </span>
              <span className="tnum font-mono" dir="ltr">{d.valueLabel}{typeof d.count === "number" ? ` · ${d.count}` : ""}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** بند فعلي مقابل موازنة للرسم — الناقص null يُستبعد من الرسم (لا صفر مختلق). */
export interface BudgetVsActualDatum {
  label: string;
  budgetMinor: string | null;
  actualMinor: string | null;
}

/** عرض توضيحي لمقارنة موازنة/فعلي (6.11) — يشتق من نفس بيانات الخدمة بلا حقيقة ثانية. */
export function budgetVsActualChartSeries(data: readonly BudgetVsActualDatum[]): {
  rows: Array<{ label: string; budgetChart: number; actualChart: number; budgetLabel: string; actualLabel: string }>;
  skippedMissing: number;
  skippedNegative: number;
} {
  const rows: Array<{ label: string; budgetChart: number; actualChart: number; budgetLabel: string; actualLabel: string }> = [];
  let skippedMissing = 0;
  let skippedNegative = 0;
  for (const d of data) {
    if (d.budgetMinor == null || d.actualMinor == null) {
      skippedMissing += 1; // الناقص يبقى ناقصًا — لا يُرسم كصفر
      continue;
    }
    const b = toChartNumber(d.budgetMinor);
    const a = toChartNumber(d.actualMinor);
    if (!Number.isFinite(b) || !Number.isFinite(a)) {
      skippedMissing += 1;
      continue;
    }
    if (b < 0 || a < 0) {
      skippedNegative += 1; // قيم سالبة تُستثنى من رسم يبدأ من الصفر — بلا تضليل
      continue;
    }
    rows.push({
      label: d.label,
      budgetChart: b,
      actualChart: a,
      budgetLabel: formatMinor(d.budgetMinor, 2),
      actualLabel: formatMinor(d.actualMinor, 2),
    });
  }
  return { rows, skippedMissing, skippedNegative };
}

/** أعمدة مجمّعة: موازنة مقابل فعلي لكل بند (6.11) — محور من الصفر، تلميح بالنص الدقيق. */
export function BudgetVsActualChart({
  title,
  data,
  heightClass = "h-[340px]",
}: {
  title: string;
  data: readonly BudgetVsActualDatum[];
  heightClass?: string;
}) {
  const { rows, skippedMissing, skippedNegative } = budgetVsActualChartSeries(data);
  const config = {
    budgetChart: { label: "الموازنة", color: "#57534e" },
    actualChart: { label: "الفعلي", color: "#059669" },
  } satisfies ChartConfig;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription className="text-xs">
          يُشتق من نفس بيانات الجدول أعلاه — الجدول هو المرجع الدقيق.
          {skippedMissing > 0 ? ` استُبعدت ${skippedMissing} بنود ببيانات ناقصة (الناقص لا يُرسم صفرًا).` : ""}
          {skippedNegative > 0 ? ` استُبعدت ${skippedNegative} بنود بقيم سالبة من هذا الرسم (يبدأ من الصفر).` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="p-6 text-center text-xs text-slate-400">لا توجد بنود قابلة للرسم — البيانات الناقصة تبقى ناقصة.</p>
        ) : (
          <ChartContainer config={config} className={heightClass + " w-full"}>
            <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={10} interval={0} angle={-20} height={56} />
              <YAxis tickLine={false} axisLine={false} width={72} fontSize={11} domain={[0, "auto"]} />
              <ChartTooltip
                cursor={false}
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const d = payload[0].payload as (typeof rows)[number];
                  return (
                    <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-md" dir="rtl">
                      <div className="font-semibold">{d.label}</div>
                      <div className="tnum font-mono" dir="ltr">الموازنة: {d.budgetLabel}</div>
                      <div className="tnum font-mono" dir="ltr">الفعلي: {d.actualLabel}</div>
                    </div>
                  );
                }}
              />
              <Bar dataKey="budgetChart" fill="#57534e" radius={3} isAnimationActive={false} />
              <Bar dataKey="actualChart" fill="#059669" radius={3} isAnimationActive={false} />
            </BarChart>
          </ChartContainer>
        )}
        <ul className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
          <li className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm" style={{ background: "#57534e" }} />الموازنة</li>
          <li className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm" style={{ background: "#059669" }} />الفعلي</li>
        </ul>
      </CardContent>
    </Card>
  );
}

/** خط اتجاه (لقطات معتمدة) — الفجوات null تبقى فجوات (لا ربط اختراعي). */
export function AmountTrendChart({
  title,
  points,
  minorUnits,
  heightClass = "h-[300px]",
}: {
  title: string;
  points: TrendPoint[];
  minorUnits: number;
  heightClass?: string;
}) {
  const chartData = points.map((p) => ({
    ...p,
    totalChart: toChartNumber(p.totalMinor),
    overdueChart: toChartNumber(p.overdueMinor),
  }));
  const config = {
    totalChart: { label: "الإجمالي", color: "#059669" },
    overdueChart: { label: "المتأخر", color: "#ca8a04" },
  } satisfies ChartConfig;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className={heightClass + " w-full"}>
          <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
            <YAxis tickLine={false} axisLine={false} width={64} fontSize={11} domain={[0, "auto"]} tickFormatter={(v: number) => String(v)} />
            <ChartTooltip cursor={false} content={<TrendTooltip minorUnits={minorUnits} />} />
            <Line dataKey="totalChart" type="monotone" stroke="#059669" strokeWidth={2} dot={true} connectNulls={false} isAnimationActive={false} />
            <Line dataKey="overdueChart" type="monotone" stroke="#ca8a04" strokeWidth={2} dot={true} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
