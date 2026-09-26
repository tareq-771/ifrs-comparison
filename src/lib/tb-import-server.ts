// ══════════════════════════════════════════════════════════════════════════════
// Phase 7.0 (Step 3) — TB Importer Server Orchestration + Controlled Draft Save
// طبقة التنسيق الخادمية لمستورد ميزان المراجعة — حدود الثقة + الإصرار المضبوط.
//
// القواعد المقفلة:
//  • المتصفح غير موثوق: الخادم يعيد بناء كل شيء حتميًا من المصدر الخام عبر
//    مكتبات Step-1/Step-2 النقية حصرًا — لا قيم مُطبَّعة ولا تصنيفات ولا مجاميع
//    ولا هاشتات ولا dataType من العميل.
//  • المعاينة والحفظ يمرّان بنفس المسار الحتمي حصرًا (لا انحراف معاينة/حفظ).
//  • الإصرار حصرًا عبر مخطط TrialBalanceImport/TrialBalanceLine القائم — بلا
//    نماذج أو أعمدة جديدة، بلا ترحيلات، بلا مسlayers حياة موازية.
//  • الإثبات عبر AuditLog القائم (append-only) بإجراء TRIAL_BALANCE_PROVENANCE
//    وبيانات موجزة محدودة الحدود — لا صفوف مصدر ولا خلايا ولا ملفات.
//  • المعاينة قراءة صرفة — لا كتابة على الإطلاق.
// ══════════════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { companyVisible } from "@/lib/company-access";
import { CURRENCIES, isSupportedCurrency } from "@/lib/currencies";
import type { SessionUser } from "@/lib/session";
import {
  resolveFiscalContext,
  TB_DATA_TYPES,
  TB_STATUSES,
  TrialBalanceError,
  type FiscalPeriodLike,
  type FiscalYearLike,
  type TrialBalanceDataType,
} from "@/lib/trial-balance";
import {
  detectRepeatedHeaderRows,
  extractTbSourceRows,
  flagSuspectedSubtotalRows,
  mapTbHeaders,
  requiredFieldsForShape,
  suggestTbShape,
  TB_CANONICAL_FIELDS,
  type TbCanonicalField,
  type TbGrid,
  type TbGridCell,
  type TbHeaderMappingResult,
  type TbImportShape,
  type TbSourceRow,
  type TbSubtotalFlag,
} from "@/lib/tb-import";
import {
  canonicalJsonStringify,
  normalizeTbSource,
  type TbCompleteness,
  type TbFlowClosingSemantics,
  type TbNormalizationIssue,
  type TbNormalizationRequest,
  type TbNormalizationResult,
  type TbSubtotalResolution,
} from "@/lib/tb-import-normalization";
import { computeTbSourcePayloadHash, sha256Hex } from "@/lib/tb-import-source-hash";
import {
  resolveAccountMapping,
  type MappingOverrideLike,
  type MappingRuleLike,
  type ResolvedAccountMapping,
  type StatementLineLike,
} from "@/lib/account-nature";

/* ── الحدود المحافظة (رفض مبكر قبل أي معالجة مكلفة) ────────────────────────── */

export const TB_IMPORT_SERVER_LIMITS = {
  MAX_ROWS: 5000,
  MAX_COLS: 64,
  MAX_CELL_TEXT: 1000,
  MAX_ERRORS_LISTED: 50,
  MAX_DUPLICATES_LISTED: 20,
  MAX_DIFFS_LISTED: 50,
  MAX_RAW_HEADER_PREVIEW: 80,
  MAX_NOTE: 500,
  MAX_FILE_NAME: 255,
  MAX_FILE_HASH: 128,
  MAX_PROVENANCE_JSON: 8000,
} as const;

export const TB_IMPORT_PROVENANCE_SCHEMA_VERSION = "tb-import-provenance-v1";
export const TB_IMPORT_SERVER_SCHEMA_VERSION = "tb-import-server-v1";

/* ── أنواع الطلب (كل شيء من العميل غير موثوق — يُتحقق بنيويًا حصرًا) ─────────── */

export interface TbImportRawCellInput {
  text?: unknown;
  isNumericSource?: unknown;
  isFormula?: unknown;
  formulaText?: unknown;
}

export interface TbImportServerInput {
  companyId?: unknown;
  fiscalYearId?: unknown;
  fromDate?: unknown;
  toDate?: unknown;
  shape?: unknown;
  /** الشبكة الخام كاملة (الترويسة أول صف) — قيم نصية + أعلام مصدر فقط. */
  grid?: unknown;
  /** إسناد المستخدم الصريح: فهرس عمود (0-based) ⇒ حقل قياني. يُطبَّق خادميًا. */
  mapping?: unknown;
  sourceCurrency?: unknown;
  completeness?: unknown;
  subsetAcknowledged?: unknown;
  flowClosingSemantics?: unknown;
  subtotalResolutions?: unknown;
  originalFileName?: unknown;
  fileHash?: unknown;
  note?: unknown;
  replaceExisting?: unknown;
  /* أي حقول أخرى يرسلها العميل (dataType، classification، totals، hashes…) تُتجاهل
     حتميًا — ليست ضمن هذا النوع ولا يُقرأ أي منها إطلاقًا. */
}

export interface ParsedTbImportInput {
  companyId: string;
  fiscalYearId: string;
  fromDate: string;
  toDate: string;
  shape: TbImportShape;
  grid: TbGrid;
  mapping: Readonly<Record<number, TbCanonicalField>>;
  sourceCurrency: string;
  completeness: TbCompleteness;
  subsetAcknowledged: boolean;
  flowClosingSemantics: TbFlowClosingSemantics | null;
  subtotalResolutions: Readonly<Record<number, TbSubtotalResolution>>;
  originalFileName: string;
  fileHash: string;
  note: string;
  replaceExisting: boolean;
}

export interface TbImportServerIssue {
  code: string;
  message: string;
}

/* ── نتيجة المعاينة الخادمية (عقد للواجهة اللاحقة — كل المبالغ نصوص آمنة JSON) ── */

export interface TbImportServerPreview {
  schemaVersion: string;
  confirmedShape: TbImportShape;
  suggestedShape: { suggestion: TbImportShape; reason: string } | null;
  mapping: {
    byField: Record<string, { index: number; tier: string; rawHeader: string }>;
    unmappedColumns: number[];
    ambiguousColumns: number[];
    duplicateTargetConflicts: Array<{ field: string; sourceColumnIndices: number[]; origin: string }>;
  };
  company: { id: string; code: string; nameAr: string; functionalCurrency: string | null };
  fiscalYear: { id: string; code: string; displayNameAr: string };
  period: { ordinal: number; startDate: string; endDate: string; displayLabel: string };
  sourceCurrency: string | null;
  functionalCurrency: string | null;
  minorUnits: number;
  completeness: TbCompleteness;
  subsetAcknowledged: boolean;
  flowClosingSemantics: TbFlowClosingSemantics | null;
  sourceRowCount: number;
  acceptedDetailRowCount: number;
  excludedSubtotalRowCount: number;
  unresolvedSubtotalRows: number[];
  repeatedHeaderRows: number[];
  duplicateAccounts: Array<{ accountCode: string; count: number; sourceRowNumbers: number[] }>;
  numericSourceCodeCount: number;
  numericSourceCodeRows: number[];
  formulaCellWarningCount: number;
  formulaCellWarningRows: number[];
  classificationSummary: Record<string, number>;
  classificationErrors: Array<{ sourceRowNumber: number; accountCode: string; mappingStatus: string }>;
  controlTotals: Record<string, { debitMinor: string; creditMinor: string; differenceMinor: string }>;
  rowEquationFailureCount: number;
  rowEquationFailures: Array<{ sourceRowNumber: number; accountCode: string; differenceMinor: string }>;
  normalizedConsumedLineCount: number;
  canonicalLineHash: string | null;
  sourcePayloadHash: string | null;
  derivedDataType: TrialBalanceDataType | null;
  blockingErrors: TbImportServerIssue[];
  warnings: TbImportServerIssue[];
  priorAsOfDisclosure: {
    hasPriorData: boolean;
    priorImportId: string | null;
    priorToDate: string | null;
    comparedCount: number;
    differenceCount: number;
    differences: Array<{ accountCode: string; sourceOpeningNetMinor: string; priorNetMinor: string; differenceMinor: string }>;
  } | null;
  validationStatus: "VALID" | "BLOCKED";
  persistenceReady: boolean;
}

