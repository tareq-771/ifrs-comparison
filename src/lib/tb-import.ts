// ═══════════════════════════════════════════════════════════════════════════
// Phase 7.0 (Step 1) — TB Importer Pure Foundations
// أساسيات مستورد ميزان المراجعة الاحترافي — الخطوة 1: أساسات نقية حصرًا.
//
// هذا الملف نقي بلا I/O ولا DB ولا حسابات مالية:
//   • الحقول القيانية الثمانية + تسميات عربي/إنجليزي + مرادفات محافظة
//   • تطبيع رؤوس الأعمدة حتمي (عربي + إنجليزي)
//   • مطابقة بطبقات EXACT / CONTAINS / USER / NONE — الالتباس صريح لا يُحلّ صامتًا
//   • تسطيح الترويسة ثنائية المستوى عند اكتشافها فقط — بلا تسرب وراثة لليسار
//   • الأشكال الأربعة FULL_MOVEMENT / CLOSING_ONLY / MOVEMENT_ONLY / LEGACY
//     (الكشف اقتراح فقط؛ شكل المستخدم المؤكد لا يُغيَّر أبدًا)
//   • صفوف المصدر: نصوص خام حصرًا — لا تحويل نقدي إلى Number إطلاقًا (لاحقًا Step 2)
//   • كاشفات ن pure: ترويسات مكررة / اشتباه مجاميع (FLAG فقط) / تكرار أكواد
//
// محظور صراحةً في هذه الخطوة: أي تطبيع محاسبي، معادلات، BigInt، FLOW/BALANCE،
// إجماليات ضبط، COMPLETE/SUBSET، FX، تصنيف، إصرار، تجزئة مصدر — كل ذلك لخطوات لاحقة.
// ═══════════════════════════════════════════════════════════════════════════

/* ── الحقول القيانية ──────────────────────────────────────────────────────── */

export const TB_CANONICAL_FIELDS = [
  "ACCOUNT_CODE",
  "ACCOUNT_NAME",
  "OPENING_DEBIT",
  "OPENING_CREDIT",
  "PERIOD_DEBIT",
  "PERIOD_CREDIT",
  "CLOSING_DEBIT",
  "CLOSING_CREDIT",
] as const;

export type TbCanonicalField = (typeof TB_CANONICAL_FIELDS)[number];

/** الحقول النقدية الستة (الأكواد والأسماء ليست نقدية). */
export const TB_MONETARY_FIELDS = [
  "OPENING_DEBIT",
  "OPENING_CREDIT",
  "PERIOD_DEBIT",
  "PERIOD_CREDIT",
  "CLOSING_DEBIT",
  "CLOSING_CREDIT",
] as const;

export type TbMonetaryField = (typeof TB_MONETARY_FIELDS)[number];

/** تسميات ثنائية اللغة للحقول القيانية. */
export const TB_FIELD_LABELS: Record<TbCanonicalField, { ar: string; en: string }> = {
  ACCOUNT_CODE: { ar: "رقم الحساب", en: "Account Code" },
  ACCOUNT_NAME: { ar: "اسم الحساب", en: "Account Name" },
  OPENING_DEBIT: { ar: "رصيد أول المدة مدين", en: "Opening Debit" },
  OPENING_CREDIT: { ar: "رصيد أول المدة دائن", en: "Opening Credit" },
  PERIOD_DEBIT: { ar: "حركة الفترة مدين", en: "Period Debit" },
  PERIOD_CREDIT: { ar: "حركة الفترة دائن", en: "Period Credit" },
  CLOSING_DEBIT: { ar: "رصيد آخر المدة مدين", en: "Closing Debit" },
  CLOSING_CREDIT: { ar: "رصيد آخر المدة دائن", en: "Closing Credit" },
};

/**
 * مرادفات محافظة ثنائية اللغة (تُقارن بعد التطبيع).
 * محافظة عمدًا: لا مرادفات عامة قصيرة («مدين»، «رصيد»، «code») لأنها تسبب
 * التباسًا خاطئًا — الصيغ المركّبة فقط («رصيد أول المدة مدين»).
 */
