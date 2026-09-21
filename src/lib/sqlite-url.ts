// Phase 5B.1 — توليد موحّد لـ SQLite/Prisma file URLs — خادم فقط.
//
// الغرض (نص المستخدم 5B.1 §7):
//   لا إنشاء file URL بالـstring concatenation (`file:${path}`) في مواضع متعددة.
//   helper مركزي واحد يدعم:
//     • Windows drive paths:  D:\IFRS-Data\db\ifrs-prod.db
//     • مسارات بمسافات:       C:\Program Data\IFRS\db.sqlite
//     • Linux absolute:       /home/app/data/db.sqlite
//     • file: URL قائم (يُطبَّع لا يُكرَّر)
//
// القاعدة الحاكمة: المخرج دائمًا بالصيغة التي توثقها Prisma للـSQLite:
//   file:<absolute-path-with-forward-slashes>
//   — فواصل أمامية حصرًا (Windows يقبلها حصريًا بأمان عبر كل أدوات Prisma)،
//   — لا percent-encoding (محلل Prisma يقرأ المسار حرفيًا؛ `?` الوحيدة الفاصلة
//     عن query params — تُرفض صراحة لأنها لا تمثل مسار SQLite صالحًا)،
//   — مطلق حصرًا (النسبي يُرفض: يعتمد على cwd/موقع schema = سلوك غامض ممنوع).
//
// ملاحظة إثبات: القبول الفعلي من محرك Prisma أُثبت على Linux (مسارات مطلقة) —
// وقبول صيغة الـdrive على Windows الحقيقي يُختبر في 5B.4 على المضيف (بند مؤجل
// موثق — لا يوصف بأنه مثبت هنا).

import path from "node:path";

export class SqliteUrlError extends Error {
  code: "SQLITE_URL_EMPTY" | "SQLITE_URL_RELATIVE" | "SQLITE_URL_INVALID_CHAR";
  constructor(code: SqliteUrlError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * يحوّل مسار قاعدة SQLite مطلقًا إلى file URL موحّد تقبله Prisma على
 * Windows وLinux. يقبل مدخلًا يكون مسارًا خامًا أو file: URL قائمًا.
 */
export function toSqliteFileUrl(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new SqliteUrlError("SQLITE_URL_EMPTY", "مسار قاعدة SQLite فارغ");
  }

  // إزالة بادئة file: إن وُجدت (بأي حالة) — ثم تطهير الموصلات
  let p = raw;
  if (/^file:/i.test(p)) {
    p = p.slice(5);
    // file:URL قد يحمل query params (connection_limit=...) — لا ندعمها هنا:
    // الاستعادة/الفحوص تحتاج URL نظيفًا؛ أي `?` يعني إعدادات خارج نطاق هذا الـhelper.
    const q = p.indexOf("?");
    if (q !== -1) {
      throw new SqliteUrlError(
        "SQLITE_URL_INVALID_CHAR",
        "file URL يحوي query params — مرر إعدادات الاتصال عبر طبقة الإعداد لا هذا الـhelper"
      );
    }
  }

  // توحيد الفواصل: backslashes (Windows) → forward slashes
  p = p.replace(/\\/g, "/");

  // UNC/شبكي (//server/share أو \\server\share) مرفوض صراحة — قاعدة SQLite
  // حية على وسيط شبكي ممنوعة معماريًا (قرار 5B: NTFS محلي حصرًا + rename ذري)
  // — الفحص قبل طيّ الفواصل المزدوجة كي لا تُنقّى البادئة
  if (p.startsWith("//")) {
    throw new SqliteUrlError(
      "SQLITE_URL_INVALID_CHAR",
      "مسار UNC/شبكي مرفوض — القاعدة الحية على NTFS محلي حصرًا (قرار معماري 5B)"
    );
  }

  // طيّ الفواصل المزدوجة الناتجة عن مزج الأنماط
  p = p.replace(/\/{2,}/g, "/");

  // حرف `?` في المسار الخام يفسّر كفاصل query — رفض صريح (fail-closed)
  if (p.includes("?")) {
    throw new SqliteUrlError("SQLITE_URL_INVALID_CHAR", "المسار يحوي '?' — غير صالح كمسار SQLite حرفي");
  }

  // مطلق عبر-المنصات (الحسم لا يعتمد على منصة التشغيل):
  //   • Windows drive:  D:/…  (بعد توحيد الفواصل)
  //   • POSIX:          /…
  const isWinDrive = /^[A-Za-z]:\//.test(p);
  const isPosixAbs = p.startsWith("/");
  if (!isWinDrive && !isPosixAbs) {
    throw new SqliteUrlError(
      "SQLITE_URL_RELATIVE",
      "مسار قاعدة SQLite نسبي — يلزم مسار مطلق (دلالات cwd/relative-to-schema ممنوعة هنا)"
    );
  }

  // تطبيع دلالي (يحل ../ و . ويوحد الشكل) دون مساس بمحتوى الأحرف (مسافات/عربية)
  const normalized = path.normalize(p);

  return `file:${normalized}`;
}

/**
 * يستخرج مسار الملف من file URL (عكس toSqliteFileUrl تقريبًا — للفحوص فقط).
 * لا يستخدم لأي كتابة.
 */
export function sqliteUrlToPath(input: string): string | null {
  try {
    const url = toSqliteFileUrl(input);
    return url.slice(5);
  } catch {
    return null;
  }
}