/* ── التحقق البنيوي الصارم للطلب (حدود محافظة — رفض مبكر) ──────────────────── */

function asTrimmedString(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function parseCell(raw: TbImportRawCellInput | undefined): TbGridCell {
  if (raw === undefined || raw === null) {
    return { text: "", isNumericSource: false, isFormula: false, formulaText: null };
  }
  let text = "";
  let numeric = false;
  if (typeof raw.text === "string") {
    text = raw.text;
  } else if (typeof raw.text === "number") {
    if (!Number.isFinite(raw.text)) throw new TrialBalanceError("INVALID_LINE", "خلية مصدر رقمية غير منتهية (NaN/Infinity) مرفوضة.");
    text = String(raw.text);
    numeric = true; // المصدر أرسلها رقمًا JSON — إفصاح أمين عن طبيعتها
  } else if (raw.text !== undefined && raw.text !== null && raw.text !== "") {
    throw new TrialBalanceError("INVALID_LINE", "نص الخلية يجب أن يكون نصًا أو رقمًا JSON حصرًا.");
  }
  if (text.length > TB_IMPORT_SERVER_LIMITS.MAX_CELL_TEXT) {
    throw new TrialBalanceError("INVALID_LINE", `نص الخلية يتجاوز الحد (${TB_IMPORT_SERVER_LIMITS.MAX_CELL_TEXT}).`);
  }
  const formulaText = typeof raw.formulaText === "string" ? raw.formulaText.slice(0, TB_IMPORT_SERVER_LIMITS.MAX_CELL_TEXT) : null;
  return {
    text,
    isNumericSource: raw.isNumericSource === true || numeric,
    isFormula: raw.isFormula === true,
    formulaText,
  };
}

export function parseTbImportServerInput(raw: TbImportServerInput): ParsedTbImportInput {
  const companyId = asTrimmedString(raw.companyId, 64);
  if (!companyId) throw new TrialBalanceError("COMPANY_REQUIRED", "الشركة إلزامية للاستيراد.");
  const fiscalYearId = asTrimmedString(raw.fiscalYearId, 64);
  if (!fiscalYearId) throw new TrialBalanceError("FISCAL_YEAR_NOT_FOUND", "السنة المالية إلزامية.");
  const fromDate = asTrimmedString(raw.fromDate, 10);
  const toDate = asTrimmedString(raw.toDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    throw new TrialBalanceError("INVALID_DATE_RANGE", "التواريخ إلزامية بصيغة YYYY-MM-DD.");
  }
  const shapeRaw = asTrimmedString(raw.shape, 20);
  if (
    shapeRaw !== "FULL_MOVEMENT" &&
    shapeRaw !== "CLOSING_ONLY" &&
    shapeRaw !== "MOVEMENT_ONLY"
  ) {
    // LEGACY ليس مسارًا للمستورد الجديد — الإرث يُقرأ عبر مساره التاريخي حصرًا.
    throw new TrialBalanceError("INVALID_DATA_TYPE", "الشكل المؤكد مطلوب: FULL_MOVEMENT أو CLOSING_ONLY أو MOVEMENT_ONLY.");
  }
  if (!Array.isArray(raw.grid)) {
    throw new TrialBalanceError("EMPTY_FILE", "شبكة المصدر الخام مطلوبة.");
  }
  const gridRows = raw.grid as unknown[];
  if (gridRows.length === 0) throw new TrialBalanceError("EMPTY_FILE", "شبكة المصدر فارغة.");
  if (gridRows.length > TB_IMPORT_SERVER_LIMITS.MAX_ROWS) {
    throw new TrialBalanceError("INVALID_LINE", `عدد الصفوف يتجاوز الحد (${TB_IMPORT_SERVER_LIMITS.MAX_ROWS}).`);
  }
  let colCount = -1;
  const grid: TbGrid = gridRows.map((row) => {
    if (!Array.isArray(row)) throw new TrialBalanceError("INVALID_LINE", "كل صف في الشبكة يجب أن يكون مصفوفة خلايا.");
    if (row.length > TB_IMPORT_SERVER_LIMITS.MAX_COLS) {
      throw new TrialBalanceError("INVALID_LINE", `عدد الأعمدة يتجاوز الحد (${TB_IMPORT_SERVER_LIMITS.MAX_COLS}).`);
    }
    if (colCount === -1) colCount = row.length;
    return (row as TbImportRawCellInput[]).map((c) => parseCell(c));
  });

  // الإسناد الصريح: مفاتيح فهارس أعمدة صحيحة داخل النطاق، وقيم حقول قيانية معروفة.
  const mapping: Record<number, TbCanonicalField> = {};
  if (raw.mapping !== undefined && raw.mapping !== null) {
    if (typeof raw.mapping !== "object" || Array.isArray(raw.mapping)) {
      throw new TrialBalanceError("INVALID_LINE", "الإسناد يجب أن يكون كائن «فهرس عمود ⇒ حقل».");
    }
    const width = grid[0]?.length ?? 0;
    for (const [k, v] of Object.entries(raw.mapping as Record<string, unknown>)) {
      const idx = Number(k);
      if (!Number.isInteger(idx) || idx < 0 || idx >= width) {
        throw new TrialBalanceError("INVALID_LINE", `فهرس عمود إسناد غير صالح (${k}).`);
      }
      const rawField = typeof v === "string" ? v : "";
      if (!(TB_CANONICAL_FIELDS as readonly string[]).includes(rawField)) {
        throw new TrialBalanceError("INVALID_LINE", `حقل قياني غير معروف في الإسناد (${v}).`);
      }
      mapping[idx] = rawField as TbCanonicalField;
    }
  }

  const completenessRaw = asTrimmedString(raw.completeness, 10);
  if (completenessRaw !== "COMPLETE" && completenessRaw !== "SUBSET") {
    throw new TrialBalanceError("INVALID_LINE", "الاكتمال إلزامي صريح: COMPLETE أو SUBSET.");
  }
  const sourceCurrency = asTrimmedString(raw.sourceCurrency, 10);
  const flowRaw = asTrimmedString(raw.flowClosingSemantics, 20);
  const flowClosingSemantics = flowRaw === "CUMULATIVE_YTD" ? "CUMULATIVE_YTD" : null;

  const subtotalResolutions: Record<number, TbSubtotalResolution> = {};
  if (raw.subtotalResolutions !== undefined && raw.subtotalResolutions !== null) {
    if (typeof raw.subtotalResolutions !== "object" || Array.isArray(raw.subtotalResolutions)) {
      throw new TrialBalanceError("INVALID_LINE", "حسم المجاميع يجب أن يكون كائن «رقم صف ⇒ KEPT|EXCLUDED».");
    }
    for (const [k, v] of Object.entries(raw.subtotalResolutions as Record<string, unknown>)) {
      const rowNo = Number(k);
      if (!Number.isInteger(rowNo) || rowNo < 1) {
        throw new TrialBalanceError("INVALID_LINE", `رقم صف حسم مجاميع غير صالح (${k}).`);
      }
      if (v !== "KEPT" && v !== "EXCLUDED") {
        throw new TrialBalanceError("INVALID_LINE", `حسم مجاميع غير صالح للصف ${k} (KEPT|EXCLUDED حصرًا).`);
      }
      subtotalResolutions[rowNo] = v;
    }
  }

  return {
    companyId,
    fiscalYearId,
    fromDate,
    toDate,
    shape: shapeRaw,
    grid,
    mapping,
    sourceCurrency,
    completeness: completenessRaw,
    subsetAcknowledged: raw.subsetAcknowledged === true,
    flowClosingSemantics,
    subtotalResolutions,
    originalFileName: asTrimmedString(raw.originalFileName, TB_IMPORT_SERVER_LIMITS.MAX_FILE_NAME),
    fileHash: /^[0-9a-fA-F]{1,128}$/.test(asTrimmedString(raw.fileHash, TB_IMPORT_SERVER_LIMITS.MAX_FILE_HASH))
      ? asTrimmedString(raw.fileHash, TB_IMPORT_SERVER_LIMITS.MAX_FILE_HASH).toLowerCase()
      : "",
    note: asTrimmedString(raw.note, TB_IMPORT_SERVER_LIMITS.MAX_NOTE),
    replaceExisting: raw.replaceExisting === true,
  };
}

/* ── الإسناد الخادمي — عبر mapTbHeaders بطبقة USER الحتمية حصرًا ─────────────── */

function buildServerMapping(
  grid: TbGrid,
  parsed: ParsedTbImportInput,
): TbHeaderMappingResult {
  const headerCells = grid[0] ?? [];
  const headerTexts = headerCells.map((c) => c.text);
  const result = mapTbHeaders(headerTexts, { userMappings: parsed.mapping });
  if (result.duplicateTargetConflicts.length > 0) {
    const detail = result.duplicateTargetConflicts
      .map((c) => `${c.field}: ${c.sourceColumnIndices.join(",")}`)
      .join(" | ");
    throw new TrialBalanceError(
      "INVALID_LINE",
      `إسناد غامض: حقل مسند لأكثر من عمود مصدر (${detail}) — عمود واحد لكل حقل حصرًا.`,
    );
  }
  const required = requiredFieldsForShape(parsed.shape);
  const missing = required.filter((f) => result.byField[f] === undefined);
  if (missing.length > 0) {
    throw new TrialBalanceError(
      "INVALID_LINE",
      `الحقول المطلوبة للشكل ${parsed.shape} غير مسندة بالكامل (${missing.join(", ")}) — الإسناد الصريح إلزامي.`,
    );
  }
  return result;
}

/* ── مدخلات محرك التصنيف المعتمد — من قاعدة البيانات حصرًا ──────────────────── */

interface ClassificationInputs {
  rules: MappingRuleLike[];
  overrides: MappingOverrideLike[];
  lines: StatementLineLike[];
}

async function loadClassificationInputs(
  client: PrismaTx,
  companyId: string,
): Promise<ClassificationInputs> {
  const rules = await client.accountNatureRule.findMany({
    where: { isActive: true, OR: [{ companyId: null }, { companyId }] },
    select: {
      id: true, companyId: true, prefix: true, mainCategory: true,
      classification: true, aggregationBehavior: true,
      statementLine: { select: { code: true } }, source: true, isActive: true,
    },
  });
  const overrides = await client.accountMappingOverride.findMany({
    where: { isActive: true, companyId },
    select: {
      id: true, companyId: true, accountCode: true, classification: true,
      aggregationBehavior: true, statementLine: { select: { code: true } }, isActive: true,
    },
  });
  const linesRef = await client.financialStatementLine.findMany({
    where: { isActive: true },
    select: { code: true, nameAr: true, statementType: true, isActive: true },
  });
  return {
    rules: rules.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      prefix: r.prefix,
      mainCategory: r.mainCategory,
      classification: r.classification,
      aggregationBehavior: r.aggregationBehavior,
      statementLineCode: r.statementLine?.code ?? null,
      source: r.source,
      isActive: r.isActive,
    })),
    overrides: overrides.map((o) => ({
      id: o.id,
      companyId: o.companyId,
      accountCode: o.accountCode,
      classification: o.classification,
      aggregationBehavior: o.aggregationBehavior,
      statementLineCode: o.statementLine?.code ?? null,
      isActive: o.isActive,
    })),
    lines: linesRef,
  };
}

