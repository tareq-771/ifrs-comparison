// Phase 6.6 — خدمة التوحيد والتقرير الجماعي المبدئي (خادم فقط).
//
// الضوابط (خارطة 6.6):
//   - كل شركة بدليلها وبنودها؛ الربط على مستوى بند قائمة الشركة → البند الجماعي
//     (GroupReportingMapping) — لا اشتراط تطابق أكواد الحسابات.
//   - محاذاة الفترات بالتواريخ: لكل شركة عضو تُشتق سنتها وفترتها من مدى التقرير —
//     شركة بلا بيانات معتمدة للمدى ⇒ INCOMPLETE_DATA (لا صفر صامت).
//   - التجميع قبل الاستبعادات؛ القيود اليدوية (ADJUSTMENT/ELIMINATION) متوازنة
//     حصرًا (Σمدين = Σدائن على مستوى القيد) وبحالة POSTED لتدخل الإجماليات.
//   - القوائم المبدئية PRELIMINARY — لا ادعاء توحيد IFRS كامل (NCI/شهرة/استحواذ/عملة لاحقًا).
//   - معادلة المركز المالي تُعرض بفارق صريح — بلا plug.
//   - الصلاحيات: المستخدم يجب أن يرى كل الشركات الأعضاء المشمولة (fail-closed).

import { db } from "@/lib/db";
import { companyVisible } from "@/lib/company-access";
import { writeAudit } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { loadCommittedAccountPoints } from "@/lib/reporting-server";
import { balanceAsOfFromPoints, flowRangeMovementFromPoints } from "@/lib/trial-balance-data";
import type { SessionUser } from "@/lib/session";

function fail(code: import("@/lib/trial-balance").TrialBalanceErrorCode, message: string): never {
  throw new TrialBalanceError(code, message);
}

/* ── إنشاء قيد توحيد/استبعاد متوازن ── */

export interface CreateAdjustmentArgs {
  user: SessionUser;
  ip: string | null;
  input: {
    groupId?: unknown;
    kind?: unknown; // ADJUSTMENT | ELIMINATION
    eliminationType?: unknown; // للـ ELIMINATION
    fiscalYearId?: unknown;
    startDate?: unknown;
    endDate?: unknown;
    reason?: unknown;
    lines?: unknown; // [{ groupLineCode, debitMinor, creditMinor }]
    post?: unknown; // true ⇒ POSTED مباشرة (بعد التوازن)
  };
}

