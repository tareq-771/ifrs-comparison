// Phase 4A — بوابة أمن ZIP الصارمة (القسم 16.2 + 17 من وثيقة التصميم).
//
// فحص بنية الـ ZIP قبل فك أي بايت إلى القرص: قراءة Central Directory يدويًا
// (بلا ثقة بأي قيمة)، ورفض كل ما عدى database.db + manifest.json.
// هذا هو الخط الذي يفشل فيه كل هجمات zip-slip / symlink / bomb / أسماء مزيفة
// قبل لمس أي شيء — وقبل قاعدة التشغيل إطلاقًا.
//
// ملاحظة: لا نستخدم فك jszip الأعمى أبدًا — jszip يُستخدم فقط بعد اجتياز
// هذا الفحص لقراءة محتوى المداخل المسموحة تحديدًا.

import JSZip from "jszip";

export type ZipSecurityCode =
  | "BAD_STRUCTURE"
  | "ZIP64_UNSUPPORTED"
  | "TOO_LARGE"
  | "TOO_MANY_ENTRIES"
  | "DUPLICATE_ENTRY"
  | "EXTRA_ENTRIES"
  | "MISSING_REQUIRED_ENTRY"
  | "BAD_ENTRY_NAME"
  | "ENTRY_TOO_LARGE"
  | "ZIP_BOMB_RATIO"
  | "ENCRYPTED_ENTRY"
  | "SYMLINK_ENTRY"
  | "DIRECTORY_ENTRY"
  | "UNSUPPORTED_METHOD"
  | "UNREADABLE";

export const ZIP_SECURITY_MESSAGES: Record<ZipSecurityCode, string> = {
  BAD_STRUCTURE: "بنية ZIP غير سليمة (لا يوجد دليل مركزي صالح)",
  ZIP64_UNSUPPORTED: "حاويات ZIP64 غير مدعومة",
  TOO_LARGE: "الحجم المضغوط للملف يتجاوز الحد المسموح",
  TOO_MANY_ENTRIES: "عدد مداخل الأرشيف يتجاوز الحد المسموح",
  DUPLICATE_ENTRY: "أسماء مداخل مكررة داخل الأرشيف",
  EXTRA_ENTRIES: "يحتوي ملفات إضافية غير database.db و manifest.json",
  MISSING_REQUIRED_ENTRY: "ينقص database.db أو manifest.json",
  BAD_ENTRY_NAME: "اسم مدخل غير مسموح (مسار مطلق/نسبي/خبيث)",
  ENTRY_TOO_LARGE: "حجم محتوى غير مضغوط يتجاوز الحد المسموح",
  ZIP_BOMB_RATIO: "نسبة انضغاط مشبوهة (احتمال ZIP bomb)",
  ENCRYPTED_ENTRY: "مداخل مشفرة غير مقبولة",
  SYMLINK_ENTRY: "مداخل symlink غير مقبولة",
  DIRECTORY_ENTRY: "مداخل مجلدات غير مقبولة",
  UNSUPPORTED_METHOD: "طريقة ضغط غير مدعومة (المسموح: stored/deflate)",
  UNREADABLE: "تعذر قراءة الأرشيف",
};

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  sizesFromDescriptor: boolean;
}

export interface ZipInspectOk {
  ok: true;
  entries: ZipEntryInfo[];
  totalUncompressed: number;
}

export interface ZipInspectFail {
  ok: false;
  code: ZipSecurityCode;
  message: string;
  /** اسم المدخل المخالف إن وجد — لأغراض الرسالة فقط. */
  entry?: string;
}

