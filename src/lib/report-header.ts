// 6.8 — بناء بيانات ترويسة التقرير الموحدة (نقية، قابلة للاختبار على الخادم والعميل).
// كل القيم تأتي من خصائص ممرَّرة — لا hard-code لأي شركة أو سنة أو عملة أو فترة.
// المصدر الوحيد للأرقام يبقى خدمات التقارير الحالية (6.2C–6.6) — هذه الطبقة عرض فقط.

/** حالة التقرير المعروضة (تظهر في الترويسة وشارة الحالة). */
export type ReportStatusKind =
  | "DRAFT"
  | "APPROVED"
  | "PRELIMINARY"
  | "INCOMPLETE_DATA";

export const REPORT_STATUS_LABELS: Record<ReportStatusKind, string> = {
  DRAFT: "مسودة",
  APPROVED: "معتمد",
  PRELIMINARY: "أولي (Preliminary)",
  INCOMPLETE_DATA: "بيانات غير مكتملة (INCOMPLETE_DATA)",
};

export const REPORT_STATUS_NOTICE: Partial<Record<ReportStatusKind, string>> = {
  PRELIMINARY:
    "قوائم موحدة أولية — Preliminary Consolidated Statements: لا تتضمن سيطرة أقلية NCI أو شهرة استحواذ أو محاسبة استحواذ أو فروق عملة (مراحل لاحقة)، والنتيجة تعتمد على اكتمال بيانات الأعضاء والاستبعادات المرحّلة.",
  INCOMPLETE_DATA:
    "التقرير مبني على بيانات غير مكتملة — العناصر الناقصة معلنة داخل التقرير ولا تُعوَّض بأصفار أو plug.",
};

/** تسميات نوع البيانات (نفس مفاهيم 6.2B حرفيًا — بلا تخمين). */
export const REPORT_DATA_TYPE_LABELS: Record<string, string> = {
  CUMULATIVE_YTD: "تراكمي من بداية السنة (CUMULATIVE_YTD)",
  PERIOD_MOVEMENT: "حركة الفترة (PERIOD_MOVEMENT)",
  YTD: "تراكمي من بداية السنة (YTD)",
  PERIOD: "حركة الفترة فقط",
};

export interface ReportHeaderMetaInput {
  /** الاسم الرسمي للنظام — يُمرَّر دائمًا (الافتراض: الاسم الرسمي المعتمد للنظام). */
  systemName?: string;
  companyCode: string | null | undefined;
  companyName: string | null | undefined;
  reportTitle: string;
  fiscalYearCode: string | null | undefined;
  fiscalYearLabel?: string | null;
  /** تسمية الفترة المعروضة (بند القائمة/المدى) — اختيارية عند التقرير بالتواريخ. */
  periodLabel?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  currency?: string | null;
  /** نوع البيانات عند الصلة (CUMULATIVE_YTD / PERIOD_MOVEMENT / ...). */
  dataType?: string | null;
  /** الحالة الصريحة؛ INCOMPLETE_DATA تتفوق على غيرها عند تمريرها. */
  status: ReportStatusKind;
  /** تعارض اختياري يعلنه التقرير نفسه (مثل فرق مطابقة غير صفري). */
  statusNotice?: string | null;
  /** تاريخ ووقت الطباعة/العرض — افتراضيًا اللحظة الحالية. */
  printedAt?: Date;
  /** لغة/تنسيق التاريخ — افتراضي عربي بأرقام لاتينية. */
  locale?: string;
}

export interface ReportHeaderMeta {
  systemName: string;
  companyCode: string;
  companyName: string;
  companyLine: string;
  reportTitle: string;
  fiscalYearCode: string;
  fiscalYearLabel: string;
  /** سطر الفترة/المدى الكامل (شامل التواريخ إن توفرت). */
  periodLine: string;
  periodLabel: string;
  fromDate: string;
  toDate: string;
  currency: string;
  dataType: string | null;
  dataTypeLabel: string | null;
  status: ReportStatusKind;
  statusLabel: string;
  /** إشعار الحالة الموحد (preliminary / incomplete / تعارض التقرير). */
  statusNotice: string | null;
  printedAtLabel: string;
  /** عنوان المستند لطباعة/تسمية ملف PDF. */
  documentTitle: string;
}

