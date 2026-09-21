// Phase 4B.1 — Session Epoch (القسم 15 من وثيقة التصميم D-7 المعدل).
//
// المبدأ الحاكم (قرار المستخدم حرفيًا):
//   • إبطال الجلسات بعد الاستعادة/التراجع يتم عبر عدّاد Epoch في ملف خارج
//     قاعدة البيانات المستبدلة — لا عبر تدوير NEXTAUTH_SECRET ولا عبر أي
//     عدّاد داخل القاعدة (لأن الاستبدال هو الحدث ذاته).
//   • JWT يحمل epoch لحظة تسجيل الدخول؛ كل استدعاء مصدّق يقارنه بالحالي.
//   • بعد نجاح Restore: epoch+1 — وبعد نجاح Rollback: epoch+1 أيضًا.
//   • لا يستخدم NEXTAUTH_SECRET ولا يقرؤه ولا يدوّره (فصل صارم D-10).
//
// سلوك الفشل الآمن (Fail-safe — قرار المستخدم):
//   • ملف مفقود أو تالف أو خارج النطاق (overflow) ⇒ epoch = null
//     ⇒ كل الجلسات الحالية تُعد ميتة (401) وتسجيل الدخول الجديد يُرفض —
//     لا نستطيع إثبات أي جلسة عند فقدان العدّاد ⇒ نرفض كله (fail-closed).
//   • لا تهيئة تلقائية أثناء التشغيل (استعادة الملف القديمة قد تُحيي جلسات
//     قديمة). التهيئة الوحيدة: عند إقلاع الخادم (instrumentation) إذا كان
//     الملف غير موجود أصلًا — قيمة أولية 1.
//   • الاسترداد اليدوي الموثق: المشغّل يكتب قيمة عددية جديدة كبيرة (لا قديمة)
//     — كل الجلسات القديمة ستموت لأن أرقامها لا تطابق.

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ensurePrivateDir, resolveSessionEpochFilePath } from "@/lib/backup-config";
// ملاحظة معمارية 5B.1: هذه الوحدة تدخل رسم auth.ts (readSessionEpoch) —
// تُبقى خالية من استيرادات @prisma/client (حتى الديناميكية) كي لا تنقسم
// وحدات رسم المصادقة في dev. فحص القاعدة المهيأة في @/lib/db-probe.

const MIN_EPOCH = 1;
const MAX_EPOCH = Number.MAX_SAFE_INTEGER; // 2^53 - 1 — فوقه overflow ⇒ fail-safe

/** شكل المخزن المؤقت للقراءة — إبطال cache عند تغير mtime أو الحجم. */
interface EpochCache {
  value: number;
  mtimeMs: number;
  size: number;
}

const g = globalThis as unknown as { __sessionEpochCache?: EpochCache };

function writeEpochFileAtomic(file: string, content: string): void {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, content, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // rename داخل نفس المجلد — ذري بنيويًا (لا ملف حالة جزئي عند crash)
  renameSync(tmp, file);
}

/**
 * قراءة epoch الحالي — null = غير قابل للقراءة/غير صالح (fail-closed).
 * قراءة رخيصة مع cache مبني على mtime+size (يُلغى فورًا عند كل كتابة).
 */
export function readSessionEpoch(): number | null {
  try {
    const file = resolveSessionEpochFilePath();
    if (!existsSync(file)) return null;
    const st = statSync(file);
    const cached = g.__sessionEpochCache;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.value;
    }
    const raw = readFileSync(file, "utf8").trim();
    // تحقق صارم: أرقام فقط — أي محتوى آخر (تالف/overflow) ⇒ null
    if (!/^\d{1,19}$/.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < MIN_EPOCH || value > MAX_EPOCH) return null;
    g.__sessionEpochCache = { value, mtimeMs: st.mtimeMs, size: st.size };
    return value;
  } catch {
    return null;
  }
}

/**
 * زيادة epoch بمقدار 1 — كتابة ذرية (tmp + fsync + rename).
 * تعيد القيمة الجديدة أو null عند الفشل (overflow/قراءة/كتابة).
 * المستدعي (محرك الاستعادة) يعيد المحاولة ثم يفشل مغلقًا عند الفشل المستمر.
 */
export function bumpSessionEpoch(): number | null {
  const current = readSessionEpoch();
  if (current === null) return null;
  if (current + 1 > MAX_EPOCH) return null; // overflow ⇒ fail-safe (لا التفاف)
  try {
    const file = resolveSessionEpochFilePath();
    writeEpochFileAtomic(file, String(current + 1));
    // إبطال cache يدويًا (mtime قد لا يتغير خلال نفس المللي ثانية)
    const st = statSync(file);
    g.__sessionEpochCache = { value: current + 1, mtimeMs: st.mtimeMs, size: st.size };
    return current + 1;
  } catch {
    return null;
  }
}

/**
 * تهيئة الإقلاع فقط: إنشاء الملف بقيمة 1 إذا لم يوجد إطلاقًا (ذريًا).
 * لا تعالج ملفًا موجودًا تالفًا — ذلك فشل مغلق يتطلب تدخلًا يدويًا موثقًا.
 *
 * Phase 5B.1 (نص المستخدم §4): في production مع قاعدة إنتاج مهيأة (مستخدمون
 * موجودون) يُمنع هذا المسار تمامًا — الإقلاع (instrumentation) لا يستدعيها
 * هناك بل يفشل مغلقًا عبر probeDbInitialized أدناه. تبقى صالحة حصرًا لـ:
 * بيئة التطوير + الإقلاع الأول الحقيقي لقاعدة إنتاج جديدة (بلا مستخدمين).
 */
export function ensureEpochBootstrapped(): { created: boolean; available: boolean } {
  const file = resolveSessionEpochFilePath();
  try {
    if (!existsSync(file)) {
      writeEpochFileAtomic(file, "1");
      return { created: true, available: true };
    }
    return { created: false, available: readSessionEpoch() !== null };
  } catch {
    return { created: false, available: false };
  }
}

/**
 * Phase 5B.1 — (انتقل إلى @/lib/db-probe — فصل عن رسم auth.ts، انظر أعلاه).
 */

/**
 * Phase 5B.1 — كتابة قيمة epoch محددة (مسار استرداد المشغّل حصرًا).
 * لا يقبل إلا عددًا صحيحًا آمنًا ≥ 1، ويكتب ذريًا (tmp + fsync + rename)،
 * ويفشل بدون أي آثار جانبية جزئية. لا تُستدعى من أي API — سكربت المشغّل فقط.
 * الحد الأمني لاختيار القيمة موثق في scripts/restore-operator.ts (--epoch-recover):
 * القيمة الاستردادية = unix-seconds — أعلى حتمًا من عائلة العدّاد القديم
 * ⇒ إبطال كامل لكل التوكنات السابقة دون قبول أي قيمة يدوية قد تكون أقل.
 */
export function writeSessionEpochValue(value: number): boolean {
  try {
    if (!Number.isSafeInteger(value) || value < MIN_EPOCH || value > MAX_EPOCH) return false;
    const file = resolveSessionEpochFilePath();
    writeEpochFileAtomic(file, String(value));
    const st = statSync(file);
    g.__sessionEpochCache = { value, mtimeMs: st.mtimeMs, size: st.size };
    return true;
  } catch {
    return false;
  }
}

/** هل العدّاد متاح الآن؟ (يستخدمه حارس الكتابة كطبقة حماية إضافية). */
export function isEpochAvailable(): boolean {
  return readSessionEpoch() !== null;
}
