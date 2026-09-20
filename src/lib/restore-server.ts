// Phase 4B.1 — محرك الاستعادة الفعلية (Production Restore Engine) — خادم فقط.
//
// التزامات ثابتة في هذا الملف (نص المستخدم):
//   1. تسلسل التبديل الحرفي: صيانة حجب كامل → قطع Prisma → تعامل آمن مع
//      WAL/SHM → وضع المرشحة في نفس filesystem → rename ذري → معالجة
//      WAL/SHM القديمة → إعادة الاتصال → تفعيل WAL → التحقق.
//   2. نسخة أمان pre-restore إلزامية قبل أي تبديل: تُنشأ backupType=pre-restore
//      ثم VALIDATED ثم RESTORE_VERIFIED — إن لم تصل ⇒ إلغاء. لا bypass حتى للمدير.
//   3. المرشحة تقبل RESTORE_VERIFIED فقط + توافق canonical — أقدم معروفة تحتاج
//      migrations تُطبق على مؤقتة أولًا ثم يُعاد Drill عليها (لا migration تجريبية
//      على Production — المسار خاملاً اليوم: لا توجد مخططات أقدم مسجلة).
//   4. DRAINING: لا كتابة جديدة + انتظار صفر كتابات جارية بمهلة — تجاوزها ⇒
//      إلغاء قبل التبديل. لا نقتل كتابة جارية ثم نستبدل القاعدة تحتها أبدًا.
//   5. Post-Verify على القاعدة الجديدة مباشرة (fs + Prisma حقيقي + prisma CLI)
//      — لا اعتماد على HTTP APIs وهي في الصيانة.
//   6. فشل أي فحص بعدي ⇒ بقاء في الصيانة + تراجع تلقائي من pre-restore
//      (المسحوبة Drill لها مسبقًا) + إعادة نفس التحقق. نجاحه ⇒ epoch+1 →
//      ROLLED_BACK → NORMAL. فشله ⇒ RECOVERY_REQUIRED (قفل كامل، لا reset تلقائي).
//   7. epoch+1 بعد كل تبديل ناجح (استعادة أو تراجع) — فشل الرفع المستمر ⇒
//      RECOVERY_REQUIRED (fail-closed — جلسات قديمة فوق صلاحيات قديمة لا تُقبل).
//   8. الحالة التشغيلية خارج القاعدة في VAR_DIR بكتابة ذرية — وCrash Recovery:
//      أي حالة غير NORMAL عند الإقلاع ⇒ RECOVERY_REQUIRED (لا افتراض نجاح).
//   9. سياسة المحاسبة الموثقة: الدليل الحاكم لأحداث الاستعادة هو سجل عمليات
//      الاسترجاع الخارجي (يعيش خارج القاعدة المستبدلة). AuditLog يُكتب فيه فقط
//      في المراحل الآمنة قبل التبديل (INITIATED/ABORTED) وصف واحد append-only
//      بعد نجاح العملية داخل القاعدة الجديدة بطابعها الزمني الحالي (لا صفوف
//      مصطنعة ولا إعادة ترتيب تاريخي أبدًا).
//  10. لا أسرار ولا بيانات مالية في أي سجل/تقرير — Sanitizer مركزي.

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

import { db as liveDb, reconnectDb } from "@/lib/db";
import {
  MAINTENANCE_READ_DRAIN_MS,
  RESTORE_TOTAL_TIMEOUT_MS,
  ensurePrivateDir,
  getCurrentCanonicalSchemaFingerprint,
  isRestoreEngineEnabled,
  newOperationId,
  resolveBackupDir,
  resolveDatabaseFilePath,
  resolveSwapDir,
} from "@/lib/backup-config";
import {
  activeReadCount,
  clearMaintenanceStateFile,
  clearPhantomWrites,
  drainActiveReadsBestEffort,
  drainActiveWrites,
  enterRecoveryRequired,
  readMaintenanceStateFile,
  transitionMaintenanceState,
  type MaintenanceStateFile,
} from "@/lib/maintenance";
import { bumpSessionEpoch, readSessionEpoch } from "@/lib/session-epoch";
import { acquireOperationLock, OperationLockBusyError } from "@/lib/recovery-lock";
import { appendRecoveryEvent } from "@/lib/recovery-log";
import {
  BackupError,
  createBackup,
  findArtifactById,
  runRestoreDrillById,
  validateBackupArtifact,
  type ActorInfo,
  type CheckResult,
} from "@/lib/backup-server";
import {
  collectCounts,
  collectPeriodRange,
  type AnyBackupManifest,
} from "@/lib/backup-manifest";
import { canonicalSchemaFingerprint as computeCanonicalFingerprint } from "@/lib/schema-fingerprint";
import { inspectZipBuffer, readZipEntry } from "@/lib/zip-secure";
import {
  faultInjectionEnabled,
  maybeCrash,
  maybeStall,
  shouldFail,
  testDrainTimeoutMs,
  testPhantomWriteCount,
  testTotalTimeoutMs,
} from "@/lib/fault-injection";
import { writeAuditSafe } from "@/lib/audit";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";

/* ──────────────────────────────────────────────────────────────────────── */
/*  الأخطاء المنظمة                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

export class RestoreError extends Error {
  code: string;
  httpStatus: number;
  extra?: Record<string, unknown>;
  constructor(code: string, message: string, httpStatus = 400, extra?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.extra = extra;
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  الأنواع العامة                                                           */
/* ──────────────────────────────────────────────────────────────────────── */

export interface RestorePhaseRecord {
  phase: string;
  state: string;
  ms: number;
  detail?: string;
}

