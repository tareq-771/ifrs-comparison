// ═══════════════════════════════════════════════════════════════════════════
// Phase 7.0 (Step 2) — TB Importer Core Accounting Normalization + Validation
// نواة التطبيع المحاسبي والتحقق لمستورد ميزان المراجعة — نقية حصرًا (بلا I/O/DB/API).
//
// القواعد المقفلة (تعليمات الخطوة 2):
//   • المحرك المعتمد للتصنيف هو account-nature.ts حصرًا — لا إعادة تصميم ولا
//     تعديل: 1=ASSET | 3=EXPENSE (3101 = EXPENSE ولا يجوز EQUITY أبدًا) |
//     4=REVENUE | الجذر 2 مركّب ⇒ NEEDS_DETAILED_CLASSIFICATION بلا بادئة تفصيلية.
//   • التحليل النقدي: نص المصدر ⇒ BigInt وحدات صغرى — حتمي، بلا Number/parseFloat/
//     parseInt/عائم إطلاقًا. الدقة الزائدة تُرفض (لا تقريب صامت أبدًا).
//   • معادلة الصف (FULL_MOVEMENT): openingNet + movementNet === closingNet
//     بدقة BigInt — لا تسامح ولا إصلاح صامت.
//   • FLOW ⇒ زوج الفترة | BALANCE ⇒ زوج الإغلاق (FULL_MOVEMENT). إغلاق FLOW
//     لا يُفسَّر YTD أبدًا. CLOSING_ONLY: FLOW يتطلب تصريح flowClosingSemantics
//     = CUMULATIVE_YTD صراحةً وإلا BLOCK. MOVEMENT_ONLY: BALANCE يُمنع (حتى الصفري).
//   • التكرار يمنع، المجاميع المشتبهة تحتاج حسمًا صريحًا KEPT/EXCLUDED،
//     COMPLETE يفرض توازن الضبط وSUBSET يكشف الفروق ويطالب بإقرار صريح.
//   • لا OTHER، لا plug موازن، لا FX، لا إصرار — كل ذلك محظور في هذه الخطوة.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type TbDuplicateAccountCode,
  type TbHeaderMappingResult,
  type TbImportShape,
  type TbMonetaryField,
  type TbSourceRow,
  type TbSubtotalFlag,
  TB_MONETARY_FIELDS,
  detectDuplicateAccountCodes,
  requiredFieldsForShape,
} from "./tb-import";
import {
  type AccountClassification,
  type AggregationBehavior,
  type MappingOverrideLike,
  type MappingRuleLike,
  type MappingSource,
  type MappingStatus,
  type ResolvedAccountMapping,
  type StatementLineLike,
  SYSTEM_ROOT_SEED,
  resolveAccountMapping,
} from "./account-nature";

/* ── مرآة الجذور النظامية كقواعد حل نقية (افتراض عند غياب قواعد المستدعي) ──── */

export const SYSTEM_ROOT_MAPPING_RULES: readonly MappingRuleLike[] = SYSTEM_ROOT_SEED.map(
  (r) => ({
    id: r.id,
    companyId: null,
    prefix: r.prefix,
    mainCategory: r.mainCategory,
    classification: r.classification,
    aggregationBehavior: r.aggregationBehavior,
    statementLineCode: null,
    source: "SYSTEM",
    isActive: true,
  }),
);

/* ── أكواد التحقق الحتمية ─────────────────────────────────────────────────── */

export type TbNormalizationErrorCode =
  | "FUNCTIONAL_CURRENCY_UNCONFIGURED"
  | "SOURCE_CURRENCY_REQUIRED"
  | "FOREIGN_CURRENCY_TB_REQUIRES_FX_PROCESS"
  | "INVALID_CURRENCY_PRECISION"
  | "MONETARY_INVALID"
  | "MONETARY_OVERPRECISION"
  | "REQUIRED_FIELD_UNMAPPED"
  | "PERIOD_ORDINALS_REQUIRED"
  | "MULTI_PERIOD_FULL_MOVEMENT_BLOCKED"
  | "UNRESOLVED_ACCOUNT_CLASSIFICATION"
  | "ROW_EQUATION_MISMATCH"
  | "DUPLICATE_ACCOUNT_CODE"
  | "SUBTOTAL_RESOLUTION_REQUIRED"
  | "SUBTOTAL_RESOLUTION_FOR_UNFLAGGED_ROW"
  | "FLOW_CLOSING_SEMANTICS_UNDECLARED"
  | "BALANCE_MOVEMENT_ONLY_BLOCKED"
  | "COMPLETE_CONTROL_TOTAL_MISMATCH"
  | "SUBSET_ACKNOWLEDGMENT_REQUIRED";

export const TB_NORMALIZATION_WARNING_CODES = [
  "BOTH_SIDES_NONZERO_OPENING",
  "BOTH_SIDES_NONZERO_CLOSING",
] as const;
export type TbNormalizationWarningCode = (typeof TB_NORMALIZATION_WARNING_CODES)[number];

/** إشعار صريح (ليس خطأ) — مسار LEGACY المؤجَّل حصرًا. */
export const TB_NORMALIZATION_NOTICE_CODES = ["LEGACY_DEFERRED_TO_EXISTING_PATH"] as const;

export interface TbNormalizationIssue {
  code: TbNormalizationErrorCode;
  message: string;
  /** تفاصيل مهيكلة — قد تحوي BigInt (حد التسلسل هو من يحوّل لنص لاحقًا). */
  details?: Record<string, unknown>;
}

