// Phase 6.1 — السنة المالية والفترات الشهرية: الثوابت + خوارزمية التوليد + الخدمات.
//
// قرارات التصميم المطبقة (6.0A + تعليمات 6.1 §§7-10):
//   - لا افتراض سنوات ميلادية ولا افتراض 12 فترة (سنوات انتقالية/قصيرة مدعومة).
//   - القاعدة الموثقة لخوارزمية التوليد (الخيار B — رفض صريح لا اختراع حدود):
//       * يجب أن تبدأ السنة المالية في اليوم الأول من شهر (YYYY-MM-01).
//       * يجب أن تنتهي في آخر يوم من شهره.
//       * الفترات = أشهر تقويمية متتالية تغطي [startDate, endDate] حرفيًا
//         بلا فجوات ولا تداخلات؛ الفترة الأخيرة تنتهي حرفيًا عند endDate.
//     أي نموذج آخر (بداية منتصف شهر/نهاية قبل آخر اليوم/4-4-5) يُرفض برسالة
//     واضحة (PERIOD_MODEL_UNSUPPORTED) — لا تُخترع حدود فترات أبدًا.
//   - الحالات OPEN/CLOSED/LOCKED مع انتقالات مُتحقق منها خادميًا؛ إعادة الفتح
//     وفك القفل تتطلبان صلاحية + سببًا إلزاميًا + حدث تدقيق.
//   - لا حسابات إقفال مالية في 6.1 إطلاقًا (طبقة القوائم لاحقًا).

import { db } from "@/lib/db";
import { isValidDateOnly } from "@/lib/workflow";
import { COMPANY_STATUS } from "@/lib/company";
import { resolveCompanyScope } from "@/lib/company-access";

/* ──────────────────────────────────────────────────────────────────────── */
/*  الثوابت                                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

export const FISCAL_YEAR_STATUS = {
  OPEN: "OPEN",
  CLOSED: "CLOSED",
  LOCKED: "LOCKED",
} as const;

export type FiscalYearStatus = (typeof FISCAL_YEAR_STATUS)[keyof typeof FISCAL_YEAR_STATUS];

export function isFiscalYearStatus(v: unknown): v is FiscalYearStatus {
  return v === FISCAL_YEAR_STATUS.OPEN || v === FISCAL_YEAR_STATUS.CLOSED || v === FISCAL_YEAR_STATUS.LOCKED;
}

export const FISCAL_YEAR_STATUS_LABELS: Record<FiscalYearStatus, string> = {
  OPEN: "مفتوحة",
  CLOSED: "مغلقة",
  LOCKED: "مقفلة",
};

/**
 * انتقالات الحالة المسموحة (خادميًا حصرًا):
 *   OPEN→CLOSED (إغلاق) | CLOSED→LOCKED (قفل) | CLOSED→OPEN (إعادة فتح — سبب إلزامي)
 *   LOCKED→CLOSED (فك القفل — سبب إلزامي). لا قفزات ولا إعادة فتح من LOCKED مباشرة.
 */
export const FISCAL_YEAR_TRANSITIONS: Record<FiscalYearStatus, FiscalYearStatus[]> = {
  OPEN: [FISCAL_YEAR_STATUS.CLOSED],
  CLOSED: [FISCAL_YEAR_STATUS.LOCKED, FISCAL_YEAR_STATUS.OPEN],
  LOCKED: [FISCAL_YEAR_STATUS.CLOSED],
};

export const FISCAL_YEAR_ORIGIN = {
  USER_CREATED: "USER_CREATED",
  PROVISIONAL_IMPORTED: "PROVISIONAL_IMPORTED",
} as const;

export type FiscalYearOrigin = (typeof FISCAL_YEAR_ORIGIN)[keyof typeof FISCAL_YEAR_ORIGIN];

/** سقف صحي أقصى لعدد الفترات (يشمل السنوات القصيرة والانتقالية — لا افتراض 12). */
export const MAX_PERIODS_PER_FISCAL_YEAR = 24;

export const FISCAL_PERIOD_STATUS = {
  OPEN: "OPEN",
  CLOSED: "CLOSED",
} as const;

export type FiscalPeriodStatus = (typeof FISCAL_PERIOD_STATUS)[keyof typeof FISCAL_PERIOD_STATUS];

