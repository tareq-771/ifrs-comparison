// Phase 6.5 — خدمة الموازنات وفعلي مقابل الموازنة (خادم فقط).
//
// الضوابط:
//   - الموازنة لكل (شركة، سنة، نسخة، سيناريو) — لا تكرار؛ المعتمد/المقفل غير قابل للتعديل.
//   - كل الانتقالات عبر BUDGET_TRANSITIONS (fail-closed) + optimistic locking + تدقيق.
//   - البنود على مستوى بند القائمة المالية (statementLineCode) + فترة مخصصة — BigInt minor.
//   - الفعلي من أحدث المراجعات المعتمدة حصرًا (قاعدة 6.3) — الموازنة من نسخة APPROVED/LOCKED.
//   - الفارق الرقمي منفصل عن دلالة ف/غ (قاعدة مركزية واحدة في lib/budget.ts).

import { db } from "@/lib/db";
import { companyVisible } from "@/lib/company-access";
import { writeAudit } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { loadCommittedAccountPoints } from "@/lib/reporting-server";
import { balanceAsOfFromPoints, flowRangeMovementFromPoints } from "@/lib/trial-balance-data";
import {
  BUDGET_STATUSES,
  favorabilityFor,
  isBudgetTransitionAllowed,
  ordinalRangeForGranularity,
  type BudgetStatus,
} from "@/lib/budget";
import type { SessionUser } from "@/lib/session";

function fail(code: import("@/lib/trial-balance").TrialBalanceErrorCode, message: string): never {
  throw new TrialBalanceError(code, message);
}

function assertScope(user: SessionUser, companyId: string): void {
  if (!companyVisible(user, companyId)) fail("NOT_FOUND", "لا تملك الوصول لهذه الشركة.");
}

async function loadBudgetForUser(user: SessionUser, id: string) {
  const budget = await db.budget.findUnique({
    where: { id },
    include: { company: { select: { code: true, nameAr: true } }, fiscalYear: { select: { code: true, displayNameAr: true, startDate: true, endDate: true, periodCount: true } } },
  });
  if (!budget || !companyVisible(user, budget.companyId)) fail("NOT_FOUND", "الموازنة غير موجودة.");
  return budget;
}

const BUDGET_INCLUDE = {
  company: { select: { code: true, nameAr: true } },
  fiscalYear: { select: { code: true, displayNameAr: true, startDate: true, endDate: true, periodCount: true } },
  lines: { orderBy: [{ statementLineCode: "asc" as const }, { fiscalPeriodId: "asc" as const }] },
};

function toDTO(b: NonNullable<Awaited<ReturnType<typeof db.budget.findUnique>>> & { company: { code: string; nameAr: string }; fiscalYear: { code: string; displayNameAr: string; startDate: string; endDate: string; periodCount: number }; lines: Array<{ id: string; budgetId: string; statementLineCode: string; fiscalPeriodId: string | null; amountMinor: bigint; note: string }> }) {
  return {
    ...b,
    lines: b.lines.map((l) => ({ ...l, amountMinor: l.amountMinor.toString() })),
  };
}

/* ── الإنشاء (DRAFT) ── */

export interface CreateBudgetArgs {
  user: SessionUser;
  ip: string | null;
  input: {
    companyId?: unknown;
    fiscalYearId?: unknown;
    budgetType?: unknown;
    scenario?: unknown;
    name?: unknown;
    note?: unknown;
    startOrdinal?: unknown;
    endOrdinal?: unknown;
    lines?: unknown; // [{ statementLineCode, fiscalPeriodId?, amountMinor: string|number }]
  };
}