/* ── أنواع داخلية ──────────────────────────────────────────────────────────── */

type PrismaTx = Prisma.TransactionClient | PrismaClient;

export interface OrchestratedTbImport {
  parsed: ParsedTbImportInput;
  company: { id: string; code: string; nameAr: string; functionalCurrency: string | null };
  fiscalYear: FiscalYearLike;
  period: FiscalPeriodLike;
  minorUnits: number;
  mapping: TbHeaderMappingResult;
  rows: TbSourceRow[];
  repeatedHeaderRowNumbers: number[];
  subtotalFlags: TbSubtotalFlag[];
  normalization: TbNormalizationResult;
  normalizeRequest: TbNormalizationRequest;
  classificationInputs: ClassificationInputs;
  consumedSnapshots: Array<{ candidateRowNumber: number } & ResolvedAccountMapping>;
  derivedDataType: TrialBalanceDataType | null;
  canonicalLineHash: string;
  sourcePayloadHash: string;
  serverIssues: TbImportServerIssue[];
}

const FUNC_CURRENCY_UNCONFIGURED = "FUNCTIONAL_CURRENCY_UNCONFIGURED";
const FX_REQUIRED = "FOREIGN_CURRENCY_TB_REQUIRES_FX_PROCESS";
const SOURCE_CURRENCY_REQUIRED = "SOURCE_CURRENCY_REQUIRED";

/**
 * المسار الحتمي الموحّد — المعاينة والحفظ يمرّان هنا حصرًا.
 * كل قيمة محاسبية تُشتق خادميًا من المصدر الخام عبر Step-1/Step-2.
 */
