import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import {
  ADMIN_PERMISSIONS,
  stringifyPermissions,
} from "@/lib/permissions";

/**
 * Creates the default admin user if no users exist in the database.
 * Default credentials:
 *   username: admin
 *   password: admin123
 *
 * @returns true if the admin was created, false if users already existed.
 */
export async function seedAdmin(): Promise<boolean> {
  const existingCount = await db.user.count();
  if (existingCount > 0) return false;

  const passwordHash = await bcrypt.hash("admin123", 10);
  await db.user.create({
    data: {
      username: "admin",
      passwordHash,
      displayName: "مدير النظام",
      role: "admin",
      permissions: stringifyPermissions(ADMIN_PERMISSIONS),
      active: true,
    },
  });
  return true;
}