export interface TbNormalizationWarning {
  code: TbNormalizationWarningCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface TbNormalizationNotice {
  code: string;
  message: string;
}

/* ── المحلل النقدي — نص المصدر ⇒ BigInt وحدات صغرى ────────────────────────── */

export type TbMonetaryParseResult =
  | { kind: "blank" }
  | { kind: "value"; minor: bigint }
  | { kind: "invalid"; code: "MONETARY_INVALID" | "MONETARY_OVERPRECISION"; reason: string };

/** الحد الأعلى المسموح لوحدات الدقة (0..8) — صريح دائمًا، لا افتراضي ضمني. */
export const TB_MAX_MINOR_UNITS = 8;

export function isValidMinorUnits(minorUnits: unknown): minorUnits is number {
  return (
    typeof minorUnits === "number" &&
    Number.isInteger(minorUnits) &&
    minorUnits >= 0 &&
    minorUnits <= TB_MAX_MINOR_UNITS
  );
}

/**
 * تطبيع تمثيلي آمن حصرًا: إزالة المسافات الطرفية (بما فيها مسافات الأرقام
 * غير الفاصلة NBSP/THIN/FIGURE) — حتمية وغير نقدية بوضوح. أي مسافة داخلية
 * تبقى سبب رفض صريحًا.
 */
const MONETARY_EDGE_SPACES_RE = /^[\s\u00A0\u2007\u202F]+|[\s\u00A0\u2007\u202F]+$/g;
const MONETARY_ANY_SPACE_RE = /[\s\u00A0\u2007\u202F]/;

/**
 * المحلل النقدي الحتمي (fail-closed):
 *  • blank ⇒ {kind:"blank"} (المستدعي يقرر سماح الفراغ حسب الحقل — الحقول
 *    النقدية المسندة تسمح بالفراغ ⇒ صفر).
 *  • الصيغة المدعومة: «(1,234.56)» أو «-1,234.56» أو «1,234» أو «1,234.56» —
 *    مجموعات آلاف ثلاثية حصرًا، فاصلة عشرية واحدة، أرقام لاتينية حصرًا.
 *  • الدقة الزائدة عن minorUnits ⇒ MONETARY_OVERPRECISION (حتى الأصفار الزائدة —
 *    قاعدة معجمية صرفًا: لا تقريب ولا قص صامت أبدًا).
 *  • NaN/Infinity/رموز عملات/أرقام عربية/أسّية/فواصل مشوّهة ⇒ MONETARY_INVALID.
 * لا Number/parseFloat/parseInt/عائم إطلاقًا — معالجة أرقام نصية ⇒ BigInt.
 */
export function parseMonetaryToMinor(raw: string, minorUnits: number): TbMonetaryParseResult {
  const invalid = (reason: string): TbMonetaryParseResult => ({
    kind: "invalid",
    code: "MONETARY_INVALID",
    reason,
  });
  if (!isValidMinorUnits(minorUnits)) {
    return invalid("INVALID_MINOR_UNITS");
  }
  const text = raw.replace(MONETARY_EDGE_SPACES_RE, "");
  if (text === "") return { kind: "blank" };

  let body = text;
  let negative = false;
  if (body.startsWith("(") && body.endsWith(")")) {
    negative = true;
    body = body.slice(1, -1);
    if (body === "") return invalid("EMPTY_PARENS");
    if (MONETARY_ANY_SPACE_RE.test(body)) return invalid("WHITESPACE_INSIDE_PARENS");
    if (body.includes("-") || body.includes("+")) return invalid("SIGN_INSIDE_PARENS");
    if (body.includes("(") || body.includes(")")) return invalid("NESTED_PARENS");
  } else {
    if (body.includes("(") || body.includes(")")) return invalid("STRAY_PAREN");
    if (body.startsWith("-")) {
      negative = true;
      body = body.slice(1);
      if (body === "") return invalid("MINUS_ONLY");
      if (MONETARY_ANY_SPACE_RE.test(body)) return invalid("WHITESPACE_AFTER_MINUS");
    } else if (body.includes("-")) {
      return invalid("MISPLACED_MINUS");
    }
    if (body.includes("+")) return invalid("PLUS_SIGN_UNSUPPORTED");
  }

  // فاصلة عشرية واحدة حصرًا
  const dotIndex = body.indexOf(".");
  let intPart: string;
  let fracPart: string | null;
  if (dotIndex === -1) {
    intPart = body;
    fracPart = null;
  } else {
    intPart = body.slice(0, dotIndex);
    fracPart = body.slice(dotIndex + 1);
    if (fracPart.includes(".")) return invalid("MULTIPLE_DECIMAL_SEPARATORS");
    if (fracPart.length === 0) return invalid("EMPTY_FRACTION");
    if (!/^\d+$/.test(fracPart)) return invalid("INVALID_FRACTION_DIGITS");
  }

  // الجزء الصحيح: أرقام مجردة («1500») أو مجموعات آلاف ثلاثية صارمة («1,500»)
  // حصرًا — أي خلط («1234,567»، «1,23»، «12,3456») مرفوض.
  if (intPart.length === 0) return invalid("EMPTY_INTEGER_PART");
  const plainDigits = /^\d+$/.test(intPart);
  const groupedDigits = /^\d{1,3}(,\d{3})+$/.test(intPart);
  if (!plainDigits && !groupedDigits) return invalid("INVALID_INTEGER_OR_SEPARATORS");

  // الدقة الزائدة تُرفض — قاعدة معجمية صرفًا (حتى الأصفار الزائدة)
  if (fracPart !== null && fracPart.length > minorUnits) {
    return { kind: "invalid", code: "MONETARY_OVERPRECISION", reason: "FRACTION_EXCEEDS_MINOR_UNITS" };
  }

  const intDigits = intPart.replace(/,/g, "");
  const fracPadded = (fracPart ?? "").padEnd(minorUnits, "0");
  const combined = `${intDigits}${fracPadded}`;
  // combined أرقام حصرًا هنا — BigInt آمن (بلا علم/فاصلة)
  let minor = BigInt(combined);
  if (negative && minor !== BigInt(0)) minor = -minor;
  return { kind: "value", minor };
}

/* ── مدخل التطبيع ─────────────────────────────────────────────────────────── */

export type TbFlowClosingSemantics = "CUMULATIVE_YTD";
export type TbCompleteness = "COMPLETE" | "SUBSET";
export type TbSubtotalResolution = "KEPT" | "EXCLUDED";

export interface TbNormalizationRequest {
  /** الشكل المؤكد (حسم Step-1: تأكيد المستخدم يعلو ولا يُمسّ). */
  shape: TbImportShape;
  shapeSource?: "USER_CONFIRMED" | "SUGGESTED";
  /** صفوف المصدر النصية الخام من Step-1 (extractTbSourceRows). */
  rows: readonly TbSourceRow[];
  /** نتيجة الإسناد المؤكدة من Step-1 (للإثبات والهاش). */
  mapping: TbHeaderMappingResult;
  /** أرقام صفوف الترويسة المكررة المكتشفة حتميًا في Step-1 (بلا إسقاط ذواتي). */
  repeatedHeaderRowNumbers?: readonly number[];
  /** أعلام اشتباه المجاميع من Step-1 (FLAG فقط). */
  subtotalFlags?: readonly TbSubtotalFlag[];
  /** حسم صريح لكل صف مشتبه: KEPT تفصيل عادي | EXCLUDED استبعاد معلن. */
  subtotalResolutions?: Readonly<Record<number, TbSubtotalResolution>>;
  /** بداية/نهاية نطاق الفترة — FULL_MOVEMENT يتطلب فترة واحدة (البداية = النهاية). */
  periodStartOrdinal?: number;
  periodEndOrdinal?: number;
  /** عملة المصدر — إلزامية صراحة. */
  sourceCurrency?: string;
  /** العملة الوظيفية المهيأة — غيابها ⇒ BLOCK. */
  functionalCurrency?: string | null;
  /** دقة العملة بوحداتها الصغرى — صريحة دائمًا، لا رجوع عام لمنزلتين. */
  minorUnits: number;
  completeness: TbCompleteness;
  subsetAcknowledged?: boolean;
  /** تصريح دلالة الإغلاق لصفوف FLOW في CLOSING_ONLY — لا تخمين أبدًا. */
  flowClosingSemantics?: TbFlowClosingSemantics | null;
  /** مدخلات محرك التصنيف المعتمد — الافتراضى الجذور النظامية حصرًا. */
  classificationRules?: readonly MappingRuleLike[];
  classificationOverrides?: readonly MappingOverrideLike[];
  classificationStatementLines?: readonly StatementLineLike[];
  classificationCompanyId?: string | null;
}

/* ── نتائج مهيكلة ─────────────────────────────────────────────────────────── */

export type TbRowSemantics = "PERIOD_MOVEMENT" | "CLOSING_AS_OF" | "CUMULATIVE_YTD";
export type TbDataTypeCandidate = "PERIOD_MOVEMENT" | "CUMULATIVE_YTD" | "BALANCE_AS_OF";
export type TbRowKind = "DETAIL" | "BLANK" | "REPEATED_HEADER" | "SUBTOTAL_EXCLUDED";

export interface TbControlTotalGroup {
  debitMinor: bigint;
  creditMinor: bigint;
  /** debitMinor - creditMinor (دلالة الفرق: موجب = مدين زائد). */
  differenceMinor: bigint;
}

export interface TbControlTotals {
  opening?: TbControlTotalGroup;
  period?: TbControlTotalGroup;
  closing?: TbControlTotalGroup;
}

export interface TbRowEquationResult {
  sourceRowNumber: number;
  accountCode: string;
  openingNetMinor: bigint;
  movementNetMinor: bigint;
  closingNetMinor: bigint;
  /** openingNet + movementNet - closingNet (صفر = متوازن). */
  differenceMinor: bigint;
  passes: boolean;
}

export interface TbClassificationResult {
  sourceRowNumber: number;
  accountCode: string;
  resolved: boolean;
  classification: AccountClassification | null;
  aggregationBehavior: AggregationBehavior | null;
  mappingStatus: MappingStatus;
  provenanceSource: MappingSource | null;
  matchedPrefix: string | null;
  rootPrefix: string | null;
  companyPrefix: string | null;
}

export interface TbAcceptedRow {
  sourceRowNumber: number;
  accountCode: string;
  accountCodeIsNumericSource: boolean;
  accountName: string;
  /** القيم المُحلَّلة للحقول المطلوبة فقط (BigInt وحدات صغرى). */
  parsedMonetary: Partial<Record<TbMonetaryField, bigint>>;
  rawMonetary: Partial<Record<TbMonetaryField, string>>;
  classification: TbClassificationResult;
  bothSidesWarnings: TbNormalizationWarning[];
  equation: TbRowEquationResult | null;
}

export interface TbNormalizedDraftLineCandidate {
  sourceRowNumber: number;
  /** نص كود الحساب كما في المصدر حرفيًا — لا تحويل Number ولا حشو أصفار. */
  accountCode: string;
  accountCodeIsNumericSource: boolean;
  accountName: string;
  debitMinor: bigint;
  creditMinor: bigint;
  /** debitMinor - creditMinor حصرًا. */
  netMinor: bigint;
  rowSemantics: TbRowSemantics;
  classification: AccountClassification | null;
  aggregationBehavior: AggregationBehavior | null;
  classificationSource: MappingSource | null;
  mappingStatus: MappingStatus;
  matchedPrefix: string | null;
}

export interface TbSubtotalExclusion {
  sourceRowNumber: number;
  accountCode: string;
  accountName: string;
  matchedKeyword: string;
  matchedIn: "CODE" | "NAME";
  resolution: TbSubtotalResolution;
}

export interface TbNormalizationResult {
  status: "VALID" | "BLOCKED" | "DEFERRED_LEGACY";
  /** VALID حصرًا — مرشح جاهز لطبقة الإصرار اللاحقة (لا إصرار في هذه الخطوة). */
  persistenceReady: boolean;
  shape: TbImportShape;
  completeness: TbCompleteness;
  sourceCurrency: string | null;
  functionalCurrency: string | null;
  minorUnits: number;
  dataTypeCandidate: TbDataTypeCandidate | null;
  periodStartOrdinal: number | null;
  periodEndOrdinal: number | null;
  acceptedRows: TbAcceptedRow[];
  structuralExclusions: {
    blankRows: number[];
    repeatedHeaderRows: number[];
  };
  subtotalExclusions: TbSubtotalExclusion[];
  warnings: TbNormalizationWarning[];
  errors: TbNormalizationIssue[];
  notices: TbNormalizationNotice[];
  /** معادلة الصف — FULL_MOVEMENT حصرًا. */
  rowEquationResults: TbRowEquationResult[];
  classificationResults: TbClassificationResult[];
  duplicateResults: { duplicates: TbDuplicateAccountCode[]; blocked: boolean };
  controlTotals: TbControlTotals | null;
  draftLineCandidates: TbNormalizedDraftLineCandidate[];
}

/* ── الحل التصنيفي لصف مفرد عبر المحرك المعتمد ────────────────────────────── */

function classifyRow(
  row: TbSourceRow,
  request: TbNormalizationRequest,
  rules: readonly MappingRuleLike[],
): TbClassificationResult {
  const code = row.accountCodeRaw.trim();
  let resolved: ResolvedAccountMapping;
  if (code === "") {
    resolved = resolveAccountMapping({ accountCode: "", rules });
  } else {
    resolved = resolveAccountMapping({
      accountCode: code,
      rules,
      overrides: request.classificationOverrides ?? [],
      lines: request.classificationStatementLines ?? [],
      companyId: request.classificationCompanyId ?? null,
    });
  }
  const behavior = resolved.aggregationBehavior;
  const classification = resolved.classification;
  const isResolved = classification !== null && behavior !== null;
  return {
    sourceRowNumber: row.sourceRowNumber,
    accountCode: row.accountCodeRaw,
    resolved: isResolved,
    classification,
    aggregationBehavior: behavior,
    mappingStatus: resolved.mappingStatus,
    provenanceSource: resolved.source,
    matchedPrefix: resolved.matchedPrefix,
    rootPrefix: resolved.rootPrefix,
    companyPrefix: resolved.companyPrefix,
  };
}

/* ── محرك التطبيع المركزي (نقي — حتمي — قابل لإعادة التشغيل خادميًا) ───────── */

export function normalizeTbSource(request: TbNormalizationRequest): TbNormalizationResult {
  const errors: TbNormalizationIssue[] = [];
  const warnings: TbNormalizationWarning[] = [];
  const notices: TbNormalizationNotice[] = [];

  /* LEGACY: مسار مؤجَّل صريح — بلا أي إعادة تفسير ولا معالجة (قرار مقفل). */
  if (request.shape === "LEGACY") {
    notices.push({
      code: "LEGACY_DEFERRED_TO_EXISTING_PATH",
      message:
        "LEGACY مسار مؤجَّل صراحةً: القارئ القديم والواردات التاريخية لا يُلمسان — التطبيع الجديد لا يعيد تفسير LEGACY.",
    });
    return emptyResult(request, {
      status: "DEFERRED_LEGACY",
      persistenceReady: false,
      errors,
      warnings,
      notices,
    });
  }

  /* ── 1) بوابة عملة المصدر/الوظيفية/الدقة — تحقق وصفية حصرًا، لا تحويل ── */
  if (!isValidMinorUnits(request.minorUnits)) {
    errors.push({
      code: "INVALID_CURRENCY_PRECISION",
      message: `دقة العملة غير صالحة: minorUnits يجب أن يكون عددًا صحيحًا بين 0 و ${TB_MAX_MINOR_UNITS} — لا رجوع صامت لمنزلتين.`,
      details: { minorUnits: request.minorUnits },
    });
  }
  const sourceCurrency = typeof request.sourceCurrency === "string" ? request.sourceCurrency.trim() : "";
  if (sourceCurrency === "") {
    errors.push({
      code: "SOURCE_CURRENCY_REQUIRED",
      message: "عملة المصدر إلزامية صراحةً — لا افتراض.",
    });
  }
  const functionalCurrencyRaw = request.functionalCurrency;
  const functionalCurrency =
    typeof functionalCurrencyRaw === "string" ? functionalCurrencyRaw.trim() : "";
  if (functionalCurrency === "") {
    errors.push({
      code: "FUNCTIONAL_CURRENCY_UNCONFIGURED",
      message: "العملة الوظيفية غير مهيأة — ممنوع المتابعة بلا تهيئة صريحة.",
    });
  }
  if (sourceCurrency !== "" && functionalCurrency !== "" && sourceCurrency !== functionalCurrency) {
    errors.push({
      code: "FOREIGN_CURRENCY_TB_REQUIRES_FX_PROCESS",
      message: `عملة المصدر (${sourceCurrency}) تخالف العملة الوظيفية (${functionalCurrency}) — ممنوع أي تحويل أو بحث سعر أو تقدير: يتطلب عملية FX صريحة خارج هذه الخطوة.`,
      details: { sourceCurrency, functionalCurrency },
    });
  }
  if (errors.length > 0) {
    return emptyResult(request, {
      status: "BLOCKED",
      persistenceReady: false,
      errors,
      warnings,
      notices,
      sourceCurrency: sourceCurrency === "" ? null : sourceCurrency,
      functionalCurrency: functionalCurrency === "" ? null : functionalCurrency,
    });
  }

  const minorUnits = request.minorUnits;
  const rules = request.classificationRules ?? SYSTEM_ROOT_MAPPING_RULES;

  /* ── 2) التصنيف البنيوي للصفوف: فراغ / ترويسة مكررة / مجمع مستبعد / تفصيل ── */
  const repeatedSet = new Set<number>(request.repeatedHeaderRowNumbers ?? []);
  const subtotalFlags = request.subtotalFlags ?? [];
  const resolutions = request.subtotalResolutions ?? {};
  const flaggedByRow = new Map<number, TbSubtotalFlag>();
  for (const flag of subtotalFlags) {
    if (!flaggedByRow.has(flag.sourceRowNumber)) flaggedByRow.set(flag.sourceRowNumber, flag);
  }

  const subtotalExclusions: TbSubtotalExclusion[] = [];
  const subtotalExcludedRows = new Set<number>();
  const unresolvedSubtotalFlags: TbSubtotalFlag[] = [];

  for (const [rowNumber, flag] of flaggedByRow) {
    const resolution = resolutions[rowNumber];
    if (resolution === "EXCLUDED") {
      subtotalExcludedRows.add(rowNumber);
    } else if (resolution === "KEPT") {
      // تفصيل عادي — يمر بكل الفحوص
    } else {
      unresolvedSubtotalFlags.push(flag);
    }
  }
  if (unresolvedSubtotalFlags.length > 0) {
    errors.push({
      code: "SUBTOTAL_RESOLUTION_REQUIRED",
      message: "صفوف مجاميع مشتبهة بلا حسم صريح KEPT/EXCLUDED — لا استبعاد صامت أبدًا.",
      details: {
        unresolvedRowNumbers: unresolvedSubtotalFlags.map((f) => f.sourceRowNumber),
        matchedKeywords: unresolvedSubtotalFlags.map((f) => f.matchedKeyword),
      },
    });
  }
  for (const key of Object.keys(resolutions)) {
    const rowNumber = Number(key);
    if (!Number.isInteger(rowNumber) || !flaggedByRow.has(rowNumber)) {
      errors.push({
        code: "SUBTOTAL_RESOLUTION_FOR_UNFLAGGED_ROW",
        message: `حسم مجمع لصف غير مُعلَّم (${rowNumber}) — مرفوض (صرامة كاملة).`,
        details: { sourceRowNumber: rowNumber, resolution: resolutions[rowNumber] },
      });
    }
  }

  const detailRows: TbSourceRow[] = [];
  const blankRowNumbers: number[] = [];
  const repeatedRowNumbers: number[] = [];
  const rowKinds = new Map<number, TbRowKind>();
  for (const row of request.rows) {
    if (row.isBlank) {
      rowKinds.set(row.sourceRowNumber, "BLANK");
      blankRowNumbers.push(row.sourceRowNumber);
      continue;
    }
    if (repeatedSet.has(row.sourceRowNumber)) {
      rowKinds.set(row.sourceRowNumber, "REPEATED_HEADER");
      repeatedRowNumbers.push(row.sourceRowNumber);
      continue;
    }
    if (subtotalExcludedRows.has(row.sourceRowNumber)) {
      rowKinds.set(row.sourceRowNumber, "SUBTOTAL_EXCLUDED");
      const flag = flaggedByRow.get(row.sourceRowNumber);
      subtotalExclusions.push({
        sourceRowNumber: row.sourceRowNumber,
        accountCode: row.accountCodeRaw,
        accountName: row.accountNameRaw,
        matchedKeyword: flag?.matchedKeyword ?? "",
        matchedIn: flag?.matchedIn ?? "NAME",
        resolution: "EXCLUDED",
      });
      continue;
    }
    rowKinds.set(row.sourceRowNumber, "DETAIL");
    detailRows.push(row);
  }

  /* ── 3) التكرار بين صفوف التفصيل المقبولة (حصراً) — منع صارم بلا تجميع ── */
  const duplicates = detectDuplicateAccountCodes(detailRows);
  for (const dup of duplicates) {
    errors.push({
      code: "DUPLICATE_ACCOUNT_CODE",
      message: `كود حساب مكرر «${dup.accountCode}» (${dup.count} مرات) — ممنوع التجميع أو الكتابة أو الاستبقاء الأول/الأخير أو الموازنة.`,
      details: { accountCode: dup.accountCode, count: dup.count, sourceRowNumbers: dup.sourceRowNumbers },
    });
  }

  /* ── 4) اكتمال الحقول المطلوبة للشكل ── */
  const requiredFields = requiredFieldsForShape(request.shape);
  const missingFields = requiredFields.filter((f) => request.mapping.byField[f] === undefined);
  for (const field of missingFields) {
    errors.push({
      code: "REQUIRED_FIELD_UNMAPPED",
      message: `الحقل المطلوب «${field}» غير مسند لعمود مصدر — الشكل ${request.shape} لا يمكن معالجتُه.`,
      details: { field, shape: request.shape },
    });
  }

  /* ── 5) تحليل نقدًا + تصنيف + معادلة لكل صف تفصيل ── */
  const acceptedRows: TbAcceptedRow[] = [];
  const classificationResults: TbClassificationResult[] = [];
  const rowEquationResults: TbRowEquationResult[] = [];
  const parseFailedRows = new Set<number>();

  const isFull = request.shape === "FULL_MOVEMENT";
  const monetaryFieldsToParse = requiredFields.filter(
    (f): f is TbMonetaryField => (TB_MONETARY_FIELDS as readonly string[]).includes(f),
  );

  for (const row of detailRows) {
    const parsedMonetary: Partial<Record<TbMonetaryField, bigint>> = {};
    const rawMonetary: Partial<Record<TbMonetaryField, string>> = {};
    let rowParseFailed = false;
    for (const field of monetaryFieldsToParse) {
      const cell = row.monetary[field];
      const raw = cell?.rawText ?? "";
      rawMonetary[field] = raw;
      const parsed = parseMonetaryToMinor(raw, minorUnits);
      if (parsed.kind === "blank") {
        parsedMonetary[field] = BigInt(0); // الفراغ مسموح في الحقول النقدية المسندة ⇒ صفر
      } else if (parsed.kind === "value") {
        parsedMonetary[field] = parsed.minor;
      } else {
        rowParseFailed = true;
        parseFailedRows.add(row.sourceRowNumber);
        errors.push({
          code: parsed.code,
          message:
            parsed.code === "MONETARY_OVERPRECISION"
              ? `دقة زائدة في «${field}» بالصف ${row.sourceRowNumber} (كود «${row.accountCodeRaw}»): نص «${raw}» يتجاوز دقة العملة (${minorUnits}) — لا تقريب صامت.`
              : `نص نقدي غير مدعوم في «${field}» بالصف ${row.sourceRowNumber} (كود «${row.accountCodeRaw}»): «${raw}».`,
          details: { sourceRowNumber: row.sourceRowNumber, field, rawText: raw, reason: parsed.reason },
        });
      }
    }

    const classification = classifyRow(row, request, rules);
    classificationResults.push(classification);
    if (!classification.resolved) {
      errors.push({
        code: "UNRESOLVED_ACCOUNT_CLASSIFICATION",
        message: `تصنيف الحساب «${row.accountCodeRaw}» غير محسوم (${classification.mappingStatus}) — يبقى صريحًا: لا OTHER، لا تطبيع صامت إلى بند.`,
        details: {
          sourceRowNumber: row.sourceRowNumber,
          accountCode: row.accountCodeRaw,
          mappingStatus: classification.mappingStatus,
        },
      });
    }

    const bothSides: TbNormalizationWarning[] = [];
    const bothSidesCheck = (fieldA: TbMonetaryField, fieldB: TbMonetaryField, code: TbNormalizationWarningCode) => {
      const a = parsedMonetary[fieldA];
      const b = parsedMonetary[fieldB];
      if (a !== undefined && b !== undefined && a !== BigInt(0) && b !== BigInt(0)) {
        bothSides.push({
          code,
          message: `الجانبان غير صفريين (${fieldA} و ${fieldB}) بالصف ${row.sourceRowNumber} — تحذير إفصاح فقط؛ المعادلة وإجماليات الضبط هي الحاكمة.`,
          details: { sourceRowNumber: row.sourceRowNumber },
        });
      }
    };
    if (isFull) {
      bothSidesCheck("OPENING_DEBIT", "OPENING_CREDIT", "BOTH_SIDES_NONZERO_OPENING");
      bothSidesCheck("CLOSING_DEBIT", "CLOSING_CREDIT", "BOTH_SIDES_NONZERO_CLOSING");
      // حركة الفترة بالجانبين معًا صحيحة محاسبيًا — لا تحذير ولا رفض.
    } else if (request.shape === "CLOSING_ONLY") {
      bothSidesCheck("CLOSING_DEBIT", "CLOSING_CREDIT", "BOTH_SIDES_NONZERO_CLOSING");
    }
    // MOVEMENT_ONLY: كلا جانبي الفترة غير صفريين = حركة صحيحة (بلا تحذير).

    let equation: TbRowEquationResult | null = null;
    if (isFull) {
      const od = parsedMonetary.OPENING_DEBIT;
      const oc = parsedMonetary.OPENING_CREDIT;
      const pd = parsedMonetary.PERIOD_DEBIT;
      const pc = parsedMonetary.PERIOD_CREDIT;
      const cd = parsedMonetary.CLOSING_DEBIT;
      const cc = parsedMonetary.CLOSING_CREDIT;
      if (od !== undefined && oc !== undefined && pd !== undefined && pc !== undefined && cd !== undefined && cc !== undefined) {
        const openingNet = od - oc;
        const movementNet = pd - pc;
        const closingNet = cd - cc;
        const difference = openingNet + movementNet - closingNet;
        equation = {
          sourceRowNumber: row.sourceRowNumber,
          accountCode: row.accountCodeRaw,
          openingNetMinor: openingNet,
          movementNetMinor: movementNet,
          closingNetMinor: closingNet,
          differenceMinor: difference,
          passes: difference === BigInt(0),
        };
        rowEquationResults.push(equation);
        if (difference !== BigInt(0)) {
          errors.push({
            code: "ROW_EQUATION_MISMATCH",
            message: `معادلة الصف فشلت بالصف ${row.sourceRowNumber} (كود «${row.accountCodeRaw}»): افتتاحي ${openingNet} + حركة ${movementNet} ≠ إغلاق ${closingNet} — الفرق ${difference}. لا إصلاح صامت.`,
            details: {
              sourceRowNumber: row.sourceRowNumber,
              accountCode: row.accountCodeRaw,
              openingNetMinor: openingNet,
              movementNetMinor: movementNet,
              closingNetMinor: closingNet,
              differenceMinor: difference,
            },
          });
        }
      }
    }

    acceptedRows.push({
      sourceRowNumber: row.sourceRowNumber,
      accountCode: row.accountCodeRaw,
      accountCodeIsNumericSource: row.accountCodeIsNumericSource,
      accountName: row.accountNameRaw,
      parsedMonetary,
      rawMonetary,
      classification,
      bothSidesWarnings: bothSides,
      equation,
    });
    warnings.push(...bothSides);
  }

  /* ── 6) قيود الشكل: فترة واحدة (FULL)، دلالة الإغلاق (CLOSING_ONLY)، منع BALANCE (MOVEMENT_ONLY) ── */
  let periodStartOrdinal: number | null = null;
  let periodEndOrdinal: number | null = null;
  let dataTypeCandidate: TbDataTypeCandidate | null = null;

  const flowRows = detailRows.filter((r) => {
    const c = classificationResults.find((x) => x.sourceRowNumber === r.sourceRowNumber);
    return c !== undefined && c.resolved && c.aggregationBehavior === "FLOW";
  });
  const balanceRows = detailRows.filter((r) => {
    const c = classificationResults.find((x) => x.sourceRowNumber === r.sourceRowNumber);
    return c !== undefined && c.resolved && c.aggregationBehavior === "BALANCE";
  });

  const shapeBlockedRows = new Set<number>();

  if (isFull) {
    dataTypeCandidate = "PERIOD_MOVEMENT";
    const start = request.periodStartOrdinal;
    const end = request.periodEndOrdinal;
    if (typeof start !== "number" || !Number.isInteger(start) || typeof end !== "number" || !Number.isInteger(end)) {
      errors.push({
        code: "PERIOD_ORDINALS_REQUIRED",
        message: "FULL_MOVEMENT يتطلب بداية ونهاية نطاق الفترة صراحةً (عددين صحيحين) — فترة واحدة حصرًا.",
      });
    } else {
      periodStartOrdinal = start;
      periodEndOrdinal = end;
      if (start !== end) {
        errors.push({
          code: "MULTI_PERIOD_FULL_MOVEMENT_BLOCKED",
          message: `FULL_MOVEMENT يمتد لعدة فترات (البداية ${start} ≠ النهاية ${end}) — ممنوع: قيم الافتتاح/الإغلاق صالحة لفترة واحدة حصرًا.`,
          details: { periodStartOrdinal: start, periodEndOrdinal: end },
        });
      }
    }
  } else if (request.shape === "CLOSING_ONLY") {
    if (flowRows.length > 0) {
      if (request.flowClosingSemantics === "CUMULATIVE_YTD") {
        dataTypeCandidate = "CUMULATIVE_YTD";
      } else {
        dataTypeCandidate = null; // لا تخمين أبدًا
        errors.push({
          code: "FLOW_CLOSING_SEMANTICS_UNDECLARED",
          message:
            "صفوف FLOW موجودة في CLOSING_ONLY بلا تصريح صريح flowClosingSemantics = CUMULATIVE_YTD — يُمنع تفسير الإغلاق كحركة (تراكمي YTD أو شهرية) من اسم الملف أو رقم الفترة أو التسمية أو الواردات السابقة.",
          details: { flowRowNumbers: flowRows.map((r) => r.sourceRowNumber) },
        });
      }
    } else {
      dataTypeCandidate = "BALANCE_AS_OF";
    }
  } else if (request.shape === "MOVEMENT_ONLY") {
    dataTypeCandidate = "PERIOD_MOVEMENT";
    for (const row of balanceRows) {
      shapeBlockedRows.add(row.sourceRowNumber);
      errors.push({
        code: "BALANCE_MOVEMENT_ONLY_BLOCKED",
        message: `حساب BALANCE «${row.accountCodeRaw}» (الصف ${row.sourceRowNumber}) في مصدر MOVEMENT_ONLY — لا يوفر المصدر زوج إغلاق إطلاقًا؛ حتى القيمة الصفرية تبقى BALANCE ممنوعة.`,
        details: { sourceRowNumber: row.sourceRowNumber, accountCode: row.accountCodeRaw },
      });
    }
  }

  /* ── 7) إجماليات الضبط على صفوف التفصيل المقبولة حصرًا ── */
  const controlTotals: TbControlTotals = {};
  const sumGroup = (debitField: TbMonetaryField, creditField: TbMonetaryField): TbControlTotalGroup | null => {
    let debit = BigInt(0);
    let credit = BigInt(0);
    let seen = false;
    for (const accepted of acceptedRows) {
      const d = accepted.parsedMonetary[debitField];
      const c = accepted.parsedMonetary[creditField];
      if (d === undefined || c === undefined) continue; // صف فشل تحليله لا يشارك قيمةً
      seen = true;
      debit += d;
      credit += c;
    }
    if (!seen) return null;
    return { debitMinor: debit, creditMinor: credit, differenceMinor: debit - credit };
  };

  if (isFull) {
    controlTotals.opening = sumGroup("OPENING_DEBIT", "OPENING_CREDIT") ?? undefined;
    controlTotals.period = sumGroup("PERIOD_DEBIT", "PERIOD_CREDIT") ?? undefined;
    controlTotals.closing = sumGroup("CLOSING_DEBIT", "CLOSING_CREDIT") ?? undefined;
  } else if (request.shape === "CLOSING_ONLY") {
    controlTotals.closing = sumGroup("CLOSING_DEBIT", "CLOSING_CREDIT") ?? undefined;
  } else if (request.shape === "MOVEMENT_ONLY") {
    controlTotals.period = sumGroup("PERIOD_DEBIT", "PERIOD_CREDIT") ?? undefined;
  }

  const completeGroups: Array<[string, TbControlTotalGroup | undefined]> = isFull
    ? [
        ["opening", controlTotals.opening],
        ["period", controlTotals.period],
        ["closing", controlTotals.closing],
      ]
    : request.shape === "CLOSING_ONLY"
      ? [["closing", controlTotals.closing]]
      : [["period", controlTotals.period]];

  if (request.completeness === "COMPLETE") {
    for (const [group, totals] of completeGroups) {
      if (totals === undefined) continue;
      if (totals.differenceMinor !== BigInt(0)) {
        errors.push({
          code: "COMPLETE_CONTROL_TOTAL_MISMATCH",
          message: `إجمالي ضبط COMPLETE غير متوازن (${group}): مدين ${totals.debitMinor} ≠ دائن ${totals.creditMinor} — الفرق ${totals.differenceMinor}. ممنوع التجميل.`,
          details: {
            group,
            debitMinor: totals.debitMinor,
            creditMinor: totals.creditMinor,
            differenceMinor: totals.differenceMinor,
          },
        });
      }
    }
  } else {
    // SUBSET: الفروق تُكشف وتُفصَل — لا منع لعدم التوازن وحده، لكن الإقرار إلزامي.
    if (request.subsetAcknowledged !== true) {
      errors.push({
        code: "SUBSET_ACKNOWLEDGMENT_REQUIRED",
        message: "المصدر معلن SUBSET بلا إقرار صريح subsetAcknowledged = true — لا قبول صامت لمجموعة جزئية.",
      });
    }
  }

  /* ── 8) مرشحو بنود الاستيراد (للفئة اللاحقة حصرًا — لا إصرار هنا) ──
     (LEGACY قد عاد مبكرًا أعلاه — هذا المسار للأشكال الثلاثة حصرًا) */
  const draftLineCandidates: TbNormalizedDraftLineCandidate[] = [];
  {
    for (const accepted of acceptedRows) {
      // صف سليم صفًا: تحليل مكتمل + تصنيف محسوم + (FULL: معادلة ناجحة) + غير محجوب بالشكل
      if (parseFailedRows.has(accepted.sourceRowNumber)) continue;
      if (shapeBlockedRows.has(accepted.sourceRowNumber)) continue;
      if (!accepted.classification.resolved) continue;
      if (isFull && (accepted.equation === null || !accepted.equation.passes)) continue;

      let debitMinor: bigint;
      let creditMinor: bigint;
      let rowSemantics: TbRowSemantics;
      const behavior = accepted.classification.aggregationBehavior;
      if (isFull) {
        if (behavior === "FLOW") {
          debitMinor = accepted.parsedMonetary.PERIOD_DEBIT as bigint;
          creditMinor = accepted.parsedMonetary.PERIOD_CREDIT as bigint;
          rowSemantics = "PERIOD_MOVEMENT";
        } else {
          debitMinor = accepted.parsedMonetary.CLOSING_DEBIT as bigint;
          creditMinor = accepted.parsedMonetary.CLOSING_CREDIT as bigint;
          rowSemantics = "CLOSING_AS_OF";
        }
      } else if (request.shape === "CLOSING_ONLY") {
        // دلالة غير مصرَّحة ⇒ لا مرشح لصفوف FLOW إطلاقًا (لا تفسير صامت للإغلاق).
        if (behavior === "FLOW" && request.flowClosingSemantics !== "CUMULATIVE_YTD") continue;
        debitMinor = accepted.parsedMonetary.CLOSING_DEBIT as bigint;
        creditMinor = accepted.parsedMonetary.CLOSING_CREDIT as bigint;
        rowSemantics = behavior === "FLOW" ? "CUMULATIVE_YTD" : "CLOSING_AS_OF";
      } else {
        // MOVEMENT_ONLY — FLOW حصرًا هنا (BALANCE محجوب أعلاه)
        debitMinor = accepted.parsedMonetary.PERIOD_DEBIT as bigint;
        creditMinor = accepted.parsedMonetary.PERIOD_CREDIT as bigint;
        rowSemantics = "PERIOD_MOVEMENT";
      }
      draftLineCandidates.push({
        sourceRowNumber: accepted.sourceRowNumber,
        accountCode: accepted.accountCode,
        accountCodeIsNumericSource: accepted.accountCodeIsNumericSource,
        accountName: accepted.accountName,
        debitMinor,
        creditMinor,
        netMinor: debitMinor - creditMinor,
        rowSemantics,
        classification: accepted.classification.classification,
        aggregationBehavior: behavior,
        classificationSource: accepted.classification.provenanceSource,
        mappingStatus: accepted.classification.mappingStatus,
        matchedPrefix: accepted.classification.matchedPrefix,
      });
    }
  }

  const status: TbNormalizationResult["status"] =
    errors.length > 0 ? "BLOCKED" : "VALID";

  return {
    status,
    persistenceReady: status === "VALID",
    shape: request.shape,
    completeness: request.completeness,
    sourceCurrency,
    functionalCurrency,
    minorUnits,
    dataTypeCandidate,
    periodStartOrdinal,
    periodEndOrdinal,
    acceptedRows,
    structuralExclusions: { blankRows: blankRowNumbers, repeatedHeaderRows: repeatedRowNumbers },
    subtotalExclusions,
    warnings,
    errors,
    notices,
    rowEquationResults,
    classificationResults,
    duplicateResults: { duplicates, blocked: duplicates.length > 0 },
    controlTotals,
    draftLineCandidates,
  };
}

/* ── نتيجة فارغة/مبكرة (بوابة عملة أو LEGACY) ─────────────────────────────── */

function emptyResult(
  request: TbNormalizationRequest,
  overrides: {
    status: TbNormalizationResult["status"];
    persistenceReady: boolean;
    errors: TbNormalizationIssue[];
    warnings: TbNormalizationWarning[];
    notices: TbNormalizationNotice[];
    sourceCurrency?: string | null;
    functionalCurrency?: string | null;
  },
): TbNormalizationResult {
  return {
    status: overrides.status,
    persistenceReady: overrides.persistenceReady,
    shape: request.shape,
    completeness: request.completeness,
    sourceCurrency: overrides.sourceCurrency ?? null,
    functionalCurrency: overrides.functionalCurrency ?? null,
    minorUnits: request.minorUnits,
    dataTypeCandidate: null,
    periodStartOrdinal: null,
    periodEndOrdinal: null,
    acceptedRows: [],
    structuralExclusions: { blankRows: [], repeatedHeaderRows: [] },
    subtotalExclusions: [],
    warnings: overrides.warnings,
    errors: overrides.errors,
    notices: overrides.notices,
    rowEquationResults: [],
    classificationResults: [],
    duplicateResults: { duplicates: [], blocked: false },
    controlTotals: null,
    draftLineCandidates: [],
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * الحمولة القيانية لحقائق المصدر — أساس هاش SHA-256 عند إعادة التحقق وقت الالتزام.
 *  • حقائق مصدر حصرًا: لا نتائج تحقق محسوبة، لا طوابع زمن، لا قيم عشوائية.
 *  • لا تعتمد ترتيب إدراج خصائص الكائنات (تسلسل قياني بمفاتيح مرتبة).
 *  • القيم نصوص/أرقام/منطقية حصرًا — BigInt لا يدخل الحمولة (المصادر نصوص خام).
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface TbSourceFactsCanonicalPayload {
  shape: TbImportShape;
  completeness: TbCompleteness;
  sourceCurrency: string;
  functionalCurrency: string;
  minorUnits: number;
  periodStartOrdinal: number | null;
  periodEndOrdinal: number | null;
  flowClosingSemantics: TbFlowClosingSemantics | null;
  subsetAcknowledged: boolean;
  confirmedMapping: Record<string, { index: number; tier: string; rawHeader: string }>;
  mappingConflicts: Array<{ field: string; sourceColumnIndices: number[]; origin: string }>;
  subtotalResolutions: Array<{ rowNumber: number; resolution: TbSubtotalResolution }>;
  sourceRows: Array<{
    rowNumber: number;
    rowKind: TbRowKind;
    accountCode: string;
    accountCodeIsNumericSource: boolean;
    accountName: string;
    monetary: Record<string, string>;
    monetaryNumericSource: Record<string, boolean>;
    monetaryFormula: Record<string, boolean>;
  }>;
}

/**
 * تسلسل JSON قياني حتمي:
 *  • مفاتيح الكائنات مرتبة معجميًا (code-unit) ⇒ مستقل تمامًا عن ترتيب الإدراج.
 *  • المصفوفات بترتيبها (ترتيب الصفوف حقيقة مصدر).
 *  • undefined داخل الكائنات يُتخطى، داخل المصفوفات ⇒ null (دلالة JSON).
 *  • BigInt وغير المحدود مرفوضان صراحةً — الحمولة حقائق نصية/رقمية حصرًا.
 */
export function canonicalJsonStringify(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value as string);
  if (t === "boolean") return value === true ? "true" : "false";
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) throw new Error("CANONICAL_JSON_NON_FINITE_NUMBER");
    return JSON.stringify(n);
  }
  if (t === "bigint") throw new Error("CANONICAL_JSON_BIGINT_UNSUPPORTED");
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : serializeCanonical(v))).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${serializeCanonical(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error("CANONICAL_JSON_UNSUPPORTED_TYPE");
}

export function buildTbSourceFactsPayload(request: TbNormalizationRequest): TbSourceFactsCanonicalPayload {
  const resolutions = request.subtotalResolutions ?? {};
  const subtotalResolutions = Object.keys(resolutions)
    .map((k) => ({ rowNumber: Number(k), resolution: resolutions[Number(k)] }))
    .filter((r) => Number.isInteger(r.rowNumber))
    .sort((a, b) => a.rowNumber - b.rowNumber);

  const repeatedSet = new Set<number>(request.repeatedHeaderRowNumbers ?? []);
  const subtotalExcludedRows = new Set<number>(
    Object.keys(resolutions)
      .filter((k) => resolutions[Number(k)] === "EXCLUDED")
      .map((k) => Number(k)),
  );

  const confirmedMapping: TbSourceFactsCanonicalPayload["confirmedMapping"] = {};
  for (const col of request.mapping.columns) {
    if (col.status !== "MAPPED" || col.canonicalField === undefined) continue;
    confirmedMapping[col.canonicalField] = {
      index: col.sourceColumnIndex,
      tier: col.tier,
      rawHeader: col.rawHeader,
    };
  }
  const mappingConflicts = request.mapping.duplicateTargetConflicts.map((c) => ({
    field: c.field,
    sourceColumnIndices: [...c.sourceColumnIndices],
    origin: c.origin,
  }));

  const sourceRows = request.rows.map((row) => {
    let rowKind: TbRowKind;
    if (row.isBlank) rowKind = "BLANK";
    else if (repeatedSet.has(row.sourceRowNumber)) rowKind = "REPEATED_HEADER";
    else if (subtotalExcludedRows.has(row.sourceRowNumber)) rowKind = "SUBTOTAL_EXCLUDED";
    else rowKind = "DETAIL";
    const monetary: Record<string, string> = {};
    const monetaryNumericSource: Record<string, boolean> = {};
    const monetaryFormula: Record<string, boolean> = {};
    for (const field of TB_MONETARY_FIELDS) {
      const cell = row.monetary[field];
      monetary[field] = cell?.rawText ?? "";
      monetaryNumericSource[field] = cell?.isNumericSource ?? false;
      monetaryFormula[field] = cell?.isFormula ?? false;
    }
    return {
      rowNumber: row.sourceRowNumber,
      rowKind,
      accountCode: row.accountCodeRaw,
      accountCodeIsNumericSource: row.accountCodeIsNumericSource,
      accountName: row.accountNameRaw,
      monetary,
      monetaryNumericSource,
      monetaryFormula,
    };
  });

  return {
    shape: request.shape,
    completeness: request.completeness,
    sourceCurrency: typeof request.sourceCurrency === "string" ? request.sourceCurrency : "",
    functionalCurrency: typeof request.functionalCurrency === "string" ? request.functionalCurrency : "",
    minorUnits: request.minorUnits,
    periodStartOrdinal: request.periodStartOrdinal ?? null,
    periodEndOrdinal: request.periodEndOrdinal ?? null,
    flowClosingSemantics: request.flowClosingSemantics ?? null,
    subsetAcknowledged: request.subsetAcknowledged === true,
    confirmedMapping,
    mappingConflicts,
    subtotalResolutions,
    sourceRows,
  };
}
