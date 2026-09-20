// Phase 4A — محرك النسخ الاحتياطي (خادم فقط).
//
// التزامات ثابتة في هذا الملف:
//  1. قاعدة التشغيل تُقرأ عبر VACUUM INTO حصرًا (snapshot متسق بلا مساس) —
//     كل التحقق والـ Drill يقع على نسخ مؤقتة معزولة في staging.
//  2. الصلاحية من المحتوى والـ Manifest — لا من اسم ZIP أو الملف المرفوع (D-1).
//  3. لا ترحيل على قاعدة التشغيل إطلاقًا — Drill يعمل على مؤقتة فقط (D-3).
//  4. لا أسرار ولا password hashes ولا مسارات قرص داخلية في أي Manifest أو
//     سجل أو Audit (Sanitizer مركزي).
//  5. لا حذف تلقائي لأي نسخة رسمية — الفشل ينظف الملفات الجزئية في staging حصرًا.

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";

import { db as liveDb } from "@/lib/db";
import {
  ALLOWED_ZIP_ENTRIES,
  BACKUP_CREATE_COOLDOWN_MS,
  UPLOAD_LIMITS,
  classifySchemaFingerprint,
  ensurePrivateDir,
  newBackupId,
  newOperationId,
  newUploadId,
  resolveBackupDir,
  resolveStagingDir,
  sanitizeDisplayName,
  setCurrentSchemaIdentity,
} from "@/lib/backup-config";
import {
  buildManifest,
  collectCounts,
  collectDataRange,
  collectPeriodRange,
  CURRENT_SCHEMA_LABEL,
  manifestClassOf,
  parseManifest,
  type AnyBackupManifest,
  type VerificationLevel,
} from "@/lib/backup-manifest";
import {
  canonicalSchemaFingerprint as computeCanonicalFingerprint,
  physicalSchemaFingerprint as computePhysicalFingerprint,
} from "@/lib/schema-fingerprint";
import { inspectZipBuffer, readZipEntry, type ZipInspectFail } from "@/lib/zip-secure";
import { appendRecoveryEvent, countRecoveryEvents } from "@/lib/recovery-log";
import { writeAuditSafe } from "@/lib/audit";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";

/* ──────────────────────────────────────────────────────────────────────── */
/*  أخطاء منظمة                                                             */
/* ──────────────────────────────────────────────────────────────────────── */

export class BackupError extends Error {
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
/*  أدوات داخلية                                                            */
/* ──────────────────────────────────────────────────────────────────────── */

function tempClientFor(dbPath: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } }, log: [] });
}

async function hashFileStream(filePath: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on("end", () => resolve({ sha256: hash.digest("hex"), bytes }));
    stream.on("error", reject);
  });
}

