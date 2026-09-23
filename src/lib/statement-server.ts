// Phase 6.2D — خدمة القوائم المالية الآلية (خادم فقط):
// Trial Balance المحفوظ + خريطة الشركة + هرمية بنود القوائم ⇒ قائمتان:
// قائمة الربح أو الخسارة وقائمة المركز المالي (+ تهيئة OCI).
// لا hard-code لأكواد الحسابات — كل شيء عبر snapshot الخريطة والمرجع.

import { db } from "@/lib/db";
import { companyVisible } from "@/lib/company-access";
import { isSupportedCurrency, CURRENCIES } from "@/lib/currencies";
import {
  balanceAsOfFromPoints,
  flowMonthMovementFromPoints,
  flowYTDFromPoints,
  safeValue,
} from "@/lib/trial-balance-data";
import { TrialBalanceError } from "@/lib/trial-balance";
import { loadReportingProvenance, type ReportingProvenance } from "@/lib/reporting-server";
import {
  buildFinancialPosition,
  buildProfitOrLoss,
  type StatementInputRow,
  type StatementLineMeta,
} from "@/lib/statement-builder";
import type { SessionUser } from "@/lib/session";

async function loadStatementContext(companyId: string, fiscalYearId: string, ordinal: number) {
  const fy = await db.fiscalYear.findUnique({
    where: { id: fiscalYearId },
    select: { id: true, companyId: true, code: true, displayNameAr: true, startDate: true, endDate: true, status: true, periodCount: true },
  });
  if (!fy || fy.companyId !== companyId) {
    throw new TrialBalanceError("FISCAL_YEAR_NOT_FOUND", "السنة المالية غير موجودة لهذه الشركة.");
  }
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > fy.periodCount) {
    throw new TrialBalanceError("INVALID_DATE_RANGE", `الفترة ${ordinal} خارج مدى السنة المالية (1..${fy.periodCount}).`);
  }
  const period = await db.fiscalPeriod.findUnique({
    where: { fiscalYearId_ordinal: { fiscalYearId, ordinal } },
    select: { id: true, ordinal: true, startDate: true, endDate: true, displayLabel: true },
  });
  if (!period) throw new TrialBalanceError("FISCAL_YEAR_NOT_FOUND", `فترة #${ordinal} غير معرفة.`);
  return { fy, period };
}

/** بنود القوائم المالية كمرجع للباني (نشطة حصرًا). */
async function loadLineMeta(): Promise<StatementLineMeta[]> {
  const lines = await db.financialStatementLine.findMany({
    where: { isActive: true },
    orderBy: [{ statementType: "asc" }, { displayOrder: "asc" }],
    select: { id: true, code: true, nameAr: true, statementType: true, parentId: true, displayOrder: true },
  });
  return lines;
}

/** صفوف الحساب بالقيم المحسوبة (YTD للـ FLOW / as-of للـ BALANCE) عند ordinal. */
async function buildInputRows(
  accounts: Map<string, {
    accountCode: string; accountName: string; points: { startOrdinal: number; endOrdinal: number; dataType: string; netMinor: bigint }[];
    mappingStatus: string | null; classification: string | null; aggregationBehavior: string | null; statementLineCode: string | null;
  }>,
  ordinal: number,
  basis: "YTD" | "PERIOD"
): Promise<StatementInputRow[]> {
  const rows: StatementInputRow[] = [];
  for (const acc of Array.from(accounts.values()).sort((a, b) => a.accountCode.localeCompare(b.accountCode))) {
    const behavior = acc.aggregationBehavior === "BALANCE" ? "BALANCE" : "FLOW";
    const v = safeValue(
      () =>
        behavior === "BALANCE"
          ? balanceAsOfFromPoints(acc.points, ordinal)
          : basis === "YTD"
            ? flowYTDFromPoints(acc.points, ordinal)
            : flowMonthMovementFromPoints(acc.points, ordinal),
      basis === "YTD" ? "YTD" : "حركة الفترة"
    );
    rows.push({
      accountCode: acc.accountCode,
      accountName: acc.accountName,
      mappingStatus: acc.mappingStatus,
      classification: acc.classification,
      statementLineCode: acc.statementLineCode,
      valueMinor: v.valueMinor,
      valueStatus: v.status,
    });
  }
  return rows;
}

