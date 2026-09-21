// Phase 5B.1 — فحص «قاعدة إنتاج مهيأة» — وحدة مستقلة (خادم فقط).
//
// فصل مقصود عن session-epoch (نص قرار 5B.1 §4): session-epoch يدخل في رسم
// الاستيراد لـ auth.ts عبر readSessionEpoch — إبقاؤه خاليًا من أي استيراد
// ديناميكي لـ @prisma/client يمنع انقسام وحدات رسم المصادقة في dev
// (تفرّق أسرار NextAuth المشتقة = موت جلسات عبر المسارات).
// instrumentation يستدعي هذا الفحص عند الإقلاع حصرًا.

import { closeSync, openSync, readSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { toSqliteFileUrl } from "@/lib/sqlite-url";

/**
 * مهيأة = ترويسة SQLite صحيحة + جدول user يحوي صفًا واحدًا على الأقل.
 * أي فحص غير حاسم (مفقود/تالف/لا جدول) يعيد false ⇒ مسار bootstrap العادي —
 * ذلك آمن: قاعدة غير قابلة للقراءة ستُصطدم بـunhealthy(database) في preflight
 * على أي حال، والفشل الحاسم الفعلي هو وجود مستخدمين بلا عدّاد.
 */
export async function probeDbInitialized(dbPath: string): Promise<boolean> {
  try {
    const fd = openSync(dbPath, "r");
    try {
      const buf = Buffer.alloc(16);
      const n = readSync(fd, buf, 0, 16, 0);
      if (n !== 16 || buf.toString("binary") !== "SQLite format 3\0") return false;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  let client: PrismaClient | null = null;
  try {
    client = new PrismaClient({ datasources: { db: { url: toSqliteFileUrl(dbPath) } }, log: [] });
    const users = await client.user.count();
    return users > 0;
  } catch {
    return false;
  } finally {
    try {
      await client?.$disconnect();
    } catch {
      /* ignore */
    }
  }
}
