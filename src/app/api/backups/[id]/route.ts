// Phase 4A — تفاصيل نسخة (Manifest كامل + حالة الحزمة).

import { NextResponse } from "next/server";
import { requireManageBackups } from "@/lib/session";
import { getBackupDetails, BackupError } from "@/lib/backup-server";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireManageBackups();
    const { id } = await ctx.params;
    const details = getBackupDetails(id);
    if (!details) {
      return NextResponse.json({ error: "لا توجد نسخة بهذا المعرف" }, { status: 404 });
    }
    return NextResponse.json(details);
  } catch (error) {
    if (error instanceof BackupError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.httpStatus });
    }
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل جلب تفاصيل النسخة: " + msg : msg },
      { status }
    );
  }
}
