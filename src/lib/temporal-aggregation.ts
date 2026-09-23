// Phase 6.2A — خدمة التجميع الزمني المركزية (وحدة نقية — client+server safe).
//
// الطبقة الوحيدة المعتمدة لاحقًا في: Monthly Reports / YTD / Actual vs Budget /
// Actual vs Prior Year / Forecast / القوائم المالية. يُمنع إعادة كتابة منطق
// FLOW/BALANCE داخل أي تقرير (قرار المستخدم 6.2A حرفيًا — قاعدة مركزية reusable).
//
// الدلالة المحاسبية (أمثلة المستخدم المعتمدة):
//   FLOW:    يناير 100، فبراير 120، مارس 80  ⇒ YTD مارس = 300.
//   BALANCE: نقدية إقفال يناير 100، فبراير 140، مارس 125 ⇒ As-of مارس = 125 (ليس 365).
//
// الضوابط:
//   - الفترات تُحدد بـ periodOrdinal (1..N) داخل سنتها المالية — لا افتراض
//     يناير ولا سنة ميلادية (سنة 2027-07-01 → 2028-06-30 تعمل بالمثل).
//   - YTD يبدأ من أول فترة في السنة المالية (ordinal=1) — حرفيًا.
//   - صرامة افتراضية: فجوة في سلسلة FLOW ⇒ INCOMPLETE_DATA (لا أرقام توحي
//     بالاكتمال وهي ناقصة — قرار 6.0A رقم 8).
//   - المبالغ bigint بوحدات secondary (amountMinor) — قرار 6.0A رقم 3.
//   - رصيد الافتتاح: لا يُختلق من لا شيء — انظر reconcileBalanceMovements أدناه.

import { AccountNatureError, type AggregationBehavior } from "./account-nature";

/* ──────────────────────────────────────────────────────────────────────────
 * الأنواع والأخطاء
 * ────────────────────────────────────────────────────────────────────────── */

/** قيمة فترة واحدة داخل سنة مالية — المبلغ بوحدات secondary (amountMinor). */
export interface PeriodAmountEntry {
  /** ترتيب الفترة داخل سنتها المالية (1..N) — أساس كل الحسابات، لا أشهر ميلادية. */
  periodOrdinal: number;
  /** المبلغ بوحدات secondary (bigint — منع أي فقد دقة Number). */
  amountMinor: bigint;
}

export type AggregationErrorCode =
  | "NEEDS_CLASSIFICATION"
  | "INCOMPLETE_DATA"
  | "DUPLICATE_PERIOD"
  | "INVALID_PERIOD"
  | "EMPTY_SERIES";

export class AggregationError extends Error {
  code: AggregationErrorCode;
  detail?: Record<string, unknown>;
  constructor(code: AggregationErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.name = "AggregationError";
    this.detail = detail;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * أدوات السلسلة الداخلية
 * ────────────────────────────────────────────────────────────────────────── */

/** نسخة مرتبة حسب ordinal + رفض التكرار والقيم غير الصالحة (نقية — بلا Side effects). */
function sortedValidated(entries: readonly PeriodAmountEntry[]): PeriodAmountEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new AggregationError("EMPTY_SERIES", "سلسلة قيم الفترات فارغة — لا أساس لأي حساب مالي.");
  }
  const seen = new Set<number>();
  const out: PeriodAmountEntry[] = [];
  for (const e of entries) {
    const ordinal = Number(e?.periodOrdinal);
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      throw new AggregationError("INVALID_PERIOD", `ترتيب فترة غير صالح: ${String(e?.periodOrdinal)}`);
    }
    if (seen.has(ordinal)) {
      throw new AggregationError("DUPLICATE_PERIOD", `قيمة مكررة لترتيب الفترة ${ordinal}.`, { periodOrdinal: ordinal });
    }
    if (typeof e.amountMinor !== "bigint") {
      throw new AggregationError("INVALID_PERIOD", `مبلغ الفترة ${ordinal} ليس bigint (amountMinor إلزامي).`, { periodOrdinal: ordinal });
    }
    seen.add(ordinal);
    out.push({ periodOrdinal: ordinal, amountMinor: e.amountMinor });
  }
  out.sort((a, b) => a.periodOrdinal - b.periodOrdinal);
  return out;
}

/** لقطة بالترتيب (ordinal → amount) — تستدعى بعد sortedValidated فقط. */
function indexByOrdinal(sorted: readonly PeriodAmountEntry[]): Map<number, bigint> {
  const map = new Map<number, bigint>();
  for (const e of sorted) map.set(e.periodOrdinal, e.amountMinor);
  return map;
}

