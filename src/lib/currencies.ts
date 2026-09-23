// Phase 6.1 — أساس العملات ISO-4217 (وحدة نقية — آمنة للاستيراد في العميل والخادم).
//
// قرار التصميم 6.0A:
//   - سجل عملات موسّع بالثوابت — إضافة عملة ISO جديدة = إضافة سجل هنا فقط
//     بلا أي ترحيل مخطط (الحقول نصية في القاعدة والتحقق من هذا السجل).
//   - الهوية الآلية = كود ISO-4217 alpha-3 الحرفي (YER/SAR/USD...) — الأسماء
//     المعروضة توصيف فقط ولا تُستخدم مفاتيح هوية أبدًا.
//   - لا تحويل عملات ولا ترجمة ولا توحيد قوائم في 6.1 إطلاقًا (مراحل لاحقة).
//   - عملة الشركة الوظيفية قد تبقى فارغة حتى أول استخدام مالي (قرار 6.0A)؛
//     عملة الإبلاغ تُشتق منطقيًا من الوظيفية حيثما اقتضى الأمر.
//
// ⚠️ لا تُطبَّع القيم المالية إلى minor units في 6.1 — جداول FinancialStatement/
//    Budget ليست جزءًا من هذه المرحلة؛ سياسة amountMinor تُفعَّل مع 6.2.

export interface CurrencyInfo {
  /** كود ISO-4217 alpha-3 — الهوية الآلية الحرفية. */
  code: string;
  /** الرقم ISO-4217 numeric (للتوثيق والتحقق المتقاطع مستقبلًا). */
  numericCode: string;
  /** عدد الخانات العشرية القياسية ISO-4217 (توثيقي في 6.1 — لا تطبيع قيم بعد). */
  minorUnits: number;
  /** الاسم المعروض بالعربية (توصيف فقط — ليس هوية). */
  nameAr: string;
  /** الاسم الإنجليزي (توصيف فقط). */
  nameEn: string;
}

/**
 * سجل العملات المدعومة — بنية قابلة للتوسيع بلا ترحيل:
 * أضف سجلًا جديدًا هنا وستُقبل فورًا في كل نقاط التحقق.
 * المجموعة الابتدائية (قرار المستخدم): العملة الحالية YER + SAR + USD.
 */
export const CURRENCIES: Record<string, CurrencyInfo> = {
  YER: {
    code: "YER",
    numericCode: "886",
    minorUnits: 2,
    nameAr: "ريال يمني",
    nameEn: "Yemeni Rial",
  },
  SAR: {
    code: "SAR",
    numericCode: "682",
    minorUnits: 2,
    nameAr: "ريال سعودي",
    nameEn: "Saudi Riyal",
  },
  USD: {
    code: "USD",
    numericCode: "840",
    minorUnits: 2,
    nameAr: "دولار أمريكي",
    nameEn: "US Dollar",
  },
} as const;

/** هل الكود عملة مدعومة؟ (كود ISO alpha-3 حرفي من السجل) */
export function isSupportedCurrency(code: unknown): code is string {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

/** التحقق الصارم لقيمة عملة قادمة من العميل/الأداة — يعيد كودًا مطبعًا أو خطأ رمزي. */
export function validateCurrencyCode(
  raw: unknown
): { ok: true; code: string } | { ok: false; reason: "MISSING" | "UNKNOWN" } {
  if (raw === null || raw === undefined || raw === "") return { ok: false, reason: "MISSING" };
  const code = String(raw).trim().toUpperCase();
  if (!isSupportedCurrency(code)) return { ok: false, reason: "UNKNOWN" };
  return { ok: true, code };
}

/** قائمة العملات للعرض في الواجهة (ترتيب ثابت بالكود). */
export function currencyOptions(): Array<CurrencyInfo> {
  return Object.values(CURRENCIES).sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * قاعدة الاشتقاق الموثقة: عملة الإبلاغ الافتراضية = العملة الوظيفية
 * (حيثما اقتضى الأمر — لا تحويل هنا إطلاقًا).
 */
export function deriveReportingCurrency(functionalCurrency: string | null | undefined): string {
  return isSupportedCurrency(functionalCurrency) ? functionalCurrency : "";
}
