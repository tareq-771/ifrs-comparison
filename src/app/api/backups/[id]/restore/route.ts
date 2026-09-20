// Phase 4B.1 — تنفيذ الاستعادة الفعلية (استبدال قاعدة التشغيل الذري).
//
// البوابات (بترتيب صارم):
//   1. requireRestoreDatabase — صلاحية منفصلة تمامًا (المدير بالدور أو مفتاح صريح).
//   2. بوابة المحرك RESTORE_ENGINE_ENABLED — معطلة في بيئة التشغيل خلال 4B.1
//      (التفعيل الفعلي على الإنتاج = 4B.2 بموافقة صريحة).
//   3. التأكيدات server-side: كتابة RESTORE حرفيًا + تأكيد ثانٍ (معرف النسخة
//      كاملًا) إذا كانت أقدم من الحالة الحالية أو ستقلل عدد التقارير —
//      الخادم يعيد اشتقاط شرط التأكيد الثاني بنفسه ولا يثق بادعاء العميل.
//   4. القفل الخارجي — عملية ثانية ⇒ 409 RECOVERY_OPERATION_IN_PROGRESS.
//
// هذا المسار معفى من حراس الصيانة عمدًا: هو من يدير الصيانة نفسها
// (أدوات إدارة الصيانة لا تحجب نفسها — القسم 10.1 من وثيقة التصميم).

import { NextRequest, NextResponse } from "next/server";
import { requireRestoreDatabase } from "@/lib/session";
import { getClientIp } from "@/lib/audit";
import { executeRestore, RestoreError } from "@/lib/restore-server";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireRestoreDatabase();
    void getClientIp(req);
    const { id } = await ctx.params;
    if (!/^(bk|up)-[A-Za-z0-9_-]+$/.test(id)) {
      return NextResponse.json({ error: "معرف غير صالح" }, { status: 400 });
    }
    const body = (await req.json().catch(() => ({}))) as {
      confirmationText?: string;
      downgradeConfirmation?: string | null;
    };
    const outcome = await executeRestore({
      backupId: id,
      actor: { id: user.id || null, username: user.username },
      confirmationText: typeof body.confirmationText === "string" ? body.confirmationText : "",
      downgradeConfirmation:
        typeof body.downgradeConfirmation === "string" ? body.downgradeConfirmation : null,
    });
    return NextResponse.json(outcome, { status: outcome.ok ? 200 : 409 });
  } catch (error) {
    if (error instanceof RestoreError) {
      return NextResponse.json(
        { error: error.message, code: error.code, ...(error.extra ?? {}) },
        { status: error.httpStatus }
      );
    }
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل تنفيذ الاستعادة: " + msg : msg },
      { status }
    );
  }
}
