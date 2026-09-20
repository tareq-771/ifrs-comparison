import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, getClientIp } from "@/lib/audit";
import {
  ADMIN_PERMISSIONS,
  stringifyPermissions,
} from "@/lib/permissions";

// GET /api/setup — check whether initial admin setup is needed
export async function GET() {
  try {
    const count = await db.user.count();
    return NextResponse.json({ needsSetup: count === 0 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          "فشل في فحص الإعداد: " +
          (error instanceof Error ? error.message : "خطأ"),
      },
      { status: 500 }
    );
  }
}

// POST /api/setup — create the initial admin user (only if no users exist)
export async function POST(req: NextRequest) {
  try {
    const count = await db.user.count();
    if (count > 0) {
      return NextResponse.json(
        { error: "تم إعداد النظام بالفعل — يوجد مستخدمون" },
        { status: 409 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const username = (body.username || "admin").toString().trim();
    const password = (body.password || "admin123").toString();
    const displayName = (body.displayName || "مدير النظام").toString();

    if (!username || !password) {
      return NextResponse.json(
        { error: "اسم المستخدم وكلمة المرور مطلوبان" },
        { status: 400 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const ip = getClientIp(req);
    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          username,
          passwordHash,
          displayName,
          role: "admin",
          permissions: stringifyPermissions(ADMIN_PERMISSIONS),
          active: true,
        },
      });
      await writeAudit(tx, {
        user: null, // لا جلسة بعد — الحدث النظامي للإعداد الأولي
        username: username,
        action: AUDIT_ACTIONS.USER_CREATED,
        entityType: AUDIT_ENTITY_TYPES.User,
        entityId: created.id,
        description: `إنشاء حساب المدير الأول «${created.username}» (الإعداد الأولي للنظام)`,
        after: {
          username: created.username,
          displayName: created.displayName,
          role: created.role,
          active: created.active,
          permissions: ADMIN_PERMISSIONS,
        },
        ip,
      });
      return created;
    });

    return NextResponse.json(
      {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        active: user.active,
        createdAt: user.createdAt,
        permissions: ADMIN_PERMISSIONS, // public shape; never leak raw hash
      },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          "فشل في إنشاء حساب المدير: " +
          (error instanceof Error ? error.message : "خطأ"),
      },
      { status: 500 }
    );
  }
}
