// Phase 5B.1 — استدعاء Prisma CLI عبر Node نفسه (بلا bunx/npx/shell/PATH/.cmd).
//
// القرار الحاكم (نص المستخدم 5B.1 §2):
//   «لا أريد حلاً يعتمد على: bunx، npx، shell:true، PATH lookup، .cmd shim
//    execution داخل restore engine. نفّذ helper مركزيًا وآمنًا لاستدعاء Prisma
//    CLI باستخدام Node نفسه: process.execPath مع resolve صريح لمدخل Prisma CLI
//    المثبت داخل release/node_modules.»
//
// التصميم:
//   • التنفيذ: spawnSync(process.execPath, [cliEntry, ...args]) — أي تشغيل
//     node.exe/node المطلق لملف JS واحد. لا shell، لا lookup في PATH لأداة CLI،
//     لا شيمات .cmd، وprocess.execPath نفسه مسار مطلق لثنائية Node الجارية.
//   • الدقة (Resolution) — بهذا الترتيب، أول موجود يفوز:
//       1. PRISMA_CLI_HOME (بيئة صريحة — الإنتاج يشير إلى أدوات المشغّل
//          المشتركة مثل C:\Apps\ifrs-comparison\tools\prisma-cli، حيث
//          <home>/node_modules/prisma مثبت بنفس إصدار @prisma/client).
//       2. البحث تصاعديًا من cwd عن node_modules/prisma (dev/اختبار معزول).
//     مدخل الـCLI يُقرأ من حقل bin في package.json الخاص بحزمة prisma —
//     لا افتراض مسار داخلي مكتوب يدويًا.
//   • يحافظ على: DATABASE_URL override، timeout، التقاط stdout/stderr،
//     ومعالجة exit-code حتمية (نتيجة مهيكلة — لا رميات غامضة).
//   • فشل الدقة (Resolution) ⇒ نتيجة مهيكلة code=PRISMA_CLI_UNRESOLVED —
//     المستدعي (فحوص ما بعد التحقق) يفشل مغلقًا برمز واضح قابل للتدقيق.
//
// فصل الـartifact (نص المستخدم §3): الـCLI أداة نشر/مشغّل (Layer B) — لا يُنسخ
// ضمن كل release؛ يُثبّت مرة واحدة على المضيف تحت tools/prisma-cli بنفس إصدار
// @prisma/client. خادم standalone (Layer A) لا يحتاجه إلا لفحص migrate status
// عند الاستعادة — عبر PRISMA_CLI_HOME. التوثيق في deploy/runbook-deploy-windows.md.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface PrismaCliRunResult {
  ok: boolean;
  /** PRISMA_CLI_OK | PRISMA_CLI_UNRESOLVED | PRISMA_CLI_TIMEOUT | PRISMA_CLI_ERROR */
  code: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** وصف آمن للتشخيص — لا مسارات حساسة تُعرض للعامة من المستدعي */
  detail: string;
  cliEntryResolved: string | null;
  timedOut: boolean;
}