/* ──────────────────────────────────────────────────────────────────────── */
/*  أدوات تواريخ date-only (بلا timezone — نمط المشروع "YYYY-MM-DD")         */
/* ──────────────────────────────────────────────────────────────────────── */

function parseDateOnly(v: string): { y: number; m: number; d: number } | null {
  if (!isValidDateOnly(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  return { y, m, d };
}

/** آخر يوم من شهر (date-only). */
export function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** هل التاريخ آخر يوم في شهره؟ */
export function isMonthEnd(v: string): boolean {
  const p = parseDateOnly(v);
  if (!p) return false;
  return p.d === lastDayOfMonth(p.y, p.m);
}

/** مقارنة معجمية آمنة للتواريخ date-only (نفس الصيغة = ترتيب زمني صحيح). */
export function dateOnlyCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** إزاحة شهر على تاريخ أول شهر (يحافظ على day=1). */
function addMonthsOnFirstDay(y: number, m: number, k: number): string {
  const total = y * 12 + (m - 1) + k;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

/** تسمية عربية للشهر (عرض فقط — ليست هوية؛ الهوية ordinal/code). */
const AR_MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
] as const;

/* ──────────────────────────────────────────────────────────────────────── */
/*  خوارزمية توليد الفترات الشهرية — نقية وقابلة للاختبار المباشر            */
/* ──────────────────────────────────────────────────────────────────────── */

export interface GeneratedPeriod {
  ordinal: number;
  code: string;      // "YYYY-MM" من بداية الفترة — مشتق حتمي
  startDate: string; // date-only
  endDate: string;   // date-only
  displayLabel: string; // عرض عربي فقط
}

export type PeriodGenerationResult =
  | { ok: true; periods: GeneratedPeriod[] }
  | { ok: false; code: "DATE_INVALID" | "RANGE_INVALID" | "PERIOD_MODEL_UNSUPPORTED" | "SPAN_TOO_LONG"; message: string };

/**
 * توليد فترات شهرية متتالية تغطي [startDate, endDate] حرفيًا:
 *   - بلا فجوات: نهاية كل فترة = اليوم السابق لبداية التالية.
 *   - بلا تداخلات: ordinal متسلسل من 1.
 *   - الرفض الصريح (لا اختراع حدود): بداية ليست أول الشهر / نهاية ليست آخر الشهر /
 *     نطاق مقلوب / امتداد > 24 شهرًا.
 * أمثلة مُختبرة إلزاميًا:
 *   2026-01-01→2026-12-31 = 12 | 2026-07-01→2027-06-30 = 12 | 2026-01-01→2026-03-31 = 3
 */
export function generateMonthlyPeriods(startDate: string, endDate: string): PeriodGenerationResult {
  const s = parseDateOnly(startDate);
  const e = parseDateOnly(endDate);
  if (!s || !e) {
    return { ok: false, code: "DATE_INVALID", message: "التواريخ يجب أن تكون بصيغة date-only صالحة YYYY-MM-DD." };
  }
  if (dateOnlyCompare(startDate, endDate) > 0) {
    return { ok: false, code: "RANGE_INVALID", message: "نطاق السنة المالية مقلوب — البداية يجب أن تسبق النهاية أو تساويها." };
  }
  // القاعدة الموثقة: بداية أول الشهر + نهاية آخر الشهر — وإلا رفض صريح (الخيار B).
  if (s.d !== 1) {
    return {
      ok: false,
      code: "PERIOD_MODEL_UNSUPPORTED",
      message: `النموذج الشهري يتطلب بدء السنة المالية في اليوم الأول من شهر — البداية المعطاة ${startDate}. لا تُخترع فترات جزئية.`,
    };
  }
  if (!isMonthEnd(endDate)) {
    return {
      ok: false,
      code: "PERIOD_MODEL_UNSUPPORTED",
      message: `النموذج الشهري يتطلب انتهاء السنة المالية في آخر يوم من شهره — النهاية المعطاة ${endDate}. لا تُخترع فترات جزئية.`,
    };
  }

  const periods: GeneratedPeriod[] = [];
  let cursorY = s.y;
  let cursorM = s.m;
  let ordinal = 1;
  while (true) {
    const pStart = `${String(cursorY).padStart(4, "0")}-${String(cursorM).padStart(2, "0")}-01`;
    const monthEnd = `${String(cursorY).padStart(4, "0")}-${String(cursorM).padStart(2, "0")}-${String(
      lastDayOfMonth(cursorY, cursorM)
    ).padStart(2, "0")}`;
    // الفترة الأخيرة تنتهي حرفيًا عند endDate (وهو آخر شهره بفحص أعلاه)
    const pEnd = dateOnlyCompare(monthEnd, endDate) > 0 ? endDate : monthEnd;
    periods.push({
      ordinal,
      code: `${String(cursorY).padStart(4, "0")}-${String(cursorM).padStart(2, "0")}`,
      startDate: pStart,
      endDate: pEnd,
      displayLabel: `${AR_MONTHS[cursorM - 1]} ${cursorY}`,
    });
    if (dateOnlyCompare(pEnd, endDate) >= 0) break;
    const next = addMonthsOnFirstDay(cursorY, cursorM, 1);
    cursorY = Number(next.slice(0, 4));
    cursorM = Number(next.slice(5, 7));
    ordinal += 1;
    if (ordinal > MAX_PERIODS_PER_FISCAL_YEAR) {
      return {
        ok: false,
        code: "SPAN_TOO_LONG",
        message: `امتداد السنة المالية يتجاوز الحد الأقصى ${MAX_PERIODS_PER_FISCAL_YEAR} فترة شهرية — راجع النطاق.`,
      };
    }
  }
  return { ok: true, periods };
}

/** هل تفسد فترات مولّدة خاصية التغطية الحرفية (تسلسل متصل بلا فجوات/تداخلات)؟ */
export function verifyPeriodCoverage(
  periods: Array<{ ordinal: number; startDate: string; endDate: string }>,
  startDate: string,
  endDate: string
): { ok: boolean; reason?: string } {
  if (periods.length === 0) return { ok: false, reason: "NO_PERIODS" };
  const sorted = [...periods].sort((a, b) => a.ordinal - b.ordinal);
  if (sorted[0].startDate !== startDate) return { ok: false, reason: "START_MISMATCH" };
  if (sorted[sorted.length - 1].endDate !== endDate) return { ok: false, reason: "END_MISMATCH" };
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (dateOnlyCompare(p.startDate, p.endDate) > 0) return { ok: false, reason: `PERIOD_${p.ordinal}_INVERTED` };
    if (i > 0) {
      const prev = sorted[i - 1];
      // التسلسل: بداية الحالية = اليوم التالي لنهاية السابقة (بلا فجوة ولا تداخل)
      const expected = nextDay(prev.endDate);
      if (p.startDate !== expected) return { ok: false, reason: `GAP_OR_OVERLAP_AT_${p.ordinal}` };
    }
  }
  return { ok: true };
}

function nextDay(v: string): string {
  const p = parseDateOnly(v)!;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return dt.toISOString().slice(0, 10);
}

/** تداخل نطاقين مغلقي [start, end] — أساس فحص تداخل السنوات للشركة نفسها. */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return dateOnlyCompare(aStart, bEnd) <= 0 && dateOnlyCompare(bStart, aEnd) <= 0;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  الخدمات الخادمية (Prisma + تدقيق)                                        */
/* ──────────────────────────────────────────────────────────────────────── */

export class FiscalYearError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FiscalYearError";
    this.code = code;
  }
}

