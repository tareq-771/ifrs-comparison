// Phase 4A — اختبارات أمن رفع ZIP (طلب المستخدم: «اختبر فعليًا» كل الحالات).
// كل الحالات تمر عبر uploadBackupZip (نفس مدخل الـ API) ويجب أن تُرفض قبل
// لمس قاعدة التشغيل إطلاقًا — مع إثبات عدم المساس وعدم ترك بقايا في staging.
//
// الحدود مضبوطة على 1MB في هذا الاختبار عبر BACKUP_MAX_UPLOAD_MB (قبل الاستيراد).

process.env.BACKUP_MAX_UPLOAD_MB = "1";

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = "/home/z/my-project";
const PROD = path.join(ROOT, "db", "custom.db");
const UPLOADS_DIR = path.join(ROOT, "var", "restore-staging", "uploads");

let failures = 0;
function line(title: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${title}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/* ── باني ZIP مخزّن يدوي (لصناعة الحالات الخبيثة بدقة) ── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface SpecEntry {
  name: string;
  data: Buffer;
  uncompSizeOverride?: number;
}

function buildStoredZip(entries: SpecEntry[]): Buffer {
  const parts: Buffer[] = [];
  const cds: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const crc = crc32(e.data);
    const nameB = Buffer.from(e.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.uncompSizeOverride ?? e.data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameB, e.data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.uncompSizeOverride ?? e.data.length, 24);
    cd.writeUInt16LE(nameB.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    cds.push(cd, nameB);
    offset += 30 + nameB.length + e.data.length;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function main() {
  console.log("=== اختبارات أمن رفع ZIP (4A) — الحد المضغوط 1MB ===\n");

  const { uploadBackupZip, BackupError } = await import("@/lib/backup-server");

  const live = new PrismaClient({ log: [] });
  const before = {
    users: await live.user.count(),
    groups: await live.group.count(),
    reports: await live.report.count(),
    workflowHistory: await live.workflowHistory.count(),
    auditLog: await live.auditLog.count(),
  };

  // قاعدة سليمة (نسخة VACUUM INTO من الإنتاج) لبناء حزم مرجعية
  const tmpRoot = path.join(ROOT, "var", "tmp-zipsec");
  if (!existsSync(tmpRoot)) mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  const clonePath = path.join(tmpRoot, "clone.db");
  {
    const src = new Database(PROD, { readonly: true });
    src.exec(`VACUUM INTO '${clonePath}'`);
    src.close();
  }
  const clone = new Database(clonePath, { readonly: true });
  const cnt = (sql: string): number => Number(clone.query(sql).get()!.n);
  const counts = {
    users: cnt(`SELECT COUNT(*) AS n FROM "User"`),
    groups: cnt(`SELECT COUNT(*) AS n FROM "Group"`),
    reports: cnt(`SELECT COUNT(*) AS n FROM "Report"`),
    workflowHistory: cnt(`SELECT COUNT(*) AS n FROM "WorkflowHistory"`),
    auditLog: cnt(`SELECT COUNT(*) AS n FROM "AuditLog"`),
  };
  const pr = clone.query(`SELECT MIN(periodEnd) AS mn, MAX(periodEnd) AS mx FROM "Report"`).get() as { mn: string | null; mx: string | null };
  clone.close();

  const cloneBytes = readFileSync(clonePath);
  const validManifest = (sha256: string, schemaVersion = "v4-phase3.5B"): Buffer =>
    Buffer.from(
      JSON.stringify({
        formatVersion: 2,
        backupId: "bk-SEC-TEST-000000000000Z-sec001",
        backupType: "upload",
        createdAt: new Date().toISOString(),
        createdBy: { id: null, username: "__4a_sec_test__" },
        appVersion: "1.0.0",
        schemaVersion,
        schemaFingerprint: "sha256:" + "a".repeat(64),
        database: { filename: "database.db", sha256, bytes: cloneBytes.length, pageSize: 4096, integrityCheck: "ok", journalModeAtBackup: "wal" },
        counts,
        periodRange: { minPeriodEnd: pr.mn, maxPeriodEnd: pr.mx },
        dataRange: { oldestCreatedAt: null, newestUpdatedAt: null },
        environment: { businessTzOffsetMinutes: 180, configFingerprint: "sha256:" + "b".repeat(64) },
        verification: { level: "CREATED", validatedAt: null, drillAt: null },
        authenticity: { note: "test", manifestHmac: null },
      }),
      "utf8"
    );

  let run = 0;
  async function expectReject(title: string, bytes: Buffer, expectedCode: string, displayName: string): Promise<void> {
    run++;
    if (existsSync(UPLOADS_DIR)) for (const f of readdirSync(UPLOADS_DIR)) rmSync(path.join(UPLOADS_DIR, f), { force: true });
    try {
      await uploadBackupZip({ id: null, username: "__4a_sec_test__" }, bytes, displayName);
      line(title, false, `قُبل خطأً — المتوقع رفض ${expectedCode}`);
    } catch (e) {
      if (e instanceof BackupError && e.code === expectedCode) {
        const leftovers = existsSync(UPLOADS_DIR) ? readdirSync(UPLOADS_DIR).length : 0;
        line(title, leftovers === 0, `${expectedCode} · بقايا staging: ${leftovers}`);
      } else {
        line(title, false, `رمز غير متوقع: ${e instanceof BackupError ? e.code : String(e)} (المتوقع ${expectedCode})`);
      }
    }
  }

  const manifestOk = validManifest(sha(cloneBytes));

  // 1) zip-slip ../
  await expectReject(
    "zip-slip «../evil.db»",
    buildStoredZip([
      { name: "../evil.db", data: Buffer.from("evil") },
      { name: "manifest.json", data: manifestOk },
    ]),
    "BAD_ENTRY_NAME",
    "slip.db.zip"
  );

  // 2) مسار مطلق
  await expectReject(
    "مسار مطلق «/etc/evil.db»",
    buildStoredZip([
      { name: "/etc/evil.db", data: Buffer.from("evil") },
      { name: "manifest.json", data: manifestOk },
    ]),
    "BAD_ENTRY_NAME",
    "abs.db.zip"
  );

  // 3) symlink (unix mode 0o120777)
  {
    const JSZip = (await import("jszip")).default;
    const z = new JSZip();
    z.file("database.db", "evil-link-target", { unixPermissions: 0o120777 });
    z.file("manifest.json", manifestOk.toString("utf8"));
    const bytes = await z.generateAsync({ type: "nodebuffer", platform: "UNIX" });
    await expectReject("مدخل symlink (bit S_IFLNK)", bytes, "SYMLINK_ENTRY", "sym.db.zip");
  }

  // 4) ملف زائد ثالث
  await expectReject(
    "ملف ثالث زائد «extra.txt»",
    buildStoredZip([
      { name: "database.db", data: cloneBytes },
      { name: "manifest.json", data: manifestOk },
      { name: "extra.txt", data: Buffer.from("nope") },
    ]),
    "EXTRA_ENTRIES",
    "extra.db.zip"
  );

  // 5) أسماء مكررة
  await expectReject(
    "اسم مدخل مكرر (database.db ×2)",
    buildStoredZip([
      { name: "database.db", data: cloneBytes },
      { name: "database.db", data: Buffer.from("second") },
      { name: "manifest.json", data: manifestOk },
    ]),
    "DUPLICATE_ENTRY",
    "dup.db.zip"
  );

  // 6) أرشيف متداخل داخل database.db
  {
    const JSZip = (await import("jszip")).default;
    const inner = new JSZip();
    inner.file("payload.txt", "nested");
    const innerBytes = await inner.generateAsync({ type: "nodebuffer" });
    await expectReject(
      "أرشيف متداخل (database.db = ZIP)",
      buildStoredZip([
        { name: "database.db", data: innerBytes },
        { name: "manifest.json", data: manifestOk },
      ]),
      "NOT_SQLITE",
      "nested.db.zip"
    );
  }

  // 7) الحد المضغوط (>1MB)
  await expectReject(
    "الحجم المضغوط يتجاوز الحد (2MB > 1MB)",
    buildStoredZip([
      { name: "database.db", data: Buffer.alloc(2 * 1024 * 1024, 0x41) },
      { name: "manifest.json", data: manifestOk },
    ]),
    "TOO_LARGE",
    "big.db.zip"
  );

  // 8) حجم غير مضغوط مزيّف في CD
  await expectReject(
    "حجم غير مضغوط مزيّف (4GB في CD)",
    buildStoredZip([
      { name: "database.db", data: Buffer.from("tiny"), uncompSizeOverride: 0xffffffff },
      { name: "manifest.json", data: manifestOk },
    ]),
    "ENTRY_TOO_LARGE",
    "lie.db.zip"
  );

  // 9) عدد مداخل زائد
  await expectReject(
    "عدد مداخل زائد (10)",
    buildStoredZip(
      Array.from({ length: 10 }, (_, i) => ({ name: `entry${i}.bin`, data: Buffer.from("x") }))
    ),
    "TOO_MANY_ENTRIES",
    "many.db.zip"
  );

  // 10) SQLite مزيفة
  await expectReject(
    "SQLite مزيفة (نص عادي)",
    buildStoredZip([
      { name: "database.db", data: Buffer.from("this is definitely not a sqlite database, just plain text bytes") },
      { name: "manifest.json", data: manifestOk },
    ]),
    "NOT_SQLITE",
    "fake.db.zip"
  );

  // 11) عدم تطابق checksum
  await expectReject(
    "عدم تطابق SHA-256 (Manifest يكذب)",
    buildStoredZip([
      { name: "database.db", data: cloneBytes },
      { name: "manifest.json", data: validManifest("f".repeat(64)) },
    ]),
    "CHECKSUM_MISMATCH",
    "sha.db.zip"
  );

  // 12) Manifest تالف
  await expectReject(
    "Manifest تالف (JSON مكسور)",
    buildStoredZip([
      { name: "database.db", data: cloneBytes },
      { name: "manifest.json", data: Buffer.from("{ this is not json !!") },
    ]),
    "BAD_MANIFEST",
    "badm.db.zip"
  );

  // 13) manifest.json مفقود
  await expectReject(
    "manifest.json مفقود من الحزمة",
    buildStoredZip([{ name: "database.db", data: cloneBytes }]),
    "MISSING_REQUIRED_ENTRY",
    "nomanifest.db.zip"
  );

  // 14) مخطط غير معروف (قاعدة سليمة بجدول واحد غريب)
  {
    const weird = path.join(tmpRoot, "weird.db");
    rmSync(weird, { force: true });
    const w = new Database(weird);
    w.exec("CREATE TABLE foo (id INTEGER)");
    w.close();
    const wb = readFileSync(weird);
    await expectReject(
      "مخطط غير معروف (بلا الجداول الإلزامية)",
      buildStoredZip([
        { name: "database.db", data: wb },
        { name: "manifest.json", data: validManifest(sha(wb)) },
      ]),
      "MISSING_TABLES",
      "weird.db.zip"
    );
  }

  // 15) مخطط «أحدث» من التطبيق (نسخة سليمة + جدول مستقبلي)
  {
    const newer = path.join(tmpRoot, "newer.db");
    rmSync(newer, { force: true });
    const src = new Database(PROD, { readonly: true });
    src.exec(`VACUUM INTO '${newer}'`);
    src.close();
    const n = new Database(newer);
    n.exec("CREATE TABLE FutureTable_9x (id INTEGER)");
    n.close();
    const nb = readFileSync(newer);
    await expectReject(
      "مخطط أحدث من التطبيق (جدول مستقبلي) — رفض لا downgrade",
      buildStoredZip([
        { name: "database.db", data: nb },
        { name: "manifest.json", data: validManifest(sha(nb), "v999-future") },
      ]),
      "SCHEMA_UNKNOWN",
      "future.db.zip"
    );
  }

  // قاعدة التشغيل لم تُلمس إطلاقًا — جداول البيانات متطابقة حرفيًا.
  // (auditLog ينمو عمدًا: كل رفض يكتب حدث BACKUP_FAILED أمنيًا — هذا الدليل نفسه)
  const after = {
    users: await live.user.count(),
    groups: await live.group.count(),
    reports: await live.report.count(),
    workflowHistory: await live.workflowHistory.count(),
    auditLog: await live.auditLog.count(),
  };
  const dataUntouched =
    before.users === after.users &&
    before.groups === after.groups &&
    before.reports === after.reports &&
    before.workflowHistory === after.workflowHistory;
  line(
    "جداول البيانات لم تُلمس طوال الاختبارات",
    dataUntouched,
    JSON.stringify({ users: after.users, groups: after.groups, reports: after.reports, workflowHistory: after.workflowHistory })
  );
  line(
    "كل رفض كتب حدث تدقيق أمنيًا (auditLog نما بعدد الحالات 15)",
    after.auditLog - before.auditLog === 15,
    `نما ${after.auditLog - before.auditLog} صفًا (${before.auditLog} → ${after.auditLog}) — كل رفض = صف Audit + حدث Recovery واحدًا بالضبط`
  );
  {
    const chk = new Database(PROD, { readonly: true });
    const r = chk.query("PRAGMA integrity_check").get() as Record<string, string>;
    chk.close();
    line("integrity_check لقاعدة التشغيل", r.integrity_check === "ok");
  }

  // تنظيف المجلدات المؤقتة
  rmSync(tmpRoot, { recursive: true, force: true });
  if (existsSync(UPLOADS_DIR)) for (const f of readdirSync(UPLOADS_DIR)) rmSync(path.join(UPLOADS_DIR, f), { force: true });

  await live.$disconnect();
  console.log(
    failures === 0
      ? `\n=== أمن ZIP: نجاح كامل (${run}/${run} رفض صحيح) ===`
      : `\n=== فشل ${failures} فحص ===`
  );
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
