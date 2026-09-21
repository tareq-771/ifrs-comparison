// Phase 5A — Health endpoint محدود المعلومات (لـ Caddy/الخدمة/المشغّل).
// Phase 5B.1 — تقليل الإفصاح النهائي (نص المستخدم §6):
//   الجسم العام: {status, app, serverTime} حصرًا — بلا version، بلا paths،
//   بلا DB counts، بلا أسماء مستخدمين، بلا schema fingerprint، بلا أسرار،
//   بلا تفاصيل recovery. عند unhealthy (config/schema/epoch): لا سبب تفصيلي
//   للعامة إطلاقًا — التفاصيل الرمزية في سجلات الخادم/الإدارة فقط (preflight
//   يسجلها عند الإقلاع، والحراس يسجلون حالاتهم لاحقًا).
// HTTP: healthy=200 · maintenance=503 · recovery_required=503 · unhealthy=503.

import { NextResponse } from "next/server";
import { maintenancePublicInfo } from "@/lib/maintenance";
import { isEpochAvailable } from "@/lib/session-epoch";
import { getBootStatus } from "@/lib/boot-status";

export const dynamic = "force-dynamic";

type HealthStatus = "healthy" | "maintenance" | "recovery_required" | "unhealthy";

export async function GET() {
  let status: HealthStatus = "healthy";

  const boot = getBootStatus();
  const mInfo = maintenancePublicInfo();
  const epochAvailable = isEpochAvailable();

  // 1) حالة الصيانة الحية (الأسبقية العليا — قد تتغير بعد الإقلاع)
  // 5B.1: بلا تفاصيل sub-state في الاستجابة — الرمز التفصيلي في سجلات الخادم
  if (mInfo.state === "RECOVERY_REQUIRED" || mInfo.stateFileStatus === "corrupt") {
    status = "recovery_required";
  } else if (mInfo.state !== "NORMAL") {
    status = "maintenance";
  } else if (!epochAvailable) {
    // fail-safe 4B.1: العدّاد غير قابل للقراءة — غير صحي (السبب للسجل حصرًا)
    console.error("[health] unhealthy: epoch_unavailable (تفاصيل السجل فقط)");
    status = "unhealthy";
  } else if (boot && (boot.mode === "unhealthy" || boot.details.config === "fail")) {
    // نتيجة preflight الإقلاع — السبب التفصيلي (boot_config/database/schema/epoch)
    // في سجل الخادم عند الإقلاع حصرًا، لا في الاستجابة العامة
    status = "unhealthy";
  } else if (boot && boot.mode === "recovery_required") {
    status = "recovery_required";
  } else if (boot && boot.mode === "maintenance") {
    status = "maintenance";
  }

  // 5B.1: الجسم العام محدود — status/app/serverTime حصرًا، بلا reason عام
  const body: Record<string, unknown> = {
    status,
    app: "ifrs-comparison-tool",
    serverTime: new Date().toISOString(),
  };

  const httpStatus = status === "healthy" ? 200 : 503;
  return NextResponse.json(body, { status: httpStatus });
}
