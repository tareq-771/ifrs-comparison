import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Phase 5A — ضبط تشغيل SQLite الإنتاجي لكل اتصال (لا يمس افتراضات الاستعادة الذرية):
//   • journal_mode=WAL — الوضع الحاكم نفسه المثبت في 4B (يُثبت في ملف القاعدة،
//     وتكراره هنا يجعل أي قاعدة جديدة/مستعادة تدخل WAL فورًا).
//   • busy_timeout=5000ms — لكل اتصال (ليس دائمًا في الملف) — يمنع فشل
//     SQLITE_BUSY العابر أثناء ذروة القراءة/الكتابة والنسخ.
//   • foreign_keys=ON — سلامة مرجعية صريحة (لم تكن مضبوطة قبل 5A).
// المبادلة الذرية (4B.1) غير مماسة: rename داخل مجلد القاعدة نفسه + reconnectDb
// تفتح الملف الحالي — الـPRAGMA تُطبق على العميل الجديد في reconnectDb أيضًا.

/** تُطبق مرة لكل عميل (الأساسي + كل عميل reconnect) — لا اعتماد على ترتيب الاستعلامات. */
function tuneSqlite(client: PrismaClient): void {
  void client
    .$queryRawUnsafe<unknown[]>("PRAGMA journal_mode=WAL")
    .then(() => client.$queryRawUnsafe<unknown[]>("PRAGMA busy_timeout=5000"))
    .then(() => client.$queryRawUnsafe<unknown[]>("PRAGMA foreign_keys=ON"))
    .catch((e) => {
      // لا نقتل الخادم على فشل ضبط — لكنه مسجل (الإنتاج: يظهر في journald)
      console.error("[db] sqlite tuning failed:", String(e).split("\n")[0]);
    });
}

// Phase 5A — تسجيل الإنتاج: log:['query'] ضجيج وأداء في الإنتاج؛
// يبقى في التطوير فقط (سلوك dev كما هو).
const isProd = process.env.NODE_ENV === "production";
const LOG_LEVELS: ("query" | "error" | "warn" | "info")[] = isProd
  ? ["error", "warn"]
  : ["query"];

// Phase 4B.1 — `export let` مقصود: إعادة تعيين المتغير بعد استبدال ملف القاعدة
// تصل إلى كل المستوردين عبر ESM live bindings (وثيقة التصميم — القسم 10.2/5).
// البديل المضمون الموثق عند أي إخفاق: إعادة تشغيل عملية الخادم.
const cachedClient = globalForPrisma.prisma
export let db =
  cachedClient ??
  new PrismaClient({
    log: LOG_LEVELS,
  })

if (!isProd) globalForPrisma.prisma = db
if (!cachedClient) tuneSqlite(db)

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
  const fresh = new PrismaClient({ log: LOG_LEVELS })
  tuneSqlite(fresh)
  db = fresh
  if (!isProd) globalForPrisma.prisma = fresh
  return fresh
}