export async function orchestrateTbImport(
  user: SessionUser,
  parsed: ParsedTbImportInput,
): Promise<OrchestratedTbImport> {
  const issues: TbImportServerIssue[] = [];

  // 1) الشركة + نطاق الوصول (fail-closed — لا ثقة بمعرّف الشركة من مستخدم غير مخوّل)
  if (!companyVisible(user, parsed.companyId)) {
    throw new TrialBalanceError("NOT_FOUND", "لا تملك الوصول لهذه الشركة.");
  }
  const companyRow = await db.company.findUnique({
    where: { id: parsed.companyId },
    select: { id: true, code: true, nameAr: true, functionalCurrency: true },
  });
  if (!companyRow) throw new TrialBalanceError("NOT_FOUND", "الشركة غير موجودة.");

  // 2) السنة المالية + الفترة — إعادة استخدام السياق المالي القائم (محاذاة فترات صارمة)
  const fyRow = await db.fiscalYear.findUnique({
    where: { id: parsed.fiscalYearId },
    select: { id: true, companyId: true, code: true, displayNameAr: true, startDate: true, endDate: true, status: true },
  });
  if (!fyRow || fyRow.companyId !== parsed.companyId) {
    throw new TrialBalanceError("FISCAL_YEAR_NOT_FOUND", "السنة المالية غير موجودة لهذه الشركة.");
  }
  const periodRows = await db.fiscalPeriod.findMany({
    where: { fiscalYearId: parsed.fiscalYearId },
    orderBy: { ordinal: "asc" },
    select: { id: true, ordinal: true, startDate: true, endDate: true, status: true, displayLabel: true },
  });
  if (periodRows.length === 0) {
    throw new TrialBalanceError("FISCAL_YEAR_NOT_FOUND", "السنة المالية بلا فترات معرفة.");
  }
  const fiscalYear: FiscalYearLike = fyRow;
  const ctx = resolveFiscalContext(fiscalYear, periodRows, parsed.fromDate, parsed.toDate);
  // المستورد الجديد: فترة واحدة حصرًا (عقد Step-2 — لا نطاق متعدد الفترات)
  if (ctx.startPeriod.ordinal !== ctx.endPeriod.ordinal) {
    issues.push({
      code: "MULTI_PERIOD_UNSUPPORTED",
      message: `المستورد الجديد يدعم فترة واحدة حصرًا (المدى يغطي الفترات ${ctx.startPeriod.ordinal}..${ctx.endPeriod.ordinal}).`,
    });
  }

  // 3) العملة — تهيئة صريحة + سجل عملات صالح + بلا أي تحويل
  const functionalCurrency = typeof companyRow.functionalCurrency === "string" ? companyRow.functionalCurrency.trim() : "";
  if (functionalCurrency === "" || !isSupportedCurrency(functionalCurrency)) {
    issues.push({
      code: FUNC_CURRENCY_UNCONFIGURED,
      message: "العملة الوظيفية للشركة غير مهيأة أو غير مسجلة في سجل العملات — لا متابعة بلا تهيئة صريحة.",
    });
  }
  const sourceCurrency = parsed.sourceCurrency;
  if (sourceCurrency === "") {
    issues.push({ code: SOURCE_CURRENCY_REQUIRED, message: "عملة المصدر إلزامية صراحةً — لا افتراض." });
  } else if (functionalCurrency !== "" && sourceCurrency !== functionalCurrency) {
    issues.push({
      code: FX_REQUIRED,
      message: `عملة المصدر (${sourceCurrency}) تخالف العملة الوظيفية (${functionalCurrency}) — يتطلب عملية FX صريحة خارج هذه الخطوة؛ لا تحويل ولا سعر صرف هنا.`,
    });
  }
  const minorUnits =
    functionalCurrency !== "" && isSupportedCurrency(functionalCurrency)
      ? CURRENCIES[functionalCurrency].minorUnits
      : 0; // صفر ⇒ غير صالح للدقة — يُرفض لاحقًا بلا رجوع لافتراضي ضمني

  // 4) الإسناد الخادمي + بناء الصفوف + المكتشفات الحتمية
  const mapping = buildServerMapping(parsed.grid, parsed);
  const rows = extractTbSourceRows(parsed.grid, { mapping, headerRowIndex: 0, headerRowCount: 1 });
  const repeatedHeader = detectRepeatedHeaderRows(parsed.grid, 0, 1);
  const repeatedHeaderRowNumbers = [...repeatedHeader.repeatedRowNumbers];
  const subtotalFlags = flagSuspectedSubtotalRows(rows);
  const unresolvedSubtotalRows = subtotalFlags
    .filter((f) => parsed.subtotalResolutions[f.sourceRowNumber] === undefined)
    .map((f) => f.sourceRowNumber);

  // 5) مدخلات محرك التصنيف المعتمد (قواعد الشركة + النظام من القاعدة)
  const classificationInputs = await loadClassificationInputs(db, parsed.companyId);

  // 6) التطبيع النقي (Step-2) — المصدر الوحيد لكل حكم محاسبي
  const normalizeRequest: TbNormalizationRequest = {
    shape: parsed.shape,
    shapeSource: "USER_CONFIRMED",
    rows,
    mapping,
    repeatedHeaderRowNumbers,
    subtotalFlags,
    subtotalResolutions: parsed.subtotalResolutions,
    periodStartOrdinal: ctx.startPeriod.ordinal,
    periodEndOrdinal: ctx.endPeriod.ordinal,
    sourceCurrency: sourceCurrency === "" ? undefined : sourceCurrency,
    functionalCurrency: functionalCurrency === "" ? null : functionalCurrency,
    // minorUnits=0 (عملة غير مهيأة/غير مسجلة) ⇒ يُرفض داخل التطبيع (INVALID_CURRENCY_PRECISION) — لا افتراضي ضمني
    minorUnits,
    completeness: parsed.completeness,
    subsetAcknowledged: parsed.subsetAcknowledged,
    flowClosingSemantics: parsed.flowClosingSemantics,
    classificationRules: classificationInputs.rules,
    classificationOverrides: classificationInputs.overrides,
    classificationStatementLines: classificationInputs.lines,
    classificationCompanyId: parsed.companyId,
  };
  // minorUnits غير صالح (عملة غير مهيأة) ⇒ دقة 0 تُرفض داخل التطبيع (INVALID_CURRENCY_PRECISION)
  const normalization = normalizeTbSource(normalizeRequest);

  // 7) dataType المشتق خادميًا حصرًا (عقد Step-2 ⇒ تمثيل التخزين القائم)
  const derivedDataType = deriveImportDataType(parsed.shape, normalization);

  // 8) الهاشتان — من قواعد Step-2 حصرًا (المصدر الخام + السطور المستهلكة)
  const sourcePayloadHash = computeTbSourcePayloadHash(normalizeRequest);
  const canonicalLineHash = computeCanonicalLineHash(parsed.shape, derivedDataType, minorUnits, normalization);

  // 9) لقطات التصنيف الكاملة للسطور المستهلكة (نفس المحرك + نفس المدخلات حصرًا)
  const consumedSnapshots: Array<{ candidateRowNumber: number } & ResolvedAccountMapping> = [];
  for (const candidate of normalization.draftLineCandidates) {
    const resolved = resolveAccountMapping({
      accountCode: candidate.accountCode,
      rules: classificationInputs.rules,
      overrides: classificationInputs.overrides,
      lines: classificationInputs.lines,
      companyId: parsed.companyId,
    });
    const step2 = normalization.classificationResults.find(
      (c) => c.sourceRowNumber === candidate.sourceRowNumber,
    );
    if (
      step2 === undefined ||
      step2.classification !== resolved.classification ||
      step2.aggregationBehavior !== resolved.aggregationBehavior ||
      step2.mappingStatus !== resolved.mappingStatus ||
      step2.matchedPrefix !== resolved.matchedPrefix
    ) {
      throw new TrialBalanceError(
        "INVALID_STATE",
        `تعارض داخلي في التصنيف للصف ${candidate.sourceRowNumber} — المحرك الحتمي أعاد نتيجتين مختلفتين.`,
      );
    }
    consumedSnapshots.push({ candidateRowNumber: candidate.sourceRowNumber, ...resolved });
  }

  return {
    parsed,
    company: companyRow,
    fiscalYear,
    period: {
      id: ctx.startPeriod.id,
      ordinal: ctx.startPeriod.ordinal,
      startDate: ctx.startPeriod.startDate,
      endDate: ctx.startPeriod.endDate,
      status: ctx.startPeriod.status,
      displayLabel: ctx.startPeriod.displayLabel,
    },
    minorUnits,
    mapping,
    rows,
    repeatedHeaderRowNumbers,
    subtotalFlags,
    normalization,
    normalizeRequest,
    classificationInputs,
    consumedSnapshots,
    derivedDataType,
    canonicalLineHash,
    sourcePayloadHash,
    serverIssues: issues,
  };
}

