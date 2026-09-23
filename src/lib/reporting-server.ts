// Phase 6.2C — خدمة التقارير من البيانات المحفوظة (خادم فقط — طبقة قراءة مركزية).
//
// Company + FiscalYear + Period/Date range ⇒ Actual financial data — الواجهة
// لا تقرأ Prisma مباشرة إطلاقًا. كل التقارير المحفوظة (مقارنة فترات، شهر مقابل
// تراكمي، القوائم المالية 6.2D) تمر من هنا — لا مصدر بيانات بديل.
//
// سياسة الخريطة للعرض: snapshot أحدث استيراد معتمد هو المعتمد في صفوف التقرير
// (استقرار تاريخي — قرار 6.2B-8)، والقيم من بيانات كل فترة عبر طبقة التطبيع
// (trial-balance-data) والمحرك الموحد (temporal-aggregation) حصرًا.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { companyVisible } from "@/lib/company-access";
import {
  balanceAsOfFromPoints,
  flowMonthMovementFromPoints,
  flowRangeMovementFromPoints,
  flowYTDFromPoints,
  safeValue,
  type TBDataPoint,
} from "@/lib/trial-balance-data";
import { TrialBalanceError } from "@/lib/trial-balance";
import type { SessionUser } from "@/lib/session";

export interface AccountPoints {
  accountCode: string;
  accountName: string;
  points: TBDataPoint[];
  // snapshot الخريطة من أحدث استيراد معتمد (استقرار العرض التاريخي)
  mappingStatus: string | null;
  mainCategory: string | null;
  classification: string | null;
  aggregationBehavior: string | null;
  statementLineCode: string | null;
}

/** تحقق نطاق + جلب FY والتحقق من انتمائها للشركة وصحة ordinal. */
async function loadContext(companyId: string, fiscalYearId: string, ordinal: number) {
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
  if (!period) {
    throw new TrialBalanceError("FISCAL_YEAR_NOT_FOUND", `فترة #${ordinal} غير معرفة في هذه السنة المالية.`);
  }
  return { fy, period };
}

/**
 * 6.3 — الافتراضي للتقارير: لكل (مدى، نوع بيانات) تُستخدم أحدث نسخة معتمدة حصرًا؛
 * النسخ المعتمدة الأقدم تبقى محفوظة قابلة للتتبع لكنها لا تشارك في قيم التقرير.
 */
function selectDefaultCommittedImports<T extends { fromDate: string; toDate: string; dataType: string; revisionNumber: number }>(
  imports: readonly T[]
): T[] {
  const latestByRange = new Map<string, T>();
  for (const imp of imports) {
    const key = `${imp.fromDate}|${imp.toDate}|${imp.dataType}`;
    const current = latestByRange.get(key);
    if (!current || imp.revisionNumber > current.revisionNumber) {
      latestByRange.set(key, imp);
    }
  }
  return Array.from(latestByRange.values());
}

