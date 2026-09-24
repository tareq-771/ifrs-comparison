// Phase 6.9 — خدمة العرض والمقارنة الموحدة (خادم فقط).
//
// المعمارية المعتمدة (تعليمات 6.9-1):
//   ميزان المراجعة المعتمد ← طبقة التطبيع والمحرك الزمني الموحد (trial-balance-data
//   + temporal-aggregation حصرًا — لا محرك تجميع ثانٍ) ← هذه الخدمة (أوضاع عرض +
//   مقارنة) ← عقد موحد ← الواجهة/الطباعة/التصدير.
//
// الضوابط:
//   - القيم من أحدث المراجعات المعتمدة حصرًا (قاعدة 6.3) عبر loadCommittedAccountPoints.
//   - لا نسخ مزدوج لمنطق FLOW/BALANCE — كل القيم عبر دوال trial-balance-data.
//   - نطاق الشركات fail-closed عبر companyVisible (نفس بوابة كل خدمات التقارير).
//   - المقارنة الناقصة حالة معلنة (NO_COMPARISON_DATA / NO_APPROVED_BUDGET /
//     INCOMPLETE_DATA / NOT_COMPARABLE) — لا أصفار مُختلقة إطلاقًا.
//   - وضع BUDGET على مستوى بنود القوائم فقط (الموازنة مخزنة على بنود لا حسابات) —
//     وبمعايرة تقرير فعلي مقابل الموازنة المركزي (getBudgetVariance) حرفيًا:
//     إيراد −net / مصروف +net / أرصدة as-of خام؛ والمبالغ غير الموزعة تدخل YTD
//     (نفس قاعدة الخدمة المركزية).
//   - PRIOR_YEAR_PERIOD بالترتيب الترتيبي (ordinal) في السنة المالية السابقة —
//     بلا افتراض أشهر ميلادية؛ سنة انتقالية بلا فترة مناظرة ⇒ NO_COMPARISON_DATA معلنة.
//   - إعادة استخدام قاعدة ف/غ المركزية favorabilityFor (lib/budget) — لا قاعدة ثانية.

import { db } from "@/lib/db";
import { companyVisible } from "@/lib/company-access";
import { isSupportedCurrency, CURRENCIES } from "@/lib/currencies";
import { TrialBalanceError } from "@/lib/trial-balance";
import {
  loadCommittedAccountPoints,
  loadReportingProvenance,
  netProfitOrLossRangeFromAccounts,
  type AccountPoints,
  type ReportingProvenance,
} from "@/lib/reporting-server";
import {
  balanceAsOfFromPoints,
  flowMonthMovementFromPoints,
  flowYTDFromPoints,
  safeValue,
} from "@/lib/trial-balance-data";
import { presentSignedValue } from "@/lib/statement-builder";
import { deriveAccountHierarchy, descendantCodesOf, HIERARCHY_DERIVATION_NOTE } from "@/lib/account-hierarchy";
import {
  COMPARISON_BASIS_LABELS,
  COMPARISON_MODES,
  PRESENTATION_MODES,
  STATEMENT_MAPPING_DISCLAIMER,
  YTD_MODE_NOTE,
  averageRounded,
  compareRowCore,
  comparisonBasisLabel,
  lineNatureFromClassification,
  type ComparisonMode,
  type ComparisonRowDTO,
  type ComparisonValueStatus,
  type PresentationMode,
  type StatementScope,
} from "@/lib/comparison-engine";
import {
  bilingual,
  normalizeReportLanguage,
  statementLineLabel,
  type ReportLanguage,
} from "@/lib/display-labels";
import { formatMinor, minorUnitsFor } from "@/lib/money";
import type { SessionUser } from "@/lib/session";

function fail(code: import("@/lib/trial-balance").TrialBalanceErrorCode, message: string): never {
  throw new TrialBalanceError(code, message);
}

/* ──────────────────────────────────────────────────────────────────────────
 * العقد الموحد (6.9-14 — مُكيَّف على اصطلاحات المشروع: minor كسلاسل نصية)
 * شكل الصف الموحد معرّف في المحرك النقي (comparison-engine) ويُعاد تصديره هنا
 * ليكون مسار الاستيراد الوحيد لطبقة الخادم.
 * ────────────────────────────────────────────────────────────────────────── */

export type { ComparisonRowDTO };

export interface ComparisonTotalDTO {
  key: string;
  label: string;
  amount: string | null;
  status: ComparisonValueStatus;
  comparisonAmount?: string | null;
  comparisonStatus?: ComparisonValueStatus;
  varianceAmount?: string | null;
  variancePercent?: string | null;
  direction?: string;
  sourceAccountCodes: string[];
}

export interface StatementComparisonResult {
  company: { code: string; nameAr: string; currency: string | null; currencyLabel: string | null };
  fiscalYear: { id: string; code: string; displayNameAr: string; startDate: string; endDate: string };
  period: { ordinal: number; startDate: string; endDate: string; displayLabel: string };
  statementScope: StatementScope;
  basis: "YTD" | "PERIOD";
  presentationMode: PresentationMode;
  /** لغة التقرير المستخدمة في النصوص المعروضة (أساس ثنائي اللغة 6.9R-E). */
  reportLanguage: ReportLanguage;
  accountLevel: number | null;
  hierarchyMaxLevel: number | null;
  comparisonMode: ComparisonMode;
  comparisonTarget: {
    label: string;
    basisLabel: string;
    fiscalYearCode?: string;
    ordinal?: number;
    fromDate: string | null;
    toDate: string | null;
  } | null;
  /** الحالة الإجمالية الصادقة للتقرير (ترويسة). */
  status: "OK" | "INCOMPLETE_DATA" | "NO_COMPARISON_DATA" | "NO_APPROVED_BUDGET";
  statusDetail: string | null;
  notes: string[];
  rows: ComparisonRowDTO[];
  totals: ComparisonTotalDTO[];
  summary: { accounts: number; incomplete: number; unclassified: number; flagged: number };
  provenance: ReportingProvenance;
}

/* ──────────────────────────────────────────────────────────────────────────
 * مساعدات داخلية
 * ────────────────────────────────────────────────────────────────────────── */

interface ScopeAccount {
  accountCode: string;
  accountName: string;
  mappingStatus: string | null;
  classification: string | null;
  behavior: "FLOW" | "BALANCE";
  statementLineCode: string | null;
  points: AccountPoints["points"];
  /** قيم السنة السابقة للمناظر بالكود (PRIOR_YEAR_PERIOD فقط). */
  priorPoints?: AccountPoints["points"];
}

type ValueResult = { status: ComparisonValueStatus; valueMinor: bigint | null };

interface AccountValues {
  account: ScopeAccount;
  current: ValueResult;
  comparison: ValueResult;
}