export const TB_FIELD_ALIASES: Record<TbCanonicalField, string[]> = {
  ACCOUNT_CODE: [
    "account code", "account no", "account number", "account id",
    "gl code", "gl account code", "ledger code",
    "رقم الحساب", "كود الحساب", "رقم الحساب الرئيسي", "كود الحساب الرئيسي",
  ],
  ACCOUNT_NAME: [
    "account name", "gl name", "account title",
    "اسم الحساب", "اسم حساب", "اسم الحساب الرئيسي",
  ],
  OPENING_DEBIT: [
    "opening debit", "opening dr", "opening balance debit",
    "رصيد أول المدة مدين", "رصيد افتتاحي مدين", "مدين أول المدة",
  ],
  OPENING_CREDIT: [
    "opening credit", "opening cr", "opening balance credit",
    "رصيد أول المدة دائن", "رصيد افتتاحي دائن", "دائن أول المدة",
  ],
  PERIOD_DEBIT: [
    "period debit", "period dr", "debit movement", "period movement debit",
    "حركة الفترة مدين", "حركة المدة مدين", "مدين حركة الفترة",
  ],
  PERIOD_CREDIT: [
    "period credit", "period cr", "credit movement", "period movement credit",
    "حركة الفترة دائن", "حركة المدة دائن", "دائن حركة الفترة",
  ],
  CLOSING_DEBIT: [
    "closing debit", "closing dr", "closing balance debit",
    "رصيد الإغلاق مدين", "رصيد آخر المدة مدين", "مدين آخر المدة",
  ],
  CLOSING_CREDIT: [
    "closing credit", "closing cr", "closing balance credit",
    "رصيد الإغلاق دائن", "رصيد آخر المدة دائن", "دائن آخر المدة",
  ],
};

/* ── تطبيع الرؤوس (حتمي نقي) ─────────────────────────────────────────────── */

/**
 * تطبيع اسم عمود حتمي: إزالة BOM والأصفار العريضة والتطويل والتشكيل،
 * توحيد الألفات (أ إ آ ⇒ ا)، توحيد المسافات، lowercase للاتينية.
 * لا يُطبَّق على أكواد الحسابات إطلاقًا (معرّفات — تُحفظ كما هي).
 */
export function normalizeTbHeader(raw: string): string {
  let s = raw;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s
    .replace(/[\u200b\u200c\u200d\u200e\u200f\ufeff]/g, "") // أصفار عريضة/علامات اتجاه
    .replace(/\u0640/g, "") // تطويل
    .replace(/[\u064b-\u065f\u0670]/g, "") // تشكيل
    .replace(/[أإآ]/g, "ا")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return s;
}

/* ── طبقات المطابقة ونتائجها ─────────────────────────────────────────────── */

export type TbMappingTier = "EXACT" | "CONTAINS" | "USER" | "NONE";
export type TbColumnMappingStatus = "MAPPED" | "AMBIGUOUS" | "UNMAPPED";

export interface TbColumnMapping {
  sourceColumnIndex: number;
  rawHeader: string;
  normalizedHeader: string;
  status: TbColumnMappingStatus;
  tier: TbMappingTier;
  canonicalField?: TbCanonicalField;
  ambiguityCandidates?: TbCanonicalField[];
  duplicateTargetConflict?: boolean;
}

export interface TbDuplicateTargetConflict {
  field: TbCanonicalField;
  sourceColumnIndices: number[];
  origin: "AUTO" | "USER" | "MIXED";
}

export interface TbHeaderMappingResult {
  columns: TbColumnMapping[];
  /** الإسنادات الناجحة الفريدة: حقل ⇒ فهرس عمود المصدر. */
  byField: Partial<Record<TbCanonicalField, number>>;
  duplicateTargetConflicts: TbDuplicateTargetConflict[];
  ambiguousColumns: TbColumnMapping[];
  unmappedColumns: TbColumnMapping[];
}

/** الحد الأدنى لطول المرادف المسموح بمطابقة الاحتواء (منع الإيجابيات الكاذبة). */
const CONTAINS_MIN_ALIAS_LENGTH = 6;

export interface TbUserMappingInput {
  /** فهرس عمود المصدر (0-based) ⇒ حقل قياني — إسناد مستخدم صريح. */
  userMappings?: Readonly<Record<number, TbCanonicalField>>;
}

