// Phase 6.4B — خدمة قائمة التدفقات النقدية (IAS 7 — الطريقة غير المباشرة) — خادم فقط.
//
// المبادئ (خارطة 6.4 المعتمدة):
//   - لا استنتاج التصنيف من الطبيعة (ASSET/LIABILITY/...) إطلاقًا — Cash Flow Mapping مستقلة
//     بقرارها: ACCOUNT_OVERRIDE → LONGEST PREFIX → UNCLASSIFIED (فشل مغلق).
//   - قاعدة الإشارة المركزية الوحيدة في lib/cashflow.ts — لا إشارات في الواجهة.
//   - FLOW: حركة المدى عبر الجسور الموحدة (لا جمع تراكمي مزدوج). BALANCE: إقفال − افتتاح.
//   - المطابقة (R): الافتتاحي + صافي حركات الأقسام = الإقفالي؛ أي فرق يُعرض صريحًا ولا يُخفى.
//   - الاكتمال (S): حسابات مؤثرة غير مصنفة ⇒ INCOMPLETE_DATA + قائمة الحسابات/المبالغ.
//   - NON_CASH: لا تدخل التدفقات إطلاقًا — منطقة إفصاح منفصلة.

import { db } from "@/lib/db";
import { companyVisible } from "@/lib/company-access";
import { TrialBalanceError } from "@/lib/trial-balance";
import {
  balanceAsOfFromPoints,
  flowRangeMovementFromPoints,
  safeValue,
} from "@/lib/trial-balance-data";
import {
  loadCommittedAccountPoints,
  loadReportingProvenance,
  netProfitOrLossRangeFromAccounts,
  type ReportingProvenance,
} from "@/lib/reporting-server";
import {
  CF_ACTIVITY_LABELS,
  CF_ACTIVITIES,
  cashEffectForBalance,
  cashEffectForFlow,
  resolveCashFlowMapping,
  type CashFlowActivity,
} from "@/lib/cashflow";
import type { SessionUser } from "@/lib/session";
import { formatMinor, minorUnitsFor } from "@/lib/money";

export interface CashFlowLineRow {
  lineCode: string | null;
  label: string;
  effectMinor: string | null;
  effectStatus: string;
  accounts: Array<{ accountCode: string; accountName: string; behavior: string; effectMinor: string | null; effectStatus: string }>;
}

export interface CashFlowActivitySection {
  activity: CashFlowActivity;
  label: string;
  lines: CashFlowLineRow[];
  netMinor: string | null;
  netStatus: string;
}

export interface CashFlowStatementResult {
  company: { code: string; nameAr: string };
  fiscalYear: { code: string; displayNameAr: string; startDate: string; endDate: string };
  range: { startOrdinal: number; endOrdinal: number };
  startingMeasure: { status: string; valueMinor: string | null; incompleteAccounts: string[] };
  operating: CashFlowActivitySection;
  investing: CashFlowActivitySection;
  financing: CashFlowActivitySection;
  nonCashDisclosure: CashFlowLineRow[];
  netChangeMinor: string | null;      // من حركات الأقسام
  cashOpeningMinor: string | null;    // من حسابات النقد المربوطة (as-of بداية المدى)
  cashOpeningStatus: string;
  cashClosingMinor: string | null;    // من حسابات النقد المربوطة (as-of نهاية المدى)
  cashClosingStatus: string;
  cashMovementFromCashAccountsMinor: string | null;
  reconciliationDifferenceMinor: string | null; // حركات الأقسام − حركة حسابات النقد (تُعرض دائمًا إن حُسبت)
  reconciled: boolean | null;
  status: "OK" | "INCOMPLETE_DATA";
  unclassifiedAccounts: Array<{ accountCode: string; accountName: string; note: string }>;
  provenance: ReportingProvenance;
}

async function loadContext(companyId: string, fiscalYearId: string, startOrdinal: number, endOrdinal: number) {
  const fy = await db.fiscalYear.findUnique({
    where: { id: fiscalYearId },
    select: { id: true, companyId: true, code: true, displayNameAr: true, startDate: true, endDate: true, status: true, periodCount: true },
  });
  if (!fy || fy.companyId !== companyId) {
    throw new TrialBalanceError("FISCAL_YEAR_NOT_FOUND", "السنة المالية غير موجودة لهذه الشركة.");
  }
  if (!Number.isInteger(startOrdinal) || !Number.isInteger(endOrdinal) || startOrdinal < 1 || endOrdinal > fy.periodCount || startOrdinal > endOrdinal) {
    throw new TrialBalanceError("INVALID_DATE_RANGE", `المدى غير صالح (1..${fy.periodCount}).`);
  }
  return { fy };
}

