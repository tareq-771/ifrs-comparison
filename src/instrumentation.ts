// Phase 4B.1 + Phase 5A — نقطة الإقلاع (Instrumentation): فحص الاسترداد + preflight الإنتاج.
//
// قرار المستخدم حرفيًا (Crash Recovery — 4B.1):
//   «عند startup اقرأ recovery state الخارجي. إذا كانت الحالة غير NORMAL
//    ولا توجد طريقة مؤكدة لإثبات سلامة النهاية: لا تفتح التطبيق طبيعيًا.
//    ادخل Recovery Required / safe recovery path. لا تفترض أن restart
//    يعني نجاح العملية.»
//
// قرار المستخدم حرفيًا (Phase 5A):
//   «Production startup/preflight يفحص config وSQLite header وintegrity_check
//    وcanonical schema وSession Epoch وMaintenance/Recovery state.»
//   «RECOVERY_REQUIRED يجب أن يشغّل التطبيق في restricted recovery mode،
//    وليس restart loop أو NORMAL تلقائي.»
//
// سلوك الإقلاع (Node runtime حصرًا):
//   1. [كل الأوضاع] تهيئة Session Epoch عند الإقلاع فقط:
//      • dev: مفقود ⇒ 1 ذريًا (سلوك 4B.1 كما هو).
//      • production: مفقود + قاعدة مهيأة (مستخدمون) ⇒ فشل مغلق — لا إنشاء
//        صمت إطلاقًا (قرار المستخدم 5B.1 §4): unhealthy(epoch) + حدث
//        EPOCH_STATE_LOST + مسار استرداد المشغّل الموثق (--epoch-recover).
//        مفقود + قاعدة غير مهيأة (إقلاع أول حقيقي/بعد migrate deploy) ⇒ 1 ذريًا.
//   2. [كل الأوضاع] كشف مقاطعة عملية سابقة ⇒ RECOVERY_REQUIRED (التطبيق يظل حيًا
//      في restricted recovery mode — الحراس يمنعون القراءة والكتابة — لا exit،
//      لا حلقة إعادة تشغيل، ولا عودة NORMAL تلقائيًا).
//   3. [production حصرًا] preflight fail-closed:
//        a. validateProductionConfig ⇒ أي إخفاق ⇒ FATAL + process.exit(1)
//           (لا سر عشوائي، لا قاعدة تُنشأ في مسار خاطئ، لا بيانات داخل شجرة النشر).
//        b. ترويسة ملف القاعدة (SQLite format 3) + PRAGMA integrity_check.
//        c. canonical schema fingerprint مقابل الثابت المثبت (4A.1).
//        d. epoch قابل للقراءة + حالة الصيانة المرصودة ⇒ setBootStatus لـ /api/health.
//      إخفاق (b/c) لا يقتل العملية — يرفع health إلى unhealthy مع سبب
//      رمزي (قاعدة تالفة مع خادم حي أفضل من حلقة إقلاع تمحو التشخيص).
//
// ملاحظة 1: حتى لو لم يعمل هذا الملف لأي سبب، حراس الصيانة يقرؤون ملف الحالة
// عند كل طلب ويفشلون مغلقين — الإقلاع يضيف التوثيق والانتقال الصريح فقط.
//
// ملاحظة 2: كل الاستيرادات ديناميكية داخل register() — Next يجمع هذا الملف
// أيضًا لحزمة Edge (تحذيريات لا أكثر لو استُخدم استيراد ثابت لـ node:fs).

