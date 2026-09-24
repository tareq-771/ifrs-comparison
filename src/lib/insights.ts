// Phase 6.11 — التنبيهات والتحليلات الذكية: النواة الحتمية الموحدة (Smart Alerts & Insights).
// تمتد على أساس 6.10 (aging.ts: AgingInsight/severity/kind) — لا محرك ثانٍ.
//
// قواعد صريحة غير قابلة للتفاوض (من نطاق 6.11 §9):
//  - كل رؤية تُميّز: واقعة (FACT) / تحليل (ANALYSIS) / توصية استشارية (RECOMMENDATION).
//  - حتمية بالكامل: نفس المدخلات ⇒ نفس الرؤى بنفس الترتيب.
//  - لا أسباب مخترعة، لا استنتاجات تدقيق، لا تحديد قابلية تحصيل، لا ECL تلقائي،
//    لا ادعاء احتيال، لا رأي مراجعة — التوصية استشارية دائمًا.
//  - بيانات ناقصة تبقى ناقصة (لا صفر) — وتبوّح بذلك بوضوح.
//  - المال BigInt حتمي (نسب bp بلا float للقيم الأصلية).
//  - مصطلح الموازنة سياقي حسب طبيعة البند (أعلى/أقل/تجاوز/وفر/ضمن) — مطابق
//    حرفيًا لمصطلحات display-labels الموحدة.
//  - الرؤى ترث صلاحية/نطاق مصدرها (تُبنى في الخادم من بيانات يستطيع المستخدم
//    رؤيتها أصلًا) — لا تمنح أي وصول جديد.

import type { AgingSeverity, AgingTotals, InsightKind } from "@/lib/aging";

export type InsightSeverity = AgingSeverity;
export type { InsightKind } from "@/lib/aging";

export type InsightModule = "AGING" | "BUDGET" | "TRIAL_BALANCE" | "RECONCILIATION";

export const INSIGHT_MODULE_LABELS: Record<InsightModule, { ar: string; en: string }> = {
  AGING: { ar: "أعمار الديون والتحصيل", en: "Receivables aging & collections" },
  BUDGET: { ar: "الموازنة والمقارنات", en: "Budget & comparisons" },
  TRIAL_BALANCE: { ar: "ميزان المراجعة", en: "Trial balance" },
  RECONCILIATION: { ar: "المطابقة والاكتمال", en: "Reconciliation & completeness" },
};

export interface UnifiedInsight {
  module: InsightModule;
  code: string;
  severity: InsightSeverity;
  kind: InsightKind;
  titleAr: string;
  titleEn: string;
  detailAr: string;
  detailEn: string;
  amountMinor?: string;
  pctBp?: number;
  affectedCount?: number;
  suggestedActionAr?: string;
  suggestedActionEn?: string;
}

export const SEVERITY_RANK: Record<InsightSeverity, number> = {
  CRITICAL: 4,
  IMPORTANT: 3,
  ATTENTION: 2,
  INFO: 1,
};

export const MODULE_ORDER: readonly InsightModule[] = ["AGING", "BUDGET", "TRIAL_BALANCE", "RECONCILIATION"];

export const EMPTY_SEVERITY_COUNTS: Record<InsightSeverity, number> = {
  INFO: 0,
  ATTENTION: 0,
  IMPORTANT: 0,
  CRITICAL: 0,
};

/** عدّ حتمي حسب الخطورة. */
export function countBySeverity(insights: readonly UnifiedInsight[]): Record<InsightSeverity, number> {
  const counts = { ...EMPTY_SEVERITY_COUNTS };
  for (const ins of insights) counts[ins.severity] += 1;
  return counts;
}

