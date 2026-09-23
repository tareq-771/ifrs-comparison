// Phase 6.2C — تطبيع بيانات ميزان المراجعة المحفوظ إلى سلاسل زمنية (وحدة نقية).
//
// الجسر الحاكم بين البيانات المخزنة (TrialBalanceImport/Lines) ومحرك التجميع
// الزمني الموحد (temporal-aggregation 6.2A) — يُمنع أي حساب FLOW/BALANCE
// خارج هذا الملف + المحرك (قرار 6.2A: قاعدة مركزية reusable بلا تكرار).
//
// القاعدة الحرجة (قرار 6.2C-2): لا تُجمع ملفات CUMULATIVE_YTD فوق بعضها أبدًا.
//   تراكمي يناير=100، فبراير=220، مارس=300 ⇒ حركة مارس=80 وYTD مارس=300 (ليس 620).
//
// أولويات الاشتقاق (موثقة ومُختبرة):
//   YTD (FLOW):
//     1) نقطة CUMULATIVE_YTD نهايتها الفترة المطلوبة ⇒ القيمة مباشرة (استيراد
//        تراكمي موثوق يغطي حتى الفترة — قرار 6.2C-8).
//     2) وإلا: اشتقاق حركات شهرية 1..N (حركة فترة صريحة، أو فرق تراكمي متتالٍ)
//        ثم aggregateYTD — أي فجوة ⇒ INCOMPLETE_DATA (صرامة 6.2A حرفيًا).
//   حركة الشهر (FLOW):
//     1) نقطة PERIOD_MOVEMENT تغطي الفترة وحدها (start==end==N) ⇒ مباشرة.
//     2) وإلا: فرق تراكمي cum(N)−cum(N−1) — يتطلب وجود cum(N) و(cum(N−1) أو N==1
//        حيث cum(0)=0 حقيقة محاسبية لإيرادات/مصروفات).
//     3) وإلا INCOMPLETE_DATA — لا اشتقاق صامت عبر فجوة.
//   As-of (BALANCE):
//     نقطة نهايتها الفترة المطلوبة حصرًا (أي نوع — ميزان الفترة يعرض رصيد الإقفال
//     لحسابات الأرصدة بنفسه) ⇒ الرصيد. غيابها ⇒ INCOMPLETE_DATA (لا ترحيل صامت
//     لرصيد فترة أقدم ولا جمع أرصدة إطلاقًا).

import {
  aggregateYTD,
  AggregationError,
  getAsOfBalance,
  type PeriodAmountEntry,
} from "./temporal-aggregation";
import { TB_DATA_TYPES, TrialBalanceError, type TrialBalanceDataType } from "./trial-balance";

export interface TBDataPoint {
  /** ordinal فترة بداية تغطية النقطة داخل سنتها المالية. */
  startOrdinal: number;
  /** ordinal فترة نهاية تغطية النقطة (= فترة الإقفال). */
  endOrdinal: number;
  dataType: TrialBalanceDataType | string;
  /** net = مدين − دائن بوحدات secondary. */
  netMinor: bigint;
}

function typed(dataType: string): TrialBalanceDataType {
  if (dataType === TB_DATA_TYPES.CUMULATIVE_YTD || dataType === TB_DATA_TYPES.PERIOD_MOVEMENT) {
    return dataType;
  }
  throw new TrialBalanceError("INVALID_DATA_TYPE", `نوع بيانات مخزن غير معروف: ${dataType}`);
}

