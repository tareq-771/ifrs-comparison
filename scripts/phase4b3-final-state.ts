/**
 * Phase 4B.3 — الحالة النهائية لقاعدة التشغيل (قراءة فقط).
 * integrity_check + عدّادات الجداول + المستخدمون + الحالة التشغيلية.
 */
export {}; // وحدة معزولة

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  console.log("=== 4B.3 Final State (read-only) ===");
  console.log("Time:", new Date().toISOString());

  const integrity = await db.$queryRawUnsafe<{ integrity_check: string }[]>(
    "PRAGMA integrity_check"
  );
  console.log("integrity_check:", JSON.stringify(integrity));

  const fk = await db.$queryRawUnsafe<{ foreign_key_check: unknown }[]>(
    "PRAGMA foreign_key_check"
  );
  console.log("foreign_key_check violations:", fk.length);

  const counts = {
    users: await db.user.count(),
    groups: await db.group.count(),
    reports: await db.report.count(),
    workflowHistory: await db.workflowHistory.count(),
    auditLog: await db.auditLog.count(),
  };
  console.log("table counts:", JSON.stringify(counts));

  const users = await db.user.findMany({ orderBy: { createdAt: "asc" } });
  for (const u of users) {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(u.permissions || "{}") as Record<string, unknown>;
    } catch {
      p = { __parseError: true };
    }
    console.log(
      JSON.stringify({
        username: u.username,
        role: u.role,
        active: u.active,
        restoreDatabaseStored: p["restoreDatabase"] === true,
        restoreKeyExplicitlyStored: "restoreDatabase" in p,
      })
    );
  }

  await db.$disconnect();
}

main();
