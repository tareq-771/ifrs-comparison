// ═══════════════════════════════════════════════════════════════════════════
// Phase 7.0 (V1 closure) — TB Importer UI Contract (client-safe, pure)
// عقد الواجهة النقي: رسائل ثنائية اللغة + قواعد تمكين الأزرار + تمييز الحالات.
//
// هذا الملف نقي بلا I/O ولا DB ولا React — تستهلكه الواجهة وتفحصه البوابة،
// مما يجعل «عقد الأمان» للواجهة قابلًا للفحص الآلي حرفيًا بنفس الكود.
// ═══════════════════════════════════════════════════════════════════════════

/** رسائل ثنائية اللغة (عربي أولًا) — الكود الآلي يُعرض دائمًا مع الرسالة. */
export const TB_IMPORT_ERROR_MESSAGES: Record<string, { ar: string; en: string }> = {
  // دلالات الأشكال
  FLOW_CLOSING_SEMANTICS_UNDECLARED: {
    ar: "يجب تحديد أن أرصدة حسابات قائمة الدخل تمثل أرصدة تراكمية حتى الفترة.",
    en: "FLOW closing balances must be explicitly declared cumulative/YTD.",
  },
  BALANCE_MOVEMENT_ONLY_BLOCKED: {
    ar: "ملف حركة الفترة فقط لا يوفر رصيد إقفال لحسابات المركز المالي.",
    en: "Movement-only file provides no closing balance for balance-sheet accounts.",
  },
  // العملة
  FOREIGN_CURRENCY_TB_REQUIRES_FX_PROCESS: {
    ar: "عملة ميزان المراجعة تختلف عن العملة الوظيفية. التحويل بين العملات غير مدعوم في الإصدار الحالي.",
    en: "TB source currency differs from functional currency; FX is not supported in this version.",
  },
  FUNCTIONAL_CURRENCY_UNCONFIGURED: {
    ar: "العملة الوظيفية للشركة غير مهيأة — لا متابعة قبل ضبطها.",
    en: "Company functional currency is not configured.",
  },
  SOURCE_CURRENCY_REQUIRED: {
    ar: "عملة المصدر إلزامية صراحةً — لا افتراض.",
    en: "Source currency must be declared explicitly.",
  },
  // إعادة تحقق الاعتماد
  SOURCE_REVALIDATION_REQUIRED: {
    ar: "يلزم إعادة اختيار ملف المصدر للتحقق منه قبل الاعتماد.",
    en: "Re-select the source file for server revalidation before commit.",
  },
  SOURCE_PAYLOAD_HASH_MISMATCH: {
    ar: "المصدر المُرسل لا يطابق إثبات المسودة المحفوظ — أعد حفظ مسودة جديدة من الملف الصحيح.",
    en: "Submitted source does not match the persisted draft provenance.",
  },
  CANONICAL_LINE_HASH_MISMATCH: {
    ar: "السطور القيانية المعاد اشتقاقها لا تطابق المسودة المحفوظة — أعد حفظ المسودة قبل الاعتماد.",
    en: "Re-derived canonical lines do not match the persisted draft.",
  },
  DRAFT_LINES_MISMATCH: {
    ar: "السطور المخزنة في المسودة لا تطابق السطور المعاد اشتقاقها من المصدر.",
    en: "Stored draft lines differ from re-derived lines.",
  },
  PROVENANCE_MISSING: {
    ar: "لا يوجد إثبات مستورد محفوظ صالح لهذه المسودة — لا اعتماد عبر المستورد V1.",
    en: "No valid importer provenance exists for this draft.",
  },
  // تحقق محاسبي
  DUPLICATE_ACCOUNT_CODE: {
    ar: "كود حساب مكرر بين صفوف التفاصيل — يجب توحيد التكرار (لا تجميع ولا إبقاء الأول/الأخير).",
    en: "Duplicate account code among detail rows.",
  },
  SUBTOTAL_RESOLUTION_REQUIRED: {
    ar: "توجد صفوف مجاميع مشتبهة غير محسومة — قرّار إبقاء/استبعاد صريح لكل صف.",
    en: "Unresolved suspected subtotal rows require explicit KEEP/EXCLUDE.",
  },
  ROW_EQUATION_MISMATCH: {
    ar: "معادلة الصف لا تتحقق: افتتاحي + حركة الفترة = إقفالي.",
    en: "Row equation failed: opening + movement must equal closing.",
  },
  COMPLETE_CONTROL_TOTAL_MISMATCH: {
    ar: "مجاميع ضبط الملف الكامل غير متوازنة (مدين ≠ دائن) — راجع المصدر.",
    en: "Control totals do not balance for a COMPLETE file.",
  },
  SUBSET_ACKNOWLEDGMENT_REQUIRED: {
    ar: "أقرّ بأن الملف ليس ميزان المراجعة الكامل للشركة (جزئي/SUBSET).",
    en: "Explicit SUBSET acknowledgement required.",
  },
  UNRESOLVED_ACCOUNT_CLASSIFICATION: {
    ar: "حساب غير قابل للتصنيف بمحرك التصنيف المعتمد — يلزم قاعدة/تجاوز صريح (لا افتراض OTHER).",
    en: "Account classification unresolved by the authoritative engine.",
  },
  MONETARY_OVERPRECISION: {
    ar: "مبلغ أدق من خانات العملة العشرية المسموحة — لا تقريب صامت أبدًا.",
    en: "Amount exceeds allowed decimal precision; no silent rounding.",
  },
  MONETARY_INVALID: {
    ar: "قيمة نقدية غير قابلة للتحويل الفوري إلى وحدات صغرى.",
    en: "Monetary value cannot be parsed exactly.",
  },
  MULTI_PERIOD_UNSUPPORTED: {
    ar: "المستورد الجديد يدعم فترة واحدة حصرًا — اختر فترة واحدة.",
    en: "Importer V1 supports a single period only.",
  },
  INVALID_CURRENCY_PRECISION: {
    ar: "دقة العملة غير صالحة (عملة غير مهيأة) — لا دقة افتراضية ضمنية.",
    en: "Invalid currency precision configuration.",
  },
  // حوكمة
  INVALID_STATE: {
    ar: "حالة غير صالحة للعملية المطلوبة (مسودة/معتمد/سلسلة مراجعات).",
    en: "Invalid state for the requested operation.",
  },
  DUPLICATE_COMMITTED: {
    ar: "يوجد ميزان معتمد لنفس الشركة/الفترة/النوع — المعتمد لا يُستبدل؛ استخدم مسار المراجعة.",
    en: "A committed TB exists for this chain; use the revision workflow.",
  },
  DUPLICATE_IMPORT: {
    ar: "يوجد استيراد قائم لنفس الشركة/الفترة/النوع — فعّل الاستبدال صراحةً.",
    en: "An import already exists for this chain; enable explicit replacement.",
  },
  VERSION_CONFLICT: {
    ar: "تعارض نسخ: الميزان تغيّر — أعد التحميل ثم أعد المحاولة.",
    en: "Version conflict; reload and retry.",
  },
  FISCAL_LIFECYCLE: {
    ar: "حالة السنة/الفترة المالية لا تسمح بالاعتماد (يتطلب OPEN).",
    en: "Fiscal year/period lifecycle blocks commit (OPEN required).",
  },
  NOT_FOUND: {
    ar: "غير موجود أو لا تملك الوصول.",
    en: "Not found or access denied.",
  },
  EMPTY_FILE: {
    ar: "ملف المصدر فارغ أو شبكة غير صالحة.",
    en: "Source file/grid is empty.",
  },
  INVALID_LINE: {
    ar: "سطر مصدر غير صالح — راجع تفاصيل الأخطاء.",
    en: "Invalid source line; see error details.",
  },
  INVALID_DATA_TYPE: {
    ar: "الشكل المؤكد مطلوب: FULL_MOVEMENT أو CLOSING_ONLY أو MOVEMENT_ONLY.",
    en: "Explicit shape required.",
  },
};

