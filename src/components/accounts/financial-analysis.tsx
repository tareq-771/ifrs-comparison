"use client";

import * as React from "react";
import {
  Droplets, Scale, TrendingUp, TrendingDown, Activity, Calculator,
  ArrowUpRight, ArrowDownRight, Minus, Wallet, Gauge,
  Clock, Target, CheckCircle2, AlertTriangle, XCircle,
  Sparkles, Lightbulb, ShieldAlert, Search, Bell,
} from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { type RatioGroup, fmtRatio } from "@/lib/accounts";
import { AiAnalysisPanel } from "@/components/accounts/ai-analysis-panel";

interface FinancialAnalysisProps {
  ratioGroups: RatioGroup[];
  L1: string;
  L2: string;
}

/* ── Ratio type (extracted from RatioGroup["ratios"][number]) ─── */
type Ratio = RatioGroup["ratios"][number];

/* ── Group metadata ─────────────────────────────────────────────────── */

interface GroupMeta {
  icon: React.ReactNode;
  gradient: string;
  headerCls: string;
  borderCls: string;
  iconBg: string;
}

const GROUP_META: Record<string, GroupMeta> = {
  "Liquidity Ratios": {
    icon: <Droplets className="size-4" />,
    gradient: "from-sky-500/10 to-cyan-500/5",
    headerCls: "bg-gradient-to-l from-sky-500/15 to-transparent",
    borderCls: "border-sky-200/60 dark:border-sky-800/50",
    iconBg: "bg-sky-100 text-sky-600 dark:bg-sky-950/50 dark:text-sky-400",
  },
  "Leverage Ratios": {
    icon: <Scale className="size-4" />,
    gradient: "from-amber-500/10 to-orange-500/5",
    headerCls: "bg-gradient-to-l from-amber-500/15 to-transparent",
    borderCls: "border-amber-200/60 dark:border-amber-800/50",
    iconBg: "bg-amber-100 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400",
  },
  "Profitability Ratios": {
    icon: <TrendingUp className="size-4" />,
    gradient: "from-emerald-500/10 to-teal-500/5",
    headerCls: "bg-gradient-to-l from-emerald-500/15 to-transparent",
    borderCls: "border-emerald-200/60 dark:border-emerald-800/50",
    iconBg: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400",
  },
  "Activity & Efficiency Ratios": {
    icon: <Activity className="size-4" />,
    gradient: "from-indigo-500/10 to-violet-500/5",
    headerCls: "bg-gradient-to-l from-indigo-500/15 to-transparent",
    borderCls: "border-indigo-200/60 dark:border-indigo-800/50",
    iconBg: "bg-indigo-100 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-400",
  },
  "Days & Cash Cycle": {
    icon: <Clock className="size-4" />,
    gradient: "from-rose-500/10 to-pink-500/5",
    headerCls: "bg-gradient-to-l from-rose-500/15 to-transparent",
    borderCls: "border-rose-200/60 dark:border-rose-800/50",
    iconBg: "bg-rose-100 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400",
  },
};