export async function createBudget(args: CreateBudgetArgs) {
  const { user, ip, input } = args;
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  const fiscalYearId = typeof input.fiscalYearId === "string" ? input.fiscalYearId.trim() : "";
  if (!companyId || !fiscalYearId) fail("COMPANY_REQUIRED", "الشركة والسنة المالية إلزاميتان.");
  assertScope(user, companyId);

  const budgetType = typeof input.budgetType === "string" ? input.budgetType : "";
  if (!["ANNUAL", "MONTHLY", "QUARTERLY", "SEMI_ANNUAL"].includes(budgetType)) fail("INVALID_BUDGET_TYPE", "نوع الموازنة إلزامي: ANNUAL | MONTHLY | QUARTERLY | SEMI_ANNUAL.");
  const scenario = typeof input.scenario === "string" && ["BASE", "CONSERVATIVE", "OPTIMISTIC"].includes(input.scenario) ? input.scenario : "BASE";
  const fy = await db.fiscalYear.findUnique({ where: { id: fiscalYearId }, select: { id: true, companyId: true, code: true, periodCount: true } });
  if (!fy || fy.companyId !== companyId) fail("FISCAL_YEAR_NOT_FOUND", "السنة المالية غير موجودة لهذه الشركة.");
  const startOrdinal = Math.max(1, Number(input.startOrdinal) || 1);
  const endOrdinal = Math.min(fy.periodCount, Number(input.endOrdinal) || fy.periodCount);
  if (startOrdinal > endOrdinal) fail("INVALID_DATE_RANGE", "مدى الموازنة غير صالح.");

  // نسخة جديدة = أعلى نسخة قائمة + 1 (لنفس السيناريو)
  const latest = await db.budget.findFirst({
    where: { companyId, fiscalYearId, scenario },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });
  const versionNumber = (latest?.versionNumber ?? 0) + 1;

  const rawLines = Array.isArray(input.lines) ? (input.lines as Array<{ statementLineCode?: unknown; fiscalPeriodId?: unknown; amountMinor?: unknown }>) : [];
  if (rawLines.length === 0) fail("INVALID_LINE", "بنود الموازنة إلزامية.");

  const budget = await db.$transaction(async (tx) => {
    const row = await tx.budget.create({
      data: {
        companyId,
        fiscalYearId,
        versionNumber,
        status: BUDGET_STATUSES.DRAFT,
        budgetType,
        scenario,
        name: typeof input.name === "string" ? input.name.trim().slice(0, 200) : "",
        note: typeof input.note === "string" ? input.note.trim().slice(0, 500) : "",
        startOrdinal,
        endOrdinal,
        createdById: user.id,
        createdByName: user.username,
        updatedById: user.id,
        updatedByName: user.username,
      },
    });
    for (const l of rawLines) {
      const code = typeof l.statementLineCode === "string" ? l.statementLineCode.trim() : "";
      if (!code) fail("INVALID_LINE", "كود بند القائمة المالية إلزامي في كل سطر.");
      const periodId = typeof l.fiscalPeriodId === "string" && l.fiscalPeriodId.trim() ? l.fiscalPeriodId.trim() : null;
      let amount: bigint;
      try {
        amount = BigInt(String(l.amountMinor ?? "").trim());
      } catch {
        fail("INVALID_LINE", `مبلغ غير صالح للبند ${code} (BigInt minor كسلسلة).`);
      }
      if (amount < BigInt(0)) fail("INVALID_LINE", `مبلغ سالب غير مقبول للبند ${code}.`);
      if (periodId) {
        const period = await tx.fiscalPeriod.findUnique({ where: { id: periodId }, select: { fiscalYearId: true, ordinal: true } });
        if (!period || period.fiscalYearId !== fiscalYearId) fail("INVALID_LINE", `فترة غير تابعة للسنة المالية للبند ${code}.`);
      }
      await tx.budgetLine.create({ data: { budgetId: row.id, statementLineCode: code, fiscalPeriodId: periodId, amountMinor: amount } });
    }
    return row;
  });

  await writeAudit(db, {
    user,
    action: "BUDGET_CREATED",
    entityType: "Budget",
    entityId: budget.id,
    description: `إنشاء موازنة ${budgetType} نسخة #${versionNumber} (${scenario}) لشركة (${fy.code})`,
    metadata: { companyId, fiscalYearId, budgetType, scenario, versionNumber, lines: rawLines.length },
    ip,
  });

  const full = await db.budget.findUnique({ where: { id: budget.id }, include: BUDGET_INCLUDE });
  return toDTO(full!);
}

/* ── تحديث بنود المسودة ── */

export interface UpdateBudgetLinesArgs {
  user: SessionUser;
  ip: string | null;
  id: string;
  input: { version?: unknown; lines?: unknown; note?: unknown };
}

