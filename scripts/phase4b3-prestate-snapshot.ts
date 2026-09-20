/**
 * Phase 4B.3 — لقطة ما قبل التغيير (قراءة فقط — لا كتابة إطلاقًا).
 *
 * الغرض:
 *  1. توثيق حالة متغيرات البيئة المتعلقة بالمحرك (بلا أسرار — قيم وجودية فقط).
 *  2. جرد المستخدمين الحاليين وصلاحياتهم المخزنة حرفيًا (بلا هاشات).
 *
 * قرار المستخدم في 4B.3: لا تغيير .env الآن — هذا السكربت تشخيص حصرًا.
 */
import { PrismaClient } from "@prisma/client";

function main() {
  console.log("=== 4B.3 Pre-State Snapshot (read-only) ===");
  console.log("Time:", new Date().toISOString());

  // ── 1. تشخيص بيئة المحرك (وجودية فقط — لا قيم أسرار) ──
  console.log("\n--- Engine environment diagnosis ---");
  const v = process.env.RESTORE_ENGINE_ENABLED;
  console.log("RESTORE_ENGINE_ENABLED present:", v !== undefined);
  console.log("RESTORE_ENGINE_ENABLED value:", v === undefined ? "(absent)" : JSON.stringify(v));
  console.log("isRestoreEngineEnabled() would be:", v === "1");
  console.log("NODE_ENV:", process.env.NODE_ENV ?? "(unset)");
  console.log("NEXTAUTH_SECRET present:", process.env.NEXTAUTH_SECRET !== undefined);
  console.log("DATABASE_URL present:", process.env.DATABASE_URL !== undefined);

  // ── 2. جرد المستخدمين (بلا هاشات) ──
  const db = new PrismaClient();
  db.user
    .findMany({ orderBy: { createdAt: "asc" } })
    .then((users) => {
      console.log("\n--- Users inventory (no password hashes) ---");
      console.log("User count:", users.length);
      for (const u of users) {
        let perms: Record<string, unknown> = {};
        try {
          perms = JSON.parse(u.permissions || "{}") as Record<string, unknown>;
        } catch {
          perms = { __parseError: true };
        }
        console.log(
          JSON.stringify({
            id: u.id,
            username: u.username,
            role: u.role,
            active: u.active,
            createdAt: u.createdAt,
            storedPermissions: perms, // حرفيًا كما في القاعدة
            restoreDatabaseKeyExplicitlyStored: "restoreDatabase" in perms,
            restoreDatabaseStoredValue: perms["restoreDatabase"] === true,
          })
        );
      }
      console.log("\n=== Snapshot complete (no writes performed) ===");
    })
    .finally(() => db.$disconnect());
}

main();
