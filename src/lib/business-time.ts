// المرحلة 3.5 — توقيت الأعمال المركزي (قرار D-3 المعتمد)
//
// «اليوم» لحساب المتأخر يُحسب من الخادم حصرًا بإزاحة ثابتة واحدة قابلة للتغيير
// عبر متغير البيئة BUSINESS_TZ_OFFSET_MINUTES (دقائق عن UTC).
// الافتراضي +180 (UTC+3) — لكنه ليس مثبتًا في الكود: تغيير واحد مركزي يكفي.
//
// لماذا إزاحة ثابتة لا اسم منطقة زمنية؟ التخزين date-only (بلا timezone) والحساب
// بأيام تقويمية Calendar Days — الإزاحة الثابتة تحسم حدود اليوم تحديدًا وبلا
// غموض التوقيت الصيفي. إن لزم مستقبلًا اسم IANA (لتغير DST) يُستبدل هنا فقط
// في هذه الوحدة دون أي تغيير في المستهلكين.
//
// الوحدة نقية (آمنة للاستيراد في الخادم) — العميل لا يحسب «اليوم» أبدًا؛
// يستقبل قيمة today من استجابات الخادم.

export const DEFAULT_BUSINESS_TZ_OFFSET_MINUTES = 180; // UTC+3

/** قراءة الإزاحة من البيئة مرة واحدة لكل عملية — قيمة خادمية مركزية واحدة. */
export function businessTzOffsetMinutes(): number {
  const raw = process.env.BUSINESS_TZ_OFFSET_MINUTES;
  if (raw === undefined || raw === "") return DEFAULT_BUSINESS_TZ_OFFSET_MINUTES;
  const n = Number(raw);
  // نطاق الإزاحات المعقول: -12:00 … +14:00
  if (!Number.isInteger(n) || n < -720 || n > 840) return DEFAULT_BUSINESS_TZ_OFFSET_MINUTES;
  return n;
}

/**
 * تاريخ اليوم بتوقيت الأعمال — نص date-only "YYYY-MM-DD".
 * الحساب: إزاحة الحاضر بمقدار الإزاحة ثم قراءة مكوّنات UTC ⇒ جدار زمني في المنطقة.
 */
export function businessToday(now: Date = new Date(), offsetMinutes?: number): string {
  const off = offsetMinutes ?? businessTzOffsetMinutes();
  const shifted = new Date(now.getTime() + off * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * فرق الأيام التقويمية بين تاريخين date-only: to − from (قد يكون سالبًا).
 * مثال: today=2026-09-20, dueDate=2026-09-19 ⇒ daysOverdue = 1 (اليوم التالي للاستحقاق).
 */
export function calendarDaysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const fromUtc = Date.UTC(fy, fm - 1, fd);
  const toUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((toUtc - fromUtc) / 86_400_000);
}
