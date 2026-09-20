// Phase 4B.1 — قفل عمليات الاسترجاع الخارجي (Recovery Operation Lock).
//
// قرار المستخدم حرفيًا:
//   • لا Restoreين في نفس الوقت.
//   • لا عملية نسخ/تحقق مدمرة أثناء swap (يتحقق عبر حراس الصيانة + هذا القفل).
//   • Drill لا يتحول إلى Restore ضمنيًا (بنيويًا: Drill يعمل على مؤقتة حصرًا).
//   • محاولة عملية ثانية ⇒ 409 RECOVERY_OPERATION_IN_PROGRESS.
//
// التنفيذ: ملف قفل خارجي بإنشاء حصري O_EXCL (ذرّي على مستوى نظام الملفات)
// يحمل operationId وkind وpid — يكشف المالك الحي عبر pid (عملية خادم واحدة
// موثقة كحد نطاق) ويعتبر القفل ستالًا إن مات صاحبه (crash) فيُستبدل مع إعادة
// معلومات المالك السابق للمستدعي كي يوثقها. داخل العملية الواحدة يوجد أيضًا
// mutex (Promise) لتسلسل المحاولات.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir, resolveOperationLockFilePath } from "@/lib/backup-config";

export interface OperationLockInfo {
  operationId: string;
  kind: string;
  pid: number;
  startedAt: string;
  username: string;
}

export class OperationLockBusyError extends Error {
  holder: OperationLockInfo | null;
  constructor(holder: OperationLockInfo | null) {
    super("عملية استرجاع أخرى قيد التنفيذ — لا يمكن تشغيل عمليتين معًا");
    this.holder = holder;
  }
}

const g = globalThis as unknown as { __recoveryOpMutex?: Promise<void> };

function readLockFile(): OperationLockInfo | null {
  try {
    const file = resolveOperationLockFilePath();
    if (!existsSync(file)) return null;
    const obj = JSON.parse(readFileSync(file, "utf8")) as OperationLockInfo;
    if (!obj || typeof obj.operationId !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createLockFileExclusive(info: OperationLockInfo): boolean {
  try {
    ensurePrivateDir(path.dirname(resolveOperationLockFilePath()));
    const fd = openSync(resolveOperationLockFilePath(), "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(info, null, 2), 0, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false; // EEXIST — القفل محتجز
  }
}

export interface HeldLock {
  info: OperationLockInfo;
  /** معلومات قفل ستال سبق استبداله (صاحبه مات) — للتوثيق، null غالبًا. */
  stoleFrom: OperationLockInfo | null;
  release: () => void;
}

/**
 * اكتساب قفل الاسترجاع — يرمي OperationLockBusyError (409) إذا كان القفل
 * حيًا، ويستبدل قفلًا ستالًا (صاحبه مات crash) مع إعادة معلوماته.
 */
export async function acquireOperationLock(args: {
  kind: string;
  username: string;
}): Promise<HeldLock> {
  // تسلسل المحاولات داخل العملية الواحدة
  while (g.__recoveryOpMutex) {
    await g.__recoveryOpMutex.catch(() => undefined);
  }
  let releaseMutex!: () => void;
  g.__recoveryOpMutex = new Promise<void>((r) => (releaseMutex = r));
  try {
    let stoleFrom: OperationLockInfo | null = null;
    for (;;) {
      const existing = readLockFile();
      if (existing) {
        if (existing.pid === process.pid || pidAlive(existing.pid)) {
          throw new OperationLockBusyError(existing);
        }
        // قفل ستال — صاحبه مات (crash): يُستبدل مع توثيق المالك السابق
        rmSync(resolveOperationLockFilePath(), { force: true });
        stoleFrom = existing;
      }
      const info: OperationLockInfo = {
        operationId: `op-lock-${Date.now()}-${randomUUID().slice(0, 8)}`,
        kind: args.kind,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        username: args.username,
      };
      if (createLockFileExclusive(info)) {
        return {
          info,
          stoleFrom,
          release: () => {
            try {
              const current = readLockFile();
              if (current && current.operationId === info.operationId) {
                rmSync(resolveOperationLockFilePath(), { force: true });
              }
            } catch {
              /* ignore */
            }
          },
        };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    releaseMutex();
    g.__recoveryOpMutex = undefined;
  }
}

/** معلومات القفل الحالي (تشخيص) — null إن كان حرًا. */
export function currentOperationLock(): OperationLockInfo | null {
  return readLockFile();
}