function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** كتابة ملف 0600 بذرية (tmp + rename داخل نفس المجلد). */
function writePrivateFileAtomic(finalPath: string, data: Buffer | string): void {
  const tmp = `${finalPath}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, finalPath);
}

/** قفل داخلي للعمليات المتغيرة (عملية خادم واحدة — حد موثق). */
const g = globalThis as unknown as { __backupOpLock?: Promise<unknown> };
async function withOpLock<T>(fn: () => Promise<T>): Promise<T> {
  while (g.__backupOpLock) {
    await g.__backupOpLock.catch(() => undefined);
  }
  let release!: () => void;
  g.__backupOpLock = new Promise((r) => (release = r));
  try {
    return await fn();
  } finally {
    release();
    g.__backupOpLock = undefined;
  }
}

let lastCreateAt = 0;

/**
 * هوية المخطط الحية (4A.1): البصمة القاعدية الدلالية الحاكمة + الفيزيائية التشخيصية
 * تُحتسبان من قاعدة التشغيل قبل كل عملية تحقق/Drill/إنشاء.
 */
async function refreshCurrentSchemaIdentity(): Promise<{ canonical: string; physical: string }> {
  const canonical = await computeCanonicalFingerprint(liveDb);
  const physical = await computePhysicalFingerprint(liveDb);
  setCurrentSchemaIdentity({ canonical, physical });
  return { canonical, physical };
}

function shortFp(fp: string): string {
  return fp.replace(/^(c)?sha256:/, "").slice(0, 12);
}

function assertSafeId(id: string): string {
  if (!/^(bk|up)-[A-Za-z0-9_-]+$/.test(id)) {
    throw new BackupError("BAD_ID", "معرف غير صالح", 400);
  }
  return id;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  أنواع التقارير العامة                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

export interface CheckResult {
  name: string;
  code: string;
  ok: boolean;
  detail?: string;
  ms?: number;
}

export interface ValidationReport {
  ok: boolean;
  backupId: string;
  source: "local" | "upload";
  level: VerificationLevel;
  checks: CheckResult[];
  warnings: string[];
  /** البصمة الفيزيائية المستخرجة من database.db نفسها (تشخيصية). */
  physicalSchemaFingerprint?: string;
  /** البصمة القاعدية الدلالية المستخرجة من database.db نفسها — الحاكمة (4A.1). */
  canonicalSchemaFingerprint?: string;
  /** صيغة الـ Manifest: 3 (canonical مضمّن) أو 2 (legacy). */
  manifestFormat?: 2 | 3;
  /** تصنيف الـ Manifest: v3 الحالي أو legacy-v2 الإرث (لا ترقية صامتة). */
  manifestClass?: "v3" | "legacy-v2";
  /** هل طابقت قيمة الـ Manifest المضمّنة المستخرجة من المحتوى؟ null = legacy v2 (لا قيمة مضمّنة). */
  canonicalMatchesManifest?: boolean | null;
  durationMs: number;
}

export interface DrillReport extends ValidationReport {
  steps: CheckResult[];
  prismaReadTests: CheckResult[];
  countsMatched: boolean;
  periodRangeMatched: boolean;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  القائمة — من Manifest لا من الأسماء                                     */
/* ──────────────────────────────────────────────────────────────────────── */

export interface BackupListEntry {
  backupId: string;
  fileName: string;
  source: "local" | "upload";
  backupType: string;
  createdAt: string;
  appVersion: string;
  schemaVersion: string;
  schemaFingerprintShort: string;
  /** صيغة الـ Manifest (4A.1) — 0 = بلا Manifest صالح. */
  manifestFormat: 2 | 3 | 0;
  /** البصمة القاعدية الدلالية المختصرة — فارغة لـ legacy v2 (تُستخرج وقت التحقق). */
  canonicalFingerprintShort: string;
  level: VerificationLevel | "INVALID";
  invalidReason: string | null;
  sizeBytes: number;
  dbBytes: number;
  counts: BackupManifestV2["counts"] | null;
  periodRange: BackupManifestV2["periodRange"] | null;
  integrityCheck: string | null;
}

function scanDirForEntries(dir: string, source: "local" | "upload"): BackupListEntry[] {
  const entries: BackupListEntry[] = [];
  if (!existsSync(dir)) return entries;
  const files = readdirSync(dir);
  const zipIds = new Set<string>();
  const manifestIds = new Set<string>();
  for (const f of files) {
    if (f.endsWith(".zip")) zipIds.add(f.slice(0, -4));
    if (f.endsWith(".manifest.json")) manifestIds.add(f.slice(0, -14));
  }
  const ids = new Set([...zipIds, ...manifestIds]);
  for (const id of ids) {
    const zipPath = path.join(dir, `${id}.zip`);
    const manifestPath = path.join(dir, `${id}.manifest.json`);
    const hasZip = existsSync(zipPath) && statSync(zipPath).size > 0;
    const manifest = hasManifest(manifestPath);

    if (!hasZip) {
      entries.push(invalidEntry(id, source, manifest?.manifest, "MISSING_PACKAGE", "حزمة ZIP مفقودة أو فارغة"));
      continue;
    }
    if (!manifest) {
      entries.push(invalidEntry(id, source, undefined, "BAD_MANIFEST", "Manifest مفقود أو تالف — ليس مرشح استعادة"));
      continue;
    }
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(zipPath).size;
    } catch {
      /* ignore */
    }
    entries.push({
      backupId: manifest.manifest.backupId,
      fileName: `${id}.zip`,
      source,
      backupType: manifest.manifest.backupType,
      createdAt: manifest.manifest.createdAt,
      appVersion: manifest.manifest.appVersion,
      schemaVersion: manifest.manifest.schemaVersion,
      schemaFingerprintShort: shortFp(manifest.manifest.schemaFingerprint),
      manifestFormat: manifest.manifest.formatVersion,
      canonicalFingerprintShort:
        manifest.manifest.formatVersion === 3 ? shortFp(manifest.manifest.canonicalSchemaFingerprint) : "",
      level: manifest.manifest.verification.level,
      invalidReason: null,
      sizeBytes,
      dbBytes: manifest.manifest.database.bytes,
      counts: manifest.manifest.counts,
      periodRange: manifest.manifest.periodRange,
      integrityCheck: manifest.manifest.database.integrityCheck,
    });
  }
  return entries.sort((a, b) => {
    if (!!a.invalidReason !== !!b.invalidReason) return a.invalidReason ? 1 : -1;
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
}

function hasManifest(manifestPath: string): { manifest: AnyBackupManifest } | null {
  try {
    if (!existsSync(manifestPath)) return null;
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = parseManifest(raw);
    return manifest ? { manifest } : null;
  } catch {
    return null;
  }
}

function invalidEntry(
  id: string,
  source: "local" | "upload",
  manifest: AnyBackupManifest | undefined,
  code: string,
  message: string
): BackupListEntry {
  return {
    backupId: manifest?.backupId ?? id,
    fileName: `${id}.zip`,
    source,
    backupType: manifest?.backupType ?? "unknown",
    createdAt: manifest?.createdAt ?? "",
    appVersion: manifest?.appVersion ?? "",
    schemaVersion: manifest?.schemaVersion ?? "",
    schemaFingerprintShort: manifest ? shortFp(manifest.schemaFingerprint) : "",
    manifestFormat: manifest?.formatVersion ?? 0,
    canonicalFingerprintShort:
      manifest?.formatVersion === 3 ? shortFp(manifest.canonicalSchemaFingerprint) : "",
    level: "INVALID",
    invalidReason: `${code}: ${message}`,
    sizeBytes: 0,
    dbBytes: manifest?.database.bytes ?? 0,
    counts: manifest?.counts ?? null,
    periodRange: manifest?.periodRange ?? null,
    integrityCheck: manifest?.database.integrityCheck ?? null,
  };
}

/** القائمة الكاملة: نسخ BACKUP_DIR الرسمية + المرفوعات في staging. */
export function listBackups(): { local: BackupListEntry[]; uploads: BackupListEntry[] } {
  return {
    local: scanDirForEntries(resolveBackupDir(), "local"),
    uploads: scanDirForEntries(path.join(resolveStagingDir(), "uploads"), "upload"),
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  إنشاء نسخة (VACUUM INTO + Manifest + ZIP + تحقق تلقائي)                 */
/* ──────────────────────────────────────────────────────────────────────── */

export interface ActorInfo {
  id: string | null;
  username: string;
}

export async function createBackup(actor: ActorInfo): Promise<{
  backupId: string;
  level: VerificationLevel;
  manifest: BackupManifestV2;
  validationReport: ValidationReport | null;
  validationError: string | null;
}> {
  const now = Date.now();
  if (now - lastCreateAt < BACKUP_CREATE_COOLDOWN_MS) {
    throw new BackupError(
      "COOLDOWN",
      `فترة تهدئة بين النسخ (${BACKUP_CREATE_COOLDOWN_MS / 1000} ثانية) — أعد المحاولة لاحقًا`,
      429,
      { retryAfterMs: BACKUP_CREATE_COOLDOWN_MS - (now - lastCreateAt) }
    );
  }
  lastCreateAt = now;

  return withOpLock(async () => {
    const opId = newOperationId("backup");
    const backupId = newBackupId();
    const backupDir = ensurePrivateDir(resolveBackupDir());
    const ws = ensurePrivateDir(path.join(resolveStagingDir(), `create-${opId}`));
    let tempClient: PrismaClient | null = null;

    await appendRecoveryEvent({
      operationId: opId,
      event: "BACKUP_STARTED",
      actor,
      backupId,
      result: "info",
      details: { backupType: "manual", trigger: "manual" },
    });

    try {
      // 1) VACUUM INTO — snapshot متسق من قاعدة التشغيل (قراءة فقط)
      const dbTarget = path.join(ws, "database.db");
      const jmRows = await liveDb.$queryRawUnsafe<{ journal_mode: string }[]>(`PRAGMA journal_mode`);
      const journalModeAtBackup = jmRows[0]?.journal_mode ?? "unknown";
      await liveDb.$executeRawUnsafe(`VACUUM INTO '${dbTarget.replace(/'/g, "''")}'`);

      // 2) فحوص على النسخة المولدة (عميل Prisma مؤقت على الملف)
      tempClient = tempClientFor(dbTarget);
      const integRows = await tempClient.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`);
      const integrityCheck = integRows[0]?.integrity_check ?? "unknown";
      if (integrityCheck !== "ok") {
        throw new BackupError("CORRUPT_DB", `integrity_check أعادت: ${integrityCheck}`);
      }
      const canonicalFp = await computeCanonicalFingerprint(tempClient);
      const physicalFp = await computePhysicalFingerprint(tempClient);
      setCurrentSchemaIdentity({ canonical: canonicalFp, physical: physicalFp });
      const countsRes = await collectCounts(tempClient);
      if (!countsRes.ok) {
        throw new BackupError("MISSING_TABLES", countsRes.missingTable);
      }
      const [periodRange, dataRange] = await Promise.all([
        collectPeriodRange(tempClient),
        collectDataRange(tempClient),
      ]);
      const psRows = await tempClient.$queryRawUnsafe<{ page_size: number | bigint }[]>(`PRAGMA page_size`);
      const pageSize = Number(psRows[0]?.page_size ?? 0);
      await tempClient.$disconnect();
      tempClient = null;

      // 3) SHA-256 + الحجم (بثّ — بلا تحميل كامل بالذاكرة)
      const { sha256, bytes } = await hashFileStream(dbTarget);

      // 4) Manifest v3 — يحمل البصمتين: الحاكمة canonical + التشخيصية physical
      const manifest = buildManifest({
        backupId,
        backupType: "manual",
        createdBy: { id: actor.id, username: actor.username },
        schemaVersion: CURRENT_SCHEMA_LABEL,
        schemaFingerprint: physicalFp,
        canonicalSchemaFingerprint: canonicalFp,
        database: {
          filename: "database.db",
          sha256,
          bytes,
          pageSize,
          integrityCheck,
          journalModeAtBackup,
        },
        counts: countsRes.counts,
        periodRange,
        dataRange,
        level: "CREATED",
      });

      // 5) التغليف: ZIP يحوي database.db + manifest.json حصرًا (D-1)
      const zip = new JSZip();
      zip.file("database.db", readFileSync(dbTarget));
      zip.file("manifest.json", JSON.stringify(manifest, null, 2));
      const zipBuf = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });

      // 6) النشر الذري في BACKUP_DIR + Manifest جانبي متزامن
      const zipPath = path.join(backupDir, `${backupId}.zip`);
      const sidecarPath = path.join(backupDir, `${backupId}.manifest.json`);
      writePrivateFileAtomic(zipPath, zipBuf);
      writePrivateFileAtomic(sidecarPath, JSON.stringify(manifest, null, 2));

      await appendRecoveryEvent({
        operationId: opId,
        event: "BACKUP_CREATED",
        actor,
        backupId,
        result: "success",
        details: { bytes, zipBytes: zipBuf.length, counts: countsRes.counts, level: "CREATED" },
      });
      await writeAuditSafe({
        user: { id: actor.id, username: actor.username },
        action: AUDIT_ACTIONS.BACKUP_CREATED,
        entityType: AUDIT_ENTITY_TYPES.Backup,
        entityId: backupId,
        description: `إنشاء نسخة احتياطية «${backupId}» (${bytes} بايت قاعدة، ${zipBuf.length} بايت حزمة)`,
        metadata: { backupId, dbBytes: bytes, zipBytes: zipBuf.length, counts: countsRes.counts },
      });

      // 7) التحقق الداخلي التلقائي فور الإنشاء (CREATED → VALIDATED إن سلمت)
      let validationReport: ValidationReport | null = null;
      let validationError: string | null = null;
      try {
        validationReport = await validateBackupArtifact({
          zipPath,
          actor,
          source: "local",
          operationId: newOperationId("validate"),
        });
        await appendRecoveryEvent({
          operationId: opId,
          event: "BACKUP_VALIDATED",
          actor,
          backupId,
          result: "success",
          details: { source: "local", level: validationReport.level, trigger: "auto" },
        });
        await writeAuditSafe({
          user: { id: actor.id, username: actor.username },
          action: AUDIT_ACTIONS.BACKUP_VALIDATED,
          entityType: AUDIT_ENTITY_TYPES.Backup,
          entityId: backupId,
          description: `نجح التحقق التلقائي للنسخة «${backupId}» — المستوى ${validationReport.level}`,
          metadata: { level: validationReport.level, trigger: "auto", durationMs: validationReport.durationMs },
        });
      } catch (e) {
        validationError = e instanceof BackupError ? `${e.code}: ${e.message}` : String(e);
        await appendRecoveryEvent({
          operationId: opId,
          event: "BACKUP_FAILED",
          actor,
          backupId,
          result: "failure",
          details: { stage: "AUTO_VALIDATION", reason: validationError, keptAs: "CREATED" },
        });
        await writeAuditSafe({
          user: { id: actor.id, username: actor.username },
          action: AUDIT_ACTIONS.BACKUP_FAILED,
          entityType: AUDIT_ENTITY_TYPES.Backup,
          entityId: backupId,
          description: `فشل التحقق التلقائي للنسخة «${backupId}» — بقيت بمستوى CREATED`,
          metadata: { stage: "AUTO_VALIDATION", reason: validationError },
        });
      }

      const finalManifest = hasManifest(sidecarPath)?.manifest ?? manifest;
      return {
        backupId,
        level: finalManifest.verification.level,
        manifest: finalManifest,
        validationReport,
        validationError,
      };
    } catch (e) {
      const reason = e instanceof BackupError ? `${e.code}: ${e.message}` : String(e);
      await appendRecoveryEvent({
        operationId: opId,
        event: "BACKUP_FAILED",
        actor,
        backupId,
        result: "failure",
        details: { stage: "CREATE", reason },
      });
      await writeAuditSafe({
        user: { id: actor.id, username: actor.username },
        action: AUDIT_ACTIONS.BACKUP_FAILED,
        entityType: AUDIT_ENTITY_TYPES.Backup,
        entityId: backupId,
        description: `فشل إنشاء نسخة احتياطية — ${reason}`,
        metadata: { stage: "CREATE", reason },
      });
      // نظافة: لا ملفات جزئية نهائية — الملفات المنشورة كاملة تُحفظ كما هي
      if (e instanceof BackupError) throw e;
      throw new BackupError("IO", `فشل إنشاء النسخة: ${reason}`, 500);
    } finally {
      try {
        await tempClient?.$disconnect();
      } catch {
        /* ignore */
      }
      rmSync(ws, { recursive: true, force: true });
    }
  });
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  خط التحقق المشترك (يستخدمه الإنشاء التلقائي/التحقق الصريح/الرفع)        */
/* ──────────────────────────────────────────────────────────────────────── */

interface ValidateArtifactArgs {
  zipPath: string;
  actor: ActorInfo;
  source: "local" | "upload";
  operationId: string;
}

/**
 * خط التحقق المشترك — مُصدَّر لسكربتات إثبات 4A.1 (اختبارات التلاعب على نسخ
 * مصطنعة خارج النسخ الرسمية). لا يكتب Audit/Recovery — المحاسبة على المستدعي.
 */
export async function validateBackupArtifact(args: ValidateArtifactArgs): Promise<ValidationReport> {
  const { zipPath, actor, source, operationId } = args;
  const t0 = Date.now();
  const checks: CheckResult[] = [];
  const warnings: string[] = [];
  const ws = ensurePrivateDir(path.join(resolveStagingDir(), `validate-${operationId}`));
  let tempClient: PrismaClient | null = null;

  try {
    const zipBuf = readFileSync(zipPath);
    const sidecarPath = zipPath.replace(/\.zip$/, ".manifest.json");
    const original = hasManifest(sidecarPath)?.manifest;
    if (!original) throw new BackupError("BAD_MANIFEST", "الـ Manifest الجانبي مفقود أو تالف");

    // 1) بوابة أمن ZIP الصارمة
    const t1 = Date.now();
    const inspected = inspectZipBuffer(zipBuf, {
      maxUncompressedBytes: UPLOAD_LIMITS.maxUncompressedMB * 1024 * 1024,
      maxEntries: UPLOAD_LIMITS.maxZipEntries,
      allowedNames: ALLOWED_ZIP_ENTRIES,
      maxRatio: UPLOAD_LIMITS.maxCompressionRatio,
      maxCompressedBytes: source === "upload" ? UPLOAD_LIMITS.maxUploadMB * 1024 * 1024 : undefined,
    });
    if (!inspected.ok) {
      throw new BackupError(inspected.code, zipFailMsg(inspected), inspected.code === "TOO_LARGE" ? 413 : 400);
    }
    checks.push({ name: "أمن الحزمة (بنية/أسماء/حدود)", code: "PACKAGE_OK", ok: true, ms: Date.now() - t1 });

    // 2) manifest.json من داخل الـ ZIP (≤1MB)
    const manifestRaw = await readZipEntry(zipBuf, "manifest.json", UPLOAD_LIMITS.maxManifestBytes);
    if ("ok" in manifestRaw && !manifestRaw.ok) {
      throw new BackupError(manifestRaw.code, zipFailMsg(manifestRaw as ZipInspectFail));
    }
    const embedded = parseManifest((manifestRaw as Buffer).toString("utf8"));
    if (!embedded) throw new BackupError("BAD_MANIFEST", "manifest.json داخل الحزمة غير صالح");
    checks.push({ name: "Manifest داخل الحزمة صالح", code: "MANIFEST_OK", ok: true });

    // اتساق الجانبي مع المضمّن
    if (embedded.database.sha256 !== original.database.sha256) {
      throw new BackupError("BAD_MANIFEST", "الـ Manifest الجانبي لا يطابق المضمّن داخل الحزمة");
    }

    // 3) استخراج database.db + فحص البصمة السحرية
    const t2 = Date.now();
    const dbBytes = await readZipEntry(zipBuf, "database.db", UPLOAD_LIMITS.maxUncompressedMB * 1024 * 1024);
    if ("ok" in dbBytes && !dbBytes.ok) {
      throw new BackupError(dbBytes.code, zipFailMsg(dbBytes as ZipInspectFail));
    }
    const dbBuf = dbBytes as Buffer;
    const MAGIC = Buffer.from("SQLite format 3\0");
    if (dbBuf.length < 16 || !dbBuf.subarray(0, 16).equals(MAGIC)) {
      throw new BackupError("NOT_SQLITE", "database.db ليس ملف SQLite صالح");
    }
    checks.push({ name: "بصمة SQLite", code: "SQLITE_MAGIC_OK", ok: true, ms: Date.now() - t2 });

    // 4) checksum قاطع — SHA-256 الفعلي مقابل الـ Manifest
    const t3 = Date.now();
    const actualSha = hashBuffer(dbBuf);
    if (actualSha !== embedded.database.sha256) {
      throw new BackupError(
        "CHECKSUM_MISMATCH",
        `عدم تطابق SHA-256 — المحتوى لا يطابق الـ Manifest (يرفض قاطعًا)`
      );
    }
    checks.push({ name: "تطابق SHA-256", code: "CHECKSUM_OK", ok: true, ms: Date.now() - t3 });

    // 5) integrity_check + جداول Prisma + بصمة المخطط (عميل مؤقت حصرًا)
    const dbPath = path.join(ws, "database.db");
    writeFileSync(dbPath, dbBuf, { mode: 0o600 });
    tempClient = tempClientFor(dbPath);
    const t4 = Date.now();
    const integ = await tempClient.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`);
    if ((integ[0]?.integrity_check ?? "") !== "ok") {
      throw new BackupError("CORRUPT_DB", `integrity_check أعادت: ${integ[0]?.integrity_check}`);
    }
    checks.push({ name: "integrity_check", code: "INTEGRITY_OK", ok: true, ms: Date.now() - t4 });

    const t5 = Date.now();
    const countsRes = await collectCounts(tempClient);
    if (!countsRes.ok) throw new BackupError("MISSING_TABLES", countsRes.missingTable);
    checks.push({
      name: "الجداول الإلزامية عبر Prisma",
      code: "TABLES_OK",
      ok: true,
      ms: Date.now() - t5,
    });

    const t6 = Date.now();
    // البصمتان تُستخرجان من database.db نفسها — لا ثقة بقيمة Manifest وحدها (قرار 4A.1)
    const canonicalFp = await computeCanonicalFingerprint(tempClient);
    const physicalFp = await computePhysicalFingerprint(tempClient);
    const liveIdentity = await refreshCurrentSchemaIdentity();

    // اتساق قيم الـ Manifest المضمنة مع المحتوى — فشل فوري عند أي تلاعب/اختلاف
    const physicalMatchesManifest = embedded.schemaFingerprint === physicalFp;
    const canonicalMatchesManifest =
      embedded.formatVersion === 3 ? embedded.canonicalSchemaFingerprint === canonicalFp : null;
    if (!physicalMatchesManifest || canonicalMatchesManifest === false) {
      throw new BackupError(
        "MANIFEST_INCONSISTENT",
        "قيمة بصمة المخطط في الـ Manifest لا تطابق ما استُخرج من database.db — رفض (لا ثقة بقيمة مكتوبة)",
        422,
        {
          manifestPhysical: shortFp(embedded.schemaFingerprint),
          actualPhysical: shortFp(physicalFp),
          ...(embedded.formatVersion === 3
            ? { manifestCanonical: shortFp(embedded.canonicalSchemaFingerprint), actualCanonical: shortFp(canonicalFp) }
            : {}),
        }
      );
    }
    checks.push({
      name: "اتساق بصمات المخطط في الـ Manifest مع المحتوى",
      code: "MANIFEST_CONSISTENT",
      ok: true,
      detail: embedded.formatVersion === 3 ? "canonical + physical" : "physical (legacy-v2)",
    });

    // قرار التوافق على البصمة القاعدية الدلالية حصرًا — لا الفيزيائية
    const classified = classifySchemaFingerprint(canonicalFp);
    if (classified.schemaClass !== "current") {
      throw new BackupError(
        "SCHEMA_UNKNOWN",
        "المخطط الدلالي للنسخة غير معروف/غير مطابق للمخطط الحالي — الرفض (يشمل الأحدث: لا downgrade)",
        422,
        { candidateCanonical: shortFp(canonicalFp), currentCanonical: shortFp(liveIdentity.canonical) }
      );
    }
    checks.push({
      name: "تطابق المخطط الدلالي (canonical) مع الحالي",
      code: "SCHEMA_OK",
      ok: true,
      ms: Date.now() - t6,
      detail: shortFp(canonicalFp),
    });

    // 6) اتساق الـ Manifest مع المحتوى الفعلي
    const t7 = Date.now();
    if (
      embedded.counts.users !== countsRes.counts.users ||
      embedded.counts.groups !== countsRes.counts.groups ||
      embedded.counts.reports !== countsRes.counts.reports ||
      embedded.counts.workflowHistory !== countsRes.counts.workflowHistory ||
      embedded.counts.auditLog !== countsRes.counts.auditLog
    ) {
      throw new BackupError("COUNTS_MISMATCH", "عدّ الـ Manifest لا يطابق محتوى قاعدة النسخة");
    }
    const periodRange = await collectPeriodRange(tempClient);
    if (
      embedded.periodRange.minPeriodEnd !== periodRange.minPeriodEnd ||
      embedded.periodRange.maxPeriodEnd !== periodRange.maxPeriodEnd
    ) {
      throw new BackupError("COUNTS_MISMATCH", "periodRange في الـ Manifest لا يطابق المحتوى");
    }
    checks.push({ name: "اتساق الـ Manifest مع المحتوى", code: "CONSISTENCY_OK", ok: true, ms: Date.now() - t7 });

    // 7) sanity أعمال (تحذيرات لا إخفاق)
    if (countsRes.counts.users === 0) {
      warnings.push("SANITY_NO_USERS: لا مستخدمون في النسخة — بعد أي استعادة مستقبلية ستُفعّل شاشة الإعداد الأولي (مدير افتراضي)");
    }

    // 8) رفع المستوى (لا يهبط أبدًا بالتحقق؛ RESTORE_VERIFIED يبقى حتى إعادة تحقق ناجحة)
    //    الصيغة تبقى كما هي: legacy v2 تبقى v2 بلا ترقية صامتة، وv3 تبقى v3.
    const updated = withValidatedLevel(embedded);
    await rewriteManifestInZip(zipPath, updated);
    checks.push({ name: "تحديث مستوى التحقق", code: "LEVEL_SET", ok: true, detail: updated.verification.level });

    return {
      ok: true,
      backupId: embedded.backupId,
      source,
      level: updated.verification.level,
      checks,
      warnings,
      physicalSchemaFingerprint: physicalFp,
      canonicalSchemaFingerprint: canonicalFp,
      manifestFormat: embedded.formatVersion,
      manifestClass: manifestClassOf(embedded),
      canonicalMatchesManifest,
      durationMs: Date.now() - t0,
    };
  } finally {
    try {
      await tempClient?.$disconnect();
    } catch {
      /* ignore */
    }
    rmSync(ws, { recursive: true, force: true });
  }
}

