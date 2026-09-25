// Phase 6.2A — خدمة «دليل الحسابات وقواعد التصنيف» (خادم فقط — تستورد db).
// التصميم النهائي المعتمد: جذور نظامية ثابتة 1/2/3/4 (قراءة فقط) + بادئات
// تفصيلية لكل شركة + استثناءات حسابات محددة + مرجع بنود القوائم المالية.
//
// الضوابط المعمارية:
//   - optimistic locking بنمط المشروع: updateMany/deleteMany شرطي على version ⇒ 409.
//   - Audit Trail القائم حصرًا (writeAudit داخل نفس المعاملة) — before/after/reason.
//   - fail-closed: الجذور النظامية (companyId=null، source=SYSTEM) تُقرأ فقط —
//     أي إنشاء/تعديل/حذف لها يُرفض (SYSTEM_IMMUTABLE). بادئات الشركات تتطلب
//     companyVisible (company-access.ts) — لا يوجد نطاق نظامي للإنشاء إطلاقًا.
//   - حاجز الاتساق: بند القائمة يجب أن يطابق التصنيف (أصل لا يقع على قائمة أرباح).
//   - دورة حياة 6.1 (CLOSED/LOCKED) غير مماسة: هذه القواعد metadata تصنيفية.

import { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { companyVisible } from "@/lib/company-access";
import {
  AccountNatureError,
  assertOverrideRootAlignment,
  assertPrefixRootAlignment,
  isStatementLineConsistent,
  normalizeNaturePrefix,
  resolveAccountMapping,
  summarizeMapping,
  validateCompanyPrefixInput,
  validateMappingOverrideInput,
  type AccountClassification,
  type AggregationBehavior,
  type MappingOverrideLike,
  type MappingRuleLike,
  type MappingStatus,
  type ResolvedAccountMapping,
} from "@/lib/account-nature";
import type { SessionUser } from "@/lib/session";

type TxClient = Prisma.TransactionClient | PrismaClient;

const RULE_SELECT = {
  id: true,
  companyId: true,
  prefix: true,
  mainCategory: true,
  classification: true,
  aggregationBehavior: true,
  statementLineId: true,
  statementLine: { select: { code: true, nameAr: true, statementType: true } },
  source: true,
  note: true,
  isActive: true,
  version: true,
  createdById: true,
  createdByName: true,
  updatedById: true,
  updatedByName: true,
  createdAt: true,
  updatedAt: true,
  company: { select: { code: true, nameAr: true } },
} as const;

export type NatureRuleRow = Prisma.AccountNatureRuleGetPayload<{ select: typeof RULE_SELECT }>;

const OVERRIDE_SELECT = {
  id: true,
  companyId: true,
  accountCode: true,
  classification: true,
  aggregationBehavior: true,
  statementLineId: true,
  statementLine: { select: { code: true, nameAr: true, statementType: true } },
  note: true,
  isActive: true,
  version: true,
  createdById: true,
  createdByName: true,
  updatedById: true,
  updatedByName: true,
  createdAt: true,
  updatedAt: true,
  company: { select: { code: true, nameAr: true } },
} as const;

export type MappingOverrideRow = Prisma.AccountMappingOverrideGetPayload<{ select: typeof OVERRIDE_SELECT }>;

const LINE_SELECT = {
  id: true,
  code: true,
  nameAr: true,
  nameEn: true,
  statementType: true,
  parentId: true,
  parent: { select: { code: true, nameAr: true } },
  displayOrder: true,
  isSubtotal: true,
  isActive: true,
  version: true,
} as const;

export type StatementLineRow = Prisma.FinancialStatementLineGetPayload<{ select: typeof LINE_SELECT }>;

/** تحقق نطاق الشركة لأي عملية كتابة — يرمي Forbidden الدلالي (RULE_NOT_FOUND). */
function assertCompanyScope(user: SessionUser, companyId: string): void {
  if (!companyVisible(user, companyId)) {
    throw new AccountNatureError("RULE_NOT_FOUND", "لا تملك الوصول لهذه الشركة.");
  }
}

/** الجذور النظامية (companyId=null) للقراءة فقط — حارس موحّد (fail-closed). */
function assertNotSystemRule(rule: { companyId: string | null; source: string }): void {
  if (rule.companyId === null || rule.source === "SYSTEM") {
    throw new AccountNatureError(
      "SYSTEM_IMMUTABLE",
      "الجذور النظامية 1/2/3/4 ثابتة للقراءة فقط — لا إنشاء ولا تعديل ولا حذف عبر الواجهة."
    );
  }
}

/** التحقق من بند القائمة: موجود + نشط + متسق مع التصنيف — يُعيد البند. */
async function resolveStatementLine(
  client: TxClient,
  code: string | null,
  classification: AccountClassification
) {
  if (!code) return null;
  const line = await client.financialStatementLine.findUnique({
    where: { code },
    select: { id: true, code: true, isActive: true, statementType: true },
  });
  if (!line || !line.isActive) {
    throw new AccountNatureError("INVALID_STATEMENT_LINE", `بند القائمة المالية «${code}» غير موجود أو غير نشط.`);
  }
  if (!isStatementLineConsistent(classification, line.statementType)) {
    throw new AccountNatureError(
      "STATEMENT_LINE_MISMATCH",
      `بند القائمة «${code}» (${line.statementType}) لا يتسق مع التصنيف ${classification}.`
    );
  }
  return line;
}

/* ──────────────────────────────────────────────────────────────────────────
 * بادئات الشركات التفصيلية (Company Detailed Prefix Rules)
 * ────────────────────────────────────────────────────────────────────────── */

/** كل القواعد (الجذور النظامية + بادئات الشركات المرئية) — لواجهة الإدارة. */
export async function listNatureRules(user: SessionUser): Promise<NatureRuleRow[]> {
  const rows = await db.accountNatureRule.findMany({
    orderBy: [{ companyId: "asc" }, { prefix: "asc" }],
    select: RULE_SELECT,
  });
  // فلترة رؤية الشركات خادميًا: الجذور النظامية + الشركات المرئية فقط (fail-closed).
  return rows.filter((r) => r.companyId === null || companyVisible(user, r.companyId));
}

export interface CreateNatureRuleArgs {
  user: SessionUser;
  ip: string | null;
  input: {
    companyId?: string | null;
    prefix: unknown;
    classification: unknown;
    aggregationBehavior: unknown;
    statementLineCode?: unknown;
    note?: unknown;
    reason?: unknown;
  };
}

/** إنشاء بادئة شركة تفصيلية — الإنشاء النظامي مرفوض نهائيًا (الجذور seed ثابتة). */
export async function createNatureRule(args: CreateNatureRuleArgs): Promise<NatureRuleRow> {
  const { user, ip, input } = args;
  const rawCompanyId =
    typeof input.companyId === "string" && input.companyId.trim().length > 0
      ? input.companyId.trim()
      : null;
  if (rawCompanyId === null) {
    throw new AccountNatureError(
      "SYSTEM_IMMUTABLE",
      "لا تُنشأ قواعد نظامية جديدة — الجذور 1/2/3/4 ثابتة، والتصنيف التفصيلي يُعرَّف داخل كل شركة."
    );
  }
  assertCompanyScope(user, rawCompanyId);

  const validated = validateCompanyPrefixInput(input);
  const company = await db.company.findUnique({ where: { id: rawCompanyId }, select: { id: true } });
  if (!company) throw new AccountNatureError("RULE_NOT_FOUND", "الشركة غير موجودة.");

  const dup = await db.accountNatureRule.findFirst({
    where: { companyId: rawCompanyId, prefix: validated.prefix },
    select: { id: true },
  });
  if (dup) {
    throw new AccountNatureError(
      "RULE_PREFIX_DUPLICATE",
      `توجد بادئة بنفس الكود «${validated.prefix}» لهذه الشركة.`
    );
  }

  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";

  return db.$transaction(async (tx) => {
    const line = await resolveStatementLine(tx, validated.statementLineCode, validated.classification);
    const created = await tx.accountNatureRule.create({
      data: {
        companyId: rawCompanyId,
        prefix: validated.prefix,
        mainCategory: null, // الفئة الرئيسية من الجذور النظامية حصرًا (fail-closed)
        classification: validated.classification,
        aggregationBehavior: validated.aggregationBehavior,
        statementLineId: line?.id ?? null,
        source: "MANUAL",
        note: validated.note ?? "",
        isActive: true,
        createdById: user.id,
        createdByName: user.username,
        updatedById: user.id,
        updatedByName: user.username,
      },
      select: RULE_SELECT,
    });
    const { company: _company, ...auditFields } = created;
    await writeAudit(tx, {
      user,
      action: "ACCOUNT_NATURE_RULE_CREATED",
      entityType: "AccountNatureRule",
      entityId: created.id,
      description: `إنشاء بادئة شركة تفصيلية «${created.prefix}» (${created.classification}/${created.aggregationBehavior})${created.statementLine ? ` — بند: ${created.statementLine.code}` : " — بلا بند مالي (ROOT_ONLY)"}`,
      after: auditFields,
      metadata: {
        scope: "COMPANY",
        companyId: created.companyId,
        statementLineCode: created.statementLine?.code ?? null,
        reason: reason || undefined,
        changedFields: ["prefix", "classification", "aggregationBehavior", "statementLineCode", "note"],
      },
      ip,
    });
    return created;
  });
}

export interface UpdateNatureRuleArgs {
  user: SessionUser;
  ip: string | null;
  id: string;
  input: {
    classification?: unknown;
    aggregationBehavior?: unknown;
    statementLineCode?: unknown;
    isActive?: unknown;
    note?: unknown;
    reason?: unknown;
    version: unknown;
  };
}

export async function updateNatureRule(args: UpdateNatureRuleArgs): Promise<NatureRuleRow> {
  const { user, ip, id, input } = args;
  const current = await db.accountNatureRule.findUnique({ where: { id }, select: RULE_SELECT });
  if (!current) throw new AccountNatureError("RULE_NOT_FOUND", "القاعدة غير موجودة.");
  assertNotSystemRule(current);
  assertCompanyScope(user, current.companyId as string);

  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new AccountNatureError("VERSION_CONFLICT", "نسخة القاعدة (version) إلزامية للحفظ.");
  }

  // التغييرات المسموحة: التصنيف/السلوك/البند/التفعيل/الملاحظة — البادئة والنطاق لا تتغيران
  // (تغيير البادئة = قاعدة جديدة بقرار صريح، لا تعديل صامت لهوية القاعدة).
  let classification = current.classification as AccountClassification | null;
  let aggregationBehavior = current.aggregationBehavior as AggregationBehavior;
  if (input.classification !== undefined || input.aggregationBehavior !== undefined) {
    const v = validateCompanyPrefixInput({
      prefix: current.prefix,
      classification: input.classification ?? current.classification,
      aggregationBehavior: input.aggregationBehavior ?? current.aggregationBehavior,
    });
    classification = v.classification;
    aggregationBehavior = v.aggregationBehavior;
  }
  let statementLineId: string | null | undefined;
  if (input.statementLineCode !== undefined) {
    const code =
      typeof input.statementLineCode === "string" && input.statementLineCode.trim().length > 0
        ? input.statementLineCode.trim()
        : null;
    const line = await resolveStatementLine(db, code, classification as AccountClassification);
    statementLineId = line?.id ?? null;
  }
  const patch: {
    classification?: AccountClassification;
    aggregationBehavior?: AggregationBehavior;
    statementLineId?: string | null;
    isActive?: boolean;
    note?: string;
  } = {};
  if (input.classification !== undefined || input.aggregationBehavior !== undefined) {
    patch.classification = classification as AccountClassification;
    patch.aggregationBehavior = aggregationBehavior;
  }
  if (statementLineId !== undefined) patch.statementLineId = statementLineId;
  if (input.isActive !== undefined) patch.isActive = input.isActive === true;
  if (input.note !== undefined) {
    const v = validateCompanyPrefixInput({
      prefix: current.prefix,
      classification: classification ?? "OTHER",
      aggregationBehavior: aggregationBehavior,
      note: input.note,
    });
    patch.note = v.note;
  }
  if (Object.keys(patch).length === 0) {
    throw new AccountNatureError("INVALID_PREFIX", "لا توجد حقول قابلة للتعديل في الطلب.");
  }

  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";

  return db.$transaction(async (tx) => {
    // نمط المشروع: updateMany شرطي على version — التعارض ⇒ 409 دلالي.
    const updated = await tx.accountNatureRule.updateMany({
      where: { id, version },
      data: {
        ...patch,
        version: version + 1,
        updatedById: user.id,
        updatedByName: user.username,
      },
    });
    if (updated.count === 0) {
      throw new AccountNatureError(
        "VERSION_CONFLICT",
        "تعارض نسخ: القاعدة عدّلت من مستخدم آخر — أعد التحميل ثم أعد المحاولة."
      );
    }
    const fresh = await tx.accountNatureRule.findUnique({ where: { id }, select: RULE_SELECT });
    if (!fresh) throw new AccountNatureError("RULE_NOT_FOUND", "القاعدة اختفت أثناء التحديث.");
    const { company: _company, ...auditFields } = fresh;
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      before[k] = (current as unknown as Record<string, unknown>)[k];
    }
    await writeAudit(tx, {
      user,
      action: "ACCOUNT_NATURE_RULE_UPDATED",
      entityType: "AccountNatureRule",
      entityId: fresh.id,
      description: `تعديل بادئة شركة «${fresh.prefix}»${
        patch.classification || patch.aggregationBehavior
          ? ` ⇒ ${patch.classification ?? current.classification}/${patch.aggregationBehavior ?? current.aggregationBehavior}`
          : ""
      }${patch.statementLineId !== undefined ? " — تغيّر البند المالي" : ""}`,
      before,
      after: patch,
      metadata: {
        scope: "COMPANY",
        companyId: fresh.companyId,
        previousVersion: version,
        newVersion: version + 1,
        reason: reason || undefined,
        changedFields: Object.keys(patch),
      },
      ip,
    });
    return fresh;
  });
}