export async function updateBudgetLines(args: UpdateBudgetLinesArgs) {
  const { user, ip, id, input } = args;
  const budget = await loadBudgetForUser(user, id);
  assertScope(user, budget.companyId);
  if (budget.status !== BUDGET_STATUSES.DRAFT) {
    fail("INVALID_STATE", `الموازنة حالتها ${budget.status} — بنود المسودة فقط قابلة للتعديل (المعتمد/المقفل ثابت).`);
  }
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) fail("VERSION_CONFLICT", "نسخة الموازنة (version) إلزامية للتحديث.");
  const rawLines = Array.isArray(input.lines) ? (input.lines as Array<{ statementLineCode?: unknown; fiscalPeriodId?: unknown; amountMinor?: unknown }>) : [];
  if (rawLines.length === 0) fail("INVALID_LINE", "بنود الموازنة إلزامية.");

  return db.$transaction(async (tx) => {
    const updated = await tx.budget.updateMany({
      where: { id, version },
      data: {
        version: version + 1,
        note: typeof input.note === "string" ? input.note.trim().slice(0, 500) : budget.note,
        updatedById: user.id,
        updatedByName: user.username,
      },
    });
    if (updated.count === 0) fail("VERSION_CONFLICT", "تعارض نسخ: الموازنة تغيّرت — أعد التحميل.");
    await tx.budgetLine.deleteMany({ where: { budgetId: id } });
    for (const l of rawLines) {
      const code = typeof l.statementLineCode === "string" ? l.statementLineCode.trim() : "";
      if (!code) fail("INVALID_LINE", "كود بند القائمة المالية إلزامي في كل سطر.");
      const periodId = typeof l.fiscalPeriodId === "string" && l.fiscalPeriodId.trim() ? l.fiscalPeriodId.trim() : null;
      let amount: bigint;
      try {
        amount = BigInt(String(l.amountMinor ?? "").trim());
      } catch {
        fail("INVALID_LINE", `مبلغ غير صالح للبند ${code}.`);
      }
      if (amount < BigInt(0)) fail("INVALID_LINE", `مبلغ سالب غير مقبول للبند ${code}.`);
      if (periodId) {
        const period = await tx.fiscalPeriod.findUnique({ where: { id: periodId }, select: { fiscalYearId: true } });
        if (!period || period.fiscalYearId !== budget.fiscalYearId) fail("INVALID_LINE", `فترة غير تابعة للسنة المالية للبند ${code}.`);
      }
      await tx.budgetLine.create({ data: { budgetId: id, statementLineCode: code, fiscalPeriodId: periodId, amountMinor: amount } });
    }
    const fresh = await tx.budget.findUnique({ where: { id }, include: BUDGET_INCLUDE });
    const meta = { budgetId: id, versionNumber: budget.versionNumber, lines: rawLines.length };
    await writeAudit(tx, {
      user,
      action: "BUDGET_UPDATED",
      entityType: "Budget",
      entityId: id,
      description: `تحديث بنود مسودة موازنة #${budget.versionNumber} (${budget.company.code} ${budget.fiscalYear.code})`,
      metadata: meta,
      ip,
    });
    return toDTO(fresh!);
  });
}

/* ── الانتقالات (SUBMIT/APPROVE/LOCK/RETURN) ── */

export interface TransitionBudgetArgs {
  user: SessionUser;
  ip: string | null;
  id: string;
  input: { action?: unknown; version?: unknown; reason?: unknown };
}

const TRANSITION_AUDIT: Record<string, string> = {
  SUBMITTED: "BUDGET_SUBMITTED",
  APPROVED: "BUDGET_APPROVED",
  LOCKED: "BUDGET_LOCKED",
  RETURNED: "BUDGET_RETURNED_TO_DRAFT",
};