/** حركة شهر واحد لحساب FLOW عند ordinal محدد — بالأولويات الموثقة أعلاه. */
export function flowMonthMovementFromPoints(points: readonly TBDataPoint[], ordinal: number): bigint {
  const active = points.filter((p) => typed(p.dataType) === TB_DATA_TYPES.PERIOD_MOVEMENT);
  const exact = active.find((p) => p.startOrdinal === ordinal && p.endOrdinal === ordinal);
  if (exact) return exact.netMinor;

  const cumulative = points
    .filter((p) => typed(p.dataType) === TB_DATA_TYPES.CUMULATIVE_YTD)
    .map((p) => ({ endOrdinal: p.endOrdinal, netMinor: p.netMinor }))
    .sort((a, b) => a.endOrdinal - b.endOrdinal);
  const atN = cumulative.find((c) => c.endOrdinal === ordinal);
  if (atN) {
    if (ordinal === 1) return atN.netMinor; // cum(0) = 0 حقيقة محاسبية
    const atPrev = cumulative.find((c) => c.endOrdinal === ordinal - 1);
    if (atPrev) return atN.netMinor - atPrev.netMinor;
  }
  throw new AggregationError(
    "INCOMPLETE_DATA",
    `لا يمكن اشتقاق حركة الفترة ${ordinal}: لا حركة فترة صريحة ولا تراكمي متتالٍ يغطيها.`,
    { ordinal }
  );
}

/** YTD لحساب FLOW حتى ordinal (شامل) — أولوية التراكمي المباشر ثم اشتقاق الحركات. */
export function flowYTDFromPoints(points: readonly TBDataPoint[], throughOrdinal: number): bigint {
  // 1) تراكمي موثوق يغطي حتى الفترة المطلوبة — لا جمع فوق الملفات أبدًا.
  const direct = points.find(
    (p) => typed(p.dataType) === TB_DATA_TYPES.CUMULATIVE_YTD && p.endOrdinal === throughOrdinal
  );
  if (direct) return direct.netMinor;

  // 2) اشتقاق الحركات الشهرية 1..N ثم المحرك الموحد (يفشل INCOMPLETE_DATA عند الفجوات).
  const movements: PeriodAmountEntry[] = [];
  for (let o = 1; o <= throughOrdinal; o += 1) {
    movements.push({ periodOrdinal: o, amountMinor: flowMonthMovementFromPoints(points, o) });
  }
  return aggregateYTD(movements, "FLOW", throughOrdinal);
}

/** رصيد as-of لحساب BALANCE عند ordinal — نقطة نهايتها الفترة المطلوبة حصرًا. */
export function balanceAsOfFromPoints(points: readonly TBDataPoint[], throughOrdinal: number): bigint {
  const series: PeriodAmountEntry[] = points
    .map((p) => ({ periodOrdinal: p.endOrdinal, amountMinor: p.netMinor }))
    .sort((a, b) => a.periodOrdinal - b.periodOrdinal);
  // getAsOfBalance يرفض غياب الفترة المطلوبة (INCOMPLETE_DATA) — نفس الدلالة المطلوبة.
  return getAsOfBalance(series, throughOrdinal);
}

/** قيمة فترة بدلالة السلوك المخزن للحساب (جسر موحد للتقارير). */
export function valueByBehavior(
  points: readonly TBDataPoint[],
  behavior: "FLOW" | "BALANCE",
  ordinal: number,
  kind: "PERIOD" | "YTD"
): bigint {
  if (behavior === "BALANCE") {
    // BALANCE: القيمة الوحيدة ذات المعنى = رصيد الإقفال (as-of) — للفترة والتراكمي على السواء.
    return balanceAsOfFromPoints(points, ordinal);
  }
  return kind === "YTD" ? flowYTDFromPoints(points, ordinal) : flowMonthMovementFromPoints(points, ordinal);
}

export type ReportRowStatus = "OK" | "INCOMPLETE_DATA";

export interface ReportRowValue {
  status: ReportRowStatus;
  valueMinor: bigint | null;
  message?: string;
}

/** قيمة آمنة للتقرير — الخطأ يتحول إلى حالة صف صريحة (لا صفر صامت ولا استثناء HTTP). */
export function safeValue(
  fn: () => bigint,
  label: string
): ReportRowValue {
  try {
    return { status: "OK", valueMinor: fn() };
  } catch (e) {
    if (e instanceof AggregationError && e.code === "INCOMPLETE_DATA") {
      return { status: "INCOMPLETE_DATA", valueMinor: null, message: `${label}: بيانات ناقصة — ${e.message}` };
    }
    throw e;
  }
}