export async function createConsolidationAdjustment(args: CreateAdjustmentArgs) {
  const { user, ip, input } = args;
  const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
  if (!groupId) fail("COMPANY_REQUIRED", "المجموعة إلزامية.");
  await assertGroupAccess(user, groupId);

  const kind = input.kind === "ELIMINATION" ? "ELIMINATION" : "ADJUSTMENT";
  const eliminationType = typeof input.eliminationType === "string" ? input.eliminationType : null;
  if (kind === "ELIMINATION" && !["INTERCOMPANY_AR_AP", "INTERCOMPANY_SALES_PURCHASES", "INTERCOMPANY_LOANS", "INTERCOMPANY_DIVIDENDS", "OTHER"].includes(eliminationType ?? "")) {
    fail("INVALID_LINE", "نوع الاستبعاد بين الشركات إلزامي من الأنواع الموثقة.");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  if (!reason) fail("REASON_REQUIRED", "سبب القيد إلزامي — لا قيد توحيد بلا سبب موثق.");
  const startDate = typeof input.startDate === "string" ? input.startDate.trim() : "";
  const endDate = typeof input.endDate === "string" ? input.endDate.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
    fail("INVALID_DATE_RANGE", "مدى القيد (date-only) إلزامي وصحيح.");
  }
  const rawLines = Array.isArray(input.lines) ? (input.lines as Array<{ groupLineCode?: unknown; debitMinor?: unknown; creditMinor?: unknown }>) : [];
  if (rawLines.length === 0) fail("INVALID_LINE", "سطور القيد إلزامية.");

  const group = await db.consolidationGroup.findUnique({ where: { id: groupId }, select: { code: true } });
  if (!group) fail("NOT_FOUND", "المجموعة غير موجودة.");

  const row = await db.$transaction(async (tx) => {
    let totalDebit = BigInt(0);
    let totalCredit = BigInt(0);
    const prepared: Array<{ groupLineId: string; debitMinor: bigint; creditMinor: bigint }> = [];
    for (const l of rawLines) {
      const lineCode = typeof l.groupLineCode === "string" ? l.groupLineCode.trim() : "";
      const groupLine = lineCode ? await tx.groupReportingLine.findUnique({ where: { groupId_code: { groupId, code: lineCode } } }) : null;
      if (!groupLine || !groupLine.isActive) fail("INVALID_LINE", `بند جماعي غير موجود أو غير نشط: ${lineCode || "—"}`);
      const debit = parseMinor(l.debitMinor);
      const credit = parseMinor(l.creditMinor);
      if (debit < BigInt(0) || credit < BigInt(0) || (debit !== BigInt(0) && credit !== BigInt(0))) {
        fail("INVALID_LINE", `سطر القيد يجب أن يكون مدينًا أو دائنًا حصرًا (غير سالب): ${lineCode}`);
      }
      totalDebit += debit;
      totalCredit += credit;
      prepared.push({ groupLineId: groupLine.id, debitMinor: debit, creditMinor: credit });
    }
    if (totalDebit === BigInt(0) && totalCredit === BigInt(0)) fail("INVALID_LINE", "قيد بلا مبالغ.");
    if (totalDebit !== totalCredit) {
      fail("NOT_BALANCED", `قيد غير متوازن (مدين ${totalDebit} ≠ دائن ${totalCredit}) — لا يدخل الإجماليات الموحدة.`);
    }
    const post = input.post === true;
    const created = await tx.consolidationAdjustment.create({
      data: {
        groupId,
        kind,
        eliminationType: kind === "ELIMINATION" ? eliminationType : null,
        fiscalYearId: typeof input.fiscalYearId === "string" && input.fiscalYearId.trim() ? input.fiscalYearId.trim() : null,
        startDate,
        endDate,
        reason,
        status: post ? "POSTED" : "DRAFT",
        preparedBy: user.username,
        postedBy: post ? user.username : "",
        postedAt: post ? new Date() : null,
        lines: { create: prepared },
      },
      include: { lines: true },
    });
    await writeAudit(tx, {
      user,
      action: post ? "CONSOLIDATION_ADJUSTMENT_POSTED" : "CONSOLIDATION_ADJUSTMENT_CREATED",
      entityType: "Backfill",
      entityId: created.id,
      description: `قيد توحيد (${kind === "ELIMINATION" ? `استبعاد ${eliminationType}` : "تسوية"}) على مجموعة ${group.code} — ${prepared.length} سطرًا — متوازن`,
      metadata: { groupId, kind, eliminationType, startDate, endDate, totalDebitMinor: totalDebit.toString(), reason, posted: post },
      ip,
    });
    return created;
  });
  return serializeAdjustment(row);
}

function parseMinor(v: unknown): bigint {
  try {
    return BigInt(String(v ?? "0").trim() || "0");
  } catch {
    return BigInt(-1);
  }
}

function serializeAdjustment(a: { id: string; groupId: string; kind: string; eliminationType: string | null; fiscalYearId: string | null; startDate: string; endDate: string; reason: string; status: string; preparedBy: string; postedBy: string; postedAt: Date | null; createdAt: Date; lines: Array<{ id: string; groupLineId: string; debitMinor: bigint; creditMinor: bigint }> }) {
  return {
    ...a,
    postedAt: a.postedAt ? a.postedAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    lines: a.lines.map((l) => ({ ...l, debitMinor: l.debitMinor.toString(), creditMinor: l.creditMinor.toString() })),
  };
}

/* ── الوصول الجماعي fail-closed: رؤية كل الأعضاء المشمولة ── */

async function assertGroupAccess(user: SessionUser, groupId: string) {
  const group = await db.consolidationGroup.findUnique({
    where: { id: groupId },
    include: { memberships: { select: { companyId: true, effectiveFrom: true, effectiveTo: true, ownershipPercentage: true } } },
  });
  if (!group || group.status !== "ACTIVE") fail("NOT_FOUND", "المجموعة غير موجودة أو غير نشطة.");
  if (user.role === "admin" && user.permissions.viewAllCompanies) return group;
  for (const m of group.memberships) {
    if (!companyVisible(user, m.companyId)) fail("NOT_FOUND", "لا تملك رؤية كل الشركات الأعضاء في المجموعة.");
  }
  return group;
}

/* ── القوائم الموحدة المبدئية + ورقة العمل ── */