export interface CreateFiscalYearInput {
  companyId: string;
  code: string;
  displayNameAr?: string;
  displayNameEn?: string;
  startDate: string;
  endDate: string;
}

/**
 * فحص مسبق موحّد (يُستخدم في الإنشاء الفردي والجماعي وأداة الربط):
 * لا يكتب شيئًا — يقرأ فقط ويعيد سبب الرفض الرمزي إن وجد.
 */
export async function prevalidateFiscalYear(
  input: CreateFiscalYearInput,
  opts: { companyStatus?: string } = {}
): Promise<{ ok: true; periods: GeneratedPeriod[] } | { ok: false; code: string; message: string }> {
  const company = await db.company.findUnique({ where: { id: input.companyId } });
  if (!company) return { ok: false, code: "COMPANY_NOT_FOUND", message: "الشركة غير موجودة" };

  // صلاحية الرؤية تُفحص عند المستدعي (company-access) — هنا قواعد الأعمال:
  const status = opts.companyStatus ?? company.status;
  if (status !== COMPANY_STATUS.ACTIVE) {
    return { ok: false, code: "COMPANY_INACTIVE", message: "الشركة موقوفة — لا يمكن إنشاء سنوات مالية عليها (التعطيل يجمّد الإنشاء ولا يخفي التاريخ)." };
  }

  const gen = generateMonthlyPeriods(input.startDate, input.endDate);
  if (!gen.ok) return { ok: false, code: gen.code, message: gen.message };

  const code = (input.code ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(code)) {
    return { ok: false, code: "FY_CODE_INVALID", message: "كود السنة المالية إلزامي (1..40 حرفًا/رقمًا/شرطة) ووحيد داخل الشركة." };
  }
  const dupCode = await db.fiscalYear.findUnique({
    where: { companyId_code: { companyId: input.companyId, code } },
    select: { id: true },
  });
  if (dupCode) return { ok: false, code: "FY_CODE_DUPLICATE", message: `كود السنة المالية «${code}» مستخدم مسبقًا لهذه الشركة.` };

  const overlapping = await db.fiscalYear.findMany({
    where: { companyId: input.companyId },
    select: { id: true, code: true, startDate: true, endDate: true },
  });
  const clash = overlapping.find((fy) => rangesOverlap(input.startDate, input.endDate, fy.startDate, fy.endDate));
  if (clash) {
    return {
      ok: false,
      code: "FY_OVERLAP",
      message: `تداخل مع السنة المالية «${clash.code}» (${clash.startDate} → ${clash.endDate}) — لا يجوز أن تتداخل سنوات الشركة نفسها.`,
    };
  }
  return { ok: true, periods: gen.periods };
}