const FALLBACK_META: GroupMeta = {
  icon: <Gauge className="size-4" />,
  gradient: "from-slate-500/10 to-slate-500/5",
  headerCls: "bg-gradient-to-l from-slate-500/15 to-transparent",
  borderCls: "border-slate-200 dark:border-slate-800",
  iconBg: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

/* ── Plain-language explanations per ratio (Arabic) ──────────────────── */
/* Each entry: explain (plain Arabic — what does this ratio mean & why does it matter?) */
const RATIO_INFO: Record<string, { explain: string }> = {
  "Current Ratio": { explain: "تقيس قدرة الشركة على سداد التزاماتها قصيرة الأجل (خلال سنة). كلما زادت عن 1.5× كان الوضع أكثر أماناً." },
  "Quick Ratio": { explain: "مثل نسبة التداول لكن دون المخزون (لأن المخزون قد يصعب تصريفه بسرعة). يُفضّل أن تكون ≥ 1.0× لتأمين السيولة الفورية." },
  "Cash Ratio": { explain: "أكثر نسب السيولة تحفظًا: تقيس ما تستطيع الشركة سداده نقداً فقط دون بيع أي أصل. بين 0.2× و0.5× يُعد مقبولاً." },
  "Defensive Interval": { explain: "تقيس قدرة الشركة على تغطية مصروفاتها التشغيلية اليومية من النقد وما يمكن تحصيله سريعاً." },
  "Working Capital": { explain: "الفرق بين الأصول المتداولة والخصوم المتداولة. يجب أن يكون موجباً لضمان استمرار النشاط." },
  "Debt Ratio": { explain: "نسبة ما تملكه الشركة من أصل ديون. يُفضّل أن تكون أقل من 50% لتقليل المخاطر المالية." },
  "Debt-to-Equity": { explain: "تقارن بين الديون وحقوق الملكية. أقل من 1.0× يعني اعتماد الشركة أكثر على رأس مالها الخاص." },
  "Equity Ratio": { explain: "نسبة ما تملكه الشركة من أصل حقوق ملكية. أعلى من 50% يعني استقلال مالي جيد." },
  "Debt-to-Assets": { explain: "نسبة الأصول المموّلة بالقروض. أقل من 40% يُعد مستوى آمناً." },
  "Equity Multiplier": { explain: "مقياس للرفع المالي: يُظهر عدد مرات مضاعفة حقوق الملكية عبر الأصول. أقل من 2.0× أكثر أماناً." },
  "Interest Coverage": { explain: "عدد مرات قدرة أرباح التشغيل على تغطية فوائد الديون. ≥ 3.0× يعني قدرة مريحة على السداد." },
  "Fixed Assets to Equity": { explain: "تُظهر نسبة تمويل الأصول الثابتة من حقوق الملكية. أقل من 1.0× يعني عدم تجاوز رأس المال لتمويل الأصول الثابتة." },
  "Current to Total Assets": { explain: "نصيب الأصول السائلة من إجمالي الأصول. أعلى من 30% يعني مرونة جيدة في السيولة." },
  "Gross Margin": { explain: "ربح كل ريال مبيعات بعد خصم التكلفة المباشرة. أعلى من 30% يُعد جيداً في معظم الأنشطة." },
  "Operating Margin": { explain: "ربح التشغيل من كل ريال مبيعات بعد المصروفات التشغيلية. أعلى من 15% يعتبر صحياً." },
  "Net Margin": { explain: "الربح النهائي من كل ريال مبيعات بعد كل المصروفات والضرائب. أعلى من 10% يُعد جيداً." },
  "Return on Assets": { explain: "أرباح الشركة مقابل كل ريال من الأصول المستثمرة. أعلى من 5% يعتبر مقبولاً، أعلى من 10% ممتاز." },
  "Return on Equity": { explain: "العائد الذي يحققه المساهمون على أموالهم. أعلى من 15% يُعد عائداً قوياً." },
  "DuPont ROE": { explain: "تحليل تفصيلي للعائد على حقوق الملكية يُظهر مصادر الربح: الهامش، الكفاءة، والرفع المالي." },
  "Gross Profit to Assets": { explain: "كفاءة استخدام الأصول في توليد مجمل الربح. أعلى من 20% يدل على استغلال جيد للأصول." },
  "Operating Profit to Assets": { explain: "كفاءة استخدام الأصول في توليد الربح التشغيلي. أعلى من 10% يُعد أداء جيداً." },
  "Asset Turnover": { explain: "عدد الريالات التي تُولّدها الشركة من المبيعات مقابل كل ريال من الأصول. أعلى من 0.5× يعني كفاءة مقبولة." },
  "Fixed Asset Turnover": { explain: "كفاءة استخدام الأصول الثابتة (المباني، المعدات) في توليد المبيعات." },
  "Inventory Turnover": { explain: "عدد مرات تصريف المخزون خلال السنة. أعلى من 4× يعني دوران سريع وعدم ركود المخزون." },
  "Receivables Turnover": { explain: "عدد مرات تحصيل الذمم المدينة سنوياً. أعلى من 6× يعني تحصيل سريع من العملاء." },
  "Payables Turnover": { explain: "عدد مرات سداد الموردين سنوياً. بين 4× و8× يوازن بين الاحتفاظ بالسيولة ورضا الموردين." },
  "Working Capital Turnover": { explain: "كفاءة استخدام رأس المال العامل في توليد المبيعات." },
  "Days Inventory Outstanding": { explain: "متوسط عدد الأيام التي يبقى فيها المخزون قبل بيعه. أقصر = أفضل (30-90 يوم مقبول)." },
  "Days Sales Outstanding": { explain: "متوسط عدد الأيام لتحصيل المبيعات من العملاء. أقصر = تحصيل أسرع (30-60 يوم مقبول)." },
  "Days Payable Outstanding": { explain: "متوسط عدد الأيام لسداد الموردين. أطول = الاحتفاظ بالسيولة (30-90 يوم مقبول)." },
  "Cash Conversion Cycle": { explain: "الفترة الزمنية بين دفع النقود للموردين وتحصيلها من العملاء. أقصر = سيولة أفضل (أقل من 60 يوم مقبول)." },
};

/* ── Insight icon mapping (string id → lucide-react node) ───────────── */
const INSIGHT_ICONS: Record<string, React.ReactNode> = {
  sparkles: <Sparkles className="size-4 text-emerald-500" />,
  scale: <Scale className="size-4 text-amber-500" />,
  alert: <AlertTriangle className="size-4 text-rose-500" />,
  "trending-up": <TrendingUp className="size-4 text-emerald-500" />,
  "trending-down": <TrendingDown className="size-4 text-amber-500" />,
  check: <CheckCircle2 className="size-4 text-emerald-500" />,
  "shield-alert": <ShieldAlert className="size-4 text-rose-500" />,
  search: <Search className="size-4 text-amber-500" />,
};

/* ── interpretRatio: generate a brief interpretation per ratio ──────── */
interface RatioInterpretation {
  cls: "good" | "warn" | "bad" | "neutral";
  icon: string;
  text: string;
}

function interpretRatio(ratio: Ratio): RatioInterpretation {
  const v = ratio.v2;
  const bench = ratio.benchmark;
  const des = ratio.desirable;
  const unit = ratio.unit;

  if (v == null || Number.isNaN(v)) {
    return { cls: "neutral", icon: "—", text: "لا توجد بيانات كافية لحساب هذه النسبة" };
  }
  if (unit === "amount") {
    if (v > 0) return { cls: "good", icon: "✓", text: "موجب — الشركة قادرة على تغطية التزاماتها قصيرة الأجل بفائض" };
    if (v < 0) return { cls: "bad", icon: "✗", text: "سالب — عجز في تغطية الالتزامات قصيرة الأجل، يستوجب مراجعة السيولة" };
    return { cls: "warn", icon: "!", text: "متعادل — لا يوجد فائض ولا عجز" };
  }

  const parsed = parseBench(bench);
  if (!parsed) return { cls: "neutral", icon: "—", text: "لا يوجد معيار مرجعي للمقارنة" };

  const threshold = des === "high" ? parsed.lo : (parsed.hi != null ? parsed.hi : parsed.lo);
  if (threshold <= 0) return { cls: "neutral", icon: "—", text: "لا يوجد معيار مرجعي للمقارنة" };
  const pctOfBench = v / threshold;

  if (des === "high") {
    if (v >= threshold) return { cls: "good", icon: "✓", text: `ممتاز — يحقق المعيار المرجعي (${Math.round(pctOfBench * 100)}% منه)` };
    if (v >= threshold * 0.5) return { cls: "warn", icon: "!", text: `مقبول لكنه أقل من المعيار المرجعي (${Math.round(pctOfBench * 100)}% منه)` };
    return { cls: "bad", icon: "✗", text: `ضعيف — أقل من نصف المعيار المرجعي (${Math.round(pctOfBench * 100)}% منه)` };
  } else {
    if (v <= threshold) return { cls: "good", icon: "✓", text: `ممتاز — أقل من الحد المسموح به بنسبة ${Math.round((1 - pctOfBench) * 100)}%` };
    if (v <= threshold * 1.5) return { cls: "warn", icon: "!", text: `مقبول لكنه تجاوز الحد المسموح بنسبة ${Math.round((pctOfBench - 1) * 100)}%` };
    return { cls: "bad", icon: "✗", text: `ضعيف — تجاوز الحد المسموح بنسبة ${Math.round((pctOfBench - 1) * 100)}%` };
  }
}

/* ── calcGroupHealth: counts of exc/acc/weak + overall score ────────── */
interface GroupHealth {
  exc: number;
  acc: number;
  weak: number;
  neu: number;
  total: number;
  score: number;
  level: "good" | "warn" | "bad";
}

function calcGroupHealth(group: RatioGroup): GroupHealth {
  let exc = 0, acc = 0, weak = 0, neu = 0;
  const total = group.ratios.length;
  for (const r of group.ratios) {
    const lvl = calcStatusLevel(r.v2, r.benchmark, r.desirable, r.unit);
    if (lvl === "excellent") exc++;
    else if (lvl === "acceptable") acc++;
    else if (lvl === "weak") weak++;
    else neu++;
  }
  const score = total > 0 ? Math.round((exc * 1 + acc * 0.5) / total * 100) : 0;
  let level: "good" | "warn" | "bad" = "good";
  if (score < 40) level = "bad";
  else if (score < 70) level = "warn";
  return { exc, acc, weak, neu, total, score, level };
}

/* ── progressInfo: % of benchmark achieved + target marker position ─── */
interface ProgressInfo {
  pct: number;
  cls: "good" | "warn" | "bad" | "neutral";
  targetPct: number | null;
}

function progressInfo(ratio: Ratio): ProgressInfo {
  const v = ratio.v2;
  const bench = ratio.benchmark;
  const des = ratio.desirable;
  const unit = ratio.unit;

  if (v == null || Number.isNaN(v)) return { pct: 0, cls: "neutral", targetPct: null };
  if (unit === "amount") {
    if (v > 0) return { pct: 100, cls: "good", targetPct: null };
    return { pct: 0, cls: "bad", targetPct: null };
  }
  const parsed = parseBench(bench);
  if (!parsed) return { pct: 0, cls: "neutral", targetPct: null };
  const threshold = des === "high" ? parsed.lo : (parsed.hi != null ? parsed.hi : parsed.lo);
  if (threshold <= 0) return { pct: 0, cls: "neutral", targetPct: null };

  /* The bar goes from 0 to 150% of threshold so we can see overshoots */
  const maxBar = threshold * 1.5;
  const pct = Math.min(100, Math.max(0, (v / maxBar) * 100));
  const targetPct = Math.min(100, (threshold / maxBar) * 100);
  const lvl = calcStatusLevel(v, bench, des, unit);
  let cls: "good" | "warn" | "bad" | "neutral" = "neutral";
  if (lvl === "excellent") cls = "good";
  else if (lvl === "acceptable") cls = "warn";
  else if (lvl === "weak") cls = "bad";
  return { pct, cls, targetPct };
}

/* ── generateExecSummary: auto-generated insights for the top of card ─ */
interface ExecInsight {
  type: "good" | "warn" | "bad";
  icon: string;
  title: string;
  text: string;
}

function generateExecSummary(groups: RatioGroup[], L1: string, L2: string): ExecInsight[] {
  const insights: ExecInsight[] = [];
  const allRatios: { group: RatioGroup; ratio: Ratio }[] = [];
  for (const g of groups) {
    for (const r of g.ratios) {
      allRatios.push({ group: g, ratio: r });
    }
  }

  /* Overall health counts */
  let exc = 0, acc = 0, weak = 0, neutral = 0, total = 0;
  for (const item of allRatios) {
    const lvl = calcStatusLevel(item.ratio.v2, item.ratio.benchmark, item.ratio.desirable, item.ratio.unit);
    if (lvl === "excellent") exc++;
    else if (lvl === "acceptable") acc++;
    else if (lvl === "weak") weak++;
    else neutral++;
    total++;
  }

  /* Overall health insight */
  if (total > 0) {
    const overallPct = Math.round((exc * 1 + acc * 0.5) / total * 100);
    if (overallPct >= 70) {
      insights.push({ type: "good", icon: "sparkles", title: "الوضع المالي العام: ممتاز", text: `تحقّق ${overallPct}% من المعايير المرجعية بنجاح (${exc} ممتاز، ${acc} مقبول، ${weak} ضعيف).` });
    } else if (overallPct >= 40) {
      insights.push({ type: "warn", icon: "scale", title: "الوضع المالي العام: مقبول", text: `تحقّق ${overallPct}% من المعايير (${exc} ممتاز، ${acc} مقبول، ${weak} ضعيف). تحتاج بعض المجالات للتحسين.` });
    } else {
      insights.push({ type: "bad", icon: "alert", title: "الوضع المالي العام: يحتاج انتباه", text: `تحقّق ${overallPct}% من المعايير فقط (${exc} ممتاز، ${acc} مقبول، ${weak} ضعيف). يُنصح بمراجعة المتخصص.` });
    }
  }

  /* Find notable improvements and deteriorations */
  const improvements: { name: string; diff: number; group: string }[] = [];
  const deteriorations: { name: string; diff: number; group: string }[] = [];
  for (const item of allRatios) {
    const r = item.ratio;
    if (r.v1 == null || r.v2 == null) continue;
    const diff = r.v2 - r.v1;
    if (diff === 0) continue;
    const good = r.desirable === "high" ? diff > 0 : diff < 0;
    if (good) {
      improvements.push({ name: r.name, diff, group: item.group.title });
    } else {
      deteriorations.push({ name: r.name, diff, group: item.group.title });
    }
  }
  improvements.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  deteriorations.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  if (improvements.length > 0) {
    const imp = improvements[0];
    insights.push({
      type: "good",
      icon: "trending-up",
      title: `أبرز تحسّن: ${imp.name}`,
      text: `تحسّن في مجال "${imp.group}" بين ${L1} و${L2}، مما يعكس تطوراً إيجابياً.`,
    });
  }
  if (deteriorations.length > 0) {
    const det = deteriorations[0];
    insights.push({
      type: "warn",
      icon: "trending-down",
      title: `أبرز تراجع: ${det.name}`,
      text: `تراجع في مجال "${det.group}" بين ${L1} و${L2}، يستحق المتابعة.`,
    });
  }

  /* Best and worst groups */
  let bestGroup: { title: string; score: number } | null = null;
  let worstGroup: { title: string; score: number } | null = null;
  for (const g of groups) {
    const h = calcGroupHealth(g);
    if (!bestGroup || h.score > bestGroup.score) bestGroup = { title: g.title, score: h.score };
    if (!worstGroup || h.score < worstGroup.score) worstGroup = { title: g.title, score: h.score };
  }
  if (bestGroup && worstGroup && bestGroup.title !== worstGroup.title) {
    insights.push({
      type: "good",
      icon: "check",
      title: `أقوى مجال: ${bestGroup.title}`,
      text: `حقق ${bestGroup.score}% من المعايير المرجعية في هذا المجال.`,
    });
    insights.push({
      type: worstGroup.score < 40 ? "bad" : "warn",
      icon: worstGroup.score < 40 ? "shield-alert" : "search",
      title: `أضعف مجال: ${worstGroup.title}`,
      text: `حقق ${worstGroup.score}% فقط من المعايير المرجعية، يُنصح بمراجعته.`,
    });
  }

  return insights;
}

/* ── Smart alert (threshold-based critical violations) ──────────────── */
interface Alert {
  type: "bad" | "warn" | "info";
  ico: string;
  title: string;
  text: string;
  ratioName: string;
  value: string;
  bench?: string;
}

/** Generate alerts for critical threshold violations, mirroring the HTML
 *  `generateAlerts(groups)` helper in `public/قائمة-الربح-IFRS.html`. */
function generateAlerts(groups: RatioGroup[]): Alert[] {
  const alerts: Alert[] = [];
  for (const g of groups) {
    for (const r of g.ratios) {
      if (r.v2 == null || Number.isNaN(r.v2)) continue;
      const v = r.v2;
      let alert: Omit<Alert, "ratioName" | "value" | "bench"> | null = null;
      switch (r.nameEn) {
        case "Current Ratio":
          if (v < 1)
            alert = { type: "bad", ico: "🚨", title: "نسبة التداول حرجة", text: "السيولة قصيرة الأجل أقل من 1× — لا تكفي لتغطية الخصوم المتداولة. يُنصح بتعزيز النقدية أو إعادة جدولة الديون قصيرة الأجل." };
          else if (v < 1.5)
            alert = { type: "warn", ico: "⚠️", title: "نسبة التداول دون المعيار", text: "أقل من 1.5× الموصى به، يستوجب مراقبة السيولة قصيرة الأجل." };
          break;
        case "Quick Ratio":
          if (v < 0.5)
            alert = { type: "bad", ico: "🚨", title: "النسبة السريعة حرجة", text: "بعد استبعاد المخزون، السيولة لا تكفي لتغطية الخصوم المتداولة." };
          break;
        case "Debt Ratio":
          if (v > 0.7)
            alert = { type: "bad", ico: "🚨", title: "نسبة المديونية مرتفعة جداً", text: "أكثر من 70% من الأصول مموّلة بالديون — مخاطرة مالية عالية." };
          else if (v > 0.5)
            alert = { type: "warn", ico: "⚠️", title: "نسبة المديونية مرتفعة", text: "تجاوزت 50% الموصى به، يستحسن تقليص الديون." };
          break;
        case "Debt-to-Equity":
          if (v > 2)
            alert = { type: "bad", ico: "🚨", title: "الدين ضعفي حقوق الملكية", text: "اعتماد مفرط على الديون مقارنة برأس المال الخاص." };
          else if (v > 1)
            alert = { type: "warn", ico: "⚠️", title: "الدين يتجاوز حقوق الملكية", text: "الديون أعلى من حقوق الملكية، راقب كفاءة خدمة الدين." };
          break;
        case "Interest Coverage":
          if (v < 1.5)
            alert = { type: "bad", ico: "🚨", title: "تغطية الفوائد حرجة", text: "أرباح التشغيل لا تكفي لتغطية فوائد الديون بشكل مريح — مخاطرة تعثر." };
          else if (v < 3)
            alert = { type: "warn", ico: "⚠️", title: "تغطية الفوائد دون المعيار", text: "أقل من 3× الموصى به — قد تواجه صعوبة في خدمة الدين مستقبلاً." };
          break;
        case "Net Margin":
          if (v < 0)
            alert = { type: "bad", ico: "🚨", title: "صافي الربح سالب", text: "الشركة تحقق خسارة صافية — راجع هيكل التكاليف والإيرادات." };
          else if (v < 0.05)
            alert = { type: "warn", ico: "⚠️", title: "هامش صافي الربح منخفض", text: "أقل من 5%، يستوجب تحسين كفاءة التشغيل." };
          break;
        case "Working Capital":
          if (v < 0)
            alert = { type: "bad", ico: "🚨", title: "رأس المال العامل سالب", text: "الخصوم المتداولة تتجاوز الأصول المتداولة — مخاطرة سيولة فورية." };
          break;
        case "Cash Conversion Cycle":
          if (v > 90)
            alert = { type: "warn", ico: "⚠️", title: "دورة التحويل النقدي طويلة", text: "تتجاوز 90 يوماً — النقد محتجز لفترة طويلة قبل تحويله." };
          else if (v < 0)
            alert = { type: "info", ico: "ℹ️", title: "دورة تحويل نقدي سالبة", text: "الشركة تحصل من عملائها قبل أن تدفع مورديها — وضع إيجابي للسيولة." };
          break;
        case "Inventory Turnover":
          if (v < 2)
            alert = { type: "warn", ico: "⚠️", title: "دوران المخزون بطيء", text: "أقل من 2× — قد يكون هناك مخزون راكد يستهلك سيولة." };
          break;
        case "Days Sales Outstanding":
          if (v > 90)
            alert = { type: "warn", ico: "⚠️", title: "فترة تحصيل طويلة", text: "أكثر من 90 يوماً — تأخر في تحصيل المبيعات من العملاء." };
          break;
      }
      if (alert) {
        alerts.push({
          ...alert,
          ratioName: r.name,
          value: fmtRatio(v, r.unit),
          bench: r.benchmark,
        });
      }
    }
  }
  return alerts;
}

/* ── Main component ──────────────────────────────────────────────────── */

export function FinancialAnalysis({ ratioGroups, L1, L2 }: FinancialAnalysisProps) {
  const [query, setQuery] = React.useState("");

  const { filteredGroups, totalRatios, visibleRatios } = React.useMemo(() => {
    const q = query.toLowerCase().trim();
    const statusMap: Record<string, StatusLevel> = {
      ممتاز: "excellent",
      excellent: "excellent",
      مقبول: "acceptable",
      acceptable: "acceptable",
      ضعيف: "weak",
      weak: "weak",
    };
    let total = 0;
    let visible = 0;
    const filtered: RatioGroup[] = ratioGroups
      .map((g) => {
        const ratios = g.ratios.filter((r) => {
          total++;
          if (!q) {
            visible++;
            return true;
          }
          const status = statusMap[q];
          let statusMatch = false;
          if (status) {
            const lvl = calcStatusLevel(r.v2, r.benchmark, r.desirable, r.unit);
            statusMatch = lvl === status;
          }
          const matches =
            r.name.toLowerCase().includes(q) ||
            r.nameEn.toLowerCase().includes(q) ||
            r.formula.toLowerCase().includes(q) ||
            statusMatch;
          if (matches) visible++;
          return matches;
        });
        return { ...g, ratios };
      })
      .filter((g) => g.ratios.length > 0);
    return { filteredGroups: filtered, totalRatios: total, visibleRatios: visible };
  }, [ratioGroups, query]);

  return (
    <Card className="border-slate-200 shadow-lg dark:border-slate-800">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2.5 text-base text-slate-800 dark:text-slate-100">
          <div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-600 to-teal-700 text-white shadow-md shadow-emerald-600/20">
            <Calculator className="size-5" />
          </div>
          <div>
            <span>التحليل المالي — النسب والمؤشرات المالية</span>
            <span className="mr-2 rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              Financial Analysis
            </span>
          </div>
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          <span>
            مقارنة بين <strong className="font-semibold text-slate-700 dark:text-slate-200">{L1}</strong> (المقارنة) و
            <strong className="font-semibold text-slate-700 dark:text-slate-200"> {L2}</strong> (الحالية)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
              <CheckCircle2 className="size-3" /> ممتاز
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
              <AlertTriangle className="size-3" /> مقبول
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-700 dark:bg-rose-950/40 dark:text-rose-400">
              <XCircle className="size-3" /> ضعيف
            </span>
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-2">
        <SearchToolbar
          query={query}
          onQueryChange={setQuery}
          visible={visibleRatios}
          total={totalRatios}
        />
        <ExecSummaryCard groups={ratioGroups} L1={L1} L2={L2} />
        <SmartAlertsBanner groups={ratioGroups} />
        <AiAnalysisPanel ratioGroups={ratioGroups} L1={L1} L2={L2} />
        {filteredGroups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/50 p-6 text-center dark:border-slate-700 dark:bg-slate-900/40">
            <Search className="mx-auto mb-2 size-6 text-slate-400" />
            <p className="text-sm font-semibold text-slate-600 dark:text-slate-300">لا توجد نسب مطابقة لبحثك</p>
            <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">جرّب كلمات بحث أخرى أو امسح الحقل لعرض كل النسب</p>
          </div>
        ) : (
          filteredGroups.map((group) => (
            <RatioGroupCard key={group.titleEn} group={group} L1={L1} L2={L2} />
          ))
        )}
      </CardContent>
      <FooterNote />
    </Card>
  );
}

