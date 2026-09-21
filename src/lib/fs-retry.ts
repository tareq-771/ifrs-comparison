// Phase 5B.1 — إعادة محاولة محدودة للأخطاء العابرة فقط (EPERM/EBUSY) — خادم فقط.
//
// الغرض (نص المستخدم 5B.1 §8): على Windows قد يُمسك Defender/AV مقبض ملف لحظيًا
// فيفشل rename/unlink رغم صحة المنطق. المطلوب retry محدود لهذه الأكواد حصرًا
// — دون إخفاء أي خطأ دائم، وبكل محاولة/فشل نهائي deterministic وقابل للتدقيق.
//
// الضوابط:
//   • الأكواد المؤهلة حصرًا: EPERM، EBUSY. أي كود آخر (EACCES، ENOENT، …)
//     يُرفع فورًا بلا أي محاولة إضافية — لا تخمين.
//   • عدد محاولات محدود + backoff ثابت قصير (افتراضي: 3 محاولات، 200ms).
//   • الفشل النهائي يرفع الخطأ الأصلي كما هو + يُسجل في console (خادم) عدد
//     المحاولات — التدقيق من السجل، والتسريب العام مستحيل لأن المستدعي يقرر
//     ما يوضع في استجابة API (استعادة تستخدم رموز RestoreError فقط).

export interface TransientRetryOptions {
  attempts?: number;
  delayMs?: number;
  /** أكواد مؤهلة — الافتراضي EPERM/EBUSY حصرًا (قرار 5B.1). */
  retryableCodes?: readonly string[];
  /** خطاف تشخيصي للاختبارات/السجل — يستقبل رقم المحاولة الفاشلة والكود. */
  onRetry?: (info: { attempt: number; code: string; totalAttempts: number }) => void;
}

const DEFAULT_RETRYABLE = ["EPERM", "EBUSY"] as const;

function errnoCode(e: unknown): string | null {
  if (e && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/**
 * ينفذ fn مع retry محدود عند الأخطاء العابرة المؤهلة حصرًا.
 * النجاح ⇒ قيمة fn. فشل غير مؤهل ⇒ يُرفع فورًا. استنفاد المحاولات ⇒ يُرفع
 * الخطأ الأصلي الأخير (دون تغليف يخفي هويته).
 */
export async function withTransientRetry<T>(fn: () => T | Promise<T>, opts: TransientRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, Math.min(opts.attempts ?? 3, 10));
  const delayMs = Math.max(0, Math.min(opts.delayMs ?? 200, 5_000));
  const retryable = opts.retryableCodes ?? DEFAULT_RETRYABLE;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const code = errnoCode(e);
      const isLast = attempt === attempts;
      if (!code || !retryable.includes(code) || isLast) {
        if (code && retryable.includes(code) && isLast && attempts > 1) {
          console.error(`[fs-retry] استنفدت المحاولات (${attempts}) على كود عابر ${code} — رفع الخطأ الأصلي`);
        }
        throw e;
      }
      opts.onRetry?.({ attempt, code, totalAttempts: attempts });
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  /* غير reachable — لكن TypeScript يتطلب return/throw */
  throw lastError;
}

/** نسخة متزامنة لسياقات fs المتزامنة (renameSync داخل محرك الاستعادة). */
export function withTransientRetrySync<T>(fn: () => T, opts: TransientRetryOptions = {}): T {
  const attempts = Math.max(1, Math.min(opts.attempts ?? 3, 10));
  const delayMs = Math.max(0, Math.min(opts.delayMs ?? 200, 5_000));
  const retryable = opts.retryableCodes ?? DEFAULT_RETRYABLE;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastError = e;
      const code = errnoCode(e);
      const isLast = attempt === attempts;
      if (!code || !retryable.includes(code) || isLast) {
        if (code && retryable.includes(code) && isLast && attempts > 1) {
          console.error(`[fs-retry] استنفدت المحاولات (${attempts}) على كود عابر ${code} — رفع الخطأ الأصلي`);
        }
        throw e;
      }
      opts.onRetry?.({ attempt, code, totalAttempts: attempts });
      if (delayMs > 0) {
        // مزامنة busy-wait محدودة — سياقات renameSync لا تحتاج دقة نانوية،
        // والمدة القصوى (5s × 9 انتظار) مقبولة داخل عملية استعادة واحدة.
        const until = Date.now() + delayMs;
        while (Date.now() < until) {
          /* busy wait مقصود للسياق المتزامن */
        }
      }
    }
  }
  throw lastError;
}
