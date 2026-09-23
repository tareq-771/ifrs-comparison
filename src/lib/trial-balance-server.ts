// Phase 6.2B — خدمة ميزان المراجعة المحفوظ (خادم فقط — تستورد db).
//
// الضوابط المعمارية:
//   - optimistic locking بنمط المشروع: updateMany/deleteMany شرطي على version ⇒ 409.
//   - Audit Trail القائم حصرًا (writeAudit داخل نفس المعاملة) — قبل/بعد/سبب،
//     مع metadata مركزة (شركة/سنة/مدى/نوع/عدد سطور/إجماليات/بصمة) — بلا محتوى Excel.
//   - fail-closed للنطاق: كل العمليات تتطلب companyVisible — مستخدم Company A
//     لا يرفع ولا يعدّل Company B إطلاقًا.
//   - دورة حياة 6.1: الاعتماد (COMMIT) يتطلب سنة مالية OPEN وفترات مغطاة OPEN —
//     أي CLOSED/LOCKED ⇒ رفض واضح (لا تجاوز lifecycle بحجة الاستيراد).
//   - سياسة التكرار المحافظة: (شركة، سنة، from، to، dataType) وحيد؛ المعتمد لا
//     يُستبدل؛ المسودة تُستبدل فقط بعلم صريح + تدقيق.

import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { companyVisible } from "@/lib/company-access";
import {
  resolveAccountMapping,
  summarizeMapping,
  type MappingRuleLike,
  type MappingOverrideLike,
  type ResolvedAccountMapping,
  type StatementLineLike,
} from "@/lib/account-nature";
import {
  minorUnitsForCurrency,
  normalizeTrialBalanceLines,
  resolveFiscalContext,
  summarizePreview,
  TB_DATA_TYPES,
  TB_STATUSES,
  TrialBalanceError,
  type NormalizedTrialBalanceLine,
  type TrialBalanceDataType,
} from "@/lib/trial-balance";
import type { SessionUser } from "@/lib/session";

type TxClient = Prisma.TransactionClient | PrismaClient;

const IMPORT_SELECT = {
  id: true,
  companyId: true,
  fiscalYearId: true,
  fromDate: true,
  toDate: true,
  startOrdinal: true,
  endOrdinal: true,
  dataType: true,
  status: true,
  // ── Phase 6.3 — حوكمة المراجعات ──
  revisionNumber: true,
  supersedesImportId: true,
  revisionReason: true,
  originalFileName: true,
  fileHash: true,
  payloadHash: true,
  totalDebitMinor: true,
  totalCreditMinor: true,
  lineCount: true,
  note: true,
  version: true,
  createdById: true,
  createdByName: true,
  updatedById: true,
  updatedByName: true,
  committedAt: true,
  committedById: true,
  committedByName: true,
  createdAt: true,
  updatedAt: true,
  company: { select: { code: true, nameAr: true, functionalCurrency: true } },
  fiscalYear: { select: { code: true, displayNameAr: true, startDate: true, endDate: true, status: true } },
} as const;

export type TrialBalanceImportRow = Prisma.TrialBalanceImportGetPayload<{ select: typeof IMPORT_SELECT }>;

const LINE_SELECT = {
  id: true,
  importId: true,
  rowIndex: true,
  accountCode: true,
  accountName: true,
  debitMinor: true,
  creditMinor: true,
  netMinor: true,
  mappedPrefix: true,
  mappingSource: true,
  mappingStatus: true,
  mainCategory: true,
  classification: true,
  aggregationBehavior: true,
  statementLineCode: true,
} as const;

export type TrialBalanceLineRow = Prisma.TrialBalanceLineGetPayload<{ select: typeof LINE_SELECT }>;

function assertCompanyScope(user: SessionUser, companyId: string): void {
  if (!companyVisible(user, companyId)) {
    throw new TrialBalanceError("NOT_FOUND", "لا تملك الوصول لهذه الشركة.");
  }
}

function assertDataType(v: unknown): asserts v is TrialBalanceDataType {
  if (v !== TB_DATA_TYPES.CUMULATIVE_YTD && v !== TB_DATA_TYPES.PERIOD_MOVEMENT) {
    throw new TrialBalanceError(
      "INVALID_DATA_TYPE",
      "نوع بيانات ميزان المراجعة إلزامي وصريح: CUMULATIVE_YTD أو PERIOD_MOVEMENT — لا تخمين من الملف."
    );
  }
}