/* ── Per-group card ──────────────────────────────────────────────────── */

function RatioGroupCard({ group, L1, L2 }: { group: RatioGroup; L1: string; L2: string }) {
  const meta = GROUP_META[group.titleEn] ?? FALLBACK_META;

  return (
    <div className={cn("overflow-hidden rounded-xl border shadow-sm", meta.borderCls, "bg-gradient-to-br", meta.gradient)}>
      {/* Group header with gradient */}
      <div className={cn("flex items-center justify-between gap-2 px-3 py-2", meta.headerCls)}>
        <div className="flex items-center gap-2.5">
          <div className={cn("flex size-7 items-center justify-center rounded-lg", meta.iconBg)}>
            {meta.icon}
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">{group.title}</h3>
            <p className="text-[10px] text-slate-500 dark:text-slate-400" dir="ltr">{group.titleEn}</p>
          </div>
        </div>
        <span className="rounded-full bg-white/80 px-3 py-0.5 text-[10px] font-bold text-slate-600 shadow-sm dark:bg-slate-800/80 dark:text-slate-300">
          {group.ratios.length} نسب
        </span>
      </div>

      {/* Group health bar — segmented bar with exc/acc/weak counts + score */}
      <GroupHealthBar group={group} />

      {/* Shared column header row (renders L1/L2 once per group, aligns values under headers) */}
      <ColsHeader L1={L1} L2={L2} />

      {/* Ratio rows — grid-based, each row aligned under the column header */}
      <div>
        {group.ratios.map((r, i) => (
          <RatioRow key={i} ratio={r} L1={L1} L2={L2} />
        ))}
      </div>
    </div>
  );
}