/**
 * مطابقة حتمية بطبقات: EXACT أولًا ثم CONTAINS (بتفرد صارم) ثم USER كتجاوز صريح.
 * القواعد المقفلة:
 *  • عمود مصدر واحد ≤ حقل قياني واحد.
 *  • التباس متساوٍ بلا حل صامت ⇒ AMBIGUOUS مع المرشحين.
 *  • هدف مكرر (عمودان لنفس الحقل) ⇒ رفض الاثنين + تسجيل التعارض.
 *  • لا أي تخمين موضعي إطلاقًا.
 */
export function mapTbHeaders(
  rawHeaders: string[],
  input: TbUserMappingInput = {},
): TbHeaderMappingResult {
  const userMappings = input.userMappings ?? {};
  const normalized = rawHeaders.map((h) => normalizeTbHeader(h));
  const columns: TbColumnMapping[] = rawHeaders.map((rawHeader, i) => ({
    sourceColumnIndex: i,
    rawHeader,
    normalizedHeader: normalized[i],
    status: "UNMAPPED" as TbColumnMappingStatus,
    tier: "NONE" as TbMappingTier,
  }));

  const aliasMap = new Map<TbCanonicalField, string[]>(
    TB_CANONICAL_FIELDS.map((f) => [
      f,
      TB_FIELD_ALIASES[f].map((a) => normalizeTbHeader(a)),
    ]),
  );

  // الطبقة 1 — EXACT: تطابق تام مع مرادف حقل واحد فقط.
  for (let i = 0; i < columns.length; i++) {
    if (columns[i].status === "MAPPED") continue;
    const nh = normalized[i];
    if (nh === "") continue;
    const candidates = TB_CANONICAL_FIELDS.filter((f) =>
      (aliasMap.get(f) as string[]).includes(nh),
    );
    if (candidates.length === 1) {
      columns[i].status = "MAPPED";
      columns[i].tier = "EXACT";
      columns[i].canonicalField = candidates[0];
    } else if (candidates.length > 1) {
      columns[i].status = "AMBIGUOUS";
      columns[i].ambiguityCandidates = candidates;
    }
  }

  // الطبقة 2 — CONTAINS: احتواء حصري (الرأس يحتوي مرادفًا واحدًا لحقل واحد فقط).
  for (let i = 0; i < columns.length; i++) {
    if (columns[i].status !== "UNMAPPED") continue;
    const nh = normalized[i];
    if (nh.length < CONTAINS_MIN_ALIAS_LENGTH) continue;
    const candidates = TB_CANONICAL_FIELDS.filter((f) =>
      (aliasMap.get(f) as string[]).some(
        (a) => a.length >= CONTAINS_MIN_ALIAS_LENGTH && nh.includes(a),
      ),
    );
    if (candidates.length === 1) {
      columns[i].status = "MAPPED";
      columns[i].tier = "CONTAINS";
      columns[i].canonicalField = candidates[0];
    } else if (candidates.length > 1) {
      columns[i].status = "AMBIGUOUS";
      columns[i].ambiguityCandidates = candidates;
    }
  }

  // الطبقة 3 — USER: تجاوز صريح من المستخدم يعلو على كل ما سبق.
  for (const key of Object.keys(userMappings)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= columns.length) continue;
    const field = userMappings[idx];
    columns[idx].status = "MAPPED";
    columns[idx].tier = "USER";
    columns[idx].canonicalField = field;
    columns[idx].ambiguityCandidates = undefined;
  }

  // كشف هدف مكرر: أكثر من عمود أسند لنفس الحقل ⇒ رفض الكل + تسجيل.
  const byField: Partial<Record<TbCanonicalField, number>> = {};
  const perField = new Map<TbCanonicalField, number[]>();
  for (const col of columns) {
    if (col.status !== "MAPPED" || !col.canonicalField) continue;
    const list = perField.get(col.canonicalField) ?? [];
    list.push(col.sourceColumnIndex);
    perField.set(col.canonicalField, list);
  }
  const duplicateTargetConflicts: TbDuplicateTargetConflict[] = [];
  for (const field of TB_CANONICAL_FIELDS) {
    const list = perField.get(field);
    if (!list || list.length <= 1) {
      if (list && list.length === 1) byField[field] = list[0];
      continue;
    }
    const origins = new Set(
      list.map((i) => (columns[i].tier === "USER" ? "USER" : "AUTO")),
    );
    duplicateTargetConflicts.push({
      field,
      sourceColumnIndices: [...list],
      origin:
        origins.size > 1 ? "MIXED" : origins.has("USER") ? "USER" : "AUTO",
    });
    for (const i of list) {
      columns[i].status = "UNMAPPED";
      columns[i].duplicateTargetConflict = true;
      // نحتفظ بالحقل المرشح للشفافية لكن دون إسناد فعلي.
    }
  }

  return {
    columns,
    byField,
    duplicateTargetConflicts,
    ambiguousColumns: columns.filter((c) => c.status === "AMBIGUOUS"),
    unmappedColumns: columns.filter((c) => c.status === "UNMAPPED"),
  };
}

