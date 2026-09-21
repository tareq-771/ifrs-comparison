// Phase 5B.1 — سياسة كلمة المرور القوية للإعداد الأولي — خادم فقط.
//
// الغرض (نص المستخدم 5B.1 §5): bootstrap أول مدير يجمع «strong password policy»
// ضمن سلسلة الحماية. تُطبق حصرًا على /api/setup (إنشاء أول مدير) — لا تمس
// مسارات المستخدمين الأخرى في هذه المرحلة (نطاق معتمد).
//
// القواعد:
//   • الطول ≥ 12 حرفًا.
//   • حرف صغير + حرف كبير + رقم (على الأقل).
//   • رفض القوائم الضعيفة المعروفة + النمط الأحادي + الأرقام المتتابعة البسيطة.
//   • لا قيم أسرار تُعاد في الأخطاء — رموز فقط (قد تُعرض للواجهة بشكل عام).

const MIN_LENGTH = 12;

/** قائمة نصوط الضعف الصريحة — تُرفض حتى لو حققت الشكل. */
const WEAK_LIST = [
  "admin123",
  "password",
  "password1",
  "password123",
  "passw0rd",
  "changeme",
  "change-me",
  "qwerty123",
  "123456789012",
  "aaaaaaaaaaaa",
  "letmein123",
  "welcome123",
  "ifrs123456",
  "ifrs-admin",
  "p4b3-restore-only",
] as const;

export type PasswordIssue =
  | "PASSWORD_REQUIRED"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_MISSING_LOWER"
  | "PASSWORD_MISSING_UPPER"
  | "PASSWORD_MISSING_DIGIT"
  | "PASSWORD_WEAK_LISTED"
  | "PASSWORD_SINGLE_CHAR_PATTERN";

export function validateStrongPassword(password: unknown): { ok: boolean; issue: PasswordIssue | null } {
  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, issue: "PASSWORD_REQUIRED" };
  }
  if (password.length < MIN_LENGTH) {
    return { ok: false, issue: "PASSWORD_TOO_SHORT" };
  }
  if (!/[a-z]/.test(password)) {
    return { ok: false, issue: "PASSWORD_MISSING_LOWER" };
  }
  if (!/[A-Z]/.test(password)) {
    return { ok: false, issue: "PASSWORD_MISSING_UPPER" };
  }
  if (!/[0-9]/.test(password)) {
    return { ok: false, issue: "PASSWORD_MISSING_DIGIT" };
  }
  const lower = password.toLowerCase();
  if (WEAK_LIST.some((w) => lower === w || lower.includes(w))) {
    return { ok: false, issue: "PASSWORD_WEAK_LISTED" };
  }
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, issue: "PASSWORD_SINGLE_CHAR_PATTERN" };
  }
  return { ok: true, issue: null };
}

/** رسالة عامة غير حساسة للاستجابة (بلا أي محتوى من كلمة المرور). */
export function passwordIssueMessage(issue: PasswordIssue): string {
  switch (issue) {
    case "PASSWORD_REQUIRED":
      return "كلمة المرور مطلوبة";
    case "PASSWORD_TOO_SHORT":
      return "كلمة المرور قصيرة — الحد الأدنى 12 حرفًا";
    case "PASSWORD_MISSING_LOWER":
      return "كلمة المرور يجب أن تتضمن حرفًا صغيرًا";
    case "PASSWORD_MISSING_UPPER":
      return "كلمة المرور يجب أن تتضمن حرفًا كبيرًا";
    case "PASSWORD_MISSING_DIGIT":
      return "كلمة المرور يجب أن تتضمن رقمًا";
    case "PASSWORD_WEAK_LISTED":
      return "كلمة المرور ضمن قائمة الضعف المعروفة — مرفوضة";
    case "PASSWORD_SINGLE_CHAR_PATTERN":
      return "كلمة المرور نمطها أحادي — مرفوضة";
  }
}
