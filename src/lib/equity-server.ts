// Phase 6.4A — خدمة قائمة التغيرات في حقوق الملكية (خادم فقط — طبقة مركزية).
//
// المبادئ:
//   - المفاهيم (9) reporting concepts تُربط لكل شركة ببادئاتها — أطول بادئة تفوز.
//   - البيانات من أحدث المراجعات المعتمدة حصرًا (قاعدة 6.3 المركزية) + provenance.
//   - Opening/Movement/Closing لكل مفهوم من أرصدة BALANCE المحفوظة — لا اختراع حركات.
//   - أي حساب حقوق ملكية غير مربوط بحركة ≠ 0 ⇒ INCOMPLETE_DATA مع قائمة صريحة.
//   - المعادلة: إجمالي الافتتاحي + إجمالي الحركات المعرّفة = إجمالي الإقفالي (تعرض دائمًا).

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
  EQUITY_COMPONENT_LABELS,
  isEquityComponent,
  type EquityComponent,
} from "@/lib/equity";
import type { SessionUser } from "@/lib/session";

export interface EquityComponentRow {
  componentCode: string;
  label: string;
  openingMinor: string | null;
  openingStatus: string;
  closingMinor: string | null;
  closingStatus: string;
  movementMinor: string | null;
  movementStatus: string;
  accounts: Array<{ accountCode: string; accountName: string }>;
}

export interface EquityUnmappedAccount {
  accountCode: string;
  accountName: string;
  movementMinor: string | null;
  movementStatus: string;
}

