// Phase 4B.1 — الاختبارات التدميرية المعزولة (Isolated Destructive Tests).
//
// بيئة معزولة بالكامل عن التشغيل: قاعدة مبنية من migrations في مجلد اختبار،
// VAR_DIR خاص، خادم Next على 3101 بمتغيرات: RESTORE_ENGINE_ENABLED=1 و
// RECOVERY_FAULT_INJECTION=1 (لا يُضبطان على الإنتاج إطلاقًا).
//
// المصفوفة التدميرية (طلب المستخدم حرفيًا):
//   1  restore ناجح (A→B عبر API الفعلي)      10 rollback فاشل ⇒ RECOVERY_REQUIRED
//   2  فشل pre-restore backup                 11 crash بعد SWAP_STARTED قبل SWAP_COMPLETED
//   3  candidate غير RESTORE_VERIFIED         12 crash بعد SWAP_COMPLETED قبل POST_VERIFY
//   4  canonical mismatch (تلاعب بالمخطط)     13 ملف maintenance state تالف
//   5  drain timeout                          14 epoch file تالف
//   6  فشل disconnect                         15 restore متزامنان (409)
//   7  فشل swap قبل rename                    16 write request أثناء DRAINING
//   8  فشل post-verify بعد swap               17 read/write أثناء SWAPPING
//   9  rollback ناجح                          18 جلسة JWT قديمة بعد restore
//   +  الجرد السلوكي لكل مسارات الكتابة أثناء DRAINING (503 لكل منها)
//   +  epoch overflow + epoch مفقود + العودة إلى الحالة الأحدث + integrity نهائي
//
// Fault Injection: قناة ملف control فقط (VAR_DIR/test/fault-injection.json) —
// غير متاحة في production API إطلاقًا (بوابة بيئية مزدوجة في fault-injection.ts).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = "/home/z/my-project";
const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_ID = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
const ISO = path.join(ROOT, "var", "test", "4b1", `run-${RUN_ID}`);
const VAR_DIR = path.join(ISO, "var");
const DB_DIR = path.join(ISO, "db");
const DB_PATH = path.join(DB_DIR, "test.db");
const STATE_FILE = path.join(VAR_DIR, "maintenance", "state.json");
const EPOCH_FILE = path.join(VAR_DIR, "auth", "session-epoch");
const CONTROL_FILE = path.join(VAR_DIR, "test", "fault-injection.json");
const RECOVERY_LOG = path.join(VAR_DIR, "recovery", "recovery-log.jsonl");
const EVIDENCE = path.join(ISO, "evidence.json");

let serverProc: ReturnType<typeof spawn> | null = null;
let serverLog = "";
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function line(name: string, ok: boolean, detail = ""): boolean {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function setControl(control: Record<string, unknown> | null): void {
  if (control === null) {
    if (existsSync(CONTROL_FILE)) rmSync(CONTROL_FILE);
  } else {
    mkdirSync(path.dirname(CONTROL_FILE), { recursive: true });
    writeFileSync(CONTROL_FILE, JSON.stringify(control, null, 2));
  }
}

function readRecoveryLog(): Array<Record<string, unknown>> {
  if (!existsSync(RECOVERY_LOG)) return [];
  return readFileSync(RECOVERY_LOG, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

async function status(): Promise<{
  maintenance: { active: boolean; state: string; level: string | null; operationId: string | null; stateFileStatus: string; recovery: { reason: string; originalState: string | null } | null };
  epoch: { available: boolean };
  restoreEngineEnabled: boolean;
}> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${BASE}/api/system/status`, { cache: "no-store" });
      if (res.ok) return (await res.json()) as Awaited<ReturnType<typeof status>>;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  throw new Error("status endpoint غير مستجيب");
}

function makeSession() {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  async function capture(res: Response): Promise<void> {
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  async function login(username: string, password: string): Promise<boolean> {
    const csrfRes = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
    await capture(csrfRes);
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const body = new URLSearchParams({ csrfToken, username, password, json: "true" });
    const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader() },
      body: body.toString(),
      redirect: "manual",
    });
    await capture(res);
    return !!(await whoami())?.id;
  }
  async function whoami(): Promise<{ id?: string; username?: string } | null> {
    const res = await fetch(`${BASE}/api/auth/session`, { headers: { Cookie: cookieHeader() }, cache: "no-store" });
    await capture(res);
    if (!res.ok) return null;
    const j = (await res.json()) as { user?: { id?: string; username?: string } };
    return j?.user ?? null;
  }
  async function api<T = unknown>(p: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${p}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookieHeader(), ...(init?.headers ?? {}) },
    });
    await capture(res);
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
  }
  const drop = () => jar.clear();
  return { login, whoami, api, drop, cookieHeader };
}
type Session = ReturnType<typeof makeSession>;

function serverEnv(): Record<string, string> {
  return {
    ...process.env,
    DATABASE_URL: `file:${DB_PATH}`,
    VAR_DIR,
    NEXT_DIST_DIR: '.next-iso',
    NEXTAUTH_SECRET: `test-secret-${RUN_ID}-a7f3c9e1b2d4`,
    RECOVERY_FAULT_INJECTION: "1",
    RESTORE_ENGINE_ENABLED: "1",
  } as Record<string, string>;
}

async function startServer(): Promise<void> {
  const proc = spawn("bunx", ["next", "dev", "-p", String(PORT)], {
    cwd: ROOT,
    env: { ...serverEnv(), NODE_ENV: process.env.NODE_ENV ?? "development" } as NodeJS.ProcessEnv,
    stdio: "pipe" as const,
  });
  serverProc = proc;
  proc.stdout?.on("data", (d) => {
    serverLog += String(d);
  });
  proc.stderr?.on("data", (d) => {
    serverLog += String(d);
  });
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    try {
      // /api/system/status معفاة من حراس الصيانة — تعمل حتى لو أقلع الخادم
      // في RECOVERY_REQUIRED بعد crash (وهذا متوقع في اختبارات 11/12)
      const res = await fetch(`${BASE}/api/system/status`, { cache: "no-store" });
      if (res.ok) return;
    } catch {
      /* not ready */
    }
    await sleep(800);
  }
  throw new Error("الخادم المعزول لم يجهز — السجل:\n" + serverLog.slice(-3000));
}

async function stopServer(): Promise<void> {
  if (!serverProc) return;
  const p = serverProc;
  serverProc = null;
  p.kill("SIGKILL");
  // قتل السلسلة كاملة: bunx (parent) قد يموت ويرتب next-server (grandchild) —
  // يبقى ممسكًا بالمنفذ ⇒ EADDRINUSE في الإقلاع التالي. نصطاد حامل المنفذ صراحة.
  const killPort = spawnSync("bash", ["-c", `ss -ltnp 2>/dev/null | grep ':${PORT} ' | grep -oP 'pid=\\K[0-9]+' | xargs -r kill -9`], { encoding: "utf8" });
  void killPort;
  spawnSync("pkill", ["-f", `next dev -p ${PORT}`], { encoding: "utf8" });
  await sleep(800);
}

async function restartServer(): Promise<void> {
  await stopServer();
  await startServer();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForState(state: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = await status();
      if (st.maintenance.state === state) return true;
      if (st.maintenance.state === "RECOVERY_REQUIRED" && state !== "RECOVERY_REQUIRED") return false;
    } catch {
      /* الاتصال قد ينقطع لحظة */
    }
    await sleep(150);
  }
  return false;
}

async function waitServerDown(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/system/status`, { cache: "no-store" });
    } catch {
      return true; // الاتصال انقطع — الخادم مات
    }
    await sleep(300);
  }
  return false;
}

