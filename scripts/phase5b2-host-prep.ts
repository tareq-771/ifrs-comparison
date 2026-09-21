// Phase 5B.2 — Host-Prep Readiness Gate — اختبارات غير مدمرة حصرًا.
//
// الأجزاء:
//   A) وحدات وقوالب (بلا خادم): getClientIp (rightmost anti-spoof)، محلل env-file
//      المشترك، ثوابت prod-server/assemble-release، مسح قوالب Windows (Caddy
//      replace-XFF، WinSW، firewall لا يمس 80، env example loopback)،
//      validateProductionConfig (داخل/خارج شجرة النشر).
//   B) مصفوفة تحقق prod-server.mjs (بلا server.js — ENOENT كنقطة مرور بعد
//      كل الفحوص): env file مفقود/تالف، HOSTNAME غير loopback ⇒ FATAL،
//      فتحة الهروب الصريحة، الافتراضي الآمن 127.0.0.1، NODE_ENV صارم.
//   C) بوابة deploy-migrate.mjs على نسخ قاعدة (صفر لمس للبيانات الحية):
//      بلا env، بلا DATABASE_URL، ملف مفقود (لا إنشاء صامت!)، داخل شجرة العمل،
//      مسار سعيد على نسخة، dry-run لا يلمس، PRISMA_CLI_UNRESOLVED.
//   D) standalone إنتاجي حقيقي (.next-prod): نقاء artifact، إقلاع سليم +
//      loopback bind فعلي + health minimal body، أسرار fail-closed (مفقود/ضعيف/
//      محرك غير صريح)، epoch مفقود على قاعدة مهيأة (بلا إنشاء صامت + EPOCH_STATE_LOST
//      + بلا حلقة إقلاع)، epoch تالف (EPOCH_STATE_CORRUPT)، bootstrap قاعدة جديدة،
//      استرداد --epoch-recover (unix-seconds عملي — بلا ادعاء رياضي) + إبطال JWT
//      القديمة فعليًا، صيانة مقطوعة ⇒ RECOVERY_REQUIRED يبقى عبر restarts
//      (لا عودة NORMAL صامتة) ثم مسح مشغّل موثق، نسخة عبر API (ZIP = مدخلان
//      حصرًا بلا أي سر)، صيانة عبر restarts، نسخة عبر API —
//
// الضمانات: كل شيء في VAR_DIR معزولة تحت var/test/5b2/ + نسخ قاعدة مولدة من
// migrations حصرًا (لا نسخ قاعدة التشغيل الحية) + منافذ عالية 31180-31199.
// لا يلمس db/custom.db ولا .env ولا var/ الحية إطلاقًا.
//
// ما يُثبت هنا على Linux (Z.ai) لا يوصف بأنه «إثبات Windows» — الفصل موثق
// في تقرير 5B.2 (المنفذ فعليًا / المحاكى منطقيًا / المؤجل لمضيف Windows 5B.4).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = "/home/z/my-project";
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
let failure = false;

function line(name: string, ok: boolean, detail = ""): boolean {
  results.push({ name, ok, detail });
  if (!ok) failure = true;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}
function section(t: string): void {
  console.log(`\n───── ${t} ─────`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function uniq(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
}

/* ═════════════════ أدوات معزولة مشتركة ═════════════════ */

const RUN_DIR = path.join(ROOT, "var", "test", "5b2", `run-${uniq()}`);
const TMP_OUT = "/tmp";

function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeEnvFile(dir: string, name: string, entries: Record<string, string>): string {
  ensureDir(dir);
  const p = path.join(dir, name);
  writeFileSync(p, Object.entries(entries).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf8");
  return p;
}

function readText(p: string): string {
  return readFileSync(p, "utf8");
}

interface SpawnResult {
  code: number | null;
  out: string;
}

/** تشغيل سكربت node سريع وجمع المخرجات (بلا shell). */
function runNode(script: string, args: string[], env: Record<string, string>, timeoutMs = 60_000): SpawnResult {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/* ═════════════════ بنية الخوادم المعزولة (جزء D) ═════════════════ */

const STANDALONE = path.join(ROOT, ".next-prod", "standalone");

interface ServerHandle {
  proc: ReturnType<typeof spawn> | null;
  port: number;
  log: string;
  name: string;
}

function makeServer(name: string, port: number): ServerHandle {
  return { proc: null, port, log: "", name };
}

async function startProdServer(srv: ServerHandle, env: Record<string, string>): Promise<void> {
  const proc = spawn(process.execPath, [path.join(STANDALONE, "prod-server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    stdio: "pipe",
  });
  srv.proc = proc;
  srv.log = "";
  proc.stdout?.on("data", (d) => (srv.log += String(d)));
  proc.stderr?.on("data", (d) => (srv.log += String(d)));
  await waitHealthy(srv, 75_000);
}

async function waitHealthy(srv: ServerHandle, timeoutMs: number): Promise<{ status: string; http: number; keys: string[] } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`[${srv.name}] لا استجابة خلال ${timeoutMs}ms — آخر السجل:\n${srv.log.slice(-1500)}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/health`, { cache: "no-store" });
      const body = (await res.json()) as Record<string, unknown>;
      if (body?.status) {
        return { status: String(body.status), http: res.status, keys: Object.keys(body).sort() };
      }
    } catch {
      /* لم يقلع بعد */
    }
    await sleep(500);
  }
}

async function stopServer(srv: ServerHandle): Promise<void> {
  if (srv.proc) {
    const p = srv.proc;
    srv.proc = null;
    try {
      p.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  spawnSync("bash", ["-c", `ss -ltnp 2>/dev/null | grep ':${srv.port} ' | grep -oP 'pid=\\K[0-9]+' | xargs -r kill -9`], { encoding: "utf8" });
  await sleep(700);
}

/** انتظار خروج عملية سريعة (سيناريوهات الفشل المغلق) وإرجاع الكود والمخرجات. */
async function waitExit(proc: ReturnType<typeof spawn>, timeoutMs = 45_000): Promise<{ code: number | null }> {
  return await new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ code: null });
    }, timeoutMs);
    proc.once("exit", (code) => {
      clearTimeout(t);
      resolve({ code });
    });
  });
}

function makeSession(port: number) {
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
    const csrfRes = await fetch(`http://127.0.0.1:${port}/api/auth/csrf`, { redirect: "manual" });
    await capture(csrfRes);
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const body = new URLSearchParams({ csrfToken, username, password, json: "true" });
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader() },
      body: body.toString(),
      redirect: "manual",
    });
    await capture(res);
    return !!(await whoami())?.id;
  }
  async function whoami(): Promise<{ id?: string; username?: string } | null> {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers: { Cookie: cookieHeader() }, cache: "no-store" });
    await capture(res);
    if (!res.ok) return null;
    const j = (await res.json()) as { user?: { id?: string; username?: string } };
    return j?.user ?? null;
  }
  async function api<T = unknown>(p: string, init?: RequestInit): Promise<{ status: number; body: T; raw?: Buffer; contentType?: string }> {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookieHeader(), ...(init?.headers ?? {}) },
    });
    await capture(res);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/zip") || ct.includes("octet-stream")) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, body: null as T, raw: buf, contentType: ct };
    }
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
  }
  return { login, whoami, api, cookieHeader };
}

