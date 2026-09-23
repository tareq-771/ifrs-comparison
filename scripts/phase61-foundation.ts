// Phase 6.1 — بوابة اختبارات الأساس المالي (نمط المراحل السابقة — معزول كليًا وغير تدميري).
//
// الأجزاء:
//   A) وحدات نقية: العملات، fail-closed للصلاحيات، نطاق الشركات، خوارزمية توليد
//      الفترات (تغطية حرفية بلا فجوات/تداخلات + أمثلة إلزامية 12/12/3 + رفض
//      الوحدات الجزئية)، انتقالات السنوات، القائمة المبيّضة للإقفال، تحقق الشركة.
//   B) المخطط/الترحيل/التوافق: قاعدة من migrations حصرًا، تحليل migration.sql
//      (بلا حذف جداول دفتر الأستاذ)، بصمة canonical == المثبت، ترحيل نسخة بيانات
//      (حفظ كامل)، تصنيف النسخ القديمة older-known ورفضها الصارم، فحص جداول 6.1
//      الوجودي في validateBackupArtifact (بما فيه CompanyClosingPolicy).
//   C) خادم dev معزول (3121): الرؤية fail-closed عبر HTTP، أداة الربط الخلفي
//      (dry-run → apply → إعادة idempotent)، إبطال الشركة وحذفها، التداخل،
//      السنوات غير الميلادية والقصيرة، الجماعي (نجاح كامل/جزئي/إعادة)، العزل
//      NO_COMPANY/NO_PERIOD/PENDING، الحاوية المؤقتة وتأكيدها، انحدار الرؤية
//      legacy، الحذف الصلب المصحح (كل أنواع أحداث الدورات + النسخة + الدورة).
//
// صفر لمس لقاعدة التشغيل: var/test/61/ + منفذ 3121 + قواعد من migrations حصرًا.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";

const ROOT = "/home/z/my-project";
const ISO = path.join(ROOT, "var", "test", "61");
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

/* ═══════════════════════ الجزء A — وحدات نقية ═══════════════════════ */

async function partA(): Promise<void> {
  section("A) وحدات نقية (بلا خادم/قاعدة)");

  // A1 — العملات ISO-4217-ready
  const cur = await import("../src/lib/currencies");
  const eurV = cur.validateCurrencyCode("EUR");
  const yerV = cur.validateCurrencyCode("yer");
  line("A1أ) YER/SAR/USD مسجلة", cur.isSupportedCurrency("YER") && cur.isSupportedCurrency("SAR") && cur.isSupportedCurrency("USD"));
  line("A1ب) كود غير مسجل مرفوض", !cur.isSupportedCurrency("EUR") && !eurV.ok && eurV.reason === "UNKNOWN", "EUR");
  line("A1ج) المطابعة غير حساسة لحالة الأحرف", yerV.ok && yerV.code === "YER");
  line("A1د) الاشتقاق: الإبلاغ = الوظيفية", cur.deriveReportingCurrency("SAR") === "SAR" && cur.deriveReportingCurrency("") === "");
  line("A1هـ) بنية قابلة للتوسيع بلا ترحيل (أضف عملة فورًا)", Object.keys(cur.CURRENCIES).length >= 3);

  // A2 — الصلاحيات fail-closed
  const perms = await import("../src/lib/permissions");
  const legacyJson = JSON.stringify({ view: true, add: true, edit: true, export: true, groupIds: ["g1"] });
  const parsedLegacy = perms.parsePermissions(legacyJson);
  line("A2أ) مستخدم قديم بلا companyIds ⇒ [] (لا وصول — fail-closed)", Array.isArray(parsedLegacy.companyIds) && parsedLegacy.companyIds.length === 0);
  line("A2ب) غياب viewAllCompanies ⇒ false", parsedLegacy.viewAllCompanies === false);
  line("A2ج) viewAllCompanies قيمة غير true ⇒ false", perms.parsePermissions(JSON.stringify({ viewAllCompanies: "yes" })).viewAllCompanies === false);
  line("A2د) companyIds غير مصفوفة ⇒ []", (perms.parsePermissions(JSON.stringify({ companyIds: "all" })).companyIds ?? []).length === 0);
  line("A2هـ) تنظيف القائمة من غير النصوص والتكرار", JSON.stringify(perms.parsePermissions(JSON.stringify({ companyIds: ["a", "", 5, "a"] })).companyIds) === '["a"]');
  const adminP = perms.parsePermissions(JSON.stringify({ role: "admin" }));
  line("A2و) قالب المدير يفعّل مفاتيح الإدارة", perms.canManageCompanies(adminP, "admin") && perms.canManageFiscalYears(adminP, "admin") && perms.canManagePeriods(adminP, "admin"));
  const userP = perms.parsePermissions("{}");
  line("A2ز) مستخدم عادي بلا مفاتيح ⇒ لا إدارة", !perms.canManageCompanies(userP, "user") && !perms.canManageFiscalYears(userP, "user"));
  line("A2ح) stringify يكتب companyIds دائمًا (صريح لا ضمني)", JSON.stringify(JSON.parse(perms.stringifyPermissions({})).companyIds) === "[]");

  // A3 — نطاق الشركات
  const access = await import("../src/lib/company-access");
  line("A3أ) admin ⇒ ALL بقاعدة الدور", (() => { const s = access.resolveCompanyScope({ role: "admin", permissions: {} }); return s.mode === "ALL" && s.reason === "ADMIN_ROLE"; })());
  line("A3ب) viewAllCompanies ⇒ ALL صريح", access.resolveCompanyScope({ role: "user", permissions: { viewAllCompanies: true } }).mode === "ALL");
  line("A3ج) قائمة غير فارغة ⇒ LIST", access.resolveCompanyScope({ role: "user", permissions: { companyIds: ["c1"] } }).mode === "LIST");
  line("A3د) [] أو مفقود ⇒ NONE (لا وصول)", access.resolveCompanyScope({ role: "user", permissions: {} }).mode === "NONE" && access.resolveCompanyScope({ role: "user", permissions: { companyIds: [] } }).mode === "NONE");
  const noneWhere = access.buildCompanyVisibilityWhere({ role: "user", permissions: {} });
  line("A3هـ) NONE ⇒ شرط Prisma مستحيل الدلالة (لا {} فارغة)", JSON.stringify(noneWhere) === JSON.stringify({ id: { in: [] } }));

  // A4 — خوارزمية توليد الفترات الشهرية
  const fy = await import("../src/lib/fiscal-year");
  const g1 = fy.generateMonthlyPeriods("2026-01-01", "2026-12-31");
  line("A4أ) سنة ميلادية كاملة = 12 فترة", g1.ok && g1.periods.length === 12);
  const g2 = fy.generateMonthlyPeriods("2026-07-01", "2027-06-30");
  line("A4ب) سنة انتقالية يوليو→يونيو = 12 فترة", g2.ok && g2.periods.length === 12 && g2.periods[0].startDate === "2026-07-01" && g2.periods[11].endDate === "2027-06-30");
  const g3 = fy.generateMonthlyPeriods("2026-01-01", "2026-03-31");
  line("A4ج) سنة قصيرة = 3 فترات", g3.ok && g3.periods.length === 3);
  const g4 = fy.generateMonthlyPeriods("2026-02-01", "2026-02-28");
  line("A4د) شهر واحد = فترة واحدة", g4.ok && g4.periods.length === 1);
  const cov1 = fy.verifyPeriodCoverage(g1.ok ? g1.periods : [], "2026-01-01", "2026-12-31");
  line("A4هـ) تغطية حرفية: بداية/نهاية مطابقة وتسلسل متصل بلا فجوات/تداخلات", cov1.ok);
  const cov2 = fy.verifyPeriodCoverage(g2.ok ? g2.periods : [], "2026-07-01", "2027-06-30");
  line("A4و) تغطية السنة الانتقالية سليمة", cov2.ok);
  line("A4ز) رفض بداية منتصف شهر (لا اختراع حدود)", (() => { const r = fy.generateMonthlyPeriods("2026-01-15", "2026-12-31"); return !r.ok && r.code === "PERIOD_MODEL_UNSUPPORTED"; })());
  line("A4ح) رفض نهاية ليست آخر الشهر", !fy.generateMonthlyPeriods("2026-01-01", "2026-12-15").ok);
  line("A4ط) رفض نطاق مقلوب وتاريخ غير صالح", (() => { const a = fy.generateMonthlyPeriods("2026-12-31", "2026-01-01"); const b = fy.generateMonthlyPeriods("bad", "2026-01-01"); return !a.ok && !b.ok && b.code === "DATE_INVALID"; })());
  line("A4ي) رفض امتداد غير منطقي (> 24 فترة)", (() => { const r = fy.generateMonthlyPeriods("2026-01-01", "2028-12-31"); return !r.ok && r.code === "SPAN_TOO_LONG"; })());
  const feb = fy.generateMonthlyPeriods("2028-01-01", "2028-12-31");
  line("A4ك) سنة كبيسة: فبراير = 2028-02-29", feb.ok && feb.periods[1].endDate === "2028-02-29");

  // A5 — انتقالات الحالة
  line("A5أ) OPEN→CLOSED فقط", JSON.stringify(fy.FISCAL_YEAR_TRANSITIONS.OPEN) === JSON.stringify(["CLOSED"]));
  line("A5ب) LOCKED→CLOSED فقط (لا إعادة فتح مباشرة)", JSON.stringify(fy.FISCAL_YEAR_TRANSITIONS.LOCKED) === JSON.stringify(["CLOSED"]));
  line("A5ج) CLOSED→LOCKED/OPEN", fy.FISCAL_YEAR_TRANSITIONS.CLOSED.includes("LOCKED") && fy.FISCAL_YEAR_TRANSITIONS.CLOSED.includes("OPEN"));

  // A6 — القائمة المبيّضة للإقفال
  const cp = await import("../src/lib/closing-policy");
  line("A6أ) المكوّنات الثلاثة مسجلة", cp.isClosingComponent("TRIAL_BALANCE") && cp.isClosingComponent("INCOME_STATEMENT") && cp.isClosingComponent("BALANCE_SHEET"));
  line("A6ب) CASH_FLOW غير مسجل (لا اشتقاق في 6.1)", !cp.isClosingComponent("CASH_FLOW"));
  line("A6ج) تنظيف/ترتيب مستقر/إزالة تكرار", JSON.stringify(cp.normalizeRequiredComponents(["BALANCE_SHEET", "TRIAL_BALANCE", "TRIAL_BALANCE"])) === JSON.stringify(["TRIAL_BALANCE", "BALANCE_SHEET"]));
  line("A6د) مكوّن غير مسجل ⇒ خطأ رمزي", (() => { try { cp.normalizeRequiredComponents(["NOPE"]); return false; } catch (e) { return (e as Error).name === "ClosingPolicyError"; } })());

  // A7 — تحقق الشركة
  const comp = await import("../src/lib/company");
  line("A7أ) كود صحيح/رفض السيئ", comp.validateCompanyCode("ABC-01") === "ABC-01" && (() => { try { comp.validateCompanyCode("أ ب"); return false; } catch { return true; } })());
  const norm = comp.normalizeCompanyInput({ nameAr: "شركة", functionalCurrency: "YER" });
  line("A7ب) اشتقاق عملة الإبلاغ من الوظيفية", norm.functionalCurrency === "YER" && norm.reportingCurrency === "YER");
  line("A7ج) الحالة: انتقالان مسموحان فقط", comp.isCompanyStatus("ACTIVE") && comp.isCompanyStatus("INACTIVE") && !comp.isCompanyStatus("DELETED"));
}