/** sha256 hex لنص normalized payload — كشف التكرار الفعلي (ليس هوية محاسبية). */
export function computePayloadHash(lines: readonly NormalizedTrialBalanceLine[]): string {
  const canonical = lines
    .map((l) => `${l.accountCode}|${l.accountName}|${l.debitMinor}|${l.creditMinor}`)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** DTO سطر بمبالغ نصية آمنة JSON (BigInt ⇒ string). */
export function lineToDTO(l: TrialBalanceLineRow) {
  return {
    ...l,
    debitMinor: l.debitMinor.toString(),
    creditMinor: l.creditMinor.toString(),
    netMinor: l.netMinor.toString(),
  };
}

/** DTO استيراد بمبالغ نصية آمنة JSON. */
export function importToDTO(i: TrialBalanceImportRow) {
  return {
    ...i,
    totalDebitMinor: i.totalDebitMinor.toString(),
    totalCreditMinor: i.totalCreditMinor.toString(),
    lines: undefined,
  };
}

interface FiscalLoad {
  fiscalYearId: string;
  fy: { id: string; code: string; displayNameAr: string; startDate: string; endDate: string; status: string };
  periods: Array<{ id: string; ordinal: number; startDate: string; endDate: string; status: string; displayLabel: string }>;
}

/** جلب السنة المالية وفتراتها — التحقق أن السنة تخص الشركة. */
async function loadFiscalYear(client: TxClient, companyId: string, fiscalYearId: string): Promise<FiscalLoad> {
  const fy = await client.fiscalYear.findUnique({
    where: { id: fiscalYearId },
    select: { id: true, companyId: true, code: true, displayNameAr: true, startDate: true, endDate: true, status: true },
  });
  if (!fy || fy.companyId !== companyId) {
    throw new TrialBalanceError("FISCAL_YEAR_NOT_FOUND", "السنة المالية غير موجودة لهذه الشركة.");
  }
  const periods = await client.fiscalPeriod.findMany({
    where: { fiscalYearId },
    orderBy: { ordinal: "asc" },
    select: { id: true, ordinal: true, startDate: true, endDate: true, status: true, displayLabel: true },
  });
  if (periods.length === 0) {
    throw new TrialBalanceError("FISCAL_YEAR_NOT_FOUND", "السنة المالية بلا فترات معرفة.");
  }
  return { fiscalYearId, fy, periods };
}

/** بناء snapshot الخريطة لكل سطر عبر الحل المركزي الوحيد (6.2A) — بلا منطق بديل. */
async function buildMappingSnapshots(
  client: TxClient,
  companyId: string,
  lines: readonly NormalizedTrialBalanceLine[]
): Promise<ResolvedAccountMapping[]> {
  const rules = await client.accountNatureRule.findMany({
    where: { isActive: true, OR: [{ companyId: null }, { companyId }] },
    select: { id: true, companyId: true, prefix: true, mainCategory: true, classification: true, aggregationBehavior: true, statementLine: { select: { code: true } }, source: true, isActive: true },
  });
  const overrides = await client.accountMappingOverride.findMany({
    where: { isActive: true, companyId },
    select: { id: true, companyId: true, accountCode: true, classification: true, aggregationBehavior: true, statementLine: { select: { code: true } }, isActive: true },
  });
  const linesRef = await client.financialStatementLine.findMany({
    where: { isActive: true },
    select: { code: true, nameAr: true, statementType: true, isActive: true },
  });
  const ruleLikes: MappingRuleLike[] = rules.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    prefix: r.prefix,
    mainCategory: r.mainCategory,
    classification: r.classification,
    aggregationBehavior: r.aggregationBehavior,
    statementLineCode: r.statementLine?.code ?? null,
    source: r.source,
    isActive: r.isActive,
  }));
  const overrideLikes: MappingOverrideLike[] = overrides.map((o) => ({
    id: o.id,
    companyId: o.companyId,
    accountCode: o.accountCode,
    classification: o.classification,
    aggregationBehavior: o.aggregationBehavior,
    statementLineCode: o.statementLine?.code ?? null,
    isActive: o.isActive,
  }));
  const lineLikes: StatementLineLike[] = linesRef;
  return lines.map((l) =>
    resolveAccountMapping({
      accountCode: l.accountCode,
      rules: ruleLikes,
      overrides: overrideLikes,
      lines: lineLikes,
      companyId,
    })
  );
}

const SNAPSHOT_FIELDS = (m: ResolvedAccountMapping) => ({
  mappedPrefix: m.matchedPrefix,
  mappingSource: m.source,
  mappingStatus: m.mappingStatus,
  mainCategory: m.mainCategory,
  classification: m.classification,
  aggregationBehavior: m.aggregationBehavior,
  statementLineCode: m.statementLineCode,
});

/* ──────────────────────────────────────────────────────────────────────────
 * القائمة والتفاصيل
 * ────────────────────────────────────────────────────────────────────────── */