export interface StatementsResult {
  company: { code: string; nameAr: string; currency: string | null; currencyLabel: string | null };
  fiscalYear: { code: string; displayNameAr: string; startDate: string; endDate: string };
  period: { ordinal: number; startDate: string; endDate: string; displayLabel: string };
  basis: "YTD" | "PERIOD";
  header: {
    systemName: string;
    pnl: { title: string; periodLabel: string };
    sfp: { title: string; periodLabel: string };
  };
  // Phase 6.3 — إثبات المصدر: أي نسخ ميزان مراجعة بُنيت عليها القائمتان
  provenance: ReportingProvenance;
  profitOrLoss: ReturnType<typeof buildProfitOrLoss>;
  financialPosition: ReturnType<typeof buildFinancialPosition>;
}

export async function getStatements(
  user: SessionUser,
  input: { companyId?: unknown; fiscalYearId?: unknown; ordinal?: unknown; basis?: unknown }
): Promise<StatementsResult> {
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  const fiscalYearId = typeof input.fiscalYearId === "string" ? input.fiscalYearId.trim() : "";
  const ordinal = Number(input.ordinal);
  const basis = input.basis === "PERIOD" ? "PERIOD" : "YTD";
  if (!companyId || !fiscalYearId) {
    throw new TrialBalanceError("COMPANY_REQUIRED", "الشركة والسنة المالية إلزاميتان.");
  }
  if (!companyVisible(user, companyId)) {
    throw new TrialBalanceError("NOT_FOUND", "لا تملك الوصول لهذه الشركة.");
  }

  const [company, ctx] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { code: true, nameAr: true, functionalCurrency: true } }),
    loadStatementContext(companyId, fiscalYearId, ordinal),
  ]);
  if (!company) throw new TrialBalanceError("NOT_FOUND", "الشركة غير موجودة.");

  const { loadCommittedAccountPoints } = await import("@/lib/reporting-server");
  const accounts = await loadCommittedAccountPoints(companyId, fiscalYearId);
  const lineMeta = await loadLineMeta();

  const currentRows = await buildInputRows(accounts, ordinal, basis);
  const prevOrdinal = ordinal - 1;
  const previousRows =
    prevOrdinal >= 1 && currentRows.some((r) => r.valueMinor !== null) ? await buildInputRows(accounts, prevOrdinal, basis) : [];

  const profitOrLoss = buildProfitOrLoss(currentRows, lineMeta, previousRows);

  // نتيجة الفترة للمركز المالي: من نفس أساس القائمة (YTD حركة FLOW حتى الفترة)
  const netResult = safeValue(() => BigInt(profitOrLoss.netResultMinor), "صافي النتيجة");
  const financialPosition = buildFinancialPosition(
    currentRows,
    lineMeta,
    { valueMinor: netResult.valueMinor, status: netResult.status },
    previousRows
  );

  const currency =
    typeof company.functionalCurrency === "string" && isSupportedCurrency(company.functionalCurrency)
      ? company.functionalCurrency
      : null; // لا تخمين عملة — تُعرض فقط إذا كانت metadata موثقة

  return {
    company: {
      code: company.code,
      nameAr: company.nameAr,
      currency,
      currencyLabel: currency ? CURRENCIES[currency].nameAr : null,
    },
    fiscalYear: { code: ctx.fy.code, displayNameAr: ctx.fy.displayNameAr, startDate: ctx.fy.startDate, endDate: ctx.fy.endDate },
    period: { ordinal: ctx.period.ordinal, startDate: ctx.period.startDate, endDate: ctx.period.endDate, displayLabel: ctx.period.displayLabel },
    basis,
    header: {
      systemName: "نظام التقارير المالية الموحدة",
      pnl: {
        title: "قائمة الربح أو الخسارة",
        periodLabel:
          basis === "YTD"
            ? `من ${ctx.fy.startDate} إلى ${ctx.period.endDate} (التراكمي حتى فترة ${ordinal})`
            : `حركة فترة ${ordinal}: ${ctx.period.startDate} → ${ctx.period.endDate}`,
      },
      sfp: {
        title: "قائمة المركز المالي",
        periodLabel: `كما في ${ctx.period.endDate} (فترة ${ordinal})`,
      },
    },
    profitOrLoss,
    financialPosition,
    provenance: await loadReportingProvenance(companyId, fiscalYearId),
  };
}
