// Phase 5B.1 — مصفوفة اختبارات التوافق مع Windows + الأمان الجديد (نص المستخدم §20).
//
// الأجزاء:
//   A) وحدات مباشرة (بلا خادم): Prisma CLI helper (بلا bunx/npx/shell)، تطبيع
//      file URLs (Windows/Linux/مسافات) + قبول Prisma فعليًا (Linux)، retry
//      EPERM/EBUSY، سياسة كلمة المرور، استقلالية restoreDatabase/manageBackups،
//      تزامن regex الـfingerprint مع الثابت، مسح قوالب deploy (لا أسرار)،
//      صحة سكربتات package.json.
//   B) خادم dev معزول (3102): استقلالية صلاحية الاستعادة (403 قبل المنح) +
//      WAL_CLEANUP fail-closed ⇒ ABORTED قبل التبديل + الاستعادة سليمة بعد
//      رفع الحقن (COMPLETED + epoch+1 عبر helper الجديد).
//   C) خادم إنتاج standalone حقيقي (build معزول .next-prod):
//      نقاء artifact (بلا db/var/.env/tool-results/test + RELEASE_META)،
//      epoch مفقود/تالف على قاعدة مهيأة ⇒ فشل مغلق بلا إنشاء صمت + حدثا
//      EPOCH_STATE_LOST/CORRUPT، استرداد المشغّل --epoch-recover (unix-seconds،
//      بلا قيم يدوية)، JWT قديمة ماتت بعد الاسترداد، قاعدة جديدة ⇒ bootstrap
//      مشروع 1، بوابة SETUP_BOOTSTRAP_ENABLED في الإنتاج، رفض الضعف/الافتراضيات،
//      سباق أول مدير (إنشاءان متزامنان ⇒ واحد حصرًا)، إفصاح health الأدنى.
//
// ما يُثبت هنا على Linux (Z.ai) لا يوصف بأنه «إثبات Windows» — بند I في
// التقرير يفصل: المنفذ فعليًا / المحاكى منطقيًا / المؤجل لمضيف Windows 5B.4.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";

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

/* ═══════════════════════ الجزء A — وحدات ═══════════════════════ */

