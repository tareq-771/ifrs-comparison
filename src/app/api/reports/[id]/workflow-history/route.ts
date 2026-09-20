import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import { canViewReportRow } from "@/lib/workflow-server";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

/**
 * GET /api/reports/[id]/workflow-history — سجل دورات الاعتماد الكامل (append-only).
 * القراءة: المشاركون (معد/مراجع/معتمد) + المالك + المجموعة المرتبطة + المدير.
 * لا توجد أي API تعديل/حذف لهذا السجل إطلاقًا (append-only).
 * السجل مرتّب زمنيًا تصاعديًا ويمكن إعادة بناء أي دورة سابقة منه بالكامل
 * (من/إلى/الفاعل/الوقت/السبب + snapshot الأدوار).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireAuth();
    const { id } = await params;
    const report = await db.report.findUnique({
      where: { id },
      select: {
        id: true, userId: true, groupId: true,
        preparedById: true, reviewedById: true, approvedById: true,
      },
    });
    if (!report || !canViewReportRow(report, user)) {
      return NextResponse.json({ error: "التقرير غير موجود" }, { status: 404 });
    }
    const rows = await db.workflowHistory.findMany({
      where: { reportId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 500, // سقف أمان — سجل تقرير واحد صغير عمليًا
    });
    return NextResponse.json(
      rows.map((r) => ({
        id: r.id,
        reportId: r.reportId,
        cycle: r.cycle,
        action: r.action,
        fromStatus: r.fromStatus,
        toStatus: r.toStatus,
        actorId: r.actorId,
        actorUsername: r.actorUsername,
        reason: r.reason,
        comment: r.comment,
        roleSnapshot: r.roleSnapshot,
        createdAt: r.createdAt.toISOString(),
      }))
    );
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل جلب سجل الدورات: " + msg : msg },
      { status }
    );
  }
}
