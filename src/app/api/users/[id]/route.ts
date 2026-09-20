import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, AUDIT_ACTION_PRIORITY } from "@/lib/audit-actions";
import { writeAudit, getClientIp } from "@/lib/audit";
import {
  DEFAULT_USER_PERMISSIONS,
  ADMIN_PERMISSIONS,
  stringifyPermissions,
  type Permissions,
} from "@/lib/permissions";
import { guardWrite, guardRead } from "@/lib/api-guard";

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

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status =
    msg === "Unauthorized"
      ? 401
      : msg === "Forbidden: admin only"
      ? 403
      : 500;
  return { status, msg };
}

// GET /api/users/[id] — fetch one user (admin only)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return guardRead("/api/users/[id]", async () => {
    try {
      await requireAdmin();
      const { id } = await params;
      const user = await db.user.findUnique({ where: { id } });
      if (!user) {
        return NextResponse.json({ error: "المستخدم غير موجود" }, { status: 404 });
      }
      return NextResponse.json(toPublic(user));
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في جلب المستخدم: " + msg : msg },
        { status }
      );
    }
  });}

// PUT /api/users/[id] — update a user (admin only)
// If `password` is empty/undefined → leave password unchanged.
// If `password` is provided → hash it with bcrypt.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return guardWrite("/api/users/[id]", async () => {
    try {
      const admin = await requireAdmin();
      const { id } = await params;
      const body = await req.json();

      const existing = await db.user.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json({ error: "المستخدم غير موجود" }, { status: 404 });
      }

      // Username change conflict check
      const newUsername = (body.username || "").toString().trim();
      if (newUsername && newUsername !== existing.username) {
        const conflict = await db.user.findUnique({ where: { username: newUsername } });
        if (conflict) {
          return NextResponse.json(
            { error: "اسم المستخدم مستخدم بالفعل" },
            { status: 409 }
          );
        }
      }

      // Build permissions
      const role = body.role === "admin" ? "admin" : body.role === "user" ? "user" : existing.role;

      // Normalize `groupIds` (user↔group linkage). For admins we drop the field
      // entirely (they see all groups). For regular users we coerce to a clean
      // string array (or omit if empty). If `body.groupIds` is not provided we
      // preserve whatever was already stored.
      let groupIds: string[] | undefined;
      if (role === "admin") {
        groupIds = undefined; // admins always see everything
      } else if (Array.isArray(body.groupIds)) {
        const cleaned = body.groupIds
          .filter((g: unknown): g is string => typeof g === "string" && g.length > 0)
          .map((g) => g);
        groupIds = cleaned.length > 0 ? cleaned : undefined;
      } else {
        // Preserve existing groupIds from the user's current permissions JSON
        try {
          const parsed = JSON.parse(existing.permissions || "{}");
          if (Array.isArray(parsed?.groupIds) && parsed.groupIds.length > 0) {
            const preserved: string[] = parsed.groupIds.filter(
              (g: unknown): g is string => typeof g === "string" && g.length > 0
            );
            groupIds = preserved.length > 0 ? preserved : undefined;
          }
        } catch {
          groupIds = undefined;
        }
      }

      let perms: Permissions;
      if (role === "admin") {
        perms = ADMIN_PERMISSIONS;
      } else if (body.permissions && typeof body.permissions === "object") {
        perms = { ...DEFAULT_USER_PERMISSIONS, ...body.permissions, groupIds };
      } else if (role !== existing.role) {
        // تغيير الدور إلى مستخدم — نبدأ من الافتراضي (لا وراثة صلاحيات مدير)
        perms = { ...DEFAULT_USER_PERMISSIONS, groupIds };
      } else {
        // لا صلاحيات في الطلب والدور دون تغيير (مثل تبديل التفعيل) —
        // إصلاح خلل قديم كشفه سجل التدقيق: كان يُعاد بناء الصلاحيات من الافتراضي
        // ويمسح أي تخصيصات سابقة للمستخدم.
        let preserved: Partial<Permissions> = {};
        try {
          preserved = JSON.parse(existing.permissions || "{}");
        } catch {
          preserved = {};
        }
        perms = { ...DEFAULT_USER_PERMISSIONS, ...preserved, groupIds };
      }

      // Build update payload (do not touch passwordHash unless a new password is provided)
      const data: {
        username?: string;
        displayName?: string;
        role?: string;
        permissions?: string;
        active?: boolean;
        passwordHash?: string;
      } = {
        permissions: stringifyPermissions(perms),
      };

      if (newUsername) data.username = newUsername;
      if (body.displayName !== undefined)
        data.displayName = (body.displayName || "").toString();
      if (body.role !== undefined) data.role = role;
      if (body.active !== undefined) data.active = body.active === true;

      if (typeof body.password === "string" && body.password.trim() !== "") {
        data.passwordHash = await bcrypt.hash(body.password, 10);
      }

      // حساب التغييرات للأثر الرقابي (قبل/بعد — حقول عامة فقط، لا هاش ولا كلمات مرور)
      const publicFields = ["username", "displayName", "role", "active"] as const;
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const changedFields: string[] = [];
      for (const f of publicFields) {
        const oldVal = existing[f];
        const newVal = data[f] !== undefined ? data[f] : oldVal;
        if (data[f] !== undefined && JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          before[f] = oldVal;
          after[f] = newVal;
          changedFields.push(f);
        }
      }
      const permsChanged = !!data.permissions && data.permissions !== existing.permissions;
      if (permsChanged) {
        before.permissions = JSON.parse(existing.permissions || "{}");
        after.permissions = JSON.parse(data.permissions!);
        changedFields.push("permissions");
      }
      const passwordChanged = !!data.passwordHash;

      // اختيار كود العملية: الأخطر أولًا (PERMISSIONS > ROLE > DISABLE/ENABLE > UPDATE)
      let action: string = AUDIT_ACTIONS.USER_UPDATED;
      if (permsChanged) action = AUDIT_ACTIONS.PERMISSIONS_CHANGED;
      else if (changedFields.includes("role")) action = AUDIT_ACTIONS.ROLE_CHANGED;
      else if (changedFields.includes("active"))
        action = existing.active ? AUDIT_ACTIONS.USER_DISABLED : AUDIT_ACTIONS.USER_ENABLED;

      const user = await db.$transaction(async (tx) => {
        const updated = await tx.user.update({ where: { id }, data });
        if (changedFields.length > 0 || passwordChanged) {
          await writeAudit(tx, {
            user: admin,
            action,
            entityType: AUDIT_ENTITY_TYPES.User,
            entityId: id,
            description: `تعديل المستخدم «${updated.username}» — الحقول المتغيرة: ${changedFields.join(", ")}${passwordChanged ? " + إعادة تعيين كلمة المرور" : ""}`,
            before,
            after,
            metadata: {
              changedFields,
              passwordChanged,
              actionPriority: AUDIT_ACTION_PRIORITY.indexOf(action),
            },
            ip: getClientIp(req),
          });
        }
        return updated;
      });
      return NextResponse.json(toPublic(user));
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في تحديث المستخدم: " + msg : msg },
        { status }
      );
    }
  });
}