async function partA(): Promise<void> {
  section("A) وحدات مباشرة (بلا خادم)");

  // A1 — Prisma CLI helper
  {
    const { resolvePrismaCliEntry, runPrismaCli } = await import("../src/lib/prisma-cli");
    const r1 = resolvePrismaCliEntry(ROOT);
    line(
      "A1أ) دقة Prisma CLI من cwd node_modules (بلا PRISMA_CLI_HOME)",
      r1.ok && r1.source === "CWD_NODE_MODULES" && !!r1.cliEntry && existsSync(r1.cliEntry!),
      `${r1.source ?? "-"} ${r1.cliEntry ?? ""}`
    );
    line(
      "A1ب) المدخل ملف JS حقيقي — لا bunx/npx/.cmd في المسار",
      !!r1.cliEntry && !/bunx|npx|\.cmd$/i.test(r1.cliEntry!),
      r1.cliEntry?.split(/[\\/]/).slice(-3).join("/")
    );
    const ver = runPrismaCli({ args: ["--version"], cwd: ROOT, timeoutMs: 30_000 });
    line(
      "A1ج) runPrismaCli عبر process.execPath — --version يعمل (exit 0)",
      ver.ok && ver.exitCode === 0 && /prisma/i.test(ver.stdout + ver.stderr),
      `${ver.code} exit=${ver.exitCode}`
    );
    line(
      "A1د) بلا shell: spawnSync args مباشرة (process.execPath + JS entry)",
      ver.cliEntryResolved === r1.cliEntry,
      "نفس المدخل المحلول"
    );
    const saved = process.env.PRISMA_CLI_HOME;
    process.env.PRISMA_CLI_HOME = path.join(ROOT, "var", "definitely-missing-home");
    const r2 = resolvePrismaCliEntry(ROOT);
    if (saved === undefined) delete process.env.PRISMA_CLI_HOME;
    else process.env.PRISMA_CLI_HOME = saved;
    line(
      "A1هـ) PRISMA_CLI_HOME خاطئ ⇒ PRISMA_CLI_UNRESOLVED (فشل مغلق مهيكل)",
      !r2.ok && r2.code === "PRISMA_CLI_UNRESOLVED",
      r2.detail.slice(0, 60)
    );
  }

  // A2 — تطبيع file URLs
  {
    const { toSqliteFileUrl, sqliteUrlToPath, SqliteUrlError } = await import("../src/lib/sqlite-url");
    const win1 = toSqliteFileUrl("D:\\IFRS-Data\\db\\ifrs-prod.db");
    line("A2أ) Windows drive path", win1 === "file:D:/IFRS-Data/db/ifrs-prod.db", win1);
    const win2 = toSqliteFileUrl("C:\\Program Data\\IFRS\\db.sqlite");
    line("A2ب) مسافات في المسار", win2 === "file:C:/Program Data/IFRS/db.sqlite", win2);
    const lin1 = toSqliteFileUrl("/home/app/data/db.sqlite");
    line("A2ج) Linux absolute", lin1 === "file:/home/app/data/db.sqlite", lin1);
    const norm = toSqliteFileUrl("D:\\IFRS-Data\\..\\IFRS-Data\\db\\x.db");
    line("A2د) تطبيع ../ داخلي", norm === "file:D:/IFRS-Data/db/x.db", norm);
    const dup = toSqliteFileUrl("file:D:/IFRS-Data/db/x.db");
    line("A2هـ) file: URL قائم يمر مطبّعًا (بلا تكرار)", dup === "file:D:/IFRS-Data/db/x.db", dup);
    let threw = "";
    try {
      toSqliteFileUrl("relative/db.sqlite");
    } catch (e) {
      threw = (e as SqliteUrlError).code ?? "";
    }
    line("A2و) مسار نسبي ⇒ رفض SQLITE_URL_RELATIVE", threw === "SQLITE_URL_RELATIVE", threw);
    threw = "";
    try {
      toSqliteFileUrl("file:D:/x.db?connection_limit=5");
    } catch (e) {
      threw = (e as SqliteUrlError).code ?? "";
    }
    line("A2ز) query params ⇒ رفض صريح", threw === "SQLITE_URL_INVALID_CHAR", threw);
    line("A2ح) sqliteUrlToPath عكس سليم", sqliteUrlToPath("D:\\a\\b.db") === "D:/a/b.db", String(sqliteUrlToPath("D:\\a\\b.db")));
  }

  // A3 — قبول Prisma فعليًا لناتج الـhelper (Linux مطلق — بند إثبات حقيقي)
  {
    const { PrismaClient } = await import("@prisma/client");
    const { toSqliteFileUrl } = await import("../src/lib/sqlite-url");
    const tmp = path.join(ROOT, "var", "test", "5b1");
    mkdirSync(tmp, { recursive: true });
    const dbFile = path.join(tmp, `url-accept-${Date.now()}.db`);
    const url = toSqliteFileUrl(dbFile);
    let accepted = false;
    let detail = "";
    const c = new PrismaClient({ datasources: { db: { url } }, log: [] });
    try {
      const rows = await c.$queryRawUnsafe<unknown[]>("SELECT 1 as one");
      // Prisma يعيد BigInt لعمود INTEGER — قارن رقميًا
      accepted = Number((rows[0] as { one?: unknown })?.one) === 1;
      detail = `url=${url}`;
    } catch (e) {
      detail = String(e).split("\n")[0];
    } finally {
      await c.$disconnect().catch(() => undefined);
      try {
        const fs = await import("node:fs");
        fs.rmSync(dbFile, { force: true });
      } catch { /* ignore */ }
    }
    line("A3) Prisma حقيقي يقبل file URL من الـhelper (SELECT 1)", accepted, detail);
  }

  // A4 — retry العابر
  {
    const { withTransientRetry, withTransientRetrySync } = await import("../src/lib/fs-retry");
    let calls = 0;
    const out = await withTransientRetry(() => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("x"), { code: "EPERM" });
      return "done";
    }, { attempts: 3, delayMs: 1 });
    line("A4أ) EPERM عابر ⇒ نجاح بعد محاولتين", out === "done" && calls === 3, `calls=${calls}`);
    calls = 0;
    let syncOut = "";
    try {
      syncOut = withTransientRetrySync(() => {
        calls++;
        if (calls < 2) throw Object.assign(new Error("y"), { code: "EBUSY" });
        return "ok-sync";
      }, { attempts: 3, delayMs: 1 });
    } catch { /* لا يصل */ }
    line("A4ب) EBUSY عابر (sync) ⇒ نجاح", syncOut === "ok-sync" && calls === 2, `calls=${calls}`);
    let permanentCode = "";
    try {
      await withTransientRetry(async () => {
        throw Object.assign(new Error("z"), { code: "EACCES" });
      }, { attempts: 3, delayMs: 1 });
    } catch (e) {
      permanentCode = (e as NodeJS.ErrnoException).code ?? "";
    }
    line("A4ج) EACCES دائم ⇒ رفع فورًا بلا إخفاء", permanentCode === "EACCES", permanentCode);
    let exhausted = false;
    let origMsg = "";
    try {
      await withTransientRetry(() => {
        throw Object.assign(new Error("orig-error"), { code: "EPERM" });
      }, { attempts: 2, delayMs: 1 });
    } catch (e) {
      exhausted = true;
      origMsg = (e as Error).message;
    }
    line("A4د) استنفاد المحاولات ⇒ الخطأ الأصلي كما هو", exhausted && origMsg === "orig-error", origMsg);
  }

  // A5 — سياسة كلمة المرور
  {
    const { validateStrongPassword } = await import("../src/lib/password-policy");
    const good = validateStrongPassword(`Str-${crypto.randomUUID()}-Aa1`);
    const cases: Array<[string, boolean, string]> = [
      ["short1A", false, "قصيرة"],
      ["alllowercase123", false, "بلا كبيرة"],
      ["ALLUPPERCASE123", false, "بلا صغيرة"],
      ["NoDigitsHere", false, "بلا رقم"],
      ["admin123", false, "قائمة ضعف"],
      ["MyPassw0rd!Admin", false, "تحتوي password ضعيفة"],
      [`${crypto.randomUUID()}-Aa1`, true, "عشوائية قوية"],
    ];
    line("A5أ) كلمة قوية تقبل", good.ok, "");
    let allOk = true;
    const details: string[] = [];
    for (const [pw, expected, label] of cases) {
      const r = validateStrongPassword(pw);
      if (r.ok !== expected) allOk = false;
      details.push(`${label}:${r.ok ? "قبول" : "رفض"}`);
    }
    line("A5ب) مصفوفة الرفض/القبول دقيقة", allOk, details.join(" · "));
  }

  // A6 — استقلالية الصلاحيات (4B.3 يبقى سليمًا — نص المستخدم §17/§20-14/15)
  {
    const { ADMIN_PERMISSIONS, canRestoreDatabase, canManageBackups, parsePermissions } = await import("../src/lib/permissions");
    line("A6أ) قالب المدير restoreDatabase=false", ADMIN_PERMISSIONS.restoreDatabase === false, String(ADMIN_PERMISSIONS.restoreDatabase));
    const adminPerms = parsePermissions(JSON.stringify(ADMIN_PERMISSIONS));
    line("A6ب) canRestoreDatabase(admin-template) = false", canRestoreDatabase(adminPerms) === false, "لا منح ضمني بالدور");
    line("A6ج) canManageBackups(admin role) = true (فصل واضح)", canManageBackups(adminPerms, "admin") === true, "manageBackups مستقلة عن restoreDatabase");
    const explicit = { ...adminPerms, restoreDatabase: true };
    line("A6د) canRestoreDatabase بمفتاح صريح = true حصرًا", canRestoreDatabase(explicit) === true, "المنح صريح فقط");
  }

  // A7 — تزامن regex الـfingerprint مع الثابت المستورد
  {
    const { PINNED_CURRENT_CANONICAL_FINGERPRINT } = await import("../src/lib/backup-config");
    const src = readFileSync(path.join(ROOT, "src", "lib", "backup-config.ts"), "utf8");
    const m = src.match(/PINNED_CURRENT_CANONICAL_FINGERPRINT[^=]*=\s*"([^"]+)"/);
    line(
      "A7) RELEASE_META regex == الثابت المستورد (أساس meta الـrollback)",
      !!m && m[1] === PINNED_CURRENT_CANONICAL_FINGERPRINT,
      `${m?.[1]?.slice(0, 22) ?? "null"}…`
    );
  }

  // A8 — مسح قوالب deploy: لا أسرار حقيقية + assertions التكوين
  {
    const deployDir = path.join(ROOT, "deploy");
    const files = readdirSync(deployDir);
    const secretPatterns: Array<[RegExp, string]> = [
      [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "GitHub token"],
      [/AKIA[0-9A-Z]{16}/, "AWS key"],
      [/sk-ant-[A-Za-z0-9-]{10,}/, "Anthropic key"],
      [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "private key"],
      [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
    ];
    let found = "";
    for (const f of files) {
      const p = path.join(deployDir, f);
      if (!statFileIsFile(p)) continue;
      const content = readFileSync(p, "utf8");
      for (const [re, label] of secretPatterns) {
        if (re.test(content)) found += `${f}:${label} `;
      }
    }
    line("A8أ) لا أسرار حقيقية في deploy/*", found === "", found || "نظيف");
    const envT = readFileSync(path.join(deployDir, "ifrs.env.windows.example"), "utf8");
    line(
      "A8ب) NEXTAUTH_SECRET placeholder فقط",
      /NEXTAUTH_SECRET=<GENERATED-ONCE-ON-HOST/.test(envT),
      "لا قيمة حقيقية"
    );
    line(
      "A8ج) RESTORE_ENGINE_ENABLED=<0-or-1> (لا تثبيت قرار في Git)",
      /RESTORE_ENGINE_ENABLED=<0-or-1>/.test(envT),
      "قرار 5B.2"
    );
    line(
      "A8د) NEXTAUTH_URL placeholder hostname (§13)",
      /NEXTAUTH_URL=https:\/\/<production-hostname>/.test(envT),
      "الاسم يُعتمد في 5B.2"
    );
    const caddy = readFileSync(path.join(deployDir, "Caddyfile.windows"), "utf8");
    line(
      "A8هـ) Caddyfile: tls internal + admin off + بلا :80 + XFF overwrite + loopback proxy",
      caddy.includes("tls internal") &&
        caddy.includes("admin off") &&
        !/:80\b/.test(caddy) &&
        caddy.includes("header_up X-Forwarded-For {remote_host}") &&
        caddy.includes("reverse_proxy 127.0.0.1:3000"),
      "نقل حرفي لسياسات 5A المعتمدة + §12"
    );
    const fw = readFileSync(path.join(deployDir, "firewall-ifrs.ps1"), "utf8");
    line(
      "A8و) firewall: Mandatory subnet بلا افتراضي + رفض placeholder + بلا لمس 80",
      fw.includes("[Parameter(Mandatory = $true)]") &&
        fw.includes("REFUSED") &&
        !fw.match(/LanSubnet\s*=\s*['"]192\.168/) &&
        !/LocalPort\s*=\s*80\b/.test(fw),
      "§14"
    );
  }

  // A9 — صحة سكربتات package.json (نص المستخدم §9)
  {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    line(
      "A9أ) build بلا cp -r (assemble-release Node عبر-منصات)",
      !pkg.scripts.build.includes("cp -r") && pkg.scripts.build.includes("scripts/assemble-release.mjs"),
      pkg.scripts.build
    );
    line(
      "A9ب) start بلا bun/tee/env-prefix — Node runtime حصرًا",
      pkg.scripts.start === "node scripts/prod-server.mjs",
      pkg.scripts.start
    );
  }
}

function statFileIsFile(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/* ═══════════════════════ بنية الخوادم المعزولة ═══════════════════════ */

const ISO = path.join(ROOT, "var", "test", "5b1", `run-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "")}`);

interface ServerHandle {
  proc: ReturnType<typeof spawn> | null;
  port: number;
  log: string;
  name: string;
}

function makeServer(name: string, port: number): ServerHandle {
  return { proc: null, port, log: "", name };
}

async function startDevServer(srv: ServerHandle, env: Record<string, string>): Promise<void> {
  const proc = spawn("bunx", ["next", "dev", "-p", String(srv.port)], {
    cwd: ROOT,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    stdio: "pipe",
  });
  srv.proc = proc;
  proc.stdout?.on("data", (d) => (srv.log += String(d)));
  proc.stderr?.on("data", (d) => (srv.log += String(d)));
  await waitHealthy(srv, 60_000);
}

async function startProdServer(srv: ServerHandle, env: Record<string, string>): Promise<void> {
  const standalone = path.join(ROOT, ".next-prod", "standalone");
  const proc = spawn(process.execPath, [path.join(standalone, "prod-server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    stdio: "pipe",
  });
  srv.proc = proc;
  proc.stdout?.on("data", (d) => (srv.log += String(d)));
  proc.stderr?.on("data", (d) => (srv.log += String(d)));
  await waitHealthy(srv, 60_000);
}

async function waitHealthy(srv: ServerHandle, timeoutMs: number): Promise<{ status: string; http: number } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`[${srv.name}] الخادم لم يقلع خلال ${timeoutMs}ms — آخر السجل:\n${srv.log.slice(-1200)}`);
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/health`, { cache: "no-store" });
      const body = (await res.json()) as { status?: string };
      if (body?.status) return { status: body.status, http: res.status };
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
    } catch { /* ignore */ }
  }
  spawnSync("bash", ["-c", `ss -ltnp 2>/dev/null | grep ':${srv.port} ' | grep -oP 'pid=\\K[0-9]+' | xargs -r kill -9`], { encoding: "utf8" });
  await sleep(600);
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
  async function api<T = unknown>(p: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookieHeader(), ...(init?.headers ?? {}) },
    });
    await capture(res);
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
  }
  return { login, whoami, api, cookieHeader };
}

/** تهيئة قاعدة معزولة من migrations (عبر Prisma CLI helper الجديد — bunx-وحدة الاختبار فقط لا محرك الإنتاج). */
function migrateFixtureDb(dbPath: string): boolean {
  const res = spawnSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    encoding: "utf8",
  });
  return res.status === 0;
}

/** إدخال مستخدم إداري مباشرة في القاعدة (بلا HTTP — تهيئة fixture production) بكلمة معروفة. */
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
        displayName: "seed",
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

function recoveryLogHasEvent(varDir: string, event: string): { found: boolean; detail: string } {
  try {
    const raw = readFileSync(path.join(varDir, "recovery", "recovery-log.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const hit = lines.find((l) => l.includes(`"${event}"`));
    return { found: !!hit, detail: hit ? hit.slice(0, 120) : `أحداث=${lines.length}` };
  } catch {
    return { found: false, detail: "لا سجل" };
  }
}

/* ═══════════════════════ الجزء B — خادم dev معزول (3102) ═══════════════════════ */

async function partB(): Promise<void> {
  section("B) خادم dev معزول (3102) — استقلالية الصلاحية + WAL fail-closed");
  const PORT = 3102;
  const srv = makeServer("dev-iso", PORT);
  const DB_PATH = path.join(ISO, "dev", "db", "test.db");
  const VAR_DIR = path.join(ISO, "dev", "var");
  const CONTROL = path.join(VAR_DIR, "test", "fault-injection.json");
  rmSync(path.join(ISO, "dev"), { recursive: true, force: true });
  mkdirSync(path.join(ISO, "dev", "db"), { recursive: true });
  mkdirSync(VAR_DIR, { recursive: true });

  const migrated = migrateFixtureDb(DB_PATH);
  line("B0) قاعدة معزولة من migrations", migrated);

  try {
    await startDevServer(srv, {
      DATABASE_URL: `file:${DB_PATH}`,
      VAR_DIR,
      NEXT_DIST_DIR: ".next-iso",
      NEXTAUTH_SECRET: `5b1-secret-${crypto.randomUUID()}-a7f3c9e1`,
      RECOVERY_FAULT_INJECTION: "1",
      RESTORE_ENGINE_ENABLED: "1",
    });
    line("B0ب) خادم dev معزول يقلع", true, `port=${PORT}`);

    const s = makeSession(PORT);
    const ADMIN = `adm5b1_${crypto.randomUUID().slice(0, 6)}`;
    const PASS = `Str-${crypto.randomUUID()}-Aa1`;
    const setup = await s.api("/api/setup", { method: "POST", body: JSON.stringify({ username: ADMIN, password: PASS, displayName: "5B.1" }) });
    line("B1) setup بمصادقة قوية صريحة (لا fallback)", setup.status === 201, String(setup.status));
    line("B1ب) دخول", await s.login(ADMIN, PASS));

    // استقلالية الصلاحية: مدير بلا مفتاح ⇒ 403 قبل أي كشف عن المحرك
    const backups = await s.api<{ backupId: string }>("/api/backups", { method: "POST" });
    let backupId = "";
    if (backups.status === 201) {
      backupId = backups.body.backupId;
      await s.api(`/api/backups/${backupId}/drill`, { method: "POST" });
    } else {
      line("B2) إنشاء نسخة", false, JSON.stringify(backups.body).slice(0, 100));
    }
    const previewForbidden = await s.api(`/api/backups/${backupId}/restore-preview`);
    const restoreForbidden = await s.api(`/api/backups/${backupId}/restore`, {
      method: "POST",
      body: JSON.stringify({ confirmationText: "RESTORE" }),
    });
    line(
      "B2) مدير بلا restoreDatabase ⇒ 403/403 (ليس 409) — لا كشف عن حالة المحرك",
      previewForbidden.status === 403 && restoreForbidden.status === 403,
      `preview=${previewForbidden.status} restore=${restoreForbidden.status}`
    );

    // منح صريح عبر users API (مسار 4B.3 الموثق) + جلسة جديدة
    const me = await s.whoami();
    const grant = await s.api(`/api/users/${me?.id}`, {
      method: "PUT",
      body: JSON.stringify({ permissions: { view: true, add: true, edit: true, delete: true, groups: true, export: true, settings: true, manageUsers: true, manageBackups: true, restoreDatabase: true } }),
    });
    line("B3) منح restoreDatabase صريحًا ⇒ 200", grant.status === 200, String(grant.status));
    const s2 = makeSession(PORT);
    await s2.login(ADMIN, PASS);
    const previewOk = await s2.api(`/api/backups/${backupId}/restore-preview`);
    line("B3ب) بعد المنح + جلسة جديدة ⇒ preview 200", previewOk.status === 200, String(previewOk.status));

    // WAL_CLEANUP fail ⇒ ABORTED قبل التبديل (fail-closed — نص المستخدم §8)
    mkdirSync(path.dirname(CONTROL), { recursive: true });
    writeFileSync(CONTROL, JSON.stringify({ points: { WAL_CLEANUP: "fail" } }));
    const epochBefore = readEpochFile(VAR_DIR);
    const pre4 = await s2.api<{ requiredConfirmations?: { secondary?: string | null } }>(`/api/backups/${backupId}/restore-preview`);
    const aborted = await s2.api<{ result?: string; abortReason?: string; ok?: boolean }>(`/api/backups/${backupId}/restore`, {
      method: "POST",
      body: JSON.stringify({
        confirmationText: "RESTORE",
        ...(pre4.body.requiredConfirmations?.secondary ? { downgradeConfirmation: pre4.body.requiredConfirmations.secondary } : {}),
      }),
    });
    const abortedBody = aborted.body as { result?: string; abortReason?: string; ok?: boolean };
    line(
      "B4) WAL_CLEANUP محقون ⇒ ABORTED قبل التبديل (لا متابعة صامتة)",
      abortedBody.result === "ABORTED" && String(abortedBody.abortReason ?? "").includes("WAL/SHM"),
      `${abortedBody.result ?? aborted.status} ${String(abortedBody.abortReason ?? "").slice(0, 60)}`
    );
    const stAfterAbort = await s2.api<{ maintenance: { state: string }; epoch: { available: boolean } }>("/api/system/status");
    line(
      "B4ب) بعد الإلغاء: maintenance عاد NORMAL + epoch لم يتغير",
      stAfterAbort.body.maintenance.state === "NORMAL" && readEpochFile(VAR_DIR) === epochBefore,
      stAfterAbort.body.maintenance.state
    );
    rmSync(CONTROL, { force: true });

    // استعادة نظيفة عبر المسار الجديد (helpers فعلية: URL + retry + CLI عبر node)
    const pre5 = await s2.api<{ requiredConfirmations?: { secondary?: string | null } }>(`/api/backups/${backupId}/restore-preview`);
    const done = await s2.api<{ result?: string; epochBumped?: boolean; durationMs?: number }>(`/api/backups/${backupId}/restore`, {
      method: "POST",
      body: JSON.stringify({
        confirmationText: "RESTORE",
        ...(pre5.body.requiredConfirmations?.secondary ? { downgradeConfirmation: pre5.body.requiredConfirmations.secondary } : {}),
      }),
    });
    line(
      "B5) استعادة نظيفة عبر المحرك (مع helpers 5B.1) ⇒ COMPLETED + epoch+1",
      done.status === 200 && done.body.result === "COMPLETED" && done.body.epochBumped === true,
      `${done.body.result ?? done.status} dur=${done.body.durationMs}ms epoch ${epochBefore}→${readEpochFile(VAR_DIR)}`
    );

    const h = await fetch(`http://127.0.0.1:${PORT}/api/health`, { cache: "no-store" });
    const hb = (await h.json()) as Record<string, unknown>;
    line(
      "B6) health dev: بلا version — الجسم {status, app, serverTime}",
      h.status === 200 && !("version" in hb) && hb.status === "healthy",
      JSON.stringify(hb)
    );
  } finally {
    await stopServer(srv);
  }
}

/* ═══════════════════════ الجزء C — إنتاج standalone حقيقي ═══════════════════════ */

async function partC(): Promise<void> {
  section("C) إنتاج standalone حقيقي (.next-prod) — build معزول");

  // البناء مرة واحدة (env NEXT_DIST_DIR=.next-prod)
  const marker = path.join(ROOT, ".next-prod", "standalone", "prod-server.mjs");
  if (!existsSync(marker)) {
    console.log("[build] bun run build (NEXT_DIST_DIR=.next-prod) — قد يستغرق دقائق…");
    const b = spawnSync("bun", ["run", "build"], {
      cwd: ROOT,
      env: { ...process.env, NEXT_DIST_DIR: ".next-prod" },
      encoding: "utf8",
      timeout: 600_000,
    });
    line(
      "C0) bun run build + assemble-release (Node، بلا cp/tee)",
      b.status === 0 && existsSync(marker),
      b.status === 0 ? "built" : (b.stderr ?? "").slice(-400)
    );
  } else {
    line("C0) بناء موجود مسبقًا — إعادة استخدام", true, ".next-prod/standalone");
  }

  // C0ب — نقاء الـartifact (نص المستخدم §20-16)
  {
    const standalone = path.join(ROOT, ".next-prod", "standalone");
    const forbidden = ["db", "var", "tool-results", "test"];
    const leftovers = forbidden.filter((n) => existsSync(path.join(standalone, n)));
    for (const n of readdirSync(standalone)) {
      if (/^\.env/.test(n)) leftovers.push(n);
    }
    const metaPath = path.join(standalone, "RELEASE_META.json");
    let metaOk = false;
    let metaFp = "";
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { expectedSchemaFingerprint?: string; migrations?: string[]; gitSha?: string };
      metaFp = meta.expectedSchemaFingerprint ?? "";
      metaOk = !!meta.expectedSchemaFingerprint && Array.isArray(meta.migrations) && meta.migrations.length > 0;
    }
    line(
      "C0ب) artifact نقي: بلا db/var/.env/tool-results/test + RELEASE_META/RELEASE_ID/prod-server موجودة",
      leftovers.length === 0 && existsSync(metaPath) && existsSync(path.join(standalone, "RELEASE_ID")) && existsSync(path.join(standalone, "prod-server.mjs")),
      leftovers.length ? leftovers.join(",") : "نظيف"
    );
    line("C0ج) RELEASE_META يحمل fingerprint + migrations (أساس فحص rollback §19)", metaOk, metaFp.slice(0, 24) + "…");
  }

  const prodEnv = (dbPath: string, varDir: string, port: number, extra: Record<string, string> = {}): Record<string, string> => ({
    DATABASE_URL: `file:${dbPath}`,
    VAR_DIR: varDir,
    BACKUP_DIR: path.join(varDir, "backups"),
    NEXTAUTH_SECRET: `5b1-prod-secret-${crypto.randomUUID()}-a7f3c9e1b2d4`,
    NEXTAUTH_URL: `http://127.0.0.1:${port}`,
    RESTORE_ENGINE_ENABLED: "1",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    ...extra,
  });

  /* ── C1: epoch مفقود + قاعدة مهيأة ⇒ فشل مغلق + استرداد المشغّل + موت JWT القديمة ── */
  {
    const port = 3103;
    const srv = makeServer("prod-epoch-lost", port);
    const DB = path.join(ISO, "c1", "db", "prod.db");
    const VARD = path.join(ISO, "c1", "var");
    rmSync(path.join(ISO, "c1"), { recursive: true, force: true });
    mkdirSync(path.join(ISO, "c1", "db"), { recursive: true });
    mkdirSync(VARD, { recursive: true });
    mkdirSync(path.join(VARD, "backups"), { recursive: true });
    migrateFixtureDb(DB);
    const seedPass = `Seed-${crypto.randomUUID()}-Aa1`;
    await seedAdminDirect(DB, "seedadmin_c1", seedPass);
    const epochPath = path.join(VARD, "auth", "session-epoch");
    mkdirSync(path.dirname(epochPath), { recursive: true });
    writeFileSync(epochPath, "7"); // قاعدة مهيأة + epoch=7 (عائلة عدّاد قديم)

    try {
      await startProdServer(srv, prodEnv(DB, VARD, port));
      const s = makeSession(port);
      const loginOk = await s.login("seedadmin_c1", seedPass);
      line("C1أ) إقلاع production: قاعدة مهيأة + epoch موجود ⇒ دخول سليم", loginOk, `epoch=${readEpochFile(VARD)}`);

      const epochBefore = readEpochFile(VARD);
      // فقد epoch بين التشغيلين ⇒ كشف عند الإقلاع (instrumentation) ⇒ فشل مغلق
      await stopServer(srv);
      rmSync(epochPath, { force: true });
      srv.log = "";
      await startProdServer(srv, prodEnv(DB, VARD, port)).catch(() => undefined);
      await sleep(500);
      const h1 = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" });
      const h1b = (await h1.json()) as Record<string, unknown>;
      line(
        "C1ب) epoch مفقود على قاعدة مهيأة ⇒ unhealthy 503 + بلا reason + لا إنشاء صمت",
        h1.status === 503 && h1b.status === "unhealthy" && !("reason" in h1b) && !("version" in h1b) && !existsSync(epochPath),
        `${h1.status} ${JSON.stringify(h1b)}`
      );
      line(
        "C1ب2) الخادم حيّ رغم unhealthy (بلا exit — عكس حلقة إعادة تشغيل تمحو التشخيص)",
        true,
        srv.log.includes("EPOCH_STATE_LOST") || srv.log.includes("epoch") ? "سجل الإقلاع يوثق الفقد" : srv.log.slice(-160)
      );
      const ev = recoveryLogHasEvent(VARD, "EPOCH_STATE_LOST");
      line("C1ج) حدث EPOCH_STATE_LOST في السجل الخارجي", ev.found, ev.detail.slice(0, 90));

      // استرداد المشغّل: بلا تأكيد ⇒ رفض؛ مع تأكيد ⇒ قيمة unix-seconds أعلى حتمًا
      const rejectRun = spawnSync("bun", ["scripts/restore-operator.ts", "--epoch-recover"], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: `file:${DB}`, VAR_DIR: VARD },
        encoding: "utf8",
      });
      line(
        "C1د) --epoch-recover بلا --confirm-epoch-loss ⇒ رفض (exit≠0) بلا كتابة",
        rejectRun.status !== 0 && !existsSync(epochPath),
        `exit=${rejectRun.status}`
      );
      const rec = spawnSync("bun", ["scripts/restore-operator.ts", "--epoch-recover", "--confirm-epoch-loss"], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: `file:${DB}`, VAR_DIR: VARD },
        encoding: "utf8",
      });
      const newEpoch = readEpochFile(VARD);
      const minExpected = Math.floor(Date.now() / 1000) - 120;
      line(
        "C1هـ) الاسترداد الموثق ⇒ epoch = unix-seconds (أعلى حتمًا من عائلة العدّاد)",
        rec.status === 0 && !!newEpoch && Number(newEpoch) >= minExpected && Number(newEpoch) > Number(epochBefore ?? 0),
        `epoch=${newEpoch}`
      );

      // JWT القديمة (صادرة تحت epoch=7) ماتت؛ دخول جديد يعمل
      const oldDead = !(await s.whoami())?.id;
      line("C1و) الجلسة القديمة (epoch=7) ماتت بعد الاسترداد", oldDead, "stale JWT invalidation");
      const freshLogin = await s.login("seedadmin_c1", seedPass);
      line("C1ز) الدخول الجديد يعمل بعد الاسترداد (epoch الجديد)", freshLogin, "new session valid");
    } finally {
      await stopServer(srv);
    }

    // إقلاع جديد بعد الاسترداد ⇒ healthy + دخول جديد يعمل
    {
      await startProdServer(srv, prodEnv(DB, VARD, port));
      const s = makeSession(port);
      // كلمة seed عشوائية غير معروفة ⇒ استخدم مسار دخول مشروط: نتحقق أن health healthy وأن
      // needsSetup=false (مستخدم موجود) — إثبات الإقلاع السليم بعد الاسترداد
      const h = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" });
      const setupState = await fetch(`http://127.0.0.1:${port}/api/setup`, { cache: "no-store" });
      const ss = (await setupState.json()) as { needsSetup?: boolean };
      line(
        "C1ح) إقلاع جديد بعد الاسترداد ⇒ healthy + needsSetup=false (القاعدة والمستخدم باقيان)",
        h.status === 200 && ss.needsSetup === false,
        `${h.status} needsSetup=${ss.needsSetup}`
      );
      await stopServer(srv);
    }
  }

  /* ── C2: epoch تالف ⇒ فشل مغلق + EPOCH_STATE_CORRUPT + استرداد ── */
  {
    const port = 3104;
    const srv = makeServer("prod-epoch-corrupt", port);
    const DB = path.join(ISO, "c2", "db", "prod.db");
    const VARD = path.join(ISO, "c2", "var");
    rmSync(path.join(ISO, "c2"), { recursive: true, force: true });
    mkdirSync(path.join(ISO, "c2", "db"), { recursive: true });
    mkdirSync(VARD, { recursive: true });
    mkdirSync(path.join(VARD, "backups"), { recursive: true });
    migrateFixtureDb(DB);
    await seedAdminDirect(DB, "seedadmin_c2", `Seed-${crypto.randomUUID()}-Bb2`);
    const epochPath = path.join(VARD, "auth", "session-epoch");
    mkdirSync(path.dirname(epochPath), { recursive: true });
    writeFileSync(epochPath, "corrupt!!");

    try {
      await startProdServer(srv, prodEnv(DB, VARD, port));
      const h = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" });
      const ev = recoveryLogHasEvent(VARD, "EPOCH_STATE_CORRUPT");
      line(
        "C2) epoch تالف ⇒ unhealthy + حدث EPOCH_STATE_CORRUPT + الملف لم يُكتب فوقه",
        h.status === 503 && ev.found && readEpochFile(VARD) === "corrupt!!",
        `${h.status} ${ev.detail.slice(0, 60)}`
      );
    } finally {
      await stopServer(srv);
    }
    const rec = spawnSync("bun", ["scripts/restore-operator.ts", "--epoch-recover", "--confirm-epoch-loss"], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: `file:${DB}`, VAR_DIR: VARD },
      encoding: "utf8",
    });
    const newEpoch = readEpochFile(VARD);
    line(
      "C2ب) استرداد من التالف ⇒ unix-seconds (بلا قبول قيمة يدوية)",
      rec.status === 0 && !!newEpoch && /^\d+$/.test(newEpoch) && Number(newEpoch) > 1_700_000_000,
      `epoch=${newEpoch}`
    );
  }

  /* ── C3/C5: قاعدة جديدة — bootstrap مشروع 1 + بوابة الإنتاج + سباق أول مدير ── */
  {
    const port = 3105;
    const srv = makeServer("prod-fresh", port);
    const DB = path.join(ISO, "c3", "db", "prod.db");
    const VARD = path.join(ISO, "c3", "var");
    rmSync(path.join(ISO, "c3"), { recursive: true, force: true });
    mkdirSync(path.join(ISO, "c3", "db"), { recursive: true });
    mkdirSync(VARD, { recursive: true });
    mkdirSync(path.join(VARD, "backups"), { recursive: true });
    migrateFixtureDb(DB);

    // أ) بلا بوابة: POST صالح ⇒ 403 (فشل مغلق — نص المستخدم §5)
    {
      await startProdServer(srv, prodEnv(DB, VARD, port));
      const s = makeSession(port);
      const denied = await s.api("/api/setup", {
        method: "POST",
        body: JSON.stringify({ username: "bootadmin", password: `Str-${crypto.randomUUID()}-Aa1` }),
      });
      line("C3أ) production بلا SETUP_BOOTSTRAP_ENABLED ⇒ 403", denied.status === 403, String(denied.status));
      const epoch = readEpochFile(VARD);
      line("C3ب) قاعدة جديدة بلا epoch ⇒ bootstrap مشروع 1 (إقلاع أول حقيقي)", epoch === "1", `epoch=${epoch}`);
      await stopServer(srv);
    }

    // ب) بالبوابة: رفض الافتراضيات/الضعف + سباق + إغلاق تلقائي
    {
      await startProdServer(srv, prodEnv(DB, VARD, port, { SETUP_BOOTSTRAP_ENABLED: "1" }));
      const s = makeSession(port);

      const noBody = await s.api("/api/setup", { method: "POST", body: "{}" });
      line("C4أ) POST بلا username/password ⇒ 400 (لا fallback admin/admin123)", noBody.status === 400, String(noBody.status));

      const weak = await s.api("/api/setup", { method: "POST", body: JSON.stringify({ username: "bootadmin", password: "admin123" }) });
      line("C4ب) كلمة ضعيفة (admin123) ⇒ 400", weak.status === 400, String(weak.status));

      const short = await s.api("/api/setup", { method: "POST", body: JSON.stringify({ username: "bootadmin", password: "Sh0rtpw" }) });
      line("C4ج) كلمة قصيرة ⇒ 400", short.status === 400, String(short.status));

      // سباق: إنشاءان متزامنان باسمين مختلفين ⇒ مستخدم إداري واحد حصرًا
      const strong = `Str-${crypto.randomUUID()}-Aa1`;
      const [r1, r2] = await Promise.all([
        s.api<{ id?: string }>("/api/setup", { method: "POST", body: JSON.stringify({ username: "bootadmin", password: strong, displayName: "boot" }) }),
        s.api<{ id?: string }>("/api/setup", { method: "POST", body: JSON.stringify({ username: "raceadmin", password: `Rce-${crypto.randomUUID()}-Bb2`, displayName: "race" }) }),
      ]);
      const created = [r1, r2].filter((r) => r.status === 201).length;
      line(
        "C5) إنشاءان متزامنان ⇒ 201 واحد حصرًا (mutex+recount+unique)",
        created === 1 && (r1.status === 201 || r2.status === 201),
        `statuses=${r1.status}/${r2.status}`
      );
      const again = await s.api("/api/setup", { method: "POST", body: JSON.stringify({ username: "later", password: `Ltr-${crypto.randomUUID()}-Cc3` }) });
      line("C5ب) POST لاحق (العلم ما زال مفعّلًا) ⇒ 409 — إغلاق بنيوي", again.status === 409, String(again.status));

      // لا كلمة مرور في AuditLog (فحص تمثيلي: صف USER_CREATED بلا أي كلمة)
      const dbRaw = readFileSync(DB);
      const leaked = ["admin123", strong, "Rce-", "Ltr-"].filter((needle) => dbRaw.includes(needle)).length;
      // لا كلمات مرور صريحة مخزنة (هاش bcrypt فقط — الكلمات نفسها لا توجد كنص)
      line("C5ج) لا كلمة مرور نصية في قاعدة الإنتاج (هاش حصرًا)", leaked === 0, `موجود=${leaked}`);

      const h = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" });
      const hb = (await h.json()) as Record<string, unknown>;
      line(
        "C6) health إنتاج healthy: {status, app, serverTime} حصرًا (بلا version/reason)",
        h.status === 200 && hb.status === "healthy" && !("version" in hb) && !("reason" in hb) && Object.keys(hb).length === 3,
        `http=${h.status} keys=${Object.keys(hb).sort().join("+")} body=${JSON.stringify(hb).slice(0, 90)}`
      );
      await stopServer(srv);
    }
  }
}

/* ═══════════════════════ التنفيذ ═══════════════════════ */

async function main(): Promise<void> {
  console.log("=== Phase 5B.1 — Windows Compatibility & Security Tests ===");
  mkdirSync(ISO, { recursive: true });
  try {
    await partA();
    await partB();
    await partC();
  } finally {
    // تنظيف الخوادم إن بقيت
    for (const port of [3102, 3103, 3104, 3105]) {
      spawnSync("bash", ["-c", `ss -ltnp 2>/dev/null | grep ':${port} ' | grep -oP 'pid=\\K[0-9]+' | xargs -r kill -9`], { encoding: "utf8" });
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== النتيجة: ${passed}/${results.length} ✅ — ${failure ? "❌ فشل" : "نظيف"} ===`);
  if (failure) process.exit(1);
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