/** جلب نقاط كل الحسابات من الاستيرادات المعتمدة حصرًا (لا مسودات في التقارير أبدًا). */
export async function loadCommittedAccountPoints(
  companyId: string,
  fiscalYearId: string
): Promise<Map<string, AccountPoints>> {
  const importsAll = await db.trialBalanceImport.findMany({
    where: { companyId, fiscalYearId, status: "COMMITTED" },
    orderBy: [{ fromDate: "asc" }, { revisionNumber: "asc" }],
    select: {
      id: true,
      fromDate: true,
      toDate: true,
      startOrdinal: true,
      endOrdinal: true,
      dataType: true,
      createdAt: true,
      revisionNumber: true,
      lines: {
        orderBy: { rowIndex: "asc" },
        select: {
          accountCode: true,
          accountName: true,
          netMinor: true,
          mappingStatus: true,
          mainCategory: true,
          classification: true,
          aggregationBehavior: true,
          statementLineCode: true,
        },
      },
    },
  });
  // 6.3 — لكل (مدى، نوع) أحدث مراجعة معتمدة فقط تشارك في القيم (القاعدة المركزية)
  const imports = selectDefaultCommittedImports(importsAll);
  const byAccount = new Map<string, AccountPoints>();
  // الترتيب تصاعديًا حسب fromDate ⇒ الاستيراد الأحدث يستبدل snapshot العرض (آخر كتابة يفوز بالعرض فقط، لا بالقيم).
  for (const imp of imports) {
    for (const l of imp.lines) {
      const existing = byAccount.get(l.accountCode);
      const point: TBDataPoint = {
        startOrdinal: imp.startOrdinal,
        endOrdinal: imp.endOrdinal,
        dataType: imp.dataType,
        netMinor: l.netMinor,
      };
      if (!existing) {
        byAccount.set(l.accountCode, {
          accountCode: l.accountCode,
          accountName: l.accountName,
          points: [point],
          mappingStatus: l.mappingStatus,
          mainCategory: l.mainCategory,
          classification: l.classification,
          aggregationBehavior: l.aggregationBehavior,
          statementLineCode: l.statementLineCode,
        });
      } else {
        existing.points.push(point);
        // تحديث snapshot العرض لقيم أحدث استيراد (الترتيب مضمون تصاعديًا)
        existing.accountName = l.accountName || existing.accountName;
        existing.mappingStatus = l.mappingStatus ?? existing.mappingStatus;
        existing.mainCategory = l.mainCategory ?? existing.mainCategory;
        existing.classification = l.classification ?? existing.classification;
        existing.aggregationBehavior = l.aggregationBehavior ?? existing.aggregationBehavior;
        existing.statementLineCode = l.statementLineCode ?? existing.statementLineCode;
      }
    }
  }
  return byAccount;
}

function assertReportScope(user: SessionUser, companyId: string): void {
  if (!companyVisible(user, companyId)) {
    throw new TrialBalanceError("NOT_FOUND", "لا تملك الوصول لهذه الشركة.");
  }
}

/* ── Phase 6.3 — إثبات المصدر (Provenance): أي نسخ ميزان بُني عليها التقرير ── */

export interface ReportingProvenanceEntry {
  importId: string;
  revisionNumber: number;
  supersedesImportId: string | null;
  committedAt: string | null;
  committedByName: string;
  fromDate: string;
  toDate: string;
  startOrdinal: number;
  endOrdinal: number;
  dataType: string;
  lineCount: number;
}

export interface ReportingProvenance {
  basis: "LATEST_COMMITTED_REVISION";
  imports: ReportingProvenanceEntry[];
}

/** إثبات مصدر التقارير: أحدث المراجعات المعتمدة لكل (مدى، نوع) — معرف النسخة ورقمها وزمن اعتمادها. */
export async function loadReportingProvenance(
  companyId: string,
  fiscalYearId: string
): Promise<ReportingProvenance> {
  const imports = await db.trialBalanceImport.findMany({
    where: { companyId, fiscalYearId, status: "COMMITTED" },
    orderBy: [{ fromDate: "asc" }, { revisionNumber: "asc" }],
    select: {
      id: true,
      revisionNumber: true,
      supersedesImportId: true,
      committedAt: true,
      committedByName: true,
      fromDate: true,
      toDate: true,
      startOrdinal: true,
      endOrdinal: true,
      dataType: true,
      lineCount: true,
    },
  });
  const defaults = selectDefaultCommittedImports(imports);
  return {
    basis: "LATEST_COMMITTED_REVISION",
    imports: defaults.map((i) => ({
      importId: i.id,
      revisionNumber: i.revisionNumber,
      supersedesImportId: i.supersedesImportId,
      committedAt: i.committedAt ? i.committedAt.toISOString() : null,
      committedByName: i.committedByName,
      fromDate: i.fromDate,
      toDate: i.toDate,
      startOrdinal: i.startOrdinal,
      endOrdinal: i.endOrdinal,
      dataType: i.dataType,
      lineCount: i.lineCount,
    })),
  };
}

export interface PeriodComparisonRow {
  accountCode: string;
  accountName: string;
  mainCategory: string | null;
  classification: string | null;
  aggregationBehavior: string | null;
  statementLineCode: string | null;
  mappingStatus: string | null;
  currentStatus: string;
  currentMinor: string | null;
  previousStatus: string;
  previousMinor: string | null;
  varianceMinor: string | null;
  variancePct: string | null;
}