/* ──────────────────────────────────────────────────────────────────────────
 * الدوال الحاكمة — aggregateYTD / aggregateForPeriod / getAsOfBalance
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * YTD حتى الفترة throughOrdinal (شاملة) بدلالة السلوك المخزّن للحساب:
 *   - FLOW:    مجموع الحركات للفترات 1..through — أي فترة ناقصة ⇒ INCOMPLETE_DATA
 *              (صرامة افتراضية: لا YTD يوحي بالاكتمال وهو ناقص).
 *   - BALANCE: رصيد نهاية الفترة through نفسها — لا جمع للأرصدة إطلاقًا؛
 *              يكفي وجود قيمة الفترة المطلوبة (الفترات السابقة ليست شرطًا).
 *
 * throughOrdinal إلزامي ومعروض — لا افتراض «آخر فترة» صامت (المستدعي يقرر
 * ويعرض الفترة المختارة). للاختيار «الأحدث المتاح» صراحةً انظر latestOrdinal.
 */
export function aggregateYTD(
  entries: readonly PeriodAmountEntry[],
  behavior: AggregationBehavior,
  throughOrdinal: number
): bigint {
  if (!Number.isInteger(throughOrdinal) || throughOrdinal < 1) {
    throw new AggregationError("INVALID_PERIOD", `فترة النهاية غير صالحة: ${String(throughOrdinal)}`);
  }
  const sorted = sortedValidated(entries);
  if (behavior === "BALANCE") {
    const value = indexByOrdinal(sorted).get(throughOrdinal);
    if (value === undefined) {
      throw new AggregationError(
        "INCOMPLETE_DATA",
        `لا توجد قيمة رصيد لفترة الوقف ${throughOrdinal} — لا يُحسب as-of من فترات غائبة.`,
        { throughOrdinal }
      );
    }
    return value;
  }
  if (behavior === "FLOW") {
    if (sorted[sorted.length - 1].periodOrdinal < throughOrdinal) {
      throw new AggregationError(
        "INCOMPLETE_DATA",
        `سلسلة الحركة ناقصة: آخر فترة متاحة ${sorted[sorted.length - 1].periodOrdinal} < فترة النهاية ${throughOrdinal}.`,
        { throughOrdinal, lastAvailable: sorted[sorted.length - 1].periodOrdinal }
      );
    }
    const byOrdinal = indexByOrdinal(sorted);
    let total = BigInt(0);
    for (let o = 1; o <= throughOrdinal; o += 1) {
      const v = byOrdinal.get(o);
      if (v === undefined) {
        throw new AggregationError(
          "INCOMPLETE_DATA",
          `فترة ${o} ناقصة من سلسلة الحركة حتى الفترة ${throughOrdinal} — YTD غير محسوم.`,
          { throughOrdinal, missingOrdinal: o }
        );
      }
      total += v;
    }
    return total;
  }
  throw new AggregationError("NEEDS_CLASSIFICATION", `سلوك تجميع غير معروف: ${String(behavior)}`);
}

/**
 * قيمة فترة واحدة بدلالة السلوك (بدون أي امتداد تراكمي):
 *   - FLOW:    حركة الفترة نفسها.
 *   - BALANCE: رصيد نهاية الفترة نفسها.
 * يرفض غياب الفترة (INCOMPLETE_DATA) — لا صفر صامت.
 */
export function aggregateForPeriod(
  entries: readonly PeriodAmountEntry[],
  behavior: AggregationBehavior,
  periodOrdinal: number
): bigint {
  if (!Number.isInteger(periodOrdinal) || periodOrdinal < 1) {
    throw new AggregationError("INVALID_PERIOD", `ترتيب فترة غير صالح: ${String(periodOrdinal)}`);
  }
  const sorted = sortedValidated(entries);
  const value = indexByOrdinal(sorted).get(periodOrdinal);
  if (value === undefined) {
    throw new AggregationError(
      "INCOMPLETE_DATA",
      `لا توجد قيمة للفترة ${periodOrdinal} في السلسلة.`,
      { periodOrdinal }
    );
  }
  return value;
}

/**
 * رصيد as-of لحساب BALANCE حصرًا — التسمية الصريحة للقارئ المحاسبي.
 * تطابق دلاليًا aggregateYTD(..., "BALANCE", ...) لكنها توثّق القصد وتمنع
 * استدعاءها بخطأ على حساب FLOW (يرمي INVALID... بدل رقم بلا معنى).
 */
export function getAsOfBalance(
  entries: readonly PeriodAmountEntry[],
  throughOrdinal: number
): bigint {
  const sorted = sortedValidated(entries);
  const value = indexByOrdinal(sorted).get(throughOrdinal);
  if (value === undefined) {
    throw new AggregationError(
      "INCOMPLETE_DATA",
      `لا توجد قيمة رصيد لفترة الوقف ${throughOrdinal}.`,
      { throughOrdinal }
    );
  }
  return value;
}

/** أحدث ordinal متاح في السلسلة (لقرار العرض الصريح — لا استدعاء صامت). */
export function latestOrdinal(entries: readonly PeriodAmountEntry[]): number {
  const sorted = sortedValidated(entries);
  return sorted[sorted.length - 1].periodOrdinal;
}