const ok = (v: bigint): ValueResult => ({ status: "OK", valueMinor: v });
const incomplete = (): ValueResult => ({ status: "INCOMPLETE_DATA", valueMinor: null });
const noData = (): ValueResult => ({ status: "NO_COMPARISON_DATA", valueMinor: null });
const notComparable = (): ValueResult => ({ status: "NOT_COMPARABLE", valueMinor: null });

/** قيمة محاسبية عند ordinal بدلالة السلوك المخزن — عبر الجسور المركزية حصرًا. */
function valueAt(points: AccountPoints["points"], behavior: "FLOW" | "BALANCE", ordinal: number, basis: "YTD" | "PERIOD"): ValueResult {
  const r = safeValue(
    () =>
      behavior === "BALANCE"
        ? balanceAsOfFromPoints(points, ordinal)
        : basis === "YTD"
          ? flowYTDFromPoints(points, ordinal)
          : flowMonthMovementFromPoints(points, ordinal),
    behavior === "BALANCE" ? "الرصيد" : "الحركة"
  );
  return r.status === "OK" && r.valueMinor !== null ? ok(r.valueMinor) : incomplete();
}

/** تجميع صارم: القيمة المجمعة موجودة فقط إذا كانت كل قيم المصادر موجودة (لا اكتمال جزئي). */
function strictSum(values: ValueResult[], presentation?: (raw: bigint, classification: string | null) => bigint, classifications?: Array<string | null>): ValueResult {
  if (values.length === 0) return incomplete();
  let total = BigInt(0);
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v.status !== "OK" || v.valueMinor === null) return incomplete();
    total += presentation && classifications ? presentation(v.valueMinor, classifications[i]) : v.valueMinor;
  }
  return ok(total);
}

