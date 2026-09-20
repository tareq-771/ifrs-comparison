// Phase 4B.1 — معاينة الاستعادة: بنود التأكيد القوية قبل التنفيذ
// (القسم 14 من وثيقة التصميم): بنسخة المرشحة وجنبًا إلى جنب عدّ الحالة
// الحالية التي ستفقد + اشتراط التأكيد الثاني server-side.

import { NextResponse } from "next/server";
import { requireRestoreDatabase } from "@/lib/session";
import { buildRestorePreview, RestoreError } from "@/lib/restore-server";
import { readMaintenanceStateFile } from "@/lib/maintenance";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireRestoreDatabase();
    // المعاينة تتطلب نظامًا طبيعيًا (NORMAL) — أثناء الصيانة تُرد الحالة
    const sf = readMaintenanceStateFile();
    if (sf && sf.state !== "NORMAL") {
      return NextResponse.json(
        {
          error: "النظام ليس في الحالة الطبيعية — لا معاينة أثناء الصيانة",
          code: "MAINTENANCE_MODE",
          maintenance: { state: sf.state, operationId: sf.operationId },
        },
        { status: 503 }
      );
    }
    const { id } = await ctx.params;
    if (!/^(bk|up)-[A-Za-z0-9_-]+$/.test(id)) {
      return NextResponse.json({ error: "معرف غير صالح" }, { status: 400 });
    }
    const preview = await buildRestorePreview(id);
    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof RestoreError) {
      return NextResponse.json(
        { error: error.message, code: error.code, ...(error.extra ?? {}) },
        { status: error.httpStatus }
      );
    }
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل بناء المعاينة: " + msg : msg },
      { status }
    );
  }
}