/** رسالة عربية مفهومة مع الاحتفاظ بالكود الآلي لاستكشاف الأخطاء (لا إخفاء للكود). */
export function tbImportErrorLabel(code: string, serverMessage?: string): string {
  const entry = TB_IMPORT_ERROR_MESSAGES[code];
  const ar = entry?.ar ?? serverMessage ?? "خطأ غير متوقع";
  return `${ar} [${code}]`;
}

/* ── تمييز الحالات الثلاث (لا خلط بين معاينة/مسودة/معتمد أبدًا) ───────────── */

export type TbWizardStatus = "PREVIEW" | "DRAFT" | "COMMITTED";

export const TB_WIZARD_STATUS_LABELS: Record<TbWizardStatus, string> = {
  PREVIEW: "معاينة (غير محفوظة)",
  DRAFT: "مسودة",
  COMMITTED: "معتمد",
};

/* ── قواعد تمكين الأزرار (عقد أمان الواجهة — نقية وقابلة للفحص) ──────────── */

export interface TbPreviewLike {
  validationStatus: "VALID" | "BLOCKED";
  persistenceReady: boolean;
}

/** «حفظ المسودة» يُعطَّل ما لم تكن معاينة خادمية حديثة وصالحة (بلا أخطاء مانعة). */
export function canSaveDraft(
  preview: TbPreviewLike | null,
  previewStale: boolean,
): boolean {
  return preview !== null && !previewStale && preview.validationStatus === "VALID" && preview.persistenceReady;
}

export interface TbDraftLike {
  id: string;
  status: string;
}

/** «الاعتماد» يتطلب مسودة محفوظة (DRAFT) + مصدرًا خامًا متاحًا في الجلسة + تأكيدًا صريحًا. */
export function canCommitDraft(draft: TbDraftLike | null, hasRawSource: boolean): boolean {
  return draft !== null && draft.status === "DRAFT" && hasRawSource;
}

/** بعد تحديث المتصفح: المصدر الخام غير موجود ⇒ إعادة اختيار الملف إلزامية (لا تظلم وهمي). */
export function requiresSourceReselection(hasRawSource: boolean, draftExists: boolean): boolean {
  return draftExists && !hasRawSource;
}

/** الاعتماد يتطلب تأكيدًا صريحًا فوريًا قبل التنفيذ — ثابت عقدي تفحصه البوابة. */
export const TB_COMMIT_REQUIRES_EXPLICIT_CONFIRMATION = true;