/** إيجاد السنة المالية السابقة بالترتيب (أحدث سنة تبدأ قبل السنة الحالية) — بلا افتراض تقويمي. */
interface PriorFiscalYearLite { id: string; code: string; displayNameAr: string; startDate: string; endDate: string; periodCount: number }
async function findPriorFiscalYear(companyId: string, currentStartDate: string): Promise<PriorFiscalYearLite | null> {
  const candidates = await db.fiscalYear.findMany({
    where: { companyId, startDate: { lt: currentStartDate } },
    orderBy: { startDate: "desc" },
    take: 1,
    select: { id: true, code: true, displayNameAr: true, startDate: true, endDate: true, periodCount: true },
  });
  return candidates.length > 0 ? candidates[0] : null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * الخدمة الرئيسية
 * ────────────────────────────────────────────────────────────────────────── */

export interface StatementComparisonArgs {
  user: SessionUser;
  input: {
    companyId?: unknown;
    fiscalYearId?: unknown;
    ordinal?: unknown;
    basis?: unknown;
    statementScope?: unknown;
    presentationMode?: unknown;
    accountLevel?: unknown;
    comparisonMode?: unknown;
    /** لغة التقرير (أساس ثنائي اللغة 6.9R-E) — مستقلة عن لغة واجهة النظام. */
    reportLanguage?: unknown;
  };
}

export async function getStatementComparison({ user, input }: StatementComparisonArgs): Promise<StatementComparisonResult> {
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  const fiscalYearId = typeof input.fiscalYearId === "string" ? input.fiscalYearId.trim() : "";
  if (!companyId || !fiscalYearId) fail("COMPANY_REQUIRED", "الشركة والسنة المالية إلزاميتان.");
  if (!companyVisible(user, companyId)) fail("NOT_FOUND", "لا تملك الوصول لهذه الشركة.");

  const fy = await db.fiscalYear.findUnique({
    where: { id: fiscalYearId },
    select: { id: true, companyId: true, code: true, displayNameAr: true, startDate: true, endDate: true, periodCount: true },
  });
  if (!fy || fy.companyId !== companyId) fail("FISCAL_YEAR_NOT_FOUND", "السنة المالية غير موجودة لهذه الشركة.");
  const ordinal = Number(input.ordinal);
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > fy.periodCount) {
    fail("INVALID_DATE_RANGE", `الفترة خارج مدى السنة المالية (1..${fy.periodCount}).`);
  }
  const period = await db.fiscalPeriod.findUnique({
    where: { fiscalYearId_ordinal: { fiscalYearId, ordinal } },
    select: { id: true, ordinal: true, startDate: true, endDate: true, displayLabel: true },
  });
  if (!period) fail("FISCAL_YEAR_NOT_FOUND", `فترة #${ordinal} غير معرفة في هذه السنة المالية.`);

  const basis: "YTD" | "PERIOD" = input.basis === "PERIOD" ? "PERIOD" : "YTD";
  const statementScope: StatementScope =
    input.statementScope === "STATEMENT_OF_FINANCIAL_POSITION" ? "STATEMENT_OF_FINANCIAL_POSITION" : "PROFIT_OR_LOSS";
  const presentationMode: PresentationMode =
    typeof input.presentationMode === "string" && (Object.values(PRESENTATION_MODES) as string[]).includes(input.presentationMode)
      ? (input.presentationMode as PresentationMode)
      : PRESENTATION_MODES.STATEMENT_MAPPING;
  const comparisonMode: ComparisonMode =
    typeof input.comparisonMode === "string" && (Object.values(COMPARISON_MODES) as string[]).includes(input.comparisonMode)
      ? (input.comparisonMode as ComparisonMode)
      : COMPARISON_MODES.NONE;

  const [company, accountsMap] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { code: true, nameAr: true, functionalCurrency: true } }),
    loadCommittedAccountPoints(companyId, fiscalYearId),
  ]);
  if (!company) fail("NOT_FOUND", "الشركة غير موجودة.");

  /* ── لغة التقرير + منسّق المبالغ (جولة المراجعة E/H) ──
   *  العملة تُذكر في النص فقط إذا كانت موثقة للشركة (لا تخمين) —
   *  والتنسيق عرض حصرًا: لا يمس أي حسابية BigInt إطلاقًا. */
  const reportLang: ReportLanguage = normalizeReportLanguage(input.reportLanguage);
  const currencyCode =
    typeof company.functionalCurrency === "string" && isSupportedCurrency(company.functionalCurrency)
      ? company.functionalCurrency
      : null;
  const minorUnits = minorUnitsFor(currencyCode);
  const formatAmount = (minor: string): string =>
    currencyCode ? `${formatMinor(minor, minorUnits)} ${currencyCode}` : formatMinor(minor, minorUnits);
  // سياق المرجع: الموازنة ⇒ صياغة الموازنة السياقية، غيره ⇒ محايد، بلا مقارنة ⇒ null
  const basisKind: "BUDGET" | "PERIOD" | null =
    comparisonMode === COMPARISON_MODES.NONE ? null : comparisonMode === COMPARISON_MODES.BUDGET ? "BUDGET" : "PERIOD";
  const rowBasisLabel = comparisonBasisLabel(comparisonMode, reportLang);

  const notes: string[] = [];
  const hierarchyModes =
    presentationMode === PRESENTATION_MODES.MAIN_ACCOUNTS ||
    presentationMode === PRESENTATION_MODES.LEAF_ACCOUNTS ||
    presentationMode === PRESENTATION_MODES.ACCOUNT_LEVEL;

  /* ── نطاق الحسابات (بيانات محركة من التصنيف — بلا hard-code) ──
   * ثلاث حالات:
   *  - تصنيف ضمن نطاق القائمة ⇒ scopeAccounts.
   *  - تصنيف null (غير مصنف) ⇒ unclassifiedAccounts — صفوف معلنة بعلامة UNCLASSIFIED.
   *  - تصنيف لنطاق القائمة الأخرى (مثل أصول في قائمة الربح) ⇒ يُستبعد كليًا —
   *    ينتمي لقائمته الخاصة ولا يُعد ناقصًا هنا ولا يُكرر. */
  const scopeClassifications =
    statementScope === "PROFIT_OR_LOSS" ? (["REVENUE", "EXPENSE"] as const) : (["ASSET", "LIABILITY", "EQUITY"] as const);
  const scopeAccounts: ScopeAccount[] = [];
  const unclassifiedAccounts: ScopeAccount[] = [];
  for (const acc of Array.from(accountsMap.values()).sort((a, b) => a.accountCode.localeCompare(b.accountCode))) {
    if (acc.classification !== null && (scopeClassifications as readonly string[]).includes(acc.classification)) {
      scopeAccounts.push({
        accountCode: acc.accountCode,
        accountName: acc.accountName,
        mappingStatus: acc.mappingStatus,
        classification: acc.classification,
        behavior: acc.aggregationBehavior === "BALANCE" ? "BALANCE" : "FLOW",
        statementLineCode: acc.statementLineCode,
        points: acc.points,
      });
    } else if (acc.classification === null) {
      unclassifiedAccounts.push({
        accountCode: acc.accountCode,
        accountName: acc.accountName,
        mappingStatus: acc.mappingStatus,
        classification: acc.classification,
        behavior: acc.aggregationBehavior === "BALANCE" ? "BALANCE" : "FLOW",
        statementLineCode: acc.statementLineCode,
        points: acc.points,
      });
    }
  }

  /* ── هدف المقارنة ── */
  let priorFy: Awaited<ReturnType<typeof findPriorFiscalYear>> = null;
  let priorPeriodOrdinal: number | null = null;
  let comparisonTarget: StatementComparisonResult["comparisonTarget"] = null;
  let targetFullyMissing = false;
  let targetDetail: string | null = null;
  let priorAccountsMap: Map<string, AccountPoints> | null = null;

  if (comparisonMode === COMPARISON_MODES.PRIOR_PERIOD) {
    if (ordinal <= 1) {
      targetFullyMissing = true;
      targetDetail = "الفترة الأولى في السنة المالية — لا توجد فترة سابقة بنفس التسلسل.";
    } else {
      priorPeriodOrdinal = ordinal - 1;
      const p = await db.fiscalPeriod.findUnique({
        where: { fiscalYearId_ordinal: { fiscalYearId, ordinal: priorPeriodOrdinal } },
        select: { ordinal: true, startDate: true, endDate: true, displayLabel: true },
      });
      comparisonTarget = p
        ? {
            label: `الفترة السابقة: فترة ${p.ordinal}${p.displayLabel ? ` — ${p.displayLabel}` : ""}`,
            basisLabel: COMPARISON_BASIS_LABELS.PRIOR_PERIOD,
            ordinal: p.ordinal,
            fromDate: p.startDate,
            toDate: p.endDate,
          }
        : null;
      if (!comparisonTarget) {
        targetFullyMissing = true;
        targetDetail = `فترة #${priorPeriodOrdinal} غير معرفة في هذه السنة المالية.`;
      }
    }
  } else if (comparisonMode === COMPARISON_MODES.PRIOR_YEAR_PERIOD) {
    priorFy = await findPriorFiscalYear(companyId, fy.startDate);
    if (!priorFy) {
      targetFullyMissing = true;
      targetDetail = "لا توجد سنة مالية سابقة لهذه الشركة — المقارنة المناظرة غير متاحة.";
    } else {
      const p = await db.fiscalPeriod.findUnique({
        where: { fiscalYearId_ordinal: { fiscalYearId: priorFy.id, ordinal } },
        select: { ordinal: true, startDate: true, endDate: true, displayLabel: true },
      });
      if (!p) {
        targetFullyMissing = true;
        targetDetail = `السنة السابقة (${priorFy.code}) سنة انتقالية بلا فترة مناظرة بالترتيب (${ordinal} من ${priorFy.periodCount}) — لا مقارنة مُختلقة.`;
      } else {
        priorAccountsMap = await loadCommittedAccountPoints(companyId, priorFy.id);
        comparisonTarget = {
          label: `الفترة المناظرة من السنة السابقة: ${priorFy.code} فترة ${p.ordinal}${p.displayLabel ? ` — ${p.displayLabel}` : ""}`,
          basisLabel: COMPARISON_BASIS_LABELS.PRIOR_YEAR_PERIOD,
          fiscalYearCode: priorFy.code,
          ordinal: p.ordinal,
          fromDate: p.startDate,
          toDate: p.endDate,
        };
      }
    }
  } else if (comparisonMode === COMPARISON_MODES.YTD || comparisonMode === COMPARISON_MODES.YTD_AVERAGE) {
    const firstPeriod = await db.fiscalPeriod.findUnique({
      where: { fiscalYearId_ordinal: { fiscalYearId, ordinal: 1 } },
      select: { startDate: true },
    });
    comparisonTarget = {
      label: comparisonMode === COMPARISON_MODES.YTD
        ? `التراكمي من بداية السنة المالية (فترة 1 حتى ${ordinal})`
        : `متوسط التراكمي للفترات 1..${ordinal}`,
      basisLabel: COMPARISON_BASIS_LABELS[comparisonMode],
      ordinal,
      fromDate: firstPeriod?.startDate ?? fy.startDate,
      toDate: period.endDate,
    };
    notes.push(YTD_MODE_NOTE);
  }

  /* ── الموازنة (وضع BUDGET — على مستوى بنود القوائم حصرًا) ── */
  const budgetMode = comparisonMode === COMPARISON_MODES.BUDGET;
  let budgetMissing = false;
  let budgetByLine = new Map<string, bigint>();
  let budgetMeta: { id: string; versionNumber: number; scenario: string; status: string; budgetType: string } | null = null;
  if (budgetMode) {
    if (presentationMode !== PRESENTATION_MODES.STATEMENT_MAPPING) {
      targetFullyMissing = true;
      targetDetail =
        "الموازنة مخزنة على مستوى بنود القوائم المالية فقط — اختر عرض «حسب تصنيف القوائم المالية» للمقارنة مع الموازنة (لا تُوزَّع الموازنة على حسابات تفصيلية بلا قواعد توزيع).";
    } else {
      const budget = await db.budget.findFirst({
        where: { companyId, fiscalYearId, status: { in: ["APPROVED", "LOCKED"] } },
        orderBy: { versionNumber: "desc" },
        include: { lines: true },
      });
      if (!budget) {
        budgetMissing = true;
        targetDetail = "لا توجد موازنة معتمدة/مقفلة لهذه الشركة والسنة المالية (المسودات لا تدخل التقارير).";
      } else {
        budgetMeta = { id: budget.id, versionNumber: budget.versionNumber, scenario: budget.scenario, status: budget.status, budgetType: budget.budgetType };
        // نطاق الفترات + قاعدة المبالغ غير الموزعة = نفس قاعدة getBudgetVariance المركزية حرفيًا
        const range = basis === "YTD" ? { startOrdinal: 1, endOrdinal: ordinal } : { startOrdinal: ordinal, endOrdinal: ordinal };
        const periodIdsInRange = new Set(
          (await db.fiscalPeriod.findMany({ where: { fiscalYearId, ordinal: { gte: range.startOrdinal, lte: range.endOrdinal } }, select: { id: true } })).map((p) => p.id)
        );
        for (const l of budget.lines) {
          const inRange = l.fiscalPeriodId ? periodIdsInRange.has(l.fiscalPeriodId) : basis === "YTD";
          if (!inRange) continue;
          budgetByLine.set(l.statementLineCode, (budgetByLine.get(l.statementLineCode) ?? BigInt(0)) + l.amountMinor);
        }
        comparisonTarget = {
          label: `الموازنة المعتمدة نسخة #${budget.versionNumber} (${budget.scenario})`,
          basisLabel: COMPARISON_BASIS_LABELS.BUDGET,
          fromDate: fy.startDate,
          toDate: period.endDate,
        };
      }
    }
  }

  /* ── قيم كل حساب (الحالي + المقارنة) ── */
  // معايرة القيمة لكل حساب: أوضاع الموازنة تتبع معايرة تقرير AvB المركزي
  // (إيراد − / مصروف + / أرصدة خام)؛ باقي الأوضاع تتبع قاعدة عرض القوائم (presentSignedValue).
  const avbNormalize = (raw: bigint, classification: string | null): bigint =>
    classification === "REVENUE" ? -raw : raw;

  const computeAccount = (acc: ScopeAccount): AccountValues => {
    let current = valueAt(acc.points, acc.behavior, ordinal, basis);
    let comparison: ValueResult;

    if (comparisonMode === COMPARISON_MODES.NONE) {
      comparison = notComparable();
    } else if (comparisonMode === COMPARISON_MODES.PRIOR_PERIOD) {
      comparison = comparisonTarget && priorPeriodOrdinal ? valueAt(acc.points, acc.behavior, priorPeriodOrdinal, basis) : noData();
    } else if (comparisonMode === COMPARISON_MODES.PRIOR_YEAR_PERIOD) {
      comparison =
        comparisonTarget && priorAccountsMap
          ? (() => {
              const prior = priorAccountsMap!.get(acc.accountCode);
              if (!prior) return noData(); // حساب غائب في السنة السابقة — لا صفر صامت
              const priorPoints = prior.points;
              return valueAt(priorPoints, acc.behavior, ordinal, basis);
            })()
          : noData();
    } else if (comparisonMode === COMPARISON_MODES.YTD || comparisonMode === COMPARISON_MODES.YTD_AVERAGE) {
      if (acc.behavior === "BALANCE") {
        // مقارنة التراكمي بلا معنى لحساب رصيد — تُعلن ولا تُختلق
        comparison = notComparable();
      } else {
        // دلالة الوضع: الحالي = حركة الفترة، المقارنة = التراكمي حتى الفترة
        const movement = safeValue(() => flowMonthMovementFromPoints(acc.points, ordinal), "حركة الفترة");
        const ytd = safeValue(() => flowYTDFromPoints(acc.points, ordinal), "التراكمي");
        current = movement.status === "OK" && movement.valueMinor !== null ? ok(movement.valueMinor) : incomplete();
        if (movement.status !== "OK" || movement.valueMinor === null) {
          comparison = incomplete();
        } else if (ytd.status !== "OK" || ytd.valueMinor === null) {
          comparison = incomplete();
        } else if (comparisonMode === COMPARISON_MODES.YTD) {
          comparison = ok(ytd.valueMinor);
        } else {
          comparison = ok(averageRounded(ytd.valueMinor, ordinal)); // متوسط مقرّب لأقرب minor
        }
      }
    } else {
      // BUDGET: تُحسب على مستوى البنود لاحقًا — مستوى الحساب يبقى غير قابل للمقارنة هنا
      comparison = notComparable();
    }
    return { account: acc, current, comparison };
  };

  const allValues: AccountValues[] = [...scopeAccounts, ...unclassifiedAccounts].map(computeAccount);
  const valuesByCode = new Map(allValues.map((v) => [v.account.accountCode, v]));

  /* ── بناء الصفوف حسب وضع العرض ── */
  const rows: ComparisonRowDTO[] = [];
  const presentationSign = (raw: bigint, classification: string | null) =>
    budgetMode ? avbNormalize(raw, classification) : (presentSignedValue(raw, classification) ?? raw);

  const makeAccountRow = (av: AccountValues, opts: { kind: ComparisonRowDTO["kind"]; label: string; depth: number; level: number | null; sourceCodes: string[] }): ComparisonRowDTO => {
    const acc = av.account;
    const nature = lineNatureFromClassification(acc.classification);
    // الحالي/المقارنة على مستوى الحساب: معايرة العرض تُطبق داخل strictSum عند التجميع؛
    // للحساب المفرد نطبقها هنا مباشرة.
    const cur = av.current.status === "OK" && av.current.valueMinor !== null
      ? ok(presentationSign(av.current.valueMinor, acc.classification))
      : av.current;
    const cmp = av.comparison.status === "OK" && av.comparison.valueMinor !== null
      ? ok(presentationSign(av.comparison.valueMinor, acc.classification))
      : av.comparison;
    const core = compareRowCore({
      currentMinor: cur.valueMinor,
      currentStatus: cur.status,
      comparisonMinor: cmp.valueMinor,
      comparisonStatus: cmp.status,
      lineNature: nature,
      mappingStatus: acc.mappingStatus,
      basisLabel: rowBasisLabel,
      basisKind,
      rowNoun: acc.accountName || null,
      lang: reportLang,
      formatAmount,
    });
    return {
      key: `${opts.kind.toLowerCase()}-${acc.accountCode || "blank"}`,
      label: opts.label,
      kind: opts.kind,
      depth: opts.depth,
      level: opts.level,
      accountCode: acc.accountCode || null,
      statementLineCode: acc.statementLineCode,
      mappingStatus: acc.mappingStatus,
      lineNature: nature,
      currentAmount: cur.valueMinor?.toString() ?? null,
      currentStatus: cur.status,
      comparisonAmount: cmp.valueMinor?.toString() ?? null,
      comparisonStatus: cmp.status,
      varianceAmount: core.varianceMinor,
      variancePercent: core.variancePercent,
      direction: core.direction,
      favorability: core.favorability,
      factText: core.factText,
      interpretationText: core.interpretationText,
      reviewGuidance: core.reviewGuidance,
      flags: core.flags,
      sourceAccountCodes: opts.sourceCodes,
    };
  };

  if (presentationMode === PRESENTATION_MODES.STATEMENT_MAPPING) {
    const lineMeta = await db.financialStatementLine.findMany({
      where: { isActive: true },
      orderBy: [{ statementType: "asc" }, { displayOrder: "asc" }],
      select: { code: true, nameAr: true, nameEn: true, statementType: true, displayOrder: true },
    });
    const scopeLineTypes = statementScope === "PROFIT_OR_LOSS" ? ["PROFIT_OR_LOSS", "OTHER_COMPREHENSIVE_INCOME"] : ["STATEMENT_OF_FINANCIAL_POSITION"];
    const metaByCode = new Map(lineMeta.filter((m) => scopeLineTypes.includes(m.statementType)).map((m) => [m.code, m]));
    const byLine = new Map<string, ScopeAccount[]>();
    const unattached: ScopeAccount[] = [];
    for (const acc of scopeAccounts) {
      const code = acc.statementLineCode && metaByCode.has(acc.statementLineCode) ? acc.statementLineCode : null;
      if (code) (byLine.get(code) ?? byLine.set(code, []).get(code)!).push(acc);
      else unattached.push(acc);
    }
    const orderedCodes = Array.from(metaByCode.keys()).filter((c) => byLine.has(c));

    const buildLineRow = (code: string): ComparisonRowDTO => {
      const members = byLine.get(code)!;
      const meta = metaByCode.get(code)!;
      const sourceCodes = members.map((m) => m.accountCode);
      const memberValues = members.map((m) => valuesByCode.get(m.accountCode)!);
      // طبيعة البند: إيراد إن كان كل المصنّفين إيرادًا، مصروف إن كان كلهم مصروفًا، وإلا OTHER —
      // نفس دلالة الخدمة المركزية (تصنيف الحسابات المربوطة بلا hard-code).
      const hasRev = members.some((m) => m.classification === "REVENUE");
      const hasExp = members.some((m) => m.classification === "EXPENSE");
      const lineNature: "REVENUE" | "EXPENSE" | "OTHER" = hasRev && !hasExp ? "REVENUE" : hasExp && !hasRev ? "EXPENSE" : "OTHER";
      const cur = strictSum(memberValues.map((v) => v.current), presentationSign, members.map((m) => m.classification));
      let cmp: ValueResult;
      if (!budgetMode) {
        cmp = comparisonMode === COMPARISON_MODES.NONE
          ? notComparable()
          : strictSum(memberValues.map((v) => v.comparison), presentationSign, members.map((m) => m.classification));
      } else if (budgetMissing) {
        cmp = { status: "NO_APPROVED_BUDGET", valueMinor: null };
      } else if (budgetByLine.has(code)) {
        cmp = ok(budgetByLine.get(code)!);
      } else {
        cmp = noData(); // لا بند موازنة لهذا البند — لا صفر مُختلق
      }
      const core = compareRowCore({
        currentMinor: cur.valueMinor,
        currentStatus: cur.status,
        comparisonMinor: cmp.valueMinor,
        comparisonStatus: cmp.status,
        lineNature,
        mappingStatus: members.every((m) => m.mappingStatus === "FULLY_MAPPED") ? "FULLY_MAPPED" : (members.find((m) => m.mappingStatus !== "FULLY_MAPPED")?.mappingStatus ?? null),
        basisLabel: rowBasisLabel,
        basisKind,
        rowNoun: statementLineLabel(code, reportLang, meta.nameAr, meta.nameEn),
        lang: reportLang,
        formatAmount,
      });
      return {
        key: `line-${code}`,
        label: statementLineLabel(code, reportLang, meta.nameAr, meta.nameEn),
        kind: "LINE",
        depth: 0,
        level: null,
        accountCode: null,
        statementLineCode: code,
        mappingStatus: null,
        lineNature,
        currentAmount: cur.valueMinor?.toString() ?? null,
        currentStatus: cur.status,
        comparisonAmount: cmp.valueMinor?.toString() ?? null,
        comparisonStatus: cmp.status,
        varianceAmount: core.varianceMinor,
        variancePercent: core.variancePercent,
        direction: core.direction,
        favorability: core.favorability,
        factText: core.factText,
        interpretationText: core.interpretationText,
        reviewGuidance: core.reviewGuidance,
        flags: core.flags,
        sourceAccountCodes: sourceCodes,
        accounts: members.map((m) => {
          const v = valuesByCode.get(m.accountCode)!;
          const signed = v.current.status === "OK" && v.current.valueMinor !== null
            ? presentationSign(v.current.valueMinor, m.classification)
            : null;
          return { accountCode: m.accountCode, accountName: m.accountName, valueMinor: signed === null ? null : signed.toString() };
        }),
      };
    };

    for (const code of orderedCodes) rows.push(buildLineRow(code));
    for (const acc of unattached) {
      const av = valuesByCode.get(acc.accountCode)!;
      const row = makeAccountRow(av, {
        kind: "UNATTACHED",
        label: `${acc.accountName || acc.accountCode} (بلا بند قائمة)`,
        depth: 0,
        level: null,
        sourceCodes: [acc.accountCode],
      });
      if (budgetMode && !budgetMissing) {
        row.comparisonStatus = "NO_COMPARISON_DATA";
        row.comparisonAmount = null;
        row.varianceAmount = null;
        row.variancePercent = null;
        row.direction = "NOT_COMPARABLE";
        row.favorability = "NO_FAVORABLE_UNFAVORABLE";
        row.factText = "حساب بلا بند قائمة لا يدخل مقارنة الموازنة — صنّفه من دليل الحسابات.";
      }
      rows.push(row);
    }
    if (STATEMENT_MAPPING_DISCLAIMER) notes.push(STATEMENT_MAPPING_DISCLAIMER);
  } else {
    /* ── أوضاع الهرمية/كل الحسابات ── */
    const allScope = [...scopeAccounts, ...unclassifiedAccounts];
    const codes = allScope.map((a) => a.accountCode);
    const hierarchy = deriveAccountHierarchy(codes);
    if (hierarchyModes) {
      notes.push(HIERARCHY_DERIVATION_NOTE);
      if (hierarchy.anomalies.length > 0) {
        notes.push(`أكواد غير قابلة للوضع في الهرمية (${hierarchy.anomalies.length}) — معلنة ولا تُهمَل ولا تُخترع لها هرمية.`);
      }
    }

    const accountLabel = (a: ScopeAccount) => `${a.accountCode} — ${a.accountName || "(بلا اسم)"}`;

    if (presentationMode === PRESENTATION_MODES.ALL_ACCOUNTS) {
      for (const acc of allScope) {
        const av = valuesByCode.get(acc.accountCode)!;
        rows.push(makeAccountRow(av, { kind: "ACCOUNT", label: accountLabel(acc), depth: 0, level: hierarchy.levelOf.get(acc.accountCode) ?? null, sourceCodes: [acc.accountCode] }));
      }
    } else if (presentationMode === PRESENTATION_MODES.LEAF_ACCOUNTS) {
      for (const code of hierarchy.leaves) {
        const acc = allScope.find((a) => a.accountCode === code)!;
        const av = valuesByCode.get(code)!;
        rows.push(makeAccountRow(av, { kind: "ACCOUNT", label: accountLabel(acc), depth: 0, level: hierarchy.levelOf.get(code) ?? null, sourceCodes: [code] }));
      }
      for (const anom of hierarchy.anomalies) {
        rows.push(unhierarchizedRow(anom, allScope, valuesByCode, makeAccountRow));
      }
    } else if (presentationMode === PRESENTATION_MODES.MAIN_ACCOUNTS) {
      // شجرة كاملة: الجذور ثم الأبناء (DFS) — العقد الرئيسية تجمعها وأبناءها
      const dfs = (code: string, depth: number) => {
        const acc = allScope.find((a) => a.accountCode === code)!;
        const av = valuesByCode.get(code)!;
        const descendants = descendantCodesOf(code, hierarchy.codes);
        const sourceCodes = [code, ...descendants];
        const isMain = descendants.length > 0;
        if (isMain) {
          const memberValues = sourceCodes.map((c) => valuesByCode.get(c)!).filter(Boolean);
          const classifications = sourceCodes.map((c) => allScope.find((a) => a.accountCode === c)?.classification ?? null);
          const cur = strictSum(memberValues.map((v) => v.current), presentationSign, classifications);
          const cmp = comparisonMode === COMPARISON_MODES.NONE || budgetMode
            ? notComparable()
            : strictSum(memberValues.map((v) => v.comparison), presentationSign, classifications);
          const nature: "REVENUE" | "EXPENSE" | "OTHER" = (() => {
            const hasRev = classifications.includes("REVENUE");
            const hasExp = classifications.includes("EXPENSE");
            return hasRev && !hasExp ? "REVENUE" : hasExp && !hasRev ? "EXPENSE" : "OTHER";
          })();
          const core = compareRowCore({
            currentMinor: cur.valueMinor,
            currentStatus: cur.status,
            comparisonMinor: cmp.valueMinor,
            comparisonStatus: cmp.status,
            lineNature: nature,
            mappingStatus: classifications.some((c) => c !== null && c !== "REVENUE" && c !== "EXPENSE" && c !== "ASSET" && c !== "LIABILITY" && c !== "EQUITY") ? "PARTIAL" : null,
            basisLabel: rowBasisLabel,
            basisKind,
            rowNoun: acc.accountName || null,
            lang: reportLang,
            formatAmount,
          });
          rows.push({
            key: `group-${code}`,
            label: accountLabel(acc),
            kind: "GROUP",
            depth,
            level: hierarchy.levelOf.get(code) ?? null,
            accountCode: code,
            statementLineCode: acc.statementLineCode,
            mappingStatus: null,
            lineNature: nature,
            currentAmount: cur.valueMinor?.toString() ?? null,
            currentStatus: cur.status,
            comparisonAmount: cmp.valueMinor?.toString() ?? null,
            comparisonStatus: cmp.status,
            varianceAmount: core.varianceMinor,
            variancePercent: core.variancePercent,
            direction: core.direction,
            favorability: core.favorability,
            factText: core.factText,
            interpretationText: core.interpretationText,
            reviewGuidance: core.reviewGuidance,
            flags: core.flags,
            sourceAccountCodes: sourceCodes,
          });
        } else {
          rows.push(makeAccountRow(av, { kind: "ACCOUNT", label: accountLabel(acc), depth, level: hierarchy.levelOf.get(code) ?? null, sourceCodes: [code] }));
        }
        for (const child of hierarchy.childrenOf.get(code) ?? []) dfs(child, depth + 1);
      };
      for (const root of hierarchy.roots) dfs(root, 0);
      for (const anom of hierarchy.anomalies) rows.push(unhierarchizedRow(anom, allScope, valuesByCode, makeAccountRow));
    } else if (presentationMode === PRESENTATION_MODES.ACCOUNT_LEVEL) {
      const rawLevel = Number(input.accountLevel);
      const level = Number.isInteger(rawLevel) && rawLevel >= 1 ? rawLevel : 1;
      if (level > hierarchy.maxLevel) {
        // فشل واضح — لا اختراع مستوى غير موجود
        return {
          company: companyDTO(company),
          fiscalYear: fyDTO(fy),
          period: periodDTO(period),
          statementScope, basis, presentationMode, reportLanguage: reportLang, accountLevel: level,
          hierarchyMaxLevel: hierarchy.maxLevel,
          comparisonMode, comparisonTarget,
          status: "NO_COMPARISON_DATA",
          statusDetail: `المستوى ${level} غير موجود — أقصى مستوى هرمي فعلي من الأكواد الموجودة هو ${hierarchy.maxLevel}.`,
          notes,
          rows: [],
          totals: [],
          summary: { accounts: allScope.length, incomplete: 0, unclassified: unclassifiedAccounts.length, flagged: 0 },
          provenance: await loadReportingProvenance(companyId, fiscalYearId),
        };
      }
      for (const code of hierarchy.codes.filter((c) => hierarchy.levelOf.get(c) === level)) {
        const acc = allScope.find((a) => a.accountCode === code)!;
        const av = valuesByCode.get(code)!;
        const descendants = descendantCodesOf(code, hierarchy.codes);
        const sourceCodes = [code, ...descendants];
        if (descendants.length === 0) {
          rows.push(makeAccountRow(av, { kind: "ACCOUNT", label: accountLabel(acc), depth: 0, level, sourceCodes }));
        } else {
          const memberValues = sourceCodes.map((c) => valuesByCode.get(c)!).filter(Boolean);
          const classifications = sourceCodes.map((c) => allScope.find((a) => a.accountCode === c)?.classification ?? null);
          const cur = strictSum(memberValues.map((v) => v.current), presentationSign, classifications);
          const cmp = comparisonMode === COMPARISON_MODES.NONE || budgetMode
            ? notComparable()
            : strictSum(memberValues.map((v) => v.comparison), presentationSign, classifications);
          const hasRev = classifications.includes("REVENUE");
          const hasExp = classifications.includes("EXPENSE");
          const nature: "REVENUE" | "EXPENSE" | "OTHER" = hasRev && !hasExp ? "REVENUE" : hasExp && !hasRev ? "EXPENSE" : "OTHER";
          const core = compareRowCore({
            currentMinor: cur.valueMinor, currentStatus: cur.status,
            comparisonMinor: cmp.valueMinor, comparisonStatus: cmp.status,
            lineNature: nature, mappingStatus: null,
            basisLabel: rowBasisLabel,
            basisKind,
            rowNoun: acc.accountName || null,
            lang: reportLang,
            formatAmount,
          });
          rows.push({
            key: `lvl-${level}-${code}`,
            label: accountLabel(acc),
            kind: "GROUP",
            depth: 0, level,
            accountCode: code,
            statementLineCode: acc.statementLineCode,
            mappingStatus: null,
            lineNature: nature,
            currentAmount: cur.valueMinor?.toString() ?? null,
            currentStatus: cur.status,
            comparisonAmount: cmp.valueMinor?.toString() ?? null,
            comparisonStatus: cmp.status,
            varianceAmount: core.varianceMinor,
            variancePercent: core.variancePercent,
            direction: core.direction,
            favorability: core.favorability,
            factText: core.factText,
            interpretationText: core.interpretationText,
            reviewGuidance: core.reviewGuidance,
            flags: core.flags,
            sourceAccountCodes: sourceCodes,
          });
        }
      }
      for (const anom of hierarchy.anomalies) rows.push(unhierarchizedRow(anom, allScope, valuesByCode, makeAccountRow));
    }
  }

  /* ── الإجماليات المقطعية (من كل الحسابات المصدرية — تتطابق مع القائمة الرسمية) ── */
  const totals: ComparisonTotalDTO[] = [];
  const scopeTotals = (classification: string, label: string, key: string): ComparisonTotalDTO => {
    const members = scopeAccounts.filter((a) => a.classification === classification);
    const memberValues = members.map((m) => valuesByCode.get(m.accountCode)!);
    const cur = strictSum(memberValues.map((v) => v.current), presentationSign, members.map((m) => m.classification));
    let cmp: ValueResult;
    if (comparisonMode === COMPARISON_MODES.NONE || budgetMode) cmp = notComparable();
    else cmp = strictSum(memberValues.map((v) => v.comparison), presentationSign, members.map((m) => m.classification));
    const core = compareRowCore({
      currentMinor: cur.valueMinor, currentStatus: cur.status,
      comparisonMinor: cmp.valueMinor, comparisonStatus: cmp.status,
      lineNature: classification === "REVENUE" ? "REVENUE" : classification === "EXPENSE" ? "EXPENSE" : "OTHER",
      mappingStatus: null,
      basisLabel: rowBasisLabel,
      basisKind,
      rowNoun: label,
      lang: reportLang,
      formatAmount,
    });
    return {
      key,
      label,
      amount: cur.valueMinor?.toString() ?? null,
      status: cur.status,
      sourceAccountCodes: members.map((m) => m.accountCode),
      comparisonAmount: cmp.valueMinor?.toString() ?? null,
      comparisonStatus: cmp.status,
      varianceAmount: core.varianceMinor,
      variancePercent: core.variancePercent,
      direction: core.direction,
    };
  };

  if (statementScope === "PROFIT_OR_LOSS") {
    totals.push(scopeTotals("REVENUE", bilingual("إجمالي الإيرادات", "Total Revenue", reportLang), "total-revenue"));
    totals.push(scopeTotals("EXPENSE", bilingual("إجمالي المصروفات", "Total Expenses", reportLang), "total-expense"));
    // صافي النتيجة: إيراد − مصروف (بإشارات العرض) — عبر القيم المجمعة نفسها
    const rev = totals[0], exp = totals[1];
    if (rev.amount !== null && exp.amount !== null && rev.status === "OK" && exp.status === "OK") {
      const net = BigInt(rev.amount) - BigInt(exp.amount);
      totals.push({ key: "net-result", label: bilingual("صافي الربح أو الخسارة", "Net Profit or Loss", reportLang), amount: net.toString(), status: "OK", sourceAccountCodes: [...rev.sourceAccountCodes, ...exp.sourceAccountCodes] });
    } else {
      totals.push({ key: "net-result", label: bilingual("صافي الربح أو الخسارة", "Net Profit or Loss", reportLang), amount: null, status: "INCOMPLETE_DATA", sourceAccountCodes: [] });
    }
  } else {
    totals.push(scopeTotals("ASSET", bilingual("إجمالي الأصول", "Total Assets", reportLang), "total-assets"));
    totals.push(scopeTotals("LIABILITY", bilingual("إجمالي الالتزامات", "Total Liabilities", reportLang), "total-liabilities"));
    totals.push(scopeTotals("EQUITY", bilingual("إجمالي حقوق الملكية (قبل نتيجة الفترة)", "Total Equity (before the period result)", reportLang), "total-equity"));
    // صافي نتيجة الفترة (يُعرض ضمن حقوق الملكية في القائمة الرسمية) — عبر الدالة المركزية الوحيدة
    // (netProfitOrLossRangeFromAccounts) بلا حساب ثانٍ — بلا ف/غ (بند داخل قائمة مركز مالي).
    const startO = basis === "YTD" ? 1 : ordinal;
    const netNow = netProfitOrLossRangeFromAccounts(accountsMap, startO, ordinal);
    let netComparison: ValueResult = notComparable();
    if (comparisonMode === COMPARISON_MODES.PRIOR_PERIOD && priorPeriodOrdinal) {
      const cs = basis === "YTD" ? 1 : priorPeriodOrdinal;
      const netPrev = netProfitOrLossRangeFromAccounts(accountsMap, cs, priorPeriodOrdinal);
      netComparison = netPrev.status === "OK" && netPrev.valueMinor !== null ? ok(netPrev.valueMinor) : incomplete();
    } else if (comparisonMode === COMPARISON_MODES.PRIOR_YEAR_PERIOD && priorAccountsMap) {
      const netPrior = netProfitOrLossRangeFromAccounts(priorAccountsMap, startO, ordinal);
      netComparison = netPrior.status === "OK" && netPrior.valueMinor !== null ? ok(netPrior.valueMinor) : incomplete();
    }
    const netCore = compareRowCore({
      currentMinor: netNow.valueMinor, currentStatus: netNow.status === "OK" ? "OK" : "INCOMPLETE_DATA",
      comparisonMinor: netComparison.valueMinor, comparisonStatus: netComparison.status,
      lineNature: "OTHER", mappingStatus: null,
      basisLabel: rowBasisLabel,
      basisKind,
      rowNoun: bilingual("صافي نتيجة الفترة", "Net result for the period", reportLang),
      lang: reportLang,
      formatAmount,
    });
    totals.push({
      key: "net-result",
      label: bilingual(
        "صافي نتيجة الفترة (يُعرض ضمن حقوق الملكية في القائمة الرسمية)",
        "Net result for the period (presented within equity in the formal statement)",
        reportLang
      ),
      amount: netNow.valueMinor?.toString() ?? null,
      status: netNow.status === "OK" ? "OK" : "INCOMPLETE_DATA",
      comparisonAmount: netComparison.valueMinor?.toString() ?? null,
      comparisonStatus: netComparison.status,
      varianceAmount: netCore.varianceMinor,
      variancePercent: netCore.variancePercent,
      direction: netCore.direction,
      sourceAccountCodes: netNow.incompleteAccounts,
    });
  }

  /* ── الحالة الإجمالية الصادقة ── */
  let status: StatementComparisonResult["status"] = "OK";
  let statusDetail: string | null = null;
  if (budgetMode && budgetMissing) {
    status = "NO_APPROVED_BUDGET";
    statusDetail = targetDetail;
  } else if (targetFullyMissing) {
    status = "NO_COMPARISON_DATA";
    statusDetail = targetDetail;
  } else {
    const anyIncomplete = rows.some((r) => r.currentStatus === "INCOMPLETE_DATA") || totals.some((t) => t.status === "INCOMPLETE_DATA");
    if (anyIncomplete) {
      status = "INCOMPLETE_DATA";
      statusDetail = "صفوف بقيم ناقصة معلنة داخل التقرير — لا تُعوَّض بأصفار.";
    }
  }

  const flaggedCount = rows.filter((r) => r.flags.length > 0).length;
  const summary = {
    accounts: allValues.length,
    incomplete: allValues.filter((v) => v.current.status !== "OK").length,
    unclassified: unclassifiedAccounts.length + allValues.filter((v) => v.account.mappingStatus !== null && v.account.mappingStatus !== "FULLY_MAPPED").length,
    flagged: flaggedCount,
  };

  return {
    company: companyDTO(company),
    fiscalYear: fyDTO(fy),
    period: periodDTO(period),
    statementScope,
    basis,
    presentationMode,
    reportLanguage: reportLang,
    accountLevel: presentationMode === PRESENTATION_MODES.ACCOUNT_LEVEL ? (Number.isInteger(Number(input.accountLevel)) && Number(input.accountLevel) >= 1 ? Number(input.accountLevel) : 1) : null,
    hierarchyMaxLevel: hierarchyModes ? deriveAccountHierarchy([...scopeAccounts, ...unclassifiedAccounts].map((a) => a.accountCode)).maxLevel : null,
    comparisonMode,
    comparisonTarget,
    status,
    statusDetail,
    notes,
    rows,
    totals,
    summary,
    provenance: await loadReportingProvenance(companyId, fiscalYearId),
  };
}