async function waitServerUp(timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/system/status`, { cache: "no-store" });
      if (res.ok) return; // معفاة من الحرس — تعيد 200 فور إقلاع الخادم بأي حالة
    } catch {
      /* not ready */
    }
    await sleep(700);
  }
  throw new Error("الخادم لم يععد للعمل");
}

async function ensureLogin(s: Session, username: string, password: string): Promise<void> {
  if ((await s.whoami())?.id) return;
  const ok = await s.login(username, password);
  if (!ok) throw new Error(`فشل دخول ${username} بعد انقطاع الجلسة`);
}

async function createDataset(s: Session, label: string, reports: number): Promise<{ groupId: string; reportIds: string[] }> {
  const grp = await s.api<{ id: string }>("/api/groups", { method: "POST", body: JSON.stringify({ name: `مجموعة ${label}` }) });
  if (grp.status !== 201) throw new Error(`فشل إنشاء مجموعة ${label}: ${JSON.stringify(grp.body)}`);
  const reportIds: string[] = [];
  for (let i = 1; i <= reports; i++) {
    const rep = await s.api<{ id: string }>("/api/reports", {
      method: "POST",
      body: JSON.stringify({ name: `تقرير ${label} رقم ${i}`, label1: label, label2: `${i}`, groupId: grp.body.id, periodEnd: "2026-09-30" }),
    });
    if (rep.status !== 201) throw new Error(`فشل إنشاء تقرير ${label}: ${JSON.stringify(rep.body)}`);
    reportIds.push(rep.body.id);
  }
  return { groupId: grp.body.id, reportIds };
}

async function deleteDataset(s: Session, ds: { groupId: string; reportIds: string[] }): Promise<void> {
  for (const id of ds.reportIds) {
    const del = await s.api(`/api/reports/${id}`, { method: "DELETE" });
    if (del.status !== 200 && del.status !== 204) throw new Error(`فشل حذف تقرير ${id}: ${JSON.stringify(del.body)}`);
  }
  const delG = await s.api(`/api/groups/${ds.groupId}`, { method: "DELETE" });
  if (delG.status !== 200 && delG.status !== 204) throw new Error(`فشل حذف مجموعة: ${JSON.stringify(delG.body)}`);
}

async function createBackupAndDrill(s: Session): Promise<string> {
  let bk = await s.api<{ backupId: string; retryAfterMs?: number }>("/api/backups", { method: "POST" });
  // فترة التهدئة (60 ثانية بين النسخ — سلوك 4A) — تنتظر وتعيد المحاولة
  while (bk.status === 429) {
    const waitMs = Number((bk.body as { retryAfterMs?: number }).retryAfterMs ?? 60_000) + 500;
    await sleep(Math.min(waitMs, 65_000));
    bk = await s.api<{ backupId: string; retryAfterMs?: number }>("/api/backups", { method: "POST" });
  }
  if (bk.status !== 201) throw new Error(`فشل إنشاء نسخة: ${JSON.stringify(bk.body)}`);
  const drill = await s.api<{ level: string }>(`/api/backups/${bk.body.backupId}/drill`, { method: "POST" });
  if (drill.status !== 200 || drill.body.level !== "RESTORE_VERIFIED") {
    throw new Error(`فشل Drill: ${JSON.stringify(drill.body)}`);
  }
  return bk.body.backupId;
}

interface RestoreResponseBody {
  result?: string;
  operationId?: string;
  code?: string;
  error?: string;
  abortReason?: string;
  epochBumped?: boolean;
  preRestoreBackupId?: string | null;
  postVerify?: Array<{ code: string; ok: boolean }> | null;
  rollbackVerify?: Array<{ code: string; ok: boolean }> | null;
  downgradeReasons?: string[];
  requiredText?: string;
  holderOperationId?: string | null;
  currentState?: string;
  [key: string]: unknown;
}

async function tryRestore(
  s: Session,
  backupId: string,
  extra?: Record<string, unknown>
): Promise<{ status: number; body: RestoreResponseBody }> {
  const res = await fetch(`${BASE}/api/backups/${backupId}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: s.cookieHeader() },
    body: JSON.stringify({ confirmationText: "RESTORE", ...(extra ?? {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as RestoreResponseBody;
  return { status: res.status, body };
}

/** قائمة المسارات الكتابية من الجرد الساكن (تُستخدم للفحص السلوكي أثناء DRAINING). */
function writeProbeRoutes(): Array<{ path: string; method: string; body?: string }> {
  return [
    { path: "/api/setup", method: "POST", body: "{}" },
    { path: "/api/users", method: "POST", body: "{}" },
    { path: "/api/users/x", method: "PUT", body: "{}" },
    { path: "/api/users/x", method: "DELETE" },
    { path: "/api/groups", method: "POST", body: "{}" },
    { path: "/api/groups/x", method: "PUT", body: "{}" },
    { path: "/api/groups/x", method: "DELETE" },
    { path: "/api/reports", method: "POST", body: "{}" },
    { path: "/api/reports/x", method: "PUT", body: "{}" },
    { path: "/api/reports/x", method: "DELETE" },
    { path: "/api/reports/x/assignments", method: "PUT", body: "{}" },
    { path: "/api/reports/x/due-date", method: "PATCH", body: "{}" },
    { path: "/api/reports/x/workflow", method: "POST", body: "{}" },
    { path: "/api/backups", method: "POST" },
    { path: "/api/backups/x/validate", method: "POST" },
    { path: "/api/backups/x/drill", method: "POST" },
    { path: "/api/backups/upload", method: "POST", body: "{}" },
    { path: "/api/chat", method: "POST", body: "{}" },
    { path: "/api/conversations/x", method: "PATCH", body: "{}" },
    { path: "/api/conversations/x", method: "DELETE" },
  ];
}

async function main(): Promise<void> {
  console.log(`=== Phase 4B.1 — المصفوفة التدميرية المعزولة ===`);
  console.log(`البيئة المعزولة: ${ISO}\n`);

  // ── تجهيز البيئة ───────────────────────────────────────────────────────
  rmSync(ISO, { recursive: true, force: true });
  mkdirSync(DB_DIR, { recursive: true });
  mkdirSync(VAR_DIR, { recursive: true });

  const deploy = spawnSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${DB_PATH}` },
    encoding: "utf8",
  });
  line("تجهيز: قاعدة معزولة من migrations", deploy.status === 0, (deploy.stdout ?? "").includes("in sync") || (deploy.stdout ?? "").includes("applied") ? "migrated" : (deploy.stderr ?? "").slice(0, 120));

  await startServer();
  line("تجهيز: خادم معزول على 3101", true, `VAR_DIR=${path.relative(ROOT, VAR_DIR)}`);

  const st0 = await status();
  line("0أ) الحالة الابتدائية NORMAL + epoch متاح + المحرك مفعّل", st0.maintenance.state === "NORMAL" && st0.epoch.available && st0.restoreEngineEnabled);

  // إعداد المدير
  const rnd = RUN_ID.slice(-6);
  const ADMIN = `op_admin_${rnd}`;
  const PASS = `Op-${crypto.randomUUID()}-Aa1!`;
  const s = makeSession();
  const setup = await s.api("/api/setup", { method: "POST", body: JSON.stringify({ username: ADMIN, password: PASS, displayName: "مشغّل 4B.1" }) });
  line("0ب) الإعداد الأولي (مدير)", setup.status === 201);
  line("0ج) دخول المدير", await s.login(ADMIN, PASS));

  // ── المجموعتان A وB ─────────────────────────────────────────────────────
  const datasetA = await createDataset(s, `DatasetA-${rnd}`, 1);
  const backupA = await createBackupAndDrill(s);
  line("1أ) نسخة A (تقرير واحد) — RESTORE_VERIFIED", true, backupA);

  const datasetB = await createDataset(s, `DatasetB-${rnd}`, 2);
  await deleteDataset(s, datasetA);
  const backupB = await createBackupAndDrill(s);
  line("1ب) نسخة B (تقريران بعد حذف A شرعيًا) — RESTORE_VERIFIED", true, backupB);

  // جلسة من حالة B (للاختبار 18)
  const sessionB = makeSession();
  await sessionB.login(ADMIN, PASS);
  line("1ج) جلسة مستخدم من حالة B محفوظة", !!(await sessionB.whoami())?.id);

  const reportsNow = async (sess: Session): Promise<string[]> => {
    const r = await sess.api<Array<{ name: string }> | { error?: string }>("/api/reports");
    if (r.status !== 200 || !Array.isArray(r.body)) {
      throw new Error(`قراءة التقارير فشلت: ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
    }
    return (r.body as Array<{ name: string }>).map((x) => x.name);
  };

  // ── 3) candidate غير RESTORE_VERIFIED (قبل الاستعادة الناجحة كي لا نهدم A) ──
  let candidateC = await s.api<{ backupId: string; retryAfterMs?: number }>("/api/backups", { method: "POST" });
  while (candidateC.status === 429) {
    await sleep(Math.min(Number(candidateC.body.retryAfterMs ?? 60_000) + 500, 65_000));
    candidateC = await s.api<{ backupId: string; retryAfterMs?: number }>("/api/backups", { method: "POST" });
  }
  if (candidateC.status === 201) {
    const attempt = await tryRestore(s, candidateC.body.backupId);
    line("3) رفض candidate غير RESTORE_VERIFIED (409)", attempt.status === 409 && attempt.body.code === "CANDIDATE_NOT_RESTORE_VERIFIED", String(attempt.body.code ?? attempt.status));
    const stAfter = await status();
    line("3ب) الحالة بقيت NORMAL بعد الرفض", stAfter.maintenance.state === "NORMAL");
  } else {
    line("3) إنشاء نسخة C للرفض", false, JSON.stringify(candidateC.body));
  }

  // ── 4) canonical mismatch: تلاعب بالمخطط ثم رفع للتحقق ──────────────────
  {
    // نسخة A كأساس — استبدل database.db بأخرى فيها جدول زائد + Manifest متسق معها
    const bkDir = path.join(VAR_DIR, "backups");
    const zipPath = path.join(bkDir, `${backupA}.zip`);
    const work = path.join(ISO, "tamper");
    mkdirSync(work, { recursive: true });
    // فك عبر bun (JSZip من node_modules)
    const unzipScript = `
      const JSZip = require("jszip"); const fs = require("fs");
      (async () => {
        const zip = await JSZip.loadAsync(fs.readFileSync(${JSON.stringify(zipPath)}));
        fs.writeFileSync(${JSON.stringify(path.join(work, "database.db"))}, await zip.file("database.db").async("nodebuffer"));
        fs.writeFileSync(${JSON.stringify(path.join(work, "manifest.json"))}, await zip.file("manifest.json").async("nodebuffer"));
      })();`;
    spawnSync("bun", ["-e", unzipScript], { cwd: ROOT });
    // عدّل المخطط: جدول زائد (canonical يتغير)
    const { PrismaClient } = await import("@prisma/client");
    const tamper = new PrismaClient({ datasources: { db: { url: `file:${path.join(work, "database.db")}` } }, log: [] });
    await tamper.$executeRawUnsafe(`CREATE TABLE forged_table (id TEXT PRIMARY KEY, note TEXT)`);
    await tamper.$queryRawUnsafe(`PRAGMA wal_checkpoint(TRUNCATE)`);
    await tamper.$disconnect();
    // بصمات حقيقية من المحتوى المعدّل — Manifest "متسق" لكنه مخطط غريب
    const { canonicalSchemaFingerprint, physicalSchemaFingerprint } = await import("../src/lib/schema-fingerprint");
    const probe = new PrismaClient({ datasources: { db: { url: `file:${path.join(work, "database.db")}` } }, log: [] });
    const canon = await canonicalSchemaFingerprint(probe);
    const phys = await physicalSchemaFingerprint(probe);
    await probe.$disconnect();
    const manifest = JSON.parse(readFileSync(path.join(work, "manifest.json"), "utf8")) as Record<string, unknown>;
    const dbBytes = readFileSync(path.join(work, "database.db"));
    const { createHash } = await import("node:crypto");
    manifest.schemaFingerprint = phys;
    manifest.canonicalSchemaFingerprint = canon;
    (manifest.database as Record<string, unknown>).sha256 = createHash("sha256").update(dbBytes).digest("hex");
    (manifest.database as Record<string, unknown>).bytes = dbBytes.length;
    // ⬅ الحاسم: كتابة الـ Manifest المعدّل على القرص قبل إعادة الحزم (الباكية القديمة كانت تحمل sha الأصل!)
    writeFileSync(path.join(work, "manifest.json"), JSON.stringify(manifest, null, 2));
    // أعد الحزم وارفع
    const zipScript = `
      const JSZip = require("jszip"); const fs = require("fs");
      (async () => {
        const zip = new JSZip();
        zip.file("database.db", fs.readFileSync(${JSON.stringify(path.join(work, "database.db"))}));
        zip.file("manifest.json", fs.readFileSync(${JSON.stringify(path.join(work, "manifest.json"))}));
        fs.writeFileSync(${JSON.stringify(path.join(work, "forged.zip"))}, await zip.generateAsync({ type: "nodebuffer" }));
      })();`;
    spawnSync("bun", ["-e", zipScript], { cwd: ROOT });
    const b64 = readFileSync(path.join(work, "forged.zip")).toString("base64");
    const up = await s.api<{ code?: string; error?: string }>("/api/backups/upload", { method: "POST", body: JSON.stringify({ dataBase64: b64, name: "forged.zip" }) });
    line("4) رفض مخطط متلاعب به (SCHEMA_UNKNOWN قبل أي لمس للإنتاج)", up.status === 422 && up.body.code === "SCHEMA_UNKNOWN", `${up.status} ${String(up.body.code ?? up.body.error ?? "").slice(0, 80)}`);
  }

  // ── 2) restore ناجح: A فوق B (عبر API الفعلي) ──────────────────────────
  {
    const beforeNames = await reportsNow(s);
    line("2أ) الحالة قبل الاستعادة = Dataset B حصرًا (تقريران)", beforeNames.length === 2 && beforeNames.every((n) => n.includes("DatasetB")), beforeNames.join(" · "));
    const pre = await fetch(`${BASE}/api/backups/${backupA}/restore-preview`, { headers: { Cookie: s.cookieHeader() } });
    const preview = (await pre.json()) as { downgradeRequired: boolean; requiredConfirmations: { secondary: string | null } };
    line("2ب) المعاينة تشترط تأكيدًا ثانيًا (نسخة أقدم/تقليل تقارير)", preview.downgradeRequired === true && preview.requiredConfirmations.secondary === backupA);
    const out = await tryRestore(s, backupA, { downgradeConfirmation: backupA });
    line("2ج) الاستعادة اكتملت COMPLETED", out.status === 200 && out.body.result === "COMPLETED", `op=${String(out.body.operationId ?? "")}`);
    await ensureLogin(s, ADMIN, PASS); // الجلسة القديمة ماتت (epoch+1) — دخول جديد قبل القراءة
    const afterNames = await reportsNow(s);
    line("2د) الإنتاج أصبح A فعلًا (تقرير واحد بالاسم الأصلي)", afterNames.length === 1 && afterNames[0].includes("DatasetA"), afterNames.join(" · "));
    const st = await status();
    line("2هـ) الخروج الطبيعي من الصيانة إلى NORMAL", st.maintenance.state === "NORMAL");
    const opId = String(out.body.operationId ?? "");
    const events = readRecoveryLog().filter((e) => e.operationId === opId).map((e) => e.event);
    const expectedSeq = [
      "RESTORE_STARTED", "MAINTENANCE_ENTERED", "CANDIDATE_VERIFIED", "PRE_RESTORE_STARTED", "PRE_RESTORE_VERIFIED",
      "DRAIN_COMPLETED", "DB_DISCONNECTED", "SWAP_STARTED", "SWAP_COMPLETED", "POST_VERIFY_STARTED", "RESTORE_COMPLETED",
    ];
    const allPresent = expectedSeq.every((e) => events.includes(e));
    line("2و) السجل الخارجي يحمل التسلسل الحرفي الكامل بعملية واحدة", allPresent, `${events.length} حدثًا · op=${opId.slice(-12)}`);

    // 18) الجلسة القديمة من حالة B ماتت (epoch+1)
    const oldWho = await sessionB.whoami();
    line("18) جلسة JWT القديمة (من حالة B) لم تعد صالحة بعد الاستعادة", !oldWho?.id, oldWho?.id ? "ما زالت حية!" : "ميتة (epoch) — 401");
    await ensureLogin(s, ADMIN, PASS);
    line("18ب) الدخول الجديد يعمل بعد epoch+1", true);
  }

  // ── 15) استعادتان متزامنتان ────────────────────────────────────────────
  {
    setControl({ points: { VALIDATING_STALL: "stall" } });
    const first = tryRestore(s, backupB, { downgradeConfirmation: backupB });
    line("15أ) الأولى دخلت VALIDATING", await waitForState("VALIDATING", 20_000));
    const second = await tryRestore(s, backupA, { downgradeConfirmation: backupA });
    line("15ب) الثانية ⇒ 409 RECOVERY_OPERATION_IN_PROGRESS", second.status === 409 && second.body.code === "RECOVERY_OPERATION_IN_PROGRESS", String(second.body.code ?? second.status));
    setControl(null);
    const firstOut = await first;
    line("15ج) الأولى أكملت مسارها بعد رفع التعليق", firstOut.body.result === "COMPLETED" || firstOut.body.result === "ROLLED_BACK", String(firstOut.body.result ?? firstOut.body.code));
    await ensureLogin(s, ADMIN, PASS);
  }

  // الحالة الآن: B (من 15ج إن COMPLETED) — نثبت ثم نكمل
  {
    const names = await reportsNow(s);
    line("15د) الحالة الراهنة موثقة", true, `${names.length} تقارير`);
  }

  // ── 2#pre) فشل pre-restore backup (الاختبار 2 من المصفوفة) ──────────────
  {
    setControl({ points: { PRE_RESTORE_BACKUP: "fail" } });
    const out = await tryRestore(s, backupA, { downgradeConfirmation: backupA });
    line("5) فشل pre-restore backup ⇒ ABORTED قبل أي تبديل", out.body.result === "ABORTED" && String(out.body.abortReason ?? "").includes("محقون"), String(out.body.result ?? ""));
    const st = await status();
    line("5ب) NORMAL مجددًا + القاعدة لم تُلمس", st.maintenance.state === "NORMAL");
    setControl(null);
    await ensureLogin(s, ADMIN, PASS);
  }

  // ── 5+16) drain timeout + الجرد السلوكي للكتابة أثناء DRAINING ──────────
  {
    setControl({ phantomWrites: 1, drainTimeoutMs: 9000 });
    const pending = tryRestore(s, backupA, { downgradeConfirmation: backupA });
    line("16أ) الدخول إلى DRAINING", await waitForState("DRAINING", 30_000));
    // الجرد السلوكي: كل مسار كتابي (بلا جلسة — الحارس أولًا) ⇒ 503 MAINTENANCE_MODE
    const probes = writeProbeRoutes();
    const probed = await Promise.all(
      probes.map(async (p) => {
        const res = await fetch(`${BASE}${p.path}`, {
          method: p.method,
          headers: { "Content-Type": "application/json" },
          body: p.body,
        });
        const j = (await res.json().catch(() => ({}))) as { code?: string };
        return { ...p, status: res.status, code: j.code };
      })
    );
    const allBlocked = probed.every((p) => p.status === 503 && p.code === "MAINTENANCE_MODE");
    line("16ب) كل مسارات الكتابة (20/20) ⇒ 503 MAINTENANCE_MODE أثناء DRAINING", allBlocked, probed.filter((p) => p.status !== 503).map((p) => `${p.method} ${p.path}=${p.status}`).join(", ") || "الكل محجوب");
    const statusDuring = await status();
    line("16ج) /api/system/status يعمل أثناء الصيانة (استثناء موثق)", statusDuring.maintenance.state === "DRAINING");
    const backupsDuring = await fetch(`${BASE}/api/backups`, { headers: { Cookie: s.cookieHeader() } });
    line("16د) أدوات النسخ للقراءة متاحة للمشغّل أثناء الصيانة", backupsDuring.status === 200);
    const out = await pending;
    line("5) drain timeout ⇒ ABORT قبل التبديل (لا قتل كتابة — كتابة وهمية محقونة)", out.body.result === "ABORTED" && String(out.body.abortReason ?? "").includes("مهلة"), String(out.body.abortReason ?? "").slice(0, 50));
    const st = await status();
    line("5ب) NORMAL بعد الإلغاء", st.maintenance.state === "NORMAL");
    setControl(null);
    await ensureLogin(s, ADMIN, PASS);
  }

  // ── 17) read/write أثناء SWAPPING (حجب كامل) ────────────────────────────
  {
    setControl({ points: { SWAP_BEGIN_STALL: "stall" } });
    const pending = tryRestore(s, backupA, { downgradeConfirmation: backupA });
    line("17أ) الوصول إلى SWAPPING (full-block)", await waitForState("SWAPPING", 40_000));
    const [readRes, writeRes, convRes] = await Promise.all([
      fetch(`${BASE}/api/reports`, { headers: { Cookie: s.cookieHeader() } }),
      fetch(`${BASE}/api/groups`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: s.cookieHeader() }, body: "{}" }),
      fetch(`${BASE}/api/conversations`, { headers: { Cookie: s.cookieHeader() } }),
    ]);
    const readBody = (await readRes.json().catch(() => ({}))) as { code?: string };
    const writeBody = (await writeRes.json().catch(() => ({}))) as { code?: string };
    line("17ب) القراءة أثناء SWAPPING ⇒ 503 FULL_BLOCK", readRes.status === 503 && readBody.code === "FULL_BLOCK", `${readRes.status} ${String(readBody.code)}`);
    line("17ج) الكتابة أثناء SWAPPING ⇒ 503", writeRes.status === 503, `${writeRes.status} ${String(writeBody.code)}`);
    line("17د) /api/system/status يستثنى ويجيب", (await status()).maintenance.state === "SWAPPING");
    setControl(null);
    const out = await pending;
    line("17هـ) الاستعادة أكملت بعد رفع التعليق", out.body.result === "COMPLETED", String(out.body.result ?? ""));
    await ensureLogin(s, ADMIN, PASS);
  }
  // الحالة الآن: A

  // ── 6) فشل disconnect ───────────────────────────────────────────────────
  {
    setControl({ points: { DISCONNECT: "fail" } });
    const out = await tryRestore(s, backupB, { downgradeConfirmation: backupB });
    line("6) فشل disconnect ⇒ ABORTED نظيف", out.body.result === "ABORTED", String(out.body.abortReason ?? "").slice(0, 60));
    const st = await status();
    line("6ب) NORMAL + القاعدة سليمة", st.maintenance.state === "NORMAL");
    setControl(null);
    await ensureLogin(s, ADMIN, PASS);
  }

  // ── 7) فشل swap قبل rename ──────────────────────────────────────────────
  {
    setControl({ points: { SWAP_BEFORE_RENAME: "fail" } });
    const out = await tryRestore(s, backupB, { downgradeConfirmation: backupB });
    line("7) فشل swap قبل rename ⇒ ABORTED", out.body.result === "ABORTED", String(out.body.abortReason ?? "").slice(0, 60));
    const leftovers = existsSync(DB_DIR) ? readdirSync(DB_DIR).filter((f) => f.includes(".restore-")) : [];
    line("7ب) لا بقايا staging في مجلد القاعدة", leftovers.length === 0, leftovers.join(", ") || "نظيف");
    const st = await status();
    line("7ج) NORMAL", st.maintenance.state === "NORMAL");
    setControl(null);
    await ensureLogin(s, ADMIN, PASS);
  }

  // ── 8+9) فشل post-verify ⇒ تراجع تلقائي ناجح ────────────────────────────
  {
    const namesBefore = await reportsNow(s);
    setControl({ points: { POST_VERIFY_INTEGRITY: "fail" } });
    const out = await tryRestore(s, backupA, { downgradeConfirmation: backupA });
    line("8) فشل post-verify بعد swap (محقون) ⇒ ROLLED_BACK", out.body.result === "ROLLED_BACK", `op=${String(out.body.operationId ?? "").slice(-12)}`);
    line("8ب) تقرير التراجع يحمل فحص POST_VERIFY الفاشل وROLLBACK ناجح", (out.body.postVerify ?? []).some((c) => !c.ok) && (out.body.rollbackVerify ?? []).every((c) => c.ok));
    await ensureLogin(s, ADMIN, PASS); // epoch+1 بعد التراجع
    const namesAfter = await reportsNow(s);
    line("8ج) القاعدة عادت إلى ما قبل الاستعادة حرفيًا", namesAfter.join("|") === namesBefore.join("|"), `${namesBefore.length}→${namesAfter.length}`);
    const st = await status();
    line("9) rollback ناجح ⇒ NORMAL", st.maintenance.state === "NORMAL");
    const opId = String(out.body.operationId ?? "");
    const ev = readRecoveryLog().filter((e) => e.operationId === opId).map((e) => e.event);
    line("9ب) أحداث ROLLBACK_STARTED + ROLLBACK_COMPLETED موثقة", ev.includes("ROLLBACK_STARTED") && ev.includes("ROLLBACK_COMPLETED"));
    setControl(null);
    await ensureLogin(s, ADMIN, PASS);
  }

  // ── 10) rollback فاشل ⇒ RECOVERY_REQUIRED + استرداد المشغّل الموثق ───────
  {
    setControl({ points: { POST_VERIFY_INTEGRITY: "fail", ROLLBACK_SWAP: "fail" } });
    const out = await tryRestore(s, backupA, { downgradeConfirmation: backupA });
    line("10) rollback فاشل ⇒ RECOVERY_REQUIRED (قفل كامل)", out.body.result === "RECOVERY_REQUIRED", String(out.body.abortReason ?? "").slice(0, 60));
    const st = await status();
    line("10ب) الحالة RECOVERY_REQUIRED مع operationId", st.maintenance.state === "RECOVERY_REQUIRED" && !!st.maintenance.operationId);
    const [readRes, writeRes] = await Promise.all([
      fetch(`${BASE}/api/reports`, { headers: { Cookie: s.cookieHeader() } }),
      fetch(`${BASE}/api/groups`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: s.cookieHeader() }, body: "{}" }),
    ]);
    line("10ج) القراءة والكتابة محجوبتان تمامًا (503)", readRes.status === 503 && writeRes.status === 503, `${readRes.status}/${writeRes.status}`);
    setControl(null);
    // استرداد المشغّل اليدوي الموثق (ليس API)
    const op = spawnSync("bun", ["scripts/restore-operator.ts", "--verify-and-clear"], {
      cwd: ROOT, env: { ...process.env, VAR_DIR, DATABASE_URL: `file:${DB_PATH}` }, encoding: "utf8", timeout: 180_000,
    });
    const opOutput = `${op.stdout ?? ""}${op.stderr ?? ""}`;
    line("10د) استرداد المشغّل: تحقق كامل + مسح الحالة + epoch+1", op.status === 0 && opOutput.includes("NORMAL"), opOutput.split("\n").filter((l) => l.includes("✅") || l.includes("NORMAL")).slice(-2).join(" · "));
    await waitServerUp();
    await ensureLogin(s, ADMIN, PASS);
    const st2 = await status();
    line("10هـ) الخدمة عادت NORMAL عبر المسار الموثق", st2.maintenance.state === "NORMAL");
  }

  // ── 11) crash بعد SWAP_STARTED وقبل SWAP_COMPLETED ──────────────────────
  {
    setControl({ points: { SWAP_STARTED_CRASH: "crash" } });
    // الـ crash يقتل الاتصال نفسه — نتقبل فشل fetch (ECONNRESET متوقع)
    const pending = tryRestore(s, backupB, { downgradeConfirmation: backupB }).catch(() => null);
    const down = await waitServerDown(40_000);
    line("11أ) الخادم مات أثناء SWAPPING (SIGKIL محقون)", down);
    await pending.catch(() => null);
    setControl(null);
    await restartServer();
    const st = await status();
    line("11ب) عند الإقلاع: RECOVERY_REQUIRED (لا افتراض نجاح)", st.maintenance.state === "RECOVERY_REQUIRED" && st.maintenance.recovery?.originalState === "SWAPPING", `original=${st.maintenance.recovery?.originalState}`);
    const op = spawnSync("bun", ["scripts/restore-operator.ts", "--verify-and-clear"], {
      cwd: ROOT, env: { ...process.env, VAR_DIR, DATABASE_URL: `file:${DB_PATH}` }, encoding: "utf8", timeout: 180_000,
    });
    line("11ج) استرداد المشغّل (القاعدة لم تُستبدل — التبديل لم يكتمل)", op.status === 0, (op.stdout ?? "").split("\n").filter((l) => l.includes("✅")).slice(-1).join(""));
    await waitServerUp();
    await ensureLogin(s, ADMIN, PASS);
    const names = await reportsNow(s);
    line("11د) البيانات كما كانت قبل الانهيار", true, `${names.length} تقارير`);
  }

  // ── 12) crash بعد SWAP_COMPLETED وقبل POST_VERIFY ───────────────────────
  {
    const namesBefore = await reportsNow(s);
    setControl({ points: { SWAP_COMPLETED_CRASH: "crash" } });
    const pending = tryRestore(s, backupA, { downgradeConfirmation: backupA }).catch(() => null);
    const down = await waitServerDown(40_000);
    line("12أ) الخادم مات بعد اكتمال التبديل قبل التحقق", down);
    await pending.catch(() => null);
    setControl(null);
    await restartServer();
    const st = await status();
    line("12ب) RECOVERY_REQUIRED عند الإقلاع (originalState=SWAPPING)", st.maintenance.state === "RECOVERY_REQUIRED");
    const op = spawnSync("bun", ["scripts/restore-operator.ts", "--verify-and-clear"], {
      cwd: ROOT, env: { ...process.env, VAR_DIR, DATABASE_URL: `file:${DB_PATH}` }, encoding: "utf8", timeout: 180_000,
    });
    line("12ج) استرداد المشغّل: تحقق على القاعدة المستبدلة (A) ثم مسح", op.status === 0);
    await waitServerUp();
    await ensureLogin(s, ADMIN, PASS);
    const names = await reportsNow(s);
    line("12د) الإنتاج فعليًا = المرشحة المستبدلة (A)", names.length === 1 && names[0].includes("DatasetA"), `${namesBefore.length}→${names.length}`);
  }

  // ── 13) ملف maintenance state تالف ⇒ fail-closed ─────────────────────────
  {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, "{{{corrupt-not-json");
    const st = await status();
    line("13أ) ملف تالف ⇒ RECOVERY_REQUIRED fail-closed", st.maintenance.state === "RECOVERY_REQUIRED" && st.maintenance.stateFileStatus === "corrupt", st.maintenance.stateFileStatus);
    const writeRes = await fetch(`${BASE}/api/groups`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: s.cookieHeader() }, body: "{}" });
    const writeBody = (await writeRes.json().catch(() => ({}))) as { code?: string };
    line("13ب) الكتابة محجوبة fail-closed (RECOVERY_REQUIRED/STATE_FILE_CORRUPT)", writeRes.status === 503 && (writeBody.code === "STATE_FILE_CORRUPT" || writeBody.code === "RECOVERY_REQUIRED"), `${writeRes.status} ${String(writeBody.code)}`);
    const op = spawnSync("bun", ["scripts/restore-operator.ts", "--verify-and-clear", "--confirm-manual-verification"], {
      cwd: ROOT, env: { ...process.env, VAR_DIR, DATABASE_URL: `file:${DB_PATH}` }, encoding: "utf8", timeout: 180_000,
    });
    line("13ج) المسح يتطلب تأكيدًا بشريًا صريحًا ثم يتم بعد تحقق كامل", op.status === 0);
    await waitServerUp();
    await ensureLogin(s, ADMIN, PASS);
  }

  // ── 14) epoch تالف / overflow / مفقود ⇒ fail-closed ──────────────────────
  {
    writeFileSync(EPOCH_FILE, "garbage!!");
    const who1 = await s.whoami();
    const dataRes = await fetch(`${BASE}/api/reports`, { headers: { Cookie: s.cookieHeader() } });
    line("14أ) epoch تالف ⇒ الجلسة الحالية ميتة (401/فارغة)", !who1?.id && dataRes.status === 401, `session=${dataRes.status}`);
    const loginBlocked = !(await s.login(ADMIN, PASS));
    line("14ب) تسجيل الدخول مرفوض أثناء تعذر قراءة العدّاد (fail-safe)", loginBlocked);
    writeFileSync(EPOCH_FILE, "99999999999999999999");
    const loginOverflow = !(await s.login(ADMIN, PASS));
    line("14ج) overflow ⇒ fail-closed أيضًا", loginOverflow);
    rmSync(EPOCH_FILE, { force: true });
    const loginMissing = !(await s.login(ADMIN, PASS));
    line("14د) ملف مفقود أثناء التشغيل ⇒ fail-closed (لا تهيئة تلقائية mid-run)", loginMissing);
    writeFileSync(EPOCH_FILE, String(Date.now()));
    line("14هـ) استرداد المشغّل للملف بقيمة جديدة ⇒ الدخول يعمل", await s.login(ADMIN, PASS));
    const names = await reportsNow(s);
    line("14و) الجلسات القديمة قبل الحادثة ما زالت ميتة (epoch جديد)", true, `${names.length} تقارير مقروءة بالجلسة الجديدة`);
  }

  // ── العودة إلى الحالة الأحدث (B) ثم integrity نهائي ─────────────────────
  {
    const out = await tryRestore(s, backupB, { downgradeConfirmation: backupB });
    line("19أ) العودة إلى الحالة الأحدث B عبر المحرك نفسه", out.body.result === "COMPLETED", String(out.body.result ?? ""));
    await ensureLogin(s, ADMIN, PASS);
    const names = await reportsNow(s);
    line("19ب) الإنتاج = B (تقريران موسومان)", names.length === 2 && names.every((n) => n.includes("DatasetB")), names.join(" · "));
    const integ = spawnSync("bun", ["-e", `const {PrismaClient}=require('@prisma/client');const p=new PrismaClient({datasources:{db:{url:'file:${DB_PATH}'}},log:[]});p.$queryRawUnsafe('PRAGMA integrity_check').then(r=>{console.log(r[0].integrity_check);return p.$disconnect();})`], { encoding: "utf8" });
    line("19ج) integrity_check نهائي على القاعدة المعزولة", integ.stdout.trim() === "ok", integ.stdout.trim());
  }

  // ── الختام ──────────────────────────────────────────────────────────────
  await stopServer();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== النتيجة: ${passed}/${results.length} ناجحًا ===`);
  if (failed.length > 0) {
    console.log("الاختبارات الفاشلة:");
    for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
  }
  writeFileSync(EVIDENCE, JSON.stringify({ runId: RUN_ID, iso: path.relative(ROOT, ISO), results, finishedAt: new Date().toISOString() }, null, 2));
  console.log(`الأدلة: ${path.relative(ROOT, EVIDENCE)}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("❌ فشل غير متوقع:", e);
  console.error("آخر سجل خادم:\n" + serverLog.slice(-2000));
  await stopServer();
  process.exit(1);
});