export interface RestoreOutcome {
  ok: boolean;
  operationId: string;
  backupId: string;
  /** COMPLETED | ROLLED_BACK | ABORTED | RECOVERY_REQUIRED */
  result: "COMPLETED" | "ROLLED_BACK" | "ABORTED" | "RECOVERY_REQUIRED";
  preRestoreBackupId: string | null;
  epochBumped: boolean;
  newEpoch: number | null;
  phases: RestorePhaseRecord[];
  postVerify: CheckResult[] | null;
  rollbackVerify: CheckResult[] | null;
  abortReason: string | null;
  warnings: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

interface EngineContext {
  opId: string;
  actor: ActorInfo;
  backupId: string;
  artifactZipPath: string;
  manifest: AnyBackupManifest;
  deadline: number;
  startedAtIso: string;
  phases: RestorePhaseRecord[];
  warnings: string[];
  preRestoreBackupId: string | null;
  swapCompleted: boolean;
  disconnected: boolean;
  stagingCandidatePath: string | null;
  replacedPath: string | null;
}

function phase<T>(ctx: EngineContext, phaseName: string, state: string, fn: () => Promise<T>, detail?: () => string): Promise<T> {
  return (async () => {
    const t0 = Date.now();
    try {
      const result = await fn();
      ctx.phases.push({ phase: phaseName, state, ms: Date.now() - t0, ...(detail ? { detail: detail() } : {}) });
      return result;
    } catch (e) {
      ctx.phases.push({
        phase: phaseName,
        state: `${state}:FAILED`,
        ms: Date.now() - t0,
        detail: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  })();
}

function checkDeadline(ctx: EngineContext): boolean {
  return Date.now() < ctx.deadline;
}

function shortFp(fp: string): string {
  return fp.replace(/^(c)?sha256:/, "").slice(0, 12);
}

function hashFileSync(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  مؤشر نضارة حالة الإنتاج — heuristic موثق (آخر حدث AuditLog)              */
/* ──────────────────────────────────────────────────────────────────────── */

async function productionFreshnessMarker(): Promise<string | null> {
  const rows = await liveDb.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { createdAt: true },
  });
  return rows[0]?.createdAt?.toISOString() ?? null;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  المعاينة — بنود التأكيد القوية قبل التنفيذ (القسم 14 من وثيقة التصميم)   */
/* ──────────────────────────────────────────────────────────────────────── */

export interface RestorePreview {
  engineEnabled: boolean;
  candidate: {
    backupId: string;
    createdAt: string;
    backupType: string;
    level: string;
    schemaVersion: string;
    checksumShort: string;
    canonicalFingerprintShort: string;
    dbBytes: number;
    counts: AnyBackupManifest["counts"] | null;
    periodRange: AnyBackupManifest["periodRange"] | null;
    source: string;
  } | null;
  current: {
    counts: AnyBackupManifest["counts"] | null;
    freshnessMarker: string | null;
  } | null;
  downgradeRequired: boolean;
  downgradeReasons: string[];
  requiredConfirmations: { primary: "RESTORE"; secondary: string | null };
  error: { code: string; message: string } | null;
}

export async function buildRestorePreview(backupId: string): Promise<RestorePreview> {
  const base: RestorePreview = {
    engineEnabled: isRestoreEngineEnabled(),
    candidate: null,
    current: null,
    downgradeRequired: false,
    downgradeReasons: [],
    requiredConfirmations: { primary: "RESTORE", secondary: null },
    error: null,
  };
  const artifact = findArtifactById(backupId);
  if (!artifact) {
    return { ...base, error: { code: "NOT_FOUND", message: "لا توجد نسخة بهذا المعرف" } };
  }
  const m = artifact.manifest;
  base.candidate = {
    backupId: m.backupId,
    createdAt: m.createdAt,
    backupType: m.backupType,
    level: m.verification.level,
    schemaVersion: m.schemaVersion,
    checksumShort: m.database.sha256.slice(0, 12),
    canonicalFingerprintShort: m.formatVersion === 3 ? shortFp(m.canonicalSchemaFingerprint) : "(legacy-v2)",
    dbBytes: m.database.bytes,
    counts: m.counts,
    periodRange: m.periodRange,
    source: artifact.source,
  };
  try {
    const currentCounts = await collectCounts(liveDb);
    const freshness = await productionFreshnessMarker();
    base.current = {
      counts: currentCounts.ok ? currentCounts.counts : null,
      freshnessMarker: freshness,
    };
    if (currentCounts.ok) {
      const reasons: string[] = [];
      if (m.counts.reports < currentCounts.counts.reports) {
        reasons.push(
          `ستقلل عدد التقارير: النسخة ${m.counts.reports} مقابل الحالي ${currentCounts.counts.reports}`
        );
      }
      if (freshness && m.createdAt < freshness) {
        reasons.push("النسخة أقدم من آخر نشاط مسجل في قاعدة التشغيل الحالية");
      }
      base.downgradeRequired = reasons.length > 0;
      base.downgradeReasons = reasons;
      base.requiredConfirmations.secondary = reasons.length > 0 ? m.backupId : null;
    }
  } catch (e) {
    base.error = { code: "PROBE_FAILED", message: `تعذر قراءة حالة الإنتاج الحالية: ${String(e)}` };
  }
  return base;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  التحقق البعدي — مباشرة على القاعدة (fs + Prisma + prisma CLI) بلا HTTP    */
/* ──────────────────────────────────────────────────────────────────────── */

async function runPostVerification(args: {
  client: PrismaClient;
  dbPath: string;
  manifest: AnyBackupManifest;
  label: string;
}): Promise<CheckResult[]> {
  const { client, dbPath, manifest, label } = args;
  const checks: CheckResult[] = [];
  const t = (name: string, code: string, ok: boolean, detail?: string, faultPoint?: string): boolean => {
    if (faultPoint && shouldFail(faultPoint)) {
      checks.push({ name, code: `${code}_INJECTED_FAIL`, ok: false, detail: "فشل محقون للاختبار (بيئة معزولة حصرًا)" });
      return false;
    }
    checks.push({ name, code, ok, ...(detail ? { detail } : {}) });
    return ok;
  };

  // 1) ترويسة SQLite من القرص مباشرة
  const t0 = Date.now();
  try {
    const fd = readFileSync(dbPath);
    const magic = Buffer.from("SQLite format 3\0");
    const headerOk = fd.length >= 16 && fd.subarray(0, 16).equals(magic);
    if (!t("ترويسة SQLite على الملف المستبدل", "SQLITE_HEADER_OK", headerOk, undefined, `${label}_HEADER`)) {
      return checks;
    }
  } catch (e) {
    checks.push({ name: "ترويسة SQLite على الملف المستبدل", code: "SQLITE_HEADER_FAIL", ok: false, detail: String(e) });
    return checks;
  }
  void t0;

  // 2) integrity_check
  try {
    const integ = await client.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`);
    const ok = (integ[0]?.integrity_check ?? "") === "ok";
    if (!t("integrity_check على القاعدة المستبدلة", "INTEGRITY_OK", ok, integ[0]?.integrity_check, `${label}_INTEGRITY`)) {
      return checks;
    }
  } catch (e) {
    checks.push({ name: "integrity_check على القاعدة المستبدلة", code: "INTEGRITY_FAIL", ok: false, detail: String(e) });
    return checks;
  }

  // 3) canonical fingerprint == الثابت المثبّت/الحالي
  try {
    const canonical = await computeCanonicalFingerprint(client);
    const expected = getCurrentCanonicalSchemaFingerprint();
    const ok = !!expected && canonical === expected;
    if (
      !t(
        "تطابق البصمة القاعدية الدلالية (canonical)",
        "CANONICAL_FINGERPRINT_OK",
        ok,
        `actual=${shortFp(canonical)} expected=${expected ? shortFp(expected) : "unpinned"}`,
        `${label}_FINGERPRINT`
      )
    ) {
      return checks;
    }
  } catch (e) {
    checks.push({ name: "تطابق البصمة القاعدية الدلالية (canonical)", code: "CANONICAL_FINGERPRINT_FAIL", ok: false, detail: String(e) });
    return checks;
  }

  // 4) prisma migrate status (عملية فرعية — بلا HTTP)
  try {
    const res = spawnSync("bunx", ["prisma", "migrate", "status"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      encoding: "utf8",
      timeout: 30_000,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    const upToDate = /up to date/i.test(out) || /Database schema is up to date/i.test(out);
    const ok = res.status === 0 && upToDate;
    if (
      !t(
        "prisma migrate status — المخطط محدّث",
        "MIGRATE_STATUS_OK",
        ok,
        upToDate ? "up to date" : out.slice(0, 200),
        `${label}_MIGRATE`
      )
    ) {
      return checks;
    }
  } catch (e) {
    checks.push({ name: "prisma migrate status — المخطط محدّث", code: "MIGRATE_STATUS_FAIL", ok: false, detail: String(e) });
    return checks;
  }

  // 5) اتصال Prigma حقيقي + قراءة الجداول الخمسة + مطابقة counts مع Manifest
  try {
    const countsRes = await collectCounts(client);
    if (!countsRes.ok) {
      checks.push({ name: "قراءة الجداول الإلزامية عبر Prisma", code: "TABLES_FAIL", ok: false, detail: "أحد الجداول غير متوافق" });
      return checks;
    }
    const countsMatched =
      countsRes.counts.users === manifest.counts.users &&
      countsRes.counts.groups === manifest.counts.groups &&
      countsRes.counts.reports === manifest.counts.reports &&
      countsRes.counts.workflowHistory === manifest.counts.workflowHistory &&
      countsRes.counts.auditLog === manifest.counts.auditLog;
    if (
      !t(
        "قراءة الجداول الأساسية + مطابقة counts مع Manifest المرشحة",
        "COUNTS_OK",
        countsMatched,
        JSON.stringify({ manifest: manifest.counts, actual: countsRes.counts }),
        `${label}_COUNTS`
      )
    ) {
      return checks;
    }
  } catch (e) {
    checks.push({ name: "قراءة الجداول الأساسية + مطابقة counts مع Manifest المرشحة", code: "COUNTS_FAIL", ok: false, detail: String(e) });
    return checks;
  }

  // 6) periodRange مقابل Manifest
  try {
    const periodRange = await collectPeriodRange(client);
    const matched =
      periodRange.minPeriodEnd === manifest.periodRange.minPeriodEnd &&
      periodRange.maxPeriodEnd === manifest.periodRange.maxPeriodEnd;
    if (!t("مطابقة periodRange مع Manifest", "PERIOD_OK", matched, undefined, `${label}_PERIOD`)) {
      return checks;
    }
  } catch (e) {
    checks.push({ name: "مطابقة periodRange مع Manifest", code: "PERIOD_FAIL", ok: false, detail: String(e) });
    return checks;
  }

  // 7) وجود مستخدم صالح واحد على الأقل
  try {
    const activeUsers = await client.user.count({ where: { active: true } });
    if (!t("وجود مستخدم صالح واحد على الأقل", "ACTIVE_USER_OK", activeUsers >= 1, `active=${activeUsers}`, `${label}_USERS`)) {
      return checks;
    }
  } catch (e) {
    checks.push({ name: "وجود مستخدم صالح واحد على الأقل", code: "ACTIVE_USER_FAIL", ok: false, detail: String(e) });
    return checks;
  }

  return checks;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  التعامل الآمن مع WAL/SHM + التبديل الذري                                 */
/* ──────────────────────────────────────────────────────────────────────── */

async function checkpointAndRemoveWal(dbPath: string): Promise<void> {
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  let walBytes = 0;
  try {
    if (existsSync(walPath)) walBytes = statSync(walPath).size;
  } catch {
    /* ignore */
  }
  if (walBytes > 0) {
    // نقطة تفتيش آمنة عبر اتصال قصير — كل بيانات WAL تُدمج في الملف الرئيسي
    let probe: PrismaClient | null = null;
    try {
      probe = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } }, log: [] });
      await probe.$queryRawUnsafe(`PRAGMA wal_checkpoint(TRUNCATE)`);
      await probe.$disconnect();
      probe = null;
    } catch {
      try {
        await probe?.$disconnect();
      } catch {
        /* ignore */
      }
    }
  }
  // بعد التفتيش/الإغلاق النظيف: أي -wal/-shm متبقية فارغة وتُزال بأمان
  for (const p of [walPath, shmPath]) {
    try {
      if (existsSync(p)) rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function assertSameFilesystem(a: string, b: string): boolean {
  // كلاهما داخل مجلد قاعدة التشغيل نفسه — بنيويًا نفس filesystem (تصميم ثابت)
  return path.dirname(a) === path.dirname(b);
}

/**
 * التبديل الذري: قديمة → staging (نفس المجلد)، المرشحة → مسار القاعدة.
 * عند فشل rename الثاني يُعاد الأول فورًا (لا حالة وسيطة نصف مكتملة).
 */
function atomicSwapFiles(args: { dbPath: string; candidatePath: string; replacedPath: string }): void {
  const { dbPath, candidatePath, replacedPath } = args;
  if (!assertSameFilesystem(candidatePath, dbPath)) {
    throw new RestoreError("CROSS_FILESYSTEM", "المرشحة ليست في نفس filesystem القاعدة — يجب staging داخل مجلد القاعدة", 500);
  }
  renameSync(dbPath, replacedPath); // القديمة جانبًا (نفس fs — ذري)
  try {
    renameSync(candidatePath, dbPath); // المرشحة مكانها (نفس fs — ذري)
  } catch (e) {
    // إعادة الترتيب: القديمة تعود مكانها — القاعدة كما كانت حرفيًا
    try {
      renameSync(replacedPath, dbPath);
    } catch {
      /* لا شيء أفضل — يُكتشف في post-verify أو crash recovery */
    }
    throw e;
  }
}

/** استخراج database.db من ZIP المرشحة إلى staging داخل مجلد القاعدة + تحقق checksum. */
async function stageCandidateDb(args: {
  zipPath: string;
  manifest: AnyBackupManifest;
  targetPath: string;
}): Promise<void> {
  const { zipPath, manifest, targetPath } = args;
  const zipBuf = readFileSync(zipPath);
  const inspected = inspectZipBuffer(zipBuf, {
    maxUncompressedBytes: 2_000_000_000,
    maxEntries: 4,
    allowedNames: ["database.db", "manifest.json"],
    maxRatio: 2000,
  });
  if (!inspected.ok) {
    throw new RestoreError("CANDIDATE_PACKAGE_BAD", `حزمة المرشحة مرفوضة: ${inspected.code}`, 422);
  }
  const dbBytes = await readZipEntry(zipBuf, "database.db", 2_000_000_000);
  if ("ok" in dbBytes && !dbBytes.ok) {
    throw new RestoreError("CANDIDATE_PACKAGE_BAD", "database.db داخل حزمة المرشحة غير قابل للقراءة", 422);
  }
  const buf = dbBytes as Buffer;
  const magic = Buffer.from("SQLite format 3\0");
  if (buf.length < 16 || !buf.subarray(0, 16).equals(magic)) {
    throw new RestoreError("NOT_SQLITE", "database.db داخل المرشحة ليس SQLite", 422);
  }
  const actualSha = createHash("sha256").update(buf).digest("hex");
  if (actualSha !== manifest.database.sha256) {
    throw new RestoreError("CHECKSUM_MISMATCH", "checksum المرشحة لا يطابق Manifest — رفض قاطع", 422);
  }
  ensurePrivateDir(path.dirname(targetPath));
  writeFileSync(targetPath, buf, { mode: 0o600 });
  // إعادة تحقق من القرص بعد الكتابة (نفس filesystem الهدف — rename ذري لاحقًا)
  const onDiskSha = hashFileSync(targetPath);
  if (onDiskSha !== manifest.database.sha256) {
    throw new RestoreError("CHECKSUM_MISMATCH", "checksum المرشحة على القرص لا يطابق Manifest", 422);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  رفع epoch بعد كل تبديل ناجح — فشل مستمر ⇒ RECOVERY_REQUIRED (fail-closed) */
/* ──────────────────────────────────────────────────────────────────────── */

async function bumpEpochWithRetry(): Promise<number | null> {
  for (let i = 0; i < 3; i++) {
    if (shouldFail("EPOCH_BUMP")) return null;
    const next = bumpSessionEpoch();
    if (next !== null) return next;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  التنفيذ الكامل                                                            */
/* ──────────────────────────────────────────────────────────────────────── */

export async function executeRestore(args: {
  backupId: string;
  actor: ActorInfo;
  confirmationText: string;
  downgradeConfirmation?: string | null;
}): Promise<RestoreOutcome> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // ── Phase 0: شروط مسبقة قبل أي تغيير حالة ──────────────────────────────
  if (!isRestoreEngineEnabled()) {
    throw new RestoreError(
      "RESTORE_ENGINE_DISABLED",
      "محرك الاستعادة الفعلية معطّل في هذه البيئة — التفعيل يجري في 4B.2 بموافقة صريحة",
      409
    );
  }
  if (readSessionEpoch() === null) {
    throw new RestoreError(
      "EPOCH_UNAVAILABLE",
      "عدّاد الجلسات غير قابل للقراءة — لا استعادة قبل استرداد العدّاد (fail-safe)",
      503
    );
  }

  const preState = readMaintenanceStateFile();
  if (preState && preState.state !== "NORMAL") {
    throw new RestoreError(
      "RECOVERY_OPERATION_IN_PROGRESS",
      `لا يمكن بدء استعادة — الحالة التشغيلية الحالية: ${preState.state}${preState.operationId ? ` (${preState.operationId})` : ""}`,
      409,
      { currentState: preState.state, currentOperationId: preState.operationId }
    );
  }

  const artifact = findArtifactById(args.backupId);
  if (!artifact) throw new RestoreError("NOT_FOUND", "لا توجد نسخة بهذا المعرف", 404);
  if (artifact.manifest.verification.level !== "RESTORE_VERIFIED") {
    const opId = newOperationId("restore");
    await appendRecoveryEvent({
      operationId: opId,
      event: "RESTORE_REJECTED",
      actor: args.actor,
      backupId: args.backupId,
      result: "failure",
      details: { reason: "CANDIDATE_NOT_RESTORE_VERIFIED", level: artifact.manifest.verification.level },
    });
    throw new RestoreError(
      "CANDIDATE_NOT_RESTORE_VERIFIED",
      `المرشحة بمستوى ${artifact.manifest.verification.level} — الاستعادة الفعلية تقبل RESTORE_VERIFIED فقط`,
      409
    );
  }

  // قفل الاسترجاع الخارجي — ثاني عملية ⇒ 409
  let lock;
  try {
    lock = await acquireOperationLock({ kind: "restore", username: args.actor.username });
  } catch (e) {
    if (e instanceof OperationLockBusyError) {
      throw new RestoreError(
        "RECOVERY_OPERATION_IN_PROGRESS",
        e.holder
          ? `عملية استرجاع قيد التنفيذ (${e.holder.kind}) — المحاولة الثانية مرفوضة`
          : "عملية استرجاع قيد التنفيذ — المحاولة الثانية مرفوضة",
        409,
        { holderOperationId: e.holder?.operationId ?? null }
      );
    }
    throw e;
  }

  const ctx: EngineContext = {
    opId: newOperationId("restore"),
    actor: args.actor,
    backupId: args.backupId,
    artifactZipPath: artifact.zipPath,
    manifest: artifact.manifest,
    deadline: Date.now() + testTotalTimeoutMs(RESTORE_TOTAL_TIMEOUT_MS),
    startedAtIso: startedAt,
    phases: [],
    warnings: [],
    preRestoreBackupId: null,
    swapCompleted: false,
    disconnected: false,
    stagingCandidatePath: null,
    replacedPath: null,
  };

  try {
    await appendRecoveryEvent({
      operationId: ctx.opId,
      event: "RESTORE_STARTED",
      actor: ctx.actor,
      backupId: ctx.backupId,
      result: "info",
      details: {
        candidateLevel: ctx.manifest.verification.level,
        ...(lock.stoleFrom ? { staleLockStolenFrom: lock.stoleFrom.operationId } : {}),
      },
    });

    // ── شروط التأكيد القوية (server-side حصرًا — لا ثقة بالعميل) ──────────
    if (args.confirmationText !== "RESTORE") {
      await appendRecoveryEvent({
        operationId: ctx.opId,
        event: "RESTORE_REJECTED",
        actor: ctx.actor,
        backupId: ctx.backupId,
        result: "failure",
        details: { reason: "CONFIRMATION_INVALID" },
      });
      throw new RestoreError("CONFIRMATION_INVALID", "التأكيد الأول غير صحيح — يجب كتابة RESTORE حرفيًا", 400);
    }
    const currentCounts = await collectCounts(liveDb);
    const freshness = await productionFreshnessMarker();
    const downgradeReasons: string[] = [];
    if (currentCounts.ok && ctx.manifest.counts.reports < currentCounts.counts.reports) {
      downgradeReasons.push("reports_reduction");
    }
    if (freshness && ctx.manifest.createdAt < freshness) {
      downgradeReasons.push("older_than_current_activity");
    }
    if (downgradeReasons.length > 0 && args.downgradeConfirmation !== args.backupId) {
      await appendRecoveryEvent({
        operationId: ctx.opId,
        event: "RESTORE_REJECTED",
        actor: ctx.actor,
        backupId: ctx.backupId,
        result: "failure",
        details: { reason: "SECOND_CONFIRMATION_REQUIRED", downgradeReasons },
      });
      throw new RestoreError(
        "SECOND_CONFIRMATION_REQUIRED",
        "تأكيد ثانٍ إلزامي: النسخة أقدم من الحالة الحالية أو ستقلل عدد التقارير — اكتب معرف النسخة كاملًا",
        409,
        { downgradeReasons, requiredText: args.backupId }
      );
    }

    // صف AuditLog قبل أي تبديل — القاعدة ما زالت الحالية (سياسة موثقة)
    await writeAuditSafe({
      user: { id: ctx.actor.id, username: ctx.actor.username },
      action: AUDIT_ACTIONS.DATABASE_RESTORE_INITIATED,
      entityType: AUDIT_ENTITY_TYPES.Backup,
      entityId: ctx.backupId,
      description: `بدء عملية استعادة إلى النسخة «${ctx.backupId}» — عملية ${ctx.opId}`,
      metadata: { backupId: ctx.backupId, operationId: ctx.opId, downgradeReasons },
    });

    // ── VALIDATING (write-block): إعادة تحقق فعلي من محتوى المرشحة ────────
    await phase(ctx, "VALIDATING", "VALIDATING", async () => {
      transitionMaintenanceState({
        operationId: ctx.opId,
        state: "VALIDATING",
        startedBy: { id: ctx.actor.id, username: ctx.actor.username },
        message: "إعادة تحقق فعلي من النسخة المرشحة قبل أي إجراء تدميري",
        flags: { candidateBackupId: ctx.backupId, swapCompleted: false },
      });
      await appendRecoveryEvent({
        operationId: ctx.opId,
        event: "MAINTENANCE_ENTERED",
        actor: ctx.actor,
        backupId: ctx.backupId,
        result: "info",
        details: { state: "VALIDATING", level: "write-block" },
      });
      await maybeStall("VALIDATING_STALL");
      maybeCrash("VALIDATING_CRASH");
      if (shouldFail("CANDIDATE_VALIDATION")) {
        throw new RestoreError("CANDIDATE_VALIDATION_FAILED", "فشل محقون في إعادة تحقق المرشحة (اختبار معزول)", 500);
      }
      const report = await validateBackupArtifact({
        zipPath: ctx.artifactZipPath,
        actor: ctx.actor,
        source: "local",
        operationId: newOperationId("validate"),
      });
      await appendRecoveryEvent({
        operationId: ctx.opId,
        event: "CANDIDATE_VERIFIED",
        actor: ctx.actor,
        backupId: ctx.backupId,
        result: "success",
        details: {
          level: report.level,
          canonical: report.canonicalSchemaFingerprint ? shortFp(report.canonicalSchemaFingerprint) : null,
          durationMs: report.durationMs,
        },
      });
      return report;
    });

    // ── PREPARING (write-block): نسخة الأمان الإلزامية بلا bypass ─────────
    await phase(ctx, "PREPARING", "PREPARING", async () => {
      if (!checkDeadline(ctx)) throw new RestoreError("TIMEOUT", "تجاوز المهلة الإجمالية قبل نسخة الأمان", 504);
      transitionMaintenanceState({
        operationId: ctx.opId,
        state: "PREPARING",
        message: "إنشاء نسخة أمان pre-restore والتحقق منها بالDrill — إلزامية بلا bypass",
      });
      await appendRecoveryEvent({
        operationId: ctx.opId,
        event: "PRE_RESTORE_STARTED",
        actor: ctx.actor,
        backupId: ctx.backupId,
        result: "info",
        details: { backupType: "pre-restore" },
      });
      if (shouldFail("PRE_RESTORE_BACKUP")) {
        throw new RestoreError("PRE_RESTORE_BACKUP_FAILED", "فشل محقون في إنشاء نسخة الأمان (اختبار معزول)", 500);
      }
      const pre = await createBackup(ctx.actor, {
        backupType: "pre-restore",
        bypassCooldown: true,
        trigger: `restore:${ctx.opId}`,
      });
      ctx.preRestoreBackupId = pre.backupId;
      if (shouldFail("PRE_RESTORE_DRILL")) {
        throw new RestoreError("PRE_RESTORE_DRILL_FAILED", "فشل محقون في Drill نسخة الأمان (اختبار معزول)", 500);
      }
      const preLevel = pre.level;
      if (preLevel !== "VALIDATED") {
        throw new RestoreError("PRE_RESTORE_NOT_VALIDATED", `نسخة الأمان بمستوى ${preLevel} — الإلزام VALIDATED فأعلى`, 500);
      }
      await runRestoreDrillById(pre.backupId, ctx.actor);
      transitionMaintenanceState({
        operationId: ctx.opId,
        state: "PREPARING",
        message: "نسخة الأمان وصلت RESTORE_VERIFIED",
        flags: { preRestoreBackupId: pre.backupId },
      });
      await appendRecoveryEvent({
        operationId: ctx.opId,
        event: "PRE_RESTORE_VERIFIED",
        actor: ctx.actor,
        backupId: pre.backupId,
        result: "success",
        details: { candidateBackupId: ctx.backupId, level: "RESTORE_VERIFIED" },
      });
    });

    // ── DRAINING (write-block): لا كتابة جديدة + انتظار الصفر بمهلة ───────
    await phase(ctx, "DRAINING", "DRAINING", async () => {
      transitionMaintenanceState({
        operationId: ctx.opId,
        state: "DRAINING",
        message: "حجب كتابات جديدة وانتظار انتهاء الكتابات الجارية — لا قتل لكتابة جارية",
      });
      const phantom = faultInjectionEnabled() ? testPhantomWriteCount() : 0;
      if (phantom > 0) {
        const { addPhantomWrite } = await import("@/lib/maintenance");
        for (let i = 0; i < phantom; i++) addPhantomWrite("fault-injection:phantom-write");
      }
      const drained = await drainActiveWrites(testDrainTimeoutMs(30_000));
      clearPhantomWrites();
      if (!drained) {
        throw new RestoreError("DRAIN_TIMEOUT", "انتهت مهلة تصريف الكتابات الجارية — إلغاء قبل التبديل", 504);
      }
      await appendRecoveryEvent({
        operationId: ctx.opId,
        event: "DRAIN_COMPLETED",
        actor: ctx.actor,
        backupId: ctx.backupId,
        result: "success",
        details: { activeWrites: 0 },
      });
    });

    // ── SWAPPING (full-block): القراءة محجوبة أيضًا ────────────────────────
    await phase(ctx, "SWAPPING", "SWAPPING", async () => {
      if (!checkDeadline(ctx)) throw new RestoreError("TIMEOUT", "تجاوز المهلة الإجمالية عند التبديل", 504);
      transitionMaintenanceState({
        operationId: ctx.opId,
        state: "SWAPPING",
        message: "حجب كامل — قطع Prisma ثم تبديل ذري",
      });
      await appendRecoveryEvent({
        operationId: ctx.opId,
        event: "SWAP_STARTED",
        actor: ctx.actor,
        backupId: ctx.backupId,
        result: "info",
        details: { level: "full-block" },
      });
      // نافذة فحص سلوكية للاختبار: قراءة/كتابة أثناء SWAPPING ⇒ 503
      await maybeStall("SWAP_BEGIN_STALL");
      maybeCrash("SWAP_STARTED_CRASH"); // crash بعد SWAP_STARTED وقبل SWAP_COMPLETED

      if (shouldFail("DISCONNECT")) {
        throw new RestoreError("DISCONNECT_FAILED", "فشل محقون في قطع الاتصال (اختبار معزول)", 500);
      }
      // تصريف القراءات بأفضل جهد ثم قطع Prisma
      await drainActiveReadsBestEffort(MAINTENANCE_READ_DRAIN_MS);
      await liveDb.$disconnect();
      ctx.disconnected = true;
      await appendRecoveryEvent({
        operationId: ctx.opId,
        event: "DB_DISCONNECTED",
        actor: ctx.actor,
        backupId: ctx.backupId,
        result: "success",
        details: { pendingReads: activeReadCount() },
      });

      // تعامل آمن مع WAL/SHM القديمة (تفتيش ثم إزالة — البيانات في الملف الرئيسي)
      const dbPath = resolveDatabaseFilePath();
      await checkpointAndRemoveWal(dbPath);

      // المرشحة داخل نفس filesystem القاعدة (staging في مجلد القاعدة نفسه) ثم rename ذري
      const swapDir = resolveSwapDir();
      const stagingCandidate = path.join(swapDir, `.restore-${ctx.opId}.candidate.db`);
      const replacedPath = path.join(swapDir, `.restore-${ctx.opId}.replaced.db`);
      ctx.stagingCandidatePath = stagingCandidate;
      ctx.replacedPath = replacedPath;
      if (shouldFail("SWAP_BEFORE_RENAME")) {
        throw new RestoreError("SWAP_BEFORE_RENAME_FAILED", "فشل محقون قبل rename (اختبار معزول)", 500);
      }
      await stageCandidateDb({
        zipPath: ctx.artifactZipPath,
        manifest: ctx.manifest,
        targetPath: stagingCandidate,
      });
      if (shouldFail("SWAP_MID_RENAME")) {
        throw new RestoreError("SWAP_MID_RENAME_FAILED", "فشل محقون بين rename الأول والثاني (اختبار معزول)", 500);
      }
      atomicSwapFiles({ dbPath, candidatePath: stagingCandidate, replacedPath });
      ctx.swapCompleted = true;
      ctx.stagingCandidatePath = null;
      transitionMaintenanceState({
        operationId: ctx.opId,
        state: "SWAPPING",
        message: "اكتمل التبديل الذري — القاعدة المستبدلة في مكانها",
        flags: { swapCompleted: true },
      });
      await appendRecoveryEvent({
        operationId: ctx.opId,
        event: "SWAP_COMPLETED",
        actor: ctx.actor,
        backupId: ctx.backupId,
        result: "success",
        details: { sameFilesystem: true },
      });
      maybeCrash("SWAP_COMPLETED_CRASH"); // crash بعد SWAP_COMPLETED وقبل POST_VERIFY
    });

    // ── VERIFYING (full-block): تحقق بعدي مباشر بلا HTTP ───────────────────
    return await phase(ctx, "VERIFYING", "VERIFYING", async () => {
      if (!checkDeadline(ctx)) throw new RestoreError("TIMEOUT", "تجاوز المهلة الإجمالية عند التحقق البعدي", 504);
      transitionMaintenanceState({
        operationId: ctx.opId,
        state: "VERIFYING",
        message: "إعادة الاتصال ثم التحقق البعدي الشامل",
        flags: { postVerifyStarted: true },
      });
      await appendRecoveryEvent({
        operationId: ctx.opId,
        event: "POST_VERIFY_STARTED",
        actor: ctx.actor,
        backupId: ctx.backupId,
        result: "info",
        details: {},
      });
      const fresh = await reconnectDb();
      ctx.disconnected = false;
      let jm: string = "unknown";
      try {
        const rows = await fresh.$queryRawUnsafe<{ journal_mode: string }[]>(`PRAGMA journal_mode=WAL`);
        jm = rows[0]?.journal_mode ?? "unknown";
      } catch {
        /* يُفحص أدناه */
      }
      if (jm.toLowerCase() !== "wal") {
        ctx.warnings.push(`journal_mode بعد التبديل = ${jm} (المتوقع wal)`);
      }

      const checks = await runPostVerification({
        client: fresh,
        dbPath: resolveDatabaseFilePath(),
        manifest: ctx.manifest,
        label: "POST_VERIFY",
      });
      const allOk = checks.length > 0 && checks.every((c) => c.ok);

      if (!allOk) {
        // ── فشل التحقق البعدي ⇒ تراجع تلقائي من نسخة الأمان ────────────────
        const rolled = await rollbackToPreRestore(ctx, checks);
        return rolled;
      }

      // ── نجاح: epoch+1 ثم الخروج من الصيانة ─────────────────────────────
      const newEpoch = await bumpEpochWithRetry();
      if (newEpoch === null) {
        await failClosedRecovery(ctx, "epoch_bump_failed", "VERIFYING", checks);
        return buildOutcome(ctx, {
          ok: false,
          result: "RECOVERY_REQUIRED",
          preRestoreBackupId: ctx.preRestoreBackupId,
          epochBumped: false,
          newEpoch: null,
          postVerify: checks,
          rollbackVerify: null,
          abortReason: "epoch_bump_failed",


        }, t0);
      }
      await appendRecoveryEvent({
        operationId: ctx.opId,
        event: "RESTORE_COMPLETED",
        actor: ctx.actor,
        backupId: ctx.backupId,
        result: "success",
        details: { epochBumped: true, phases: ctx.phases.length },
      });
      // صف واحد append-only في القاعدة الجديدة بطابعها الزمني الحالي (سياسة موثقة)
      await writeAuditSafe({
        user: { id: ctx.actor.id, username: ctx.actor.username },
        action: AUDIT_ACTIONS.DATABASE_RESTORE_COMPLETED,
        entityType: AUDIT_ENTITY_TYPES.Backup,
        entityId: ctx.backupId,
        description: `اكتملت استعادة قاعدة البيانات إلى «${ctx.backupId}» — عملية ${ctx.opId} (epoch+1)`,
        metadata: { backupId: ctx.backupId, operationId: ctx.opId, epochBumped: true },
      });
      cleanupSwapArtifacts(ctx);
      clearMaintenanceStateFile(); // → NORMAL
      return buildOutcome(ctx, {
        ok: true,
        result: "COMPLETED",
        preRestoreBackupId: ctx.preRestoreBackupId,
        epochBumped: true,
        newEpoch,
        postVerify: checks,
        rollbackVerify: null,
        abortReason: null,


      }, t0);
    });
  } catch (e) {
    // ── مسارات الفشل المنظمة: قبل التبديل ⇒ إلغاء نظيف؛ بعده ⇒ تراجع/قفل ──
    const isTimeout = e instanceof RestoreError && e.code === "TIMEOUT";
    const reason = e instanceof Error ? e.message : String(e);
    try {
      if (ctx.swapCompleted) {
        const rolled = await rollbackToPreRestore(ctx, [
          { name: "الاستمرار بعد التبديل", code: "TRIGGER", ok: false, detail: reason },
        ]);
        return rolled;
      }
      // قبل التبديل: القاعدة لم تُلمس — إلغاء نظيف
      await abortPreSwap(ctx, isTimeout ? "TIMEOUT" : reason);
      return buildOutcome(ctx, {
        ok: false,
        result: "ABORTED",
        preRestoreBackupId: ctx.preRestoreBackupId,
        epochBumped: false,
        newEpoch: null,
        postVerify: null,
        rollbackVerify: null,
        abortReason: reason,


      }, t0);
    } catch (secondary) {
      // فشل حتى مسار الطوارئ ⇒ قفل كامل
      await failClosedRecovery(ctx, `secondary_failure: ${String(secondary)}`, ctx.swapCompleted ? "VERIFYING" : "PREPARING", null);
      return buildOutcome(ctx, {
        ok: false,
        result: "RECOVERY_REQUIRED",
        preRestoreBackupId: ctx.preRestoreBackupId,
        epochBumped: false,
        newEpoch: null,
        postVerify: null,
        rollbackVerify: null,
        abortReason: `primary: ${reason} · secondary: ${String(secondary)}`,


      }, t0);
    }
  } finally {
    clearPhantomWrites();
    lock.release();
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  التراجع التلقائي — نفس آلية التبديل من نسخة الأمان المسحوبة Drill لها     */
/* ──────────────────────────────────────────────────────────────────────── */

async function rollbackToPreRestore(ctx: EngineContext, failedChecks: CheckResult[]): Promise<RestoreOutcome> {
  transitionMaintenanceState({
    operationId: ctx.opId,
    state: "ROLLING_BACK",
    message: "فشل التحقق البعدي — تراجع تلقائي إلى نسخة الأمان (البقاء في الصيانة الكاملة)",
  });
  await appendRecoveryEvent({
    operationId: ctx.opId,
    event: "ROLLBACK_STARTED",
    actor: ctx.actor,
    backupId: ctx.preRestoreBackupId ?? ctx.backupId,
    result: "info",
    details: { trigger: failedChecks.filter((c) => !c.ok).map((c) => c.code).slice(0, 5) },
  });

  const doRollback = async (): Promise<{ checks: CheckResult[] }> => {
    if (!ctx.preRestoreBackupId) {
      throw new RestoreError("NO_PRE_RESTORE", "لا توجد نسخة أمان للتراجع — خطأ بنيوي غير متوقع", 500);
    }
    const pre = findArtifactById(ctx.preRestoreBackupId);
    if (!pre) throw new RestoreError("NOT_FOUND", "نسخة الأمان اختفت أثناء التراجع", 500);
    const dbPath = resolveDatabaseFilePath();
    const swapDir = resolveSwapDir();
    const stagingRollback = path.join(swapDir, `.restore-${ctx.opId}.rollback.db`);
    const replacedCandidate = path.join(swapDir, `.restore-${ctx.opId}.replaced-candidate.db`);

    // قطع العميل الحالي (المتصلاً بالقاعدة الفاشلة) ثم تبديل ذري
    await liveDb.$disconnect().catch(() => undefined);
    ctx.disconnected = true;
    if (shouldFail("ROLLBACK_SWAP")) {
      throw new RestoreError("ROLLBACK_SWAP_FAILED", "فشل محقون في تبديل التراجع (اختبار معزول)", 500);
    }
    await stageCandidateDb({ zipPath: pre.zipPath, manifest: pre.manifest, targetPath: stagingRollback });
    atomicSwapFiles({ dbPath, candidatePath: stagingRollback, replacedPath: replacedCandidate });
    ctx.swapCompleted = true; // القاعدة استُبدلت (بالنسخة الأمان) ⇒ epoch+1 إلزامي
    ctx.replacedPath = replacedCandidate;

    const fresh = await reconnectDb();
    ctx.disconnected = false;
    try {
      await fresh.$queryRawUnsafe(`PRAGMA journal_mode=WAL`);
    } catch {
      /* يُفحص في التحقق */
    }
    const checks = await runPostVerification({
      client: fresh,
      dbPath,
      manifest: pre.manifest,
      label: "ROLLBACK_VERIFY",
    });
    return { checks };
  };

  try {
    if (shouldFail("ROLLBACK_VERIFY")) {
      throw new RestoreError("ROLLBACK_VERIFY_FAILED", "فشل محقون في تحقق التراجع (اختبار معزول)", 500);
    }
    const { checks } = await doRollback();
    const allOk = checks.length > 0 && checks.every((c) => c.ok);
    if (!allOk) {
      await failClosedRecovery(ctx, "rollback_verification_failed", "ROLLING_BACK", checks);
      return buildOutcome(ctx, {
        ok: false,
        result: "RECOVERY_REQUIRED",
        preRestoreBackupId: ctx.preRestoreBackupId,
        epochBumped: false,
        newEpoch: null,
        postVerify: failedChecks,
        rollbackVerify: checks,
        abortReason: "rollback_verification_failed",


      }, Date.now());
    }
    const newEpoch = await bumpEpochWithRetry();
    if (newEpoch === null) {
      await failClosedRecovery(ctx, "epoch_bump_failed_after_rollback", "ROLLING_BACK", checks);
      return buildOutcome(ctx, {
        ok: false,
        result: "RECOVERY_REQUIRED",
        preRestoreBackupId: ctx.preRestoreBackupId,
        epochBumped: false,
        newEpoch: null,
        postVerify: failedChecks,
        rollbackVerify: checks,
        abortReason: "epoch_bump_failed_after_rollback",


      }, Date.now());
    }
    await appendRecoveryEvent({
      operationId: ctx.opId,
      event: "ROLLBACK_COMPLETED",
      actor: ctx.actor,
      backupId: ctx.preRestoreBackupId,
      result: "success",
      details: { epochBumped: true },
    });
    await writeAuditSafe({
      user: { id: ctx.actor.id, username: ctx.actor.username },
      action: AUDIT_ACTIONS.DATABASE_RESTORE_ROLLED_BACK,
      entityType: AUDIT_ENTITY_TYPES.Backup,
      entityId: ctx.preRestoreBackupId,
      description: `اكتمل التراجع التلقائي إلى نسخة الأمان «${ctx.preRestoreBackupId}» — عملية ${ctx.opId} (epoch+1)`,
      metadata: { backupId: ctx.preRestoreBackupId, operationId: ctx.opId, epochBumped: true },
    });
    cleanupSwapArtifacts(ctx);
    clearMaintenanceStateFile(); // → NORMAL (بعد تراجع ناجح حصرًا)
    return buildOutcome(ctx, {
      ok: true,
      result: "ROLLED_BACK",
      preRestoreBackupId: ctx.preRestoreBackupId,
      epochBumped: true,
      newEpoch,
      postVerify: failedChecks,
      rollbackVerify: checks,
      abortReason: null,


    }, Date.now());
  } catch (e) {
    await failClosedRecovery(ctx, `rollback_failed: ${e instanceof Error ? e.message : String(e)}`, "ROLLING_BACK", null);
    return buildOutcome(ctx, {
      ok: false,
      result: "RECOVERY_REQUIRED",
      preRestoreBackupId: ctx.preRestoreBackupId,
      epochBumped: false,
      newEpoch: null,
      postVerify: failedChecks,
      rollbackVerify: null,
      abortReason: e instanceof Error ? e.message : String(e),


    }, Date.now());
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  الإلغاء النظيف قبل التبديل + القفل المغلق                                 */
/* ──────────────────────────────────────────────────────────────────────── */

async function abortPreSwap(ctx: EngineContext, reason: string): Promise<void> {
  if (ctx.disconnected) {
    // القاعدة لم تُستبدل — إعادة الاتصال تعيد الخدمة بأمان
    await reconnectDb();
    ctx.disconnected = false;
    try {
      await liveDb.$queryRawUnsafe(`PRAGMA journal_mode=WAL`);
    } catch {
      /* ignore */
    }
  }
  cleanupSwapArtifacts(ctx);
  clearMaintenanceStateFile(); // → NORMAL
  await appendRecoveryEvent({
    operationId: ctx.opId,
    event: "RESTORE_ABORTED",
    actor: ctx.actor,
    backupId: ctx.backupId,
    result: "aborted",
    details: { reason, productionUntouched: true },
  });
  await writeAuditSafe({
    user: { id: ctx.actor.id, username: ctx.actor.username },
    action: AUDIT_ACTIONS.DATABASE_RESTORE_ABORTED,
    entityType: AUDIT_ENTITY_TYPES.Backup,
    entityId: ctx.backupId,
    description: `إلغاء منظم لعملية الاستعادة قبل التبديل — القاعدة لم تُلمس (${reason.slice(0, 120)})`,
    metadata: { backupId: ctx.backupId, operationId: ctx.opId, reason: reason.slice(0, 200) },
  });
}

async function failClosedRecovery(
  ctx: EngineContext,
  reason: string,
  originalState: string,
  checks: CheckResult[] | null
): Promise<void> {
  enterRecoveryRequired({
    operationId: ctx.opId,
    reason,
    originalState: originalState as MaintenanceStateFile["state"],
    message: "فشل مسار الاستعادة/التراجع — الخدمة مقفلة حتى استرداد يدوي موثق (RECOVERY_REQUIRED)",
  });
  await appendRecoveryEvent({
    operationId: ctx.opId,
    event: "RECOVERY_REQUIRED",
    actor: ctx.actor,
    backupId: ctx.backupId ?? ctx.preRestoreBackupId,
    result: "failure",
    details: { reason, originalState, failedChecks: checks?.filter((c) => !c.ok).map((c) => c.code) ?? null },
  });
  console.error(`[restore-engine] RECOVERY_REQUIRED — operation=${ctx.opId} reason=${reason}`);
}

function cleanupSwapArtifacts(ctx: EngineContext): void {
  for (const p of [ctx.stagingCandidatePath, ctx.replacedPath]) {
    try {
      if (p && existsSync(p)) rmSync(p, { force: true });
    } catch {
      /* ignore — ملفات staging لا تؤثر على القاعدة */
    }
  }
  ctx.stagingCandidatePath = null;
  ctx.replacedPath = null;
}

function buildOutcome(
  ctx: EngineContext,
  data: Omit<
    RestoreOutcome,
    "operationId" | "backupId" | "phases" | "warnings" | "startedAt" | "finishedAt" | "durationMs"
  >,
  t0: number
): RestoreOutcome {
  return {
    ...data,
    operationId: ctx.opId,
    backupId: ctx.backupId,
    phases: ctx.phases,
    warnings: ctx.warnings,
    startedAt: ctx.startedAtIso,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
  };
}