/* ── Column header row (rendered once per group, aligns with RatioRow grid) ── */

const RATIO_GRID_COLS = "minmax(160px,1.6fr) 64px 76px 78px 88px 100px";

function ColsHeader({ L1, L2 }: { L1: string; L2: string }) {
  return (
    <div
      className="grid gap-1.5 px-3 py-1.5 bg-slate-100/80 dark:bg-slate-800/40 border-y border-slate-200 dark:border-slate-800 text-[9.5px] font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400"
      style={{ gridTemplateColumns: RATIO_GRID_COLS }}
    >
      <div className="text-right">النسبة</div>
      <div className="text-center truncate" title={L1}>{L1}</div>
      <div className="text-center truncate" title={L2}>{L2}</div>
      <div className="text-center">التغير</div>
      <div className="text-center">المعيار 🎯</div>
      <div className="text-center">التقدّم</div>
    </div>
  );
}

/* ── Individual ratio row (grid-based, 6 columns aligned with ColsHeader) ── */

function RatioRow({ ratio, L1, L2 }: { ratio: Ratio; L1: string; L2: string }) {
  const { name, nameEn, formula, v1, v2, unit, benchmark, desirable } = ratio;
  const diff = v1 != null && v2 != null ? Math.round((v2 - v1) * 10000) / 10000 : null;
  const changeStatus = diffStatus(diff, desirable);
  const statusLevel = calcStatusLevel(v2, benchmark, desirable, unit);
  const interp = interpretRatio(ratio);
  const prog = progressInfo(ratio);
  const info = RATIO_INFO[nameEn];

  return (
    <div
      className="grid items-center gap-1.5 px-3 py-1.5 border-t border-slate-100 dark:border-slate-800/60 transition-colors hover:bg-white/50 dark:hover:bg-slate-900/30 odd:bg-slate-50/30 dark:odd:bg-slate-900/10"
      style={{ gridTemplateColumns: RATIO_GRID_COLS }}
    >
      {/* Col 1: ratio name + status pill + nameEn + formula */}
      <div className="min-w-0">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs font-bold text-slate-800 dark:text-slate-100">{name}</span>
          <StatusPill level={statusLevel} />
        </div>
        <p className="mt-0.5 text-[9.5px] text-slate-400 dark:text-slate-500" dir="ltr">{nameEn}</p>
        <p className="mt-0.5 text-[9.5px] text-slate-400 dark:text-slate-500 leading-snug">{formula}</p>
      </div>

      {/* Col 2: v1 — comparative (sits under L1 header) */}
      <div className="text-center">
        <p className="tnum text-xs text-slate-600 dark:text-slate-300">{fmtRatio(v1, unit)}</p>
      </div>

      {/* Col 3: v2 — current, highlighted (sits under L2 header) */}
      <div className="text-center">
        <p className="tnum text-[13.5px] font-extrabold text-slate-800 dark:text-slate-100">{fmtRatio(v2, unit)}</p>
      </div>

      {/* Col 4: change badge (under التغير header) */}
      <div className="flex justify-center">
        <ChangeBadge diff={diff} unit={unit} status={changeStatus} />
      </div>

      {/* Col 5: benchmark pill (under المعيار header) */}
      <div className="flex justify-center">
        {benchmark && (
          <div className="flex items-center gap-1 rounded-lg bg-slate-100/70 px-2.5 py-1 dark:bg-slate-800/50">
            <Target className="size-3 text-slate-400" />
            <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">{benchmark}</span>
          </div>
        )}
      </div>

      {/* Col 6: sparkline + progress gauge (under التقدّم header) */}
      <div className="flex w-full flex-col items-center gap-1 min-w-0">
        <Sparkline v1={v1} v2={v2} desirable={desirable} />
        {prog.targetPct != null ? (
          <ProgressGauge info={prog} />
        ) : v1 == null || v2 == null ? (
          <span className="text-[10px] text-slate-400 dark:text-slate-500">—</span>
        ) : null}
      </div>

      {/* Extras row: explanation + interpretation (spans all 6 cols) */}
      {(info?.explain || interp.text) && (
        <div className="col-span-full mt-1 pt-1 border-t border-dashed border-slate-200 dark:border-slate-800/60 flex gap-1.5 flex-wrap items-start">
          {info?.explain && <ExplanationBox text={info.explain} />}
          {interp.text && <InterpretationPill interp={interp} />}
        </div>
      )}
    </div>
  );
}