/** ترتيب عرض حتمي: الخطورة تنازليًا ثم الوحدة ثم الكود. */
export function sortInsightsForDisplay(insights: readonly UnifiedInsight[]): UnifiedInsight[] {
  return [...insights].sort((a, b) => {
    const s = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (s !== 0) return s;
    const m = MODULE_ORDER.indexOf(a.module) - MODULE_ORDER.indexOf(b.module);
    if (m !== 0) return m;
    return a.code.localeCompare(b.code) || a.titleAr.localeCompare(b.titleAr);
  });
}

/** نسبة bp حتمية من BigInt — null عند مقام صفر (لا NaN/Infinity أبدًا). */
function varianceBp(variance: bigint, base: bigint): number | null {
  if (base === BigInt(0)) return null;
  const absBase = base < BigInt(0) ? base * BigInt(-1) : base;
  const signed = (variance * BigInt(10000)) / absBase;
  // ملاحظة: Number.isFinite لا تُحوّل الأنواع — BigInt يُحوَّل صراحةً قبل الفحص
  // (بدون التحويل كانت تُعيد false دائمًا فتُفقَد النسب كلها).
  if (!Number.isFinite(Number(signed))) return null;
  return Number(signed);
}

// ── رؤى الموازنة (فعلي مقابل موازنة) ────────────────────────────────────────
/** صف إدخال محايد — يطابق حقول VarianceRow من الخدمة (strings minor). */
export interface BudgetVarianceInsightRow {
  statementLineCode: string;
  lineNameAr?: string | null;
  lineNature: string; // REVENUE | EXPENSE | OTHER (أي شيء آخر يُعامل OTHER)
  budgetMinor: string | null;
  actualMinor: string | null;
  favorability: string;
}

/** عتبة "ضمن الموازنة": |فارق| ≤ 5% (500bp) ⇒ ضمن الموازنة. */
export const ON_BUDGET_TOLERANCE_BP = 500;

/**
 * رؤى حتمية من صفوف الفعلي مقابل الموازنة.
 * - بند بلا بيانات مقارنة ⇒ رؤية ناقصة معلنة (تُجمَّع في رؤية واحدة عند التعدد).
 * - بنود OTHER (أصول/التزامات): اتجاه عام فقط "ارتفاع/انخفاض" — بلا حكم زيادة/وفر.
 */
