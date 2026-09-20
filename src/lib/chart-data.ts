/**
 * تقرير الرسوم البياني — طبقة تجهيز البيانات (Data Layer)
 *
 * تحوّل مخرجات المطابقة (قائمة الدخل T + التصنيفات cat + المركز المالي bs1/bs2
 * + النسب ratioGroups) إلى مجموعات بيانات جاهزة للعرض — بدون أي منطق واجهة.
 *
 * المبادئ:
 *  - كل قيمة مشتقة من بيانات المطابقة الحقيقية — لا بيانات وهمية إطلاقاً.
 *  - القيم المئوية (unit === "percent" و الهوامش) تُخزَّن كأعداد عشرية
 *    (0.15 = 15%) وتحوّلها طبقة العرض عند الرسم.
 *  - القيم المفقودة تُعاد null ولا تُخمَّن أبداً.
 *
 * الاتجاهات (Sign conventions — متوافقة مع accounts.ts):
 *  - قائمة الدخل: الإيرادات دائن-موجبة، المصروفات مدين-موجبة.
 *  - المركز المالي: الأصول مدين-موجبة، الخصوم وحقوق الملكية دائن-موجبة.
 */

import {
  type BalanceSheetTotals,
  type Categorized,
  type MatchedRow,
  type RatioGroup,
  type Totals,
  computeChangePct,
  leafInfo,
  rowAmount,
} from "@/lib/accounts";

/* ══════════════════════════════════════════════════════════════════════════
 * الأنواع العامة
 * ══════════════════════════════════════════════════════════════════════════ */

export type ReportType = "pl" | "bs" | "fa" | "pl_bs" | "all";

export type KpiFormat = "amount" | "ratio" | "percent";
export type KpiTone = "emerald" | "rose" | "amber" | "teal" | "sky" | "violet";

export interface KpiCardData {
  /** مفتاح أيقونة يُفسَّر في طبقة العرض. */
  icon: string;
  label: string;
  value: number | null;
  format: KpiFormat;
  /** نسبة التغير (كسر) أو فرق النقاط المئوية (كسر) حسب deltaKind. */
  delta: number | null;
  deltaKind: "pct" | "pp" | "none";
  /** هل التغير الموجب مرغوب؟ */
  positiveIsGood: boolean;
  tone: KpiTone;
}

export type AlertSeverity = "danger" | "warning" | "info" | "success";

export interface ChartAlert {
  severity: AlertSeverity;
  title: string;
  detail: string;
}

export interface MoverItem {
  num: string | null;
  name: string;
  v1: number;
  v2: number;
  chg: number;
  /** نسبة التغير ككسر (0.25 = 25%) — null عندما يكون أساس المقارنة صفراً. */
  cp: number | null;
  favorable: boolean | null;
}

export interface MarginPoint {
  name: string;
  /** كسر (0.2 = 20%). */
  v1: number | null;
  v2: number | null;
}

export interface PeriodSeriesPoint {
  period: string;
  revenue: number;
  cost: number;
  sell: number;
  adm: number;
  other: number;
  finance: number;
  tax: number;
  net: number;
}

/* ══════════════════════════════════════════════════════════════════════════
 * مجموعات بيانات كل نوع تقرير
 * ══════════════════════════════════════════════════════════════════════════ */

export interface PLDataset {
  kpis: KpiCardData[];
  /** اتجاه الأداء عبر الفترتين (مصروفات مكدسة + إيراد وصافي ربح). */
  trend: PeriodSeriesPoint[];
  /** البنود الأكثر تغيراً — أفضل/أسوأ. */
  movers: MoverItem[];
  alerts: ChartAlert[];
}

export interface BSDataset {
  /** هل تتوفر بيانات مركز مالي؟ */
  available: boolean;
  kpis: KpiCardData[];
  /** هيكل الأصول (الفترة الحالية). */
  assetStructure: { name: string; value: number }[];
  /** هيكل التمويل: خصوم متداولة/غير متداولة/حقوق ملكية (الفترة الحالية). */
  financingStructure: { name: string; value: number }[];
  /** مقارنة المكونات الرئيسية بين الفترتين. */
  comparison: { metric: string; v1: number | null; v2: number | null }[];
  /** العناصر التفصيلية (مخزون، نقدية…) بين الفترتين. */
  details: { metric: string; v1: number | null; v2: number | null }[];
  alerts: ChartAlert[];
}