// DELETE /api/users/[id] — delete a user (admin only, prevent self-deletion)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return guardWrite("/api/users/[id]", async () => {
    try {
      const admin = await requireAdmin();
      const { id } = await params;
      if (admin.id === id) {
        return NextResponse.json(
          { error: "لا يمكن حذف حسابك الحالي" },
          { status: 400 }
        );
      }
      const existing = await db.user.findUnique({ where: { id } });
      if (!existing) {
        return NextResponse.json({ error: "المستخدم غير موجود" }, { status: 404 });
      }
      // الحذف + تسجيل أثره الرقابي في نفس المعاملة
      // (التقاط public shape فقط — بلا هاش؛ اسم المستخدم يبقى snapshot في AuditLog)
      await db.$transaction(async (tx) => {
        await tx.user.delete({ where: { id } });
        await writeAudit(tx, {
          user: admin,
          action: AUDIT_ACTIONS.USER_DELETED,
          entityType: AUDIT_ENTITY_TYPES.User,
          entityId: id,
          description: `حذف المستخدم «${existing.username}»`,
          before: {
            username: existing.username,
            displayName: existing.displayName,
            role: existing.role,
            active: existing.active,
            permissions: JSON.parse(existing.permissions || "{}"),
          },
          ip: getClientIp(req),
        });
      });
      return NextResponse.json({ success: true });
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في حذف المستخدم: " + msg : msg },
        { status }
      );
    }
  });
}