/* ── اكتمال المتطلبات حسب الشكل ──────────────────────────────────────────── */

/** الحقول المطلوبة الصريحة لكل شكل (الاكتمال يُفحص لاحقًا بوضوح). */
export function requiredFieldsForShape(shape: TbImportShape): TbCanonicalField[] {
  switch (shape) {
    case "FULL_MOVEMENT":
      return [...TB_CANONICAL_FIELDS];
    case "CLOSING_ONLY":
      return ["ACCOUNT_CODE", "ACCOUNT_NAME", "CLOSING_DEBIT", "CLOSING_CREDIT"];
    case "MOVEMENT_ONLY":
      return ["ACCOUNT_CODE", "ACCOUNT_NAME", "PERIOD_DEBIT", "PERIOD_CREDIT"];
    case "LEGACY":
      return [];
  }
}

export interface TbMappingCompleteness {
  shape: TbImportShape;
  missing: TbCanonicalField[];
  satisfied: boolean;
}

/** فحص صريح للحقول المطلوبة الناقصة — لا افتراضات ضمنية. */
export function assessMappingCompleteness(
  mapping: TbHeaderMappingResult,
  shape: TbImportShape,
): TbMappingCompleteness {
  const missing = requiredFieldsForShape(shape).filter(
    (f) => mapping.byField[f] === undefined,
  );
  return { shape, missing, satisfied: missing.length === 0 };
}

/* ── تسطيح الترويسة ثنائية المستوى ───────────────────────────────────────── */

export interface TbFlattenedHeaders {
  effectiveHeaders: string[];
  /** هل اكتُشفت بنية ثنائية المستوى فعليًا؟ */
  twoLevelDetected: boolean;
  /** فهارس الأعمدة المركّبة من أب+ابن (أو ابن وارِث لأب مدمج). */
  composedColumns: number[];
}

/**
 * تسطيح كتلة ترويسة من صفّين (نصوص خام من الشبكة).
 * الاكتشاف الحتمي: صف فرعي فيه ≥2 خلية غير فارغة AND توجد خلية واحدة على الأقل
 * فيها الأب والابن معًا غير فارغين.
 * عند الاكتشاف فقط: يجوز للابن أن يرث أقرب أب غير فارغ إلى يساره (خلايا الدمج).
 * بلا اكتشاف: بلا أي وراثة يسرى إطلاقًا — الرأس = الأب إن وجد وإلا الابن.
 */
export function flattenTwoLevelHeaderBlock(
  topRow: string[],
  subRow: string[],
): TbFlattenedHeaders {
  const width = Math.max(topRow.length, subRow.length);
  const topAt = (i: number) => (i < topRow.length ? topRow[i] : "");
  const subAt = (i: number) => (i < subRow.length ? subRow[i] : "");
  const nonEmpty = (s: string) => s.trim() !== "";

  const subNonEmpty = Array.from({ length: width }, (_, i) => nonEmpty(subAt(i)));
  const bothNonEmptyExists = Array.from({ length: width }, (_, i) =>
    nonEmpty(topAt(i)),
  ).some((t, i) => t && subNonEmpty[i]);
  const twoLevelDetected =
    subNonEmpty.filter(Boolean).length >= 2 && bothNonEmptyExists;

  const effectiveHeaders: string[] = [];
  const composedColumns: number[] = [];
  let lastTopParent = "";
  for (let i = 0; i < width; i++) {
    const top = topAt(i);
    const sub = subAt(i);
    if (twoLevelDetected) {
      const hasTop = nonEmpty(top);
      const hasSub = nonEmpty(sub);
      if (hasTop) lastTopParent = top.trim();
      if (hasTop && hasSub) {
        effectiveHeaders.push(`${top.trim()} ${sub.trim()}`);
        composedColumns.push(i);
      } else if (!hasTop && hasSub) {
        // ابن تحت أب مدمج (خلايا الدمج) — وراثة يسرى مسموحة هنا فقط.
        if (lastTopParent !== "") {
          effectiveHeaders.push(`${lastTopParent} ${sub.trim()}`);
          composedColumns.push(i);
        } else {
          effectiveHeaders.push(sub.trim());
        }
      } else {
        effectiveHeaders.push(top.trim());
      }
    } else {
      // ترويسة أحادية المستوى — بلا وراثة إطلاقًا.
      effectiveHeaders.push(nonEmpty(top) ? top.trim() : sub.trim());
      lastTopParent = nonEmpty(top) ? top.trim() : lastTopParent;
    }
  }
  return { effectiveHeaders, twoLevelDetected, composedColumns };
}

