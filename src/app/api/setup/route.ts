import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, getClientIp } from "@/lib/audit";
import {
  ADMIN_PERMISSIONS,
  stringifyPermissions,
} from "@/lib/permissions";
import { guardWrite, guardRead } from "@/lib/api-guard";
import { validateStrongPassword, passwordIssueMessage } from "@/lib/password-policy";

// Phase 5B.1 — تحصين الإعداد الأولي (نص المستخدم §5):
//   • لا بيانات افتراضية إطلاقًا (admin/admin123 محذوفة كليًا).
//   • سياسة كلمة مرور قوية إلزامية (password-policy.ts).
//   • بوابة bootstrap صريحة في الإنتاج: SETUP_BOOTSTRAP_ENABLED=1 حصرًا —
//     وهي إحدى طبقات فقط (لا حماية وحيدة): تُجمع مع صفر مستخدمين + السياسة
//     + السلوك أحادي المرة + الإغلاق التلقائي + أدلة AuditLog.
//   • بعد أول مدير: النهاية ميتة بنيويًا (zero-users check داخل معاملة +
//     mutex معالجة واحدة + قيد username@unique) حتى لو نُسي العلم مفعّلًا.
//   • لا كلمة مرور ولا أي سر في AuditLog (sanitize مركزي + لا تمرير أصلًا).

/**
 * Phase 5B.1 — mutex على مستوى العملية لتسلسل محاولات bootstrap المتزامنة.
 * نطاق العملية الواحدة هو الحد المعماري الموثق للخادم (نفس نمط recovery-lock).
 * مع داخل-المعاملة إعادة فحص العدد + قيد unique — ثلاث طبقات مستقلة.
 */
let bootstrapInFlight: Promise<unknown> | null = null;

// GET /api/setup — check whether initial admin setup is needed
export async function GET() {
  return guardRead("/api/setup", async () => {
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
  });
}

// POST /api/setup — create the initial admin user (only if no users exist)
export async function POST(req: NextRequest) {
  return guardWrite("/api/setup", async () => {
    // ── بوابة الإنتاج الصريحة (طبقة 1 من 3) ─────────────────────────────
    if (process.env.NODE_ENV === "production" && process.env.SETUP_BOOTSTRAP_ENABLED !== "1") {
      return NextResponse.json(
        { error: "الإعداد الأولي غير مفعل في هذه البيئة" },
        { status: 403 }
      );
    }

    // ── تسلسل المحاولات المتزامنة على مستوى العملية (طبقة 2) ────────────
    while (bootstrapInFlight) {
      await bootstrapInFlight.catch(() => undefined);
    }
    let releaseMutex!: () => void;
    bootstrapInFlight = new Promise<void>((r) => (releaseMutex = r));
    try {
      const body = await req.json().catch(() => ({}));
      const username = typeof body.username === "string" ? body.username.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";

      // ── لا قيم افتراضية إطلاقًا — بيانات صريحة إلزامية ─────────────────
      if (!username || !password) {
        return NextResponse.json(
          { error: "اسم المستخدم وكلمة المرور مطلوبان صراحةً" },
          { status: 400 }
        );
      }
      if (username.length < 3 || username.length > 60) {
        return NextResponse.json(
          { error: "اسم المستخدم يجب أن بين 3 و60 حرفًا" },
          { status: 400 }
        );
      }
      const displayNameSafe = displayName || username;

      // ── سياسة كلمة المرور القوية (طبقة إضافية) ─────────────────────────
      const pwCheck = validateStrongPassword(password);
      if (!pwCheck.ok) {
        return NextResponse.json(
          { error: passwordIssueMessage(pwCheck.issue!) },
          { status: 400 }
        );
      }

      const count = await db.user.count();
      if (count > 0) {
        return NextResponse.json(
          { error: "تم إعداد النظام بالفعل — يوجد مستخدمون" },
          { status: 409 }
        );
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const ip = getClientIp(req);
      const user = await db.$transaction(async (tx) => {
        // إعادة فحص داخل المعاملة (طبقة 2 ب): التسلسل على SQLite يضمن أن
        // المتأخر يرى صفوف المتقدم ⇒ يُرفض قبل أي إنشاء مكرر
        const recount = await tx.user.count();
        if (recount > 0) {
          throw new Error("BOOTSTRAP_ALREADY_DONE");
        }
        const created = await tx.user.create({
          data: {
            username,
            passwordHash,
            displayName: displayNameSafe,
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
      // طبقة 3: قيد username@unique على مستوى القاعدة — أي سباق نافذ للمتقدمين
      // المتبقيين يُرفض هنا أيضًا (لا مستخدمان إداريان أبدًا)
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return NextResponse.json(
          { error: "تعذر إنشاء الحساب — الاسم مستخدم أو أُتم الإعداد للتو" },
          { status: 409 }
        );
      }
      if (error instanceof Error && error.message === "BOOTSTRAP_ALREADY_DONE") {
        return NextResponse.json(
          { error: "تم إعداد النظام بالفعل — يوجد مستخدمون" },
          { status: 409 }
        );
      }
      return NextResponse.json(
        {
          error:
            "فشل في إنشاء حساب المدير: " +
            (error instanceof Error ? error.message : "خطأ"),
        },
        { status: 500 }
      );
    } finally {
      releaseMutex();
      bootstrapInFlight = null;
    }
  });
}