/**
 * اشتقاق dataType للتخزين خادميًا حصرًا (لا قبول من العميل إطلاقًا):
 *   FULL_MOVEMENT  ⇒ PERIOD_MOVEMENT
 *   MOVEMENT_ONLY  ⇒ PERIOD_MOVEMENT
 *   CLOSING_ONLY   ⇒ FLOW مصرَّح تراكمي أو BALANCE حصرًا ⇒ CUMULATIVE_YTD
 *                    (التمثيل القائم المعتمد للأرصدة as-of)
 *   غير محسوم      ⇒ null (لا إصرار)
 */
export function deriveImportDataType(
  shape: TbImportShape,
  normalization: TbNormalizationResult,
): TrialBalanceDataType | null {
  if (shape === "FULL_MOVEMENT" || shape === "MOVEMENT_ONLY") {
    return normalization.dataTypeCandidate === "PERIOD_MOVEMENT" ? TB_DATA_TYPES.PERIOD_MOVEMENT : null;
  }
  if (shape === "CLOSING_ONLY") {
    // BALANCE_AS_OF (أو CUMULATIVE_YTD مصرَّح) ⇒ التمثيل القائم للأرصدة لحظة الزمن
    return normalization.dataTypeCandidate === "BALANCE_AS_OF" || normalization.dataTypeCandidate === "CUMULATIVE_YTD"
      ? TB_DATA_TYPES.CUMULATIVE_YTD
      : null;
  }
  return null;
}

/** هاش السطور المستهلكة — نفس قواعد Step-2 (JSON قياني بمفاتيح مرتبة، مبالغ نصية). */
export function computeCanonicalLineHash(
  shape: TbImportShape,
  derivedDataType: TrialBalanceDataType | null,
  minorUnits: number,
  normalization: TbNormalizationResult,
): string {
  const payload = {
    schemaVersion: "tb-import-canonical-lines-v1",
    shape,
    derivedDataType,
    minorUnits,
    lines: normalization.draftLineCandidates.map((l) => ({
      sourceRowNumber: l.sourceRowNumber,
      accountCode: l.accountCode,
      accountCodeIsNumericSource: l.accountCodeIsNumericSource,
      accountName: l.accountName,
      debitMinor: l.debitMinor.toString(),
      creditMinor: l.creditMinor.toString(),
      netMinor: l.netMinor.toString(),
      rowSemantics: l.rowSemantics,
      classification: l.classification,
      aggregationBehavior: l.aggregationBehavior,
      classificationSource: l.classificationSource,
      mappingStatus: l.mappingStatus,
      matchedPrefix: l.matchedPrefix,
    })),
  };
  return sha256Hex(canonicalJsonStringify(payload));
}

/* ── المقارنة مع معتمد سابق as-of (FULL_MOVEMENT BALANCE حصرًا — إفصاح معاينة فقط) ── */

async function computePriorAsOfDisclosure(
  orchestrated: OrchestratedTbImport,
): Promise<OrchestratedTbImport["normalization"] extends never ? never : NonNullable<TbImportServerPreview["priorAsOfDisclosure"]> | null> {
  if (orchestrated.parsed.shape !== "FULL_MOVEMENT") return null;
  const balanceRowNumbers = new Set(
    orchestrated.normalization.draftLineCandidates
      .filter((c) => c.aggregationBehavior === "BALANCE")
      .map((c) => c.sourceRowNumber),
  );
  if (balanceRowNumbers.size === 0) return null;
  const priorOrdinal = orchestrated.period.ordinal - 1;
  if (priorOrdinal < 1) {
    return { hasPriorData: false, priorImportId: null, priorToDate: null, comparedCount: 0, differenceCount: 0, differences: [] };
  }
  const prior = await db.trialBalanceImport.findFirst({
    where: {
      companyId: orchestrated.parsed.companyId,
      fiscalYearId: orchestrated.parsed.fiscalYearId,
      status: TB_STATUSES.COMMITTED,
      dataType: TB_DATA_TYPES.CUMULATIVE_YTD,
      endOrdinal: priorOrdinal,
    },
    orderBy: { revisionNumber: "desc" },
    select: { id: true, toDate: true },
  });
  const disclosure = {
    hasPriorData: prior !== null,
    priorImportId: prior?.id ?? null,
    priorToDate: prior?.toDate ?? null,
    comparedCount: 0,
    differenceCount: 0,
    differences: [] as Array<{ accountCode: string; sourceOpeningNetMinor: string; priorNetMinor: string; differenceMinor: string }>,
  };
  if (!prior) return disclosure;
  const priorLines = await db.trialBalanceLine.findMany({
    where: { importId: prior.id },
    select: { accountCode: true, netMinor: true },
  });
  const priorNetByCode = new Map<string, bigint>();
  for (const line of priorLines) {
    priorNetByCode.set(line.accountCode, line.netMinor);
  }
  for (const accepted of orchestrated.normalization.acceptedRows) {
    if (!balanceRowNumbers.has(accepted.sourceRowNumber)) continue;
    const od = accepted.parsedMonetary.OPENING_DEBIT;
    const oc = accepted.parsedMonetary.OPENING_CREDIT;
    if (od === undefined || oc === undefined) continue;
    const sourceOpeningNet = od - oc;
    const priorNet = priorNetByCode.get(accepted.accountCode);
    if (priorNet === undefined) continue; // «لا بيانات سابقة لهذا الحساب» — لا فرض ولا صمت عدّ
    disclosure.comparedCount += 1;
    const diff = sourceOpeningNet - priorNet;
    if (diff !== BigInt(0)) {
      disclosure.differenceCount += 1;
      if (disclosure.differences.length < TB_IMPORT_SERVER_LIMITS.MAX_DIFFS_LISTED) {
        disclosure.differences.push({
          accountCode: accepted.accountCode,
          sourceOpeningNetMinor: sourceOpeningNet.toString(),
          priorNetMinor: priorNet.toString(),
          differenceMinor: diff.toString(),
        });
      }
    }
  }
  return disclosure;
}

/* ── تجميع نتيجة المعاينة (قراءة صرفة — لا كتابة إطلاقًا) ──────────────────── */

function capIssues(list: TbImportServerIssue[]): TbImportServerIssue[] {
  return list.slice(0, TB_IMPORT_SERVER_LIMITS.MAX_ERRORS_LISTED);
}

function issuesOf(normalization: TbNormalizationResult): TbImportServerIssue[] {
  return normalization.errors.map((e: TbNormalizationIssue) => ({ code: e.code, message: e.message }));
}