export async function listTrialBalances(user: SessionUser, companyId?: string | null) {
  const where: Prisma.TrialBalanceImportWhereInput = {};
  if (companyId) {
    assertCompanyScope(user, companyId);
    where.companyId = companyId;
  }
  const rows = await db.trialBalanceImport.findMany({
    where,
    orderBy: [{ companyId: "asc" }, { fromDate: "desc" }],
    select: IMPORT_SELECT,
  });
  return rows
    .filter((r) => companyVisible(user, r.companyId))
    .map((r) => ({
      ...importToDTO(r),
      committedAt: r.committedAt ? r.committedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
}

export async function getTrialBalance(user: SessionUser, id: string) {
  const row = await db.trialBalanceImport.findUnique({ where: { id }, select: IMPORT_SELECT });
  if (!row || !companyVisible(user, row.companyId)) {
    throw new TrialBalanceError("NOT_FOUND", "ميزان المراجعة غير موجود.");
  }
  const lines = await db.trialBalanceLine.findMany({
    where: { importId: id },
    orderBy: { rowIndex: "asc" },
    select: LINE_SELECT,
  });
  return {
    ...importToDTO(row),
    committedAt: row.committedAt ? row.committedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lines: lines.map(lineToDTO),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * المعاينة — بلا أي حفظ
 * ────────────────────────────────────────────────────────────────────────── */

export interface PreviewTrialBalanceArgs {
  user: SessionUser;
  input: {
    companyId?: unknown;
    fiscalYearId?: unknown;
    fromDate?: unknown;
    toDate?: unknown;
    dataType?: unknown;
    lines?: unknown;
  };
}

export async function previewTrialBalance(args: PreviewTrialBalanceArgs) {
  const { user, input } = args;
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  if (!companyId) throw new TrialBalanceError("COMPANY_REQUIRED", "الشركة إلزامية للمعاينة.");
  assertCompanyScope(user, companyId);
  assertDataType(input.dataType);

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, code: true, nameAr: true, functionalCurrency: true },
  });
  if (!company) throw new TrialBalanceError("NOT_FOUND", "الشركة غير موجودة.");

  const fiscal = await loadFiscalYear(db, companyId, String(input.fiscalYearId ?? ""));
  const ctx = resolveFiscalContext(
    { ...fiscal.fy },
    fiscal.periods,
    input.fromDate,
    input.toDate
  );
  const minorUnits = minorUnitsForCurrency(company.functionalCurrency);
  const normalized = normalizeTrialBalanceLines(
    Array.isArray(input.lines) ? (input.lines as never[]) : [],
    minorUnits
  );
  const mappings = await buildMappingSnapshots(db, companyId, normalized.lines);
  const summary = summarizePreview(
    normalized.lines,
    mappings.map((m) => ({
      mappingStatus: m.mappingStatus,
      mappingSource: m.source,
      mainCategory: m.mainCategory,
      classification: m.classification,
      aggregationBehavior: m.aggregationBehavior,
      statementLineCode: m.statementLineCode,
    }))
  );

  return {
    company: { id: company.id, code: company.code, nameAr: company.nameAr },
    functionalCurrency: company.functionalCurrency || null,
    minorUnits,
    fiscalYear: {
      id: fiscal.fy.id,
      code: fiscal.fy.code,
      displayNameAr: fiscal.fy.displayNameAr,
      startDate: fiscal.fy.startDate,
      endDate: fiscal.fy.endDate,
      status: fiscal.fy.status,
    },
    fromDate: ctx.startPeriod.startDate,
    toDate: ctx.endPeriod.endDate,
    startOrdinal: ctx.startPeriod.ordinal,
    endOrdinal: ctx.endPeriod.ordinal,
    coveredPeriodLabels: ctx.coveredPeriods.map((p) => p.displayLabel || p.startDate),
    dataType: input.dataType as TrialBalanceDataType,
    totalDebitMinor: normalized.totalDebitMinor.toString(),
    totalCreditMinor: normalized.totalCreditMinor.toString(),
    differenceMinor: normalized.differenceMinor.toString(),
    balanced: normalized.balanced,
    lineCount: normalized.lineCount,
    minorUnitsHint: minorUnits,
    mapping: summary,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * الإنشاء (حفظ مسودة/غير متوازن) — بلا اعتماد
 * ────────────────────────────────────────────────────────────────────────── */

export interface CreateTrialBalanceArgs {
  user: SessionUser;
  ip: string | null;
  input: {
    companyId?: unknown;
    fiscalYearId?: unknown;
    fromDate?: unknown;
    toDate?: unknown;
    dataType?: unknown;
    originalFileName?: unknown;
    fileHash?: unknown;
    lines?: unknown;
    note?: unknown;
    replaceExisting?: unknown;
    reason?: unknown;
    // Phase 6.3 — عند تعبئته: الطلب = استبدال سطور مسودة مراجعة قائمة (لا استيراد جديد)
    revisionTargetId?: unknown;
    version?: unknown;
  };
}

export async function createTrialBalance(args: CreateTrialBalanceArgs) {
  const { user, ip, input } = args;
  // Phase 6.3 — وضع الاستيراد داخل مسودة مراجعة: استبدال السطور كاملة بدل إنشاء استيراد جديد
  const revisionTargetId = typeof input.revisionTargetId === "string" ? input.revisionTargetId.trim() : "";
  if (revisionTargetId) {
    return replaceRevisionDraftLines({ user, ip, id: revisionTargetId, input });
  }
  const companyId = typeof input.companyId === "string" ? input.companyId.trim() : "";
  if (!companyId) throw new TrialBalanceError("COMPANY_REQUIRED", "الشركة إلزامية للاستيراد.");
  assertCompanyScope(user, companyId);
  assertDataType(input.dataType);

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, code: true, nameAr: true, functionalCurrency: true },
  });
  if (!company) throw new TrialBalanceError("NOT_FOUND", "الشركة غير موجودة.");

  const fiscal = await loadFiscalYear(db, companyId, String(input.fiscalYearId ?? ""));
  const ctx = resolveFiscalContext({ ...fiscal.fy }, fiscal.periods, input.fromDate, input.toDate);
  const minorUnits = minorUnitsForCurrency(company.functionalCurrency);
  const normalized = normalizeTrialBalanceLines(
    Array.isArray(input.lines) ? (input.lines as never[]) : [],
    minorUnits
  );
  const payloadHash = computePayloadHash(normalized.lines);
  const status = normalized.balanced ? TB_STATUSES.DRAFT : TB_STATUSES.UNBALANCED;
  const replaceExisting = input.replaceExisting === true;

  // سياسة التكرار المحافظة (6.3) — السلسلة: نفس الشركة/السنة/المدى/النوع بعدة نسخ مرقمة؛
  // المعتمد لا يُستبدل إطلاقًا (مسار المراجعة الصريح)، والمسودة الأخيرة وحدها قابلة للاستبدال.
  const chainLatest = await db.trialBalanceImport.findFirst({
    where: {
      companyId,
      fiscalYearId: fiscal.fiscalYearId,
      fromDate: ctx.startPeriod.startDate,
      toDate: ctx.endPeriod.endDate,
      dataType: input.dataType as string,
    },
    orderBy: { revisionNumber: "desc" },
    select: { id: true, status: true, version: true, revisionNumber: true },
  });
  const existing = chainLatest
    ? { id: chainLatest.id, status: chainLatest.status, version: chainLatest.version }
    : null;
  if (existing) {
    if (existing.status === TB_STATUSES.COMMITTED) {
      throw new TrialBalanceError(
        "DUPLICATE_COMMITTED",
        "يوجد ميزان معتمد لنفس الشركة/السنة/المدى/النوع — لا استبدال للمعتمد؛ استخدم مسار المراجعة (Revision) الصريح."
      );
    }
    if (!replaceExisting) {
      throw new TrialBalanceError(
        "DUPLICATE_IMPORT",
        "يوجد استيراد قائم لنفس الشركة/السنة/المدى/النوع — فعّل «الاستبدال» صراحةً ليُحذف القديم (مسودة) ويُسجل ذلك في التدقيق."
      );
    }
  }

  // تحذير تكرار المحتوى (غير مانع — hash ليس هوية محاسبية)
  const samePayload = await db.trialBalanceImport.findFirst({
    where: { companyId, payloadHash, id: existing?.id ? { not: existing.id } : undefined },
    select: { id: true, fromDate: true, toDate: true, dataType: true, status: true },
  });

  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
  const fileName = typeof input.originalFileName === "string" ? input.originalFileName.trim().slice(0, 255) : "";
  const fileHash = typeof input.fileHash === "string" ? input.fileHash.trim().slice(0, 128) : "";
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";

  const created = await db.$transaction(async (tx) => {
    if (existing && replaceExisting) {
      await tx.trialBalanceImport.delete({ where: { id: existing.id } }); // Cascade للسطور
    }
    const row = await tx.trialBalanceImport.create({
      data: {
        companyId,
        fiscalYearId: fiscal.fiscalYearId,
        fromDate: ctx.startPeriod.startDate,
        toDate: ctx.endPeriod.endDate,
        startOrdinal: ctx.startPeriod.ordinal,
        endOrdinal: ctx.endPeriod.ordinal,
        dataType: input.dataType as string,
        status,
        originalFileName: fileName,
        fileHash,
        payloadHash,
        totalDebitMinor: normalized.totalDebitMinor,
        totalCreditMinor: normalized.totalCreditMinor,
        lineCount: normalized.lineCount,
        note,
        createdById: user.id,
        createdByName: user.username,
        updatedById: user.id,
        updatedByName: user.username,
      },
      select: IMPORT_SELECT,
    });
    const mappings = await buildMappingSnapshots(tx, companyId, normalized.lines);
    await tx.trialBalanceLine.createMany({
      data: normalized.lines.map((l, i) => ({
        importId: row.id,
        rowIndex: l.rowIndex,
        accountCode: l.accountCode,
        accountName: l.accountName,
        debitMinor: l.debitMinor,
        creditMinor: l.creditMinor,
        netMinor: l.netMinor,
        ...SNAPSHOT_FIELDS(mappings[i]),
      })),
    });
    const auditMeta = {
      companyId,
      companyCode: company.code,
      fiscalYearCode: fiscal.fy.code,
      fromDate: ctx.startPeriod.startDate,
      toDate: ctx.endPeriod.endDate,
      dataType: input.dataType,
      status,
      lineCount: normalized.lineCount,
      totalDebitMinor: normalized.totalDebitMinor.toString(),
      totalCreditMinor: normalized.totalCreditMinor.toString(),
      balanced: normalized.balanced,
      originalFileName: fileName,
      fileHash,
      payloadHash,
      replacedImportId: existing && replaceExisting ? existing.id : undefined,
      minorUnits,
      reason: reason || undefined,
    };
    await writeAudit(tx, {
      user,
      action: "TRIAL_BALANCE_SAVED",
      entityType: "TrialBalanceImport",
      entityId: row.id,
      description: `حفظ ميزان مراجعة ${company.code} (${ctx.startPeriod.startDate} → ${ctx.endPeriod.endDate}) ${input.dataType} — ${normalized.lineCount} سطرًا — ${status}`,
      after: auditMeta,
      metadata: { ...auditMeta, replaced: existing && replaceExisting },
      ip,
    });
    return row;
  });

  return {
    import: { ...importToDTO(created), committedAt: null, createdAt: created.createdAt.toISOString(), updatedAt: created.updatedAt.toISOString() },
    duplicatePayloadWarning: samePayload
      ? `تحذير: نفس محتوى الميزان (نفس البصمة) محفوظ سابقًا لنفس الشركة (${samePayload.fromDate} → ${samePayload.toDate} / ${samePayload.dataType} / ${samePayload.status}) — تأكد ألا يكون رفعًا مكررًا.`
      : null,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 6.3 — استبدال سطور مسودة المراجعة (الرفع المصحح داخل المراجعة)
 * المدى/النوع/الشركة/السنة ثابتة من المعتمد المصدر — يتغير المحتوى حصرًا.
 * ────────────────────────────────────────────────────────────────────────── */

export interface ReplaceRevisionDraftLinesArgs {
  user: SessionUser;
  ip: string | null;
  id: string;
  input: {
    version?: unknown;
    fromDate?: unknown;
    toDate?: unknown;
    dataType?: unknown;
    lines?: unknown;
    originalFileName?: unknown;
    fileHash?: unknown;
    note?: unknown;
    reason?: unknown;
  };
}

export async function replaceRevisionDraftLines(args: ReplaceRevisionDraftLinesArgs) {
  const { user, ip, id, input } = args;
  const draft = await db.trialBalanceImport.findUnique({ where: { id }, select: IMPORT_SELECT });
  if (!draft || !companyVisible(user, draft.companyId)) {
    throw new TrialBalanceError("NOT_FOUND", "مسودة المراجعة غير موجودة.");
  }
  assertCompanyScope(user, draft.companyId);
  if (draft.status !== TB_STATUSES.DRAFT || !draft.supersedesImportId) {
    throw new TrialBalanceError(
      "INVALID_STATE",
      "استبدال السطور يتطلب مسودة مراجعة قائمة (revision draft) — المعتمد لا يُعدّل والمسودات العادية لها مسارها."
    );
  }
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new TrialBalanceError("VERSION_CONFLICT", "نسخة المسودة (version) إلزامية لاستبدال السطور.");
  }
  assertDataType(input.dataType);
  if ((input.dataType as string) !== draft.dataType) {
    throw new TrialBalanceError(
      "INVALID_DATA_TYPE",
      `نوع بيانات المراجعة ثابت من المصدر المعتمد (${draft.dataType}) — لا تغيير النوع داخل مسودة المراجعة.`
    );
  }
  const fiscal = await loadFiscalYear(db, draft.companyId, draft.fiscalYearId);
  const ctx = resolveFiscalContext({ ...fiscal.fy }, fiscal.periods, input.fromDate, input.toDate);
  if (ctx.startPeriod.startDate !== draft.fromDate || ctx.endPeriod.endDate !== draft.toDate) {
    throw new TrialBalanceError(
      "INVALID_DATE_RANGE",
      `مدى المراجعة ثابت من المصدر المعتمد (${draft.fromDate} → ${draft.toDate}) — لا تغيير للمدى داخل مسودة المراجعة.`
    );
  }
  const company = await db.company.findUnique({
    where: { id: draft.companyId },
    select: { id: true, code: true, nameAr: true, functionalCurrency: true },
  });
  if (!company) throw new TrialBalanceError("NOT_FOUND", "الشركة غير موجودة.");
  const minorUnits = minorUnitsForCurrency(company.functionalCurrency);
  const normalized = normalizeTrialBalanceLines(
    Array.isArray(input.lines) ? (input.lines as never[]) : [],
    minorUnits
  );
  const payloadHash = computePayloadHash(normalized.lines);
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
  const fileName = typeof input.originalFileName === "string" ? input.originalFileName.trim().slice(0, 255) : "";
  const fileHash = typeof input.fileHash === "string" ? input.fileHash.trim().slice(0, 128) : "";
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";

  return db.$transaction(async (tx) => {
    const updated = await tx.trialBalanceImport.updateMany({
      where: { id, version },
      data: {
        status: normalized.balanced ? TB_STATUSES.DRAFT : TB_STATUSES.UNBALANCED,
        version: version + 1, // نمط المشروع: كل تحديث ناجح يزيد النسخة (optimistic locking)
        totalDebitMinor: normalized.totalDebitMinor,
        totalCreditMinor: normalized.totalCreditMinor,
        lineCount: normalized.lineCount,
        payloadHash,
        originalFileName: fileName,
        fileHash,
        note,
        updatedById: user.id,
        updatedByName: user.username,
      },
    });
    if (updated.count === 0) {
      throw new TrialBalanceError("VERSION_CONFLICT", "تعارض نسخ: مسودة المراجعة تغيّرت — أعد التحميل.");
    }
    await tx.trialBalanceLine.deleteMany({ where: { importId: id } });
    const mappings = await buildMappingSnapshots(tx, draft.companyId, normalized.lines);
    await tx.trialBalanceLine.createMany({
      data: normalized.lines.map((l, i) => ({
        importId: id,
        rowIndex: l.rowIndex,
        accountCode: l.accountCode,
        accountName: l.accountName,
        debitMinor: l.debitMinor,
        creditMinor: l.creditMinor,
        netMinor: l.netMinor,
        ...SNAPSHOT_FIELDS(mappings[i]),
      })),
    });
    const meta = {
      companyId: draft.companyId,
      companyCode: company.code,
      fiscalYearCode: draft.fiscalYear.code,
      revisionDraft: true,
      revisionNumber: draft.revisionNumber,
      supersedesImportId: draft.supersedesImportId,
      revisionReason: draft.revisionReason || undefined,
      fromDate: draft.fromDate,
      toDate: draft.toDate,
      dataType: draft.dataType,
      lineCount: normalized.lineCount,
      totalDebitMinor: normalized.totalDebitMinor.toString(),
      totalCreditMinor: normalized.totalCreditMinor.toString(),
      balanced: normalized.balanced,
      payloadHash,
      minorUnits,
      reason: reason || undefined,
    };
    await writeAudit(tx, {
      user,
      action: "TRIAL_BALANCE_SAVED",
      entityType: "TrialBalanceImport",
      entityId: id,
      description: `استبدال سطور مسودة المراجعة #${draft.revisionNumber} لميزان ${company.code} (${draft.fromDate} → ${draft.toDate}) — ${normalized.lineCount} سطرًا — ${normalized.balanced ? "متوازن" : "غير متوازن"}`,
      after: meta,
      metadata: meta,
      ip,
    });
    const fresh = await tx.trialBalanceImport.findUnique({ where: { id }, select: IMPORT_SELECT });
    if (!fresh) throw new TrialBalanceError("NOT_FOUND", "مسودة المراجعة اختفت أثناء الاستبدال.");
    return {
      import: { ...importToDTO(fresh), committedAt: null, createdAt: fresh.createdAt.toISOString(), updatedAt: fresh.updatedAt.toISOString() },
      duplicatePayloadWarning: null,
    };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 6.3 — حوكمة المراجعات: COMMITTED → CREATE REVISION → DRAFT → VALIDATE → COMMIT
 * - المراجعة تُنشأ من أحدث نسخة معتمدة حصرًا (لا تفريخ من التاريخ)
 * - سبب المراجعة إلزامي، ورقم المراجعة يزيد 1، والمعتمد السابق لا يُمس ولا يُعدّل
 * - حوكمة السنة: LOCKED يمنع المراجعة العادية (و6.1 controls تبقى حاكمة عند الاعتماد)
 * ────────────────────────────────────────────────────────────────────────── */

export interface CreateTrialBalanceRevisionArgs {
  user: SessionUser;
  ip: string | null;
  id: string; // معرّف النسخة المعتمدة المصدر
  input: { reason?: unknown };
}

export async function createTrialBalanceRevision(args: CreateTrialBalanceRevisionArgs) {
  const { user, ip, id, input } = args;
  const source = await db.trialBalanceImport.findUnique({ where: { id }, select: IMPORT_SELECT });
  if (!source || !companyVisible(user, source.companyId)) {
    throw new TrialBalanceError("NOT_FOUND", "ميزان المراجعة غير موجود.");
  }
  assertCompanyScope(user, source.companyId);
  if (source.status !== TB_STATUSES.COMMITTED) {
    throw new TrialBalanceError("INVALID_STATE", "المراجعة تُنشأ من نسخة معتمدة حصرًا — المسودات تُعدّل مباشرة.");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
  if (!reason) {
    throw new TrialBalanceError("REASON_REQUIRED", "سبب المراجعة إلزامي — لا تُنشأ مراجعة بلا سبب موثق.");
  }
  // حوكمة السنة المالية: LOCKED يمنع المراجعة العادية فورًا (بلا أي استثناء صامت)
  if (source.fiscalYear.status === "LOCKED") {
    throw new TrialBalanceError(
      "FISCAL_LIFECYCLE",
      `السنة المالية ${source.fiscalYear.code} مقفلة (LOCKED) — لا مراجعة عادية؛ يلزم مسار حوكمة صريح لفك القفل أولًا.`
    );
  }

  return db.$transaction(async (tx) => {
    // السلسلة الكاملة لنفس (الشركة/السنة/المدى/النوع) — مرتبة ترتيبيًا
    const chain = await tx.trialBalanceImport.findMany({
      where: {
        companyId: source.companyId,
        fiscalYearId: source.fiscalYearId,
        fromDate: source.fromDate,
        toDate: source.toDate,
        dataType: source.dataType,
      },
      select: { id: true, revisionNumber: true, status: true },
      orderBy: { revisionNumber: "asc" },
    });
    const latestCommitted = [...chain].reverse().find((r) => r.status === TB_STATUSES.COMMITTED);
    if (!latestCommitted || latestCommitted.id !== source.id) {
      throw new TrialBalanceError(
        "REVISION_SOURCE_NOT_LATEST",
        "المراجعة تُنشأ من أحدث نسخة معتمدة في سلسلتها حصرًا — لا تفريخ من نسخة تاريخية."
      );
    }
    const openDraft = chain.find((r) => r.status !== TB_STATUSES.COMMITTED);
    if (openDraft) {
      throw new TrialBalanceError(
        "REVISION_DRAFT_EXISTS",
        `توجد مسودة مراجعة مفتوحة (رقم ${openDraft.revisionNumber}) — أنهِها أو احذفها قبل إنشاء مراجعة جديدة.`
      );
    }
    const nextRevision = chain[chain.length - 1].revisionNumber + 1;

    // بذر السطور من المعتمد المصدر كنقطة بداية (snapshot المجمّد يُنسخ كما هو — لا إعادة حل صامتة)
    const sourceLines = await tx.trialBalanceLine.findMany({
      where: { importId: source.id },
      orderBy: { rowIndex: "asc" },
      select: LINE_SELECT,
    });

    const draft = await tx.trialBalanceImport.create({
      data: {
        companyId: source.companyId,
        fiscalYearId: source.fiscalYearId,
        fromDate: source.fromDate,
        toDate: source.toDate,
        startOrdinal: source.startOrdinal,
        endOrdinal: source.endOrdinal,
        dataType: source.dataType,
        status: TB_STATUSES.DRAFT,
        revisionNumber: nextRevision,
        supersedesImportId: source.id,
        revisionReason: reason,
        originalFileName: "",
        fileHash: "",
        payloadHash: source.payloadHash,
        totalDebitMinor: source.totalDebitMinor,
        totalCreditMinor: source.totalCreditMinor,
        lineCount: source.lineCount,
        note: "",
        createdById: user.id,
        createdByName: user.username,
        updatedById: user.id,
        updatedByName: user.username,
      },
      select: IMPORT_SELECT,
    });
    if (sourceLines.length > 0) {
      await tx.trialBalanceLine.createMany({
        data: sourceLines.map((l) => ({
          importId: draft.id,
          rowIndex: l.rowIndex,
          accountCode: l.accountCode,
          accountName: l.accountName,
          debitMinor: l.debitMinor,
          creditMinor: l.creditMinor,
          netMinor: l.netMinor,
          mappedPrefix: l.mappedPrefix,
          mappingSource: l.mappingSource,
          mappingStatus: l.mappingStatus,
          mainCategory: l.mainCategory,
          classification: l.classification,
          aggregationBehavior: l.aggregationBehavior,
          statementLineCode: l.statementLineCode,
        })),
      });
    }

    const before = {
      importId: source.id,
      revisionNumber: source.revisionNumber,
      status: source.status,
      payloadHash: source.payloadHash,
    };
    const after = {
      importId: draft.id,
      revisionNumber: nextRevision,
      status: draft.status,
      revisionReason: reason,
    };
    const meta = {
      companyId: source.companyId,
      companyCode: source.company.code,
      fiscalYearCode: source.fiscalYear.code,
      fiscalYearStatus: source.fiscalYear.status,
      fromDate: source.fromDate,
      toDate: source.toDate,
      dataType: source.dataType,
      sourceImportId: source.id,
      oldRevisionNumber: source.revisionNumber,
      newRevisionNumber: nextRevision,
      reason,
      lineCount: source.lineCount,
    };
    await writeAudit(tx, {
      user,
      action: "TRIAL_BALANCE_REVISION_CREATED",
      entityType: "TrialBalanceImport",
      entityId: draft.id,
      description: `إنشاء مسودة مراجعة #${nextRevision} لميزان معتمد ${source.company.code} (${source.fromDate} → ${source.toDate}) ${source.dataType} تحلّ محلّ المراجعة #${source.revisionNumber} — السطور مبذورة من المعتمد (${source.lineCount} سطرًا)`,
      before,
      after,
      metadata: meta,
      ip,
    });
    return {
      ...importToDTO(draft),
      committedAt: null,
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
    };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * الاعتماد (COMMIT) — تجميد نهائي مع حراس دورة الحياة
 * ────────────────────────────────────────────────────────────────────────── */

export interface CommitTrialBalanceArgs {
  user: SessionUser;
  ip: string | null;
  id: string;
  input: { version: unknown; reason?: unknown };
}

export async function commitTrialBalance(args: CommitTrialBalanceArgs) {
  const { user, ip, id, input } = args;
  const current = await db.trialBalanceImport.findUnique({ where: { id }, select: IMPORT_SELECT });
  if (!current || !companyVisible(user, current.companyId)) {
    throw new TrialBalanceError("NOT_FOUND", "ميزان المراجعة غير موجود.");
  }
  assertCompanyScope(user, current.companyId);
  if (current.status === TB_STATUSES.COMMITTED) {
    throw new TrialBalanceError("NOT_FOUND", "الميزان معتمد بالفعل.");
  }
  if (current.status !== TB_STATUSES.DRAFT) {
    throw new TrialBalanceError(
      "NOT_BALANCED",
      "لا يُعتمد ميزان غير متوازن (مدين ≠ دائن) — صحّح الملف وأعد الرفع."
    );
  }
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new TrialBalanceError("VERSION_CONFLICT", "نسخة الميزان (version) إلزامية للاعتماد.");
  }

  // حراس دورة الحياة (6.1) — لا تجاوز بحجة الاستيراد:
  if (current.fiscalYear.status !== "OPEN") {
    throw new TrialBalanceError(
      "FISCAL_LIFECYCLE",
      `السنة المالية ${current.fiscalYear.code} حالتها ${current.fiscalYear.status} — الاعتماد يتطلب سنة OPEN (مسار حوكمة صريح لاحقًا).`
    );
  }
  const covered = await db.fiscalPeriod.findMany({
    where: { fiscalYearId: current.fiscalYearId, ordinal: { gte: current.startOrdinal, lte: current.endOrdinal } },
    select: { ordinal: true, status: true },
  });
  const nonOpen = covered.filter((p) => p.status !== "OPEN");
  if (nonOpen.length > 0) {
    throw new TrialBalanceError(
      "FISCAL_LIFECYCLE",
      `فترات مغطاة ليست OPEN (${nonOpen.map((p) => `#${p.ordinal}:${p.status}`).join("، ")}) — الاعتماد مرفوض محافظًا.`
    );
  }

  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";

  return db.$transaction(async (tx) => {
    const updated = await tx.trialBalanceImport.updateMany({
      where: { id, version },
      data: {
        status: TB_STATUSES.COMMITTED,
        committedAt: new Date(),
        committedById: user.id,
        committedByName: user.username,
        updatedById: user.id,
        updatedByName: user.username,
      },
    });
    if (updated.count === 0) {
      throw new TrialBalanceError("VERSION_CONFLICT", "تعارض نسخ: الميزان تغيّر — أعد التحميل ثم اعتمد.");
    }
    const fresh = await tx.trialBalanceImport.findUnique({ where: { id }, select: IMPORT_SELECT });
    if (!fresh) throw new TrialBalanceError("NOT_FOUND", "الميزان اختفى أثناء الاعتماد.");
    // تجميد snapshot الخريطة للسطور (يُحدَّث بعلم snapshotFrozen — محفوظ كقيم حالية)
    const lines = await tx.trialBalanceLine.findMany({ where: { importId: id }, select: { id: true, accountCode: true } });
    const mappings = await buildMappingSnapshots(tx, fresh.companyId, lines.map((l) => ({
      rowIndex: 0,
      accountCode: l.accountCode,
      accountName: "",
      debitMinor: BigInt(0),
      creditMinor: BigInt(0),
      netMinor: BigInt(0),
    })));
    for (let i = 0; i < lines.length; i += 1) {
      await tx.trialBalanceLine.update({
        where: { id: lines[i].id },
        data: SNAPSHOT_FIELDS(mappings[i]),
      });
    }
    const meta = {
      companyId: fresh.companyId,
      fiscalYearCode: fresh.fiscalYear.code,
      fromDate: fresh.fromDate,
      toDate: fresh.toDate,
      dataType: fresh.dataType,
      lineCount: fresh.lineCount,
      totalDebitMinor: fresh.totalDebitMinor.toString(),
      totalCreditMinor: fresh.totalCreditMinor.toString(),
      payloadHash: fresh.payloadHash,
      reason: reason || undefined,
    };
    // Phase 6.3 — اعتماد المراجعة: حراس السلسلة + كود تدقيق مخصص + before/after
    const isRevision = !!fresh.supersedesImportId;
    if (isRevision) {
      const chainMax = await tx.trialBalanceImport.findFirst({
        where: {
          companyId: fresh.companyId,
          fiscalYearId: fresh.fiscalYearId,
          fromDate: fresh.fromDate,
          toDate: fresh.toDate,
          dataType: fresh.dataType,
        },
        orderBy: { revisionNumber: "desc" },
        select: { revisionNumber: true },
      });
      if (!chainMax || chainMax.revisionNumber !== fresh.revisionNumber) {
        throw new TrialBalanceError("REVISION_STALE", "تعارض سلسلة المراجعات: توجد نسخة أحدث — لا اعتماد لنسخة قديمة.");
      }
    }
    const revisionMeta = isRevision
      ? {
          sourceImportId: fresh.supersedesImportId,
          oldRevisionNumber: fresh.revisionNumber - 1,
          newRevisionNumber: fresh.revisionNumber,
          revisionReason: fresh.revisionReason || undefined,
        }
      : {};
    await writeAudit(tx, {
      user,
      action: isRevision ? "TRIAL_BALANCE_REVISION_COMMITTED" : "TRIAL_BALANCE_COMMITTED",
      entityType: "TrialBalanceImport",
      entityId: fresh.id,
      description: isRevision
        ? `اعتماد مراجعة #${fresh.revisionNumber} لميزان ${fresh.company.code} (${fresh.fromDate} → ${fresh.toDate}) ${fresh.dataType} — تصبح أحدث المعتمدين في التقارير مع بقاء المراجعة #${fresh.revisionNumber - 1} سليمة للتتبع`
        : `اعتماد ميزان مراجعة ${fresh.company.code} (${fresh.fromDate} → ${fresh.toDate}) ${fresh.dataType} — ${fresh.lineCount} سطرًا — تجميد snapshot الخريطة`,
      before: isRevision
        ? { importId: fresh.id, revisionNumber: fresh.revisionNumber, status: "DRAFT" }
        : undefined,
      after: { ...meta, ...revisionMeta },
      metadata: { ...meta, ...revisionMeta },
      ip,
    });
    return { ...importToDTO(fresh), committedAt: fresh.committedAt!.toISOString(), createdAt: fresh.createdAt.toISOString(), updatedAt: fresh.updatedAt.toISOString() };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * إعادة التحقق (للمسودات فقط) — بعد تصنيف حسابات جديدة دون إعادة رفع Excel
 * ────────────────────────────────────────────────────────────────────────── */

export interface RevalidateTrialBalanceArgs {
  user: SessionUser;
  ip: string | null;
  id: string;
  input: { version: unknown; reason?: unknown };
}

export async function revalidateTrialBalance(args: RevalidateTrialBalanceArgs) {
  const { user, ip, id, input } = args;
  const current = await db.trialBalanceImport.findUnique({ where: { id }, select: IMPORT_SELECT });
  if (!current || !companyVisible(user, current.companyId)) {
    throw new TrialBalanceError("NOT_FOUND", "ميزان المراجعة غير موجود.");
  }
  assertCompanyScope(user, current.companyId);
  if (current.status === TB_STATUSES.COMMITTED) {
    throw new TrialBalanceError("NOT_FOUND", "الميزان معتمد — snapshot الخريطة مجمّد (لا إعادة تحقق).");
  }
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new TrialBalanceError("VERSION_CONFLICT", "نسخة الميزان (version) إلزامية لإعادة التحقق.");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";

  return db.$transaction(async (tx) => {
    const updated = await tx.trialBalanceImport.updateMany({
      where: { id, version },
      data: { version: version + 1, updatedById: user.id, updatedByName: user.username },
    });
    if (updated.count === 0) {
      throw new TrialBalanceError("VERSION_CONFLICT", "تعارض نسخ: الميزان تغيّر — أعد التحميل.");
    }
    const lines = await tx.trialBalanceLine.findMany({
      where: { importId: id },
      orderBy: { rowIndex: "asc" },
      select: { id: true, accountCode: true },
    });
    const mappings = await buildMappingSnapshots(tx, current.companyId, lines.map((l) => ({
      rowIndex: 0, accountCode: l.accountCode, accountName: "", debitMinor: BigInt(0), creditMinor: BigInt(0), netMinor: BigInt(0),
    })));
    for (let i = 0; i < lines.length; i += 1) {
      await tx.trialBalanceLine.update({ where: { id: lines[i].id }, data: SNAPSHOT_FIELDS(mappings[i]) });
    }
    const meta = { companyId: current.companyId, lineCount: lines.length, reason: reason || undefined };
    await writeAudit(tx, {
      user,
      action: "TRIAL_BALANCE_REVALIDATED",
      entityType: "TrialBalanceImport",
      entityId: id,
      description: `إعادة تحقق خريطة الحسابات لميزان مسودة ${current.company.code} (${current.fromDate} → ${current.toDate}) — ${lines.length} سطرًا`,
      metadata: meta,
      ip,
    });
    const summary = summarizeMapping(mappings);
    return { revalidated: lines.length, summary: { fullyMapped: summary.fullyMapped, needsAttention: summary.needsAttention, unclassified: summary.unclassified } };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * الحذف — مسودات فقط، version-guarded، بتدقيق
 * ────────────────────────────────────────────────────────────────────────── */

export interface DeleteTrialBalanceArgs {
  user: SessionUser;
  ip: string | null;
  id: string;
  input: { version: unknown; reason?: unknown };
}

export async function deleteTrialBalance(args: DeleteTrialBalanceArgs) {
  const { user, ip, id, input } = args;
  const current = await db.trialBalanceImport.findUnique({ where: { id }, select: IMPORT_SELECT });
  if (!current || !companyVisible(user, current.companyId)) {
    throw new TrialBalanceError("NOT_FOUND", "ميزان المراجعة غير موجود.");
  }
  assertCompanyScope(user, current.companyId);
  if (current.status === TB_STATUSES.COMMITTED) {
    throw new TrialBalanceError("NOT_FOUND", "الميزان المعتمد لا يُحذف — مسار Revision/Reopen لاحقًا حسب الـ workflow.");
  }
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new TrialBalanceError("VERSION_CONFLICT", "نسخة الميزان (version) إلزامية للحذف.");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";

  return db.$transaction(async (tx) => {
    const deleted = await tx.trialBalanceImport.deleteMany({ where: { id, version } });
    if (deleted.count === 0) {
      throw new TrialBalanceError("VERSION_CONFLICT", "تعارض نسخ عند الحذف: الميزان تغيّر — أعد التحميل.");
    }
    const before = {
      companyId: current.companyId,
      fromDate: current.fromDate,
      toDate: current.toDate,
      dataType: current.dataType,
      status: current.status,
      lineCount: current.lineCount,
      totalDebitMinor: current.totalDebitMinor.toString(),
      totalCreditMinor: current.totalCreditMinor.toString(),
      payloadHash: current.payloadHash,
    };
    await writeAudit(tx, {
      user,
      action: "TRIAL_BALANCE_DELETED",
      entityType: "TrialBalanceImport",
      entityId: current.id,
      description: `حذف ميزان مراجعة ${current.status} لشركة ${current.company.code} (${current.fromDate} → ${current.toDate})`,
      before,
      metadata: { ...before, reason: reason || undefined },
      ip,
    });
    return { id: current.id };
  });
}