/* ──────────────────────────────────────────────────────────────────────────
 * الجسور مع قرار التخزين (أ): الرصيد التراكمي كما يرد من ميزان المراجعة
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * قرار 6.2 المعتمد: Actual يُخزَّن «رصيدًا تراكميًا حتى نهاية الشهر كما يرد من
 * ميزان المراجعة الشهري». هذه الدالة تحوّل السلسلة التراكمية المخزّنة إلى
 * الحركة الشهرية التي تعمل عليها الدوال أعلاه:
 *   - FLOW:    movement(1) = cum(1) (أساس بداية السنة صفر لإيرادات/مصروفات —
 *              حقيقة محاسبية)، movement(m) = cum(m) − cum(m−1).
 *   - BALANCE: تُعاد كما هي (المخزّن هو رصيد نهاية الفترة بالفعل).
 * فجوة في التسلسل التراكمي ⇒ INCOMPLETE_DATA (لا اشتقاق صامت عبر فترة غائبة).
 */
export function monthlyMovementsFromCumulative(
  cumulative: readonly PeriodAmountEntry[],
  behavior: AggregationBehavior
): PeriodAmountEntry[] {
  const sorted = sortedValidated(cumulative);
  if (behavior === "BALANCE") return sorted.map((e) => ({ ...e }));
  const out: PeriodAmountEntry[] = [];
  let prev = BigInt(0);
  let prevOrdinal = 0;
  for (const e of sorted) {
    if (prevOrdinal !== 0 && e.periodOrdinal !== prevOrdinal + 1) {
      throw new AggregationError(
        "INCOMPLETE_DATA",
        `سلسلة تراكمية غير متصلة: فجوة بين ${prevOrdinal} و ${e.periodOrdinal} — لا اشتقاق حركة عبر فجوة.`,
        { gapAfter: prevOrdinal, nextOrdinal: e.periodOrdinal }
      );
    }
    out.push({ periodOrdinal: e.periodOrdinal, amountMinor: e.amountMinor - prev });
    prev = e.amountMinor;
    prevOrdinal = e.periodOrdinal;
  }
  return out;
}

/** العكس: حركات شهرية ⇒ سلسلة تراكمية (للعرض/المطابقة مع ميزان المراجعة). */
export function cumulativeFromMovements(
  movements: readonly PeriodAmountEntry[]
): PeriodAmountEntry[] {
  const sorted = sortedValidated(movements);
  const out: PeriodAmountEntry[] = [];
  let running = BigInt(0);
  let prevOrdinal = 0;
  for (const e of sorted) {
    if (prevOrdinal !== 0 && e.periodOrdinal !== prevOrdinal + 1) {
      throw new AggregationError(
        "INCOMPLETE_DATA",
        `سلسلة حركات غير متصلة: فجوة بين ${prevOrdinal} و ${e.periodOrdinal}.`,
        { gapAfter: prevOrdinal, nextOrdinal: e.periodOrdinal }
      );
    }
    running += e.amountMinor;
    out.push({ periodOrdinal: e.periodOrdinal, amountMinor: running });
    prevOrdinal = e.periodOrdinal;
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * رصيد الافتتاح (قسم 6) — توثيق الفجوة لا اختراعها
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * لحساب BALANCE: closing = opening + Σ الحركات. هذه الدالة تُتيح تمثيل ذلك
 * لاحقًا حين يتوفر مصدر opening balance موثوق (لا توجد بنية تخزين له اليوم —
 * فجوة موثقة للمرحلة التالية، ولا تُشتق قيم افتتاح من لا شيء إطلاقًا).
 * الاستخدام المستقبلي: المطابقة/التحقق العكسي في 6.2B+ وليس توليد أرقام.
 */
export function reconcileBalanceMovements(
  openingBalanceMinor: bigint,
  movements: readonly PeriodAmountEntry[]
): { computedClosingMinor: bigint; sumOfMovementsMinor: bigint } {
  if (typeof openingBalanceMinor !== "bigint") {
    throw new AggregationError("INVALID_PERIOD", "رصيد الافتتاح يجب أن يكون bigint (amountMinor).");
  }
  // cumulativeFromMovements تتحقق من الاتصال وتُعيد التراكمي انطلاقًا من صفر
  // (الافتتاح ليس حركة) — آخر قيمة = مجموع الحركات حرفيًا.
  const cumulative = cumulativeFromMovements(movements);
  const sumOfMovements = cumulative[cumulative.length - 1].amountMinor;
  return {
    computedClosingMinor: openingBalanceMinor + sumOfMovements,
    sumOfMovementsMinor: sumOfMovements,
  };
}

/** رفض صريح لحل غير محسوم — الجسر بين resolveAccountMapping والدوال الحسابية.
 *  الحالتان ROOT_ONLY/FULLY_MAPPED تحسمان السلوك الزمني؛ NEEDS_* تُرفض صراحة. */
export function requireBehavior(
  mapping: { status: string; aggregationBehavior?: AggregationBehavior | null }
): AggregationBehavior {
  if (
    (mapping.status !== "FULLY_MAPPED" && mapping.status !== "ROOT_ONLY") ||
    !mapping.aggregationBehavior
  ) {
    throw new AccountNatureError(
      "NEEDS_CLASSIFICATION",
      "الحساب غير محسوم السلوك الزمني (FLOW/BALANCE) — يُمنع الحساب الزمني الصامت."
    );
  }
  return mapping.aggregationBehavior;
}
