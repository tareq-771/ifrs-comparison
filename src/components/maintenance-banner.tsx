"use client";

// Phase 4B.1 — شريط الصيانة العام (القسم 21 من وثيقة التصميم).
// يستطلع /api/system/status دوريًا (كل 15 ثانية) وعند أي 503 يعرض فورًا.
// المستويات:
//   write-block (كهرماني): «التعديلات معلقة مؤقتًا» — القراءة تعمل.
//   full-block (أحمر): «الخدمة في صيانة كاملة — استعادة قيد التنفيذ».
//   RECOVERY_REQUIRED (أحمر مقفل): operationId + سبب آمن + خطوات الاسترداد اليدوي
//   الموثقة — لا reset تلقائي أبدًا.

import * as React from "react";
import { AlertTriangle, Loader2, Wrench } from "lucide-react";

interface StatusPayload {
  maintenance: {
    active: boolean;
    state: string;
    level: "write-block" | "full-block" | "locked" | null;
    operationId: string | null;
    startedAt: string | null;
    startedBy: string | null;
    message: string | null;
    recovery: { reason: string; originalState: string | null; originalOperationId: string | null } | null;
    stateFileStatus: "missing" | "ok" | "corrupt";
  };
  epoch: { available: boolean };
  serverTime: string;
}

export function MaintenanceBanner() {
  const [status, setStatus] = React.useState<StatusPayload | null>(null);

  const poll = React.useCallback(async () => {
    try {
      const res = await fetch("/api/system/status", { cache: "no-store" });
      if (res.ok) setStatus((await res.json()) as StatusPayload);
    } catch {
      /* الخادم غير متاح — لا تغيير */
    }
  }, []);

  React.useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), 15_000);
    // عند أي استجابة 503 من أي استدعاء آخر — أسرّع الاستطلاع
    const onBlocked = () => void poll();
    window.addEventListener("maintenance-blocked", onBlocked);
    return () => {
      clearInterval(t);
      window.removeEventListener("maintenance-blocked", onBlocked);
    };
  }, [poll]);

  if (!status?.maintenance.active && status?.epoch.available !== false) return null;

  const m = status.maintenance;

  if (m.state === "RECOVERY_REQUIRED" || m.stateFileStatus === "corrupt" || status.epoch.available === false) {
    return (
      <div
        role="alert"
        className="sticky top-0 z-50 border-b border-rose-300 bg-rose-100 px-4 py-2 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <AlertTriangle className="size-4 shrink-0" />
          <strong className="font-bold">الخدمة مقفلة — تدخل تشغيلي يدوي مطلوب (RECOVERY_REQUIRED)</strong>
          {m.operationId && <span className="font-mono" dir="ltr">operation: {m.operationId}</span>}
          {m.recovery?.reason && <span dir="ltr" className="font-mono opacity-80">reason: {m.recovery.reason}</span>}
          {m.recovery?.originalState && <span className="opacity-80">الحالة الأصلية: {m.recovery.originalState}</span>}
          <span className="opacity-80">
            القراءة والكتابة محجوبتان. لا يوجد reset تلقائي — الاسترداد عبر إجراء المشغّل اليدوي الموثق
            (scripts/restore-operator.ts) بعد التحقق من سلامة القاعدة.
          </span>
        </div>
      </div>
    );
  }

  if (m.level === "write-block") {
    return (
      <div
        role="status"
        className="sticky top-0 z-50 border-b border-amber-300 bg-amber-100 px-4 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <Wrench className="size-4 shrink-0" />
          <strong className="font-bold">صيانة النظام — التعديلات معلقة مؤقتًا</strong>
          <span className="opacity-80">القراءة متاحة · الاستعادة قيد التنفيذ</span>
          {m.operationId && <span className="font-mono" dir="ltr">operation: {m.operationId}</span>}
        </div>
      </div>
    );
  }

  if (m.level === "full-block") {
    return (
      <div
        role="alert"
        className="sticky top-0 z-50 border-b border-rose-300 bg-rose-100 px-4 py-2 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <Loader2 className="size-4 shrink-0 animate-spin" />
          <strong className="font-bold">الخدمة في صيانة كاملة — استعادة قيد التنفيذ</strong>
          <span className="opacity-80">القراءة والكتابة محجوبتان مؤقتًا</span>
          {m.operationId && <span className="font-mono" dir="ltr">operation: {m.operationId}</span>}
        </div>
      </div>
    );
  }

  return null;
}