/* ═══════════════ الجزء B — المخطط/الترحيل/التوافق ═══════════════ */

function migrateFixtureDb(dbPath: string): boolean {
  const res = spawnSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    encoding: "utf8",
  });
  return res.status === 0;
}

async function buildOldSchemaDb(dbPath: string): Promise<void> {
  // قاعدة إرث (ما قبل 6.1) من 0_init حصرًا — لاختبار التصنيف/الرفض الصارم
  const sql = readFileSync(path.join(ROOT, "prisma", "migrations", "0_init", "migration.sql"), "utf8");
  return withClient(dbPath, async (c) => {
    for (const stmt of sql.split(/;\s*\n/)) {
      // أزل سطور التعليقات ثم نفّذ إذا بقي نص فعلي (تعليقات تسبق CREATE لا تلغيها)
      const s = stmt
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (!s) continue;
      await c.$executeRawUnsafe(s);
    }
  });
}

async function withClient<T>(dbPath: string, fn: (c: import("@prisma/client").PrismaClient) => Promise<T>): Promise<T> {
  const { PrismaClient } = await import("@prisma/client");
  const c = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } }, log: [] });
  try {
    return await fn(c);
  } finally {
    await c.$disconnect().catch(() => undefined);
  }
}

async function partB(): Promise<void> {
  section("B) المخطط/الترحيل/التوافق (معزول)");
  rmSync(ISO, { recursive: true, force: true });
  mkdirSync(ISO, { recursive: true });

  // B1 — قاعدة جديدة من migrations حصرًا
  const freshDb = path.join(ISO, "fresh.db");
  line("B1) migrate deploy على قاعدة معزولة", migrateFixtureDb(freshDb));
  const migs = await withClient(freshDb, async (c) =>
    c.$queryRawUnsafe<{ migration_name: string }[]>(`SELECT migration_name FROM _prisma_migrations ORDER BY started_at`)
  );
  line("B1ب) الترحيلان مسجلان (0_init + phase61)", migs.length === 2 && migs.some((m) => m.migration_name.includes("phase61")));

  // B2 — تحليل SQL: بلا حذف لجداول دفتر الأستاذ + إعادة بناء Report تحفظ البيانات
  const migDir = path.join(ROOT, "prisma", "migrations", "20260922085424_phase61_financial_foundation");
  const sql = readFileSync(path.join(migDir, "migration.sql"), "utf8");
  const drops = [...sql.matchAll(/DROP TABLE\s+"?(\w+)"?/gi)].map((m) => m[1]);
  line("B2أ) DROP TABLE يشمل Report فقط (إعادة بناء قياسية تحفظ الصفوف)", drops.length === 1 && drops[0] === "Report", drops.join(","));
  line("B2ب) إعادة البناء تشمل نسخ الصفوف INSERT INTO new_Report ... SELECT", /INSERT INTO "new_Report"[\s\S]*SELECT[\s\S]*FROM "Report"/i.test(sql));
  line("B2ج) كل مفاتيح 6.1 الخارجية RESTRICT (5: FY/Period/Policy + Report×2)", (sql.match(/ON DELETE RESTRICT/g) ?? []).length === 5);
  line("B2د) لا db push ولا صيغ تدميرية (DELETE FROM/DROP COLUMN)", !/DELETE FROM/i.test(sql) && !/DROP COLUMN/i.test(sql));

  // B3 — البصمة المثبتة
  const { canonicalSchemaFingerprint } = await import("../src/lib/schema-fingerprint");
  const { PINNED_CURRENT_CANONICAL_FINGERPRINT, classifySchemaFingerprint, REQUIRED_P61_TABLES } = await import("../src/lib/backup-config");
  const fpFresh = await withClient(freshDb, (c) => canonicalSchemaFingerprint(c));
  line("B3) بصمة قاعدة المهاجرات == المثبت الحالي", fpFresh === PINNED_CURRENT_CANONICAL_FINGERPRINT, fpFresh.slice(0, 24));

  // B4 — ترحيل نسخة بيانات (0_init + بيانات + ترحيل 6.1) ⇒ حفظ كامل
  const seedLegacyRaw = async (dbPath: string) => {
    // بذر بالـ SQL الخام حصرًا — عميل Prisma الجديد يُدرج أعمدة 6.1 غير الموجودة في مخطط الإرث
    const bcrypt = (await import("bcryptjs")).default;
    const hash = await bcrypt.hash("Str-pass-1Aa", 10);
    const now = new Date().toISOString();
    await withClient(dbPath, async (c) => {
      await c.$executeRawUnsafe(
        `INSERT INTO "User" ("id","username","passwordHash","displayName","role","permissions","active","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)`,
        "u-legacy-1", "legacy", hash, "legacy", "admin", "{}", 1, now, now
      );
      await c.$executeRawUnsafe(
        `INSERT INTO "Group" ("id","name","createdAt","updatedAt","userId") VALUES (?,?,?,?,?)`,
        "g-legacy-1", "مجموعة إرث", now, now, "u-legacy-1"
      );
      await c.$executeRawUnsafe(
        `INSERT INTO "Report" ("id","name","groupId","userId","version","status","cycle","periodEnd","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?)`,
        "r-legacy-1", "تقرير إرث 1", "g-legacy-1", "u-legacy-1", 1, "DRAFT", 1, "2025-06-30", now, now
      );
      await c.$executeRawUnsafe(
        `INSERT INTO "Report" ("id","name","groupId","userId","version","status","cycle","periodEnd","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?)`,
        "r-legacy-2", "تقرير إرث 2", null, "u-legacy-1", 1, "DRAFT", 1, null, now, now
      );
      await c.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id","userId","username","action","entityType","entityId","createdAt") VALUES (?,?,?,?,?,?,?)`,
        "a-legacy-1", null, "legacy", "REPORT_CREATED", "Report", "r-legacy-1", now
      );
      // سجل ترحيلات مُحلول (نمط 4A.1: baseline resolve --applied) — كي يطبّق deploy الترحيل الجديد حصرًا
      await c.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "_prisma_migrations" ("id" TEXT NOT NULL PRIMARY KEY, "checksum" TEXT NOT NULL, "finished_at" DATETIME, "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT current_timestamp, "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`
      );
      const { createHash } = await import("node:crypto");
      const zeroSql = readFileSync(path.join(ROOT, "prisma", "migrations", "0_init", "migration.sql"), "utf8");
      await c.$executeRawUnsafe(
        `INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count") VALUES (?,?,?,?,?,?,?,?)`,
        "m-baseline-0init", createHash("sha256").update(zeroSql).digest("hex"), now, "0_init", null, null, now, 1
      );
    });
  };
  const legacyDb = path.join(ISO, "legacy-with-data.db");
  await buildOldSchemaDb(legacyDb);
  await seedLegacyRaw(legacyDb);
  const beforeCounts = await withClient(legacyDb, async (c) => ({
    users: await c.user.count(), groups: await c.group.count(), reports: await c.report.count(), audit: await c.auditLog.count(),
  }));
  const applyRes = spawnSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: ROOT, env: { ...process.env, DATABASE_URL: `file:${legacyDb}` }, encoding: "utf8",
  });
  line("B4أ) تطبيق الترحيل على نسخة البيانات", applyRes.status === 0);
  const afterCounts = await withClient(legacyDb, async (c) => ({
    users: await c.user.count(), groups: await c.group.count(), reports: await c.report.count(), audit: await c.auditLog.count(),
    companyId: (await c.report.findFirst({ where: { name: "تقرير إرث 1" } }))?.companyId,
    backfill: (await c.report.findFirst({}))?.backfillStatus ?? null,
  }));
  line(
    "B4ب) حفظ كامل: نفس العدّادات + حقول 6.1 الجديدة null",
    JSON.stringify(beforeCounts) === JSON.stringify({ users: afterCounts.users, groups: afterCounts.groups, reports: afterCounts.reports, audit: afterCounts.audit })
      && afterCounts.companyId === null && afterCounts.backfill === null,
    JSON.stringify({ before: beforeCounts, after: afterCounts })
  );
  const fpData = await withClient(legacyDb, (c) => canonicalSchemaFingerprint(c));
  line("B4ج) بصمة نسخة البيانات المرحّلة == المثبت (استقلال عن ترتيب الأعمدة)", fpData === PINNED_CURRENT_CANONICAL_FINGERPRINT);

  // B5 — تصنيف النسخ القديمة ورفضها الصارم + فحص جداول 6.1
  await buildOldSchemaDb(path.join(ISO, "old-schema-check.db"));
  const fpOld = await withClient(path.join(ISO, "old-schema-check.db"), (c) => canonicalSchemaFingerprint(c));
  const oldClass = classifySchemaFingerprint(fpOld);
  line("B5أ) مخطط الإرث ⇒ older-known (مصنّف لا مجهول)", oldClass.schemaClass === "older-known", fpOld.slice(0, 24));
  line("B5ب) مخطط الإرث ≠ الحالي (لا قبول صامت)", fpOld !== PINNED_CURRENT_CANONICAL_FINGERPRINT);

  // B5ج — فحص جداول 6.1 الوجودي: نسخة current بها الجداول ⇒ PASSES؛ بلاها ⇒ MISSING_TABLES
  const { validateBackupArtifact } = await import("../src/lib/backup-server");
  const staging = path.join(ISO, "staging");
  mkdirSync(staging, { recursive: true });
  async function buildBackupZip(fromDb: string, zipPath: string): Promise<void> {
    const { buildManifest, collectPeriodRange, collectDataRange } = await import("../src/lib/backup-manifest");
    const { computeSchemaFingerprint } = await import("../src/lib/schema-fingerprint");
    const counts = await withClient(fromDb, async (c) => ({
      users: await c.user.count(), groups: await c.group.count(), reports: await c.report.count(),
      workflowHistory: await c.workflowHistory.count(), auditLog: await c.auditLog.count(),
    }));
    const manifest = buildManifest({
      backupId: `bk-test-${crypto.randomUUID().slice(0, 8)}`,
      backupType: "manual",
      createdBy: { id: null, username: "harness" },
      schemaVersion: "test",
      schemaFingerprint: await withClient(fromDb, (c) => computeSchemaFingerprint(c)),
      canonicalSchemaFingerprint: await withClient(fromDb, (c) => canonicalSchemaFingerprint(c)),
      database: { filename: "database.db", sha256: "0".repeat(64), bytes: 1, pageSize: 4096, integrityCheck: "ok", journalModeAtBackup: "wal" },
      counts,
      periodRange: await withClient(fromDb, (c) => collectPeriodRange(c)),
      dataRange: await withClient(fromDb, (c) => collectDataRange(c)),
      level: "CREATED",
    });
    // صحّح sha256 لمحتوى فعلي
    const { readFileSync, copyFileSync, statSync } = await import("node:fs");
    copyFileSync(fromDb, path.join(staging, "database.db"));
    const dbBytes = readFileSync(path.join(staging, "database.db"));
    const h = crypto.createHash("sha256").update(dbBytes).digest("hex");
    const fixed = { ...manifest, database: { ...manifest.database, sha256: h, bytes: statSync(path.join(staging, "database.db")).size } };
    writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(fixed));
    // الجانبي المطلوب من validateBackupArtifact: <zip بدون .zip>.manifest.json
    writeFileSync(zipPath.replace(/\.zip$/, ".manifest.json"), JSON.stringify(fixed));
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("database.db", dbBytes);
    zip.file("manifest.json", JSON.stringify(fixed));
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    writeFileSync(zipPath, buf);
  }
  try {
    const zipCurrent = path.join(staging, "current.zip");
    await buildBackupZip(freshDb, zipCurrent);
    const rep = await validateBackupArtifact({ zipPath: zipCurrent, actor: { id: null, username: "harness" }, source: "local", operationId: `op-${Date.now()}` });
    line("B5ج) نسخة current: تحقق كامل يعبر + P61_TABLES_OK (يشمل CompanyClosingPolicy)", rep.ok === true && (rep.checks ?? []).some((k: { code: string }) => k.code === "P61_TABLES_OK"), JSON.stringify((rep.checks ?? []).map((k: { code: string }) => k.code)));
  } catch (e) {
    line("B5ج) نسخة current: تحقق كامل", false, String(e).split("\n")[0]);
  }
  try {
    const zipOld = path.join(staging, "old.zip");
    // نسخة إرث مخصصة (لم تمر بالترحيل) — قاعدة 0_init + بيانات فقط
    const oldBackupDb = path.join(ISO, "old-schema-backup.db");
    await buildOldSchemaDb(oldBackupDb);
    await seedLegacyRaw(oldBackupDb);
    await buildBackupZip(oldBackupDb, zipOld);
    await validateBackupArtifact({ zipPath: zipOld, actor: { id: null, username: "harness" }, source: "local", operationId: `op-${Date.now()}` });
    line("B5د) نسخة الإرث تُرفض صارمًا في validateBackupArtifact", false, "لم تُرفض!");
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "";
    const msg = String(e);
    line(
      "B5د) نسخة الإرث تُرفض صارمًا (older-known ⇒ رفض قبل أي استعادة)",
      code === "SCHEMA_UNKNOWN" || code === "SCHEMA_MIGRATION_UNAVAILABLE" || /SCHEMA_MIGRATION_UNAVAILABLE|SCHEMA_UNKNOWN/.test(msg),
      `code=${code || "-"} ${msg.split("\n")[0].slice(0, 100)}`
    );
  }
  line("B5هـ) REQUIRED_P61_TABLES تشمل CompanyClosingPolicy", REQUIRED_P61_TABLES.includes("CompanyClosingPolicy"));
}