export async function transitionBudget(args: TransitionBudgetArgs) {
  const { user, ip, id, input } = args;
  const budget = await loadBudgetForUser(user, id);
  assertScope(user, budget.companyId);
  const action = typeof input.action === "string" ? input.action.trim().toUpperCase() : "";
  const target = action === "SUBMIT" ? "SUBMITTED" : action === "APPROVE" ? "APPROVED" : action === "LOCK" ? "LOCKED" : action === "RETURN" ? "DRAFT" : "";
  if (!target) fail("INVALID_TRANSITION", `إجراء غير معروف: ${action || "—"}`);
  if (!isBudgetTransitionAllowed(budget.status, target)) {
    fail("INVALID_TRANSITION", `انتقال غير شرعي: ${budget.status} → ${target} (المسار: DRAFT→SUBMITTED→APPROVED→LOCKED).`);
  }
  if (target !== "DRAFT" && !user.permissions.view) fail("NOT_FOUND", "صلاحيات غير كافية.");
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) fail("VERSION_CONFLICT", "نسخة الموازنة (version) إلزامية للانتقال.");
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";

  const now = new Date();
  const patch: Record<string, unknown> = {
    status: target,
    version: version + 1,
    updatedById: user.id,
    updatedByName: user.username,
  };
  if (target === "SUBMITTED") Object.assign(patch, { submittedById: user.id, submittedByName: user.username, submittedAt: now });
  if (target === "APPROVED") Object.assign(patch, { approvedById: user.id, approvedByName: user.username, approvedAt: now });
  if (target === "LOCKED") Object.assign(patch, { lockedById: user.id, lockedByName: user.username, lockedAt: now });

  return db.$transaction(async (tx) => {
    const updated = await tx.budget.updateMany({ where: { id, version }, data: patch });
    if (updated.count === 0) fail("VERSION_CONFLICT", "تعارض نسخ: الموازنة تغيّرت — أعد التحميل.");
    const fresh = await tx.budget.findUnique({ where: { id }, include: BUDGET_INCLUDE });
    const meta = {
      budgetId: id,
      companyId: budget.companyId,
      fiscalYearCode: budget.fiscalYear.code,
      versionNumber: budget.versionNumber,
      fromStatus: budget.status,
      toStatus: target,
      reason: reason || undefined,
    };
    await writeAudit(tx, {
      user,
      action: TRANSITION_AUDIT[target] ?? "BUDGET_UPDATED",
      entityType: "Budget",
      entityId: id,
      description: `انتقال موازنة #${budget.versionNumber} (${budget.company.code} ${budget.fiscalYear.code}): ${budget.status} → ${target}`,
      metadata: meta,
      ip,
    });
    return toDTO(fresh!);
  });
}

/* ── نسخة جديدة (revision): versionNumber+1 مع نسخ البنود نقطة بداية ── */

export interface ReviseBudgetArgs {
  user: SessionUser;
  ip: string | null;
  id: string;
  input: { reason?: unknown };
}

export async function reviseBudget(args: ReviseBudgetArgs) {
  const { user, ip, id, input } = args;
  const source = await loadBudgetForUser(user, id);
  assertScope(user, source.companyId);
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
  if (!reason) fail("REASON_REQUIRED", "سبب النسخة الجديدة إلزامي.");

  return db.$transaction(async (tx) => {
    const latest = await tx.budget.findFirst({
      where: { companyId: source.companyId, fiscalYearId: source.fiscalYearId, scenario: source.scenario },
      orderBy: { versionNumber: "desc" },
      select: { id: true, versionNumber: true, status: true },
    });
    if (!latest || latest.id !== source.id) fail("REVISION_SOURCE_NOT_LATEST", "النسخة الجديدة تُنشأ من أحدث نسخة في سلسلتها حصرًا.");
    if (latest.status === "DRAFT") fail("REVISION_DRAFT_EXISTS", "توجد مسودة مفتوحة — أنهِها أو احذفها أولًا.");
    const versionNumber = latest.versionNumber + 1;
    const row = await tx.budget.create({
      data: {
        companyId: source.companyId,
        fiscalYearId: source.fiscalYearId,
        versionNumber,
        status: BUDGET_STATUSES.DRAFT,
        budgetType: source.budgetType,
        scenario: source.scenario,
        name: source.name,
        note: source.note,
        revisionReason: reason,
        supersedesBudgetId: source.id,
        startOrdinal: source.startOrdinal,
        endOrdinal: source.endOrdinal,
        createdById: user.id,
        createdByName: user.username,
        updatedById: user.id,
        updatedByName: user.username,
      },
    });
    const sourceLines = await tx.budgetLine.findMany({ where: { budgetId: source.id } });
    for (const l of sourceLines) {
      await tx.budgetLine.create({ data: { budgetId: row.id, statementLineCode: l.statementLineCode, fiscalPeriodId: l.fiscalPeriodId, amountMinor: l.amountMinor, note: l.note } });
    }
    await writeAudit(tx, {
      user,
      action: "BUDGET_REVISION_CREATED",
      entityType: "Budget",
      entityId: row.id,
      description: `إنشاء نسخة موازنة #${versionNumber} محلّ النسخة #${source.versionNumber} — ${sourceLines.length} بندًا مبذورًا`,
      before: { budgetId: source.id, versionNumber: source.versionNumber, status: source.status },
      after: { budgetId: row.id, versionNumber, status: "DRAFT", reason },
      metadata: { sourceBudgetId: source.id, oldVersion: source.versionNumber, newVersion: versionNumber, reason, lines: sourceLines.length },
      ip,
    });
    const full = await tx.budget.findUnique({ where: { id: row.id }, include: BUDGET_INCLUDE });
    return toDTO(full!);
  });
}