function zipFailMsg(f: ZipInspectFail): string {
  const withEntry = f.entry ? ` [${f.entry}]` : "";
  return `${f.message}${withEntry}`;
}

/** رفع مستوى التحقق — الصيغة تبقى كما هي (2 تبقى 2، 3 تبقى 3 — لا ترقية صامتة). */
function withValidatedLevel(m: AnyBackupManifest): AnyBackupManifest {
  const nextLevel = m.verification.level === "RESTORE_VERIFIED" ? ("RESTORE_VERIFIED" as const) : ("VALIDATED" as const);
  const verification = { ...m.verification, level: nextLevel, validatedAt: new Date().toISOString() };
  if (m.formatVersion === 3) return { ...m, verification };
  return { ...m, verification };
}

/**
 * توثيق Drill ناجح على الـ Manifest — نفس الصيغة بلا ترقية.
 * drillRuns يزداد مع كل نجاح — كي لا يُقرأ تشغيلان مستقلان كحدث واحد
 * (مع operationId المستقل لكل تشغيل — ملاحظة المستخدم في 4A.1).
 */
function withDrillVerified(m: AnyBackupManifest, operationId: string): AnyBackupManifest {
  const verification = {
    ...m.verification,
    level: "RESTORE_VERIFIED" as const,
    drillAt: new Date().toISOString(),
    drillOperationId: operationId,
    drillRuns: (m.verification.drillRuns ?? 0) + 1,
  };
  if (m.formatVersion === 3) return { ...m, verification };
  return { ...m, verification };
}

