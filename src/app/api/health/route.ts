// Phase 5A — Health endpoint محدود المعلومات (لـ Caddy/systemd/المشغّل).
//
// العقد (نص المستخدم 5A):
//   «/api/health محدود المعلومات بحالات healthy, maintenance,
//    recovery_required, unhealthy — دون كشف معلومات حساسة أو بيانات مالية.»
//
// المنطق:
//   • الحالة الحية تُقرأ عند كل طلب: حالة الصيانة + توفر epoch (قد تتغير بعد
//     الإقلاع: RECOVERY_REQUIRED لاحقًا أو تطبيع يدوي).
//   • نتائج preflight الإقلاع (config/قاعدة/مخطط) ثابتة للعملية — من boot-status.
//   • HTTP: healthy=200 · maintenance=200 (مخطط، الخدمة تعمل) ·
//     recovery_required=503 · unhealthy=503.
//   • الجسم: {status, reason?, app, version, serverTime} — بلا epoch بقيمته،
//     بلا مسارات، بلا operationId، بلا أي بيانات تطبيقية.

import { NextResponse } from "next/server";
import { maintenancePublicInfo } from "@/lib/maintenance";
import { isEpochAvailable } from "@/lib/session-epoch";
import { getBootStatus } from "@/lib/boot-status";
import { appVersion } from "@/lib/backup-config";

export const dynamic = "force-dynamic";

type HealthStatus = "healthy" | "maintenance" | "recovery_required" | "unhealthy";

export async function GET() {
  let status: HealthStatus = "healthy";
  let reason: string | undefined;

  const boot = getBootStatus();
  const mInfo = maintenancePublicInfo();
  const epochAvailable = isEpochAvailable();

  // 1) حالة الصيانة الحية (الأسبقية العليا — قد تتغير بعد الإقلاع)
  if (mInfo.state === "RECOVERY_REQUIRED" || mInfo.stateFileStatus === "corrupt") {
    status = "recovery_required";
    reason = "recovery_required";
  } else if (mInfo.state !== "NORMAL") {
    status = "maintenance";
    reason = `maintenance:${mInfo.state}`;
  } else if (!epochAvailable) {
    // fail-safe 4B.1: العدّاد غير قابل للقراءة ⇒ لا جلسات ولا كتابات — غير صحي
    status = "unhealthy";
    reason = "epoch_unavailable";
  } else if (boot && (boot.mode === "unhealthy" || boot.details.config === "fail")) {
    // نتيجة preflight الإقلاع (تهيئة/قاعدة/مخطط)
    status = "unhealthy";
    reason = boot.unhealthyReason ?? "preflight_failed";
  } else if (boot && boot.mode === "recovery_required") {
    status = "recovery_required";
    reason = "recovery_required";
  } else if (boot && boot.mode === "maintenance") {
    status = "maintenance";
    reason = "maintenance_at_boot";
  }

  const body: Record<string, unknown> = {
    status,
    app: "ifrs-comparison-tool",
    version: appVersion(),
    serverTime: new Date().toISOString(),
  };
  if (reason) body.reason = reason;

  const httpStatus = status === "healthy" || status === "maintenance" ? 200 : 503;
  return NextResponse.json(body, { status: httpStatus });
}
