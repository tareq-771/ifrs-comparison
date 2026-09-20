import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  canManageBackups,
  canRestoreDatabase,
  parsePermissions,
  type Permissions,
} from "@/lib/permissions";

export interface SessionUser {
  id: string;
  username: string;
  name: string;
  role: string;
  permissions: Permissions;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  const su = session.user as any;
  // 4B.1 — دفاع إضافي: جلسة بلا معرف مستخدم فعلي (توكن ميت epoch/قديم)
  // لا تُعد مستخدمًا — يمنع "المستخدم الشبح" بمعرف فارغ وصلاحيات افتراضية.
  if (!su.id) return null;
  return {
    id: su.id || "",
    username: su.username || session.user.name || "",
    name: session.user.name || "",
    role: su.role || "user",
    permissions: parsePermissions(su.permissions || "{}"),
  };
}

export async function requireAuth(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}

export async function requirePermission(
  key: "manageUsers" | "groups" | "settings" | "delete" | "add" | "edit" | "manageBackups"
): Promise<SessionUser> {
  const user = await requireAuth();
  if (!user.permissions[key]) throw new Error("Forbidden");
  return user;
}

/**
 * Phase 4A — بوابة صلاحية إدارة النسخ الاحتياطي.
 * المدير ضمنيًا بالدور؛ غيره بمفتاح manageBackups الصريح حصرًا
 * (settings لا تمنحه — D-5). كل مسارات /api/backups تمر من هنا.
 */
export async function requireManageBackups(): Promise<SessionUser> {
  const user = await requireAuth();
  if (!canManageBackups(user.permissions, user.role)) {
    throw new Error("Forbidden");
  }
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireAuth();
  if (user.role !== "admin") throw new Error("Forbidden: admin only");
  return user;
}

/**
 * Phase 4B.3 — بوابة تنفيذ الاستعادة الفعلية (استبدال قاعدة التشغيل).
 *
 * Explicit High-Risk Permission (قرار المستخدم 4B.3):
 *   restoreDatabase مفتاح صريح مستقل — لا يُمنح ضمنيًا بدور admin ولا بـsettings
 *   ولا بـmanageBackups. مدير كامل الصلاحيات الإدارية بلا المفتاح يُرد هنا 403
 *   قبل أي فحص لاحق (المحرك/الحالة/التأكيدات) — أي أن حالة المحرك لا تُكشف
 *   لغير المخوّل إطلاقًا.
 */
export async function requireRestoreDatabase(): Promise<SessionUser> {
  const user = await requireAuth();
  if (!canRestoreDatabase(user.permissions)) {
    throw new Error("Forbidden");
  }
  return user;
}