/* ═══════════════ الجزء C — خادم dev معزول (3121) ═══════════════ */

function makeServer(name: string, port: number) {
  return { name, port, proc: null as ReturnType<typeof spawn> | null, log: "" };
}

async function startDevServer(srv: ReturnType<typeof makeServer>, env: Record<string, string>): Promise<void> {
  srv.proc = spawn("bunx", ["next", "dev", "-p", String(srv.port)], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.proc.stdout?.on("data", (d) => { srv.log += d.toString(); });
  srv.proc.stderr?.on("data", (d) => { srv.log += d.toString(); });
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/health`, { cache: "no-store" });
      if (r.status < 500) return;
    } catch { /* لم يقلع بعد */ }
  }
  throw new Error(`server ${srv.name} failed to start:\n` + srv.log.slice(-2000));
}

async function stopServer(srv: ReturnType<typeof makeServer>): Promise<void> {
  if (srv.proc?.pid) {
    try { process.kill(srv.proc.pid, "SIGTERM"); } catch { /* انتهى */ }
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
        displayName: "seed-admin",
        role: "admin",
        permissions: stringifyPermissions(ADMIN_PERMISSIONS),
        active: true,
      },
    });
  } finally {
    await c.$disconnect().catch(() => undefined);
  }
}

interface CompanyLike { id: string; code: string; nameAr: string; status: string }
interface FYLike { id: string; code: string; status: string; origin: string; periods: Array<{ id: string; ordinal: number; startDate: string; endDate: string; status: string }> }

async function partC(): Promise<void> {
  section("C) خادم dev معزول (3121) — سلوك HTTP كامل");
  const PORT = 3121;
  const srv = makeServer("61-iso", PORT);
  const WORK = path.join(ISO, "server");
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(path.join(WORK, "db"), { recursive: true });
  mkdirSync(path.join(WORK, "var"), { recursive: true });
  const DB_PATH = path.join(WORK, "db", "test.db");
  line("C0) قاعدة الخادم من migrations حصرًا", migrateFixtureDb(DB_PATH));
  await seedAdminDirect(DB_PATH, "adm61", "Str-admin-61Aa");

  try {
    await startDevServer(srv, {
      DATABASE_URL: `file:${DB_PATH}`,
      VAR_DIR: path.join(WORK, "var"),
      NEXT_DIST_DIR: ".next-iso61",
      NEXTAUTH_SECRET: `61-secret-${crypto.randomUUID()}-a7f3c9e1`,
    });
    line("C0ب) الخادم المعزول يقلع", true, `port=${PORT}`);

    const admin = makeSession(PORT);
    line("C0ج) دخول المدير", await admin.login("adm61", "Str-admin-61Aa"));

    // ── مستخدمو الاختبار بصلاحيات مختلفة (أنشأهم المدير) ──
    const mk = async (username: string, permissions: Record<string, unknown>) => {
      const r = await admin.api<{ id?: string }>("/api/users", {
        method: "POST",
        body: JSON.stringify({ username, password: "Str-user-61Aa", displayName: username, role: "user", active: true, permissions }),
      });
      return r.status === 201;
    };
    const mkOk =
      (await mk("u_none", {})) &&
      (await mk("u_mgr", { manageCompanies: true, manageFiscalYears: true, companyIds: [] })) &&
      (await mk("u_all", { viewAllCompanies: true })) &&
      (await mk("u_g1", { groupIds: [], view: true, add: true }));
    line("C1) إنشاء مستخدمي الاختبار", mkOk);

    const sNone = makeSession(PORT); await sNone.login("u_none", "Str-user-61Aa");
    const sMgr = makeSession(PORT); await sMgr.login("u_mgr", "Str-user-61Aa");
    const sAll = makeSession(PORT); await sAll.login("u_all", "Str-user-61Aa");
    const sG1 = makeSession(PORT); await sG1.login("u_g1", "Str-user-61Aa");

    // ── E) الرؤية fail-closed ──
    const created = await admin.api<CompanyLike>("/api/companies", { method: "POST", body: JSON.stringify({ code: "CO-A", nameAr: "شركة أ", functionalCurrency: "YER" }) });
    line("E1أ) المدير ينشئ شركة (201)", created.status === 201);
    const coA = created.body;
    const created2 = await admin.api<CompanyLike>("/api/companies", { method: "POST", body: JSON.stringify({ code: "CO-B", nameAr: "شركة ب" }) });
    line("E1ب) شركة ثانية + كود مكرر مرفوض 409", created2.status === 201 && (await admin.api("/api/companies", { method: "POST", body: JSON.stringify({ code: "CO-A", nameAr: "شركة مكررة" }) })).status === 409);
    const coB = created2.body;
    const asMgr = await sMgr.api<CompanyLike[]>("/api/companies");
    const asAll = await sAll.api<CompanyLike[]>("/api/companies");
    const asNone = await sNone.api<CompanyLike[]>("/api/companies");
    line("E2أ) companyIds=[] ⇒ قائمة فارغة (لا خطأ — لا وصول)", asNone.status === 200 && Array.isArray(asNone.body) && asNone.body.length === 0);
    line("E2ب) viewAllCompanies ⇒ يرى الكل", asAll.status === 200 && asAll.body.length === 2);
    line("E2ج) بلا مفاتيح إدارة ⇒ إنشاء مرفوض 403", (await sNone.api("/api/companies", { method: "POST", body: JSON.stringify({ code: "CO-X", nameAr: "x" }) })).status === 403);
    // منح u_mgr رؤية CO-A فقط (via PUT)
    const usersList = await admin.api<Array<{ id: string; username: string }>>("/api/users");
    const mgrId = usersList.body.find((u) => u.username === "u_mgr")!.id;
    await admin.api(`/api/users/${mgrId}`, { method: "PUT", body: JSON.stringify({ displayName: "u_mgr", role: "user", active: true, permissions: { manageCompanies: true, manageFiscalYears: true, companyIds: [coA.id] } }) });
    const sMgr2 = makeSession(PORT); await sMgr2.login("u_mgr", "Str-user-61Aa");
    const mgrList = await sMgr2.api<CompanyLike[]>("/api/companies");
    line("E2د) companyIds=[CO-A] ⇒ يرى A حصرًا", mgrList.body.length === 1 && mgrList.body[0].id === coA.id);
    line("E3أ) شركة غير مرئية ⇒ 404 (لا كشف وجود)", (await sMgr2.api(`/api/companies/${coB.id}`)).status === 404);
    line("E3ب) سنوات شركة غير مرئية ⇒ 404", (await sMgr2.api(`/api/fiscal-years?companyId=${coB.id}`)).status === 404);

    // ── I/J/K/L) السنوات: تداخل/غير ميلادية/قصيرة/تغطية ──
    const fyOk = await admin.api<FYLike>("/api/fiscal-years", { method: "POST", body: JSON.stringify({ companyId: coA.id, code: "FY2026", startDate: "2026-01-01", endDate: "2026-12-31" }) });
    line("I) سنة ميلادية 2026 = 12 فترة", fyOk.status === 201 && fyOk.body.periods.length === 12);
    const fyNonCal = await admin.api<FYLike>("/api/fiscal-years", { method: "POST", body: JSON.stringify({ companyId: coB.id, code: "FY2627", displayNameAr: "سنة انتقالية", startDate: "2026-07-01", endDate: "2027-06-30" }) });
    line("J) سنة غير ميلادية (يوليو→يونيو) = 12 فترة بحدود حرفية", fyNonCal.status === 201 && fyNonCal.body.periods.length === 12 && fyNonCal.body.periods[0].endDate === "2026-07-31" && fyNonCal.body.periods[11].endDate === "2027-06-30");
    const fyShort = await admin.api<FYLike>("/api/fiscal-years", { method: "POST", body: JSON.stringify({ companyId: coA.id, code: "FY2027Q1", startDate: "2027-01-01", endDate: "2027-03-31" }) });
    line("K) سنة قصيرة = 3 فترات", fyShort.status === 201 && fyShort.body.periods.length === 3);
    const fyOverlap = await admin.api("/api/fiscal-years", { method: "POST", body: JSON.stringify({ companyId: coA.id, code: "FY2026B", startDate: "2026-06-01", endDate: "2027-05-31" }) });
    line("Iب) تداخل داخل الشركة مرفوض FY_OVERLAP", fyOverlap.status === 400 && (fyOverlap.body as { code?: string }).code === "FY_OVERLAP");
    const fyAdjacent = await admin.api("/api/fiscal-years", { method: "POST", body: JSON.stringify({ companyId: coA.id, code: "FY2027", startDate: "2027-04-01", endDate: "2027-12-31" }) });
    line("Iج) سنوات متلاصقة (بلا مشاركة يوم) مسموحة", fyAdjacent.status === 201);
    const fyDupCode = await admin.api("/api/fiscal-years", { method: "POST", body: JSON.stringify({ companyId: coA.id, code: "FY2026", startDate: "2029-01-01", endDate: "2029-12-31" }) });
    line("Iد) تكرار الكود داخل الشركة مرفوض", fyDupCode.status === 400 && (fyDupCode.body as { code?: string }).code === "FY_CODE_DUPLICATE");
    const fyMidMonth = await admin.api("/api/fiscal-years", { method: "POST", body: JSON.stringify({ companyId: coA.id, code: "BAD1", startDate: "2029-01-15", endDate: "2029-12-31" }) });
    line("L) بداية منتصف شهر مرفوضة بوضوح", fyMidMonth.status === 400 && (fyMidMonth.body as { code?: string }).code === "PERIOD_MODEL_UNSUPPORTED");
    const fyByMgr = await sMgr2.api("/api/fiscal-years", { method: "POST", body: JSON.stringify({ companyId: coB.id, code: "X1", startDate: "2029-01-01", endDate: "2029-12-31" }) });
    line("E3ج) إنشاء سنة لشركة غير مرئية ⇒ 404", fyByMgr.status === 404);

    // ── انتقالات الحالة + الأسباب ──
    const closed = await admin.api(`/api/fiscal-years/${fyOk.body.id}`, { method: "PATCH", body: JSON.stringify({ action: "close" }) });
    line("Mأ) إغلاق OPEN→CLOSED", closed.status === 200 && (closed.body as { status: string }).status === "CLOSED");
    const lockedNoPerm = await sG1.api(`/api/fiscal-years/${fyOk.body.id}`, { method: "PATCH", body: JSON.stringify({ action: "lock" }) });
    line("Mب) مستخدم بلا lockFiscalYears ⇒ 403", lockedNoPerm.status === 403);
    const locked = await admin.api(`/api/fiscal-years/${fyOk.body.id}`, { method: "PATCH", body: JSON.stringify({ action: "lock" }) });
    line("Mج) قفل CLOSED→LOCKED", locked.status === 200);
    const noReason = await admin.api(`/api/fiscal-years/${fyOk.body.id}`, { method: "PATCH", body: JSON.stringify({ action: "unlock" }) });
    line("Mد) فك القفل بلا سبب ⇒ 400 REASON_REQUIRED", noReason.status === 400 && (noReason.body as { code?: string }).code === "REASON_REQUIRED");
    const unlocked = await admin.api(`/api/fiscal-years/${fyOk.body.id}`, { method: "PATCH", body: JSON.stringify({ action: "unlock", reason: "خطأ إداري مررنا به" }) });
    line("Mهـ) فك القفل بسبب ⇒ LOCKED→CLOSED", unlocked.status === 200 && (unlocked.body as { status: string }).status === "CLOSED");
    const reopened = await admin.api(`/api/fiscal-years/${fyOk.body.id}`, { method: "PATCH", body: JSON.stringify({ action: "reopen", reason: "تسوية أرصدة افتتاحية" }) });
    line("Mو) إعادة فتح CLOSED→OPEN بسبب", reopened.status === 200 && (reopened.body as { status: string }).status === "OPEN");
    const lockFromOpen = await admin.api(`/api/fiscal-years/${fyOk.body.id}`, { method: "PATCH", body: JSON.stringify({ action: "lock" }) });
    line("Mز) OPEN→LOCKED مرفوض (لا قفزات)", lockFromOpen.status === 409);
    const periodLocked = await admin.api(`/api/fiscal-periods/${fyShort.body.periods[0].id}`, { method: "PATCH", body: JSON.stringify({ status: "CLOSED" }) });
    line("Mح) تغيير حالة فترة (managePeriods للمدير)", periodLocked.status === 200);
    const periodNoPerm = await sG1.api(`/api/fiscal-periods/${fyShort.body.periods[0].id}`, { method: "PATCH", body: JSON.stringify({ status: "OPEN" }) });
    line("Mط) مستخدم بلا managePeriods ⇒ 403", periodNoPerm.status === 403);

    // ── N/O) الجماعي: نجاح كامل/جزئي/إعادة idempotent ──
    const bulkItems = [
      { companyId: coA.id, code: "BULK29", startDate: "2029-01-01", endDate: "2029-12-31" },
      { companyId: coB.id, code: "BULK29", startDate: "2029-01-01", endDate: "2029-12-31" },
      { companyId: coB.id, code: "BULK28", startDate: "2028-13-01", endDate: "2028-12-31" }, // تاريخ غير صالح ⇒ فشل جزئي
    ];
    const plan = await admin.api<{ executableCount: number; failedCount: number; plan: Array<{ willCreate: boolean; reason?: string }> }>("/api/fiscal-years/bulk", { method: "POST", body: JSON.stringify({ mode: "plan", items: bulkItems }) });
    line("Nأ) الخطة: 2 قابلان للتنفيذ + 1 فشل واضح", plan.status === 200 && plan.body.executableCount === 2 && plan.body.failedCount === 1);
    const execNoConfirm = await admin.api("/api/fiscal-years/bulk", { method: "POST", body: JSON.stringify({ mode: "execute", items: bulkItems }) });
    line("Nب) تنفيذ بلا confirmed ⇒ 400 (لا إنشاء صامت)", execNoConfirm.status === 400 && (execNoConfirm.body as { code?: string }).code === "CONFIRMATION_REQUIRED");
    const exec = await admin.api<{ created: unknown[]; alreadyExists: unknown[]; failed: Array<{ code: string; reason: string }> }>("/api/fiscal-years/bulk", { method: "POST", body: JSON.stringify({ mode: "execute", confirmed: true, items: bulkItems }) });
    line(
      "Nج) التنفيذ: نجاح جزئي مهيكل (2 أنشئت + 1 فشل بسبب التاريخ)",
      exec.status === 200 && exec.body.created.length === 2 && exec.body.failed.length === 1 && /DATE_INVALID/.test(exec.body.failed[0]?.reason ?? ""),
      `status=${exec.status} body=${JSON.stringify(exec.body).slice(0, 300)}`
    );
    const retry = await admin.api<{ created: unknown[]; alreadyExists: unknown[]; failed: unknown[] }>("/api/fiscal-years/bulk", { method: "POST", body: JSON.stringify({ mode: "execute", confirmed: true, items: bulkItems }) });
    line(
      "O) إعادة المحاولة idempotent: 0 إنشاء + 2 alreadyExists",
      retry.status === 200 && retry.body.created.length === 0 && retry.body.alreadyExists.length === 2 && retry.body.failed.length === 1,
      `status=${retry.status} body=${JSON.stringify(retry.body).slice(0, 200)}`
    );

    // ── G/H) الإبطال + الحذف المقيد ──
    const stillVisible = await sAll.api<CompanyLike[]>("/api/companies");
    const deact = await admin.api(`/api/companies/${coB.id}`, { method: "PUT", body: JSON.stringify({ status: "INACTIVE" }) });
    line("Gأ) إبطال الشركة يعمل", deact.status === 200 && (deact.body as { status: string }).status === "INACTIVE");
    const afterDeact = await sAll.api<CompanyLike[]>("/api/companies");
    line("Gب) الإبطال يحفظ الرؤية التاريخية (الشركة ما تزال مرئية)", afterDeact.status === 200 && afterDeact.body.length === stillVisible.body.length);
    const fyOnInactive = await admin.api("/api/fiscal-years", { method: "POST", body: JSON.stringify({ companyId: coB.id, code: "INACT1", startDate: "2030-01-01", endDate: "2030-12-31" }) });
    line("Gج) لا سنوات جديدة على شركة موقوفة", fyOnInactive.status === 409 && (fyOnInactive.body as { code?: string }).code === "COMPANY_INACTIVE");
    const react = await admin.api(`/api/companies/${coB.id}`, { method: "PUT", body: JSON.stringify({ status: "ACTIVE" }) });
    line("Gد) إعادة التفعيل تعمل", react.status === 200 && (react.body as { status: string }).status === "ACTIVE");

    // H) الحذف المقيد: شركة عليها سنوات ⇒ 409 + حدث رفض؛ شركة فارغة ⇒ يُحذف
    const delBlocked = await admin.api(`/api/companies/${coA.id}`, { method: "DELETE" });
    line("Hأ) حذف شركة عليها سنوات ⇒ 409 COMPANY_DELETE_BLOCKED", delBlocked.status === 409 && (delBlocked.body as { code?: string }).code === "COMPANY_DELETE_BLOCKED");
    const emptyCo = await admin.api<CompanyLike>("/api/companies", { method: "POST", body: JSON.stringify({ code: "CO-EMPTY", nameAr: "فارغة" }) });
    const delOk = await admin.api(`/api/companies/${emptyCo.body.id}`, { method: "DELETE" });
    line("Hب) شركة فارغة تمامًا تُحذف", delOk.status === 200);
    const legacyAnchor = (await admin.api<CompanyLike[]>("/api/companies")).body.find((c) => c.code.startsWith("LEG-"));
    if (legacyAnchor) {
      const delAnchor = await admin.api(`/api/companies/${legacyAnchor.id}`, { method: "DELETE" });
      line("Hج) شركة بمرساة legacyGroupId لا تُحذف (استقرار إعادة الربط)", delAnchor.status === 409);
    }

    // ── P/Q/R/S/T) أداة الربط الخلفي ──
    // بذر سيناريو إرث داخل قاعدة الخادم: مجموعة + تقارير (مملوكة من u_g1)
    const g1User = usersList.body.find((u) => u.username === "u_g1")!.id;
    const seeded = await withClient(DB_PATH, async (c) => {
      const g = await c.group.create({ data: { name: "مجموعة إرث C", userId: g1User } });
      const r1 = await c.report.create({ data: { name: "R-مربوط", groupId: g.id, userId: g1User, periodEnd: "2026-05-31" } });
      const r2 = await c.report.create({ data: { name: "R-بلا-فترة", groupId: g.id, userId: g1User } });
      const r3 = await c.report.create({ data: { name: "R-بلا-مجموعة", groupId: null, userId: g1User } });
      return { g, r1: r1.id, r2: r2.id, r3: r3.id };
    });
    // منح u_g1 رؤية المجموعة (مطابق للسلوك القديم قبل الربط)
    await admin.api(`/api/users/${g1User}`, { method: "PUT", body: JSON.stringify({ displayName: "u_g1", role: "user", active: true, permissions: { groupIds: [seeded.g.id], view: true, add: true } }) });

    const beforeDbCounts = await withClient(DB_PATH, async (c) => ({ companies: await c.company.count(), reports: await c.report.count() }));
    const dry = spawnSync("bun", ["scripts/phase61-backfill.ts", `--db=file:${DB_PATH}`, `--report=${path.join(WORK, "dry.json")}`], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
    line("Pأ) dry-run ينجح (exit 0)", dry.status === 0, (dry.stdout + dry.stderr).split("\n").slice(-3).join(" | "));
    const dryJson = JSON.parse(readFileSync(path.join(WORK, "dry.json"), "utf8")) as { companiesProposed: number; companiesCreated: number; reportsMapped: number; reportsNoCompany: number; reportsNoPeriod: number; reportsPending: number };
    const afterDryCounts = await withClient(DB_PATH, async (c) => ({ companies: await c.company.count(), reports: await c.report.count() }));
    line("Pب) dry-run لا يكتب شيئًا", JSON.stringify(beforeDbCounts) === JSON.stringify(afterDryCounts) && dryJson.companiesCreated === 0);
    line("R) عزل NO_COMPANY للتقرير بلا مجموعة", dryJson.reportsNoCompany === 1, JSON.stringify(dryJson));
    line("S) عزل NO_PERIOD للتقرير بلا periodEnd (داخل نطاق مجموعة)", dryJson.reportsNoPeriod === 1);

    const apply = spawnSync("bun", ["scripts/phase61-backfill.ts", "--apply", `--db=file:${DB_PATH}`, `--report=${path.join(WORK, "apply.json")}`], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
    line("Qأ) apply ينجح", apply.status === 0, (apply.stdout + apply.stderr).split("\n").slice(-3).join(" | "));
    const applyJson = JSON.parse(readFileSync(path.join(WORK, "apply.json"), "utf8")) as { companiesCreated: number; companiesProposed: number; reportsMapped: number; permissionMappingsApplied: number; beforeAfter: { before: { companies: number }; after: { companies: number } } };
    line("Qب) شركة واحدة مبنية على مرساة legacyGroupId", applyJson.companiesCreated === 1 && applyJson.beforeAfter.after.companies - applyJson.beforeAfter.before.companies === 1);
    const mappedRow = await withClient(DB_PATH, async (c) => c.report.findUnique({ where: { id: seeded.r1 }, select: { backfillStatus: true, companyId: true, fiscalPeriodId: true } }));
    line("Tأ) التقرير المربوط ⇒ MAPPED + فترة حاوية مؤقتة (PROVISIONAL_IMPORTED)", mappedRow?.backfillStatus === "MAPPED" && !!mappedRow?.fiscalPeriodId);
    const periodOrigin = await withClient(DB_PATH, async (c) => c.fiscalPeriod.findUnique({ where: { id: mappedRow!.fiscalPeriodId! }, select: { fiscalYear: { select: { origin: true, code: true, confirmedAt: true } } } }));
    line("Tب) الحاوية مؤقتة تتطلب تأكيد المدير — لا ادعاء سنة ميلادية محاسبية", periodOrigin?.fiscalYear.origin === "PROVISIONAL_IMPORTED" && periodOrigin?.fiscalYear.confirmedAt === null, periodOrigin?.fiscalYear.code);
    const pendingRow = await withClient(DB_PATH, async (c) => c.report.findUnique({ where: { id: seeded.r2 }, select: { backfillStatus: true, companyId: true } }));
    line("Sب) تقرير بفترة نهاية مفقودة ⇒ NO_PERIOD مع شركة معروفة", pendingRow?.backfillStatus === "NO_PERIOD" && pendingRow?.companyId !== null);

    // U) انحدار الرؤية legacy بعد الربط: u_g1 لا يزال يرى تقارير مجموعته، وربط الصلاحيات preserve-or-narrow
    const g1After = makeSession(PORT); await g1After.login("u_g1", "Str-user-61Aa");
    const legacyReports = await g1After.api<Array<{ id: string }>>("/api/reports");
    line("Uأ) رؤية legacy سليمة: u_g1 يرى تقارير مجموعته بعد الربط", legacyReports.status === 200 && legacyReports.body.length >= 2);
    const g1Perms = await withClient(DB_PATH, async (c) => (await c.user.findUnique({ where: { id: g1User }, select: { permissions: true } }))?.permissions ?? "{}");
    const g1Parsed = JSON.parse(g1Perms) as { companyIds: string[]; viewAllCompanies: boolean };
    const mappedCompanyId = mappedRow?.companyId ?? "";
    line("Uب) preserve-or-narrow: companyIds مشتقة حصرًا من رؤية المجموعة السابقة + viewAllCompanies=false", JSON.stringify(g1Parsed.companyIds) === JSON.stringify([mappedCompanyId]) && g1Parsed.viewAllCompanies === false);
    // لا وصول جديد: u_g1 لا يرى CO-A/CO-B (غير مشتقة من مجموعاته)
    const g1Companies = await g1After.api<CompanyLike[]>("/api/companies");
    line("Uج) لا توسيع: u_g1 يرى الشركة المشتقة حصرًا (لا CO-A ولا CO-B)", g1Companies.body.length === 1 && g1Companies.body[0].id === mappedCompanyId);

    // Qج) إعادة تشغيل الأداة ⇒ idempotent (لا شركات مكررة ولا تغيير)
    const rerun = spawnSync("bun", ["scripts/phase61-backfill.ts", "--apply", `--db=file:${DB_PATH}`, `--report=${path.join(WORK, "rerun.json")}`], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
    const rerunJson = JSON.parse(readFileSync(path.join(WORK, "rerun.json"), "utf8")) as { companiesCreated: number; reportsMapped: number; reportsAlreadyMapped: number; permissionMappingsApplied: number };
    line("Qج) إعادة التشغيل idempotent (0 إنشاء، التقارير مربوطة مسبقًا، 0 تغيير صلاحيات)", rerun.status === 0 && rerunJson.companiesCreated === 0 && rerunJson.reportsAlreadyMapped >= 1 && rerunJson.permissionMappingsApplied === 0);

    // Tج) تأكيد الحاوية المؤقتة
    const fyId = await withClient(DB_PATH, async (c) => (await c.fiscalPeriod.findUnique({ where: { id: mappedRow!.fiscalPeriodId! }, select: { fiscalYearId: true } }))!.fiscalYearId);
    const confirmed = await admin.api(`/api/fiscal-years/${fyId}`, { method: "PATCH", body: JSON.stringify({ action: "confirm-provisional" }) });
    line("Tج) تأكيد الحاوية المؤقتة ⇒ origin USER_CREATED + confirmedAt", confirmed.status === 200 && (confirmed.body as { origin: string; confirmedByName: string }).origin === "USER_CREATED" && (confirmed.body as { confirmedByName: string }).confirmedByName !== "");

    // ── V) فلتر تقارير الشركة (وفاق legacy ∧ رؤية الشركة) ──
    const asAdminFiltered = await admin.api<Array<{ id: string; companyId: string | null }>>(`/api/reports?companyId=${coA.id}`);
    line("Vأ) فلتر companyId: المدير يرى تقارير الشركة فقط", asAdminFiltered.status === 200 && asAdminFiltered.body.every((r) => r.companyId === coA.id));
    const asNoneFiltered = await sNone.api(`/api/reports?companyId=${coA.id}`);
    line("Vب) فلتر لشركة غير مرئية ⇒ 403 COMPANY_NOT_VISIBLE", asNoneFiltered.status === 403 && (asNoneFiltered.body as { code?: string }).code === "COMPANY_NOT_VISIBLE");

    // ── W/X/Y) الحذف الصلب المصحح ──
    const rep = await admin.api<{ id: string; version: number }>("/api/reports", { method: "POST", body: JSON.stringify({ name: "W-قابل للحذف", label1: "أ", label2: "ب" }) });
    line("Wأ) إنشاء تقرير (CREATED صف واحد)", rep.status === 201);
    const delNoVersion = await admin.api(`/api/reports/${rep.body.id}`, { method: "DELETE", body: JSON.stringify({}) });
    line("Yأ) حذف بلا نسخة ⇒ 400 VERSION_REQUIRED", delNoVersion.status === 400 && (delNoVersion.body as { code?: string }).code === "VERSION_REQUIRED");
    const delStale = await admin.api(`/api/reports/${rep.body.id}`, { method: "DELETE", body: JSON.stringify({ version: 99 }) });
    line("Yب) حذف بنسخة قديمة ⇒ 409 VERSION_CONFLICT (التقرير قائم)", delStale.status === 409 && (delStale.body as { code?: string }).code === "VERSION_CONFLICT" && (await admin.api(`/api/reports/${rep.body.id}`)).status === 200);
    const delOk2 = await admin.api(`/api/reports/${rep.body.id}`, { method: "DELETE", body: JSON.stringify({ version: rep.body.version }) });
    line("Wب) DRAFT + cycle=1 + CREATED فقط + نسخة مطابقة ⇒ حذف ناجح", delOk2.status === 200 && (await admin.api(`/api/reports/${rep.body.id}`)).status === 404);

    // X) رفض الحذف بعد كل نوع حدث دخول دورة (كل الأنواع)
    const HISTORY_ACTIONS = ["SUBMITTED", "RESUBMITTED", "REVIEW_STARTED", "REVIEW_COMPLETED", "RETURNED", "APPROVED", "REOPENED", "RESUMED_EDIT", "ASSIGNMENT_CHANGED"];
    let xAll = true;
    const xDetails: string[] = [];
    for (const action of HISTORY_ACTIONS) {
      const r = await admin.api<{ id: string }>("/api/reports", { method: "POST", body: JSON.stringify({ name: `X-${action}` }) });
      const rid = r.body.id;
      // أدخل صف تاريخ إضافي مباشرة في القاعدة (محاكاة كل أنواع الأحداث)
      await withClient(DB_PATH, async (c) => {
        await c.workflowHistory.create({ data: { reportId: rid, cycle: 1, action, actorId: null, actorUsername: "harness" } });
      });
      const del = await admin.api(`/api/reports/${rid}`, { method: "DELETE", body: JSON.stringify({ version: 1 }) });
      const ok = del.status === 403 && (del.body as { code?: string }).code === "HARD_DELETE_DENIED";
      if (!ok) xAll = false;
      xDetails.push(`${action}=${del.status}`);
    }
    line("Xأ) كل نوع حدث تاريخي يمنع الحذف الصلب (9 أنواع)", xAll, xDetails.join(","));
    // الدورة 2: عاد DRAFT لكنه ليس قابلًا للحذف
    const r2 = await admin.api<{ id: string }>("/api/reports", { method: "POST", body: JSON.stringify({ name: "X-cycle2" }) });
    await withClient(DB_PATH, async (c) => {
      await c.report.update({ where: { id: r2.body.id }, data: { cycle: 2 } });
    });
    const delCycle2 = await admin.api(`/api/reports/${r2.body.id}`, { method: "DELETE", body: JSON.stringify({ version: 1 }) });
    line("Xب) cycle=2 ⇒ رفض (حتى لو DRAFT وCREATED فقط)", delCycle2.status === 403 && (delCycle2.body as { code?: string }).code === "HARD_DELETE_DENIED");

    // ── تدقيق: أحداث 6.1 مكتوبة ──
    const audit = await withClient(DB_PATH, async (c) => {
      const rows = await c.auditLog.findMany({ where: { action: { in: ["COMPANY_CREATED", "COMPANY_DEACTIVATED", "COMPANY_REACTIVATED", "COMPANY_DELETE_DENIED", "FISCAL_YEAR_CREATED", "FISCAL_YEAR_BULK_CREATED", "FISCAL_YEAR_CLOSED", "FISCAL_YEAR_LOCKED", "FISCAL_YEAR_UNLOCKED", "FISCAL_YEAR_REOPENED", "FISCAL_PERIOD_STATUS_CHANGED", "PERMISSIONS_CHANGED", "BACKFILL_APPLIED"] } }, select: { action: true }, distinct: ["action"] });
      return rows.map((r) => r.action).sort();
    });
    line("Kأ) أحداث التدقيق 6.1 مكتوبة فعليًا", audit.length >= 11, audit.join(","));

  } finally {
    await stopServer(srv);
  }
}

/* ═══════════════════════ التشغيل ═══════════════════════ */

async function main(): Promise<void> {
  console.log("═════════ Phase 6.1 — Financial Platform Foundation — Test Gate ═════════");
  await partA();
  await partB();
  await partC();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n═════════ النتيجة: ${pass}/${results.length} ${failure ? "— FAIL ❌" : "— PASS ✅"} ═════════`);
  if (failure) {
    console.log("\nالفحوصات الفاشلة:");
    for (const r of results.filter((r) => !r.ok)) console.log(`  ❌ ${r.name} — ${r.detail}`);
  }
  process.exit(failure ? 1 : 0);
}

main().catch((e) => {
  console.error("HARNESS_CRASH", e);
  process.exit(1);
});