export async function previewTbImport(
  user: SessionUser,
  rawInput: TbImportServerInput,
): Promise<TbImportServerPreview> {
  const parsed = parseTbImportServerInput(rawInput);
  const orchestrated = await orchestrateTbImport(user, parsed);
  const { normalization } = orchestrated;

  const blockingErrors = capIssues([...orchestrated.serverIssues, ...issuesOf(normalization)]);
  const warnings: TbImportServerIssue[] = normalization.warnings.map((w) => ({ code: w.code, message: w.message }));

  // إفصاحات أكواد الحساب الرقمية وخلَايا الصيغ (من المصدر حصرًا)
  const numericSourceRows = orchestrated.rows
    .filter((r) => r.accountCodeIsNumericSource)
    .map((r) => r.sourceRowNumber);
  const formulaRows = new Set<number>();
  for (const row of orchestrated.rows) {
    for (const field of Object.values(row.monetary)) {
      if (field?.isFormula) {
        formulaRows.add(row.sourceRowNumber);
        break;
      }
    }
  }
  warnings.push({
    code: "NUMERIC_SOURCE_ACCOUNT_CODES",
    message: `${numericSourceRows.length} صفًا مصدره كود حساب رقمي (احتمال فقد الأصفار الرائدة) — الأكواد تُحفظ كما وردت نصيًا.`,
  });
  if (formulaRows.size > 0) {
    warnings.push({
      code: "FORMULA_CELLS_PRESENT",
      message: `${formulaRows.size} صفًا يحتوي خلايا صيغ — الصيغ لا تُنفَّذ أبدًا، القيمة المخزنة النصية هي الحاكمة.`,
    });
  }

  const classificationSummary: Record<string, number> = {
    ASSET: 0, LIABILITY: 0, EQUITY: 0, EXPENSE: 0, REVENUE: 0, unresolved: 0,
  };
  for (const c of normalization.classificationResults) {
    if (!c.resolved || c.classification === null) classificationSummary.unresolved += 1;
    else classificationSummary[c.classification] = (classificationSummary[c.classification] ?? 0) + 1;
  }

  const controlTotals: TbImportServerPreview["controlTotals"] = {};
  if (normalization.controlTotals !== null) {
    for (const group of ["opening", "period", "closing"] as const) {
      const t = normalization.controlTotals[group];
      if (t === undefined) continue;
      controlTotals[group] = {
        debitMinor: t.debitMinor.toString(),
        creditMinor: t.creditMinor.toString(),
        differenceMinor: t.differenceMinor.toString(),
      };
    }
  }

  const equationFailures = normalization.rowEquationResults.filter((e) => !e.passes);

  const validationStatus: "VALID" | "BLOCKED" = blockingErrors.length === 0 && normalization.status === "VALID"
    ? "VALID"
    : "BLOCKED";

  const byFieldPreview: Record<string, { index: number; tier: string; rawHeader: string }> = {};
  for (const [field, index] of Object.entries(orchestrated.mapping.byField)) {
    const col = orchestrated.mapping.columns.find((c) => c.sourceColumnIndex === index);
    byFieldPreview[field] = {
      index,
      tier: col?.tier ?? "USER",
      rawHeader: (col?.rawHeader ?? "").slice(0, TB_IMPORT_SERVER_LIMITS.MAX_RAW_HEADER_PREVIEW),
    };
  }

  const priorAsOfDisclosure = await computePriorAsOfDisclosure(orchestrated);

  return {
    schemaVersion: TB_IMPORT_SERVER_SCHEMA_VERSION,
    confirmedShape: orchestrated.parsed.shape,
    suggestedShape: suggestTbShape(orchestrated.mapping).suggestion !== null
      ? (suggestTbShape(orchestrated.mapping) as { suggestion: TbImportShape; reason: string })
      : null,
    mapping: {
      byField: byFieldPreview,
      unmappedColumns: orchestrated.mapping.unmappedColumns.map((c) => c.sourceColumnIndex),
      ambiguousColumns: orchestrated.mapping.ambiguousColumns.map((c) => c.sourceColumnIndex),
      duplicateTargetConflicts: orchestrated.mapping.duplicateTargetConflicts.map((c) => ({
        field: c.field,
        sourceColumnIndices: [...c.sourceColumnIndices],
        origin: c.origin,
      })),
    },
    company: orchestrated.company,
    fiscalYear: {
      id: orchestrated.fiscalYear.id,
      code: orchestrated.fiscalYear.code,
      displayNameAr: orchestrated.fiscalYear.displayNameAr,
    },
    period: {
      ordinal: orchestrated.period.ordinal,
      startDate: orchestrated.period.startDate,
      endDate: orchestrated.period.endDate,
      displayLabel: orchestrated.period.displayLabel,
    },
    sourceCurrency: orchestrated.parsed.sourceCurrency === "" ? null : orchestrated.parsed.sourceCurrency,
    functionalCurrency: orchestrated.company.functionalCurrency,
    minorUnits: orchestrated.minorUnits,
    completeness: orchestrated.parsed.completeness,
    subsetAcknowledged: orchestrated.parsed.subsetAcknowledged,
    flowClosingSemantics: orchestrated.parsed.flowClosingSemantics,
    sourceRowCount: orchestrated.rows.length,
    acceptedDetailRowCount: normalization.acceptedRows.length,
    excludedSubtotalRowCount: normalization.subtotalExclusions.length,
    unresolvedSubtotalRows: orchestrated.subtotalFlags
      .filter((f) => orchestrated.parsed.subtotalResolutions[f.sourceRowNumber] === undefined)
      .map((f) => f.sourceRowNumber),
    repeatedHeaderRows: orchestrated.repeatedHeaderRowNumbers,
    duplicateAccounts: normalization.duplicateResults.duplicates
      .slice(0, TB_IMPORT_SERVER_LIMITS.MAX_DUPLICATES_LISTED)
      .map((d) => ({ accountCode: d.accountCode, count: d.count, sourceRowNumbers: [...d.sourceRowNumbers] })),
    numericSourceCodeCount: numericSourceRows.length,
    numericSourceCodeRows: numericSourceRows.slice(0, TB_IMPORT_SERVER_LIMITS.MAX_ERRORS_LISTED),
    formulaCellWarningCount: formulaRows.size,
    formulaCellWarningRows: [...formulaRows].slice(0, TB_IMPORT_SERVER_LIMITS.MAX_ERRORS_LISTED).sort((a, b) => a - b),
    classificationSummary,
    classificationErrors: normalization.classificationResults
      .filter((c) => !c.resolved)
      .slice(0, TB_IMPORT_SERVER_LIMITS.MAX_ERRORS_LISTED)
      .map((c) => ({ sourceRowNumber: c.sourceRowNumber, accountCode: c.accountCode, mappingStatus: c.mappingStatus })),
    controlTotals,
    rowEquationFailureCount: equationFailures.length,
    rowEquationFailures: equationFailures
      .slice(0, TB_IMPORT_SERVER_LIMITS.MAX_ERRORS_LISTED)
      .map((e) => ({
        sourceRowNumber: e.sourceRowNumber,
        accountCode: e.accountCode,
        differenceMinor: e.differenceMinor.toString(),
      })),
    normalizedConsumedLineCount: normalization.draftLineCandidates.length,
    canonicalLineHash: blockingErrors.length === 0 && normalization.status === "VALID" ? orchestrated.canonicalLineHash : null,
    sourcePayloadHash: blockingErrors.length === 0 && normalization.status === "VALID" ? orchestrated.sourcePayloadHash : null,
    derivedDataType: orchestrated.derivedDataType,
    blockingErrors,
    warnings: capIssues(warnings),
    priorAsOfDisclosure,
    validationStatus,
    persistenceReady: validationStatus === "VALID",
  };
}

/* ── الإثبات الموجود المحدود الحدود (AuditLog metadata) ────────────────────── */

