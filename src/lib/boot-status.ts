// Phase 5A — حالة الإقلاع الموحدة (Boot Status) — خادم فقط.
//
// جسر بين instrumentation (يكتب) و /api/health (يقرأ) عبر globalThis —
// نفس نمط سجل حارس الصيانة في maintenance.ts (عملية خادم واحدة).
//
// العقد:
//   • ما يُحدد عند الإقلاع: صلاحية التهيئة + سلامة القاعدة/المخطط + epoch.
//   • ما يُقرأ حيًا عند كل /api/health: حالة الصيانة (قد تتغير بعد الإقلاع —
//     RECOVERY_REQUIRED لاحقًا أو تطبيع يدوي).
//   • لا قيم سرية ولا مسارات قرص هنا إطلاقًا — رموز أسباب قصيرة فقط.

import type { MaintenanceState } from "@/lib/maintenance";

export type BootHealthMode = "normal" | "maintenance" | "recovery_required" | "unhealthy";

export interface BootCheckDetails {
  /** نتيجة validateProductionConfig عند الإقلاع (production) — dev: "skipped". */
  config: "ok" | "fail" | "skipped";
  /** ملف القاعدة موجود بترويسة SQLite صحيحة. */
  dbFile: "ok" | "fail" | "skipped";
  /** PRAGMA integrity_check عند الإقلاع. */
  integrity: "ok" | "fail" | "skipped";
  /** canonical schema fingerprint مقابل الثابت المثبت. */
  schema: "ok" | "fail" | "skipped";
  /** Session Epoch قابل للقراءة بعد التهيئة. */
  epoch: "ok" | "fail";
  /** حالة الصيانة المرصودة لحظة الإقلاع (قبل أي انتقال startup). */
  maintenanceStateAtBoot: MaintenanceState | "unknown";
  /** false = production preflight لم يكتمل (يُعامل unhealthy). */
  preflightCompleted: boolean;
}

export interface BootStatus {
  mode: BootHealthMode;
  checkedAt: string;
  details: BootCheckDetails;
  /** رمز السبب غير الحساس لعدم الصحة (unhealthy فقط). */
  unhealthyReason?: "boot_config" | "database" | "schema" | "epoch" | "preflight_incomplete";
}

const g = globalThis as unknown as { __ifrsBootStatus?: BootStatus };

export function setBootStatus(status: BootStatus): void {
  g.__ifrsBootStatus = status;
}

export function getBootStatus(): BootStatus | null {
  return g.__ifrsBootStatus ?? null;
}