export interface PeriodComparisonResult {
  company: { code: string; nameAr: string };
  fiscalYear: { code: string; displayNameAr: string; startDate: string; endDate: string };
  currentPeriod: { ordinal: number; startDate: string; endDate: string; displayLabel: string };
  previousPeriod: { ordinal: number; startDate: string; endDate: string; displayLabel: string } | null;
  rows: PeriodComparisonRow[];
  summary: { total: number; currentComplete: number; currentIncomplete: number; unclassifiedAccounts: number };
  provenance: ReportingProvenance;
}

/** «الفترة الحالية مقابل الفترة السابقة» من البيانات المحفوظة — لا اختراع فترة سابقة. */
export async function getSavedPeriodComparison(
  user: SessionUser,
  input: { companyId?: unknown; fiscalYearId?: unknown; currentOrdinal?: unknown }
): Promise<PeriodComparisonResult> {
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  const fiscalYearId = typeof input.fiscalYearId === "string" ? input.fiscalYearId.trim() : "";
  const currentOrdinal = Number(input.currentOrdinal);
  if (!companyId || !fiscalYearId) {
    throw new TrialBalanceError("COMPANY_REQUIRED", "الشركة والسنة المالية إلزاميتان.");
  }
  assertReportScope(user, companyId);

  const [company, ctx] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { code: true, nameAr: true } }),
    loadContext(companyId, fiscalYearId, currentOrdinal),
  ]);
  if (!company) throw new TrialBalanceError("NOT_FOUND", "الشركة غير موجودة.");

  const prevOrdinal = currentOrdinal - 1;
  const previousPeriod =
    prevOrdinal >= 1
      ? await db.fiscalPeriod.findUnique({
          where: { fiscalYearId_ordinal: { fiscalYearId, ordinal: prevOrdinal } },
          select: { ordinal: true, startDate: true, endDate: true, displayLabel: true },
        })
      : null;

  const accounts = await loadCommittedAccountPoints(companyId, fiscalYearId);
  const provenance = await loadReportingProvenance(companyId, fiscalYearId);
  const rows: PeriodComparisonRow[] = [];
  let currentComplete = 0;
  let currentIncomplete = 0;
  let unclassifiedAccounts = 0;

  for (const acc of Array.from(accounts.values()).sort((a, b) => a.accountCode.localeCompare(b.accountCode))) {
    const behavior = acc.aggregationBehavior === "BALANCE" ? "BALANCE" : "FLOW";
    const cur = safeValue(
      () => (behavior === "BALANCE" ? balanceAsOfFromPoints(acc.points, currentOrdinal) : flowMonthMovementFromPoints(acc.points, currentOrdinal)),
      "الفترة الحالية"
    );
    let prev: { status: string; valueMinor: bigint | null; message?: string } = { status: "OK", valueMinor: null };
    if (!previousPeriod) {
      prev = { status: "NO_PREVIOUS_PERIOD", valueMinor: null, message: "لا توجد فترة سابقة في نفس السنة المالية." };
    } else {
      prev = safeValue(
        () => (behavior === "BALANCE" ? balanceAsOfFromPoints(acc.points, prevOrdinal) : flowMonthMovementFromPoints(acc.points, prevOrdinal)),
        "الفترة السابقة"
      );
    }
    if (cur.status === "OK") currentComplete += 1; else currentIncomplete += 1;
    if (acc.mappingStatus !== "FULLY_MAPPED") unclassifiedAccounts += 1;

    let varianceMinor: string | null = null;
    let variancePct: string | null = null;
    if (cur.status === "OK" && prev.status === "OK" && cur.valueMinor !== null && prev.valueMinor !== null) {
      const v = cur.valueMinor - prev.valueMinor;
      varianceMinor = v.toString();
      variancePct = prev.valueMinor === BigInt(0) ? null : ((Number(v) / Number(prev.valueMinor < BigInt(0) ? -prev.valueMinor : prev.valueMinor)) * 100).toFixed(1);
    }
    rows.push({
      accountCode: acc.accountCode,
      accountName: acc.accountName,
      mainCategory: acc.mainCategory,
      classification: acc.classification,
      aggregationBehavior: acc.aggregationBehavior,
      statementLineCode: acc.statementLineCode,
      mappingStatus: acc.mappingStatus,
      currentStatus: cur.status,
      currentMinor: cur.valueMinor?.toString() ?? null,
      previousStatus: prev.status,
      previousMinor: prev.valueMinor?.toString() ?? null,
      varianceMinor,
      variancePct,
    });
  }

  return {
    company,
    fiscalYear: { code: ctx.fy.code, displayNameAr: ctx.fy.displayNameAr, startDate: ctx.fy.startDate, endDate: ctx.fy.endDate },
    currentPeriod: { ordinal: ctx.period.ordinal, startDate: ctx.period.startDate, endDate: ctx.period.endDate, displayLabel: ctx.period.displayLabel },
    previousPeriod,
    rows,
    summary: { total: rows.length, currentComplete, currentIncomplete, unclassifiedAccounts },
    provenance,
  };
}