interface LineBucket {
  lineCode: string | null;
  label: string;
  activity: CashFlowActivity;
  isAdjustment: boolean;
  effect: bigint | null;
  effectStatus: string;
  accounts: CashFlowLineRow["accounts"];
}

export async function getCashFlowStatement(
  user: SessionUser,
  input: { companyId?: unknown; fiscalYearId?: unknown; startOrdinal?: unknown; endOrdinal?: unknown }
): Promise<CashFlowStatementResult> {
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  const fiscalYearId = typeof input.fiscalYearId === "string" ? input.fiscalYearId.trim() : "";
  const startOrdinal = Number(input.startOrdinal);
  const endOrdinal = Number(input.endOrdinal);
  if (!companyId || !fiscalYearId) {
    throw new TrialBalanceError("COMPANY_REQUIRED", "الشركة والسنة المالية إلزاميتان.");
  }
  if (!companyVisible(user, companyId)) {
    throw new TrialBalanceError("NOT_FOUND", "لا تملك الوصول لهذه الشركة.");
  }
  const { fy } = await loadContext(companyId, fiscalYearId, startOrdinal, endOrdinal);
  const company = await db.company.findUnique({ where: { id: companyId }, select: { code: true, nameAr: true, functionalCurrency: true } });
  if (!company) throw new TrialBalanceError("NOT_FOUND", "الشركة غير موجودة.");

  const [accounts, rules, overrides, lines, provenance] = await Promise.all([
    loadCommittedAccountPoints(companyId, fiscalYearId),
    db.cashFlowMapping.findMany({
      where: { isActive: true, OR: [{ companyId: null }, { companyId }] },
      orderBy: { prefix: "desc" },
      select: { companyId: true, prefix: true, activity: true, line: { select: { code: true } }, isActive: true },
    }),
    db.cashFlowAccountOverride.findMany({
      where: { companyId, isActive: true },
      select: { accountCode: true, activity: true, line: { select: { code: true } }, isActive: true },
    }),
    db.cashFlowStatementLine.findMany({ where: { isActive: true }, select: { code: true, nameAr: true, activity: true, isAdjustment: true, displayOrder: true } }),
    loadReportingProvenance(companyId, fiscalYearId),
  ]);

  const ruleLikes = rules.map((r) => ({ prefix: r.prefix, activity: r.activity, lineCode: r.line?.code ?? null, isActive: r.isActive }));
  const overrideLikes = overrides.map((o) => ({ accountCode: o.accountCode, activity: o.activity, lineCode: o.line?.code ?? null, isActive: o.isActive }));
  const lineMetaByCode = new Map(lines.map((l) => [l.code, l]));
  // شركة-أولاً: بادئة الشركة تفوز على النظامية عند نفس الطول (ترتيب desc ثم companyId غير null أولًا)
  const orderedRules = [...ruleLikes].sort((a, b) => b.prefix.length - a.prefix.length);

  const openOrd = startOrdinal - 1;
  const buckets = new Map<string, LineBucket>();
  const cashAccounts: Array<{ code: string; name: string; opening: bigint | null; openingStatus: string; closing: bigint | null; closingStatus: string }> = [];
  const unclassified: CashFlowStatementResult["unclassifiedAccounts"] = [];
  let cashOpening = BigInt(0);
  let cashOpeningOk = true;
  let cashClosing = BigInt(0);
  let cashClosingOk = true;

  const sectionKey = (activity: CashFlowActivity, lineCode: string | null): string =>
    `${activity}::${lineCode ?? "__none__"}`;

  for (const acc of Array.from(accounts.values()).sort((a, b) => a.accountCode.localeCompare(b.accountCode))) {
    const resolved = resolveCashFlowMapping({ accountCode: acc.accountCode, rules: orderedRules, overrides: overrideLikes });
    const behavior = acc.aggregationBehavior === "BALANCE" ? "BALANCE" : "FLOW";

    if (resolved.activity === CF_ACTIVITIES.CASH_AND_CASH_EQUIVALENTS) {
      if (behavior !== "BALANCE") {
        unclassified.push({ accountCode: acc.accountCode, accountName: acc.accountName, note: "حساب نقد بسلوك FLOW — يلزم مراجعة التصنيف (السلوك/النشاط)." });
        continue;
      }
      const opening = safeValue(() => balanceAsOfFromPoints(acc.points, openOrd), "نقد افتتاحي");
      const closing = safeValue(() => balanceAsOfFromPoints(acc.points, endOrdinal), "نقد إقفالي");
      cashAccounts.push({
        code: acc.accountCode, name: acc.accountName,
        opening: opening.valueMinor, openingStatus: opening.status,
        closing: closing.valueMinor, closingStatus: closing.status,
      });
      if (opening.valueMinor === null) cashOpeningOk = false; else cashOpening += opening.valueMinor;
      if (closing.valueMinor === null) cashClosingOk = false; else cashClosing += closing.valueMinor;
      continue;
    }

    if (resolved.activity === CF_ACTIVITIES.UNCLASSIFIED) {
      // (S) — الحسابات المؤثرة غير المصنفة تُبلّغ صراحة ولا تختفي.
      // استثناء محاسبي موثق: حسابات الإيراد/المصروف (FLOW) غير المربوطة مغطاة أصلًا
      // ببادئ قياس القائمة (صافي الربح/الخسارة) — لا تُعد فجوة ولا تُبلّغ مرتين.
      if (behavior === "FLOW" && (acc.classification === "REVENUE" || acc.classification === "EXPENSE")) {
        continue;
      }
      let hint = "";
      try {
        const mv = behavior === "BALANCE"
          ? balanceAsOfFromPoints(acc.points, endOrdinal) - (openOrd >= 1 ? balanceAsOfFromPoints(acc.points, openOrd) : BigInt(0))
          : flowRangeMovementFromPoints(acc.points, startOrdinal, endOrdinal);
        // 6.9R (عهدة G): الملاحظات بعملة الشركة الموثقة — لا أرقام minor خام في نصوص المستخدم
        hint = mv === BigInt(0)
          ? "بلا حركة في المدى"
          : `حركة في المدى = ${formatMinor(mv.toString(), minorUnitsFor(company.functionalCurrency))}${company.functionalCurrency ? ` ${company.functionalCurrency}` : ""}`;
      } catch {
        hint = "تعذر حساب الحركة (بيانات غير مكتملة)";
      }
      unclassified.push({ accountCode: acc.accountCode, accountName: acc.accountName, note: hint });
      continue;
    }

    const meta = resolved.lineCode ? lineMetaByCode.get(resolved.lineCode) : undefined;
    const bucketKey = sectionKey(resolved.activity, resolved.lineCode);
    const bucket = buckets.get(bucketKey) ?? {
      lineCode: resolved.lineCode,
      // 6.9R (عهدة D): بند تدفق غير معروف يتسمى وصفًا مقروءًا — لا كود خام كنص أساسي
      label: meta?.nameAr ?? (resolved.lineCode ? `بند تدفق غير معروف بالمرجع (${resolved.lineCode})` : CF_ACTIVITY_LABELS[resolved.activity]),
      activity: resolved.activity,
      isAdjustment: meta?.isAdjustment ?? false,
      effect: BigInt(0),
      effectStatus: "OK",
      accounts: [],
    };

    let effect: bigint | null = null;
    let effectStatus = "OK";
    if (behavior === "BALANCE") {
      const opening = safeValue(() => balanceAsOfFromPoints(acc.points, openOrd), "الافتتاحي");
      const closing = safeValue(() => balanceAsOfFromPoints(acc.points, endOrdinal), "الإقفالي");
      if (opening.valueMinor === null || closing.valueMinor === null) {
        effect = null;
        effectStatus = opening.status !== "OK" ? opening.status : closing.status;
      } else {
        effect = cashEffectForBalance(acc.classification, closing.valueMinor - opening.valueMinor);
      }
    } else {
      try {
        const mv = flowRangeMovementFromPoints(acc.points, startOrdinal, endOrdinal);
        effect = cashEffectForFlow(mv, bucket.isAdjustment);
      } catch {
        effect = null;
        effectStatus = "INCOMPLETE_DATA";
      }
    }
    bucket.accounts.push({
      accountCode: acc.accountCode,
      accountName: acc.accountName,
      behavior,
      effectMinor: effect?.toString() ?? null,
      effectStatus,
    });
    if (effect === null) bucket.effectStatus = effectStatus;
    else bucket.effect = (bucket.effect ?? BigInt(0)) + effect;
    buckets.set(bucketKey, bucket);
  }

  const netPnl = netProfitOrLossRangeFromAccounts(accounts, startOrdinal, endOrdinal);

  const buildSection = (activity: CashFlowActivity): CashFlowActivitySection => {
    const sectionBuckets = Array.from(buckets.values())
      .filter((b) => b.activity === activity)
      .sort((a, b) => (a.lineCode ?? "").localeCompare(b.lineCode ?? ""));
    let net = BigInt(0);
    let netOk = true;
    const rows: CashFlowLineRow[] = [];
    for (const b of sectionBuckets) {
      rows.push({
        lineCode: b.lineCode,
        label: b.label,
        effectMinor: b.effectStatus === "OK" && b.effect !== null ? b.effect.toString() : null,
        effectStatus: b.effectStatus,
        accounts: b.accounts,
      });
      if (b.effectStatus !== "OK" || b.effect === null) netOk = false;
      else net += b.effect;
    }
    // بادئ القياس داخل التشغيلية: صافي الربح/الخسارة من القائمة (مصدر موحد)
    if (activity === CF_ACTIVITIES.OPERATING) {
      rows.unshift({
        lineCode: "CF-OP-NET-PL",
        label: "الربح أو الخسارة للفترة (بادئ قياس القائمة — من قائمة الربح أو الخسارة المحفوظة)",
        effectMinor: netPnl.valueMinor?.toString() ?? null,
        effectStatus: netPnl.status,
        accounts: [],
      });
      if (netPnl.status !== "OK" || netPnl.valueMinor === null) netOk = false; else net += netPnl.valueMinor;
    }
    return {
      activity,
      label: CF_ACTIVITY_LABELS[activity],
      lines: rows,
      netMinor: netOk ? net.toString() : null,
      netStatus: netOk ? "OK" : "INCOMPLETE_DATA",
    };
  };

  const operating = buildSection(CF_ACTIVITIES.OPERATING);
  const investing = buildSection(CF_ACTIVITIES.INVESTING);
  const financing = buildSection(CF_ACTIVITIES.FINANCING);
  const nonCashDisclosure = Array.from(buckets.values())
    .filter((b) => b.activity === CF_ACTIVITIES.NON_CASH)
    .sort((a, b) => (a.lineCode ?? "").localeCompare(b.lineCode ?? ""))
    .map((b) => ({
      lineCode: b.lineCode,
      label: b.label,
      effectMinor: b.effectStatus === "OK" && b.effect !== null ? b.effect.toString() : null,
      effectStatus: b.effectStatus,
      accounts: b.accounts,
    }));

  const sectionsNet =
    operating.netMinor !== null && investing.netMinor !== null && financing.netMinor !== null
      ? BigInt(operating.netMinor) + BigInt(investing.netMinor) + BigInt(financing.netMinor)
      : null;
  const cashMovement = cashOpeningOk && cashClosingOk ? cashClosing - cashOpening : null;
  const reconciliationDifference =
    sectionsNet !== null && cashMovement !== null ? sectionsNet - cashMovement : null;

  const status: "OK" | "INCOMPLETE_DATA" =
    operating.netStatus !== "OK" ||
    investing.netStatus !== "OK" ||
    financing.netStatus !== "OK" ||
    !cashOpeningOk ||
    !cashClosingOk ||
    unclassified.some((u) => !u.note.includes("بلا حركة"))
      ? "INCOMPLETE_DATA"
      : "OK";

  return {
    company: { code: company.code, nameAr: company.nameAr },
    fiscalYear: { code: fy.code, displayNameAr: fy.displayNameAr, startDate: fy.startDate, endDate: fy.endDate },
    range: { startOrdinal, endOrdinal },
    startingMeasure: {
      status: netPnl.status,
      valueMinor: netPnl.valueMinor?.toString() ?? null,
      incompleteAccounts: netPnl.incompleteAccounts,
    },
    operating,
    investing,
    financing,
    nonCashDisclosure,
    netChangeMinor: sectionsNet?.toString() ?? null,
    cashOpeningMinor: cashOpeningOk ? cashOpening.toString() : null,
    cashOpeningStatus: cashOpeningOk ? "OK" : "INCOMPLETE_DATA",
    cashClosingMinor: cashClosingOk ? cashClosing.toString() : null,
    cashClosingStatus: cashClosingOk ? "OK" : "INCOMPLETE_DATA",
    cashMovementFromCashAccountsMinor: cashMovement?.toString() ?? null,
    reconciliationDifferenceMinor: reconciliationDifference?.toString() ?? null,
    reconciled: reconciliationDifference === null ? null : reconciliationDifference === BigInt(0),
    status,
    unclassifiedAccounts: unclassified,
    provenance,
  };
}