/** إعادة كتابة manifest.json داخل الـ ZIP + الجانبي (ذرية tmp+rename) — الصيغة كما هي. */
async function rewriteManifestInZip(zipPath: string, manifest: AnyBackupManifest): Promise<void> {
  const zip = await JSZip.loadAsync(readFileSync(zipPath));
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  const out = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  writePrivateFileAtomic(zipPath, out);
  writePrivateFileAtomic(zipPath.replace(/\.zip$/, ".manifest.json"), JSON.stringify(manifest, null, 2));
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  التحقق الصريح                                                           */
/* ──────────────────────────────────────────────────────────────────────── */

export async function validateBackupById(id: string, actor: ActorInfo): Promise<ValidationReport> {
  assertSafeId(id);
  return withOpLock(async () => {
    const artifact = findArtifact(id);
    if (!artifact) throw new BackupError("NOT_FOUND", "لا توجد نسخة بهذا المعرف", 404);
    const opId = newOperationId("validate");
    try {
      const report = await validateBackupArtifact({
        zipPath: artifact.zipPath,
        actor,
        source: artifact.source,
        operationId: opId,
      });
      await appendRecoveryEvent({
        operationId: opId,
        event: "BACKUP_VALIDATED",
        actor,
        backupId: report.backupId,
        result: "success",
        details: { source: artifact.source, level: report.level, durationMs: report.durationMs },
      });
      await writeAuditSafe({
        user: { id: actor.id, username: actor.username },
        action: AUDIT_ACTIONS.BACKUP_VALIDATED,
        entityType: AUDIT_ENTITY_TYPES.Backup,
        entityId: report.backupId,
        description: `نجح التحقق من النسخة «${report.backupId}» — المستوى ${report.level}`,
        metadata: { level: report.level, durationMs: report.durationMs, source: artifact.source },
      });
      return report;
    } catch (e) {
      const reason = e instanceof BackupError ? `${e.code}: ${e.message}` : String(e);
      await appendRecoveryEvent({
        operationId: opId,
        event: "BACKUP_FAILED",
        actor,
        backupId: id,
        result: "failure",
        details: { stage: "VALIDATION", source: artifact.source, reason },
      });
      await writeAuditSafe({
        user: { id: actor.id, username: actor.username },
        action: AUDIT_ACTIONS.BACKUP_FAILED,
        entityType: AUDIT_ENTITY_TYPES.Backup,
        entityId: id,
        description: `فشل التحقق من النسخة «${id}» — ${reason}`,
        metadata: { stage: "VALIDATION", reason, source: artifact.source },
      });
      if (e instanceof BackupError) throw e;
      throw new BackupError("IO", `فشل التحقق: ${reason}`, 500);
    }
  });
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Restore Drill — قاعدة مؤقتة معزولة حصرًا (لا يمس التشغيل إطلاقًا)       */
/* ──────────────────────────────────────────────────────────────────────── */

export async function runRestoreDrillById(id: string, actor: ActorInfo): Promise<DrillReport> {
  assertSafeId(id);
  return withOpLock(async () => {
    const opId = newOperationId("drill");
    const t0 = Date.now();
    const steps: CheckResult[] = [];
    const prismaReadTests: CheckResult[] = [];
    const warnings: string[] = [];
    let tempClient: PrismaClient | null = null;
    const ws = ensurePrivateDir(path.join(resolveStagingDir(), `drill-${opId}`));

    // رقم تشغيل مستقل لكل Drill — تشغيلان لنفس النسخة لا يبدآن كحدثين مكررين
    // (operationId مميز لكل تشغيل + sequence في details — ملاحظة المستخدم 4A.1)
    const priorDrills = await countRecoveryEvents("DRILL_STARTED", id);
    const drillRunSequence = priorDrills + 1;
    await appendRecoveryEvent({
      operationId: opId,
      event: "DRILL_STARTED",
      actor,
      backupId: id,
      result: "info",
      details: {
        target: "temp-isolated-db",
        drillRun: { sequence: drillRunSequence, startedAt: new Date().toISOString() },
      },
    });

    try {
      const artifact = findArtifact(id);
      if (!artifact) throw new BackupError("NOT_FOUND", "لا توجد نسخة بهذا المعرف", 404);
      let manifest = artifact.manifest;

      // الرخصة: لا Drill إلا لنسخة تم التحقق منها — CREATED تُتحقق تلقائيًا أولًا
      if (manifest.verification.level === "CREATED") {
        steps.push({ name: "تحقق أولي (CREATED → VALIDATED)", code: "AUTO_VALIDATE", ok: true });
        await validateBackupArtifact({
          zipPath: artifact.zipPath,
          actor,
          source: artifact.source,
          operationId: newOperationId("validate"),
        });
        const refreshed = findArtifact(id);
        if (!refreshed) throw new BackupError("NOT_FOUND", "اختفاء النسخة أثناء التحقق", 404);
        manifest = refreshed.manifest;
        if (manifest.verification.level === "CREATED") {
          throw new BackupError("NOT_VALIDATED", "لم يكتمل التحقق الأولي — لا Drill");
        }
      }

      const zipBuf = readFileSync(artifact.zipPath);

      // 1) فك في temp معزول + بوابة أمن ZIP
      let t = Date.now();
      const inspected = inspectZipBuffer(zipBuf, {
        maxUncompressedBytes: UPLOAD_LIMITS.maxUncompressedMB * 1024 * 1024,
        maxEntries: UPLOAD_LIMITS.maxZipEntries,
        allowedNames: ALLOWED_ZIP_ENTRIES,
        maxRatio: UPLOAD_LIMITS.maxCompressionRatio,
      });
      if (!inspected.ok) throw new BackupError(inspected.code, zipFailMsg(inspected));
      steps.push({ name: "فك الحزمة في temp معزول", code: "EXTRACT_OK", ok: true, ms: Date.now() - t });

      // 2) checksum
      t = Date.now();
      const dbBytes = await readZipEntry(zipBuf, "database.db", UPLOAD_LIMITS.maxUncompressedMB * 1024 * 1024);
      if ("ok" in dbBytes && !dbBytes.ok) throw new BackupError(dbBytes.code, zipFailMsg(dbBytes as ZipInspectFail));
      const actualSha = hashBuffer(dbBytes as Buffer);
      if (actualSha !== manifest.database.sha256) {
        throw new BackupError("CHECKSUM_MISMATCH", "عدم تطابق SHA-256 داخل الـ Drill");
      }
      steps.push({ name: "تطابق SHA-256", code: "CHECKSUM_OK", ok: true, ms: Date.now() - t });

      // 3) SQLite validation
      t = Date.now();
      const MAGIC = Buffer.from("SQLite format 3\0");
      if (!(dbBytes as Buffer).subarray(0, 16).equals(MAGIC)) {
        throw new BackupError("NOT_SQLITE", "database.db ليس SQLite");
      }
      const extractedPath = path.join(ws, "extracted-database.db");
      writeFileSync(extractedPath, dbBytes as Buffer, { mode: 0o600 });
      steps.push({ name: "بصمة SQLite سليمة", code: "SQLITE_MAGIC_OK", ok: true, ms: Date.now() - t });

      // 4) توافق المخطط — ثم migrations على المؤقتة فقط إن لزم (4A: لا إصدارات أقدم مسجلة)
      t = Date.now();
      const probe = tempClientFor(extractedPath);
      const integ = await probe.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`);
      if ((integ[0]?.integrity_check ?? "") !== "ok") {
        throw new BackupError("CORRUPT_DB", `integrity_check: ${integ[0]?.integrity_check}`);
      }
      await probe.$disconnect();
      const candidateCanonical = await (async () => {
        const c = tempClientFor(extractedPath);
        try {
          return await computeCanonicalFingerprint(c);
        } finally {
          await c.$disconnect();
        }
      })();
      const candidatePhysical = await (async () => {
        const c = tempClientFor(extractedPath);
        try {
          return await computePhysicalFingerprint(c);
        } finally {
          await c.$disconnect();
        }
      })();
      // اتساق بصمات الـ Manifest مع محتوى النسخة — قبل أي قرار قبول (لا ثقة بقيمة مكتوبة)
      const physicalMatchesManifest = manifest.schemaFingerprint === candidatePhysical;
      const canonicalMatchesManifest =
        manifest.formatVersion === 3 ? manifest.canonicalSchemaFingerprint === candidateCanonical : null;
      if (!physicalMatchesManifest || canonicalMatchesManifest === false) {
        throw new BackupError(
          "MANIFEST_INCONSISTENT",
          "بصمة المخطط في الـ Manifest لا تطابق محتوى database.db داخل الحزمة",
          422
        );
      }
      const liveIdentity = await refreshCurrentSchemaIdentity();
      // قرار التوافق على البصمة القاعدية الدلالية حصرًا (4A.1)
      const classified = classifySchemaFingerprint(candidateCanonical);
      if (classified.schemaClass === "older-known") {
        // 4B: تطبيق تسلسل migrations على المؤقتة فقط — غير مفعّل في 4A
        throw new BackupError("SCHEMA_MIGRATION_UNAVAILABLE", "ترحيل المخططات الأقدم يعتمد في 4B (مؤقتة فقط)");
      }
      if (classified.schemaClass !== "current") {
        throw new BackupError(
          "SCHEMA_UNKNOWN",
          "المخطط الدلالي غير معروف — رفض (يشمل الأحدث من التطبيق: لا downgrade)",
          422,
          { candidateCanonical: shortFp(candidateCanonical), currentCanonical: shortFp(liveIdentity.canonical) }
        );
      }
      steps.push({
        name: "توافق المخطط الدلالي canonical (بلا ترحيل — مطابق للحالي)",
        code: "SCHEMA_OK",
        ok: true,
        ms: Date.now() - t,
        detail: `${shortFp(candidateCanonical)} · physical: ${shortFp(candidatePhysical)} (تشخيصي)`,
      });

      // 5) integrity_check على DB مؤقتة عاملة
      t = Date.now();
      const workingPath = path.join(ws, "drill-working.db");
      writeFileSync(workingPath, readFileSync(extractedPath), { mode: 0o600 });
      tempClient = tempClientFor(workingPath);
      const integ2 = await tempClient.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`);
      if ((integ2[0]?.integrity_check ?? "") !== "ok") {
        throw new BackupError("CORRUPT_DB", "integrity_check على المؤقتة فشل");
      }
      steps.push({ name: "integrity_check على المؤقتة", code: "INTEGRITY_OK", ok: true, ms: Date.now() - t });

      // 6) اتصال Prisma حقيقي على المؤقتة + قراءة الجداول الأساسية (إثبات طبقة البيانات)
      t = Date.now();
      const userSample = await tempClient.user.findMany({ take: 5, select: { id: true, username: true, role: true } });
      const groupSample = await tempClient.group.findMany({ take: 5, select: { id: true, name: true } });
      const reportSample = await tempClient.report.findMany({ take: 5, select: { id: true, name: true, status: true, periodEnd: true } });
      const wfSample = await tempClient.workflowHistory.findMany({ take: 5, select: { id: true, action: true, cycle: true } });
      const auditSample = await tempClient.auditLog.findMany({ take: 5, select: { id: true, action: true } });
      prismaReadTests.push(
        { name: "Prisma: user.read", code: "READ_OK", ok: true, detail: `${userSample.length} صف مقروء` },
        { name: "Prisma: group.read", code: "READ_OK", ok: true, detail: `${groupSample.length} صف مقروء` },
        { name: "Prisma: report.read", code: "READ_OK", ok: true, detail: `${reportSample.length} صف مقروء` },
        { name: "Prisma: workflowHistory.read", code: "READ_OK", ok: true, detail: `${wfSample.length} صف مقروء` },
        { name: "Prisma: auditLog.read", code: "READ_OK", ok: true, detail: `${auditSample.length} صف مقروء` }
      );
      steps.push({
        name: "قراءة Prisma حقيقية على المؤقتة (5 جداول)",
        code: "PRISMA_READ_OK",
        ok: true,
        ms: Date.now() - t,
      });

      // 7) مقارنة counts مع Manifest
      t = Date.now();
      const countsRes = await collectCounts(tempClient);
      if (!countsRes.ok) throw new BackupError("MISSING_TABLES", countsRes.missingTable);
      const countsMatched =
        countsRes.counts.users === manifest.counts.users &&
        countsRes.counts.groups === manifest.counts.groups &&
        countsRes.counts.reports === manifest.counts.reports &&
        countsRes.counts.workflowHistory === manifest.counts.workflowHistory &&
        countsRes.counts.auditLog === manifest.counts.auditLog;
      if (!countsMatched) {
        throw new BackupError("COUNTS_MISMATCH", "عدّ المؤقتة لا يطابق عدّ الـ Manifest", 422, {
          manifest: manifest.counts,
          actual: countsRes.counts,
        });
      }
      steps.push({ name: "مطابقة counts مع Manifest", code: "COUNTS_OK", ok: true, ms: Date.now() - t });

      // 8) business sanity
      t = Date.now();
      const periodRange = await collectPeriodRange(tempClient);
      const periodRangeMatched =
        periodRange.minPeriodEnd === manifest.periodRange.minPeriodEnd &&
        periodRange.maxPeriodEnd === manifest.periodRange.maxPeriodEnd;
      if (!periodRangeMatched) {
        throw new BackupError("PERIOD_MISMATCH", "periodRange لا يطابق الـ Manifest", 422);
      }
      if (countsRes.counts.users === 0) warnings.push("SANITY_NO_USERS: لا مستخدمون في النسخة");
      const statusRows = await tempClient.report.groupBy({ by: ["status"], _count: { status: true } });
      const KNOWN_STATUSES = new Set(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "PENDING_APPROVAL", "RETURNED", "APPROVED", "REOPENED"]);
      const oddStatuses = statusRows.map((r) => r.status).filter((s) => !KNOWN_STATUSES.has(s));
      if (oddStatuses.length > 0) {
        warnings.push(`SANITY_UNKNOWN_STATUSES: حالات غير معروفة في التقارير — ${oddStatuses.join(", ")}`);
      }
      steps.push({ name: "فحوص sanity أعمال", code: "SANITY_OK", ok: true, ms: Date.now() - t, detail: oddStatuses.length === 0 ? "لا حالات شاذة" : "تحذيرات" });

      // 9) النتيجة: RESTORE_VERIFIED — drillRuns يزداد مع كل تشغيل ناجح
      const updated = withDrillVerified(manifest, opId);
      await rewriteManifestInZip(artifact.zipPath, updated);

      const report: DrillReport = {
        ok: true,
        backupId: manifest.backupId,
        source: artifact.source,
        level: "RESTORE_VERIFIED",
        checks: steps,
        steps,
        prismaReadTests,
        warnings,
        countsMatched,
        periodRangeMatched,
        physicalSchemaFingerprint: candidatePhysical,
        canonicalSchemaFingerprint: candidateCanonical,
        manifestFormat: manifest.formatVersion,
        manifestClass: manifestClassOf(manifest),
        canonicalMatchesManifest,
        durationMs: Date.now() - t0,
      };

      // تقرير Drill محفوظ في staging (مسار مرحلي — لا يحوي مسارات داخلية)
      writePrivateFileAtomic(
        path.join(resolveStagingDir(), `drill-${opId}.json`),
        JSON.stringify({ ...report, manifestSummary: { backupId: manifest.backupId, counts: manifest.counts } }, null, 2)
      );

      await appendRecoveryEvent({
        operationId: opId,
        event: "DRILL_VERIFIED",
        actor,
        backupId: manifest.backupId,
        result: "success",
        details: {
          durationMs: report.durationMs,
          counts: countsRes.counts,
          level: "RESTORE_VERIFIED",
          drillRun: { sequence: drillRunSequence, operationId: opId },
        },
      });
      await writeAuditSafe({
        user: { id: actor.id, username: actor.username },
        action: AUDIT_ACTIONS.BACKUP_DRILLED,
        entityType: AUDIT_ENTITY_TYPES.Backup,
        entityId: manifest.backupId,
        description: `نجح Restore Drill للنسخة «${manifest.backupId}» على قاعدة مؤقتة معزولة — RESTORE_VERIFIED`,
        metadata: { durationMs: report.durationMs, operationId: opId, counts: countsRes.counts },
      });

      return report;
    } catch (e) {
      const reason = e instanceof BackupError ? `${e.code}: ${e.message}` : String(e);
      await appendRecoveryEvent({
        operationId: opId,
        event: "DRILL_FAILED",
        actor,
        backupId: id,
        result: "failure",
        details: { stage: "DRILL", reason },
      });
      await writeAuditSafe({
        user: { id: actor.id, username: actor.username },
        action: AUDIT_ACTIONS.BACKUP_FAILED,
        entityType: AUDIT_ENTITY_TYPES.Backup,
        entityId: id,
        description: `فشل Restore Drill للنسخة «${id}» — ${reason}`,
        metadata: { stage: "DRILL", reason, operationId: opId },
      });
      if (e instanceof BackupError) throw e;
      throw new BackupError("IO", `فشل الـ Drill: ${reason}`, 500);
    } finally {
      try {
        await tempClient?.$disconnect();
      } catch {
        /* ignore */
      }
      rmSync(ws, { recursive: true, force: true });
    }
  });
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  الرفع — staging فقط + نفس خط التحقق                                     */
/* ──────────────────────────────────────────────────────────────────────── */

export interface UploadOutcome {
  uploadId: string;
  backupId: string;
  level: VerificationLevel;
  report: ValidationReport;
  manifest: BackupManifestV2;
}

export async function uploadBackupZip(
  actor: ActorInfo,
  bytes: Buffer,
  originalName: string
): Promise<UploadOutcome> {
  return withOpLock(async () => {
    const opId = newOperationId("upload");
    const uploadId = newUploadId();
    const displayName = sanitizeDisplayName(originalName);
    const uploadsDir = ensurePrivateDir(path.join(resolveStagingDir(), "uploads"));
    const ws = ensurePrivateDir(path.join(resolveStagingDir(), `upload-${opId}`));

    await appendRecoveryEvent({
      operationId: opId,
      event: "UPLOAD_RECEIVED",
      actor,
      backupId: null,
      result: "info",
      details: { displayName, compressedBytes: bytes.length },
    });

    let rejectedLogged = false;
    const reject = async (code: string, message: string, httpStatus = 400): Promise<never> => {
      rmSync(ws, { recursive: true, force: true });
      rejectedLogged = true;
      await appendRecoveryEvent({
        operationId: opId,
        event: "UPLOAD_REJECTED",
        actor,
        backupId: null,
        result: "failure",
        details: { reason: code, message, displayName },
      });
      await writeAuditSafe({
        user: { id: actor.id, username: actor.username },
        action: AUDIT_ACTIONS.BACKUP_FAILED,
        entityType: AUDIT_ENTITY_TYPES.Backup,
        entityId: null,
        description: `رفض ملف مرفوع «${displayName}» — ${code}: ${message}`,
        metadata: { stage: "UPLOAD", reason: code },
      });
      throw new BackupError(code, message, httpStatus);
    };

    try {
      // الحد المضغوط — قبل أي فحص آخر
      if (bytes.length > UPLOAD_LIMITS.maxUploadMB * 1024 * 1024) {
        await reject("TOO_LARGE", `الحجم المضغوط ${bytes.length} يتجاوز الحد`, 413);
      }

      // بوابة أمن ZIP — المسموح: database.db + manifest.json حصرًا
      const inspected = inspectZipBuffer(bytes, {
        maxUncompressedBytes: UPLOAD_LIMITS.maxUncompressedMB * 1024 * 1024,
        maxEntries: UPLOAD_LIMITS.maxZipEntries,
        allowedNames: ALLOWED_ZIP_ENTRIES,
        maxRatio: UPLOAD_LIMITS.maxCompressionRatio,
        maxCompressedBytes: UPLOAD_LIMITS.maxUploadMB * 1024 * 1024,
      });
      if (!inspected.ok) {
        await reject(inspected.code, zipFailMsg(inspected), inspected.code === "TOO_LARGE" ? 413 : 400);
      }

      // manifest.json من الداخل
      const manifestRaw = await readZipEntry(bytes, "manifest.json", UPLOAD_LIMITS.maxManifestBytes);
      if ("ok" in manifestRaw && !manifestRaw.ok) {
        await reject(manifestRaw.code, zipFailMsg(manifestRaw as ZipInspectFail));
      }
      const manifest = parseManifest((manifestRaw as Buffer).toString("utf8"));
      if (!manifest) {
        await reject("BAD_MANIFEST", "manifest.json داخل الحزمة غير صالح أو ناقص الحقول الإلزامية");
      }

      // حفظ الحزمة كما هي في staging ثم خط التحقق المشترك عليها
      const zipPath = path.join(uploadsDir, `${uploadId}.zip`);
      writePrivateFileAtomic(zipPath, bytes);
      writePrivateFileAtomic(
        zipPath.replace(/\.zip$/, ".manifest.json"),
        JSON.stringify(
          (manifest as AnyBackupManifest).backupType === "upload"
            ? manifest
            : { ...(manifest as AnyBackupManifest), backupType: "upload" as const },
          null,
          2
        )
      );
      rmSync(ws, { recursive: true, force: true });

      const report = await validateBackupArtifact({
        zipPath,
        actor,
        source: "upload",
        operationId: newOperationId("validate"),
      });

      // إثراء الـ Manifest بمعلومات الرفع (وصفية — ليست آلية تحقق)
      const sidecarPath = zipPath.replace(/\.zip$/, ".manifest.json");
      const current = hasManifest(sidecarPath)?.manifest;
      if (current) {
        const enriched: AnyBackupManifest = {
          ...current,
          uploadInfo: {
            originalNameSanitized: displayName,
            uploadedAt: new Date().toISOString(),
            uploadedByUsername: actor.username ?? "",
          },
        };
        await rewriteManifestInZip(zipPath, enriched);
      }

      const finalManifest = hasManifest(sidecarPath)?.manifest ?? (manifest as BackupManifestV2);
      await appendRecoveryEvent({
        operationId: opId,
        event: "BACKUP_VALIDATED",
        actor,
        backupId: finalManifest.backupId,
        result: "success",
        details: { source: "upload", uploadId, level: finalManifest.verification.level, displayName },
      });
      await writeAuditSafe({
        user: { id: actor.id, username: actor.username },
        action: AUDIT_ACTIONS.BACKUP_UPLOADED,
        entityType: AUDIT_ENTITY_TYPES.Backup,
        entityId: finalManifest.backupId,
        description: `رفع نسخة للتحقق «${finalManifest.backupId}» (${displayName}) — المستوى ${finalManifest.verification.level}`,
        metadata: { source: "upload", uploadId, level: finalManifest.verification.level },
      });

      return {
        uploadId,
        backupId: finalManifest.backupId,
        level: finalManifest.verification.level,
        report,
        manifest: finalManifest,
      };
    } catch (e) {
      rmSync(ws, { recursive: true, force: true });
      // فشل التحقق بعد الحفظ: إزالة الحزمة المرحلية (الرفض النهائي)
      const zipPath = path.join(uploadsDir, `${uploadId}.zip`);
      rmSync(zipPath, { force: true });
      rmSync(zipPath.replace(/\.zip$/, ".manifest.json"), { force: true });
      if (e instanceof BackupError) {
        if (!rejectedLogged) {
          // رفض في مرحلة التحقق المحتواي (checksum/SQLite/مخطط) — أثر أمني كامل أيضًا
          await appendRecoveryEvent({
            operationId: opId,
            event: "UPLOAD_REJECTED",
            actor,
            backupId: null,
            result: "failure",
            details: { reason: e.code, message: e.message, displayName, stage: "VALIDATION" },
          });
          await writeAuditSafe({
            user: { id: actor.id, username: actor.username },
            action: AUDIT_ACTIONS.BACKUP_FAILED,
            entityType: AUDIT_ENTITY_TYPES.Backup,
            entityId: null,
            description: `رفض ملف مرفوع «${displayName}» في التحقق — ${e.code}: ${e.message}`,
            metadata: { stage: "UPLOAD_VALIDATION", reason: e.code },
          });
        }
        throw e;
      }
      throw new BackupError("IO", `فشل الرفع: ${String(e)}`, 500);
    }
  });
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  تفاصيل وتنزيل                                                           */
/* ──────────────────────────────────────────────────────────────────────── */

interface Artifact {
  id: string;
  source: "local" | "upload";
  zipPath: string;
  manifest: AnyBackupManifest;
  sizeBytes: number;
}

function findArtifact(id: string): Artifact | null {
  const dirs: Array<{ dir: string; source: "local" | "upload" }> = [
    { dir: resolveBackupDir(), source: "local" },
    { dir: path.join(resolveStagingDir(), "uploads"), source: "upload" },
  ];
  for (const { dir, source } of dirs) {
    const zipPath = path.join(dir, `${id}.zip`);
    if (existsSync(zipPath)) {
      const manifest = hasManifest(zipPath.replace(/\.zip$/, ".manifest.json"));
      if (!manifest) continue;
      return {
        id,
        source,
        zipPath,
        manifest: manifest.manifest,
        sizeBytes: statSync(zipPath).size,
      };
    }
  }
  return null;
}

export function getBackupDetails(id: string): {
  manifest: AnyBackupManifest;
  source: "local" | "upload";
  sizeBytes: number;
  zipExists: boolean;
} | null {
  assertSafeId(id);
  const artifact = findArtifact(id);
  if (!artifact) return null;
  return {
    manifest: artifact.manifest,
    source: artifact.source,
    sizeBytes: artifact.sizeBytes,
    zipExists: true,
  };
}

/** مسار ZIP للتنزيل — تحديد إغلاق (confinement) + وجود. */
export function getBackupZipForDownload(id: string): { fileName: string; buf: Buffer; sizeBytes: number } {
  assertSafeId(id);
  const artifact = findArtifact(id);
  if (!artifact) throw new BackupError("NOT_FOUND", "لا توجد نسخة بهذا المعرف", 404);
  const resolved = path.resolve(artifact.zipPath);
  const root = path.resolve(path.dirname(artifact.zipPath));
  if (!resolved.startsWith(root + path.sep)) {
    throw new BackupError("BAD_ID", "معرف غير صالح", 400);
  }
  return { fileName: `${id}.zip`, buf: readFileSync(artifact.zipPath), sizeBytes: artifact.sizeBytes };
}