export interface ConsolidatedWorkingPaperRow {
  groupLineCode: string;
  groupLineNameAr: string;
  statementType: string;
  companyValues: Array<{ companyId: string; companyCode: string; valueMinor: string | null; status: string }>;
  totalBeforeEliminationsMinor: string | null;
  adjustmentsMinor: string | null;
  consolidatedTotalMinor: string | null;
}

export interface ConsolidatedStatementsResult {
  group: { id: string; code: string; nameAr: string };
  range: { startDate: string; endDate: string };
  members: Array<{ companyId: string; companyCode: string; ownershipPercentage: number | null; dataStatus: string; fiscalYearCode: string | null }>;
  workingPaper: ConsolidatedWorkingPaperRow[];
  profitOrLoss: { totalRevenueMinor: string | null; totalExpensesMinor: string | null; netResultMinor: string | null };
  financialPosition: { totalAssetsMinor: string | null; totalLiabilitiesMinor: string | null; totalEquityMinor: string | null; differenceMinor: string | null; reconciled: boolean | null };
  status: "OK" | "INCOMPLETE_DATA";
  completenessNotes: string[];
  preliminary: true;
}

export async function getConsolidatedStatements(
  user: SessionUser,
  input: { groupId?: unknown; startDate?: unknown; endDate?: unknown }
): Promise<ConsolidatedStatementsResult> {
  const groupId = typeof input.groupId === "string" ? input.groupId.trim() : "";
  const startDate = typeof input.startDate === "string" ? input.startDate.trim() : "";
  const endDate = typeof input.endDate === "string" ? input.endDate.trim() : "";
  if (!groupId) fail("COMPANY_REQUIRED", "المجموعة إلزامية.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
    fail("INVALID_DATE_RANGE", "مدى التقرير الموحد (date-only) إلزامي.");
  }
  const group = await assertGroupAccess(user, groupId);

  // الأعضاء الفعليون للمدى (effectiveFrom <= endDate && (effectiveTo == null || effectiveTo >= startDate))
  const members = group.memberships.filter((m) => m.effectiveFrom <= endDate && (!m.effectiveTo || m.effectiveTo >= startDate));
  if (members.length === 0) fail("NOT_FOUND", "لا شركات أعضاء نشطة في مدى التقرير.");

  const lines = await db.groupReportingLine.findMany({
    where: { groupId, isActive: true },
    orderBy: [{ statementType: "asc" }, { displayOrder: "asc" }],
  });
  const mappings = await db.groupReportingMapping.findMany({ where: { groupId } });
  const lineById = new Map(lines.map((l) => [l.id, l]));
  // companyLineCode → groupLineCode (لكل شركة)
  const mapByCompany = new Map<string, Map<string, string>>(); // companyId -> companyLineCode -> groupLineCode
  for (const m of mappings) {
    if (!mapByCompany.has(m.companyId)) mapByCompany.set(m.companyId, new Map());
    mapByCompany.get(m.companyId)!.set(m.companyLineCode, (await lineCode(m.groupLineId))!);
  }
  async function lineCode(id: string): Promise<string | undefined> {
    return lineById.get(id)?.code ?? (await db.groupReportingLine.findUnique({ where: { id }, select: { code: true } }))?.code ?? undefined;
  }

  // لكل شركة: اشتقاق سنتها وفترتها من التواريخ + القيم لكل بند جماعي
  const companyValues = new Map<string, { status: string; fyCode: string | null; byGroupLine: Map<string, bigint> }>();
  const completenessNotes: string[] = [];
  for (const m of members) {
    const company = await db.company.findUnique({ where: { id: m.companyId }, select: { code: true } });
    if (!company) continue;
    companyCodeCache.set(m.companyId, company.code);
    // سنة الشركة التي يقع بها endDate (محاذاة بالتاريخ — لا افتراض تقويم موحد)
    const fy = await db.fiscalYear.findFirst({
      where: { companyId: m.companyId, startDate: { lte: endDate }, endDate: { gte: endDate } },
      select: { id: true, code: true, periodCount: true },
    });
    if (!fy) {
      companyValues.set(m.companyId, { status: "INCOMPLETE_DATA", fyCode: null, byGroupLine: new Map() });
      completenessNotes.push(`الشركة ${company.code}: لا سنة مالية تغطي نهاية المدى ${endDate} — لا صفر صامت.`);
      continue;
    }
    const accounts = await loadCommittedAccountPoints(m.companyId, fy.id);
    // ordinals من التواريخ عبر فترات الشركة
    const periods = await db.fiscalPeriod.findMany({ where: { fiscalYearId: fy.id }, orderBy: { ordinal: "asc" }, select: { id: true, ordinal: true, startDate: true, endDate: true } });
    const startPeriod = periods.find((p) => p.startDate <= startDate && p.endDate >= startDate);
    const endPeriod = periods.find((p) => p.startDate <= endDate && p.endDate >= endDate);
    if (!startPeriod || !endPeriod) {
      companyValues.set(m.companyId, { status: "INCOMPLETE_DATA", fyCode: fy.code, byGroupLine: new Map() });
      completenessNotes.push(`الشركة ${company.code}: مدى التقرير لا يتوافق مع فترات سنتها المالية.`);
      continue;
    }
    // القيم لكل بند شركة (نفس اصطلاح company statements: net = مدين−دائن)
    const byCompanyLine = new Map<string, bigint>();
    let anyData = false;
    for (const acc of accounts.values()) {
      if (!acc.statementLineCode) continue;
      const behavior = acc.aggregationBehavior === "BALANCE" ? "BALANCE" : "FLOW";
      try {
        const v = behavior === "BALANCE"
          ? balanceAsOfFromPoints(acc.points, endPeriod.ordinal) - (startPeriod.ordinal <= 1 ? BigInt(0) : balanceAsOfFromPoints(acc.points, startPeriod.ordinal - 1))
          : flowRangeMovementFromPoints(acc.points, startPeriod.ordinal, endPeriod.ordinal);
        if (v !== BigInt(0)) anyData = true;
        byCompanyLine.set(acc.statementLineCode, (byCompanyLine.get(acc.statementLineCode) ?? BigInt(0)) + v);
      } catch {
        completenessNotes.push(`الشركة ${company.code}: حساب ${acc.accountCode} لا يمكن حساب قيمته للمدى (بيانات غير مكتملة).`);
      }
    }
    if (!anyData && byCompanyLine.size === 0) {
      companyValues.set(m.companyId, { status: "INCOMPLETE_DATA", fyCode: fy.code, byGroupLine: new Map() });
      completenessNotes.push(`الشركة ${company.code}: لا بيانات معتمدة للمدى — لا صفر صامت.`);
      continue;
    }
    // تجميع إلى البنود الجماعية عبر الخريطة
    const byGroupLine = new Map<string, bigint>();
    const mapping = mapByCompany.get(m.companyId) ?? new Map<string, string>();
    for (const [companyLineCode, v] of byCompanyLine.entries()) {
      const gl = mapping.get(companyLineCode);
      if (!gl) {
        completenessNotes.push(`الشركة ${company.code}: بند ${companyLineCode} غير مربوط ببند جماعي — لا يدخل الإجمالي (فجوة معلنة).`);
        continue;
      }
      byGroupLine.set(gl, (byGroupLine.get(gl) ?? BigInt(0)) + v);
    }
    companyValues.set(m.companyId, { status: "OK", fyCode: fy.code, byGroupLine });
  }

  // القيود POSTED المشمولة بالمدى (محاذاة تداخل تواريخ)
  const adjustments = await db.consolidationAdjustment.findMany({
    where: { groupId, status: "POSTED", startDate: { lte: endDate }, endDate: { gte: startDate } },
    include: { lines: true },
  });
  const adjByGroupLine = new Map<string, bigint>();
  for (const adj of adjustments) {
    for (const l of adj.lines) {
      const glCode = lineById.get(l.groupLineId)?.code ?? (await lineCode(l.groupLineId)) ?? "";
      const net = l.debitMinor - l.creditMinor;
      adjByGroupLine.set(glCode, (adjByGroupLine.get(glCode) ?? BigInt(0)) + net);
    }
  }

  // ورقة العمل
  const allStatusOk = members.every((m) => companyValues.get(m.companyId)?.status === "OK");
  const workingPaper: ConsolidatedWorkingPaperRow[] = [];
  let totalRevenue = BigInt(0);
  let totalExpenses = BigInt(0);
  let hasPnl = false;
  let totalAssets = BigInt(0);
  let totalLiabilities = BigInt(0);
  let totalEquity = BigInt(0);
  let hasSfp = false;
  let assetsComplete = true;
  let liabEqComplete = true;

  for (const line of lines) {
    const companyVals = members.map((m) => {
      const cv = companyValues.get(m.companyId);
      const v = cv?.byGroupLine.get(line.code);
      return {
        companyId: m.companyId,
        companyCode: (members.length ? m.companyId : "") && (companyCodeCache.get(m.companyId) ?? m.companyId),
        valueMinor: v === undefined ? null : v.toString(),
        status: cv?.status ?? "INCOMPLETE_DATA",
      };
    });
    let totalBefore: bigint | null = BigInt(0);
    let complete = true;
    for (const cv of companyVals) {
      if (cv.valueMinor === null || cv.status !== "OK") complete = false;
      else totalBefore += BigInt(cv.valueMinor);
    }
    const adjNet = adjByGroupLine.get(line.code);
    const consolidated = complete && totalBefore !== null ? totalBefore + (adjNet ?? BigInt(0)) : null;
    // تجميع القوائم (net convention: الإيراد سالب، المصروف موجب، الأصول موجبة، الالتزام/الحقوق سالبة)
    if (line.statementType === "PROFIT_OR_LOSS" && consolidated !== null) {
      hasPnl = true;
      if (line.code.endsWith("REVENUE") || (line.nameAr.includes("إيراد"))) { totalRevenue += consolidated; }
      else { totalExpenses += consolidated; }
    }
    if (line.statementType === "STATEMENT_OF_FINANCIAL_POSITION" && consolidated !== null) {
      hasSfp = true;
      // التصنيف الجماعي عبر الكود: ASSET/LIAB/EQUITY في اسم الكود الجماعي (اصطلاح التأسيس)
      if (/ASSET|CASH|RECEIVABLE|INVENTORY|INVEST/.test(line.code.toUpperCase())) totalAssets += consolidated;
      else if (/LIAB|PAYABLE|TAX/.test(line.code.toUpperCase())) { totalLiabilities += consolidated; }
      else if (/EQUITY/.test(line.code.toUpperCase())) { totalEquity += consolidated; }
    }
    if (line.statementType === "STATEMENT_OF_FINANCIAL_POSITION") {
      const classified = /ASSET|CASH|RECEIVABLE|INVENTORY|INVEST|LIAB|PAYABLE|TAX|EQUITY/.test(line.code.toUpperCase());
      if (!classified) liabEqComplete = false;
      if (/ASSET|CASH|RECEIVABLE|INVENTORY|INVEST/.test(line.code.toUpperCase())) void assetsComplete;
    }
    workingPaper.push({
      groupLineCode: line.code,
      groupLineNameAr: line.nameAr,
      statementType: line.statementType,
      companyValues: companyVals,
      totalBeforeEliminationsMinor: complete ? totalBefore.toString() : null,
      adjustmentsMinor: adjNet === undefined ? null : adjNet.toString(),
      consolidatedTotalMinor: consolidated?.toString() ?? null,
    });
  }

  const difference = hasSfp && allStatusOk ? totalAssets + totalLiabilities + totalEquity : null;
  const status: "OK" | "INCOMPLETE_DATA" = allStatusOk && completenessNotes.length === 0 ? "OK" : "INCOMPLETE_DATA";

  return {
    group: { id: group.id, code: group.code, nameAr: group.nameAr },
    range: { startDate, endDate },
    members: members.map((m) => ({
      companyId: m.companyId,
      companyCode: companyCodeCache.get(m.companyId) ?? m.companyId,
      ownershipPercentage: m.ownershipPercentage,
      dataStatus: companyValues.get(m.companyId)?.status ?? "INCOMPLETE_DATA",
      fiscalYearCode: companyValues.get(m.companyId)?.fyCode ?? null,
    })),
    workingPaper,
    profitOrLoss: {
      totalRevenueMinor: hasPnl ? totalRevenue.toString() : null,
      totalExpensesMinor: hasPnl ? totalExpenses.toString() : null,
      netResultMinor: hasPnl ? (totalRevenue + totalExpenses).toString() : null,
    },
    financialPosition: {
      totalAssetsMinor: hasSfp ? totalAssets.toString() : null,
      totalLiabilitiesMinor: hasSfp ? totalLiabilities.toString() : null,
      totalEquityMinor: hasSfp ? totalEquity.toString() : null,
      differenceMinor: difference === null ? null : difference.toString(),
      reconciled: difference === null ? null : difference === BigInt(0),
    },
    status,
    completenessNotes,
    preliminary: true,
  };
}

const companyCodeCache = new Map<string, string>();