const SQLITE_MAGIC = "SQLite format 3\0";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const [
      { existsSync, openSync, readSync, closeSync },
      { setBootStatus },
      { ensureEpochBootstrapped, readSessionEpoch },
      { probeDbInitialized },
      maintenance,
      { appendRecoveryEvent },
    ] = await Promise.all([
      import("node:fs"),
      import("@/lib/boot-status"),
      import("@/lib/session-epoch"),
      import("@/lib/db-probe"),
      import("@/lib/maintenance"),
      import("@/lib/recovery-log"),
    ]);

    /** فحص ترويسة ملف SQLite — أول 16 بايت بالضبط. */
    const checkSqliteHeader = (dbFile: string): { ok: boolean; exists: boolean } => {
      try {
        if (!existsSync(dbFile)) return { ok: false, exists: false };
        const fd = openSync(dbFile, "r");
        try {
          const buf = Buffer.alloc(16);
          const n = readSync(fd, buf, 0, 16, 0);
          return { ok: n === 16 && buf.toString("binary") === SQLITE_MAGIC, exists: true };
        } finally {
          closeSync(fd);
        }
      } catch {
        return { ok: false, exists: existsSync(dbFile) };
      }
    };

    // 1) تهيئة epoch عند الإقلاع فقط
    let boot = { created: false, available: false };
    let epochFileExists = existsSync(await import("@/lib/backup-config").then((m) => m.resolveSessionEpochFilePath()));
    if (process.env.NODE_ENV === "production" && !epochFileExists) {
      // 5B.1: production + ملف مفقود ⇒ قرار حسب حالة القاعدة (fail-closed عند المهيأة)
      const { resolveDatabaseFilePath } = await import("@/lib/backup-config");
      const initialized = await probeDbInitialized(resolveDatabaseFilePath());
      if (initialized) {
        boot = { created: false, available: false };
        console.error(
          "[instrumentation] CRITICAL: session-epoch مفقود على قاعدة إنتاج مهيأة — لا إنشاء صمت (fail-closed) — يلزم استرداد المشغّل الموثق (--epoch-recover)"
        );
        await appendRecoveryEvent({
          operationId: "op-startup-epoch-lost",
          event: "EPOCH_STATE_LOST",
          actor: { id: null, username: "system:startup" },
          backupId: null,
          result: "failure",
          details: { reason: "epoch_file_missing_with_initialized_production_db" },
        });
      } else {
        boot = ensureEpochBootstrapped(); // إقلاع أول حقيقي: قاعدة جديدة بلا مستخدمين
      }
    } else {
      boot = ensureEpochBootstrapped(); // dev كما هو؛ أو ملف موجود (لا إنشاء)
      if (process.env.NODE_ENV === "production" && boot.available === false && epochFileExists) {
        // ملف موجود لكن غير قابل للقراءة (تالف) — فشل مغلق موثق
        await appendRecoveryEvent({
          operationId: "op-startup-epoch-corrupt",
          event: "EPOCH_STATE_CORRUPT",
          actor: { id: null, username: "system:startup" },
          backupId: null,
          result: "failure",
          details: { reason: "epoch_file_corrupt" },
        });
      }
    }
    const epochOk = readSessionEpoch() !== null;
    console.log(
      `[instrumentation] session-epoch bootstrap: created=${boot.created} available=${epochOk}`
    );

    // 2) كشف مقاطعة عملية سابقة (كل الأوضاع)
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

    // 3) Phase 5A — preflight الإنتاج (production حصرًا)
    if (process.env.NODE_ENV !== "production") return;

    const { validateProductionConfig } = await import("@/lib/production-config");
    const backupConfig = await import("@/lib/backup-config");
    const { canonicalSchemaFingerprint, shortFingerprint } = await import("@/lib/schema-fingerprint");
    const { maintenancePublicInfo } = await import("@/lib/maintenance");
    const { db } = await import("@/lib/db");

    const config = validateProductionConfig();
    if (!config.ok) {
      // fail-closed حاكم: لا إقلاع بتهيئة ناقصة/ضعيفة — لا fallback عشوائي أبدًا.
      console.error(`[instrumentation] FATAL: production config invalid: ${config.errors.join(", ")}`);
      console.error("[instrumentation] FATAL: refusing to start (fail-closed). لا يُطبع أي قيمة سرية.");
      setBootStatus({
        mode: "unhealthy",
        checkedAt: new Date().toISOString(),
        details: {
          config: "fail",
          dbFile: "skipped",
          integrity: "skipped",
          schema: "skipped",
          epoch: epochOk ? "ok" : "fail",
          maintenanceStateAtBoot: "unknown",
          preflightCompleted: false,
        },
        unhealthyReason: "boot_config",
      });
      process.exit(1);
    }
    for (const w of config.warnings) {
      console.log(`[instrumentation] production config warning: ${w}`);
    }

    const details = {
      config: "ok" as const,
      dbFile: "skipped" as "ok" | "fail" | "skipped",
      integrity: "skipped" as "ok" | "fail" | "skipped",
      schema: "skipped" as "ok" | "fail" | "skipped",
      epoch: epochOk ? ("ok" as const) : ("fail" as const),
      maintenanceStateAtBoot: "unknown" as ReturnType<typeof maintenancePublicInfo>["state"],
      preflightCompleted: true,
    };

    // 3b) ملف القاعدة: موجود + ترويسة SQLite صحيحة (لا إنشاء صامت في مسار خاطئ)
    const dbFile = backupConfig.resolveDatabaseFilePath();
    const header = checkSqliteHeader(dbFile);
    details.dbFile = header.ok ? "ok" : "fail";
    if (!header.ok) {
      console.error(
        `[instrumentation] PREFLIGHT FAIL: database file header invalid (exists=${header.exists}) — code=DATABASE_FILE_INVALID`
      );
    }

    // 3c) integrity_check + canonical schema — عبر عميل القاعدة الفعلي
    let integrityOk = false;
    let schemaOk = false;
    if (header.ok) {
      try {
        const rows = await db.$queryRawUnsafe<{ integrity_check: string }[]>("PRAGMA integrity_check");
        integrityOk = rows.length > 0 && rows.every((r) => r.integrity_check === "ok");
        details.integrity = integrityOk ? "ok" : "fail";
        if (!integrityOk) {
          console.error("[instrumentation] PREFLIGHT FAIL: PRAGMA integrity_check != ok — code=DB_INTEGRITY_FAIL");
        }
      } catch (e) {
        details.integrity = "fail";
        console.error("[instrumentation] PREFLIGHT FAIL: integrity_check threw — code=DB_INTEGRITY_ERROR");
        console.error(String(e).split("\n")[0]);
      }
      try {
        const fp = await canonicalSchemaFingerprint(db);
        const pinned = backupConfig.PINNED_CURRENT_CANONICAL_FINGERPRINT;
        if (pinned && fp !== pinned) {
          details.schema = "fail";
          console.error(
            `[instrumentation] PREFLIGHT FAIL: canonical schema mismatch: live=${shortFingerprint(fp)} expected=${shortFingerprint(pinned)} — code=SCHEMA_MISMATCH`
          );
        } else {
          details.schema = "ok";
          console.log(`[instrumentation] canonical schema ok: ${shortFingerprint(fp)}`);
        }
      } catch (e) {
        details.schema = "fail";
        console.error("[instrumentation] PREFLIGHT FAIL: schema fingerprint threw — code=SCHEMA_ERROR");
        console.error(String(e).split("\n")[0]);
      }
    }

    // 3d) حالة الصيانة المرصودة لحظة الإقلاع (بعد انتقال startup)
    const mInfo = maintenancePublicInfo();
    details.maintenanceStateAtBoot = mInfo.state;

    // تحديد الوضع: config=exit أعلاه؛ DB/مخطط/epoch تالفة ⇒ unhealthy (بلا exit)؛
    // RECOVERY_REQUIRED ⇒ restricted recovery mode؛ صيانة نشطة ⇒ maintenance؛
    // وإلا normal.
    let mode: "normal" | "maintenance" | "recovery_required" | "unhealthy";
    let unhealthyReason: "boot_config" | "database" | "schema" | "epoch" | "preflight_incomplete" | undefined;

    if (!epochOk) {
      mode = "unhealthy";
      unhealthyReason = "epoch";
    } else if (details.dbFile === "fail" || details.integrity === "fail") {
      mode = "unhealthy";
      unhealthyReason = "database";
    } else if (details.schema === "fail") {
      mode = "unhealthy";
      unhealthyReason = "schema";
    } else if (mInfo.state === "RECOVERY_REQUIRED" || mInfo.stateFileStatus === "corrupt") {
      mode = "recovery_required";
    } else if (mInfo.state !== "NORMAL") {
      mode = "maintenance";
    } else {
      mode = "normal";
    }

    setBootStatus({
      mode,
      checkedAt: new Date().toISOString(),
      details,
      unhealthyReason,
    });

    const summary = `mode=${mode}${unhealthyReason ? ` reason=${unhealthyReason}` : ""} db=${details.dbFile} integrity=${details.integrity} schema=${details.schema} epoch=${details.epoch} maintenance=${details.maintenanceStateAtBoot}`;
    if (mode === "normal") {
      console.log(`[instrumentation] production preflight: OK ${summary}`);
    } else {
      console.error(`[instrumentation] production preflight: DEGRADED ${summary}`);
    }
  } catch (e) {
    // فشل فحص الإقلاع نفسه لا يجب أن يمنع الخادم من الإقلاع — الحراس يفشلون مغلقين
    console.error("[instrumentation] startup recovery check failed (fail-closed guards remain active):", e);
    try {
      const { setBootStatus } = await import("@/lib/boot-status");
      setBootStatus({
        mode: "unhealthy",
        checkedAt: new Date().toISOString(),
        details: {
          config: "skipped",
          dbFile: "skipped",
          integrity: "skipped",
          schema: "skipped",
          epoch: "fail",
          maintenanceStateAtBoot: "unknown",
          preflightCompleted: false,
        },
        unhealthyReason: "preflight_incomplete",
      });
    } catch {
      /* لا شيء يمنع الإقلاع */
    }
  }
}