/* ── حذف مسودة ── */

export async function deleteBudget(args: { user: SessionUser; ip: string | null; id: string; input: { version?: unknown } }) {
  const { user, ip, id, input } = args;
  const budget = await loadBudgetForUser(user, id);
  assertScope(user, budget.companyId);
  if (budget.status !== BUDGET_STATUSES.DRAFT) fail("INVALID_STATE", "المسودات فقط قابلة للحذف.");
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) fail("VERSION_CONFLICT", "نسخة الموازنة إلزامية للحذف.");
  return db.$transaction(async (tx) => {
    const deleted = await tx.budget.deleteMany({ where: { id, version } });
    if (deleted.count === 0) fail("VERSION_CONFLICT", "تعارض نسخ عند الحذف.");
    await writeAudit(tx, {
      user,
      action: "BUDGET_DELETED",
      entityType: "Budget",
      entityId: id,
      description: `حذف مسودة موازنة #${budget.versionNumber} (${budget.company.code} ${budget.fiscalYear.code})`,
      metadata: { budgetId: id, versionNumber: budget.versionNumber },
      ip,
    });
    return { id };
  });
}

/* ── القائمة ── */

export async function listBudgets(user: SessionUser, companyId?: string | null) {
  const where = companyId ? { companyId } : {};
  const rows = await db.budget.findMany({ where, include: BUDGET_INCLUDE, orderBy: [{ companyId: "asc" }, { versionNumber: "desc" }] });
  const visible: ReturnType<typeof toDTO>[] = [];
  for (const r of rows) {
    if (!companyVisible(user, r.companyId)) continue;
    visible.push(toDTO(r));
  }
  return visible;
}

/* ── فعلي مقابل الموازنة ── */

export interface BudgetVarianceRow {
  statementLineCode: string;
  /** 6.9R (عهدة D): الاسم المعروض أساسي والكود ثانوي — من مرجع بنود القوائم (DB ثم null). */
  lineNameAr: string | null;
  lineNameEn: string | null;
  lineNature: "REVENUE" | "EXPENSE" | "OTHER";
  budgetMinor: string | null;
  actualMinor: string | null;
  actualStatus: string;
  varianceMinor: string | null;
  variancePct: string | null;
  favorability: string;
}

export interface BudgetVarianceResult {
  company: { code: string; nameAr: string };
  fiscalYear: { code: string; displayNameAr: string; startDate: string; endDate: string };
  budget: { id: string; versionNumber: number; scenario: string; status: string; budgetType: string };
  granularity: string;
  range: { startOrdinal: number; endOrdinal: number };
  rows: BudgetVarianceRow[];
  status: "OK" | "INCOMPLETE_DATA";
}

