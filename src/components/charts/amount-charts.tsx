"use client";

// Phase 6.10 — أساس الرسوم البيانية القابل لإعادة الاستخدام (N.8: غير مقيّد بالأعمار).
// قواعد صريحة: القيمة الدقيقة نصًا على كل عنصر وفي التلميحات (formatMinor — بلا
// تحويل float للنص المعروض)، محور القيم يبدأ من الصفر (لا مقاييس مضللة)،
// استجابة، تسميات عربية/إنجليزية، ألوان ثابتة بلا أزرق/بنفسجي.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
