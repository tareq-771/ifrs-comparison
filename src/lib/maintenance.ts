// Phase 4B.1 — وضع الصيانة: آلة حالة مركزية + حراس الكتابة/القراءة + سجل التصريف.
//
// القرارات الحاكمة (نص المستخدم):
//   1. آلة حالة مركزية وليست boolean فقط:
//      NORMAL → VALIDATING → PREPARING → DRAINING → SWAPPING → VERIFYING
//      → (NORMAL | ROLLING_BACK → (NORMAL | RECOVERY_REQUIRED))
//      مع operationId وstartedAt وstartedBy وmessage لكل انتقال.
//   2. الحالة التشغيلية خارج قاعدة البيانات المستعادة — في VAR_DIR —
//      وبكتابة ذرية (tmp + fsync + rename) بحيث لا ينتج ملف حالة جزئي عند crash.
//   3. Write Guard مركزي واحد: assertSystemWritable (عبر acquireWriteLease)
//      يُطبق على كل mutation endpoints — ومعه اختبار آلي يجرد المسارات الكتابية
//      ويثبت حمايتها (scripts/phase4b1-write-guard-scan.ts + المصفوفة في harness).
//   4. DRAINING: لا كتابة جديدة + انتظار وصول الكتابات الجارية إلى صفر بمهلة
//      محددة — تجاوزها ⇒ إلغاء قبل التبديل. لا نقتل كتابة جارية أبدًا.
//   5. SWAPPING وما بعدها: حجب كامل (القراءة أيضًا 503) حتى نجاح التحقق النهائي
//      أو نجاح التراجع — لا عودة إلى NORMAL إلا بها.
//   6. RECOVERY_REQUIRED: القراءة والكتابة محجوبتان — لا reset تلقائي —
//      والعرض للإدارة operationId ومعلومات تشخيصية آمنة فقط.
//   7. Crash Recovery: أي حالة غير NORMAL موجودة عند إقلاع الخادم (أو عند
//      قراءة الحارس) تعني عملية مقاطعة بلا إثبات سلامة نهاية ⇒ fail-closed
//      إلى RECOVERY_REQUIRED — لا نفترض أن restart يعني نجاح العملية.
//
// الفشل الآمن لملف الحالة: ملف تالف/غير قابل للتحليل ⇒ يُعامل RECOVERY_REQUIRED
// (لا يمكن إثبات السلامة ⇒ لا فتح الخدمة) — يُسترد يدويًا عبر سكربت المشغّل الموثق.

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  ensurePrivateDir,
  MAINTENANCE_DRAIN_TIMEOUT_MS,
  resolveMaintenanceStateFilePath,
} from "@/lib/backup-config";
import { isEpochAvailable } from "@/lib/session-epoch";

/* ──────────────────────────────────────────────────────────────────────── */
/*  آلة الحالة                                                               */
/* ──────────────────────────────────────────────────────────────────────── */

export type MaintenanceState =
  | "NORMAL"
  | "VALIDATING"
  | "PREPARING"
  | "DRAINING"
  | "SWAPPING"
  | "VERIFYING"
  | "ROLLING_BACK"
  | "RECOVERY_REQUIRED";

export type MaintenanceLevel = "write-block" | "full-block" | "locked" | null;

const STATE_LEVEL: Record<MaintenanceState, MaintenanceLevel> = {
  NORMAL: null,
  VALIDATING: "write-block",
  PREPARING: "write-block",
  DRAINING: "write-block",
  SWAPPING: "full-block",
  VERIFYING: "full-block",
  ROLLING_BACK: "full-block",
  RECOVERY_REQUIRED: "locked",
};

export interface MaintenanceStateFile {
  state: MaintenanceState;
  level: MaintenanceLevel;
  operationId: string | null;
  startedAt: string | null;
  startedBy: { id: string | null; username: string } | null;
  message: string | null;
  updatedAt: string;
  /** سجل الانتقالات داخل العملية الواحدة (تشخيصي). */
  history: Array<{ state: MaintenanceState; at: string; ms: number }>;
  /** أعلام تشخيصية يستخدمها محرك الاستعادة والمشغّل اليدوي. */
  flags: {
    candidateBackupId?: string | null;
    preRestoreBackupId?: string | null;
    swapCompleted?: boolean;
    postVerifyStarted?: boolean;
  };
  /** عند RECOVERY_REQUIRED: سبب آمن للتشخيص (لا مسارات ولا أسرار). */
  recovery?: {
    reason: string;
    originalState: MaintenanceState | null;
    originalOperationId: string | null;
    detectedAt: string;
  } | null;
}

