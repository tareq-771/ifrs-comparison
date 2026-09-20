import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { requireAdmin, requireAuth } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, getClientIp } from "@/lib/audit";
import {
  DEFAULT_USER_PERMISSIONS,
  ADMIN_PERMISSIONS,
  stringifyPermissions,
  type Permissions,
} from "@/lib/permissions";

// Public user shape (never exposes passwordHash)
type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  role: string;
  permissions: Permissions;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toPublic(u: {
  id: string;
  username: string;
  displayName: string;
  role: string;
  permissions: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    permissions: JSON.parse(u.permissions) as Permissions,
    active: u.active,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

// GET /api/users — list all users (admin only)
// GET /api/users?for=assignment — قائمة مرشحي الإسناد (حيازو assignWorkflow أو المدير)
//   تعرض الحد الأدنى فقط: {id, username, displayName, active} — بلا أدوار ولا صلاحيات
//   ولا بيانات إدارة المستخدمين (تعديل المستخدم رقم 12).
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    if (searchParams.get("for") === "assignment") {
      const user = await requireAuth();
      const canAssign = user.role === "admin" || user.permissions.assignWorkflow === true;
      if (!canAssign) {
        return NextResponse.json(
          { error: "قائمة مرشحي الإسناد متاحة لحائزي صلاحية assignWorkflow فقط.", code: "FORBIDDEN" },
          { status: 403 }
        );
      }
      const users = await db.user.findMany({
        orderBy: { username: "asc" },
        select: { id: true, username: true, displayName: true, active: true },
      });
      return NextResponse.json(users);
    }
    await requireAdmin();
    const users = await db.user.findMany({
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json(users.map(toPublic));
  } catch (error) {
    const msg = error instanceof Error ? error.message : "خطأ";
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden: admin only" ? 403 : 500;
    return NextResponse.json(
      { error: status === 500 ? "فشل في جلب المستخدمين: " + msg : msg },
      { status }
    );
  }
}

// POST /api/users — create a new user (admin only)
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const body = await req.json();
    const username = (body.username || "").toString().trim();
    const password = (body.password || "").toString();
    if (!username || !password) {
      return NextResponse.json(
        { error: "اسم المستخدم وكلمة المرور مطلوبان" },
        { status: 400 }
      );
    }

    const existing = await db.user.findUnique({ where: { username } });
    if (existing) {
      return NextResponse.json(
        { error: "اسم المستخدم مستخدم بالفعل" },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const role = body.role === "admin" ? "admin" : "user";

    // Normalize `groupIds` (user↔group linkage). For admins we drop the field
    // entirely (they see all groups). For regular users we coerce to a clean
    // string array (or omit if empty).
    let groupIds: string[] | undefined;
    if (role !== "admin" && Array.isArray(body.groupIds)) {
      const cleaned = body.groupIds
        .filter((g: unknown): g is string => typeof g === "string" && g.length > 0)
        .map((g) => g);
      groupIds = cleaned.length > 0 ? cleaned : undefined;
    }

    const perms =
      role === "admin"
        ? ADMIN_PERMISSIONS
        : { ...DEFAULT_USER_PERMISSIONS, ...(body.permissions || {}), groupIds };

    // إنشاء المستخدم + تسجيل أثره الرقابي في نفس المعاملة
    // (لا تُخزن كلمة المرور أو هاشها أبدًا — serializeAuditField يحجبها مركزيًا أيضًا)
    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          username,
          passwordHash,
          displayName: (body.displayName || "").toString(),
          role,
          permissions: stringifyPermissions(perms),
          active: body.active !== false,
        },
      });
      await writeAudit(tx, {
        user: admin,
        action: AUDIT_ACTIONS.USER_CREATED,
        entityType: AUDIT_ENTITY_TYPES.User,
        entityId: created.id,
        description: `إنشاء المستخدم «${created.username}» بدور ${created.role === "admin" ? "مدير" : "مستخدم"}`,
        after: {
          username: created.username,
          displayName: created.displayName,
          role: created.role,
          active: created.active,
          permissions: JSON.parse(created.permissions),
        },
        ip: getClientIp(req),
      });
      return created;
    });
    return NextResponse.json(toPublic(user), { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "خطأ";
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden: admin only" ? 403 : 500;
    return NextResponse.json(
      { error: status === 500 ? "فشل في إنشاء المستخدم: " + msg : msg },
      { status }
    );
  }
}
