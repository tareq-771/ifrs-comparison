// Phase 4B.1 — حالة النظام العامة (للشريط العلوي ولوحة الإدارة).
//
// عام بلا مصادقة (قرار التصميم — القسم 10.1): المحتوى آمن حصرًا —
// حالة الصيانة ومستواها وoperationId وسبب الاسترداد — لا مسارات قرص
// ولا أسرار ولا بيانات مالية. الاستثناءات المسموحة من حجب الصيانة:
// هذا المسار + مسارات المصادقة + أدوات النسخ الاحتياطي للقراءة.

import { NextResponse } from "next/server";
import { maintenancePublicInfo } from "@/lib/maintenance";
import { readSessionEpoch } from "@/lib/session-epoch";
import { isRestoreEngineEnabled } from "@/lib/backup-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const maintenance = maintenancePublicInfo();
  const epochAvailable = readSessionEpoch() !== null;
  return NextResponse.json({
    maintenance: {
      active: maintenance.active,
      state: maintenance.state,
      level: maintenance.level,
      operationId: maintenance.operationId,
      startedAt: maintenance.startedAt,
      startedBy: maintenance.startedBy,
      message: maintenance.message,
      recovery: maintenance.recovery,
      stateFileStatus: maintenance.stateFileStatus,
    },
    epoch: { available: epochAvailable },
    restoreEngineEnabled: isRestoreEngineEnabled(),
    serverTime: new Date().toISOString(),
  });
}