export function budgetVarianceInsights(rows: readonly BudgetVarianceInsightRow[]): UnifiedInsight[] {
  const out: UnifiedInsight[] = [];
  const missingRows: string[] = [];

  for (const row of rows) {
    const label = row.lineNameAr?.trim() ? row.lineNameAr.trim() : row.statementLineCode;
    const budget = toBigIntOrNull(row.budgetMinor);
    const actual = toBigIntOrNull(row.actualMinor);

    if (budget === null || actual === null) {
      missingRows.push(label);
      continue;
    }

    const variance = actual - budget;
    const pctBp = varianceBp(variance, budget);
    const absBp = pctBp === null ? null : Math.abs(pctBp);
    const nature = row.lineNature === "REVENUE" || row.lineNature === "EXPENSE" ? row.lineNature : "OTHER";
    const pctText = absBp === null ? "—" : formatBpText(absBp);

    if (nature === "OTHER") {
      // قاعدة §9: بلا تقييم زيادة/وفر لبنود خارج الإيراد/المصروف — اتجاه عام فقط.
      if (variance === BigInt(0)) {
        out.push({
          module: "BUDGET",
          code: "BUDGET_OTHER_ON_LEVEL",
          severity: "INFO",
          kind: "FACT",
          titleAr: `${label}: بلا تغير عن الموازنة`,
          titleEn: `${label}: no change versus budget`,
          detailAr: `الواقعة: الفعلي يساوي الموازنة لهذا البند (لا فارق).`,
          detailEn: "Fact: actual equals budget for this line (no variance).",
          amountMinor: variance.toString(),
          pctBp: pctBp ?? undefined,
        });
      } else {
        const rising = variance > BigInt(0);
        out.push({
          module: "BUDGET",
          code: rising ? "BUDGET_OTHER_RISE" : "BUDGET_OTHER_FALL",
          severity: "INFO",
          kind: "FACT",
          titleAr: `${label}: ${rising ? "ارتفاع" : "انخفاض"} عن الموازنة`,
          titleEn: `${label}: ${rising ? "above" : "below"} the budget`,
          detailAr: `الواقعة: الفعلي ${rising ? "أعلى" : "أدنى"} من الموازنة بمقدار ${variance.toString()} وحدة صغرى (${pctText}). هذا البند خارج الإيراد/المصروف فلا يُقيَّم بزيادة أو وفر.`,
          detailEn: `Fact: actual is ${rising ? "above" : "below"} budget by ${variance.toString()} minor units (${pctText}). Direction only — no saving/overrun assessment for non-P&L lines.`,
          amountMinor: variance.toString(),
          pctBp: pctBp ?? undefined,
          suggestedActionAr: "توصية استشارية: راجع مصدر البند إن رغبت في فهم سبب الفارق.",
          suggestedActionEn: "Advisory: review the line source if you need to understand the variance.",
        });
      }
      continue;
    }

    if (variance === BigInt(0) || (absBp !== null && absBp <= ON_BUDGET_TOLERANCE_BP)) {
      out.push({
        module: "BUDGET",
        code: nature === "REVENUE" ? "BUDGET_REVENUE_ON" : "BUDGET_EXPENSE_ON",
        severity: "INFO",
        kind: "FACT",
        titleAr: `${label}: ضمن الموازنة`,
        titleEn: `${label}: On Budget`,
        detailAr: `الواقعة: الفارق ${variance.toString()} وحدة صغرى (${pctText}) — ضمن حد التسامح ${ON_BUDGET_TOLERANCE_BP / 100}%.`,
        detailEn: `Fact: variance ${variance.toString()} minor units (${pctText}) — within the ${ON_BUDGET_TOLERANCE_BP / 100}% tolerance.`,
        amountMinor: variance.toString(),
        pctBp: pctBp ?? undefined,
      });
      continue;
    }

    if (nature === "REVENUE") {
      if (variance > BigInt(0)) {
        out.push({
          module: "BUDGET",
          code: "BUDGET_REVENUE_ABOVE",
          severity: "INFO",
          kind: "FACT",
          titleAr: `${label}: أعلى من الموازنة`,
          titleEn: `${label}: Above Budget`,
          detailAr: `الواقعة: الفعلي أعلى من الموازنة بمقدار ${variance.toString()} وحدة صغرى (${pctText}).`,
          detailEn: `Fact: actual is above budget by ${variance.toString()} minor units (${pctText}).`,
          amountMinor: variance.toString(),
          pctBp: pctBp ?? undefined,
          suggestedActionAr: "توصية استشارية: تحقق من اكتمال التسجيل قبل تعميم أي استنتاج.",
          suggestedActionEn: "Advisory: verify recording completeness before generalizing any conclusion.",
        });
      } else {
        out.push({
          module: "BUDGET",
          code: "BUDGET_REVENUE_BELOW",
          severity: "ATTENTION",
          kind: "ANALYSIS",
          titleAr: `${label}: أقل من الموازنة`,
          titleEn: `${label}: Below Budget`,
          detailAr: `الواقعة والتحليل: الفعلي أقل من الموازنة بمقدار ${(variance < BigInt(0) ? variance * BigInt(-1) : variance).toString()} وحدة صغرى (${pctText}) — انخفاض عن المخطط يتطلب مراجعة.`,
          detailEn: `Fact & analysis: actual is below budget by ${variance.toString()} minor units (${pctText}) — a shortfall versus plan worth reviewing.`,
          amountMinor: variance.toString(),
          pctBp: pctBp ?? undefined,
          suggestedActionAr: "توصية استشارية: راجع أسباب الفجوة (توقيت التسجيل، تحقق الموازنة، أداء الفترة) قبل أي إجراء.",
          suggestedActionEn: "Advisory: review the gap drivers (timing, budget realism, period performance) before acting.",
        });
      }
      continue;
    }

    // EXPENSE
    if (variance > BigInt(0)) {
      out.push({
        module: "BUDGET",
        code: "BUDGET_EXPENSE_OVER",
        severity: "ATTENTION",
        kind: "ANALYSIS",
        titleAr: `${label}: تجاوز الموازنة`,
        titleEn: `${label}: Over Budget`,
        detailAr: `الواقعة والتحليل: الفعلي أعلى من الموازنة بمقدار ${variance.toString()} وحدة صغرى (${pctText}) — تجاوز يستحق الفحص.`,
        detailEn: `Fact & analysis: actual exceeds budget by ${variance.toString()} minor units (${pctText}) — an overrun worth examining.`,
        amountMinor: variance.toString(),
        pctBp: pctBp ?? undefined,
        suggestedActionAr: "توصية استشارية: راجع بنود التجاوز وتوقيت الالتزامات مقابل خطة الموازنة.",
        suggestedActionEn: "Advisory: review the overrunning items and commitment timing versus the budget plan.",
      });
    } else {
      out.push({
        module: "BUDGET",
        code: "BUDGET_EXPENSE_SAVING",
        severity: "INFO",
        kind: "FACT",
        titleAr: `${label}: وفر عن الموازنة`,
        titleEn: `${label}: Budget Saving`,
        detailAr: `الواقعة: الفعلي أقل من الموازنة بمقدار ${(variance < BigInt(0) ? variance * BigInt(-1) : variance).toString()} وحدة صغرى (${pctText}) — وفر عن الموازنة حتى تاريخه.`,
        detailEn: `Fact: actual is below budget by ${variance.toString()} minor units (${pctText}) — a saving versus budget to date.`,
        amountMinor: variance.toString(),
        pctBp: pctBp ?? undefined,
        suggestedActionAr: "توصية استشارية: تأكد أن الوفر ليس تأجيل التزامات مستحقة.",
        suggestedActionEn: "Advisory: confirm the saving is not deferred due obligations.",
      });
    }
  }

  if (missingRows.length > 0) {
    out.push({
      module: "BUDGET",
      code: "BUDGET_COMPARISON_DATA_MISSING",
      severity: "INFO",
      kind: "FACT",
      titleAr: "لا تتوفر بيانات للمقارنة",
      titleEn: "No data available for comparison",
      detailAr: `الواقعة: ${missingRows.length === 1 ? "بند واحد" : `${missingRows.length} بنود`} بلا فعلي أو موازنة قابلة للمقارنة: ${missingRows.slice(0, 5).join("، ")}${missingRows.length > 5 ? " وغيرها" : ""}. القيم الناقصة تبقى ناقصة ولا تُعرض صفرًا.`,
      detailEn: `Fact: ${missingRows.length} line(s) lack comparable actual or budget values (e.g. ${missingRows.slice(0, 5).join(", ")}). Missing stays missing — never zero.`,
      affectedCount: missingRows.length,
      suggestedActionAr: "توصية استشارية: أكمل بيانات الفعلي أو اعتمد الموازنة لهذه البنود لتظهر المقارنة.",
      suggestedActionEn: "Advisory: complete actual data or approve the budget for these lines to enable comparison.",
    });
  }

  return sortInsightsForDisplay(out);
}