export interface DeleteNatureRuleArgs {
  user: SessionUser;
  ip: string | null;
  id: string;
  input: { reason?: unknown; version: unknown };
}

export async function deleteNatureRule(args: DeleteNatureRuleArgs): Promise<{ id: string }> {
  const { user, ip, id, input } = args;
  const current = await db.accountNatureRule.findUnique({ where: { id }, select: RULE_SELECT });
  if (!current) throw new AccountNatureError("RULE_NOT_FOUND", "القاعدة غير موجودة.");
  assertNotSystemRule(current);
  assertCompanyScope(user, current.companyId as string);

  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new AccountNatureError("VERSION_CONFLICT", "نسخة القاعدة (version) إلزامية للحذف.");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";

  return db.$transaction(async (tx) => {
    const deleted = await tx.accountNatureRule.deleteMany({
      where: { id, version }, // حذف بشرط النسخة — حماية تعارض مماثلة
    });
    if (deleted.count === 0) {
      throw new AccountNatureError(
        "VERSION_CONFLICT",
        "تعارض نسخ عند الحذف: القاعدة تغيّرت — أعد التحميل ثم أعد المحاولة."
      );
    }
    const { company: _company, ...before } = current;
    await writeAudit(tx, {
      user,
      action: "ACCOUNT_NATURE_RULE_DELETED",
      entityType: "AccountNatureRule",
      entityId: current.id,
      description: `حذف بادئة شركة «${current.prefix}» (${current.classification}/${current.aggregationBehavior})`,
      before,
      metadata: {
        scope: "COMPANY",
        companyId: current.companyId,
        version,
        reason: reason || undefined,
      },
      ip,
    });
    return { id: current.id };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * استثناءات الحسابات (Account-specific Overrides)
 * ────────────────────────────────────────────────────────────────────────── */

/** قائمة الاستثناءات للشركات المرئية (اختياريًا: شركة واحدة). */
export async function listMappingOverrides(
  user: SessionUser,
  companyId?: string | null
): Promise<MappingOverrideRow[]> {
  const where: Prisma.AccountMappingOverrideWhereInput = {};
  if (companyId) {
    assertCompanyScope(user, companyId);
    where.companyId = companyId;
  }
  const rows = await db.accountMappingOverride.findMany({
    where,
    orderBy: [{ companyId: "asc" }, { accountCode: "asc" }],
    select: OVERRIDE_SELECT,
  });
  return rows.filter((r) => companyVisible(user, r.companyId));
}

export interface CreateMappingOverrideArgs {
  user: SessionUser;
  ip: string | null;
  input: {
    companyId?: string | null;
    accountCode: unknown;
    classification: unknown;
    aggregationBehavior: unknown;
    statementLineCode?: unknown;
    note?: unknown;
    reason?: unknown;
  };
}

export async function createMappingOverride(args: CreateMappingOverrideArgs): Promise<MappingOverrideRow> {
  const { user, ip, input } = args;
  const rawCompanyId =
    typeof input.companyId === "string" && input.companyId.trim().length > 0
      ? input.companyId.trim()
      : null;
  if (rawCompanyId === null) {
    throw new AccountNatureError("COMPANY_REQUIRED", "الاستثناء خاص بشركة محددة — نطاق الشركة إلزامي.");
  }
  assertCompanyScope(user, rawCompanyId);

  const validated = validateMappingOverrideInput(input);
  const company = await db.company.findUnique({ where: { id: rawCompanyId }, select: { id: true } });
  if (!company) throw new AccountNatureError("RULE_NOT_FOUND", "الشركة غير موجودة.");

  const dup = await db.accountMappingOverride.findFirst({
    where: { companyId: rawCompanyId, accountCode: validated.accountCode },
    select: { id: true },
  });
  if (dup) {
    throw new AccountNatureError(
      "OVERRIDE_DUPLICATE",
      `يوجد استثناء بنفس كود الحساب «${validated.accountCode}» لهذه الشركة.`
    );
  }

  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";

  return db.$transaction(async (tx) => {
    const line = await resolveStatementLine(tx, validated.statementLineCode, validated.classification);
    const created = await tx.accountMappingOverride.create({
      data: {
        companyId: rawCompanyId,
        accountCode: validated.accountCode,
        classification: validated.classification,
        aggregationBehavior: validated.aggregationBehavior,
        statementLineId: line?.id ?? null,
        note: validated.note ?? "",
        isActive: true,
        createdById: user.id,
        createdByName: user.username,
        updatedById: user.id,
        updatedByName: user.username,
      },
      select: OVERRIDE_SELECT,
    });
    const { company: _company, ...auditFields } = created;
    await writeAudit(tx, {
      user,
      action: "ACCOUNT_NATURE_OVERRIDE_CREATED",
      entityType: "AccountMappingOverride",
      entityId: created.id,
      description: `إنشاء استثناء للحساب «${created.accountCode}» (${created.classification}/${created.aggregationBehavior})${created.statementLine ? ` — بند: ${created.statementLine.code}` : " — بلا بند مالي"}`,
      after: auditFields,
      metadata: {
        companyId: created.companyId,
        accountCode: created.accountCode,
        statementLineCode: created.statementLine?.code ?? null,
        reason: reason || undefined,
        changedFields: ["accountCode", "classification", "aggregationBehavior", "statementLineCode", "note"],
      },
      ip,
    });
    return created;
  });
}

export interface UpdateMappingOverrideArgs {
  user: SessionUser;
  ip: string | null;
  id: string;
  input: {
    classification?: unknown;
    aggregationBehavior?: unknown;
    statementLineCode?: unknown;
    isActive?: unknown;
    note?: unknown;
    reason?: unknown;
    version: unknown;
  };
}

export async function updateMappingOverride(args: UpdateMappingOverrideArgs): Promise<MappingOverrideRow> {
  const { user, ip, id, input } = args;
  const current = await db.accountMappingOverride.findUnique({ where: { id }, select: OVERRIDE_SELECT });
  if (!current) throw new AccountNatureError("OVERRIDE_NOT_FOUND", "الاستثناء غير موجود.");
  assertCompanyScope(user, current.companyId);

  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new AccountNatureError("VERSION_CONFLICT", "نسخة الاستثناء (version) إلزامية للحفظ.");
  }

  let classification = current.classification as AccountClassification;
  let aggregationBehavior = current.aggregationBehavior as AggregationBehavior;
  if (input.classification !== undefined || input.aggregationBehavior !== undefined) {
    const v = validateMappingOverrideInput({
      accountCode: current.accountCode,
      classification: input.classification ?? current.classification,
      aggregationBehavior: input.aggregationBehavior ?? current.aggregationBehavior,
    });
    classification = v.classification;
    aggregationBehavior = v.aggregationBehavior;
  }
  let statementLineId: string | null | undefined;
  if (input.statementLineCode !== undefined) {
    const code =
      typeof input.statementLineCode === "string" && input.statementLineCode.trim().length > 0
        ? input.statementLineCode.trim()
        : null;
    const line = await resolveStatementLine(db, code, classification);
    statementLineId = line?.id ?? null;
  }
  const patch: {
    classification?: AccountClassification;
    aggregationBehavior?: AggregationBehavior;
    statementLineId?: string | null;
    isActive?: boolean;
    note?: string;
  } = {};
  if (input.classification !== undefined || input.aggregationBehavior !== undefined) {
    patch.classification = classification;
    patch.aggregationBehavior = aggregationBehavior;
  }
  if (statementLineId !== undefined) patch.statementLineId = statementLineId;
  if (input.isActive !== undefined) patch.isActive = input.isActive === true;
  if (input.note !== undefined) {
    const v = validateMappingOverrideInput({
      accountCode: current.accountCode,
      classification,
      aggregationBehavior,
      note: input.note,
    });
    patch.note = v.note;
  }
  if (Object.keys(patch).length === 0) {
    throw new AccountNatureError("INVALID_ACCOUNT_CODE", "لا توجد حقول قابلة للتعديل في الطلب.");
  }

  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";

  return db.$transaction(async (tx) => {
    const updated = await tx.accountMappingOverride.updateMany({
      where: { id, version },
      data: {
        ...patch,
        version: version + 1,
        updatedById: user.id,
        updatedByName: user.username,
      },
    });
    if (updated.count === 0) {
      throw new AccountNatureError(
        "VERSION_CONFLICT",
        "تعارض نسخ: الاستثناء عدّل من مستخدم آخر — أعد التحميل ثم أعد المحاولة."
      );
    }
    const fresh = await tx.accountMappingOverride.findUnique({ where: { id }, select: OVERRIDE_SELECT });
    if (!fresh) throw new AccountNatureError("OVERRIDE_NOT_FOUND", "الاستثناء اختفى أثناء التحديث.");
    const { company: _company, ...auditFields } = fresh;
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      before[k] = (current as unknown as Record<string, unknown>)[k];
    }
    await writeAudit(tx, {
      user,
      action: "ACCOUNT_NATURE_OVERRIDE_UPDATED",
      entityType: "AccountMappingOverride",
      entityId: fresh.id,
      description: `تعديل استثناء الحساب «${fresh.accountCode}» ⇒ ${patch.classification ?? current.classification}/${patch.aggregationBehavior ?? current.aggregationBehavior}`,
      before,
      after: patch,
      metadata: {
        companyId: fresh.companyId,
        accountCode: fresh.accountCode,
        previousVersion: version,
        newVersion: version + 1,
        reason: reason || undefined,
        changedFields: Object.keys(patch),
      },
      ip,
    });
    return fresh;
  });
}

export interface DeleteMappingOverrideArgs {
  user: SessionUser;
  ip: string | null;
  id: string;
  input: { reason?: unknown; version: unknown };
}

export async function deleteMappingOverride(args: DeleteMappingOverrideArgs): Promise<{ id: string }> {
  const { user, ip, id, input } = args;
  const current = await db.accountMappingOverride.findUnique({ where: { id }, select: OVERRIDE_SELECT });
  if (!current) throw new AccountNatureError("OVERRIDE_NOT_FOUND", "الاستثناء غير موجود.");
  assertCompanyScope(user, current.companyId);

  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new AccountNatureError("VERSION_CONFLICT", "نسخة الاستثناء (version) إلزامية للحذف.");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";

  return db.$transaction(async (tx) => {
    const deleted = await tx.accountMappingOverride.deleteMany({ where: { id, version } });
    if (deleted.count === 0) {
      throw new AccountNatureError(
        "VERSION_CONFLICT",
        "تعارض نسخ عند الحذف: الاستثناء تغيّر — أعد التحميل ثم أعد المحاولة."
      );
    }
    const { company: _company, ...before } = current;
    await writeAudit(tx, {
      user,
      action: "ACCOUNT_NATURE_OVERRIDE_DELETED",
      entityType: "AccountMappingOverride",
      entityId: current.id,
      description: `حذف استثناء الحساب «${current.accountCode}» (${current.classification}/${current.aggregationBehavior})`,
      before,
      metadata: {
        companyId: current.companyId,
        accountCode: current.accountCode,
        version,
        reason: reason || undefined,
      },
      ip,
    });
    return { id: current.id };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * بنود القوائم المالية (مرجع قراءة — الإدارة الكاملة لاحقًا)
 * ────────────────────────────────────────────────────────────────────────── */

export async function listStatementLines(includeInactive = false): Promise<StatementLineRow[]> {
  return db.financialStatementLine.findMany({
    where: includeInactive ? undefined : { isActive: true },
    orderBy: [{ statementType: "asc" }, { displayOrder: "asc" }, { code: "asc" }],
    select: LINE_SELECT,
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * نسخ خريطة شركة (Copy Chart Mapping From Company) — تنفيذ صغير آمن معزول:
 * نسخة مستقلة تمامًا؛ تعديل المصدر لاحقًا لا يمس الهدف إطلاقًا.
 * ────────────────────────────────────────────────────────────────────────── */

export interface CopyCompanyMappingArgs {
  user: SessionUser;
  ip: string | null;
  input: {
    fromCompanyId: unknown;
    toCompanyId: unknown;
    replaceExisting?: unknown;
    reason?: unknown;
  };
}

export async function copyCompanyMapping(
  args: CopyCompanyMappingArgs
): Promise<{ rulesCopied: number; overridesCopied: number; replaced: boolean }> {
  const { user, ip, input } = args;
  const fromId = typeof input.fromCompanyId === "string" ? input.fromCompanyId.trim() : "";
  const toId = typeof input.toCompanyId === "string" ? input.toCompanyId.trim() : "";
  if (!fromId || !toId) {
    throw new AccountNatureError("COPY_NOT_ALLOWED", "شركتا المصدر والهدف إلزاميتان للنسخ.");
  }
  if (fromId === toId) {
    throw new AccountNatureError("COPY_NOT_ALLOWED", "نسخ الخريطة من شركة إلى نفسها غير مسموح.");
  }
  assertCompanyScope(user, fromId);
  assertCompanyScope(user, toId);

  const [fromCompany, toCompany] = await Promise.all([
    db.company.findUnique({ where: { id: fromId }, select: { id: true, code: true, nameAr: true } }),
    db.company.findUnique({ where: { id: toId }, select: { id: true, code: true, nameAr: true } }),
  ]);
  if (!fromCompany || !toCompany) {
    throw new AccountNatureError("RULE_NOT_FOUND", "شركة المصدر أو الهدف غير موجودة.");
  }

  const replaceExisting = input.replaceExisting === true;
  const [existingRules, existingOverrides] = await Promise.all([
    db.accountNatureRule.count({ where: { companyId: toId } }),
    db.accountMappingOverride.count({ where: { companyId: toId } }),
  ]);
  if ((existingRules > 0 || existingOverrides > 0) && !replaceExisting) {
    throw new AccountNatureError(
      "COPY_NOT_ALLOWED",
      "الشركة الهدف لديها قواعد/استثناءات قائمة — فعّل «الاستبدال» صراحةً لاستبدالها بالكامل."
    );
  }

  const sourceRules = await db.accountNatureRule.findMany({
    where: { companyId: fromId },
    select: { prefix: true, classification: true, aggregationBehavior: true, statementLineId: true, note: true, isActive: true },
    orderBy: { prefix: "asc" },
  });
  const sourceOverrides = await db.accountMappingOverride.findMany({
    where: { companyId: fromId },
    select: { accountCode: true, classification: true, aggregationBehavior: true, statementLineId: true, note: true, isActive: true },
    orderBy: { accountCode: "asc" },
  });
  if (sourceRules.length === 0 && sourceOverrides.length === 0) {
    throw new AccountNatureError("COPY_NOT_ALLOWED", "شركة المصدر بلا بادئات تفصيلية ولا استثناءات — لا شيء يُنسخ.");
  }

  // حاجز تناقض الجذر على النسخ — لا تُنسخ قواعد/استثناءات تخالف جذورها النظامية
  // (31xx⇒EQUITY مرفوض حتى لو وُجدت قديمة في شركة المصدر).
  for (const r of sourceRules) {
    assertPrefixRootAlignment(r.prefix, r.classification as AccountClassification);
  }
  for (const o of sourceOverrides) {
    assertOverrideRootAlignment(o.accountCode, o.classification as AccountClassification);
  }

  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";

  return db.$transaction(async (tx) => {
    if (replaceExisting) {
      // استبدال صريح داخل نفس المعاملة — إما الكل أو لا شيء.
      await tx.accountNatureRule.deleteMany({ where: { companyId: toId } });
      await tx.accountMappingOverride.deleteMany({ where: { companyId: toId } });
    }
    for (const r of sourceRules) {
      await tx.accountNatureRule.create({
        data: {
          companyId: toId,
          prefix: r.prefix,
          mainCategory: null,
          classification: r.classification,
          aggregationBehavior: r.aggregationBehavior,
          statementLineId: r.statementLineId,
          source: "MANUAL",
          note: r.note,
          isActive: r.isActive,
          createdById: user.id,
          createdByName: user.username,
          updatedById: user.id,
          updatedByName: user.username,
        },
      });
    }
    for (const o of sourceOverrides) {
      await tx.accountMappingOverride.create({
        data: {
          companyId: toId,
          accountCode: o.accountCode,
          classification: o.classification,
          aggregationBehavior: o.aggregationBehavior,
          statementLineId: o.statementLineId,
          note: o.note,
          isActive: o.isActive,
          createdById: user.id,
          createdByName: user.username,
          updatedById: user.id,
          updatedByName: user.username,
        },
      });
    }
    await writeAudit(tx, {
      user,
      action: "ACCOUNT_NATURE_MAPPING_COPIED",
      entityType: "Company",
      entityId: toId,
      description: `نسخ دليل الحسابات وقواعد التصنيف من ${fromCompany.code} (${fromCompany.nameAr}) إلى ${toCompany.code} (${toCompany.nameAr}) — ${sourceRules.length} بادئة و${sourceOverrides.length} استثناءً${replaceExisting ? " مع استبدال القائمة القائمة" : ""}`,
      before: replaceExisting ? { rules: existingRules, overrides: existingOverrides } : undefined,
      after: { rulesCopied: sourceRules.length, overridesCopied: sourceOverrides.length },
      metadata: {
        fromCompanyId: fromId,
        toCompanyId: toId,
        fromCompanyCode: fromCompany.code,
        toCompanyCode: toCompany.code,
        rulesCopied: sourceRules.length,
        overridesCopied: sourceOverrides.length,
        replaced: replaceExisting,
        reason: reason || undefined,
      },
      ip,
    });
    return { rulesCopied: sourceRules.length, overridesCopied: sourceOverrides.length, replaced: replaceExisting };
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * الحل الخادمي المركزي — نقطة الدخول الوحيدة لتحليل أكواد الحسابات
 * (ستستهلكه Monthly/YTD/Actual-vs-Budget/القوائم في 6.2B — لا منطق بديل).
 * ────────────────────────────────────────────────────────────────────────── */

export interface ResolveMappingResult {
  results: ResolvedAccountMapping[];
  summary: {
    total: number;
    byStatus: Record<MappingStatus, number>;
    fullyMapped: number;
    needsAttention: number;
    unclassified: number;
  };
}

function toRuleLike(row: {
  id: string;
  companyId: string | null;
  prefix: string;
  mainCategory: string | null;
  classification: string | null;
  aggregationBehavior: string;
  statementLine: { code: string } | null;
  source: string;
  isActive: boolean;
}): MappingRuleLike {
  return {
    id: row.id,
    companyId: row.companyId,
    prefix: row.prefix,
    mainCategory: row.mainCategory,
    classification: row.classification,
    aggregationBehavior: row.aggregationBehavior,
    statementLineCode: row.statementLine?.code ?? null,
    source: row.source,
    isActive: row.isActive,
  };
}

function toOverrideLike(row: {
  id: string;
  companyId: string;
  accountCode: string;
  classification: string;
  aggregationBehavior: string;
  statementLine: { code: string } | null;
  isActive: boolean;
}): MappingOverrideLike {
  return {
    id: row.id,
    companyId: row.companyId,
    accountCode: row.accountCode,
    classification: row.classification,
    aggregationBehavior: row.aggregationBehavior,
    statementLineCode: row.statementLine?.code ?? null,
    isActive: row.isActive,
  };
}

export async function resolveCodesForCompany(
  companyId: string | null,
  codes: readonly unknown[]
): Promise<ResolveMappingResult> {
  const rules = await db.accountNatureRule.findMany({
    where: { isActive: true, OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] },
    select: { id: true, companyId: true, prefix: true, mainCategory: true, classification: true, aggregationBehavior: true, statementLine: { select: { code: true } }, source: true, isActive: true },
  });
  const overrides = companyId
    ? await db.accountMappingOverride.findMany({
        where: { isActive: true, companyId },
        select: { id: true, companyId: true, accountCode: true, classification: true, aggregationBehavior: true, statementLine: { select: { code: true } }, isActive: true },
      })
    : [];
  const lines = await db.financialStatementLine.findMany({
    where: { isActive: true },
    select: { code: true, nameAr: true, statementType: true, isActive: true },
  });
  const ruleLikes = rules.map(toRuleLike);
  const overrideLikes = overrides.map(toOverrideLike);
  const cleanCodes = codes.filter((c): c is string => typeof c === "string");
  const results = cleanCodes.map((code) =>
    resolveAccountMapping({ accountCode: code, rules: ruleLikes, overrides: overrideLikes, lines, companyId })
  );
  return { results, summary: summarizeMapping(results) };
}

/** إعادة تصدير للتحقق النقيل في الاختبارات (نفس وحدة الدلالة). */
export { normalizeNaturePrefix };