export function readMaintenanceStateFile(): MaintenanceStateFile | null {
  const file = resolveMaintenanceStateFilePath();
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const obj = JSON.parse(raw) as MaintenanceStateFile;
    if (!obj || typeof obj !== "object" || typeof obj.state !== "string") return null;
    return obj;
  } catch {
    // ملف تالف = لا يمكن إثبات السلامة ⇒ fail-closed (يُعامل RECOVERY_REQUIRED)
    return {
      state: "RECOVERY_REQUIRED",
      level: "locked",
      operationId: null,
      startedAt: null,
      startedBy: null,
      message: "STATE_FILE_CORRUPT",
      updatedAt: new Date().toISOString(),
      history: [],
      flags: {},
      recovery: {
        reason: "state_file_corrupt",
        originalState: null,
        originalOperationId: null,
        detectedAt: new Date().toISOString(),
      },
    };
  }
}

/** كتابة ذرية: tmp بfsync ثم rename داخل نفس المجلد — لا ملف حالة جزئي عند crash. */
function writeStateFileAtomic(next: MaintenanceStateFile): void {
  const file = resolveMaintenanceStateFilePath();
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(next, null, 2), 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export function clearMaintenanceStateFile(): void {
  const file = resolveMaintenanceStateFilePath();
  try {
    if (existsSync(file)) rmSync(file, { force: true });
  } catch {
    /* ignore — القراءة التالفة تفشل مغلقًا على أي حال */
  }
}

/** ملخص آمن للعرض في الـ API/الواجهة — لا مسارات قرص ولا أسرار. */
export function maintenancePublicInfo(): {
  state: MaintenanceState;
  level: MaintenanceLevel;
  active: boolean;
  stateFileStatus: "missing" | "ok" | "corrupt";
  operationId: string | null;
  startedAt: string | null;
  startedBy: string | null;
  message: string | null;
  recovery: { reason: string; originalState: string | null; originalOperationId: string | null } | null;
} {
  const rawExists = existsSync(resolveMaintenanceStateFilePath());
  const sf = readMaintenanceStateFile();
  if (!sf) {
    return {
      state: "NORMAL",
      level: null,
      active: false,
      stateFileStatus: rawExists ? "corrupt" : "missing",
      operationId: null,
      startedAt: null,
      startedBy: null,
      message: null,
      recovery: null,
    };
  }
  const corrupt = sf.message === "STATE_FILE_CORRUPT";
  return {
    state: sf.state,
    level: sf.level,
    active: sf.state !== "NORMAL",
    stateFileStatus: corrupt ? "corrupt" : "ok",
    operationId: sf.operationId,
    startedAt: sf.startedAt,
    startedBy: sf.startedBy?.username ?? null,
    message: sf.message,
    recovery: sf.recovery
      ? {
          reason: sf.recovery.reason,
          originalState: sf.recovery.originalState,
          originalOperationId: sf.recovery.originalOperationId,
        }
      : null,
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  خطأ الحجب + تحويله إلى استجابة API موحدة                                */
/* ──────────────────────────────────────────────────────────────────────── */

export class MaintenanceError extends Error {
  code: "MAINTENANCE_MODE" | "FULL_BLOCK" | "RECOVERY_REQUIRED" | "EPOCH_UNAVAILABLE" | "STATE_FILE_CORRUPT";
  httpStatus: number;
  state: MaintenanceState;
  operationId: string | null;
  constructor(
    code: MaintenanceError["code"],
    message: string,
    state: MaintenanceState,
    operationId: string | null,
    httpStatus = 503
  ) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.state = state;
    this.operationId = operationId;
  }
}

/** استجابة موحدة لأخطاء الصيانة داخل catch أي route — null إن لم يكن من نوعها. */
export function maintenanceErrorResponse(error: unknown): {
  body: Record<string, unknown>;
  status: number;
} | null {
  if (error instanceof MaintenanceError) {
    const info = maintenancePublicInfo();
    return {
      status: error.httpStatus,
      body: {
        error: error.message,
        code: error.code,
        maintenance: {
          state: error.state,
          level: info.level,
          operationId: error.operationId,
          ...(error.state === "RECOVERY_REQUIRED" ? { recovery: info.recovery } : {}),
        },
      },
    };
  }
  return null;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  سجل العمليات الجارية (Drain Registry) — في عملية الخادم الواحدة         */
/* ──────────────────────────────────────────────────────────────────────── */

interface LeaseEntry {
  route: string;
  kind: "write" | "read";
  startedAt: number;
}

interface GuardRegistry {
  writes: Map<string, LeaseEntry>;
  reads: Map<string, LeaseEntry>;
}

const g = globalThis as unknown as { __recoveryGuardRegistry?: GuardRegistry };
function registry(): GuardRegistry {
  if (!g.__recoveryGuardRegistry) {
    g.__recoveryGuardRegistry = { writes: new Map(), reads: new Map() };
  }
  return g.__recoveryGuardRegistry;
}

export function activeWriteCount(): number {
  return registry().writes.size;
}
export function activeReadCount(): number {
  return registry().reads.size;
}
/** قائمة تشخيصية آمنة للمسارات الجارية (للتقارير — لا بيانات طلبات). */
export function activeWriteRoutes(): string[] {
  return [...registry().writes.values()].map((e) => e.route);
}

export interface SystemWriteLease {
  release: () => void;
}

/**
 * بوابة الكتابة المركزية — تُستدعى في مقدمة كل mutation handler قبل أي عمل آخر
 * (قبل حتى المصادقة: أثناء الصيانة يُرد 503 بلا أي تسريب آخر).
 *  - أي حالة ≠ NORMAL ⇒ حجب (503 MAINTENANCE_MODE أو RECOVERY_REQUIRED).
 *  - epoch غير قابل للقراءة ⇒ حجب كتابة (fail-safe فوق طبقة 401).
 *  - يُسجل الـ lease في عدّاد التصريف حتى يستدعي المحرك release() في finally.
 */
export function acquireWriteLease(route: string): SystemWriteLease {
  const sf = readMaintenanceStateFile();
  if (sf && sf.state !== "NORMAL") {
    const opId = sf.operationId;
    if (sf.state === "RECOVERY_REQUIRED") {
      throw new MaintenanceError(
        "RECOVERY_REQUIRED",
        "الخدمة مقفلة — تدخل تشغيلي يدوي مطلوب (RECOVERY_REQUIRED)",
        sf.state,
        opId
      );
    }
    const corrupt = sf.message === "STATE_FILE_CORRUPT";
    throw new MaintenanceError(
      corrupt ? "STATE_FILE_CORRUPT" : "MAINTENANCE_MODE",
      corrupt
        ? "ملف حالة الصيانة تالف — النظام مغلق حتى الاسترداد الموثق"
        : "النظام في وضع الصيانة — الكتابة محجوبة مؤقتًا",
      sf.state,
      opId
    );
  }
  if (!isEpochAvailable()) {
    throw new MaintenanceError(
      "EPOCH_UNAVAILABLE",
      "عدّاد جلسات النظام غير قابل للقراءة — الكتابة محجوبة حتى الاسترداد (fail-safe)",
      "NORMAL",
      null
    );
  }
  const id = randomUUID();
  registry().writes.set(id, { route, kind: "write", startedAt: Date.now() });
  return {
    release: () => {
      registry().writes.delete(id);
    },
  };
}

/**
 * بوابة القراءة — تمنع قراءات جديدة أثناء الحجب الكامل (SWAPPING وما بعده)
 * وتسجل القراءات الجارية لتصريفها بأفضل جهد قبل disconnect. حالات
 * write-block (VALIDATING/PREPARING/DRAINING) تُبقي القراءة تعمل (قرار المستخدم).
 */
export function acquireReadLease(route: string): SystemWriteLease {
  const sf = readMaintenanceStateFile();
  if (sf && sf.state !== "NORMAL") {
    const level = sf.level;
    if (level === "full-block" || level === "locked" || sf.state === "RECOVERY_REQUIRED") {
      const corrupt = sf.message === "STATE_FILE_CORRUPT";
      throw new MaintenanceError(
        sf.state === "RECOVERY_REQUIRED" ? "RECOVERY_REQUIRED" : corrupt ? "STATE_FILE_CORRUPT" : "FULL_BLOCK",
        sf.state === "RECOVERY_REQUIRED"
          ? "الخدمة مقفلة — تدخل تشغيلي يدوي مطلوب (RECOVERY_REQUIRED)"
          : corrupt
            ? "ملف حالة الصيانة تالف — النظام مغلق حتى الاسترداد الموثق"
            : "الخدمة في صيانة كاملة — القراءة محجوبة مؤقتًا",
        sf.state,
        sf.operationId
      );
    }
  }
  const id = randomUUID();
  registry().reads.set(id, { route, kind: "read", startedAt: Date.now() });
  return {
    release: () => {
      registry().reads.delete(id);
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  أدوات محرك الاستعادة — انتقالات الحالة والتصريف                          */
/* ──────────────────────────────────────────────────────────────────────── */

export interface TransitionInput {
  operationId: string;
  state: MaintenanceState;
  startedBy?: { id: string | null; username: string } | null;
  message?: string | null;
  flags?: Partial<MaintenanceStateFile["flags"]>;
}

/** انتقال حالة مع تراكم history داخل العملية الواحدة (قراءة-تعديل-كتابة ذرية). */
export function transitionMaintenanceState(input: TransitionInput): void {
  const file = resolveMaintenanceStateFilePath();
  const prev = readMaintenanceStateFile();
  const now = new Date().toISOString();
  const next: MaintenanceStateFile = {
    state: input.state,
    level: STATE_LEVEL[input.state],
    operationId: input.operationId,
    startedAt: prev?.startedAt ?? now,
    startedBy: input.startedBy ?? prev?.startedBy ?? null,
    message: input.message ?? null,
    updatedAt: now,
    history: [...(prev?.history ?? []), { state: input.state, at: now, ms: 0 }],
    flags: { ...(prev?.flags ?? {}), ...(input.flags ?? {}) },
    recovery: input.state === "RECOVERY_REQUIRED" ? prev?.recovery ?? null : null,
  };
  writeStateFileAtomic(next);
}

/** دخول RECOVERY_REQUIRED مع تشخيص آمن — من المحرك أو من كشف مقاطعة عند الإقلاع. */
export function enterRecoveryRequired(args: {
  operationId: string | null;
  reason: string;
  originalState: MaintenanceState | null;
  message: string;
  startedBy?: { id: string | null; username: string } | null;
}): void {
  const file = resolveMaintenanceStateFilePath();
  const prev = readMaintenanceStateFile();
  const now = new Date().toISOString();
  const next: MaintenanceStateFile = {
    state: "RECOVERY_REQUIRED",
    level: "locked",
    operationId: args.operationId ?? prev?.operationId ?? null,
    startedAt: prev?.startedAt ?? now,
    startedBy: args.startedBy ?? prev?.startedBy ?? null,
    message: args.message,
    updatedAt: now,
    history: [...(prev?.history ?? []), { state: "RECOVERY_REQUIRED", at: now, ms: 0 }],
    flags: prev?.flags ?? {},
    recovery: {
      reason: args.reason,
      originalState: args.originalState,
      originalOperationId: prev?.operationId ?? args.operationId ?? null,
      detectedAt: now,
    },
  };
  writeStateFileAtomic(next);
  void file;
}

/**
 * انتظار تصريف الكتابات الجارية إلى صفر — لا نقتل كتابة جارية أبدًا.
 * يعيد true عند الصفر، أو false عند تجاوز المهلة (المحرك يلغي قبل التبديل).
 */
export async function drainActiveWrites(timeoutMs: number = MAINTENANCE_DRAIN_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (activeWriteCount() === 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return activeWriteCount() === 0;
}

/** تصريف القراءات — أفضل جهد قصير قبل disconnect (قراءة مقطوعة = خطأ عرضي فقط). */
export async function drainActiveReadsBestEffort(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (activeReadCount() === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Crash Recovery — كشف مقاطعة عند الإقلاع (instrumentation)                */
/*                                                                           */
/*  قرار المستخدم حرفيًا: عند startup اقرأ الحالة الخارجية؛ إذا كانت غير    */
/*  NORMAL ولا توجد طريقة مؤكدة لإثبات سلامة النهاية ⇒ لا فتح طبيعي —       */
/*  RECOVERY_REQUIRED. لا نفترض أن restart يعني نجاح العملية.               */
/* ──────────────────────────────────────────────────────────────────────── */

export interface StartupCheckResult {
  transitioned: boolean;
  originalState: MaintenanceState | null;
  operationId: string | null;
}

export function startupRecoveryCheck(): StartupCheckResult {
  const sf = readMaintenanceStateFile();
  if (!sf || sf.state === "NORMAL") {
    return { transitioned: false, originalState: null, operationId: null };
  }
  // حالة غير NORMAL باقية من عملية سابقة — لا إثبات سلامة نهاية ⇒ fail-closed
  const operationId = sf.operationId;
  enterRecoveryRequired({
    operationId,
    reason: "startup_after_interrupted_operation",
    originalState: sf.state,
    message: `عملية سابقة توقفت دون إثبات اكتمال (الحالة المسجلة: ${sf.state}) — النظام مغلق حتى الاسترداد الموثق`,
  });
  return { transitioned: true, originalState: sf.state, operationId };
}

/** أداة لسكربت المشغّل اليدوي — مسح الحالة بعد تحقق بشري موثق (ليس API أبدًا). */
export function operatorClearMaintenanceState(): void {
  clearMaintenanceStateFile();
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  حقن كتابة وهمية للاختبار فقط — يُستخدم من fault-injection في بيئة معزولة */
/* ──────────────────────────────────────────────────────────────────────── */

const testPhantoms: string[] = [];

export function addPhantomWrite(route: string): void {
  const id = `phantom-${randomUUID()}`;
  registry().writes.set(id, { route, kind: "write", startedAt: Date.now() });
  testPhantoms.push(id);
}

export function clearPhantomWrites(): void {
  for (const id of testPhantoms) registry().writes.delete(id);
  testPhantoms.length = 0;
}
