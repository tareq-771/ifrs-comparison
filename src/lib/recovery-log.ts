// Phase 4A — السجل التشغيلي الخارجي (Operational Recovery Log).
//
// قرار المستخدم حرفيًا:
//  - Append-only على مستوى التطبيق — لا يوجد endpoint update/delete له إطلاقًا
//    (لا توجد أصلاً دوال تعديل/حذف في هذا الملف — البنية نفسها تمنعه).
//  - كل سجل: eventId / timestamp / operationId / event / actor / backupId /
//    result / details — operationId يربط عملية واحدة من بدايتها لنهايتها.
//  - لا أسرار ولا password hashes ولا محتوى تقارير ولا مسارات قرص داخلية
//    (details تمر عبر Sanitizer المركزي نفسه المستخدم في AuditLog).
//  - الملف خارج قاعدة البيانات المستبدلة ⇒ أدلة الاستعادة تبقى بعد أي استعادة.
//
// الأحداث في 4A (نص المستخدم): BACKUP_STARTED / BACKUP_CREATED /
// BACKUP_VALIDATED / BACKUP_FAILED / DRILL_STARTED / DRILL_VERIFIED /
// DRILL_FAILED / UPLOAD_RECEIVED / UPLOAD_REJECTED

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { recoveryLogFilePath, resolveRecoveryLogDir, ensurePrivateDir } from "@/lib/backup-config";
import { sanitizeAuditValue } from "@/lib/audit";

export type RecoveryEvent =
  | "BACKUP_STARTED"
  | "BACKUP_CREATED"
  | "BACKUP_VALIDATED"
  | "BACKUP_FAILED"
  | "DRILL_STARTED"
  | "DRILL_VERIFIED"
  | "DRILL_FAILED"
  | "UPLOAD_RECEIVED"
  | "UPLOAD_REJECTED";

export const RECOVERY_EVENT_LABELS: Record<RecoveryEvent, string> = {
  BACKUP_STARTED: "بدء إنشاء نسخة",
  BACKUP_CREATED: "تم إنشاء نسخة",
  BACKUP_VALIDATED: "نجح التحقق",
  BACKUP_FAILED: "فشل نسخ/تحقق",
  DRILL_STARTED: "بدء Restore Drill",
  DRILL_VERIFIED: "نجح Drill — RESTORE_VERIFIED",
  DRILL_FAILED: "فشل Drill",
  UPLOAD_RECEIVED: "استلام ملف مرفوع",
  UPLOAD_REJECTED: "رفض ملف مرفوع",
};

export type RecoveryResult = "success" | "failure" | "aborted" | "info";

export interface RecoveryActor {
  id: string | null;
  username: string;
}

export interface RecoveryRecord {
  eventId: string;
  timestamp: string;
  operationId: string;
  event: RecoveryEvent;
  actor: RecoveryActor;
  backupId: string | null;
  result: RecoveryResult;
  details: Record<string, unknown>;
}

/** كتابة حدث واحد — إلحاق سطر JSON واحد. لا تعديل ولا حذف للأحداث القائمة أبدًا. */
export async function appendRecoveryEvent(input: {
  operationId: string;
  event: RecoveryEvent;
  actor: RecoveryActor;
  backupId?: string | null;
  result: RecoveryResult;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    ensurePrivateDir(resolveRecoveryLogDir());
    const record: RecoveryRecord = {
      eventId: `evt-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      operationId: input.operationId,
      event: input.event,
      actor: { id: input.actor.id ?? null, username: input.actor.username ?? "" },
      backupId: input.backupId ?? null,
      result: input.result,
      details: (sanitizeAuditValue(input.details ?? {}) ?? {}) as Record<string, unknown>,
    };
    // appendFile بالوضع a — أسطر JSON مستقلة؛ mode يُطبق عند إنشاء الملف
    await appendFile(recoveryLogFilePath(), JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch (error) {
    // السجل الخارجي مهم لكن يجب ألا يعطل العملية — يُسجل الفشل في مخرجات الخادم
    console.error("[recovery-log] فشل إلحاق حدث:", input.event, error);
  }
}

/**
 * 4A.1 — عدّاد قراءة فقط: كم عملية Drill بدأت سابقًا لنسخة معينة (طبقًا للأحداث).
 * الغرض: إعطاء كل تشغيل Drill «رقم تشغيل» (drillRun.sequence) في details كي لا
 * يبدو تشغيلان مستقلان لنفس backupId كحدثين مكررين للعملية نفسها —
 * operationId يبقى هو المميز الأساسي لكل تشغيل، وbackupId يتكرر طبيعيًا.
 * قراءة حصرًا — لا تلمس الملف كتابةً (append-only بنيويًا).
 */
export async function countRecoveryEvents(
  event: RecoveryEvent,
  backupId?: string
): Promise<number> {
  try {
    const file = recoveryLogFilePath();
    await stat(file);
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n");
    let count = 0;
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.event !== event) continue;
        if (backupId !== undefined && obj?.backupId !== backupId) continue;
        count++;
      } catch {
        /* سطر تالف — يُتخطى */
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/** قراءة آخر N حدثًا (العرض فقط — لا تعديل). الأسطر التالفة تُتخطى وتُعد. */
export async function readRecoveryEvents(limit = 50): Promise<{
  events: RecoveryRecord[];
  corruptLines: number;
  totalBytes: number;
  exists: boolean;
}> {
  const file = recoveryLogFilePath();
  try {
    await stat(file);
  } catch {
    return { events: [], corruptLines: 0, totalBytes: 0, exists: false };
  }
  const raw = await readFile(file, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const parsed: RecoveryRecord[] = [];
  let corrupt = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (typeof obj?.eventId === "string" && typeof obj?.event === "string") {
        parsed.push(obj as RecoveryRecord);
      } else {
        corrupt++;
      }
    } catch {
      corrupt++;
    }
    if (parsed.length >= limit) break;
  }
  const { size } = await stat(file);
  return { events: parsed, corruptLines: corrupt, totalBytes: size, exists: true };
}
