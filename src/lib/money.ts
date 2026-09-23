// 6.7 — تنسيق مالي آمن بدقة BigInt (تحذير إلزامي: المبالغ الدنيا BigInt تُنقل كسلاسل نصية).
// أي عرض للمبالغ في واجهة 6.7 يجب أن يمر من هنا — لا Number() ولا toFixed() على قيم minor.
// الدوال نقية (تعمل في العميل والخادم) — بلا اعتماديات.
// ملاحظة: target ES2017 ⇒ لا literals للـ BigInt — يُستخدم BigInt(x) حصرًا.

/** فصل آلاف بنمط latn (1,234,567) — يدوي لتفادي Intl على BigInt. */
function groupDigits(digits: string): string {
  const out: string[] = [];
  for (let i = digits.length; i > 0; i -= 3) {
    out.unshift(digits.slice(Math.max(0, i - 3), i));
  }
  return out.join(",");
}

/** قوة 10 كـ BigInt (بديل literal) */
function pow10(n: number): bigint {
  let result = BigInt(1);
  for (let i = 0; i < n; i++) result = result * BigInt(10);
  return result;
}

function toBigIntSafe(amountMinor: string | bigint | null | undefined): bigint | null {
  if (amountMinor === null || amountMinor === undefined || amountMinor === "") return null;
  try {
    return typeof amountMinor === "bigint" ? amountMinor : BigInt(String(amountMinor).trim());
  } catch {
    return null;
  }
}

/**
 * تنسيق مبلغ minor (سلسلة/BigInt) إلى نص عرض مع فواصل آلاف وخانات عشرية حسب العملة.
 * - القيم غير المتاحة ⇒ "—".
 * - لا فقد دقة إطلاقًا: كل العمليات على BigInt.
 */
export function formatMinor(
  amountMinor: string | bigint | null | undefined,
  minorUnits = 2,
  opts: { emptyLabel?: string } = {}
): string {
  const { emptyLabel = "—" } = opts;
  const raw = toBigIntSafe(amountMinor);
  if (raw === null) return emptyLabel;
  const negative = raw < BigInt(0);
  const abs = negative ? raw * BigInt(-1) : raw;
  const base = pow10(Math.max(0, minorUnits));
  const whole = abs / base;
  const frac = abs % base;
  const digits = groupDigits(whole.toString());
  const fracStr = minorUnits > 0 ? "." + frac.toString().padStart(minorUnits, "0") : "";
  const body = `${digits}${fracStr}`;
  if (negative) return `(${body})`; // اصطلاح محاسبي: السالب بين قوسين
  return body;
}

/** نفس formatMinor لكن السالب/الموجب بعلامة أمامية (للاستخدام خارج الجداول المحاسبية). */
export function formatMinorSigned(
  amountMinor: string | bigint | null | undefined,
  minorUnits = 2,
  emptyLabel = "—"
): string {
  const raw = toBigIntSafe(amountMinor);
  if (raw === null) return emptyLabel;
  if (raw === BigInt(0)) return formatMinor(raw, minorUnits);
  const formatted = formatMinor(raw < BigInt(0) ? raw * BigInt(-1) : raw, minorUnits);
  return raw < BigInt(0) ? `-${formatted}` : `+${formatted}`;
}

/** تحويل نص إدخال عشري إلى minor كنص — بدون فقد دقة (لا يمس Number إطلاقًا). */
export function decimalStringToMinorString(input: string, minorUnits = 2): string | null {
  const trimmed = input.trim().replace(/[,،]/g, "").replace(/[\u066B]/g, ".");
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  const fracPadded = (fracPart + "0".repeat(minorUnits)).slice(0, minorUnits);
  const whole = wholePart === "" ? BigInt(0) : BigInt(wholePart);
  const frac = minorUnits > 0 ? BigInt(fracPadded) : BigInt(0);
  const value = whole * pow10(minorUnits) + frac;
  return (negative ? "-" : "") + value.toString();
}

/** العملات المدعومة في النظام (نفس مجموعة واجهة الشركات). */
export const MINOR_UNITS_BY_CURRENCY: Record<string, number> = {
  YER: 2,
  SAR: 2,
  USD: 2,
};

export function minorUnitsFor(currency: string | null | undefined): number {
  if (!currency) return 2;
  return MINOR_UNITS_BY_CURRENCY[currency.toUpperCase()] ?? 2;
}