export function buildTbImportProvenanceMetadata(
  orchestrated: OrchestratedTbImport,
  importId: string,
  revisionNumber: number,
): Record<string, unknown> {
  const { normalization, parsed } = orchestrated;
  const excludedRows = Object.entries(parsed.subtotalResolutions)
    .filter(([, v]) => v === "EXCLUDED")
    .map(([k]) => Number(k))
    .sort((a, b) => a - b)
    .slice(0, TB_IMPORT_SERVER_LIMITS.MAX_ERRORS_LISTED);
  const keptCount = Object.values(parsed.subtotalResolutions).filter((v) => v === "KEPT").length;

  const byField: Record<string, { index: number; tier: string; rawHeader: string }> = {};
  for (const [field, index] of Object.entries(orchestrated.mapping.byField)) {
    const col = orchestrated.mapping.columns.find((c) => c.sourceColumnIndex === index);
    byField[field] = {
      index,
      tier: col?.tier ?? "USER",
      rawHeader: (col?.rawHeader ?? "").slice(0, TB_IMPORT_SERVER_LIMITS.MAX_RAW_HEADER_PREVIEW),
    };
  }

  const classificationSummary: Record<string, number> = {
    ASSET: 0, LIABILITY: 0, EQUITY: 0, EXPENSE: 0, REVENUE: 0, unresolved: 0,
  };
  for (const c of normalization.classificationResults) {
    if (!c.resolved || c.classification === null) classificationSummary.unresolved += 1;
    else classificationSummary[c.classification] = (classificationSummary[c.classification] ?? 0) + 1;
  }

  const ct = normalization.controlTotals ?? {};
  const s = (v: bigint | undefined): string => (v === undefined ? "0" : v.toString());

  return {
    schemaVersion: TB_IMPORT_PROVENANCE_SCHEMA_VERSION,
    importId,
    companyId: parsed.companyId,
    companyCode: orchestrated.company.code,
    fiscalYearId: parsed.fiscalYearId,
    fiscalYearCode: orchestrated.fiscalYear.code,
    fromDate: ctxStart(orchestrated),
    toDate: ctxEnd(orchestrated),
    startOrdinal: orchestrated.period.ordinal,
    endOrdinal: orchestrated.period.ordinal,
    shape: parsed.shape,
    completeness: parsed.completeness,
    subsetAcknowledged: parsed.subsetAcknowledged,
    flowClosingSemantics: parsed.flowClosingSemantics,
    sourceCurrency: parsed.sourceCurrency,
    functionalCurrency: orchestrated.company.functionalCurrency,
    minorUnits: orchestrated.minorUnits,
    derivedDataType: orchestrated.derivedDataType,
    mappingSummary: {
      source: "USER_EXPLICIT",
      byField,
      unmappedCount: orchestrated.mapping.unmappedColumns.length,
      ambiguousCount: orchestrated.mapping.ambiguousColumns.length,
    },
    sourceRowCount: orchestrated.rows.length,
    acceptedDetailRowCount: normalization.acceptedRows.length,
    excludedSubtotalRowCount: normalization.subtotalExclusions.length,
    subtotalResolutionSummary: {
      excludedRows,
      keptCount,
      unresolvedCount: orchestrated.subtotalFlags.filter(
        (f) => parsed.subtotalResolutions[f.sourceRowNumber] === undefined,
      ).length,
    },
    duplicateSummary: {
      duplicateAccountCount: normalization.duplicateResults.duplicates.length,
      codes: normalization.duplicateResults.duplicates
        .slice(0, TB_IMPORT_SERVER_LIMITS.MAX_DUPLICATES_LISTED)
        .map((d) => d.accountCode),
    },
    numericAccountCodeCount: orchestrated.rows.filter((r) => r.accountCodeIsNumericSource).length,
    formulaCellWarningCount: orchestrated.rows.filter((r) =>
      Object.values(r.monetary).some((c) => c?.isFormula),
    ).length,
    sourceControlTotals: {
      openingDebit: s(ct.opening?.debitMinor),
      openingCredit: s(ct.opening?.creditMinor),
      periodDebit: s(ct.period?.debitMinor),
      periodCredit: s(ct.period?.creditMinor),
      closingDebit: s(ct.closing?.debitMinor),
      closingCredit: s(ct.closing?.creditMinor),
    },
    equationSummary: {
      checked: normalization.rowEquationResults.length,
      failures: normalization.rowEquationResults.filter((e) => !e.passes).length,
    },
    classificationSummary,
    canonicalLineHash: orchestrated.canonicalLineHash,
    sourcePayloadHash: orchestrated.sourcePayloadHash,
    fileHash: parsed.fileHash === "" ? undefined : parsed.fileHash,
    validationStatus: "VALID",
    revisionNumber,
    status: TB_STATUSES.DRAFT,
  };
}

function ctxStart(o: OrchestratedTbImport): string {
  return o.period.startDate;
}
function ctxEnd(o: OrchestratedTbImport): string {
  return o.period.endDate;
}

/** ضابط الحد: الإثبات موجز حصرًا — إسقاط حتمي متدرج (موجزات اختيارية ⇒ تفاصيل الإسناد) ثم رفض صريح. */
export function enforceProvenanceBound(metadata: Record<string, unknown>): Record<string, unknown> {
  const over = (m: Record<string, unknown>): boolean =>
    JSON.stringify(m).length > TB_IMPORT_SERVER_LIMITS.MAX_PROVENANCE_JSON;
  if (!over(metadata)) return metadata;
  // المرحلة 1: إسقاط الموجزات الاختيارية (تصنيف/تكرار/مجاميع)
  const trimmed: Record<string, unknown> = { ...metadata };
  delete trimmed.classificationSummary;
  delete trimmed.duplicateSummary;
  delete trimmed.subtotalResolutionSummary;
  if (!over(trimmed)) return trimmed;
  // المرحلة 2: إسقاط تفاصيل الإسناد (يبقى المصدر والعدّادات + الهاشتان)
  const mappingSummary = trimmed.mappingSummary as Record<string, unknown> | undefined;
  if (mappingSummary !== undefined && typeof mappingSummary === "object") {
    trimmed.mappingSummary = {
      source: mappingSummary.source,
      unmappedCount: mappingSummary.unmappedCount,
      ambiguousCount: mappingSummary.ambiguousCount,
      byFieldHash: sha256Hex(JSON.stringify(mappingSummary.byField ?? {})),
    };
  }
  if (!over(trimmed)) return trimmed;
  throw new TrialBalanceError(
    "INVALID_STATE",
    `الإثبات الموجز يتجاوز الحد الأقصى (${TB_IMPORT_SERVER_LIMITS.MAX_PROVENANCE_JSON}) حتى بعد الإسقاط الحتمي — مرفوض.`,
  );
}

/* ── حفظ المسودة — نفس المسار الحتمي + حوكمة السلسلة القائمة حصرًا ──────────── */

export interface TbImportDraftSaveResult {
  importId: string;
  status: string;
  dataType: TrialBalanceDataType;
  revisionNumber: number;
  lineCount: number;
  totalDebitMinor: string;
  totalCreditMinor: string;
  canonicalLineHash: string;
  sourcePayloadHash: string;
  provenance: Record<string, unknown>;
  replacedImportId: string | null;
}

