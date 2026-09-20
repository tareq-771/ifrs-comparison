import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden: admin only" ? 403 : 500;
  return { status, msg };
}

function parseJsonSafe(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// GET /api/audit — قائمة سجل التدقيق (مدير فقط — قراءة بلا أي تعديل)
//
// فلاتر مدعومة (query params):
//   page, pageSize (20 افتراضيًا، حد أقصى 100)
//   userId, action, entityType, entityId, q (بحث في الوصف)
//   from, to — تواريخ بحدود YYYY-MM-DD (يُفسَّران كأيام UTC — يُعرض في الواجهة
//             التوقيت المحلي + ISO-UTC لكل سجل لمنع الالتباس)
export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
    const { searchParams } = new URL(req.url);

    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("pageSize") || "20", 10) || 20)
    );

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

    const [total, rows] = await Promise.all([
      db.auditLog.count({ where }),
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return NextResponse.json({
      rows: rows.map((r) => ({
        ...r,
        beforeData: parseJsonSafe(r.beforeData),
        afterData: parseJsonSafe(r.afterData),
        metadata: parseJsonSafe(r.metadata),
      })),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل في جلب سجل التدقيق: " + msg : msg },
      { status }
    );
  }
}