export interface EquityStatementResult {
  company: { code: string; nameAr: string };
  fiscalYear: { code: string; displayNameAr: string; startDate: string; endDate: string };
  range: { startOrdinal: number; endOrdinal: number };
  rows: EquityComponentRow[];
  profitOrLossForPeriod: { status: string; valueMinor: string | null; incompleteAccounts: string[] };
  totals: {
    openingMinor: string | null;
    movementsMinor: string | null;
    closingMinor: string | null;
    reconciled: boolean | null; // null = لا يمكن الحسم (افتتاحي/إقفالي غير مكتمل)
  };
  status: "OK" | "INCOMPLETE_DATA";
  unmappedAccounts: EquityUnmappedAccount[];
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

export async function getEquityStatement(
  user: SessionUser,
  input: { companyId?: unknown; fiscalYearId?: unknown; startOrdinal?: unknown; endOrdinal?: unknown }
): Promise<EquityStatementResult> {
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
  const company = await db.company.findUnique({ where: { id: companyId }, select: { code: true, nameAr: true } });
  if (!company) throw new TrialBalanceError("NOT_FOUND", "الشركة غير موجودة.");

  const [accounts, mappings, provenance] = await Promise.all([
    loadCommittedAccountPoints(companyId, fiscalYearId),
    db.equityComponentMapping.findMany({
      where: { companyId, isActive: true },
      orderBy: { prefix: "desc" },
      select: { prefix: true, componentCode: true },
    }),
    loadReportingProvenance(companyId, fiscalYearId),
  ]);

  const openOrd = startOrdinal - 1;
  const componentRows = new Map<EquityComponent, EquityComponentRow>();
  const unmapped: EquityUnmappedAccount[] = [];

  for (const acc of Array.from(accounts.values()).sort((a, b) => a.accountCode.localeCompare(b.accountCode))) {
    if (acc.classification !== "EQUITY") continue;
    const behavior = acc.aggregationBehavior === "BALANCE" ? "BALANCE" : "FLOW";
    const opening = safeValue(
      () => (behavior === "BALANCE" ? balanceAsOfFromPoints(acc.points, openOrd) : flowRangeMovementFromPoints(acc.points, 1, openOrd)),
      openOrd >= 1 ? "الافتتاحي" : "الافتتاحي (بلا رصيد افتتاحي محفوظ — لا اختراع)"
    );
    const closing = safeValue(
      () => (behavior === "BALANCE" ? balanceAsOfFromPoints(acc.points, endOrdinal) : flowYTD(acc.points, endOrdinal)),
      "الإقفالي"
    );
    const movement = safeValue(
      () => (behavior === "BALANCE" ? closing.valueMinor! - opening.valueMinor! : flowRangeMovementFromPoints(acc.points, startOrdinal, endOrdinal)),
      "الحركة"
    );

    // ربط المفهوم: أطول بادئة تفوز (المصفوفة مرتبة تنازليًا)
    const mapping = mappings.find((m) => acc.accountCode.startsWith(m.prefix));
    if (!mapping || !isEquityComponent(mapping.componentCode)) {
      unmapped.push({
        accountCode: acc.accountCode,
        accountName: acc.accountName,
        movementMinor: movement.valueMinor?.toString() ?? null,
        movementStatus: movement.status,
      });
      continue;
    }
    const row = componentRows.get(mapping.componentCode) ?? {
      componentCode: mapping.componentCode,
      label: EQUITY_COMPONENT_LABELS[mapping.componentCode],
      openingMinor: null, openingStatus: "OK",
      closingMinor: null, closingStatus: "OK",
      movementMinor: null, movementStatus: "OK",
      accounts: [],
    };
    row.accounts.push({ accountCode: acc.accountCode, accountName: acc.accountName });
    if (opening.valueMinor !== null) row.openingMinor = (BigInt(row.openingMinor ?? "0") + opening.valueMinor).toString();
    else row.openingStatus = opening.status;
    if (closing.valueMinor !== null) row.closingMinor = (BigInt(row.closingMinor ?? "0") + closing.valueMinor).toString();
    else row.closingStatus = closing.status;
    if (movement.valueMinor !== null) row.movementMinor = (BigInt(row.movementMinor ?? "0") + movement.valueMinor).toString();
    else row.movementStatus = movement.status;
    componentRows.set(mapping.componentCode, row);
  }

  // صافي الربح/الخسارة للمدى (مساعد مركزي وحيد — 6.4)
  const pnl = netProfitOrLossRangeFromAccounts(accounts, startOrdinal, endOrdinal);

  // الإجماليات: من الصفوف المربوطة فقط — الحسابات غير المربوطة تُبلّغ كفجوة
  let openingTotal = BigInt(0);
  let closingTotal = BigInt(0);
  let movementsTotal = BigInt(0);
  let totalsComplete = true;
  for (const row of componentRows.values()) {
    if (row.openingMinor === null || row.openingStatus !== "OK") totalsComplete = false;
    else openingTotal += BigInt(row.openingMinor);
    if (row.closingMinor === null || row.closingStatus !== "OK") totalsComplete = false;
    else closingTotal += BigInt(row.closingMinor);
    if (row.movementMinor === null || row.movementStatus !== "OK") totalsComplete = false;
    else movementsTotal += BigInt(row.movementMinor);
  }

  const reconciled = totalsComplete
    ? openingTotal + movementsTotal === closingTotal
    : null;

  const status: "OK" | "INCOMPLETE_DATA" =
    unmapped.some((u) => u.movementMinor !== "0" || u.movementStatus !== "OK") ||
    !totalsComplete ||
    pnl.status !== "OK"
      ? "INCOMPLETE_DATA"
      : "OK";

  return {
    company: { code: company.code, nameAr: company.nameAr },
    fiscalYear: { code: fy.code, displayNameAr: fy.displayNameAr, startDate: fy.startDate, endDate: fy.endDate },
    range: { startOrdinal, endOrdinal },
    rows: Array.from(componentRows.values()),
    profitOrLossForPeriod: {
      status: pnl.status,
      valueMinor: pnl.valueMinor?.toString() ?? null,
      incompleteAccounts: pnl.incompleteAccounts,
    },
    totals: {
      openingMinor: totalsComplete ? openingTotal.toString() : null,
      movementsMinor: totalsComplete ? movementsTotal.toString() : null,
      closingMinor: totalsComplete ? closingTotal.toString() : null,
      reconciled,
    },
    status,
    unmappedAccounts: unmapped,
    provenance,
  };
}

function flowYTD(points: Parameters<typeof flowRangeMovementFromPoints>[0], ordinal: number): bigint {
  return flowRangeMovementFromPoints(points, 1, ordinal);
}