export async function saveTbImportDraft(
  user: SessionUser,
  ip: string | null,
  rawInput: TbImportServerInput,
): Promise<TbImportDraftSaveResult> {
  // 1) إعادة البناء الحتمي الكامل من المصدر الخام — لا شيء من العميل يُوثق
  const parsed = parseTbImportServerInput(rawInput);
  const orchestrated = await orchestrateTbImport(user, parsed);
  const { normalization } = orchestrated;

  // 2) أي فشل تحقق (خادمي أو محاسبي) ⇒ لا إصرار إطلاقًا
  const blockingErrors = [...orchestrated.serverIssues, ...issuesOf(normalization)];
  if (blockingErrors.length > 0 || normalization.status !== "VALID" || orchestrated.derivedDataType === null) {
    const summary = capIssues(blockingErrors)
      .map((e) => `[${e.code}] ${e.message}`)
      .join(" | ")
      .slice(0, 2000);
    throw new TrialBalanceError("INVALID_LINE", `فشل التحقق — لا حفظ (${blockingErrors.length} خطأً مانعًا): ${summary}`, {
      errors: capIssues(blockingErrors),
    });
  }
  const derivedDataType = orchestrated.derivedDataType;

  // 3) حوكمة السلسلة القائمة حصرًا (نفس سياسة 6.3): المعتمد لا يُستبدل؛
  //    مسودة المراجعة (revisionNumber>1) تُدار بمسار المراجعة القانوني حصرًا.
  const chainLatest = await db.trialBalanceImport.findFirst({
    where: {
      companyId: parsed.companyId,
      fiscalYearId: parsed.fiscalYearId,
      fromDate: orchestrated.period.startDate,
      toDate: orchestrated.period.endDate,
      dataType: derivedDataType,
    },
    orderBy: { revisionNumber: "desc" },
    select: { id: true, status: true, revisionNumber: true },
  });
  if (chainLatest && chainLatest.status === TB_STATUSES.COMMITTED) {
    throw new TrialBalanceError(
      "DUPLICATE_COMMITTED",
      "يوجد ميزان معتمد لنفس الشركة/السنة/المدى/النوع — لا استبدال للمعتمد؛ استخدم مسار المراجعة (Revision) القائم حصرًا.",
    );
  }
  if (chainLatest && chainLatest.revisionNumber > 1) {
    throw new TrialBalanceError(
      "INVALID_STATE",
      "أحدث نسخة في السلسلة مسودة مراجعة (revisionNumber>1) — تُدار بمسار المراجعة القائم حصرًا، لا بمستورد V1.",
    );
  }
  const existing = chainLatest ? { id: chainLatest.id, revisionNumber: chainLatest.revisionNumber } : null;
  if (existing && !parsed.replaceExisting) {
    throw new TrialBalanceError(
      "DUPLICATE_IMPORT",
      "يوجد استيراد قائم لنفس الشركة/السنة/المدى/النوع — فعّل «الاستبدال» صراحةً ليُحذف القديم (مسودة) ويُسجل ذلك.",
    );
  }

  const lines = normalization.draftLineCandidates;
  const snapshotByRow = new Map(orchestrated.consumedSnapshots.map((s) => [s.candidateRowNumber, s]));
  const totalDebit = lines.reduce((acc, l) => acc + l.debitMinor, BigInt(0));
  const totalCredit = lines.reduce((acc, l) => acc + l.creditMinor, BigInt(0));

  // 4) الإصرار الذري + الإثبات الموجود (نفس tx)
  const created = await db.$transaction(async (tx) => {
    if (existing) {
      await tx.trialBalanceImport.delete({ where: { id: existing.id } }); // Cascade للسطور
    }
    const row = await tx.trialBalanceImport.create({
      data: {
        companyId: parsed.companyId,
        fiscalYearId: parsed.fiscalYearId,
        fromDate: orchestrated.period.startDate,
        toDate: orchestrated.period.endDate,
        startOrdinal: orchestrated.period.ordinal,
        endOrdinal: orchestrated.period.ordinal,
        dataType: derivedDataType,
        status: TB_STATUSES.DRAFT, // تحقق كامل VALID — أزواج التخزين المختلطة لا تلزم توازن الإجمالي
        revisionNumber: 1,
        supersedesImportId: null,
        revisionReason: "",
        originalFileName: parsed.originalFileName,
        fileHash: parsed.fileHash,
        payloadHash: orchestrated.canonicalLineHash, // هاش السطور القياني (قواعد Step-2)
        totalDebitMinor: totalDebit,
        totalCreditMinor: totalCredit,
        lineCount: lines.length,
        note: parsed.note,
        createdById: user.id,
        createdByName: user.username,
        updatedById: user.id,
        updatedByName: user.username,
      },
      select: { id: true, revisionNumber: true },
    });
    await tx.trialBalanceLine.createMany({
      data: lines.map((l) => {
        const snap = snapshotByRow.get(l.sourceRowNumber);
        return {
          importId: row.id,
          rowIndex: l.sourceRowNumber,
          accountCode: l.accountCode,
          accountName: l.accountName,
          debitMinor: l.debitMinor,
          creditMinor: l.creditMinor,
          netMinor: l.netMinor,
          mappedPrefix: snap?.matchedPrefix ?? l.matchedPrefix,
          mappingSource: snap?.source ?? l.classificationSource,
          mappingStatus: snap?.mappingStatus ?? l.mappingStatus,
          mainCategory: snap?.mainCategory ?? null,
          classification: l.classification,
          aggregationBehavior: l.aggregationBehavior,
          statementLineCode: snap?.statementLineCode ?? null,
        };
      }),
    });
    const provenance = enforceProvenanceBound(
      buildTbImportProvenanceMetadata(orchestrated, row.id, row.revisionNumber),
    );
    await writeAudit(tx, {
      user,
      action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE,
      entityType: "TrialBalanceImport",
      entityId: row.id,
      description: `إثبات استيراد ميزان مراجعة V1 (${orchestrated.company.code} ${orchestrated.period.startDate} ← ${parsed.shape}) — ${lines.length} سطرًا`,
      metadata: provenance,
      ip,
    });
    return { id: row.id, revisionNumber: row.revisionNumber, provenance };
  });

  return {
    importId: created.id,
    status: TB_STATUSES.DRAFT,
    dataType: derivedDataType,
    revisionNumber: created.revisionNumber,
    lineCount: lines.length,
    totalDebitMinor: totalDebit.toString(),
    totalCreditMinor: totalCredit.toString(),
    canonicalLineHash: orchestrated.canonicalLineHash,
    sourcePayloadHash: orchestrated.sourcePayloadHash,
    provenance: created.provenance,
    replacedImportId: existing?.id ?? null,
  };
}

/* ── قراءة الإثبات المحفوظ (قراءة صرفة — عبر الأنماط القائمة) ───────────────── */

export async function getTbImportProvenance(user: SessionUser, importId: string) {
  const row = await db.trialBalanceImport.findUnique({
    where: { id: importId },
    select: {
      id: true, companyId: true, status: true, dataType: true, fromDate: true, toDate: true,
      startOrdinal: true, endOrdinal: true, revisionNumber: true, lineCount: true,
      payloadHash: true, fileHash: true, totalDebitMinor: true, totalCreditMinor: true,
      company: { select: { id: true, code: true, nameAr: true, functionalCurrency: true } },
    },
  });
  if (!row) throw new TrialBalanceError("NOT_FOUND", "الاستيراد غير موجود.");
  if (!companyVisible(user, row.companyId)) {
    throw new TrialBalanceError("NOT_FOUND", "لا تملك الوصول لهذه الشركة.");
  }
  const audits = await db.auditLog.findMany({
    where: { action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE, entityId: importId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, createdAt: true, username: true, action: true, metadata: true },
  });
  return {
    import: {
      ...row,
      totalDebitMinor: row.totalDebitMinor.toString(),
      totalCreditMinor: row.totalCreditMinor.toString(),
    },
    provenance: audits.map((a) => ({
      id: a.id,
      createdAt: a.createdAt.toISOString(),
      username: a.username,
      metadata: JSON.parse(a.metadata) as Record<string, unknown>,
    })),
  };
}

/* ── هاش ملف اختياري (يُستخدم فقط إذا عرّفه العميل فعليًا تحت عقد المصدر) ────── */

export function normalizeClientFileHash(raw: unknown): string {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return /^[0-9a-f]{64}$/.test(v) ? v : "";
}

/** مرآة داخلية للاستخدام الحتمي — تمنع استيراد createHash من أماكن متفرقة. */
export function tbServerSha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