export interface MonthVsCumulativeRow {
  accountCode: string;
  accountName: string;
  mainCategory: string | null;
  classification: string | null;
  aggregationBehavior: string | null;
  statementLineCode: string | null;
  mappingStatus: string | null;
  monthStatus: string;
  monthMinor: string | null;
  ytdStatus: string;
  ytdMinor: string | null;
}

export interface MonthVsCumulativeResult {
  company: { code: string; nameAr: string };
  fiscalYear: { code: string; displayNameAr: string; startDate: string; endDate: string };
  period: { ordinal: number; startDate: string; endDate: string; displayLabel: string };
  rows: MonthVsCumulativeRow[];
  summary: { total: number; complete: number; incomplete: number; unclassifiedAccounts: number };
  provenance: ReportingProvenance;
}

/** «الشهر مقابل التراكمي» من البيانات المحفوظة — BALANCE تُعرض كرصيد إقفال (as-of) بلا جمع. */
export async function getSavedMonthVsCumulative(
  user: SessionUser,
  input: { companyId?: unknown; fiscalYearId?: unknown; ordinal?: unknown }
): Promise<MonthVsCumulativeResult> {
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  const fiscalYearId = typeof input.fiscalYearId === "string" ? input.fiscalYearId.trim() : "";
  const ordinal = Number(input.ordinal);
  if (!companyId || !fiscalYearId) {
    throw new TrialBalanceError("COMPANY_REQUIRED", "الشركة والسنة المالية إلزاميتان.");
  }
  assertReportScope(user, companyId);

  const [company, ctx] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { code: true, nameAr: true } }),
    loadContext(companyId, fiscalYearId, ordinal),
  ]);
  if (!company) throw new TrialBalanceError("NOT_FOUND", "الشركة غير موجودة.");

  const accounts = await loadCommittedAccountPoints(companyId, fiscalYearId);
  const provenance = await loadReportingProvenance(companyId, fiscalYearId);
  const rows: MonthVsCumulativeRow[] = [];
  let complete = 0;
  let incomplete = 0;
  let unclassifiedAccounts = 0;

  for (const acc of Array.from(accounts.values()).sort((a, b) => a.accountCode.localeCompare(b.accountCode))) {
    const behavior = acc.aggregationBehavior === "BALANCE" ? "BALANCE" : "FLOW";
    if (behavior === "BALANCE") {
      const asOf = safeValue(() => balanceAsOfFromPoints(acc.points, ordinal), "الرصيد");
      const row: MonthVsCumulativeRow = {
        accountCode: acc.accountCode,
        accountName: acc.accountName,
        mainCategory: acc.mainCategory,
        classification: acc.classification,
        aggregationBehavior: acc.aggregationBehavior,
        statementLineCode: acc.statementLineCode,
        mappingStatus: acc.mappingStatus,
        monthStatus: asOf.status === "OK" ? "OK" : asOf.status,
        monthMinor: null, // لحسابات الأرصدة: لا «حركة شهر» ذات معنى — لا رقم مُختلق
        ytdStatus: asOf.status,
        ytdMinor: asOf.valueMinor?.toString() ?? null,
      };
      rows.push(row);
      if (asOf.status === "OK") complete += 1; else incomplete += 1;
    } else {
      const month = safeValue(() => flowMonthMovementFromPoints(acc.points, ordinal), "حركة الشهر");
      const ytd = safeValue(() => flowYTDFromPoints(acc.points, ordinal), "التراكمي");
      const ok = month.status === "OK" && ytd.status === "OK";
      rows.push({
        accountCode: acc.accountCode,
        accountName: acc.accountName,
        mainCategory: acc.mainCategory,
        classification: acc.classification,
        aggregationBehavior: acc.aggregationBehavior,
        statementLineCode: acc.statementLineCode,
        mappingStatus: acc.mappingStatus,
        monthStatus: month.status,
        monthMinor: month.valueMinor?.toString() ?? null,
        ytdStatus: ytd.status,
        ytdMinor: ytd.valueMinor?.toString() ?? null,
      });
      if (ok) complete += 1; else incomplete += 1;
    }
    if (acc.mappingStatus !== "FULLY_MAPPED") unclassifiedAccounts += 1;
  }

  return {
    company,
    fiscalYear: { code: ctx.fy.code, displayNameAr: ctx.fy.displayNameAr, startDate: ctx.fy.startDate, endDate: ctx.fy.endDate },
    period: { ordinal: ctx.period.ordinal, startDate: ctx.period.startDate, endDate: ctx.period.endDate, displayLabel: ctx.period.displayLabel },
    rows,
    summary: { total: rows.length, complete, incomplete, unclassifiedAccounts },
    provenance,
  };
}