export async function getBudgetVariance(
  user: SessionUser,
  input: { companyId?: unknown; fiscalYearId?: unknown; budgetId?: unknown; granularity?: unknown; ordinal?: unknown }
): Promise<BudgetVarianceResult> {
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  const fiscalYearId = typeof input.fiscalYearId === "string" ? input.fiscalYearId.trim() : "";
  if (!companyId || !fiscalYearId) fail("COMPANY_REQUIRED", "الشركة والسنة المالية إلزاميتان.");
  assertScope(user, companyId);
  const fy = await db.fiscalYear.findUnique({ where: { id: fiscalYearId }, select: { id: true, companyId: true, code: true, displayNameAr: true, startDate: true, endDate: true, periodCount: true } });
  if (!fy || fy.companyId !== companyId) fail("FISCAL_YEAR_NOT_FOUND", "السنة المالية غير موجودة لهذه الشركة.");

  const granularity = (typeof input.granularity === "string" && ["MONTH", "QUARTER", "SEMI_ANNUAL", "ANNUAL", "YTD"].includes(input.granularity) ? input.granularity : "MONTH") as "MONTH" | "QUARTER" | "SEMI_ANNUAL" | "ANNUAL" | "YTD";
  const ordinal = Math.max(1, Math.min(fy.periodCount, Number(input.ordinal) || fy.periodCount));
  const range = ordinalRangeForGranularity(granularity, ordinal, fy.periodCount);

  // الموازنة: النسخة المحددة أو أحدث APPROVED/LOCKED
  let budget = typeof input.budgetId === "string" && input.budgetId.trim() ? await db.budget.findUnique({ where: { id: input.budgetId.trim() }, include: { lines: true } }) : null;
  if (budget) {
    if (budget.companyId !== companyId || budget.fiscalYearId !== fiscalYearId) fail("NOT_FOUND", "الموازنة لا تخص هذه الشركة/السنة.");
  } else {
    budget = await db.budget.findFirst({
      where: { companyId, fiscalYearId, status: { in: ["APPROVED", "LOCKED"] } },
      orderBy: { versionNumber: "desc" },
      include: { lines: true },
    });
  }
  if (!budget) fail("NOT_FOUND", "لا توجد موازنة معتمدة/مقفلة لهذه الشركة والسنة (المسودات لا تدخل التقارير).");

  // الفعلي من أحدث المراجعات المعتمدة حصرًا
  const accounts = await loadCommittedAccountPoints(companyId, fiscalYearId);

  // ميزانية المدى لكل بند: مجموع مبالغ الفترات ضمن المدى + المبالغ غير الموزعة (سنوية) تُحتسب في ANNUAL/YTD فقط
  const budgetByLine = new Map<string, bigint>();
  const periodIdsInRange = new Set(
    (await db.fiscalPeriod.findMany({ where: { fiscalYearId, ordinal: { gte: range.startOrdinal, lte: range.endOrdinal } }, select: { id: true } })).map((p) => p.id)
  );
  for (const l of budget.lines) {
    const inRange = l.fiscalPeriodId ? periodIdsInRange.has(l.fiscalPeriodId) : granularity === "ANNUAL" || granularity === "YTD";
    if (!inRange) continue;
    budgetByLine.set(l.statementLineCode, (budgetByLine.get(l.statementLineCode) ?? BigInt(0)) + l.amountMinor);
  }

  // طبيعة البند من تصنيف حساباته المربوطة (بيانات محركة — بلا hard-code)
  const natureByLine = new Map<string, "REVENUE" | "EXPENSE" | "OTHER">();
  const actualByLine = new Map<string, { v: bigint | null; status: string }>();
  for (const acc of accounts.values()) {
    if (!acc.statementLineCode) continue;
    if (acc.classification === "REVENUE" || acc.classification === "EXPENSE") {
      if (!natureByLine.has(acc.statementLineCode)) natureByLine.set(acc.statementLineCode, acc.classification as "REVENUE" | "EXPENSE");
    } else if (!natureByLine.has(acc.statementLineCode)) {
      natureByLine.set(acc.statementLineCode, "OTHER");
    }
    const behavior = acc.aggregationBehavior === "BALANCE" ? "BALANCE" : "FLOW";
    const prev = actualByLine.get(acc.statementLineCode);
    try {
      const raw =
        behavior === "BALANCE"
          ? balanceAsOfFromPoints(acc.points, range.endOrdinal) // بند رصيد: الفعلي = رصيد الإقفال as-of (الموازنة هدف رصيد)
          : flowRangeMovementFromPoints(acc.points, range.startOrdinal, range.endOrdinal);
      // تطبيع الحجم الطبيعي: الإيراد دائن ⇒ −net موجب؛ المصروف مدين ⇒ +net — موازنة الإدخال بالموجب
      const v = acc.classification === "REVENUE" ? -raw : raw;
      actualByLine.set(acc.statementLineCode, { v: (prev?.v ?? BigInt(0)) + v, status: prev?.status === "INCOMPLETE_DATA" ? "INCOMPLETE_DATA" : "OK" });
    } catch {
      actualByLine.set(acc.statementLineCode, { v: prev?.v ?? null, status: "INCOMPLETE_DATA" });
    }
  }

  const lineCodes = new Set<string>([...budgetByLine.keys(), ...actualByLine.keys()]);
  // 6.9R (عهدة D): أسماء البنود المعروضة من المرجع (الاسم أساسي والكود ثانوي)
  const lineNameRows = lineCodes.size > 0
    ? await db.financialStatementLine.findMany({ where: { code: { in: Array.from(lineCodes) } }, select: { code: true, nameAr: true, nameEn: true } })
    : [];
  const lineNameByCode = new Map(lineNameRows.map((l) => [l.code, l]));
  const rows: BudgetVarianceRow[] = [];
  let status: "OK" | "INCOMPLETE_DATA" = "OK";
  for (const code of Array.from(lineCodes).sort()) {
    const b = budgetByLine.get(code) ?? null;
    const a = actualByLine.get(code) ?? { v: null, status: "NO_DATA" };
    const nature = natureByLine.get(code) ?? "OTHER";
    const variance = a.v !== null && b !== null ? a.v - b : null;
    const pct = variance !== null && b !== null && b !== BigInt(0) ? ((Number(variance) / Number(b < BigInt(0) ? -b : b)) * 100).toFixed(1) : null;
    const fav = favorabilityFor(nature, a.v, b);
    if (a.status !== "OK") status = "INCOMPLETE_DATA";
    rows.push({
      statementLineCode: code,
      lineNameAr: lineNameByCode.get(code)?.nameAr ?? null,
      lineNameEn: lineNameByCode.get(code)?.nameEn ?? null,
      lineNature: nature,
      budgetMinor: b?.toString() ?? null,
      actualMinor: a.v?.toString() ?? null,
      actualStatus: a.status,
      varianceMinor: variance?.toString() ?? null,
      variancePct: pct,
      favorability: fav,
    });
  }

  return {
    company: { code: (await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { code: true, nameAr: true } })).code, nameAr: (await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { nameAr: true } })).nameAr },
    fiscalYear: { code: fy.code, displayNameAr: fy.displayNameAr, startDate: fy.startDate, endDate: fy.endDate },
    budget: { id: budget.id, versionNumber: budget.versionNumber, scenario: budget.scenario, status: budget.status, budgetType: budget.budgetType },
    granularity,
    range,
    rows,
    status,
  };
}