/** يبحث عن node_modules/prisma بدءًا من dir وصاعدًا — يعيد مجلد الحزمة أو null. */
function findPrismaPackageFrom(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", "prisma");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** يقرأ مدخل CLI من حقل bin في package.json الخاصة بحزمة prisma. */
function resolveCliEntry(prismaPkgDir: string): string | null {
  try {
    const pkgPath = path.join(prismaPkgDir, "package.json");
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      bin?: string | Record<string, string>;
      main?: string;
      version?: string;
    };
    let binRel: string | null = null;
    if (typeof pkg.bin === "string") binRel = pkg.bin;
    else if (pkg.bin && typeof pkg.bin === "object" && typeof pkg.bin.prisma === "string") {
      binRel = pkg.bin.prisma;
    } else if (typeof pkg.main === "string") binRel = pkg.main;
    if (!binRel) return null;
    const entry = path.resolve(prismaPkgDir, binRel);
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/** دقة مدخل Prisma CLI — تُصدّر للفحص في الاختبارات. */
export function resolvePrismaCliEntry(cwd: string = process.cwd()): {
  ok: boolean;
  code: string;
  cliEntry: string | null;
  source: "PRISMA_CLI_HOME" | "CWD_NODE_MODULES" | null;
  detail: string;
} {
  // 1) PRISMA_CLI_HOME الصريح
  const home = process.env.PRISMA_CLI_HOME?.trim() ?? "";
  if (home) {
    const pkgDir = path.isAbsolute(home) ? path.join(home, "node_modules", "prisma") : path.resolve(cwd, home, "node_modules", "prisma");
    if (!existsSync(pkgDir)) {
      return {
        ok: false,
        code: "PRISMA_CLI_UNRESOLVED",
        cliEntry: null,
        source: null,
        detail: "PRISMA_CLI_HOME مضبوط لكن node_modules/prisma غير موجود داخله",
      };
    }
    const entry = resolveCliEntry(pkgDir);
    if (!entry) {
      return {
        ok: false,
        code: "PRISMA_CLI_UNRESOLVED",
        cliEntry: null,
        source: null,
        detail: "تعذر قراءة مدخل CLI من package.json لحزمة prisma داخل PRISMA_CLI_HOME",
      };
    }
    return { ok: true, code: "PRISMA_CLI_OK", cliEntry: entry, source: "PRISMA_CLI_HOME", detail: "PRISMA_CLI_HOME" };
  }

  // 2) البحث تصاعديًا من cwd (dev/اختبار)
  const pkgDir = findPrismaPackageFrom(cwd);
  if (!pkgDir) {
    return {
      ok: false,
      code: "PRISMA_CLI_UNRESOLVED",
      cliEntry: null,
      source: null,
      detail: "لا PRISMA_CLI_HOME ولا node_modules/prisma في سلسلة cwd — أداة النشر (Layer B) غير مثبتة في متناول هذا السياق",
    };
  }
  const entry = resolveCliEntry(pkgDir);
  if (!entry) {
    return { ok: false, code: "PRISMA_CLI_UNRESOLVED", cliEntry: null, source: null, detail: "حزمة prisma موجودة لكن مدخل CLI غير قابل للقراءة" };
  }
  return { ok: true, code: "PRISMA_CLI_OK", cliEntry: entry, source: "CWD_NODE_MODULES", detail: "cwd node_modules" };
}

export interface RunPrismaCliOptions {
  args: string[];
  cwd?: string;
  /** DATABASE_URL صريح يُحقن في بيئة العملية الفرعية (override كامل). */
  databaseUrl?: string;
  timeoutMs?: number;
}

/**
 * تشغيل Prisma CLI عبر process.execPath حصرًا — بلا shell ولا bunx/npx ولا
 * شيمات. النتيجة مهيكلة حتميًا؛ لا ريميات.
 */
export function runPrismaCli(opts: RunPrismaCliOptions): PrismaCliRunResult {
  const cwd = opts.cwd ?? process.cwd();
  const resolved = resolvePrismaCliEntry(cwd);
  if (!resolved.ok || !resolved.cliEntry) {
    return {
      ok: false,
      code: "PRISMA_CLI_UNRESOLVED",
      exitCode: null,
      stdout: "",
      stderr: "",
      detail: resolved.detail,
      cliEntryResolved: null,
      timedOut: false,
    };
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.databaseUrl) {
    env.DATABASE_URL = opts.databaseUrl;
  }

  const res = spawnSync(process.execPath, [resolved.cliEntry, ...opts.args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30_000,
    windowsHide: true,
    shell: false, // صريح: لا shell إطلاقًا على أي منصة
  });

  if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    return {
      ok: false,
      code: "PRISMA_CLI_TIMEOUT",
      exitCode: null,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      detail: `تجاوز مهلة ${opts.timeoutMs ?? 30_000}ms`,
      cliEntryResolved: resolved.cliEntry,
      timedOut: true,
    };
  }
  if (res.error) {
    return {
      ok: false,
      code: "PRISMA_CLI_ERROR",
      exitCode: res.status ?? null,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      detail: String(res.error).split("\n")[0],
      cliEntryResolved: resolved.cliEntry,
      timedOut: false,
    };
  }

  return {
    ok: res.status === 0,
    code: res.status === 0 ? "PRISMA_CLI_OK" : "PRISMA_CLI_ERROR",
    exitCode: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    detail: res.status === 0 ? "ok" : `exit=${res.status}`,
    cliEntryResolved: resolved.cliEntry,
    timedOut: false,
  };
}
