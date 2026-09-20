import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";

// GET /api/audit/export — تصدير سجل التدقيق CSV (مدير فقط) وفق نفس فلاتر القائمة.
// - CSV مع BOM لدعم العربية في Excel، واقتباس RFC4180.
// - حد أقصى 5000 صف لكل عملية تصدير (حماية الذاكرة) — مرتب زمنيًا تصاعديًا.
export async function GET(req: NextRequest) {
  return guardRead("/api/audit/export", async () => {
  try {
    await requireAdmin();
    const { searchParams } = new URL(req.url);

    const userId = searchParams.get("userId") || undefined;
    const action = searchParams.get("action") || undefined;
    const entityType = searchParams.get("entityType") || undefined;
    const entityId = searchParams.get("entityId") || undefined;
    const q = searchParams.get("q") || undefined;
    const from = searchParams.get("from") || undefined;
    const to = searchParams.get("to") || undefined;

    const where: Prisma.AuditLogWhereInput = {};
    if (userId) where.userId = userId;
    if (action) where.action = action;
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;
    if (q) where.description = { contains: q };
    if (from || to) {
      where.createdAt = {};
      if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
        where.createdAt.gte = new Date(`${from}T00:00:00.000Z`);
      }
      if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        where.createdAt.lte = new Date(`${to}T23:59:59.999Z`);
      }
    }

    const EXPORT_CAP = 5000;
    const rows = await db.auditLog.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: EXPORT_CAP + 1, // +1 لكشف تجاوز الحد
    });
    const truncated = rows.length > EXPORT_CAP;
    const data = rows.slice(0, EXPORT_CAP);

    const headers = [
      "createdAtUTC",
      "userId",
      "username",
      "action",
      "entityType",
      "entityId",
      "description",
      "ipAddress",
      "beforeData",
      "afterData",
      "metadata",
    ];

    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? "" : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };

    const lines: string[] = [headers.map(esc).join(",")];
    for (const r of data) {
      lines.push(
        [
          r.createdAt.toISOString(), // ISO-8601 UTC — توقيت أصلي غير ملتبس
          r.userId,
          r.username,
          r.action,
          r.entityType,
          r.entityId,
          r.description,
          r.ipAddress,
          r.beforeData,
          r.afterData,
          r.metadata,
        ]
          .map(esc)
          .join(",")
      );
    }
    if (truncated) {
      lines.push(esc(`[تنبيه: تم اقتطاع التصدير عند ${EXPORT_CAP} صفًا — استخدم فلاتر أدق]`));
    }

    const csv = "\uFEFF" + lines.join("\r\n");
    const now = new Date();
    const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(
      now.getUTCDate()
    ).padStart(2, "0")}-${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}${String(now.getUTCSeconds()).padStart(2, "0")}`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-log-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "خطأ";
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden: admin only" ? 403 : 500;
    return NextResponse.json(
      { error: status === 500 ? "فشل في تصدير سجل التدقيق: " + msg : msg },
      { status }
    );
  }
  });
}
