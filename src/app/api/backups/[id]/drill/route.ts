// Phase 4A — Restore Drill: فك معزول → checksum → SQLite → مخطط → integrity →
// اتصال Prisma حقيقي على قاعدة مؤقتة → قراءة الجداول → مطابقة counts/sanity.
// لا يمس قاعدة التشغيل إطلاقًا — كل شيء في var/restore-staging وينظف بعده.

import { NextResponse } from "next/server";
import { requireManageBackups } from "@/lib/session";
import { runRestoreDrillById, BackupError } from "@/lib/backup-server";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireManageBackups();
    const { id } = await ctx.params;
    const report = await runRestoreDrillById(id, { id: user.id || null, username: user.username });
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
      { error: status === 500 ? "فشل الـ Drill: " + msg : msg },
      { status }
    );
  }
}