// ── رؤى اكتمال ميزان المراجعة ───────────────────────────────────────────────
export interface TbReadinessInput {
  hasCommittedTB: boolean;
  unclassifiedCount: number | null; // null = لا معلومة (لا تُخترع)
  totalDebitMinor: string | null;
  totalCreditMinor: string | null;
}

export function tbReadinessInsights(input: TbReadinessInput): UnifiedInsight[] {
  const out: UnifiedInsight[] = [];
  if (!input.hasCommittedTB) {
    out.push({
      module: "TRIAL_BALANCE",
      code: "TB_NO_COMMITTED",
      severity: "INFO",
      kind: "FACT",
      titleAr: "لا يوجد ميزان مراجعة معتمد",
      titleEn: "No committed trial balance",
      detailAr: "الواقعة: لا توجد مراجعة معتمدة لهذه الشركة — القوائم المالية ستعرض حالة بيانات غير مكتملة (INCOMPLETE_DATA) ولن تُخترع أرقام.",
      detailEn: "Fact: no committed revision exists — statements will show INCOMPLETE_DATA and no figures will be invented.",
      suggestedActionAr: "توصية استشارية: استورد واعتمد ميزان مراجعة من تبويب ميزان المراجعة.",
      suggestedActionEn: "Advisory: import and commit a trial balance from the Trial Balance tab.",
    });
    return sortInsightsForDisplay(out);
  }

  if (input.unclassifiedCount != null && input.unclassifiedCount > 0) {
    out.push({
      module: "TRIAL_BALANCE",
      code: "TB_UNCLASSIFIED_ACCOUNTS",
      severity: "ATTENTION",
      kind: "FACT",
      titleAr: "حسابات بحاجة إلى تصنيف",
      titleEn: "Accounts awaiting classification",
      detailAr: `الواقعة: ${input.unclassifiedCount} حسابًا بحاجة إلى تصنيف (NEEDS_CLASSIFICATION) — تُعرض كنص ظاهر ولا تُصنَّف تلقائيًا كبنود أخرى.`,
      detailEn: `Fact: ${input.unclassifiedCount} account line(s) need classification — shown visibly, never auto-classified as OTHER.`,
      affectedCount: input.unclassifiedCount,
      suggestedActionAr: "توصية استشارية: أكمل التصنيف من شاشة ميزان المراجعة قبل إعداد القوائم.",
      suggestedActionEn: "Advisory: complete classification in the Trial Balance screen before preparing statements.",
    });
  }

  const debit = toBigIntOrNull(input.totalDebitMinor);
  const credit = toBigIntOrNull(input.totalCreditMinor);
  if (debit !== null && credit !== null && debit !== credit) {
    out.push({
      module: "RECONCILIATION",
      code: "TB_DEBIT_CREDIT_DIFFERENCE",
      severity: "CRITICAL",
      kind: "FACT",
      titleAr: "فرق بين إجمالي المدين والدائن",
      titleEn: "Debit/credit totals differ",
      detailAr: `الواقعة: إجمالي المدين لا يساوي إجمالي الدائن (الفرق ${(debit < credit ? credit - debit : debit - credit).toString()} وحدة صغرى) — الفرق معلن ولا يُسد تلقائيًا أبدًا.`,
      detailEn: `Fact: total debits do not equal total credits (difference ${debit < credit ? credit - debit : debit - credit} minor units) — disclosed, never auto-plugged.`,
      amountMinor: (debit < credit ? credit - debit : debit - credit).toString(),
      suggestedActionAr: "توصية استشارية: راجع أسطر الميزان وحدث ميزانًا جديدًا قبل الاعتماد.",
      suggestedActionEn: "Advisory: review the TB lines and submit a corrected revision before commit.",
    });
  }
  return sortInsightsForDisplay(out);
}

