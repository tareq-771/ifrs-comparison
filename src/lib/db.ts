import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Phase 4B.1 — `export let` مقصود: إعادة تعيين المتغير بعد استبدال ملف القاعدة
// تصل إلى كل المستوردين عبر ESM live bindings (وثيقة التصميم — القسم 10.2/5).
// البديل المضمون الموثق عند أي إخفاق: إعادة تشغيل عملية الخادم.
export let db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

/**
 * Phase 4B.1 — إعادة اتصال Prisma بعد الاستبدال الذري لملف القاعدة.
 *
 * الضرورة: العميل القديم يحمل open handle على inode القديمة (الملف المستبدل)،
 * فأي استعلام بعده يقرأ القاعدة القديمة المحذوفة. الاتصال الجديد يفتح الملف
 * الحالي (نفس DATABASE_URL — نفس المسار — inode الجديدة).
 * يعيد عميل Prisma الجديد بعد قطع القديم وإعادة تعيين المتغير المصدَّر.
 */
export async function reconnectDb(): Promise<PrismaClient> {
  try {
    await db.$disconnect()
  } catch {
    /* القديم قد يكون مقطوعًا أصلًا — لا يمنع الاتصال الجديد */
  }
  const fresh = new PrismaClient({ log: ['query'] })
  db = fresh
  if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = fresh
  return fresh
}