/* ── الأشكال الأربعة ─────────────────────────────────────────────────────── */

export type TbImportShape = "FULL_MOVEMENT" | "CLOSING_ONLY" | "MOVEMENT_ONLY" | "LEGACY";

/**
 * وصف دلالي مقفل لكل شكل — يمنع الافتراضات الخطرة لاحقًا:
 *  • CLOSING_ONLY لا يوفر حركة فترة FLOW إطلاقًا.
 *  • MOVEMENT_ONLY لا يوفر زوج إغلاق BALANCE إطلاقًا.
 *  • closingIsYtdForFlowRows = false دائمًا: يُمنع تفسير الإغلاق كتراكمي YTD لصفوف FLOW.
 */
export interface TbShapeDescriptor {
  shape: TbImportShape;
  providesOpeningGroup: boolean;
  providesPeriodMovementGroup: boolean;
  providesClosingGroup: boolean;
  closingIsYtdForFlowRows: boolean;
  autoSuggestionAllowed: boolean;
  notes: string[];
}

export const TB_SHAPE_DESCRIPTORS: Record<TbImportShape, TbShapeDescriptor> = {
  FULL_MOVEMENT: {
    shape: "FULL_MOVEMENT",
    providesOpeningGroup: true,
    providesPeriodMovementGroup: true,
    providesClosingGroup: true,
    closingIsYtdForFlowRows: false,
    autoSuggestionAllowed: true,
    notes: [
      "يوفر المجموعات الثلاث: افتتاح + حركة فترة + إغلاق.",
      "يُمنع تفسير رصيد الإغلاق كتراكمي YTD لصفوف FLOW — قرار التصنيف لاحق بقرار المستخدم/المحرك لا بافتراض.",
    ],
  },
  CLOSING_ONLY: {
    shape: "CLOSING_ONLY",
    providesOpeningGroup: false,
    providesPeriodMovementGroup: false,
    providesClosingGroup: true,
    closingIsYtdForFlowRows: false,
    autoSuggestionAllowed: true,
    notes: [
      "لا يوفر حركة فترة FLOW إطلاقًا.",
      "زوج الإغلاق زوج BALANCE «كما هو» (as-of) — لا يُفترض أنه YTD.",
    ],
  },
  MOVEMENT_ONLY: {
    shape: "MOVEMENT_ONLY",
    providesOpeningGroup: false,
    providesPeriodMovementGroup: true,
    providesClosingGroup: false,
    closingIsYtdForFlowRows: false,
    autoSuggestionAllowed: true,
    notes: [
      "لا يوفر زوج إغلاق BALANCE إطلاقًا.",
      "زوج الفترة حركة FLOW للفترة المذكورة فقط.",
    ],
  },
  LEGACY: {
    shape: "LEGACY",
    providesOpeningGroup: false,
    providesPeriodMovementGroup: false,
    providesClosingGroup: false,
    closingIsYtdForFlowRows: false,
    autoSuggestionAllowed: false,
    notes: [
      "مسار Excel المصحّح القديم (accounts.ts readExcelFile) — مفهوم محفوظ فقط.",
      "لا يقترحه المستورد الاحترافي تلقائيًا أبدًا؛ اختياره قراءة مستخدم صريحة.",
    ],
  },
};

export interface TbShapeSuggestion {
  suggestion: TbImportShape | null;
  reason: string;
}