export interface ZipInspectLimits {
  /** مجموع الأحجام غير المضغوطة (بايت) */
  maxUncompressedBytes: number;
  /** أقصى عدد مداخل */
  maxEntries: number;
  /** أسماء مسموحة بالضبط — null = الافتراضي database.db + manifest.json */
  allowedNames?: readonly string[];
  /** أقصى نسبة انضغاط uncompressed/compressed */
  maxRatio: number;
  /** الحد المضغوط الكلي — حجم بايتات الملف نفسه (يُفحص عند الاستدعاء عادة) */
  maxCompressedBytes?: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

/** قراءة Central Directory وفحصه فحصًا صارمًا — لا يفك شيئًا. */
export function inspectZipBuffer(buf: Buffer, limits: ZipInspectLimits): ZipInspectOk | ZipInspectFail {
  // الحد المضغوط (حجم الملف نفسه)
  if (limits.maxCompressedBytes !== undefined && buf.length > limits.maxCompressedBytes) {
    return fail("TOO_LARGE", `الحجم المضغوط ${buf.length} يتجاوز الحد ${limits.maxCompressedBytes}`);
  }

  // البحث عن EOCD من النهاية (تعليق حتى 64KB)
  const scanFrom = Math.max(0, buf.length - (22 + 65_535));
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd < 0) return fail("BAD_STRUCTURE", "لا يوجد End of Central Directory صالح");

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: مرفوض صريحًا (نسخنا صغيرة؛ ZIP64 = مشبوه أو ضخم)
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    return fail("ZIP64_UNSUPPORTED");
  }
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) {
    return fail("ZIP64_UNSUPPORTED");
  }
  if (totalEntries > limits.maxEntries) {
    return fail("TOO_MANY_ENTRIES", `عدد المداخل ${totalEntries} يتجاوز الحد ${limits.maxEntries}`);
  }
  if (cdOffset + cdSize > buf.length) return fail("BAD_STRUCTURE", "دليل مركزي خارج حدود الملف");

  const allowed = new Set(limits.allowedNames ?? ["database.db", "manifest.json"]);
  const seen = new Set<string>();
  const entries: ZipEntryInfo[] = [];
  let totalUncompressed = 0;

  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      return fail("BAD_STRUCTURE", "مدخل دليل مركزي تالف");
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (flags & 0x0001) return fail("ENCRYPTED_ENTRY", undefined, name);

    // symlink/dir: unix mode في الـ 16 بت العليا من external attributes
    const unixMode = (extAttr >>> 16) & 0o170000;
    if (unixMode === 0o120000) return fail("SYMLINK_ENTRY", undefined, name);
    if (unixMode === 0o040000 || (extAttr & 0x10) !== 0 || name.endsWith("/")) {
      return fail("DIRECTORY_ENTRY", undefined, name);
    }
    if (method !== 0 && method !== 8) {
      return fail("UNSUPPORTED_METHOD", `طريقة الضغط ${method} غير مدعومة`, name);
    }

    // الاسم: مطابقة تامة بالمجموعة المسموحة — يستحيل بنيويًا أي traversal
    if (!allowed.has(name)) {
      return fail(
        name.includes("..") || name.includes("/") || name.includes("\\") || name.startsWith("/")
          ? "BAD_ENTRY_NAME"
          : "EXTRA_ENTRIES",
        undefined,
        name
      );
    }
    if (seen.has(name)) return fail("DUPLICATE_ENTRY", undefined, name);
    seen.add(name);

    const sizesFromDescriptor = (flags & 0x0008) !== 0 && compSize === 0 && uncompSize === 0;
    if (!sizesFromDescriptor) {
      totalUncompressed += uncompSize;
      if (uncompSize > limits.maxUncompressedBytes) {
        return fail("ENTRY_TOO_LARGE", undefined, name);
      }
      // نسبة الانضغاط — صدّ bomb (تُفحص لكل مدخل حيثما توفرت الأحجام)
      if (compSize > 0 && uncompSize / compSize > limits.maxRatio) {
        return fail("ZIP_BOMB_RATIO", `نسبة ${Math.round(uncompSize / compSize)}×`, name);
      }
    }

    entries.push({ name, compressedSize: compSize, uncompressedSize: uncompSize, method, sizesFromDescriptor });
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (totalUncompressed > limits.maxUncompressedBytes) {
    return fail("ENTRY_TOO_LARGE", `المجموع غير المضغوط ${totalUncompressed} يتجاوز الحد`);
  }

  const missing = [...allowed].filter((n) => !seen.has(n));
  if (missing.length > 0) {
    return fail("MISSING_REQUIRED_ENTRY", `ينقص: ${missing.join(", ")}`);
  }

  return { ok: true, entries, totalUncompressed };
}

function fail(code: ZipSecurityCode, message?: string, entry?: string): ZipInspectFail {
  return { ok: false, code, message: message ?? ZIP_SECURITY_MESSAGES[code], entry };
}

/**
 * قراءة محتوى مدخل محدد بعد اجتياز الفحص الأمني حصرًا.
 * يعيد القياس الفعلي للحدود بعد الفك (يغطي حالة data descriptors).
 */
export async function readZipEntry(buf: Buffer, name: string, maxBytes: number): Promise<Buffer | ZipInspectFail> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file(name);
    if (!entry) return fail("MISSING_REQUIRED_ENTRY", undefined, name);
    const content = await entry.async("nodebuffer");
    if (content.length > maxBytes) {
      return fail("ENTRY_TOO_LARGE", `الحجم الفعلي ${content.length} يتجاوز الحد ${maxBytes}`, name);
    }
    return content;
  } catch {
    return fail("UNREADABLE");
  }
}

export { fail as zipFail };