/** تغليف كتابة السنة + فتراتها داخل معاملة (يكفي صف واحد ذري). */
export async function writeFiscalYearWithPeriods(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  input: CreateFiscalYearInput,
  periods: GeneratedPeriod[],
  meta: { origin: FiscalYearOrigin; actorId: string | null; actorName: string }
) {
  const coverage = verifyPeriodCoverage(periods, input.startDate, input.endDate);
  if (!coverage.ok) {
    throw new FiscalYearError("PERIOD_COVERAGE_BROKEN", `فشل فحص التغطية: ${coverage.reason}`);
  }
  return tx.fiscalYear.create({
    data: {
      companyId: input.companyId,
      code: input.code.trim(),
      displayNameAr: (input.displayNameAr ?? "").slice(0, 200),
      displayNameEn: (input.displayNameEn ?? "").slice(0, 200),
      startDate: input.startDate,
      endDate: input.endDate,
      periodCount: periods.length,
      status: FISCAL_YEAR_STATUS.OPEN,
      origin: meta.origin,
      periods: {
        create: periods.map((p) => ({
          ordinal: p.ordinal,
          code: p.code,
          startDate: p.startDate,
          endDate: p.endDate,
          displayLabel: p.displayLabel,
        })),
      },
    },
    include: { periods: { orderBy: { ordinal: "asc" } } },
  });
}

/**
 * بوابة الرؤية الموحدة لسنة مالية عبر شركتها — fail-closed على مستوى الشركة.
 * تُستخدم في كل مسار fiscal-years قبل أي قراءة/كتابة.
 */
export async function assertFiscalYearVisible(
  fiscalYearId: string,
  user: { role: string; permissions: { companyIds?: string[]; viewAllCompanies?: boolean } }
) {
  const fy = await db.fiscalYear.findUnique({
    where: { id: fiscalYearId },
    include: { company: { select: { id: true, status: true, code: true, nameAr: true } } },
  });
  if (!fy) throw new FiscalYearError("FY_NOT_FOUND", "السنة المالية غير موجودة");
  const scope = resolveCompanyScope(user);
  const visible = scope.mode === "ALL" || (scope.mode === "LIST" && scope.companyIds.includes(fy.companyId));
  if (!visible) throw new FiscalYearError("FY_FORBIDDEN", "لا تملك صلاحية الوصول لشركة هذه السنة المالية");
  return fy;
}