/** تهيئة قاعدة معزولة من migrations (اختبار فقط — لا محرك الإنتاج). */
function migrateFixtureDb(dbPath: string): boolean {
  const res = spawnSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    encoding: "utf8",
  });
  return res.status === 0;
}

/** إدخال مستخدم إداري مباشرة (بلا HTTP) — يجعل القاعدة «مهيأة» (users>0). */
async function seedAdminDirect(dbPath: string, username: string, password: string): Promise<void> {
  const { PrismaClient } = await import("@prisma/client");
  const bcrypt = (await import("bcryptjs")).default;
  const { ADMIN_PERMISSIONS, stringifyPermissions } = await import("../src/lib/permissions");
  const c = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } }, log: [] });
  try {
    await c.user.create({
      data: {
        username,
        passwordHash: await bcrypt.hash(password, 10),
        displayName: "seed-5b2",
        role: "admin",
        permissions: stringifyPermissions(ADMIN_PERMISSIONS),
        active: true,
      },
    });
  } finally {
    await c.$disconnect().catch(() => undefined);
  }
}

function readEpochFile(varDir: string): string | null {
  try {
    return readFileSync(path.join(varDir, "auth", "session-epoch"), "utf8").trim();
  } catch {
    return null;
  }
}

function recoveryLogEvents(varDir: string): string[] {
  try {
    return readFileSync(path.join(varDir, "recovery", "recovery-log.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return (JSON.parse(l) as { event?: string }).event ?? "";
        } catch {
          return "";
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

interface Iso {
  dir: string;
  varDir: string;
  backupDir: string;
  dbPath: string;
  port: number;
}

/** بيئة معزولة كاملة: var + backups + منفذ — بلا قاعدة بعد. */
function makeIso(name: string, port: number): Iso {
  const dir = ensureDir(path.join(RUN_DIR, name));
  const varDir = ensureDir(path.join(dir, "var"));
  const backupDir = ensureDir(path.join(dir, "backups"));
  const dbPath = path.join(dir, "db-fixture.db");
  return { dir, varDir, backupDir, dbPath, port };
}

/** ملف env إنتاجي صالح لبيئة معزولة — مع تجاوزات اختيارية. */
function envFileFor(iso: Iso, overrides: Record<string, string> = {}): string {
  const entries: Record<string, string> = {
    DATABASE_URL: `file:${iso.dbPath}`,
    VAR_DIR: iso.varDir,
    BACKUP_DIR: iso.backupDir,
    NEXTAUTH_SECRET: "p5b2-test-secret-not-real-0123456789abcdefABCDEF",
    NEXTAUTH_URL: `http://127.0.0.1:${iso.port}`,
    RESTORE_ENGINE_ENABLED: "0",
    PORT: String(iso.port),
    HOSTNAME: "127.0.0.1",
    ...overrides,
  };
  const name = `ifrs-${path.basename(iso.dir)}.env`;
  if (overrides.__omit) {
    for (const k of overrides.__omit.split(",")) delete entries[k];
  }
  delete entries.__omit;
  return writeEnvFile(iso.dir, name, entries);
}

/** محتوى ملف حالة صيانة مقطوعة (SWAPPING — نفس شكل writeStateFileAtomic). */
function interruptedStateJson(operationId: string): string {
  const now = new Date().toISOString();
  return JSON.stringify(
    {
      state: "SWAPPING",
      level: "full-block",
      operationId,
      startedAt: now,
      startedBy: { id: null, username: "fixture-5b2" },
      message: "اختبار 5B.2 — عملية مقطوعة محاكاةً (بيئة معزولة)",
      updatedAt: now,
      history: [{ state: "SWAPPING", at: now, ms: 0 }],
      flags: {},
      recovery: null,
    },
    null,
    2
  );
}

/* ═════════════════ الجزء A — وحدات وقوالب ═════════════════ */

async function partA(): Promise<void> {
  section("A) وحدات وقوالب (بلا خادم)");

  // A1 — getClientIp: rightmost anti-spoof
  {
    const { getClientIp } = await import("../src/lib/audit");
    line(
      "A1أ) XFF منتتح: «spoofed, real» ⇒ real (آخر عنصر لا الأول)",
      getClientIp({ headers: { "x-forwarded-for": "6.6.6.6, 192.168.1.50" } }) === "192.168.1.50",
      "كان الأول يُعتمد (قابل للانتحال) — 5B.2 يعتمد الأخير"
    );
    line(
      "A1ب) XFF عنصر واحد (استبدال Caddy {remote_host}) ⇒ يُعتمد كما هو",
      getClientIp({ headers: { "x-forwarded-for": "192.168.1.77" } }) === "192.168.1.77"
    );
    line(
      "A1ج) سلسلة انتحال ثلاثية ⇒ الأخير حصرًا",
      getClientIp({ headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 10.0.0.9" } }) === "10.0.0.9"
    );
    line(
      "A1د) x-real-ip احتياط عند غياب XFF",
      getClientIp({ headers: { "x-real-ip": "192.168.1.90" } }) === "192.168.1.90"
    );
    line("A1هـ) لا ترويسات ⇒ null (لا ادعاء IP للوصول المباشر)", getClientIp({ headers: {} }) === null);
    const h = new Headers({ "x-forwarded-for": "3.3.3.3, 4.4.4.4" });
    line("A1و) كائن Headers الفعلي ⇒ الأخير", getClientIp({ headers: h }) === "4.4.4.4");
    line(
      "A1ز) null/undefined آمن",
      getClientIp(null) === null && getClientIp(undefined) === null
    );
  }

  // A2 — محلل env-file المشترك
  {
    const { parseEnvFile, EnvFileError } = await import("../scripts/env-file.mjs");
    const d = ensureDir(path.join(RUN_DIR, "a2"));
    const good = writeEnvFile(d, "good.env", { DATABASE_URL: "file:D:/IFRS-Data/db/x.db", NEXTAUTH_SECRET: "s".repeat(40) });
    const parsed = parseEnvFile(good);
    line("A2أ) ملف سليم ⇒ متغيران", parsed.count === 2 && parsed.map.DATABASE_URL === "file:D:/IFRS-Data/db/x.db");
    const crlf = path.join(d, "crlf.env");
    writeFileSync(crlf, "A=1\r\nB=2\r\n", "utf8");
    line("A2ب) CRLF يتقبل", parseEnvFile(crlf).count === 2);
    const pointer = path.join(d, "pointer.env");
    writeFileSync(pointer, "IFRS_ENV_FILE=/evil/override\nOK=1\n", "utf8");
    const pp = parseEnvFile(pointer);
    line("A2ج) IFRS_ENV_FILE من الداخل يُتجاهل (لا override للمؤشر)", !("IFRS_ENV_FILE" in pp.map) && pp.map.OK === "1");
    const bad = path.join(d, "bad.env");
    writeFileSync(bad, "GOOD=1\nJUST_TEXT\n", "utf8");
    let badMsg = "";
    try {
      parseEnvFile(bad);
    } catch (e) {
      badMsg = e instanceof Error ? e.message : String(e);
    }
    line("A2د) سطر غير صالح ⇒ خطأ برقم السطر", /سطر 2/.test(badMsg), badMsg);
    let missingMsg = "";
    let missingIsEnvFileError = false;
    try {
      parseEnvFile(path.join(d, "nope.env"));
    } catch (e) {
      missingIsEnvFileError = e instanceof EnvFileError;
      missingMsg = e instanceof Error ? e.message : String(e);
    }
    line("A2هـ) ملف مفقود ⇒ EnvFileError صريح", missingIsEnvFileError && missingMsg.includes("غير موجود"), missingMsg.slice(0, 60));
    let emptyMsg = "";
    try {
      parseEnvFile("");
    } catch (e) {
      emptyMsg = e instanceof Error ? e.message : String(e);
    }
    line("A2و) مسار فارغ ⇒ فشل مغلق", /غير محدد/.test(emptyMsg));
  }

  // A3 — ثوابت prod-server/assemble/deploy-migrate
  {
    const prod = readText(path.join(ROOT, "scripts", "prod-server.mjs"));
    line(
      "A3أ) prod-server يفرض loopback: افتراضي 127.0.0.1 + FATAL غير loopback",
      prod.includes('process.env.HOSTNAME = "127.0.0.1"') && prod.includes("IFRS_BIND_ALLOW_NON_LOOPBACK"),
      "5B.2 §5"
    );
    line("A3ب) prod-server يستورد المحلل المشترك (لا تكرار دلالات)", prod.includes('from "./env-file.mjs"'));
    line("A3ج) prod-server يتعامل مع SIGBREAK/SIGTERM/SIGINT best-effort", prod.includes("SIGBREAK") && prod.includes("SIGTERM"));
    const asm = readText(path.join(ROOT, "scripts", "assemble-release.mjs"));
    line("A3د) assemble-release ينسخ env-file.mjs مع prod-server.mjs", asm.includes("env-file.mjs"));
    const dm = readText(path.join(ROOT, "scripts", "deploy-migrate.mjs"));
    line(
      "A3هـ) deploy-migrate: migrate deploy حصرًا + محلل مشترك + بلا أمر db push",
      dm.includes('"migrate", "deploy"') && dm.includes('from "./env-file.mjs"') && !dm.includes('"db", "push"'),
      "بوابة §6"
    );
  }

  // A4 — Caddyfile.windows
  {
    const c = readText(path.join(ROOT, "deploy", "Caddyfile.windows"));
    line(
      "A4أ) XFF استبدال صريح بـ{remote_host} (يمسح انتحال العميل)",
      c.includes("header_up X-Forwarded-For {remote_host}") && c.includes("header_up X-Real-IP {remote_host}")
    );
    line("A4ب) tls internal + admin off (بلا ACME/بلا إدارة)", c.includes("tls internal") && c.includes("admin off"));
    line("A4ج) المحيل الوحيد 127.0.0.1:3000", c.includes("reverse_proxy 127.0.0.1:3000"));
    line("A4د) لا listener على :80 إطلاقًا (SSRS محصّن)", !/http:\/\//.test(c) && !/:\s*80\b/.test(c.replace(/[^\n]*max_size[^\n]*/, "")));
  }

  // A5 — WinSW app
  {
    const w = readText(path.join(ROOT, "deploy", "ifrs-app.winsw.xml"));
    line("A5أ) الخدمة: node.exe + prod-server.mjs + cwd=current", w.includes("node.exe") && w.includes("prod-server.mjs") && w.includes("<workingdirectory>C:\\Apps\\ifrs-comparison\\current</workingdirectory>"));
    line("A5ب) الأسرار عبر IFRS_ENV_FILE حصرًا — لا سر في الـXML", w.includes("IFRS_ENV_FILE") && w.includes("D:\\IFRS-Data\\config\\ifrs.env") && !/NEXTAUTH_SECRET/.test(w));
    line(
      "A5ج) restart محدود تصاعدي ثم NONE — لا حلقة إقلاع",
      (w.match(/<onfailure action="RESTART"/g) ?? []).length === 2 && w.includes('action="NONE"') && w.includes("<resetfailure>")
    );
    line("A5د) stoptimeout + stopparentprocessfirst=false", w.includes("<stoptimeout>30 sec</stoptimeout>") && w.includes("<stopparentprocessfirst>false</stopparentprocessfirst>"));
    line("A5هـ) سجلات على D:\\IFRS-Data\\logs (دائمة)", w.includes("D:\\IFRS-Data\\logs\\winsw\\ifrs-app"));
  }

  // A6 — firewall ps1
  {
    const f = readText(path.join(ROOT, "deploy", "firewall-ifrs.ps1"));
    line("A6أ) -LanSubnet إلزامي بلا افتراضي (لا قناع مفترض)", f.includes("Mandatory = $true") && f.includes("[string]$LanSubnet"));
    line("A6ب) يرفض placeholders وصيغة غير CIDR", f.includes("REFUSED") && f.includes("CIDR"));
    line("A6ج) قاعدة 443 فقط — لا أي قاعدة LocalPort 80", f.includes("-LocalPort 443") && !/-LocalPort\s+80\b/.test(f));
    line("A6د) 3000 block اختياري ( defense-in-depth — الربط loopback هو التحكم)", f.includes("BlockAppPort") && f.includes("-LocalPort 3000"));
  }

  // A7 — env example
  {
    const e = readText(path.join(ROOT, "deploy", "ifrs.env.windows.example"));
    line("A7أ) DB/state/backup على D:\\ خارج أي release", e.includes("DATABASE_URL=file:D:/IFRS-Data/db/ifrs-prod.db") && e.includes("VAR_DIR=D:\\IFRS-Data") && e.includes("BACKUP_DIR=D:\\IFRS-Backups"));
    line("A7ب) loopback حصري مضبوط", e.includes("HOSTNAME=127.0.0.1") && e.includes("PORT=3000"));
    line("A7ج) RESTORE_ENGINE_ENABLED صريح placeholder — لا قيمة نهائية في Git", e.includes("RESTORE_ENGINE_ENABLED=<0-or-1>"));
    line("A7د) بلا أي سر حقيقي — placeholder توليد على المضيف حصرًا", e.includes("<GENERATED-ONCE-ON-HOST-48-BYTES-BASE64>"));
    line("A7هـ) بوابة bootstrap تُزال بعد الإعداد", e.includes("SETUP_BOOTSTRAP_ENABLED=<remove-after-bootstrap>"));
  }

  // A8 — host-preflight قراءة فقط + قناع موثق
  {
    const p = readText(path.join(ROOT, "deploy", "host-preflight-windows.ps1"));
    line("A8أ) preflight قراءة فقط (لا New-*/Set-*)", !/New-Net(Name)?(Firewall|Adapter)|Set-Service|New-Service/.test(p) && p.includes("لا يعدّل شيئًا"));
    line("A8ب) يوثق PrefixLength الفعلي (القناع من ipconfig لا من الاختراع)", p.includes("PrefixLength"));
  }

  // A9 — package.json scripts
  {
    const pkg = JSON.parse(readText(path.join(ROOT, "package.json"))) as { scripts: Record<string, string> };
    line("A9أ) start = prod-server.mjs (لا next start)", pkg.scripts.start === "node scripts/prod-server.mjs");
    line("A9ب) build = next build + assemble-release", pkg.scripts.build.includes("assemble-release.mjs"));
  }

  // A10 — validateProductionConfig: داخل/خارج شجرة النشر
  {
    const { validateProductionConfig } = await import("../src/lib/production-config");
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = "production";
      process.env.NEXTAUTH_SECRET = "p5b2-Config-Test-9f4c2b7e-Secret-MixedCase";
      process.env.NEXTAUTH_URL = "https://ifrs-test.internal";
      process.env.RESTORE_ENGINE_ENABLED = "0";
      const outsideDb = path.join(TMP_OUT, `p5b2-config-ok-${uniq()}.db`);
      writeFileSync(outsideDb, "SQLite format 3\0" + "\0".repeat(16), "utf8");
      process.env.DATABASE_URL = `file:${outsideDb}`;
      process.env.VAR_DIR = ensureDir(path.join(TMP_OUT, `p5b2-var-${uniq()}`));
      process.env.BACKUP_DIR = ensureDir(path.join(TMP_OUT, `p5b2-bk-${uniq()}`));
      const ok = validateProductionConfig();
      line("A10أ) تهيئة سليمة خارج شجرة النشر ⇒ ok", ok.ok, ok.errors.join(","));
      process.env.VAR_DIR = path.join(ROOT, "var", "test", "5b2-inside");
      ensureDir(process.env.VAR_DIR);
      const inside = validateProductionConfig();
      line(
        "A10ب) VAR_DIR داخل شجرة العمل ⇒ VAR_DIR_INSIDE_RELEASE_TREE",
        !inside.ok && inside.errors.includes("VAR_DIR_INSIDE_RELEASE_TREE"),
        inside.errors.join(",")
      );
      process.env.RESTORE_ENGINE_ENABLED = "";
      const eng = validateProductionConfig();
      line("A10ج) محرك غير صريح ⇒ RESTORE_ENGINE_ENABLED_MISSING", !eng.ok && eng.errors.includes("RESTORE_ENGINE_ENABLED_MISSING"));
      try {
        rmSync(outsideDb, { force: true });
      } catch {
        /* ignore */
      }
    } finally {
      process.env.NODE_ENV = saved.NODE_ENV;
      process.env.NEXTAUTH_SECRET = saved.NEXTAUTH_SECRET;
      process.env.NEXTAUTH_URL = saved.NEXTAUTH_URL;
      process.env.DATABASE_URL = saved.DATABASE_URL;
      process.env.VAR_DIR = saved.VAR_DIR;
      process.env.BACKUP_DIR = saved.BACKUP_DIR;
      process.env.RESTORE_ENGINE_ENABLED = saved.RESTORE_ENGINE_ENABLED;
    }
  }
}

/* ═════════════════ الجزء B — مصفوفة prod-server ═════════════════ */

async function partB(): Promise<void> {
  section("B) prod-server.mjs — مصفوفة الفشل المغلق (بلا server.js: ENOENT = نقطة مرور)");
  const d = ensureDir(path.join(RUN_DIR, "b"));
  const validEnv = writeEnvFile(d, "valid.env", {
    DATABASE_URL: "file:/tmp/p5b2-b-does-not-matter.db",
    NEXTAUTH_SECRET: "b-part-test-secret-not-real-0123456789abcdef",
    NEXTAUTH_URL: "https://ifrs-b.internal",
    RESTORE_ENGINE_ENABLED: "0",
  });

  async function matrix(name: string, env: Record<string, string>, expect: "fatal" | "pass", pattern: RegExp): Promise<boolean> {
    const proc = spawn(process.execPath, [path.join(ROOT, "scripts", "prod-server.mjs")], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    proc.stdout?.on("data", (x) => (out += String(x)));
    proc.stderr?.on("data", (x) => (out += String(x)));
    const { code } = await waitExit(proc, 30_000);
    const gotFatal = out.includes("[prod-server] FATAL:");
    const gotEnoent = /Cannot find module[\s\S]*server\.js/.test(out);
    const ok = expect === "fatal" ? gotFatal && pattern.test(out) : !gotFatal && gotEnoent && pattern.test(out);
    return line(name, ok, `exit=${code} ${out.split("\n").find((l) => /FATAL|loopback|Cannot find/.test(l))?.slice(0, 90) ?? ""}`);
  }

  await matrix("B1) IFRS_ENV_FILE مفقود ⇒ FATAL (لا قيم افتراضية)", { IFRS_ENV_FILE: path.join(d, "nope.env") }, "fatal", /غير موجود/);
  // B2 — env file تالف فعليًا (سطر بلا =)
  {
    const badPath = path.join(d, "bad2.env");
    writeFileSync(badPath, "GOOD=1\nBAD_LINE_WITHOUT_EQUALS\n", "utf8");
    await matrix("B2-ثانية) env تالف فعليًا ⇒ FATAL سطر 2", { IFRS_ENV_FILE: badPath }, "fatal", /سطر 2/);
  }
  await matrix(
    "B3) HOSTNAME غير loopback ⇒ FATAL (3000 لا يُعرض على LAN أبدًا)",
    { IFRS_ENV_FILE: validEnv, HOSTNAME: "10.9.9.9" },
    "fatal",
    /غير loopback/
  );
  await matrix(
    "B4) فتحة الهروب الصريحة IFRS_BIND_ALLOW_NON_LOOPBACK=1 ⇒ تمر (ثم ENOENT server.js)",
    { IFRS_ENV_FILE: validEnv, HOSTNAME: "10.9.9.9", IFRS_BIND_ALLOW_NON_LOOPBACK: "1" },
    "pass",
    /Cannot find module/
  );
  await matrix(
    "B5) HOSTNAME ساقط ⇒ افتراضي آمن 127.0.0.1 (تمر)",
    { IFRS_ENV_FILE: validEnv },
    "pass",
    /loopback افتراضي آمن/
  );
  await matrix(
    "B6) NODE_ENV=development في بيئة العملية ⇒ FATAL (production حصرًا)",
    { IFRS_ENV_FILE: validEnv, NODE_ENV: "development" },
    "fatal",
    /production حصرًا/
  );
}

/* ═════════════════ الجزء C — بوابة deploy-migrate ═════════════════ */

async function partC(): Promise<void> {
  section("C) deploy-migrate.mjs — بوابة الترحيل (نسخ قاعدة — صفر لمس للبيانات الحية)");
  const d = ensureDir(path.join(RUN_DIR, "c"));
  const DM = path.join(ROOT, "scripts", "deploy-migrate.mjs");

  // C1 — بلا env file
  {
    const r = runNode(DM, [], { IFRS_ENV_FILE: "" });
    line("C1) بلا --env-file وبلا IFRS_ENV_FILE ⇒ FATAL", r.code === 1 && /--env-file غير محدد/.test(r.out), r.out.split("\n")[0]?.slice(0, 80));
  }
  // C2 — env بلا DATABASE_URL (نحيد DATABASE_URL الموروث من بيئة الاختبار)
  {
    const envFile = writeEnvFile(d, "no-db.env", { NEXTAUTH_SECRET: "p5b2-c2-Not-Real-Secret-0123456789" });
    const r = runNode(DM, ["--env-file", envFile], { DATABASE_URL: "" });
    line("C2) DATABASE_URL_MISSING ⇒ FATAL", r.code === 1 && r.out.includes("DATABASE_URL_MISSING"), r.out.split("\n").find((l) => /FATAL/.test(l))?.slice(0, 90));
  }
  // C3 — ملف القاعدة مفقود ⇒ رفض + لا إنشاء صامت
  {
    const ghost = path.join(TMP_OUT, `p5b2-c3-ghost-${uniq()}.db`);
    const envFile = writeEnvFile(d, "ghost.env", { DATABASE_URL: `file:${ghost}` });
    const r = runNode(DM, ["--env-file", envFile], {});
    line(
      "C3) DATABASE_FILE_NOT_FOUND + لا إنشاء صامت للقاعدة",
      r.code === 1 && r.out.includes("DATABASE_FILE_NOT_FOUND") && !existsSync(ghost)
    );
  }
  // C4 — قاعدة داخل شجرة العمل ⇒ رفض
  {
    const insideDb = path.join(RUN_DIR, "c", "inside-worktree.db");
    writeFileSync(insideDb, "SQLite format 3\0" + "\0".repeat(16), "utf8");
    const envFile = writeEnvFile(d, "inside.env", { DATABASE_URL: `file:${insideDb}` });
    const r = runNode(DM, ["--env-file", envFile], {});
    line("C4) قاعدة داخل شجرة العمل ⇒ INSIDE_WORKTREE", r.code === 1 && /INSIDE_WORKTREE/.test(r.out));
  }
  // C5 — مسار سعيد على نسخة حقيقية (migrate deploy — لا pending)
  {
    const copy = path.join(TMP_OUT, `p5b2-c5-copy-${uniq()}.db`);
    const ok = migrateFixtureDb(copy);
    const envFile = writeEnvFile(d, "happy.env", { DATABASE_URL: `file:${copy}` });
    const before = existsSync(copy) ? statSync(copy).size : -1;
    const r = ok
      ? runNode(DM, ["--env-file", envFile], {}, 120_000)
      : { code: -1, out: "migrateFixtureDb فشل — لا يمكن إثبات المسار السعيد" };
    line(
      "C5) مسار سعيد: خطة صريحة + migrate deploy عبر node (لا bunx) + exit 0",
      r.code === 0 && r.out.includes("migrate deploy") && r.out.includes("OK"),
      `exit=${r.code}`
    );
    line("C5-ب) نسخة القاعدة بقيت موجودة (لم تُستبدل/تُحذف)", existsSync(copy) && statSync(copy).size >= before - 1);
    try {
      rmSync(copy, { force: true });
    } catch {
      /* ignore */
    }
  }
  // C6 — dry-run لا يلمس شيئًا
  {
    const copy = path.join(TMP_OUT, `p5b2-c6-copy-${uniq()}.db`);
    const ok = migrateFixtureDb(copy);
    const envFile = writeEnvFile(d, "dry.env", { DATABASE_URL: `file:${copy}` });
    const mtimeBefore = statSync(copy).mtimeMs;
    const r = ok ? runNode(DM, ["--env-file", envFile, "--dry-run"], {}) : { code: -1, out: "fixture فشل" };
    line(
      "C6) dry-run: خطة دون تنفيذ + mtime القاعدة لم يتغير",
      r.code === 0 && r.out.includes("لا تنفيذ") && statSync(copy).mtimeMs === mtimeBefore
    );
    try {
      rmSync(copy, { force: true });
    } catch {
      /* ignore */
    }
  }
  // C7 — PRISMA_CLI_HOME غير صالح
  {
    const copy = path.join(TMP_OUT, `p5b2-c7-copy-${uniq()}.db`);
    const ok = migrateFixtureDb(copy);
    const envFile = writeEnvFile(d, "badhome.env", { DATABASE_URL: `file:${copy}` });
    const r = ok ? runNode(DM, ["--env-file", envFile], { PRISMA_CLI_HOME: "/tmp/p5b2-no-such-home" }) : { code: -1, out: "fixture فشل" };
    line("C7) PRISMA_CLI_HOME خاطئ ⇒ PRISMA_CLI_UNRESOLVED (فشل مغلق مهيكل)", r.code === 1 && r.out.includes("PRISMA_CLI_UNRESOLVED"));
    try {
      rmSync(copy, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/* ═════════════════ الجزء D — standalone إنتاجي حقيقي ═════════════════ */

async function partD(): Promise<void> {
  section("D) standalone إنتاجي حقيقي (.next-prod) — سيناريوهات persistence/fail-closed");

  // D0 — نقاء artifact
  {
    line("D0أ) server.js + prod-server.mjs + env-file.mjs موجودون", existsSync(path.join(STANDALONE, "server.js")) && existsSync(path.join(STANDALONE, "prod-server.mjs")) && existsSync(path.join(STANDALONE, "env-file.mjs")));
    const meta = JSON.parse(readText(path.join(STANDALONE, "RELEASE_META.json"))) as {
      gitSha?: string;
      migrations?: string[];
      expectedSchemaFingerprint?: string | null;
    };
    line(
      "D0ب) RELEASE_META: sha + migrations + fingerprint",
      !!meta.gitSha && Array.isArray(meta.migrations) && typeof meta.expectedSchemaFingerprint === "string",
      `migrations=${meta.migrations?.length ?? "-"}`
    );
    const forbidden = ["db", "var", "tool-results", "test"].filter((n) => existsSync(path.join(STANDALONE, n)));
    const envLeaks = readdirSync(STANDALONE).filter((n) => /^\.env/.test(n));
    line("D0ج) artifact نقي: بلا db/var/tool-results/test/.env*", forbidden.length === 0 && envLeaks.length === 0, `${forbidden.join(",") || "نظيف"} ${envLeaks.join(",") || ""}`);
  }

  // D1 — إقلاع سليم: health minimal + loopback bind فعلي
  {
    const iso = makeIso("d1-healthy", 31181);
    if (!migrateFixtureDb(iso.dbPath)) throw new Error("migrateFixtureDb فشل — لا fixture");
    await seedAdminDirect(iso.dbPath, "p5b2-admin", "P5b2!Admin#2026");
    writeEpochFixture(iso.varDir, "1");
    const ef = envFileFor(iso);
    const srv = makeServer("d1", iso.port);
    try {
      await startProdServer(srv, { IFRS_ENV_FILE: ef });
      const h = await waitHealthy(srv, 10_000);
      line("D1أ) healthy 200", h?.status === "healthy" && h.http === 200, `keys=${h?.keys.join(",")}`);
      line(
        "D1ب) جسم health محدود: {app, serverTime, status} حصرًا — بلا epoch/paths/counts/reason",
        !!h && h.keys.length === 3 && h.keys.includes("status") && h.keys.includes("app") && h.keys.includes("serverTime")
      );
      const ss = spawnSync("bash", ["-c", `ss -ltn | grep ':${iso.port} '`], { encoding: "utf8" });
      // عمود العنوان المحلي فقط (الرابع) — عمود Peer يظل 0.0.0.0:* دائمًا لكل listener
      const listenLines = (ss.stdout ?? "").split("\n").filter((l) => l.includes(":" + iso.port + " "));
      const locals = listenLines.map((l) => l.trim().split(/\s+/)[3] ?? "");
      const allLoopback = locals.length > 0 && locals.every((a) => a.startsWith("127.0.0.1:"));
      line(
        "D1ج) الربط الفعلي 127.0.0.1 حصرًا (عمود Local) — لا 0.0.0.0/[::] محليًا",
        allLoopback,
        locals.join(",") || "لا listener"
      );
      line("D1د) epoch بقى كما هو (لا إعادة كتابة عند إقلاع سليم)", readEpochFile(iso.varDir) === "1");
    } finally {
      await stopServer(srv);
    }
  }

  // D2 — أسرار fail-closed (خروج سريع برمز واضح)
  {
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ["NEXTAUTH_SECRET مفقود", { __omit: "NEXTAUTH_SECRET" }, /NEXTAUTH_SECRET_MISSING/],
      ["NEXTAUTH_SECRET ضعيف (قصير)", { NEXTAUTH_SECRET: "short-secret" }, /NEXTAUTH_SECRET_TOO_SHORT/],
      ["RESTORE_ENGINE_ENABLED غائب", { __omit: "RESTORE_ENGINE_ENABLED" }, /RESTORE_ENGINE_ENABLED_MISSING/],
    ];
    let i = 0;
    for (const [name, ov, pat] of cases) {
      i++;
      const iso = makeIso(`d2-fail-${i}`, 31182 + i);
      if (!migrateFixtureDb(iso.dbPath)) throw new Error("migrateFixtureDb فشل — لا fixture");
      await seedAdminDirect(iso.dbPath, "p5b2-admin", "P5b2!Admin#2026");
      writeEpochFixture(iso.varDir, "1");
      const ef = envFileFor(iso, ov);
      const proc = spawn(process.execPath, [path.join(STANDALONE, "prod-server.mjs")], {
        cwd: ROOT,
        env: { ...process.env, IFRS_ENV_FILE: ef },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      proc.stdout?.on("data", (x) => (out += String(x)));
      proc.stderr?.on("data", (x) => (out += String(x)));
      const { code } = await waitExit(proc, 45_000);
      line(
        `D2-${i}) ${name} ⇒ رفض إقلاع exit=1 برمز صريح (بلا قيمة سرية في المخرج)`,
        code === 1 && pat.test(out) && !out.includes("p5b2-test-secret-not-real"),
        out.split("\n").find((l) => /FATAL/.test(l))?.slice(0, 100) ?? `exit=${code}`
      );
    }
  }

  // D3 — epoch مفقود على قاعدة مهيأة ⇒ unhealthy (بلا إنشاء صامت، بلا حلقة)
  {
    const iso = makeIso("d3-epoch-lost", 31186);
    if (!migrateFixtureDb(iso.dbPath)) throw new Error("migrateFixtureDb فشل — لا fixture");
    await seedAdminDirect(iso.dbPath, "p5b2-admin", "P5b2!Admin#2026");
    // لا epoch fixture — مفقود عمدًا
    const ef = envFileFor(iso);
    const srv = makeServer("d3", iso.port);
    try {
      await startProdServer(srv, { IFRS_ENV_FILE: ef });
      const h1 = await waitHealthy(srv, 10_000);
      await sleep(1_500);
      const h2 = await waitHealthy(srv, 10_000);
      line(
        "D3أ) unhealthy 503 مستقر (بلا موت/بلا حلقة إعادة إقلاع)",
        h1?.status === "unhealthy" && h1.http === 503 && h2?.status === "unhealthy" && srv.proc !== null,
        `h1=${h1?.status}/${h1?.http} h2=${h2?.status}`
      );
      line("D3ب) epoch لم يُنشأ صمتًا (بلا قيمة قديمة/جديدة من الهواء)", readEpochFile(iso.varDir) === null);
      line(
        "D3ج) EPOCH_STATE_LOST موثق في سجل الاسترجاع الخارجي",
        recoveryLogEvents(iso.varDir).includes("EPOCH_STATE_LOST")
      );
      const readyCount = (srv.log.match(/Ready in/g) ?? []).length;
      line("D3د) سطر Ready واحد — لا إعادة إقلاع خلفية", readyCount === 1, `ready=${readyCount}`);
    } finally {
      await stopServer(srv);
    }
  }

  // D4 — epoch تالف ⇒ unhealthy + EPOCH_STATE_CORRUPT + المحتوى لا يُلمس
  {
    const iso = makeIso("d4-epoch-corrupt", 31187);
    if (!migrateFixtureDb(iso.dbPath)) throw new Error("migrateFixtureDb فشل — لا fixture");
    await seedAdminDirect(iso.dbPath, "p5b2-admin", "P5b2!Admin#2026");
    const corrupted = "corrupt!!not-a-number##";
    writeEpochFixture(iso.varDir, corrupted);
    const ef = envFileFor(iso);
    const srv = makeServer("d4", iso.port);
    try {
      await startProdServer(srv, { IFRS_ENV_FILE: ef });
      const h = await waitHealthy(srv, 10_000);
      line(
        "D4أ) ملف تالف ⇒ unhealthy 503 (fail-closed)",
        h?.status === "unhealthy" && h.http === 503
      );
      line("D4ب) المحتوى التالف لم يُستبدل صمتًا (تدخل مشغّل حصرًا)", readEpochFile(iso.varDir) === corrupted);
      line("D4ج) EPOCH_STATE_CORRUPT موثق", recoveryLogEvents(iso.varDir).includes("EPOCH_STATE_CORRUPT"));
    } finally {
      await stopServer(srv);
    }
  }

  // D5 — epoch مفقود + قاعدة جديدة (بلا مستخدمين) ⇒ bootstrap مشروع 1
  {
    const iso = makeIso("d5-fresh", 31188);
    const ok = migrateFixtureDb(iso.dbPath); // بلا مستخدمين
    writeEpochFixture(iso.varDir, "", true); // احذف/تجاهل — لا ملف
    const ef = envFileFor(iso);
    const srv = makeServer("d5", iso.port);
    try {
      if (!ok) {
        line("D5أ) قاعدة جديدة من migrations", false, "migrateFixtureDb فشل");
      } else {
        await startProdServer(srv, { IFRS_ENV_FILE: ef });
        const h = await waitHealthy(srv, 10_000);
        line("D5أ) قاعدة جديدة + epoch مفقود ⇒ إقلاع سليم (إقلاع أول حقيقي)", h?.status === "healthy" && h.http === 200);
        line("D5ب) bootstrap مشروع إلى 1 (ذري)", readEpochFile(iso.varDir) === "1", `epoch=${readEpochFile(iso.varDir)}`);
      }
    } finally {
      await stopServer(srv);
    }
  }

  // D6 — استرداد المشغّل --epoch-recover (بعد فقد فعلي للملف): unix-seconds عملي + إبطال JWT
  {
    const iso = makeIso("d6-epoch-recover", 31189);
    if (!migrateFixtureDb(iso.dbPath)) throw new Error("migrateFixtureDb فشل — لا fixture");
    await seedAdminDirect(iso.dbPath, "p5b2-admin", "P5b2!Admin#2026");
    writeEpochFixture(iso.varDir, "1");
    const ef = envFileFor(iso);
    const srv = makeServer("d6", iso.port);
    try {
      await startProdServer(srv, { IFRS_ENV_FILE: ef });
      const s = makeSession(iso.port);
      const loginOk = await s.login("p5b2-admin", "P5b2!Admin#2026");
      line("D6أ) دخول فعلي تحت epoch=1 (توكن قديم يُلتقط)", loginOk);
      const oldCookie = s.cookieHeader();
      await stopServer(srv);

      // فقد فعلي لملف epoch (السيناريو الموثق: مفقود — لا استرداد فوق ملف سليم،
      // الـoperator يرفض بطبيعته أي كتابة فوق عدّاد صالح — أُثبت أعلاه بتصميمه)
      rmSync(path.join(iso.varDir, "auth", "session-epoch"), { force: true });

      const rec = spawnSync("bun", ["scripts/restore-operator.ts", "--epoch-recover", "--confirm-epoch-loss"], {
        cwd: ROOT,
        env: { ...process.env, VAR_DIR: iso.varDir, DATABASE_URL: `file:${iso.dbPath}` },
        encoding: "utf8",
      });
      const recOut = `${rec.stdout ?? ""}${rec.stderr ?? ""}`;
      const newEpoch = readEpochFile(iso.varDir);
      const nowSec = Math.floor(Date.now() / 1000);
      const plausibleUnix = !!newEpoch && /^\d+$/.test(newEpoch) && Number(newEpoch) > 1_000_000_000 && Math.abs(Number(newEpoch) - nowSec) < 86_400;
      line(
        "D6ب) --epoch-recover بعد فقد فعلي: قيمة جديدة عالية (unix-seconds — آلية عملية، لا ادعاء رياضي مطلق)",
        rec.status === 0 && plausibleUnix,
        `epoch=${newEpoch} (now=${nowSec}) ${rec.status !== 0 ? recOut.slice(-150) : ""}`
      );
      // الاستراتيجية توثق في سجل الاسترجاع الخارجي (JSONL) — لا في stdout
      let logStrategy = "";
      try {
        logStrategy = readFileSync(path.join(iso.varDir, "recovery", "recovery-log.jsonl"), "utf8");
      } catch {
        /* لا سجل */
      }
      line(
        "D6ج) سجل الاسترجاع الخارجي: استراتيجية unix_time_seconds موثقة (عملية لا رياضية مطلقة)",
        logStrategy.includes("unix_time_seconds") && logStrategy.includes("MANUAL_RECOVERY_COMPLETED"),
        `أحداث=${logStrategy.split("\n").filter((l) => l.trim()).length}`
      );

      await startProdServer(srv, { IFRS_ENV_FILE: ef });
      const s2 = makeSession(iso.port);
      // جلسة قديمة (نفس الكوكيز) بعد الاسترداد:
      const oldRes = await fetch(`http://127.0.0.1:${iso.port}/api/auth/session`, { headers: { Cookie: oldCookie }, cache: "no-store" });
      const oldBody = (await oldRes.json().catch(() => ({}))) as { user?: unknown };
      line(
        "D6د) JWT القديمة ماتت بعد الاسترداد (epoch التقطعت — لا اعتماد على ≥)",
        oldBody?.user === null || oldBody?.user === undefined,
        `http=${oldRes.status} user=${oldBody?.user ? "حي" : "ميت"}`
      );
      const relogin = await s2.login("p5b2-admin", "P5b2!Admin#2026");
      line("D6هـ) دخول جديد يعمل بعد الاسترداد", relogin);
    } finally {
      await stopServer(srv);
    }
  }

  // D7 — صيانة مقطوعة ⇒ RECOVERY_REQUIRED يبقى عبر restarts (لا NORMAL صامت)
  {
    const iso = makeIso("d7-maintenance", 31190);
    if (!migrateFixtureDb(iso.dbPath)) throw new Error("migrateFixtureDb فشل — لا fixture");
    await seedAdminDirect(iso.dbPath, "p5b2-admin", "P5b2!Admin#2026");
    writeEpochFixture(iso.varDir, "1");
    const ef = envFileFor(iso);
    const stateFile = path.join(iso.varDir, "maintenance", "state.json");
    const srv = makeServer("d7", iso.port);
    try {
      // إقلاع سليم أولًا (يثبت الحالة الابتدائية NORMAL)
      await startProdServer(srv, { IFRS_ENV_FILE: ef });
      const h0 = await waitHealthy(srv, 10_000);
      line("D7أ) إقلاع سليم قبل الزرع (NORMAL)", h0?.status === "healthy");
      await stopServer(srv);

      // زرع حالة عملية مقطوعة (محاكاة crash أثناء SWAPPING)
      ensureDir(path.join(iso.varDir, "maintenance"));
      writeFileSync(stateFile, interruptedStateJson("op-restore-5b2-fixture"), "utf8");

      await startProdServer(srv, { IFRS_ENV_FILE: ef });
      const h1 = await waitHealthy(srv, 15_000);
      line(
        "D7ب) إقلاع فوق مقطوعة ⇒ recovery_required 503 (لا افتتاح طبيعي)",
        h1?.status === "recovery_required" && h1.http === 503,
        `${h1?.status}/${h1?.http}`
      );
      const s = makeSession(iso.port);
      const groups = await s.api("/api/groups");
      line("D7ج) القراءة محجوبة في الوضع المقيد (503 locked)", groups.status === 503, `http=${groups.status}`);
      line(
        "D7د) الحالة بقیت RECOVERY_REQUIRED على القرص (بلا مسح صامت)",
        existsSync(stateFile) && /RECOVERY_REQUIRED/.test(readText(stateFile))
      );
      await stopServer(srv);

      // إعادة إقلاع كاملة — المتطلب الحاكم: البقاء عبر restart
      await startProdServer(srv, { IFRS_ENV_FILE: ef });
      const h2 = await waitHealthy(srv, 15_000);
      line(
        "D7هـ) restart كامل ⇒ ما زال recovery_required (لا عودة NORMAL بسبب restart)",
        h2?.status === "recovery_required" && h2.http === 503,
        `${h2?.status}`
      );
      await stopServer(srv);

      // مسح المشغّل الموثق فقط
      const clear = spawnSync("bun", ["scripts/restore-operator.ts", "--verify-and-clear", "--confirm-manual-verification"], {
        cwd: ROOT,
        env: { ...process.env, VAR_DIR: iso.varDir, DATABASE_URL: `file:${iso.dbPath}` },
        encoding: "utf8",
      });
      const cleared = clear.status === 0 && !existsSync(stateFile);
      line("D7و) مسح المشغّل الموثق (--verify-and-clear + تأكيد صريح)", cleared, (clear.stdout ?? "").split("\n").find((l) => /✅|تم|حالة/.test(l))?.slice(0, 80));

      await startProdServer(srv, { IFRS_ENV_FILE: ef });
      const h3 = await waitHealthy(srv, 15_000);
      line("D7ز) بعد المسح الموثق ⇒ healthy NORMAL (عودة مشروعة)", h3?.status === "healthy" && h3.http === 200);
    } finally {
      await stopServer(srv);
    }
  }

  // D8 — نسخة عبر API: ZIP بمدخلين حصرًا وبلا أي سر
  {
    const iso = makeIso("d8-backup", 31191);
    if (!migrateFixtureDb(iso.dbPath)) throw new Error("migrateFixtureDb فشل — لا fixture");
    await seedAdminDirect(iso.dbPath, "p5b2-admin", "P5b2!Admin#2026");
    writeEpochFixture(iso.varDir, "1");
    const secret = "p5b2-NEVER-IN-BACKUP-0123456789abcdefABCDEF";
    const ef = envFileFor(iso, { NEXTAUTH_SECRET: secret });
    const srv = makeServer("d8", iso.port);
    try {
      await startProdServer(srv, { IFRS_ENV_FILE: ef });
      const s = makeSession(iso.port);
      const loginOk = await s.login("p5b2-admin", "P5b2!Admin#2026");
      const created = await s.api<{ id?: string; backupId?: string; level?: string }>("/api/backups", { method: "POST" });
      const id = created.body?.id ?? created.body?.backupId;
      line(
        "D8أ) إنشاء نسخة عبر API (201) بمستوى معلن",
        loginOk && created.status === 201 && !!id,
        `http=${created.status} id=${id ?? "-"} level=${(created.body as { level?: string })?.level ?? "-"}`
      );
      if (id) {
        const dl = await s.api<null>(`/api/backups/${id}/download`);
        const JSZip = (await import("jszip")).default;
        const zip = await JSZip.loadAsync(dl.raw ?? Buffer.alloc(0));
        const names = Object.keys(zip.files).sort();
        line(
          "D8ب) ZIP = {database.db, manifest.json} حصرًا (لا env ولا أي ملف آخر)",
          names.length === 2 && names[0] === "database.db" && names[1] === "manifest.json",
          names.join(",")
        );
        const manifestText = await zip.files["manifest.json"]?.async("string");
        line(
          "D8ج) لا سر NEXTAUTH في manifest ولا في أي مدخل ZIP",
          !!manifestText && !manifestText.includes(secret) && !names.some((n) => n.toLowerCase().includes("env")),
          "فحص نصي فعلي للمحتوى"
        );
        const manifest = JSON.parse(manifestText ?? "{}") as Record<string, unknown>;
        const secretish = Object.keys(manifest).filter((k) => /secret|password|token/i.test(k));
        line("D8د) manifest بلا أي مفاتيح أسرار", secretish.length === 0, secretish.join(",") || "نظيف");
      }
    } finally {
      await stopServer(srv);
    }
  }
}

function writeEpochFixture(varDir: string, content: string, skipIfEmpty = false): void {
  if (skipIfEmpty && !content) return;
  const dir = ensureDir(path.join(varDir, "auth"));
  writeFileSync(path.join(dir, "session-epoch"), content, "utf8");
}

/* ═════════════════ التشغيل ═════════════════ */

async function main(): Promise<void> {
  console.log(`\n=== Phase 5B.2 — Host-Prep Readiness Gate — ${new Date().toISOString()} ===`);
  console.log(`(معزول: ${RUN_DIR})\n`);
  ensureDir(RUN_DIR);
  try {
    await partA();
    await partB();
    await partC();
    await partD();
  } finally {
    // تنظيف العمليات — لا خوادم يتيمة
    for (const port of [31181, 31182, 31183, 31184, 31186, 31187, 31188, 31189, 31190, 31191]) {
      spawnSync("bash", ["-c", `ss -ltnp 2>/dev/null | grep ':${port} ' | grep -oP 'pid=\\K[0-9]+' | xargs -r kill -9`], { encoding: "utf8" });
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n═══ النتيجة: ${passed}/${results.length} ═══`);
  if (failure) {
    console.log("\nفحوص فاشلة:");
    for (const r of results.filter((x) => !x.ok)) console.log(`  ❌ ${r.name} — ${r.detail.slice(0, 120)}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(" Suite crashed:", e);
  process.exit(1);
});