export interface FADataset {
  kpis: KpiCardData[];
  /** اتجاهات الهوامش عبر الفترتين (مشتقة من قائمة الدخل مباشرة). */
  margins: MarginPoint[];
  /** مجموعات النسب كما حُسبت في computeRatios — بعد استبعاد النسب المكررة. */
  groups: {
    title: string;
    titleEn: string;
    unit: "ratio" | "percent" | "amount" | "days";
    items: { name: string; nameEn: string; v1: number | null; v2: number | null; benchmark: string | null }[];
  }[];
  alerts: ChartAlert[];
}

export interface CombinedDataset {
  available: boolean;
  kpis: KpiCardData[];
  /** تحليل دوپونت: الهامش (%) × الدوران (×) × المضاعف (×). */
  dupont: { name: string; nameEn: string; v1: number | null; v2: number | null; format: "percent" | "ratio" }[];
  /** مؤشرات متقاطعة من القائمتين. */
  cross: { metric: string; v1: number | null; v2: number | null }[];
}

export interface ReportData {
  pl: PLDataset;
  bs: BSDataset;
  fa: FADataset;
  combined: CombinedDataset;
}

/* ══════════════════════════════════════════════════════════════════════════
 * حدود التنبيهات (معايير تحليل مالي قياسية — موثقة)
 * ══════════════════════════════════════════════════════════════════════════ */

/** حد «التغير غير الاعتيادي» في نسبة التغير للبنود. */
const UNUSUAL_CP = 0.25; // ±25%
/** الحد الأدنى لأثر التغير المطلق: 2% من إيرادات الفترة الحالية. */
const UNUSUAL_ABS_SHARE = 0.02;
/** حد التنبيه عند تغير الهامش (بالنقاط المئوية). */
const MARGIN_PP_ALERT = 0.05; // 5 ن.م
/** حد التوازن المحاسبي المسموح به (فروق التقريب). */
const EQUATION_TOL_RATE = 0.005; // 0.5% من إجمالي الأصول
const EQUATION_TOL_ABS = 1;

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** نسبة تغير آمنة: null عند غياب الأساس أو كونه صفراً (دقة 4 منازل لتجنب تشويه النسب). */
const r4 = (n: number): number => Math.round(n * 10000) / 10000;
function pctDelta(v1: number, v2: number): number | null {
  if (v1 === 0) return null;
  return r4((v2 - v1) / Math.abs(v1));
}

/* ══════════════════════════════════════════════════════════════════════════
 * بنود التغير: جمع أوراق شجرة الحسابات من كل فئات قائمة الدخل
 * ══════════════════════════════════════════════════════════════════════════ */