/**
 * اقتراح شكل محافظ من الإسنادات الناجحة — اقتراح فقط لا قرار:
 *  • الحقول الثمانية كلها ⇒ FULL_MOVEMENT.
 *  • {كود، اسم، إغلاق مدين، إغلاق دائن} حصرًا ⇒ CLOSING_ONLY.
 *  • {كود، اسم، فترة مدين، فترة دائن} حصرًا ⇒ MOVEMENT_ONLY.
 *  • أي مجموعة إضافية أو نقص ⇒ بلا اقتراح (null) مع سبب — لا تخمين.
 * لا يعيد LEGACY أبدًا (autoSuggestionAllowed=false).
 */
export function suggestTbShape(mapping: TbHeaderMappingResult): TbShapeSuggestion {
  const mapped = new Set(
    TB_CANONICAL_FIELDS.filter((f) => mapping.byField[f] !== undefined),
  );
  const conflicts = mapping.duplicateTargetConflicts.length > 0;
  const allEight = mapped.size === TB_CANONICAL_FIELDS.length;
  const setEquals = (expected: TbCanonicalField[]) =>
    mapped.size === expected.length && expected.every((f) => mapped.has(f));

  if (conflicts) {
    return { suggestion: null, reason: "DUPLICATE_TARGET_CONFLICTS" };
  }
  if (allEight) {
    return { suggestion: "FULL_MOVEMENT", reason: "ALL_EIGHT_FIELDS_MAPPED" };
  }
  if (
    setEquals(["ACCOUNT_CODE", "ACCOUNT_NAME", "CLOSING_DEBIT", "CLOSING_CREDIT"])
  ) {
    return { suggestion: "CLOSING_ONLY", reason: "CODE_NAME_CLOSING_PAIR_ONLY" };
  }
  if (
    setEquals(["ACCOUNT_CODE", "ACCOUNT_NAME", "PERIOD_DEBIT", "PERIOD_CREDIT"])
  ) {
    return { suggestion: "MOVEMENT_ONLY", reason: "CODE_NAME_PERIOD_PAIR_ONLY" };
  }
  if (mapped.size === 0) {
    return { suggestion: null, reason: "NO_FIELDS_MAPPED" };
  }
  return {
    suggestion: null,
    reason: "AMBIGUOUS_FIELD_GROUPS_NO_GUESS",
  };
}

export interface TbShapeResolution {
  shape: TbImportShape | null;
  source: "USER_CONFIRMED" | "SUGGESTED" | "NONE";
  /** true فقط عندما كان هناك شكل مؤكد من المستخدم ولم يُمسّ. */
  userConfirmationPreserved: boolean;
}

/**
 * حسم الشكل: شكل المستخدم المؤكد يعلو دائمًا ولا يُغيَّر صامتًا أبدًا؛
 * الاقتراح يُستخدم فقط بغياب تأكيد صريح.
 */
export function resolveTbShape(
  confirmedShape: TbImportShape | null | undefined,
  suggestion: TbImportShape | null,
): TbShapeResolution {
  if (confirmedShape != null) {
    return {
      shape: confirmedShape,
      source: "USER_CONFIRMED",
      userConfirmationPreserved: true,
    };
  }
  if (suggestion != null) {
    return { shape: suggestion, source: "SUGGESTED", userConfirmationPreserved: false };
  }
  return { shape: null, source: "NONE", userConfirmationPreserved: false };
}

/* ── صفوف المصدر (نصوص خام حصرًا — لا تحويل نقدي) ───────────────────────── */

/** خلية شبكة عامة (يملؤها قارئ excel-grid من xlsx/csv). */
export interface TbGridCell {
  /** النص الخام الظاهر كما في المصدر — لا تحويل أنواع. */
  text: string;
  /** المصدر خزّنها رقميًا (كشف فقط — لا يُستنتج منه شيء آخر). */
  isNumericSource: boolean;
  /** خلية صيغة: لا تُنفَّذ أبدًا من طرفنا — بيانات وصفية فقط. */
  isFormula: boolean;
  /** نص الصيغة كما في الملف (مثل "B2+C2") أو null. */
  formulaText: string | null;
}

export type TbGrid = TbGridCell[][];