/* ── Phase 6.4 — مساعد مركزي وحيد: صافي الربح/الخسارة عبر مدى (أساس SOCIE و IAS7) ── */

export interface RangeNetResult {
  status: "OK" | "INCOMPLETE_DATA";
  valueMinor: bigint | null;
  revenueMinor: bigint | null;
  expenseMinor: bigint | null;
  incompleteAccounts: string[];
}

/**
 * صافي الربح/الخسارة للمدى من أحدث المراجعات المعتمدة حصرًا:
 * الإيرادات − المصروفات بحركة المدى (FLOW عبر الجسور الموحدة — لا جمع تراكمي مزدوج).
 * مصنّف رئيسي REVENUE/EXPENSE فقط — الحسابات غير القابلة للحساب تُبلّغ لا تُختلق.
 */
export function netProfitOrLossRangeFromAccounts(
  accounts: Map<string, AccountPoints>,
  startOrdinal: number,
  endOrdinal: number
): RangeNetResult {
  let revenue = BigInt(0);
  let expense = BigInt(0);
  const incompleteAccounts: string[] = [];
  for (const acc of accounts.values()) {
    if (acc.classification !== "REVENUE" && acc.classification !== "EXPENSE") continue;
    const behavior = acc.aggregationBehavior === "BALANCE" ? "BALANCE" : "FLOW";
    try {
      const v =
        behavior === "BALANCE"
          ? balanceAsOfFromPoints(acc.points, endOrdinal) - (startOrdinal <= 1 ? BigInt(0) : balanceAsOfFromPoints(acc.points, startOrdinal - 1))
          : flowRangeMovementFromPoints(acc.points, startOrdinal, endOrdinal);
      if (acc.classification === "REVENUE") revenue += v;
      else expense += v;
    } catch {
      incompleteAccounts.push(acc.accountCode);
    }
  }
  // اصطلاح القائمة: الإيراد دائن ⇒ −net موجب؛ المصروف مدين ⇒ +net موجب؛ الصافي = إيراد − مصروف
  const revenueMinor = -revenue;
  const expenseMinor = expense;
  return {
    status: incompleteAccounts.length === 0 ? "OK" : "INCOMPLETE_DATA",
    valueMinor: incompleteAccounts.length === 0 ? revenueMinor - expenseMinor : null,
    revenueMinor: incompleteAccounts.length === 0 ? revenueMinor : null,
    expenseMinor: incompleteAccounts.length === 0 ? expenseMinor : null,
    incompleteAccounts,
  };
}
