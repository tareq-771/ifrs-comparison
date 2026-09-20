// Phase 4A — اختبار الاتساق أثناء الكتابة (القسم 22.1):
// كتابة/تحديثات متزامنة مستمرة أثناء إنشاء النسخة ⇒ VACUUM INTO ينتج snapshot
// متسقة: قيمة العداد وعدد الصفوف يجب أن يعودا لنفس المعاملة المكتملة تمامًا
// (v == عدد الصفوف، وكلاهما مضاعف حجم الدفعة 5) + integrity_check ناجح.
//
// الاختبار على نسخة clone من قاعدة التشغيل (VACUUM INTO) — لا يكتب في الإنتاج.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const ROOT = "/home/z/my-project";
const PROD = path.join(ROOT, "db", "custom.db");
const TMP = path.join(ROOT, "var", "tmp-consistency");
const BATCH = 5;
const TOTAL_BATCHES = 20000;

let failures = 0;
function line(title: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${title}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  console.log("=== اختبار الاتساق أثناء الكتابة المتزامنة (4A) ===\n");

  // 0) وضع الحد الأدنى للتهدئة جانبًا: نستخدم clone — لا cooldown لأننا لا ننشئ من الإنتاج
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true, mode: 0o700 });
  const clonePath = path.join(TMP, "clone.db");
  rmSync(clonePath, { force: true });
  rmSync(clonePath + "-wal", { force: true });
  rmSync(clonePath + "-shm", { force: true });
  {
    const src = new Database(PROD, { readonly: true });
    src.exec(`VACUUM INTO '${clonePath}'`);
    src.close();
  }

  // تجهيز clone: WAL + جداول الاختبار
  {
    const c = new Database(clonePath);
    c.exec("PRAGMA journal_mode=WAL");
    c.exec(`CREATE TABLE IF NOT EXISTS __c4a_counter (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)`);
    c.exec(`INSERT OR REPLACE INTO __c4a_counter (id, v) VALUES (1, 0)`);
    c.exec(`CREATE TABLE IF NOT EXISTS __c4a_rows (seq INTEGER PRIMARY KEY AUTOINCREMENT, batch INTEGER NOT NULL)`);
    c.close();
  }

  // توجيه DATABASE_URL إلى الـ clone قبل استيراد مكتبات الخادم
  process.env.DATABASE_URL = `file:${clonePath}`;
  const { createBackup } = await import("@/lib/backup-server");

  const state = { done: 0 };
  function writerSync(maxBatches: number): void {
    const w = new Database(clonePath);
    w.exec("PRAGMA journal_mode=WAL");
    const upd = w.prepare(`UPDATE __c4a_counter SET v = v + ${BATCH} WHERE id = 1`);
    const ins = w.prepare(`INSERT INTO __c4a_rows (batch) VALUES (?)`);
    for (let b = 0; b < maxBatches; b++) {
      w.exec("BEGIN IMMEDIATE");
      upd.run();
      for (let i = 0; i < BATCH; i++) ins.run(b);
      w.exec("COMMIT");
      state.done++;
    }
    w.close();
  }

  // رأس إطلاق: 50 دفعة مكتملة قبل النسخة ⇒ اللقطة لن تكون صفرية إطلاقًا
  writerSync(50);
  const headStart = state.done * BATCH;

  // الكاتب الحقيقي كعملية bun منفصلة — تزامن فعلي على مستوى نظام التشغيل:
  // معاملات مستمرة عبر اتصال مستقل تتخطى لحظة الـ snapshot بكثير
  const writerProc = Bun.spawn(
    ["bun", path.join(ROOT, "scripts", "phase4a-consistency-writer.ts"), clonePath, String(TOTAL_BATCHES), String(BATCH)],
    { stdout: "pipe", stderr: "pipe" }
  );

  // إتاحة الوقت للكاتب كي يدخل منتصف الكتابة قبل بدء النسخة
  await new Promise((r) => setTimeout(r, 250));

  const t0 = Date.now();
  const created = await createBackup({ id: null, username: "__4a_consistency_test__" });
  const backupMs = Date.now() - t0;
  const writerOut = await new Response(writerProc.stdout).text();
  const writerExit = await writerProc.exited;
  const doneMatch = writerOut.match(/DONE (\d+)/);
  state.done = 50 + (doneMatch ? parseInt(doneMatch[1], 10) : 0);
  if (writerExit !== 0) throw new Error(`فشل الكاتب (${writerExit}): ${writerOut}`);
  const finalTotal = state.done * BATCH;

  line(
    "أُنشئت النسخة أثناء كتابة متزامنة مستمرة",
    created.level === "VALIDATED" && !created.validationError,
    `backupId=${created.backupId} · ${(backupMs / 1000).toFixed(2)}s · دفعات مكتملة أثناء الاختبار: ${state.done}`
  );
  line(
    "journalModeAtBackup = wal (الكتابة لم تتوقف)",
    created.manifest.database.journalModeAtBackup === "wal",
    created.manifest.database.journalModeAtBackup
  );

  // فتح النسخة الناتجة والتحقق من ثابت الاتساق الحاسم
  let snapshotV = 0;
  let snapshotRows = 0;
  const JSZip = (await import("jszip")).default;
  const backupDir = path.join(ROOT, "var", "backups");
  const zipPath = path.join(backupDir, `${created.backupId}.zip`);
  const ws = mkdtempSync(path.join(os.tmpdir(), "4a-consistency-"));
  const zip = await JSZip.loadAsync(readFileSync(zipPath));
  const dbBuf = await zip.file("database.db")!.async("nodebuffer");
  const snapDb = path.join(ws, "snapshot.db");
  writeFileSync(snapDb, dbBuf, { mode: 0o600 });

  {
    const s = new Database(snapDb, { readonly: true });
    const integ = s.query("PRAGMA integrity_check").get() as Record<string, string>;
    line("integrity_check على snapshot النسخة", integ.integrity_check === "ok");
    const counter = s.query(`SELECT v FROM __c4a_counter WHERE id = 1`).get() as { v: number };
    const rowCount = s.query(`SELECT COUNT(*) AS n FROM __c4a_rows`).get() as { n: number };
    const v = Number(counter.v);
    const n = Number(rowCount.n);
    snapshotV = v;
    snapshotRows = n;
    line(
      "⭐ ثابت الاتساق: v == عدد الصفوف (نفس المعاملة المكتملة)",
      v === n,
      `counter=${v} · rows=${n}`
    );
    line(
      "كلاهما مضاعف حجم الدفعة (لا معاملة جزئية)",
      v % BATCH === 0 && n % BATCH === 0,
      `الدفعة=${BATCH}`
    );
    const doneAtSnapshot = v / BATCH;
    line(
      "⭐ اللقطة في منتصف الكتابة (بعد البداية وقبل النهاية)",
      v >= headStart && v < finalTotal,
      `snapshot=${doneAtSnapshot} دفعة · رأس الإطلاق=${headStart / BATCH} · النهائي=${finalTotal / BATCH}`
    );
    // البيانات الأصلية للنظام موجودة أيضًا في الـ snapshot
    const usersInSnap = s.query(`SELECT COUNT(*) AS n FROM "User"`).get() as { n: number };
    line("بيانات النظام الأساسية داخل snapshot سليمة", Number(usersInSnap.n) >= 1, `users=${usersInSnap.n}`);
    s.close();
  }

  // قيمة الكاتب النهائية أعلى من snapshot (الكتابة استمرت بعد الالتقاط)
  {
    const c = new Database(clonePath, { readonly: true });
    const counter = c.query(`SELECT v FROM __c4a_counter WHERE id = 1`).get() as { v: number };
    const rows = c.query(`SELECT COUNT(*) AS n FROM __c4a_rows`).get() as { n: number };
    line(
      "الكتابة استمرت بعد الـ snapshot (تزامن حقيقي لا تسلسل)",
      Number(counter.v) === finalTotal && finalTotal > snapshotV,
      `clone النهائي: counter=${counter.v} · rows=${rows.n} > snapshot=${snapshotV}`
    );
    const integ = c.query("PRAGMA integrity_check").get() as Record<string, string>;
    line("integrity_check للـ clone بعد كل الكتابة", integ.integrity_check === "ok");
    c.close();
  }

  // قاعدة التشغيل لم تُلمس (الاختبار كله على الـ clone)
  {
    const chk = new Database(PROD, { readonly: true });
    const r = chk.query("PRAGMA integrity_check").get() as Record<string, string>;
    chk.close();
    line("integrity_check لقاعدة التشغيل (لم تُستخدم في الاختبار)", r.integrity_check === "ok");
  }

  // تنظيف: النسخة المرجعية للاختبار تُحذف (نسخة clone تجريبية ليست نسخة رسمية)
  rmSync(zipPath, { force: true });
  rmSync(path.join(backupDir, `${created.backupId}.manifest.json`), { force: true });
  rmSync(ws, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
  // أي مخلفات staging
  const staging = path.join(ROOT, "var", "restore-staging");
  if (existsSync(staging)) {
    for (const f of readdirSync(staging)) {
      if (f.startsWith("create-") || f.startsWith("validate-") || f.startsWith("drill-") || f.startsWith("upload-")) {
        rmSync(path.join(staging, f), { recursive: true, force: true });
      }
    }
  }
  line("التنظيف: نسخة الاختبار المرجعية والمجلدات المؤقتة أزيلت", !existsSync(zipPath));
  // دليل sha256 للنسخة (توثيق فقط)
  console.log(`   (SHA-256 snapshot في الـ Manifest: ${created.manifest.database.sha256.slice(0, 16)}… · hash محلي: ${createHash("sha256").update(dbBuf).digest("hex").slice(0, 16)}…)`);

  console.log(failures === 0 ? "\n=== اختبار الاتساق: نجاح كامل ===" : `\n=== فشل ${failures} فحص ===`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