export const EMPTY_TB_GRID_CELL: TbGridCell = {
  text: "",
  isNumericSource: false,
  isFormula: false,
  formulaText: null,
};

export interface TbSourceCell {
  rawText: string;
  isNumericSource: boolean;
  isFormula: boolean;
  formulaText: string | null;
}

export interface TbSourceRow {
  /** رقم الصف في الشبكة (1-based كما في xlsx/csv). */
  sourceRowNumber: number;
  accountCodeRaw: string;
  accountCodeIsNumericSource: boolean;
  accountNameRaw: string;
  monetary: Record<TbMonetaryField, TbSourceCell>;
  /** صف فارغ بنيويًا (كل الخلايا المسندة فارغة) — يُبقى ظاهرًا، القرار لاحق. */
  isBlank: boolean;
}

export interface TbExtractRowsInput {
  mapping: TbHeaderMappingResult;
  /** فهرس صف الترويسة الأول في الشبكة (0-based). */
  headerRowIndex: number;
  /** عدد صفوف كتلة الترويسة (1 أو 2). */
  headerRowCount?: number;
}

function cellToSourceCell(cell: TbGridCell | undefined): TbSourceCell {
  if (!cell) return { rawText: "", isNumericSource: false, isFormula: false, formulaText: null };
  return {
    rawText: cell.text,
    isNumericSource: cell.isNumericSource,
    isFormula: cell.isFormula,
    formulaText: cell.formulaText,
  };
}

/**
 * استخلاص صفوف المصدر نصيًا من الشبكة وفق الإسناد — أمانة حفظ خام:
 *  • نصوص المبالغ تُحفظ حرفيًا («(1,234.56)»، «1,234.56»، «00101») بلا أي
 *    تحويل Number/parseFloat/عائم — التحويل لخطوة لاحقة fail-closed.
 *  • أكواد الحسابات معرّفات: «00101» تبقى «00101»؛ الرقمي 101 يبقى «101» مع
 *    علم المصدر الرقمي — لا اختراع أصفار بادئة أبدًا.
 *  • بيانات الصيغ تُحفظ وصفيةً (لا تنفيذ).
 * الصفوف الفارغة تُستخلص بعلم isBlank (الإسقاط البنيوي قرار خطوة لاحقة).
 */
export function extractTbSourceRows(
  grid: TbGrid,
  input: TbExtractRowsInput,
): TbSourceRow[] {
  const { mapping, headerRowIndex } = input;
  const headerRowCount = input.headerRowCount ?? 1;
  const colFor = (field: TbCanonicalField): number | undefined => mapping.byField[field];
  const codeCol = colFor("ACCOUNT_CODE");
  const nameCol = colFor("ACCOUNT_NAME");
  const monetaryCols = new Map<TbMonetaryField, number | undefined>(
    TB_MONETARY_FIELDS.map((f) => [f, colFor(f)]),
  );

  const rows: TbSourceRow[] = [];
  for (let r = headerRowIndex + headerRowCount; r < grid.length; r++) {
    const gridRow = grid[r] ?? [];
    const codeCell = codeCol === undefined ? undefined : gridRow[codeCol];
    const nameCell = nameCol === undefined ? undefined : gridRow[nameCol];
    const monetary = {} as Record<TbMonetaryField, TbSourceCell>;
    let anyMonetary = false;
    let anyMonetaryFlags = false;
    for (const f of TB_MONETARY_FIELDS) {
      const c = monetaryCols.get(f);
      const cell = c === undefined || c === undefined ? undefined : gridRow[c];
      const sc = cellToSourceCell(cell);
      monetary[f] = sc;
      if (sc.rawText.trim() !== "") anyMonetary = true;
      if (sc.isNumericSource || sc.isFormula) anyMonetaryFlags = true;
    }
    const codeRaw = cellToSourceCell(codeCell).rawText;
    const nameRaw = cellToSourceCell(nameCell).rawText;
    const isBlank =
      codeRaw.trim() === "" &&
      nameRaw.trim() === "" &&
      !anyMonetary &&
      !anyMonetaryFlags;
    rows.push({
      sourceRowNumber: r + 1, // 1-based
      accountCodeRaw: codeRaw,
      accountCodeIsNumericSource: cellToSourceCell(codeCell).isNumericSource,
      accountNameRaw: nameRaw,
      monetary,
      isBlank,
    });
  }
  return rows;
}