/* ── مقترح الموازنة (أساس قابل للتوسع — بلا محرك تنبؤ) ── */

export interface ProposeBudgetArgs {
  user: SessionUser;
  ip: string | null;
  input: {
    companyId?: unknown;
    fiscalYearId?: unknown;
    scenario?: unknown;
    budgetType?: unknown;
    startOrdinal?: unknown;
    endOrdinal?: unknown;
    method?: unknown;
    growthPct?: unknown; // GROWTH_PERCENTAGE / INDEPENDENT_GROWTH
    percentOfSales?: unknown; // PERCENT_OF_SALES
    salesLineCode?: unknown; // بند المبيعات المرجعي
    fixed?: unknown; // FIXED_AMOUNT: [{ statementLineCode, amountMinor }]
  };
}

export async function proposeBudget(args: ProposeBudgetArgs) {
  const { user, input } = args;
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  const fiscalYearId = typeof input.fiscalYearId === "string" ? input.fiscalYearId.trim() : "";
  if (!companyId || !fiscalYearId) fail("COMPANY_REQUIRED", "الشركة والسنة المالية إلزاميتان.");
  assertScope(user, companyId);
  const fy = await db.fiscalYear.findUnique({ where: { id: fiscalYearId }, select: { id: true, companyId: true, code: true, periodCount: true } });
  if (!fy || fy.companyId !== companyId) fail("FISCAL_YEAR_NOT_FOUND", "السنة المالية غير موجودة لهذه الشركة.");
  const startOrdinal = Math.max(1, Number(input.startOrdinal) || 1);
  const endOrdinal = Math.min(fy.periodCount, Number(input.endOrdinal) || fy.periodCount);
  const method = typeof input.method === "string" ? input.method : "";

  const accounts = await loadCommittedAccountPoints(companyId, fiscalYearId);
  const actualByLine = new Map<string, bigint>();
  for (const acc of accounts.values()) {
    if (!acc.statementLineCode || acc.classification !== "REVENUE" && acc.classification !== "EXPENSE") continue;
    try {
      const v = acc.aggregationBehavior === "BALANCE"
        ? balanceAsOfFromPoints(acc.points, endOrdinal) - (startOrdinal <= 1 ? BigInt(0) : balanceAsOfFromPoints(acc.points, startOrdinal - 1))
        : flowRangeMovementFromPoints(acc.points, startOrdinal, endOrdinal);
      actualByLine.set(acc.statementLineCode, (actualByLine.get(acc.statementLineCode) ?? BigInt(0)) + v);
    } catch {
      fail("INCOMPLETE_DATA", `لا يمكن اشتقاق خط أساس للبند ${acc.statementLineCode} (بيانات الفعلي غير مكتملة) — لا تخمين.`);
    }
  }
  if (actualByLine.size === 0) fail("INCOMPLETE_DATA", "لا خط أساس متاح (لا فعلي معتمد مربوط ببنود) — لا تخمين.");

  const lines: Array<{ statementLineCode: string; fiscalPeriodId: null; amountMinor: string }> = [];
  const periodCount = endOrdinal - startOrdinal + 1;
  if (method === "GROWTH_PERCENTAGE" || method === "INDEPENDENT_GROWTH") {
    const pct = Number(input.growthPct);
    if (!Number.isFinite(pct)) fail("INVALID_LINE", "growthPct إلزامي رقميًا لهذه الطريقة.");
    for (const [code, net] of actualByLine.entries()) {
      const nature = accounts && [...accounts.values()].find((a) => a.statementLineCode === code)?.classification;
      const positive = nature === "REVENUE" ? -net : net;
      const proposed = (positive * BigInt(Math.round((1 + pct / 100) * 100))) / BigInt(100);
      lines.push({ statementLineCode: code, fiscalPeriodId: null, amountMinor: proposed.toString() });
    }
  } else if (method === "PERCENT_OF_SALES") {
    const pct = Number(input.percentOfSales);
    const salesCode = typeof input.salesLineCode === "string" ? input.salesLineCode.trim() : "";
    const salesNet = actualByLine.get(salesCode);
    if (!Number.isFinite(pct) || !salesCode || salesNet === undefined) fail("INVALID_LINE", "percentOfSales و salesLineCode (بند فعلي موجود) إلزامية.");
    const salesPositive = -salesNet; // الإيراد دائن ⇒ موجب
    for (const code of actualByLine.keys()) {
      const proposed = (salesPositive * BigInt(Math.round(pct * 100))) / BigInt(10000);
      lines.push({ statementLineCode: code, fiscalPeriodId: null, amountMinor: proposed.toString() });
    }
  } else if (method === "FIXED_AMOUNT") {
    const fixed = Array.isArray(input.fixed) ? (input.fixed as Array<{ statementLineCode?: unknown; amountMinor?: unknown }>) : [];
    for (const f of fixed) {
      const code = typeof f.statementLineCode === "string" ? f.statementLineCode.trim() : "";
      if (!code) fail("INVALID_LINE", "كود البند إلزامي.");
      lines.push({ statementLineCode: code, fiscalPeriodId: null, amountMinor: String(f.amountMinor ?? "0") });
    }
  } else {
    fail("INVALID_LINE", `طريقة مقترح غير مدعومة: ${method || "—"}`);
  }

  return {
    method,
    scenario: typeof input.scenario === "string" ? input.scenario : "BASE",
    budgetType: typeof input.budgetType === "string" ? input.budgetType : "ANNUAL",
    baselineRange: { startOrdinal, endOrdinal },
    periodCount,
    lines,
    note: "مقترح قابل للتعديل — يُحفظ كمسودة عبر POST /api/budgets ثم يمر سير العمل. السيناريو وسم لا سياسة تلقائية.",
  };
}

