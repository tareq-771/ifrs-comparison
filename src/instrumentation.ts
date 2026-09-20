// Phase 4B.1 — نقطة الإقلاع (Instrumentation): فحص الاسترداد عند بدء العملية.
//
// قرار المستخدم حرفيًا (Crash Recovery):
//   «عند startup اقرأ recovery state الخارجي. إذا كانت الحالة غير NORMAL
//    ولا توجد طريقة مؤكدة لإثبات سلامة النهاية: لا تفتح التطبيق طبيعيًا.
//    ادخل Recovery Required / safe recovery path. لا تفترض أن restart
//    يعني نجاح العملية.»
//
// ما يفعله الإقلاع (Node runtime حصرًا):
//   1. تهيئة Session Epoch إذا لم يوجد الملف إطلاقًا (قيمة أولية 1 — ذريًا).
//      ملف موجود لكنه تالف ⇒ لا علاج تلقائي — fail-closed (يُرفض كل شيء حتى
//      استرداد يدوي موثق) — سلوك fail-safe المقصود.
//   2. قراءة ملف حالة الصيانة الخارجي: أي حالة غير NORMAL باقية من عملية سابقة
//      ⇒ انتقال صريح إلى RECOVERY_REQUIRED مع توثيق الحالة الأصلية + حدث
//      RECOVERY_REQUIRED في السجل الخارجي. الحارس المركزي يمنع كل القراءة
//      والكتابة بعدها (تطابقًا مع سياسة RECOVERY_REQUIRED).
//
// ملاحظة: حتى لو لم يعمل هذا الملف لأي سبب، حراس الصيانة يقرأون ملف الحالة
// عند كل طلب ويفشلون مغلقين — الإقلاع يضيف التوثيق والانتقال الصريح فقط.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const [{ ensureEpochBootstrapped }, { readSessionEpoch }, maintenance, { appendRecoveryEvent }] =
      await Promise.all([
        import("@/lib/session-epoch"),
        import("@/lib/session-epoch"),
        import("@/lib/maintenance"),
        import("@/lib/recovery-log"),
      ]);

    // 1) تهيئة epoch عند الإقلاع فقط
    const boot = ensureEpochBootstrapped();
    const epochOk = readSessionEpoch() !== null;
    console.log(
      `[instrumentation] session-epoch bootstrap: created=${boot.created} available=${epochOk}`
    );

    // 2) كشف مقاطعة عملية سابقة
    const check = maintenance.startupRecoveryCheck();
    if (check.transitioned) {
      console.error(
        `[instrumentation] CRASH RECOVERY: حالة غير NORMAL من عملية سابقة (${check.originalState}) → RECOVERY_REQUIRED (operation=${check.operationId ?? "unknown"})`
      );
      await appendRecoveryEvent({
        operationId: check.operationId ?? "op-startup-unknown",
        event: "RECOVERY_REQUIRED",
        actor: { id: null, username: "system:startup" },
        backupId: null,
        result: "failure",
        details: {
          reason: "startup_after_interrupted_operation",
          originalState: check.originalState,
        },
      });
    } else {
      console.log("[instrumentation] maintenance state: NORMAL (no interrupted operation)");
    }
  } catch (e) {
    // فشل فحص الإقلاع نفسه لا يجب أن يمنع الخادم من الإقلاع — الحراس يفشلون مغلقين
    console.error("[instrumentation] startup recovery check failed (fail-closed guards remain active):", e);
  }
}