/* ── كاشفات ن pure ───────────────────────────────────────────────────────── */

function rowSignature(cells: TbGridCell[]): string {
  return cells
    .map((c) => normalizeTbHeader(c?.text ?? ""))
    .join("\u0001");
}

export interface TbRepeatedHeaderResult {
  /** أرقام صفوف (1-based) المطابقة لتوقيع كتلة الترويسة — مرشحة بنيوية فقط. */
  repeatedRowNumbers: number[];
}

/** كشف حتمي لترويسات مكررة تحت كتلة الترويسة الأساسية — كشف فقط لا إسقاط. */
export function detectRepeatedHeaderRows(
  grid: TbGrid,
  headerRowIndex: number,
  headerRowCount = 1,
): TbRepeatedHeaderResult {
  const headerSig = rowSignature(grid[headerRowIndex] ?? []);
  const subSig =
    headerRowCount > 1 ? rowSignature(grid[headerRowIndex + 1] ?? []) : null;
  const repeatedRowNumbers: number[] = [];
  for (let r = headerRowIndex + headerRowCount; r < grid.length; r++) {
    if (rowSignature(grid[r] ?? []) !== headerSig) continue;
    if (subSig !== null) {
      const next = rowSignature(grid[r + 1] ?? []);
      if (next !== subSig) continue;
      repeatedRowNumbers.push(r + 1);
      r++; // الكتلة المطابقة تُستهلك صفّين
      continue;
    }
    repeatedRowNumbers.push(r + 1);
  }
  return { repeatedRowNumbers };
}

/** كلمات اشتباه المجاميع (عربي/إنجليزي) — مطابقة على نص متطبَّع. */
export const TB_SUBTOTAL_KEYWORDS = [
  "subtotal", "total", "sum",
  "اجمالي", "الاجمالي", "مجموع", "المجموع",
] as const;

export interface TbSubtotalFlag {
  sourceRowNumber: number;
  matchedKeyword: string;
  matchedIn: "CODE" | "NAME";
}

/**
 * اشتباه مجاميع — FLAG فقط: لا حذف ولا استبعاد ولا أي تأثير حسابي.
 * (التطبيع يوحّد الألفات ف«الإجمالي» تُطابق «الاجمالي».)
 */
export function flagSuspectedSubtotalRows(rows: TbSourceRow[]): TbSubtotalFlag[] {
  const flags: TbSubtotalFlag[] = [];
  for (const row of rows) {
    const code = normalizeTbHeader(row.accountCodeRaw);
    const name = normalizeTbHeader(row.accountNameRaw);
    for (const kw of TB_SUBTOTAL_KEYWORDS) {
      if (code.includes(kw)) {
        flags.push({ sourceRowNumber: row.sourceRowNumber, matchedKeyword: kw, matchedIn: "CODE" });
        continue;
      }
      if (name.includes(kw)) {
        flags.push({ sourceRowNumber: row.sourceRowNumber, matchedKeyword: kw, matchedIn: "NAME" });
      }
    }
  }
  return flags;
}

export interface TbDuplicateAccountCode {
  accountCode: string;
  count: number;
  sourceRowNumbers: number[];
}

/**
 * كشف تكرار أكواد الحسابات — تقرير فقط:
 * لا تجميع ولا overwrite ولا keep-first/last ولا netting.
 * المقارنة على نص الكود الحرفي («00101» ≠ «101» — معرّفات مختلفة).
 */
export function detectDuplicateAccountCodes(rows: TbSourceRow[]): TbDuplicateAccountCode[] {
  const order: string[] = [];
  const seen = new Map<string, number[]>();
  for (const row of rows) {
    const code = row.accountCodeRaw.trim();
    if (code === "") continue;
    const list = seen.get(code);
    if (list) {
      list.push(row.sourceRowNumber);
    } else {
      seen.set(code, [row.sourceRowNumber]);
      order.push(code);
    }
  }
  const duplicates: TbDuplicateAccountCode[] = [];
  for (const code of order) {
    const rowsForCode = seen.get(code) as number[];
    if (rowsForCode.length > 1) {
      duplicates.push({ accountCode: code, count: rowsForCode.length, sourceRowNumbers: [...rowsForCode] });
    }
  }
  return duplicates;
}
