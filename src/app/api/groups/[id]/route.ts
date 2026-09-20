import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, getClientIp } from "@/lib/audit";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status =
    msg === "Unauthorized"
      ? 401
      : msg === "Forbidden"
      ? 403
      : 500;
  return { status, msg };
}

// GET /api/groups/[id] — fetch one group (must belong to current user)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requirePermission("groups");
    const { id } = await params;
    const group = await db.group.findUnique({
      where: { id },
      include: { _count: { select: { reports: true } } },
    });
    if (!group || group.userId !== user.id) {
      return NextResponse.json({ error: "المجموعة غير موجودة" }, { status: 404 });
    }
    return NextResponse.json({
      id: group.id,
      name: group.name,
      userId: group.userId,
      reportCount: group._count.reports,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    });
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل في جلب المجموعة: " + msg : msg },
      { status }
    );
  }
}

// PUT /api/groups/[id] — rename a group
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requirePermission("groups");
    const { id } = await params;
    const group = await db.group.findUnique({ where: { id } });
    if (!group || group.userId !== user.id) {
      return NextResponse.json({ error: "المجموعة غير موجودة" }, { status: 404 });
    }
    const body = await req.json();
    const name = (body.name || "").toString().trim();
    if (!name || name === group.name) {
      if (!name) {
        return NextResponse.json(
          { error: "اسم المجموعة مطلوب" },
          { status: 400 }
        );
      }
      // لا تغيير فعلي — لا أثر رقابي
      return NextResponse.json(group);
    }
    // Case-insensitive duplicate check against the user's other groups.
    // SQLite doesn't support Prisma's `mode: "insensitive"`, so we compare in JS.
    const siblings = await db.group.findMany({
      where: { userId: user.id, NOT: { id } },
      select: { name: true },
    });
    const dup = siblings.some(
      (g) => g.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (dup) {
      return NextResponse.json(
        { error: "يوجد مجموعة بنفس الاسم" },
        { status: 409 }
      );
    }
    // التعديل + تسجيل أثره الرقابي في نفس المعاملة
    const updated = await db.$transaction(async (tx) => {
      const g = await tx.group.update({ where: { id }, data: { name } });
      await writeAudit(tx, {
        user,
        action: AUDIT_ACTIONS.GROUP_UPDATED,
        entityType: AUDIT_ENTITY_TYPES.Group,
        entityId: id,
        description: `تعديل المجموعة «${group.name}» → «${name}»`,
        before: { name: group.name },
        after: { name },
        ip: getClientIp(req),
      });
      return g;
    });
    return NextResponse.json(updated);
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل في تحديث المجموعة: " + msg : msg },
      { status }
    );
  }
}

// DELETE /api/groups/[id] — delete group (set reports.groupId to null)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requirePermission("groups");
    const { id } = await params;
    const group = await db.group.findUnique({ where: { id } });
    if (!group || group.userId !== user.id) {
      return NextResponse.json({ error: "المجموعة غير موجودة" }, { status: 404 });
    }
    const reportCount = await db.report.count({ where: { groupId: id } });
    // الحذف (وفك ربط التقارير) + تسجيل الأثر الرقابي في نفس المعاملة
    await db.$transaction(async (tx) => {
      await tx.report.updateMany({ where: { groupId: id }, data: { groupId: null } });
      await tx.group.delete({ where: { id } });
      await writeAudit(tx, {
        user,
        action: AUDIT_ACTIONS.GROUP_DELETED,
        entityType: AUDIT_ENTITY_TYPES.Group,
        entityId: id,
        description: `حذف المجموعة «${group.name}» — فُكّت ربط ${reportCount} تقريرًا`,
        before: { name: group.name, reportCount },
        metadata: { unlinkedReports: reportCount },
        ip: getClientIp(req),
      });
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل في حذف المجموعة: " + msg : msg },
      { status }
    );
  }
}
