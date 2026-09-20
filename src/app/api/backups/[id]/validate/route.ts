// Phase 4A — تشغيل خط التحقق الكامل على نسخة قائمة (checksum + SQLite +
// integrity + مخطط معروف + اتساق Manifest) — على نسخ مرحلية حصرًا.

import { NextResponse } from "next/server";
import { requireManageBackups } from "@/lib/session";
import { validateBackupById, BackupError } from "@/lib/backup-server";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireManageBackups();
    const { id } = await ctx.params;
    const report = await validateBackupById(id, { id: user.id || null, username: user.username });
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof BackupError) {
      return NextResponse.json(
        { error: error.message, code: error.code, ...(error.extra ?? {}) },
        { status: error.httpStatus }
      );
    }
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل التحقق: " + msg : msg },
      { status }
    );
  }
}