/* ── Status pill ──────────────────────────────────────────────────────── */

type StatusLevel = "excellent" | "acceptable" | "weak" | "neutral";

const STATUS_STYLES: Record<StatusLevel, { label: string; cls: string; icon: React.ReactNode }> = {
  excellent: {
    label: "ممتاز",
    cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
    icon: <CheckCircle2 className="size-3" />,
  },
  acceptable: {
    label: "مقبول",
    cls: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
    icon: <AlertTriangle className="size-3" />,
  },
  weak: {
    label: "ضعيف",
    cls: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400",
    icon: <XCircle className="size-3" />,
  },
  neutral: {
    label: "—",
    cls: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
    icon: null,
  },
};

function StatusPill({ level }: { level: StatusLevel }) {
  const s = STATUS_STYLES[level];
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold", s.cls)}>
      {s.icon}
      {s.label}
    </span>
  );
}

/* ── Search toolbar (filter ratios by name/formula/status) ─────────── */

function SearchToolbar({
  query,
  onQueryChange,
  visible,
  total,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  visible: number;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/60 px-2.5 py-2 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="ابحث باسم النسبة، الصيغة، الحالة..."
          className="w-full rounded-md border border-slate-200 bg-white py-1.5 pr-8 pl-3 text-xs text-slate-700 placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:placeholder:text-slate-500"
          aria-label="بحث النسب المالية"
        />
      </div>
      <span
        className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300"
        dir="ltr"
      >
        <span className="tnum">{visible}/{total}</span>
        <span className="text-slate-400">نسبة</span>
      </span>
    </div>
  );
}

