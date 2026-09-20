// Phase 4A — رفع حزمة نسخة للتحقق — staging فقط (لا تدخل BACKUP_DIR ولا تمس
// أي شيء). ضوابط ZIP الصارمة ثم نفس خط التحقق المشترك.

import { NextRequest, NextResponse } from "next/server";
import { requireManageBackups } from "@/lib/session";
import { getClientIp } from "@/lib/audit";
import { uploadBackupZip, BackupError } from "@/lib/backup-server";
import { UPLOAD_LIMITS, sanitizeDisplayName } from "@/lib/backup-config";
import { guardWrite } from "@/lib/api-guard";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

export async function POST(req: NextRequest) {
  return guardWrite("/api/backups/upload", async () => {
    try {
      const user = await requireManageBackups();
      void getClientIp(req);
      const body = await req.json().catch(() => null);
      if (!body || typeof body.dataBase64 !== "string" || body.dataBase64.length === 0) {
        return NextResponse.json({ error: "حمولة الرفع غير صالحة" }, { status: 400 });
      }
      // الحد المضغوط — فحص قبل فك base64 (1.37×)
      const approxBytes = Math.floor((body.dataBase64.length * 3) / 4);
      if (approxBytes > UPLOAD_LIMITS.maxUploadMB * 1024 * 1024) {
        return NextResponse.json(
          { error: `الحجم المضغوط يتجاوز الحد (${UPLOAD_LIMITS.maxUploadMB} MB)`, code: "TOO_LARGE" },
          { status: 413 }
        );
      }
      const bytes = Buffer.from(body.dataBase64, "base64");
      if (bytes.length === 0) {
        return NextResponse.json({ error: "الحمولة غير صالحة" }, { status: 400 });
      }
      const name = typeof body.name === "string" ? sanitizeDisplayName(body.name) : "(بدون اسم)";
      const result = await uploadBackupZip({ id: user.id || null, username: user.username }, bytes, name);
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
        { error: status === 500 ? "فشل الرفع: " + msg : msg },
        { status }
      );
    }
  });
}
