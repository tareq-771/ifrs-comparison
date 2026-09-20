// Phase 4A — تنزيل ZIP (database.db + manifest.json) — بثّ من BACKUP_DIR عبر
// فحص صلاحية حصرًا (النسخ خارج public/ — لا مسارات مباشرة من العميل).

import { NextResponse } from "next/server";
import { requireManageBackups } from "@/lib/session";
import { getClientIp, writeAuditSafe } from "@/lib/audit";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { getBackupZipForDownload, BackupError } from "@/lib/backup-server";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireManageBackups();
    const { id } = await ctx.params;
    const file = getBackupZipForDownload(id);
    await writeAuditSafe({
      user: { id: user.id, username: user.username },
      action: AUDIT_ACTIONS.BACKUP_DOWNLOADED,
      entityType: AUDIT_ENTITY_TYPES.Backup,
      entityId: id,
      description: `تنزيل حزمة النسخة «${id}» (${file.sizeBytes} بايت)`,
      metadata: { backupId: id, bytes: file.sizeBytes },
      ip: getClientIp(req),
    });
    return new Response(new Uint8Array(file.buf), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(file.sizeBytes),
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof BackupError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.httpStatus });
    }
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل التنزيل: " + msg : msg },
      { status }
    );
  }
}