const DEFAULT_SYSTEM_NAME = "نظام التقارير المالية الموحدة";

function safe(v: string | null | undefined, fallback = "—"): string {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : fallback;
}

/** تنسيق تاريخ ISO (YYYY-MM-DD) كما هو — بلا تحويلات منطقة زمنية تفسد اليوم. */
function isoDateLabel(v: string | null | undefined): string {
  const t = (v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : safe(v);
}

/** تاريخ ووقت الطباعة بالأرقام اللاتينية (مقروء ومتسق في الطباعة). */
function formatPrintedAt(d: Date, locale: string): string {
  try {
    const date = new Intl.DateTimeFormat(locale, {
      dateStyle: "long",
      numberingSystem: "latn",
    }).format(d);
    const time = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      numberingSystem: "latn",
    }).format(d);
    return `${date} — ${time}`;
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

/**
 * بناء بيانات الترويسة من مكونات مصدرها DTOs الخدمات — نقية وحتمية.
 * لا تفترض سنة تقويمية ولا فترة شهرية ولا عملة معينة.
 */
export function buildReportHeaderMeta(input: ReportHeaderMetaInput): ReportHeaderMeta {
  const companyCode = safe(input.companyCode);
  const companyName = safe(input.companyName);
  const fiscalYearCode = safe(input.fiscalYearCode);
  const fiscalYearLabel = safe(input.fiscalYearLabel ?? null, "");
  const periodLabel = safe(input.periodLabel ?? null, "");
  const fromDate = isoDateLabel(input.fromDate ?? null);
  const toDate = isoDateLabel(input.toDate ?? null);
  const currency = safe(input.currency ?? null, "");

  // سطر الفترة: التسمية أولاً ثم المدى بالتواريخ إن توفر — سنة مالية غير تقويمية آمنة.
  const rangeParts: string[] = [];
  if (fromDate && toDate) rangeParts.push(`${fromDate} → ${toDate}`);
  const periodLineParts: string[] = [];
  if (periodLabel) periodLineParts.push(periodLabel);
  if (rangeParts.length > 0) periodLineParts.push(rangeParts[0]);
  const periodLine = safe(periodLineParts.join(" · "), "—");

  const dataType = (input.dataType ?? "").trim() || null;
  const dataTypeLabel = dataType
    ? REPORT_DATA_TYPE_LABELS[dataType] ?? dataType
    : null;

  const status: ReportStatusKind = input.status;
  const notices: string[] = [];
  if (REPORT_STATUS_NOTICE[status]) notices.push(REPORT_STATUS_NOTICE[status]!);
  if (input.statusNotice) notices.push(input.statusNotice);

  const printedAt = input.printedAt ?? new Date();
  const locale = input.locale ?? "ar";
  const printedAtLabel = formatPrintedAt(printedAt, locale);

  const companyLine = `${companyCode} — ${companyName}`;
  const fyLine = fiscalYearLabel
    ? `${fiscalYearCode} (${fiscalYearLabel})`
    : fiscalYearCode;
  const documentTitle = [
    DEFAULT_SYSTEM_NAME,
    companyName !== "—" ? companyName : null,
    input.reportTitle,
    fiscalYearCode !== "—" ? fiscalYearCode : null,
    periodLabel !== "—" ? periodLabel : null,
  ]
    .filter(Boolean)
    .join(" - ");

  return {
    systemName: safe(input.systemName, DEFAULT_SYSTEM_NAME),
    companyCode,
    companyName,
    companyLine,
    reportTitle: input.reportTitle,
    fiscalYearCode,
    fiscalYearLabel,
    periodLine,
    periodLabel,
    fromDate,
    toDate,
    currency,
    dataType,
    dataTypeLabel,
    status,
    statusLabel: REPORT_STATUS_LABELS[status],
    statusNotice: notices.length > 0 ? notices.join(" ") : null,
    printedAtLabel,
    documentTitle,
  };
}