// ── رؤى حالة أعمار الديون/المطابقة (من اللقطة المعتمدة — بلا تكرار محرك 6.10) ─
export interface AgingStatusInput {
  hasApprovedSnapshot: boolean;
  reconciliationStatus: string | null; // RECONCILED | DIFFERENCE | NO_TB_DATA | NO_RECEIVABLE_MAPPING | INCOMPLETE_DATA
  totals: AgingTotals | null;
}

export function agingStatusInsights(input: AgingStatusInput): UnifiedInsight[] {
  const out: UnifiedInsight[] = [];
  if (!input.hasApprovedSnapshot) {
    out.push({
      module: "AGING",
      code: "AGING_NO_APPROVED_SNAPSHOT",
      severity: "INFO",
      kind: "FACT",
      titleAr: "لا لقطة أعمار معتمدة",
      titleEn: "No approved aging snapshot",
      detailAr: "الواقعة: لم تُعتمد لقطة أعمار بعد — رؤى الأعمار ستتوفر بعد اعتماد لقطة من وحدة أعمار الديون.",
      detailEn: "Fact: no approved aging snapshot yet — aging insights appear after approving a snapshot in the aging module.",
      suggestedActionAr: "توصية استشارية: ارفع ملف أعمار واعتمد لقطة من تبويب أعمار الديون والتحصيل.",
      suggestedActionEn: "Advisory: upload an aging file and approve a snapshot from the aging tab.",
    });
    return sortInsightsForDisplay(out);
  }

  if (input.reconciliationStatus === "DIFFERENCE") {
    out.push({
      module: "RECONCILIATION",
      code: "AGING_RECONCILIATION_DIFFERENCE",
      severity: "IMPORTANT",
      kind: "FACT",
      titleAr: "فرق مطابقة معلن بين الأعمار وميزان المراجعة",
      titleEn: "Disclosed aging-to-TB reconciliation difference",
      detailAr: "الواقعة: إجمالي أعمار الديون لا يطابق رصيد حسابات المدينين في ميزان المراجعة المعتمد — الفرق معلن في تقرير الأعمار ولا يُخفى ولا يُسد.",
      detailEn: "Fact: aging totals do not reconcile to committed receivable accounts — the difference is disclosed, never hidden or plugged.",
      suggestedActionAr: "توصية استشارية: راجع تفاصيل المطابقة في تبويب التحليل داخل وحدة الأعمار.",
      suggestedActionEn: "Advisory: review reconciliation details in the aging module's analysis tab.",
    });
  } else if (input.reconciliationStatus === "NO_TB_DATA") {
    out.push({
      module: "RECONCILIATION",
      code: "AGING_NO_TB_DATA",
      severity: "INFO",
      kind: "FACT",
      titleAr: "لا ميزان مراجعة معتمد لمطابقة الأعمار",
      titleEn: "No committed TB to reconcile aging against",
      detailAr: "الواقعة: المطابقة غير ممكنة لغياب ميزان مراجعة معتمد — الحالة معلنة.",
      detailEn: "Fact: reconciliation is not possible without a committed trial balance — status disclosed.",
    });
  } else if (input.reconciliationStatus === "NO_RECEIVABLE_MAPPING") {
    out.push({
      module: "RECONCILIATION",
      code: "AGING_NO_RECEIVABLE_MAPPING",
      severity: "INFO",
      kind: "FACT",
      titleAr: "لم تُربط حسابات المدينين بعد",
      titleEn: "Receivable accounts not mapped yet",
      detailAr: "الواقعة: لم تُحدَّد حسابات المدينين في إعدادات الأعمار — المطابقة تنتظر الربط.",
      detailEn: "Fact: receivable accounts are not mapped in aging settings — reconciliation awaits mapping.",
      suggestedActionAr: "توصية استشارية: اربط حسابات المدينين من تبويب الإعدادات (لمن يملك الصلاحية).",
      suggestedActionEn: "Advisory: map receivable accounts from settings (requires permission).",
    });
  }
  return sortInsightsForDisplay(out);
}

// ── أدوات ───────────────────────────────────────────────────────────────────
function toBigIntOrNull(v: string | null | undefined): bigint | null {
  if (v == null) return null;
  try {
    const b = BigInt(v);
    return b;
  } catch {
    return null;
  }
}

/** عرض نسبة من bp بنص "12.3%" — أرضية منزلة عشرية واحدة، حتمي. */
function formatBpText(bp: number): string {
  if (!Number.isFinite(bp)) return "—";
  const tenth = Math.floor(bp / 10); // عُشر بالمئة
  return `${tenth / 10}%`;
}