/* ── Smart alerts banner (critical threshold violations) ──────────── */

const ALERT_BORDER: Record<Alert["type"], string> = {
  bad: "border-r-rose-500",
  warn: "border-r-amber-500",
  info: "border-r-sky-500",
};

const ALERT_ICO_BG: Record<Alert["type"], string> = {
  bad: "bg-rose-50 dark:bg-rose-950/40",
  warn: "bg-amber-50 dark:bg-amber-950/40",
  info: "bg-sky-50 dark:bg-sky-950/40",
};

function SmartAlertsBanner({ groups }: { groups: RatioGroup[] }) {
  const alerts = generateAlerts(groups);
  if (alerts.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-200/60 bg-gradient-to-br from-amber-50/70 to-transparent p-3 dark:border-amber-800/50 dark:from-amber-950/20">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-extrabold text-amber-800 dark:text-amber-300">
        <Bell className="size-4" />
        تنبيهات ذكية — مؤشرات تستحق الانتباه
        <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white">
          {alerts.length}
        </span>
      </h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {alerts.map((al, i) => (
          <div
            key={i}
            className={cn(
              "flex items-start gap-2 rounded-lg border border-slate-200/60 border-r-2 bg-white p-2 dark:border-slate-700/60 dark:bg-slate-900/40",
              ALERT_BORDER[al.type]
            )}
          >
            <div
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md text-base",
                ALERT_ICO_BG[al.type]
              )}
            >
              {al.ico}
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-extrabold text-slate-800 dark:text-slate-100">{al.title}</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">{al.text}</p>
              <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
                <span className="font-bold text-slate-700 dark:text-slate-200" dir="ltr">{al.value}</span>
                {al.bench ? <span> · المعيار: {al.bench}</span> : null}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Executive summary card (top of card, auto-generated insights) ──── */

function ExecSummaryCard({ groups, L1, L2 }: { groups: RatioGroup[]; L1: string; L2: string }) {
  const insights = generateExecSummary(groups, L1, L2);
  if (insights.length === 0) return null;

  const typeStyles: Record<ExecInsight["type"], string> = {
    good: "border-r-emerald-500 bg-emerald-50/40 dark:bg-emerald-950/20",
    warn: "border-r-amber-500 bg-amber-50/40 dark:bg-amber-950/20",
    bad: "border-r-rose-500 bg-rose-50/40 dark:bg-rose-950/20",
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-transparent p-3 dark:border-slate-800 dark:from-slate-900/40">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-extrabold text-slate-800 dark:text-slate-100">
        <Sparkles className="size-4 text-emerald-500" />
        ملخص تنفيذي للوضع المالي
      </h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {insights.map((ins, i) => (
          <div
            key={i}
            className={cn(
              "flex items-start gap-2 rounded-lg border border-slate-200/60 border-r-2 bg-white p-2 dark:border-slate-700/60 dark:bg-slate-900/40",
              typeStyles[ins.type]
            )}
          >
            <div className="shrink-0 text-slate-700 dark:text-slate-300">
              {INSIGHT_ICONS[ins.icon] ?? <Sparkles className="size-4" />}
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-extrabold text-slate-800 dark:text-slate-100">{ins.title}</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">{ins.text}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Group health bar (segmented bar inside each group header) ─────── */

function GroupHealthBar({ group }: { group: RatioGroup }) {
  const h = calcGroupHealth(group);
  if (h.total === 0) return null;

  const label = h.level === "good" ? "صحي" : h.level === "warn" ? "يحتاج تحسين" : "حرج";
  const scoreCls =
    h.level === "good"
      ? "text-emerald-700 dark:text-emerald-400"
      : h.level === "warn"
        ? "text-amber-700 dark:text-amber-400"
        : "text-rose-700 dark:text-rose-400";

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/50 px-3 py-1 dark:border-slate-800/60 dark:bg-slate-900/30">
      <span className="text-[10px] font-bold text-slate-600 dark:text-slate-300">صحة المجموعة:</span>
      <div className="flex h-2 max-w-[180px] flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        {h.exc > 0 && (
          <div className="h-full bg-emerald-500" style={{ width: `${(h.exc / h.total) * 100}%` }} />
        )}
        {h.acc > 0 && (
          <div className="h-full bg-amber-500" style={{ width: `${(h.acc / h.total) * 100}%` }} />
        )}
        {h.weak > 0 && (
          <div className="h-full bg-rose-500" style={{ width: `${(h.weak / h.total) * 100}%` }} />
        )}
        {h.neu > 0 && (
          <div className="h-full bg-slate-400/40 dark:bg-slate-600/50" style={{ width: `${(h.neu / h.total) * 100}%` }} />
        )}
      </div>
      <span className={cn("text-[10px] font-bold", scoreCls)} dir="ltr">
        {h.score}% · {label} ({h.exc} ممتاز، {h.acc} مقبول، {h.weak} ضعيف)
      </span>
    </div>
  );
}

/* ── Interpretation pill (per-ratio auto-generated interpretation) ─── */

const INTERPRETATION_STYLES: Record<RatioInterpretation["cls"], { cls: string; icon: React.ReactNode }> = {
  good: {
    cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
    icon: <CheckCircle2 className="size-2.5" />,
  },
  warn: {
    cls: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
    icon: <AlertTriangle className="size-2.5" />,
  },
  bad: {
    cls: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400",
    icon: <XCircle className="size-2.5" />,
  },
  neutral: {
    cls: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
    icon: <Minus className="size-2.5" />,
  },
};

function InterpretationPill({ interp }: { interp: RatioInterpretation }) {
  const s = INTERPRETATION_STYLES[interp.cls];
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[9px] font-bold", s.cls)}>
      {s.icon}
      {interp.text}
    </span>
  );
}

/* ── Sparkline (mini v1→v2 trend SVG) ──────────────────────────────── */

function Sparkline({
  v1,
  v2,
  desirable,
}: {
  v1: number | null;
  v2: number | null;
  desirable: "high" | "low";
}) {
  if (v1 == null || v2 == null || Number.isNaN(v1) || Number.isNaN(v2)) return null;

  const vals: [number, number] = [v1, v2];
  const max = Math.max(Math.abs(v1) || 1, Math.abs(v2) || 1);
  const safeMax = max === 0 ? 1 : max;
  const W = 60;
  const H = 18;
  const pad = 3;
  const xs: [number, number] = [pad + 1, W - pad - 1];
  const ys = vals.map((v) => H / 2 - (v / safeMax) * (H / 2 - pad)) as [number, number];

  const diff = v2 - v1;
  let good = false;
  if (desirable === "high") good = diff > 0;
  else if (desirable === "low") good = diff < 0;
  const cls: "good" | "bad" | "neutral" = diff === 0 ? "neutral" : good ? "good" : "bad";
  const colorCls =
    cls === "good"
      ? "text-emerald-500"
      : cls === "bad"
        ? "text-rose-500"
        : "text-slate-400";

  return (
    <svg
      className={cn("block w-full", colorCls)}
      style={{ height: "18px", direction: "ltr" }}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`اتجاه ${cls === "good" ? "إيجابي" : cls === "bad" ? "سلبي" : "ثابت"}`}
    >
      <path
        stroke="currentColor"
        strokeWidth={1.5}
        fill="none"
        d={`M ${xs[0].toFixed(1)} ${ys[0].toFixed(1)} L ${xs[1].toFixed(1)} ${ys[1].toFixed(1)}`}
      />
      <circle cx={xs[0]} cy={ys[0]} r={2} fill="currentColor" opacity={0.5} />
      <circle cx={xs[1]} cy={ys[1]} r={2} fill="currentColor" />
    </svg>
  );
}

/* ── Progress gauge (small bar with target marker) ──────────────────── */

const PROGRESS_BAR_STYLES: Record<ProgressInfo["cls"], string> = {
  good: "bg-gradient-to-l from-emerald-200 to-emerald-500",
  warn: "bg-gradient-to-l from-amber-200 to-amber-500",
  bad: "bg-gradient-to-l from-rose-200 to-rose-500",
  neutral: "bg-slate-400/50",
};

function ProgressGauge({ info }: { info: ProgressInfo }) {
  if (info.targetPct == null) return null;

  return (
    <div className="w-[120px]" dir="ltr">
      <div className="relative h-1.5 overflow-hidden rounded-full border border-slate-200 bg-slate-200/50 dark:border-slate-700 dark:bg-slate-800">
        <div
          className={cn("h-full rounded-full transition-all", PROGRESS_BAR_STYLES[info.cls])}
          style={{ width: `${info.pct}%` }}
        />
        {/* Target marker */}
        <div
          className="absolute inset-y-[-2px] w-0.5 bg-slate-700 opacity-60 dark:bg-slate-300"
          style={{ left: `${info.targetPct}%` }}
        />
      </div>
      <div className="mt-0.5 flex justify-between text-[8px] text-slate-400 dark:text-slate-500">
        <span>0</span>
        <span>المعيار</span>
      </div>
    </div>
  );
}

/* ── Explanation box (plain-language explanation with Lightbulb icon) ── */

function ExplanationBox({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="mt-1 flex items-start gap-1.5 rounded-md border-r-2 border-emerald-400 bg-slate-50 px-2 py-1 dark:border-emerald-600 dark:bg-slate-800/40">
      <Lightbulb className="mt-0.5 size-3 shrink-0 text-emerald-500" />
      <p className="text-[10px] leading-relaxed text-slate-600 dark:text-slate-300">{text}</p>
    </div>
  );
}

/* ── Footer note (explains how to read the report) ─────────────────── */

function FooterNote() {
  return (
    <div className="border-t border-slate-200 bg-slate-50/60 px-4 py-2 dark:border-slate-800 dark:bg-slate-900/40">
      <p className="text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
        <strong className="font-bold text-slate-600 dark:text-slate-300">كيف تقرأ هذا التقرير؟</strong>{" "}
        <strong>الحالة</strong> (ممتاز/مقبول/ضعيف) تقارن القيمة الحالية بالمعيار المرجعي.{" "}
        <strong>التغيّر</strong> يُظهر الفرق بين فترتي المقارنة والحالية بلون أخضر (تحسّن) أو أحمر (تراجع).{" "}
        <strong>المعيار</strong> 🎯 هو النطاق المرجعي للنسبة.{" "}
        <strong>شريط التقدّم</strong> يُظهر مدى قرب القيمة من المعيار (الخط الرأسي).{" "}
        <strong>التفسير</strong> يُقدّم حكماً موجزاً واضحاً لغير المختصين.
      </p>
    </div>
  );
}

/* ── Status level calculator ─────────────────────────────────────────── */

interface ParsedBench {
  lo: number;
  hi: number | null;
  isPercent: boolean;
}

function parseBench(bench?: string): ParsedBench | null {
  if (!bench) return null;
  const s = String(bench).trim();
  const nums = s.match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return null;
  const isPercent = s.indexOf("%") >= 0;
  const lo = parseFloat(nums[0]);
  const hi = nums.length > 1 ? parseFloat(nums[1]) : null;
  return {
    lo: isPercent ? lo / 100 : lo,
    hi: isPercent && hi != null ? hi / 100 : hi,
    isPercent,
  };
}

function calcStatusLevel(
  v2: number | null,
  bench: string | undefined,
  desirable: "high" | "low",
  unit: "ratio" | "percent" | "amount" | "days"
): StatusLevel {
  if (v2 == null || Number.isNaN(v2)) return "neutral";

  if (unit === "amount") {
    if (v2 > 0) return "excellent";
    if (v2 < 0) return "weak";
    return "acceptable";
  }

  const parsed = parseBench(bench);
  if (!parsed) return "neutral";

  const threshold = desirable === "high"
    ? parsed.lo
    : (parsed.hi != null ? parsed.hi : parsed.lo);

  if (desirable === "high") {
    if (v2 >= threshold) return "excellent";
    if (v2 >= threshold * 0.5) return "acceptable";
    return "weak";
  }
  if (v2 <= threshold) return "excellent";
  if (v2 <= threshold * 1.5) return "acceptable";
  return "weak";
}

/* ── Change badge ────────────────────────────────────────────────────── */

type ChangeStatus = "good" | "bad" | "neutral";

function diffStatus(diff: number | null, desirable: "high" | "low"): ChangeStatus {
  if (diff == null || Number.isNaN(diff) || diff === 0) return "neutral";
  if (desirable === "high") return diff > 0 ? "good" : "bad";
  return diff < 0 ? "good" : "bad";
}

function ChangeBadge({ diff, unit, status }: {
  diff: number | null;
  unit: "ratio" | "percent" | "amount" | "days";
  status: ChangeStatus;
}) {
  if (diff == null || Number.isNaN(diff)) {
    return <span className="text-[10px] text-slate-400 dark:text-slate-500">—</span>;
  }
  if (diff === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        <Minus className="size-2.5" /> ثابت
      </span>
    );
  }
  const positive = diff > 0;
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  const cls = status === "good"
    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
    : "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400";

  const sign = positive ? "+" : "−";
  const value = formatDiff(Math.abs(diff), unit);

  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-md px-2 py-0.5 text-[10px] font-bold", cls)} dir="ltr">
      <Icon className="size-2.5" />
      {sign}{value}
    </span>
  );
}

function formatDiff(v: number, unit: "ratio" | "percent" | "amount" | "days"): string {
  if (unit === "percent") return (v * 100).toFixed(1) + " نقطة";
  if (unit === "amount") return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (unit === "days") return v.toFixed(0) + " يوم";
  return v.toFixed(2) + "×";
}

/* ── Quick stat (exported helper) ────────────────────────────────────── */

export function QuickStat({ icon, label, value, sub }: {
  icon: React.ReactNode; label: string; value: string; sub?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white p-2.5 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        {icon ?? <Wallet className="size-4" />}
      </div>
      <div className="min-w-0">
        <div className="tnum text-sm font-extrabold leading-tight text-slate-800 dark:text-slate-100">{value}</div>
        <div className="truncate text-[10px] text-slate-500 dark:text-slate-400">{label}{sub ? <span className="text-slate-400"> · {sub}</span> : null}</div>
      </div>
    </div>
  );
}