function collectMovers(cat: Categorized): MoverItem[] {
  const defs: { rows: MatchedRow[]; isRevenue: boolean }[] = [
    { rows: cat.sales, isRevenue: true },
    { rows: cat.cost, isRevenue: false },
    { rows: cat.sell, isRevenue: false },
    { rows: cat.adm, isRevenue: false },
    { rows: cat.oth, isRevenue: false },
    { rows: cat.fin, isRevenue: false },
    { rows: cat.tax, isRevenue: false },
    { rows: cat.othRev, isRevenue: true },
  ];
  const out: MoverItem[] = [];
  for (const { rows, isRevenue } of defs) {
    const info = leafInfo(rows);
    for (let i = 0; i < rows.length; i++) {
      const { leaf1, leaf2 } = info[i];
      if (!leaf1 && !leaf2) continue;
      const r = rows[i];
      const v1 = rowAmount(r, "a1", isRevenue);
      const v2 = rowAmount(r, "a2", isRevenue);
      if (v1 == null || v2 == null) continue;
      const chg = r2(v2 - v1);
      const cp = computeChangePct(chg, v1);
      const a = r.a1 ?? r.a2!;
      out.push({
        num: a.num,
        name: a.nm,
        v1,
        v2,
        chg,
        cp,
        favorable: chg === 0 ? null : isRevenue ? chg > 0 : chg < 0,
      });
    }
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * قائمة الربح والخسارة
 * ══════════════════════════════════════════════════════════════════════════ */

function buildPL(T: Totals, cat: Categorized, L1: string): PLDataset {
  const netMargin1 = T.rev1 !== 0 ? r4(T.net1 / T.rev1) : null;
  const netMargin2 = T.rev2 !== 0 ? r4(T.net2 / T.rev2) : null;
  const grossMargin1 = T.rev1 !== 0 ? r4(T.gross1 / T.rev1) : null;
  const grossMargin2 = T.rev2 !== 0 ? r4(T.gross2 / T.rev2) : null;
  const operMargin1 = T.rev1 !== 0 ? r4(T.oper1 / T.rev1) : null;
  const operMargin2 = T.rev2 !== 0 ? r4(T.oper2 / T.rev2) : null;

  const kpis: KpiCardData[] = [
    {
      icon: "revenue", label: "الإيرادات", value: T.rev2, format: "amount",
      delta: pctDelta(T.rev1, T.rev2), deltaKind: "pct", positiveIsGood: true, tone: "teal",
    },
    {
      icon: "gross", label: "مجمل الربح", value: T.gross2, format: "amount",
      delta: pctDelta(T.gross1, T.gross2), deltaKind: "pct", positiveIsGood: true,
      tone: T.gross2 >= 0 ? "emerald" : "rose",
    },
    {
      icon: "operating", label: "الربح التشغيلي", value: T.oper2, format: "amount",
      delta: pctDelta(T.oper1, T.oper2), deltaKind: "pct", positiveIsGood: true,
      tone: T.oper2 >= 0 ? "emerald" : "rose",
    },
    {
      icon: "net", label: "صافي الربح", value: T.net2, format: "amount",
      delta: pctDelta(T.net1, T.net2), deltaKind: "pct", positiveIsGood: true,
      tone: T.net2 >= 0 ? "emerald" : "rose",
    },
    {
      icon: "margin", label: "هامش صافي الربح", value: netMargin2, format: "percent",
      delta: netMargin1 != null && netMargin2 != null ? r4(netMargin2 - netMargin1) : null,
      deltaKind: "pp", positiveIsGood: true,
      tone: netMargin2 != null && netMargin2 < 0 ? "rose" : "emerald",
    },
  ];

  /** اتجاه الأداء عبر الفترتين: [المقارنة، الحالية] — العرض يستبدل العلامة. */
  const CURRENT_PLACEHOLDER = "__CURRENT__";
  const trend: PeriodSeriesPoint[] = [
    {
      period: L1,
      revenue: T.rev1, cost: T.cost1, sell: T.sell1, adm: T.adm1,
      other: T.oth1, finance: T.fin1, tax: T.tax1, net: T.net1,
    },
    {
      period: CURRENT_PLACEHOLDER,
      revenue: T.rev2, cost: T.cost2, sell: T.sell2, adm: T.adm2,
      other: T.oth2, finance: T.fin2, tax: T.tax2, net: T.net2,
    },
  ];

  const movers = collectMovers(cat);

  /* ── التنبيهات ── */
  const alerts: ChartAlert[] = [];
  const revenueRef = Math.max(Math.abs(T.rev2), Math.abs(T.rev1), 1);

  if (netMargin2 != null && netMargin2 < 0) {
    alerts.push({
      severity: "danger",
      title: "صافي ربح سلبي",
      detail: "خسارة في الفترة الحالية — يلزم مراجعة هيكل الإيرادات والمصروفات",
    });
  }
  if (grossMargin1 != null && grossMargin2 != null && grossMargin1 - grossMargin2 >= MARGIN_PP_ALERT) {
    alerts.push({
      severity: "warning",
      title: "تراجع هامش مجمل الربح",
      detail: `انخفض الهامش بمقدار ${((grossMargin1 - grossMargin2) * 100).toFixed(1)} نقطة مئوية — غالباً بسبب ارتفاع تكلفة الإيرادات أسرع من الإيرادات`,
    });
  }
  if (operMargin1 != null && operMargin2 != null && operMargin1 - operMargin2 >= MARGIN_PP_ALERT) {
    alerts.push({
      severity: "warning",
      title: "تراجع الربحية التشغيلية",
      detail: `انخفض هامش الربح التشغيلي بمقدار ${((operMargin1 - operMargin2) * 100).toFixed(1)} نقطة مئوية — راجع المصروفات التشغيلية`,
    });
  }
  for (const m of movers) {
    if (m.cp == null) continue;
    if (Math.abs(m.cp) >= UNUSUAL_CP && Math.abs(m.chg) >= revenueRef * UNUSUAL_ABS_SHARE) {
      const dir = m.chg > 0 ? "ارتفاع" : "انخفاض";
      alerts.push({
        severity: m.favorable === false ? "warning" : "info",
        title: `${dir} غير اعتيادي: ${m.name}`,
        detail: `${dir} بنسبة ${(Math.abs(m.cp) * 100).toFixed(1)}% بمقدار ${Math.abs(m.chg).toLocaleString("en-US")}${m.favorable === false ? " — يستحق المراجعة" : " — اتجاه إيجابي"}`,
      });
    }
  }
  if (alerts.length === 0 && T.net2 > 0 && netMargin1 != null && netMargin2 != null && netMargin2 >= netMargin1) {
    alerts.push({
      severity: "success",
      title: "لا تنبيهات — أداء مستقر",
      detail: "لا توجد تغيرات غير اعتيادية، وهامش صافي الربح محسّن أو مستقر",
    });
  }

  return { kpis, trend, movers, alerts };
}

/* ══════════════════════════════════════════════════════════════════════════
 * قائمة المركز المالي
 * ══════════════════════════════════════════════════════════════════════════ */

function buildBS(
  bs1: BalanceSheetTotals | null,
  bs2: BalanceSheetTotals | null,
  T: Totals
): BSDataset {
  const cur = bs2 ?? bs1;
  const prev = bs1 ?? bs2;

  if (!cur) {
    return {
      available: false, kpis: [], assetStructure: [], financingStructure: [],
      comparison: [], details: [],
      alerts: [{
        severity: "info",
        title: "قائمة المركز المالي غير متاحة",
        detail: "ارفع ملف قائمة المركز المالي (فترة أو فترتين) ثم أعد المطابقة لعرض هذا القسم",
      }],
    };
  }

  const wc2 = r2(cur.currentAssets - cur.currentLiabilities);
  const wc1 = prev ? r2(prev.currentAssets - prev.currentLiabilities) : null;

  const kpis: KpiCardData[] = [
    {
      icon: "assets", label: "إجمالي الأصول", value: cur.totalAssets, format: "amount",
      delta: prev ? pctDelta(prev.totalAssets, cur.totalAssets) : null,
      deltaKind: "pct", positiveIsGood: true, tone: "teal",
    },
    {
      icon: "liabilities", label: "إجمالي الخصوم", value: cur.totalLiabilities, format: "amount",
      delta: prev ? pctDelta(prev.totalLiabilities, cur.totalLiabilities) : null,
      deltaKind: "pct", positiveIsGood: false, tone: "amber",
    },
    {
      icon: "equity", label: "حقوق الملكية", value: cur.equity, format: "amount",
      delta: prev ? pctDelta(prev.equity, cur.equity) : null,
      deltaKind: "pct", positiveIsGood: true,
      tone: cur.equity >= 0 ? "emerald" : "rose",
    },
    {
      icon: "wc", label: "رأس المال العامل", value: wc2, format: "amount",
      delta: wc1 != null ? pctDelta(wc1, wc2) : null,
      deltaKind: "pct", positiveIsGood: true,
      tone: wc2 >= 0 ? "sky" : "rose",
    },
  ];

  const assetStructure = [
    { name: "أصول متداولة", value: r2(cur.currentAssets) },
    { name: "أصول غير متداولة", value: r2(cur.nonCurrentAssets) },
  ].filter((d) => Math.abs(d.value) > 0);

  const financingStructure = [
    { name: "خصوم متداولة", value: r2(cur.currentLiabilities) },
    { name: "خصوم غير متداولة", value: r2(cur.nonCurrentLiabilities) },
    { name: "حقوق الملكية", value: r2(cur.equity) },
  ].filter((d) => Math.abs(d.value) > 0);

  const comparison = [
    { metric: "إجمالي الأصول", v1: prev?.totalAssets ?? null, v2: cur.totalAssets },
    { metric: "أصول متداولة", v1: prev?.currentAssets ?? null, v2: cur.currentAssets },
    { metric: "أصول غير متداولة", v1: prev?.nonCurrentAssets ?? null, v2: cur.nonCurrentAssets },
    { metric: "إجمالي الخصوم", v1: prev?.totalLiabilities ?? null, v2: cur.totalLiabilities },
    { metric: "خصوم متداولة", v1: prev?.currentLiabilities ?? null, v2: cur.currentLiabilities },
    { metric: "حقوق الملكية", v1: prev?.equity ?? null, v2: cur.equity },
  ].filter((d) => (d.v1 ?? 0) !== 0 || d.v2 !== 0);

  const details = [
    { metric: "المخزون", v1: prev?.inventory ?? null, v2: cur.inventory },
    { metric: "النقدية", v1: prev?.cash ?? null, v2: cur.cash },
    { metric: "المدينون", v1: prev?.receivables ?? null, v2: cur.receivables },
    { metric: "الأصول الثابتة", v1: prev?.fixedAssets ?? null, v2: cur.fixedAssets },
    { metric: "الدائنون", v1: prev?.payables ?? null, v2: cur.payables },
    { metric: "قروض قصيرة", v1: prev?.shortTermDebt ?? null, v2: cur.shortTermDebt },
    { metric: "قروض طويلة", v1: prev?.longTermDebt ?? null, v2: cur.longTermDebt },
  ].filter((d) => (d.v1 ?? 0) !== 0 || d.v2 !== 0);

  /* ── التنبيهات ── */
  const alerts: ChartAlert[] = [];

  if (cur.equity < 0) {
    alerts.push({
      severity: "danger",
      title: "حقوق ملكية سالبة",
      detail: "الخصوم تتجاوز الأصول — وضع مالي حرج يستوجب تدخلاً فورياً",
    });
  }
  if (wc2 < 0) {
    alerts.push({
      severity: "danger",
      title: "رأس مال عامل سلبي",
      detail: "الخصوم المتداولة تتجاوز الأصول المتداولة — ضغط على السيولة قصيرة الأجل",
    });
  }

  const eqDiff = r2(cur.totalAssets - (cur.totalLiabilities + cur.equity));
  const tol = Math.max(EQUATION_TOL_ABS, Math.abs(cur.totalAssets) * EQUATION_TOL_RATE);
  if (Math.abs(eqDiff) > tol) {
    alerts.push({
      severity: "warning",
      title: "عدم توازن المعادلة المحاسبية",
      detail: `الأصول − (الخصوم + حقوق الملكية) = ${eqDiff.toLocaleString("en-US")} — قد يعود لعدم احتساب نتيجة الفترة ضمن حقوق الملكية أو لخصوم/أصول غير مصنفة`,
    });
  } else {
    alerts.push({
      severity: "success",
      title: "المعادلة المحاسبية متوازنة",
      detail: "إجمالي الأصول يساوي إجمالي الخصوم وحقوق الملكية ضمن حدود التقريب",
    });
  }

  const debtRatio = cur.totalAssets !== 0 ? r2(cur.totalLiabilities / cur.totalAssets) : null;
  if (debtRatio != null && debtRatio > 0.7) {
    alerts.push({
      severity: "warning",
      title: "رفع مالي مرتفع",
      detail: `الخصوم تمول ${(debtRatio * 100).toFixed(1)}% من الأصول (أعلى من 70%) — يزيد مخاطر المديونية`,
    });
  }

  // ربط تلقائي: لو لم تُحتسب نتيجة الفترة في حقوق الملكية نوضح ذلك بدل إرباك المستخدم
  if (Math.abs(eqDiff) > tol && T.net2 !== 0) {
    alerts.push({
      severity: "info",
      title: "ملاحظة محاسبية",
      detail: "صافي ربح الفترة يظهر في ميزان المراجعة لكنه قد لا يكون مقفلاً على حساب الأرباح المبقاة في المركز المالي",
    });
  }

  return { available: true, kpis, assetStructure, financingStructure, comparison, details, alerts };
}

/* ══════════════════════════════════════════════════════════════════════════
 * التحليل المالي
 * ══════════════════════════════════════════════════════════════════════════ */

/** البحث في مجموعات النسب بالاسم الإنجليزي. */
function findRatio(ratioGroups: RatioGroup[], nameEn: string): { v1: number | null; v2: number | null } | null {
  for (const g of ratioGroups) {
    const r = g.ratios.find((x) => x.nameEn === nameEn);
    if (r) return { v1: r.v1, v2: r.v2 };
  }
  return null;
}

function buildFA(
  T: Totals,
  ratioGroups: RatioGroup[],
  bsAvailable: boolean
): FADataset {
  const netMargin1 = T.rev1 !== 0 ? r4(T.net1 / T.rev1) : null;
  const netMargin2 = T.rev2 !== 0 ? r4(T.net2 / T.rev2) : null;
  const grossMargin1 = T.rev1 !== 0 ? r4(T.gross1 / T.rev1) : null;
  const grossMargin2 = T.rev2 !== 0 ? r4(T.gross2 / T.rev2) : null;
  const operMargin1 = T.rev1 !== 0 ? r4(T.oper1 / T.rev1) : null;
  const operMargin2 = T.rev2 !== 0 ? r4(T.oper2 / T.rev2) : null;

  const current = findRatio(ratioGroups, "Current Ratio");
  const quick = findRatio(ratioGroups, "Quick Ratio");
  const roe = findRatio(ratioGroups, "Return on Equity");

  const kpis: KpiCardData[] = [
    {
      icon: "ratio", label: "نسبة التداول", value: current?.v2 ?? null, format: "ratio",
      delta: current && current.v1 != null && current.v2 != null ? r4(current.v2 - current.v1) : null,
      deltaKind: "none", positiveIsGood: true,
      tone: (current?.v2 ?? 0) < 1 ? "rose" : "sky",
    },
    {
      icon: "quick", label: "النسبة السريعة", value: quick?.v2 ?? null, format: "ratio",
      delta: quick && quick.v1 != null && quick.v2 != null ? r4(quick.v2 - quick.v1) : null,
      deltaKind: "none", positiveIsGood: true,
      tone: (quick?.v2 ?? 0) < 0.5 ? "amber" : "sky",
    },
    {
      icon: "margin", label: "هامش صافي الربح", value: netMargin2, format: "percent",
      delta: netMargin1 != null && netMargin2 != null ? r4(netMargin2 - netMargin1) : null,
      deltaKind: "pp", positiveIsGood: true,
      tone: netMargin2 != null && netMargin2 < 0 ? "rose" : "emerald",
    },
    {
      icon: "roe", label: "العائد على حقوق الملكية", value: roe?.v2 ?? null, format: "percent",
      delta: roe && roe.v1 != null && roe.v2 != null ? r4(roe.v2 - roe.v1) : null,
      deltaKind: "pp", positiveIsGood: true,
      tone: roe?.v2 != null && roe.v2 < 0 ? "rose" : "emerald",
    },
  ];

  const margins: MarginPoint[] = [
    { name: "هامش مجمل الربح", v1: grossMargin1, v2: grossMargin2 },
    { name: "هامش الربح التشغيلي", v1: operMargin1, v2: operMargin2 },
    { name: "هامش صافي الربح", v1: netMargin1, v2: netMargin2 },
  ];

  /* مجموعات النسب كما هي — مع استبعاد «Defensive Interval» لأن قيمها
     مكررة من «نسبة النقدية» في computeRatios (تجنب بيانات مضللة).
     وتُقسَّم كل مجموعة إلى أقسام حسب وحدة القياس حتى لا تختلط
     المضاعفات مع النسب المئوية أو المبالغ في محور واحد. */
  const UNIT_LABEL: Record<string, string> = {
    ratio: "مضاعفات",
    percent: "نسب مئوية",
    amount: "مبالغ",
    days: "أيام",
  };
  type RatioItem = RatioGroup["ratios"][number];
  const groups: FADataset["groups"] = [];
  for (const g of ratioGroups) {
    const filtered: RatioItem[] = g.ratios
      .filter((r) => r.nameEn !== "Defensive Interval")
      .filter((r) => r.v1 != null || r.v2 != null);
    const byUnit = new Map<string, RatioItem[]>();
    for (const r of filtered) {
      const arr = byUnit.get(r.unit) ?? [];
      arr.push(r);
      byUnit.set(r.unit, arr);
    }
    for (const [unit, items] of byUnit) {
      const primaryUnit = g.ratios[0]?.unit ?? "ratio";
      groups.push({
        title: unit === primaryUnit ? g.title : `${g.title} — ${UNIT_LABEL[unit] ?? unit}`,
        titleEn: `${g.titleEn} [${unit}]`,
        unit: unit as "ratio" | "percent" | "amount" | "days",
        items: items.map((r) => ({ name: r.name, nameEn: r.nameEn, v1: r.v1, v2: r.v2, benchmark: r.benchmark ?? null })),
      });
    }
  }

  /* ── التنبيهات (معايير قياسية موثقة) ── */
  const alerts: ChartAlert[] = [];

  if (current?.v2 != null && current.v2 < 1) {
    alerts.push({
      severity: "danger",
      title: "نسبة تداول أقل من 1×",
      detail: "الأصول المتداولة لا تغطي الخصوم المتداولة — خطر سيولة قصير الأجل",
    });
  } else if (current?.v2 != null && current.v2 >= 1.5 && current.v2 <= 2.5) {
    alerts.push({
      severity: "success",
      title: "سيولة مريحة",
      detail: `نسبة التداول ${current.v2.toFixed(2)}× ضمن النطاق الصحي (1.5–2.5×)`,
    });
  }
  if (quick?.v2 != null && quick.v2 < 0.5 && (current?.v2 ?? 0) >= 1) {
    alerts.push({
      severity: "warning",
      title: "اعتماد كبير على المخزون في السيولة",
      detail: `النسبة السريعة ${quick.v2.toFixed(2)}× — دون المخزون يتراجع الغطاء إلى نصفه تقريباً`,
    });
  }
  const finRef = Math.max(Math.abs(T.fin1), Math.abs(T.fin2));
  const ic = findRatio(ratioGroups, "Interest Coverage");
  if (finRef > 0 && ic?.v2 != null && ic.v2 < 1) {
    alerts.push({
      severity: "danger",
      title: "تغطية فوائد غير كافية",
      detail: "الربح التشغيلي لا يغطي تكاليف التمويل — خطر في خدمة الدين",
    });
  }
  const de = findRatio(ratioGroups, "Debt-to-Equity");
  if (de?.v2 != null && de.v2 > 2) {
    alerts.push({
      severity: "warning",
      title: "مديونية مرتفعة مقابل حقوق الملكية",
      detail: `الدين إلى حقوق الملكية ${de.v2.toFixed(2)}× (أعلى من 2×)`,
    });
  }
  const ccc = findRatio(ratioGroups, "Cash Conversion Cycle");
  if (ccc?.v2 != null && ccc.v2 > 90) {
    alerts.push({
      severity: "info",
      title: "دورة تحويل نقدي طويلة",
      detail: `${ccc.v2.toFixed(0)} يوماً بين صرف النقد وتحصيله (أعلى من 90 يوماً) — فرصة لتحسين إدارة رأس المال العامل`,
    });
  }
  if (roe?.v2 != null && roe.v2 < 0) {
    alerts.push({
      severity: "danger",
      title: "عائد سالب على حقوق الملكية",
      detail: "خسارة الفترة تلتهم حقوق المساهمين",
    });
  }
  if (!bsAvailable) {
    alerts.push({
      severity: "info",
      title: "النسب المرتبطة بالمركز المالي غير متاحة",
      detail: "ارفع ملف قائمة المركز المالي لعرض نسب السيولة والمديونية والكفاءة — الهوامش متاحة من قائمة الدخل",
    });
  }
  if (alerts.length === 0) {
    alerts.push({
      severity: "success",
      title: "لا تنبيهات تحليلية",
      detail: "جميع النسب المتاحة ضمن مستويات مقبولة",
    });
  }

  return { kpis, margins, groups, alerts };
}

/* ══════════════════════════════════════════════════════════════════════════
 * التحليل المتكامل (قائمة الدخل + المركز المالي)
 * ══════════════════════════════════════════════════════════════════════════ */

function buildCombined(
  T: Totals,
  bs1: BalanceSheetTotals | null,
  bs2: BalanceSheetTotals | null,
  ratioGroups: RatioGroup[]
): CombinedDataset {
  const bs = bs2 ?? bs1;
  if (!bs) {
    return {
      available: false, kpis: [], dupont: [], cross: [],
    };
  }

  const roa = findRatio(ratioGroups, "Return on Assets");
  const roe = findRatio(ratioGroups, "Return on Equity");
  const at = findRatio(ratioGroups, "Asset Turnover");
  const em = findRatio(ratioGroups, "Equity Multiplier");
  const nm = findRatio(ratioGroups, "Net Margin");

  const kpis: KpiCardData[] = [
    {
      icon: "roa", label: "العائد على الأصول", value: roa?.v2 ?? null, format: "percent",
      delta: roa && roa.v1 != null && roa.v2 != null ? r4(roa.v2 - roa.v1) : null,
      deltaKind: "pp", positiveIsGood: true,
      tone: roa?.v2 != null && roa.v2 < 0 ? "rose" : "emerald",
    },
    {
      icon: "roe", label: "العائد على حقوق الملكية", value: roe?.v2 ?? null, format: "percent",
      delta: roe && roe.v1 != null && roe.v2 != null ? r4(roe.v2 - roe.v1) : null,
      deltaKind: "pp", positiveIsGood: true,
      tone: roe?.v2 != null && roe.v2 < 0 ? "rose" : "emerald",
    },
    {
      icon: "turnover", label: "معدل دوران الأصول", value: at?.v2 ?? null, format: "ratio",
      delta: at && at.v1 != null && at.v2 != null ? r4(at.v2 - at.v1) : null,
      deltaKind: "none", positiveIsGood: true, tone: "sky",
    },
    {
      icon: "leverage", label: "مضاعف حقوق الملكية", value: em?.v2 ?? null, format: "ratio",
      delta: em && em.v1 != null && em.v2 != null ? r4(em.v2 - em.v1) : null,
      deltaKind: "none", positiveIsGood: false, tone: "violet",
    },
  ];

  const dupont = [
    { name: "هامش صافي الربح", nameEn: "Net Margin", v1: nm?.v1 ?? null, v2: nm?.v2 ?? null, format: "percent" as const },
    { name: "معدل دوران الأصول", nameEn: "Asset Turnover", v1: at?.v1 ?? null, v2: at?.v2 ?? null, format: "ratio" as const },
    { name: "مضاعف حقوق الملكية", nameEn: "Equity Multiplier", v1: em?.v1 ?? null, v2: em?.v2 ?? null, format: "ratio" as const },
  ];

  const cross = [
    { metric: "الإيرادات", v1: T.rev1, v2: T.rev2 },
    { metric: "إجمالي الأصول", v1: bs1?.totalAssets ?? bs.totalAssets, v2: bs.totalAssets },
    { metric: "صافي الربح", v1: T.net1, v2: T.net2 },
    { metric: "حقوق الملكية", v1: bs1?.equity ?? bs.equity, v2: bs.equity },
    {
      metric: "رأس المال العامل",
      v1: bs1 ? r2(bs1.currentAssets - bs1.currentLiabilities) : r2(bs.currentAssets - bs.currentLiabilities),
      v2: r2(bs.currentAssets - bs.currentLiabilities),
    },
  ].filter((d) => d.v1 !== 0 || d.v2 !== 0);

  return { available: true, kpis, dupont, cross };
}

/* ══════════════════════════════════════════════════════════════════════════
 * المُجمِّع الرئيسي
 * ══════════════════════════════════════════════════════════════════════════ */

export function buildReportData(args: {
  T: Totals;
  cat: Categorized;
  L1: string;
  L2: string;
  bs1: BalanceSheetTotals | null;
  bs2: BalanceSheetTotals | null;
  ratioGroups: RatioGroup[];
}): ReportData {
  const { T, cat, L1, bs1, bs2, ratioGroups } = args;
  const bsAvailable = !!(bs1 || bs2);

  return {
    pl: buildPL(T, cat, L1),
    bs: buildBS(bs1, bs2, T),
    fa: buildFA(T, ratioGroups, bsAvailable),
    combined: buildCombined(T, bs1, bs2, ratioGroups),
  };
}
