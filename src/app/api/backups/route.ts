// Phase 4A — GET: القائمة (من Manifestات لا من الأسماء) / POST: إنشاء نسخة.
// البوابة: manageBackups حصرًا (المدير ضمنيًا بالدور — settings لا تمنح شيئًا D-5).

import { NextRequest, NextResponse } from "next/server";
import { requireManageBackups } from "@/lib/session";
import { getClientIp } from "@/lib/audit";
import { createBackup, listBackups, BackupError } from "@/lib/backup-server";
import { BACKUP_CREATE_COOLDOWN_MS, UPLOAD_LIMITS } from "@/lib/backup-config";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

export async function GET() {
  try {
    await requireManageBackups();
    const data = listBackups();
    return NextResponse.json({
      ...data,
      config: {
        maxUploadMB: UPLOAD_LIMITS.maxUploadMB,
        maxUncompressedMB: UPLOAD_LIMITS.maxUncompressedMB,
        cooldownSeconds: BACKUP_CREATE_COOLDOWN_MS / 1000,
        allowedZipEntries: ["database.db", "manifest.json"],
      },
      policy: {
        // بطاقة السياسة — نصوص موثقة (لا مسارات قرص ولا أسرار)
        backupLocation:
          "مجلد بيانات نسخ مستقل عن كود التطبيق (BACKUP_DIR قابل للتهيئة — خارج public/ وخارج Git للأمام فقط)",
        noAutoDelete: "لا حذف تلقائي لأي نسخة — الاحتفاظ قرار تشغيلي يدوي",
        rpoNote:
          "النسخ اليدوي وحده لا يضمن RPO ≤ 24 ساعة — تحقيق ذلك يتطلب لاحقًا Scheduled Backup ناجحًا ومراقبًا",
        rtoNote: "RTO ≤ 30 دقيقة توصية أولية تتحقق بالتدريب على Recovery Test",
        encryptionNote:
          "0600 ≠ تشفير: النسخ تحتوي بيانات مالية وهاشات كلمات المرور — أي تخزين خارجي مستقبلي ملزم بالتشفير at rest/in transit",
        authenticityNote:
          "VALIDATED/RESTORE_VERIFIED = تحقق سلامة واتساق — ليست إثبات أصالة تشفيرية (توقيع Manifest مستقبلًا)",
      },
    });
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل جلب قائمة النسخ: " + msg : msg },
      { status }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireManageBackups();
    const result = await createBackup({ id: user.id || null, username: user.username });
    void getClientIp(req);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof BackupError) {
      return NextResponse.json(
        { error: error.message, code: error.code, ...(error.extra ?? {}) },
        { status: error.httpStatus }
      );
    }
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل إنشاء النسخة: " + msg : msg },
      { status }
    );
  }
}
