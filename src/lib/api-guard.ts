// Phase 4B.1 — لفّ حارس الصيانة حول معالجات HTTP (قراءة/كتابة).
//
// الغرض المعماري (نص المستخدم): «لا أريد إضافة guard يدويًا بطريقة يسهل
// نسيانها مستقبلًا دون اختبار» — helper مركزي واحد + اختبار آلي يجرد كل
// المسارات الكتابية ويثبت حمايتها (scripts/phase4b1-write-guard-scan.ts).
//
// الاستخدام في أي route:
//   export async function POST(req: NextRequest) {
//     return guardWrite("/api/x", async () => { ...الجسم الأصلي... });
//   }
//
// الحارس يعمل قبل أي شيء آخر (قبل المصادقة): أثناء الصيانة يُرد 503 فورًا
// بلا أي كشف إضافي، وفي NORMAL يمر الطلب لمساره الطبيعي حرفيًا.

import { NextResponse } from "next/server";
import {
  acquireReadLease,
  acquireWriteLease,
  MaintenanceError,
  maintenanceErrorResponse,
  type SystemWriteLease,
} from "@/lib/maintenance";

function blockedResponse(error: unknown): Response | null {
  if (error instanceof MaintenanceError) {
    const mapped = maintenanceErrorResponse(error);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
  }
  return null;
}

/** حجب أثناء أي حالة صيانة + تسجيل الكتابة في عدّاد التصريف حتى نهاية الطلب. */
export async function guardWrite(route: string, handler: () => Promise<Response>): Promise<Response> {
  let lease: SystemWriteLease;
  try {
    lease = acquireWriteLease(route);
  } catch (error) {
    const blocked = blockedResponse(error);
    if (blocked) return blocked;
    throw error;
  }
  try {
    return await handler();
  } finally {
    lease.release();
  }
}

/** حجب القراءة أثناء الحجب الكامل فقط (SWAPPING/VERIFYING/ROLLING_BACK/RECOVERY_REQUIRED). */
export async function guardRead(route: string, handler: () => Promise<Response>): Promise<Response> {
  let lease: SystemWriteLease;
  try {
    lease = acquireReadLease(route);
  } catch (error) {
    const blocked = blockedResponse(error);
    if (blocked) return blocked;
    throw error;
  }
  try {
    return await handler();
  } finally {
    lease.release();
  }
}
