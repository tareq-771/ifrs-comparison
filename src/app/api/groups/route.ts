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

// GET /api/groups — list groups for current user
//   • Admin: all groups (governance — يحتاج الوصول لأي تقرير للإسناد/إعادة الفتح).
//   • If the user has `permissions.groupIds` set to a non-empty array, return only
//     those groups (regardless of ownership) — used to share a subset of groups
//     with a non-admin user.
//   • Otherwise, fall back to all groups owned by the current user.
export async function GET() {
  try {
    const user = await requirePermission("groups");
    const linkedGroupIds = user.permissions.groupIds;
    const isAdmin = user.role === "admin";
    const useLinkedFilter = !isAdmin && Array.isArray(linkedGroupIds) && linkedGroupIds.length > 0;

    const groups = await db.group.findMany({
      where: isAdmin
        ? {}
        : useLinkedFilter
          ? { id: { in: linkedGroupIds as string[] } }
          : { userId: user.id },
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { reports: true } },
        user: { select: { username: true, displayName: true } },
      },
    });
    return NextResponse.json(
      groups.map((g) => ({
        id: g.id,
        name: g.name,
        userId: g.userId,
        // اسم المالك للمدير (حوكمة) — يظهر في حوار الفتح لتمييز مجموعات الآخرين
        ownerName: g.user?.displayName || g.user?.username || "",
        reportCount: g._count.reports,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
      }))
    );
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل في جلب المجموعات: " + msg : msg },
      { status }
    );
  }
}

// POST /api/groups — create a group owned by current user
export async function POST(req: NextRequest) {
  try {
    const user = await requirePermission("groups");
    const body = await req.json();
    const name = (body.name || "").toString().trim();
    if (!name) {
      return NextResponse.json(
        { error: "اسم المجموعة مطلوب" },
        { status: 400 }
      );
    }
    // Case-insensitive duplicate-name check (per user) — prevents silent duplicates
    // when two clients race or when the client-side check is bypassed.
    // Note: SQLite does not support Prisma's `mode: "insensitive"`, so we fetch
    // the user's groups and compare in JavaScript. Works for both ASCII and Arabic.
    const owned = await db.group.findMany({
      where: { userId: user.id },
      select: { id: true, name: true },
    });
    const dup = owned.some(
      (g) => g.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (dup) {
      return NextResponse.json(
        { error: "يوجد مجموعة بنفس الاسم" },
        { status: 409 }
      );
    }
    // إنشاء المجموعة + تسجيل أثرها الرقابي في نفس المعاملة
    const group = await db.$transaction(async (tx) => {
      const created = await tx.group.create({
        data: {
          name,
          userId: user.id,
        },
      });
      await writeAudit(tx, {
        user,
        action: AUDIT_ACTIONS.GROUP_CREATED,
        entityType: AUDIT_ENTITY_TYPES.Group,
        entityId: created.id,
        description: `إنشاء المجموعة «${created.name}»`,
        after: { name: created.name },
        ip: getClientIp(req),
      });
      return created;
    });
    return NextResponse.json(group, { status: 201 });
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل في إنشاء المجموعة: " + msg : msg },
      { status }
    );
  }
}