/* ── صف الأكواد الشاذة (بلا هرمية قابلة للاشتقاق) — ظاهر دائمًا لا مُخفى ── */
function unhierarchizedRow(
  anomCode: string,
  allScope: ScopeAccount[],
  valuesByCode: Map<string, AccountValues>,
  makeAccountRow: (av: AccountValues, opts: { kind: ComparisonRowDTO["kind"]; label: string; depth: number; level: number | null; sourceCodes: string[] }) => ComparisonRowDTO
): ComparisonRowDTO {
  const acc = allScope.find((a) => a.accountCode === anomCode);
  const av = acc ? valuesByCode.get(anomCode) : undefined;
  if (!acc || !av) {
    return {
      key: `anomaly-${anomCode || "blank"}`, label: "(حساب بكود فارغ — غير قابل للوضع في الهرمية)",
      kind: "ACCOUNT", depth: 0, level: null, accountCode: null, statementLineCode: null,
      mappingStatus: null, lineNature: "OTHER",
      currentAmount: null, currentStatus: "INCOMPLETE_DATA",
      comparisonAmount: null, comparisonStatus: "NOT_COMPARABLE",
      varianceAmount: null, variancePercent: null, direction: "NOT_COMPARABLE", favorability: "NO_FAVORABLE_UNFAVORABLE",
      factText: null, interpretationText: "كود حساب غير صالح للهرمية — يلزم تصحيح كود الحساب في مصدر ميزان المراجعة.",
      reviewGuidance: "يوصى تصحيح كود الحساب الفارغ/غير الصالح في مصدر البيانات.", flags: ["INCOMPLETE_DATA"],
      sourceAccountCodes: [],
    };
  }
  return makeAccountRow(av, {
    kind: "ACCOUNT",
    label: `${acc.accountCode || "(كود فارغ)"} — ${acc.accountName || "(بلا اسم)"} (بلا هرمية)`,
    depth: 0, level: null, sourceCodes: [acc.accountCode],
  });
}

/* ── مخططات DTO صغيرة ── */
type CompanyLite = { code: string; nameAr: string; functionalCurrency: string };
function companyDTO(c: CompanyLite) {
  const currency = typeof c.functionalCurrency === "string" && isSupportedCurrency(c.functionalCurrency) ? c.functionalCurrency : null;
  return { code: c.code, nameAr: c.nameAr, currency, currencyLabel: currency ? CURRENCIES[currency].nameAr : null };
}
type FyLite = { id: string; code: string; displayNameAr: string; startDate: string; endDate: string };
function fyDTO(fy: FyLite) { return { id: fy.id, code: fy.code, displayNameAr: fy.displayNameAr, startDate: fy.startDate, endDate: fy.endDate }; }
type PeriodLite = { ordinal: number; startDate: string; endDate: string; displayLabel: string };
function periodDTO(p: PeriodLite) { return { ordinal: p.ordinal, startDate: p.startDate, endDate: p.endDate, displayLabel: p.displayLabel }; }
