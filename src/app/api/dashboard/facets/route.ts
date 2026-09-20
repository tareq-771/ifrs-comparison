import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import {
  buildDashboardVisibility,
  parseScopeParams,
  scopeToWhere,
  DashboardParamError,
} from "@/lib/dashboard-server";
import { Prisma } from "@prisma/client";
import { guardRead } from "@/lib/api-guard";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

/**
 * GET /api/dashboard/facets — خيارات الفلاتر ضمن الرؤية (قراءة فقط).
 * - periods: DISTINCT periodEnd تنازليًا (الواجهة تضيف خيار «بدون فترة» دائمًا)
 * - groups: المجموعات الظاهرة ضمن التقارير المرئية فقط
 * - users: المعدون/المراجعون/المعتمدون الظاهرون في التقارير المرئية فقط —
 *   منع التسريب: لا يظهر اسم مستخدم من تقارير لا يراها صاحب الطلب إطلاقًا.
 * Query: نفس فلاتر النطاق (groupId, period) كي تتسق الخيارات مع النطاق المختار.
 */
export async function GET(req: NextRequest) {
  return guardRead("/api/dashboard/facets", async () => {
    try {
      const user = await requireAuth();
      const { searchParams } = new URL(req.url);

      let scope;
      try {
        scope = parseScopeParams(searchParams);
      } catch (e) {
        if (e instanceof DashboardParamError) {
          return NextResponse.json({ error: "باراميترات غير صالحة", code: e.code, detail: e.message }, { status: 400 });
        }
        throw e;
      }

      const where: Prisma.ReportWhereInput = {
        AND: [buildDashboardVisibility(user), scopeToWhere(scope)],
      };

      const [periodRows, prepRows, revRows, apprRows, groupRows] = await Promise.all([
        db.report.findMany({
          where,
          distinct: ["periodEnd"],
          select: { periodEnd: true },
          orderBy: { periodEnd: "desc" },
        }),
        db.report.findMany({
          where: { AND: [where, { preparedById: { not: null } }] } as Prisma.ReportWhereInput,
          distinct: ["preparedById"],
          select: { preparedById: true, preparedByName: true },
          orderBy: { preparedByName: "asc" },
        }),
        db.report.findMany({
          where: { AND: [where, { reviewedById: { not: null } }] } as Prisma.ReportWhereInput,
          distinct: ["reviewedById"],
          select: { reviewedById: true, reviewedByName: true },
          orderBy: { reviewedByName: "asc" },
        }),
        db.report.findMany({
          where: { AND: [where, { approvedById: { not: null } }] } as Prisma.ReportWhereInput,
          distinct: ["approvedById"],
          select: { approvedById: true, approvedByName: true },
          orderBy: { approvedByName: "asc" },
        }),
        db.report.findMany({
          where: { AND: [where, { groupId: { not: null } }] } as Prisma.ReportWhereInput,
          distinct: ["groupId"],
          select: { groupId: true },
        }),
      ]);

      // أسماء المجموعات الظاهرة فقط
      const groupIds = groupRows.map((g) => g.groupId).filter((g): g is string => !!g);
      const groups = groupIds.length
        ? await db.group.findMany({
            where: { id: { in: groupIds } },
            select: { id: true, name: true },
            orderBy: { name: "asc" },
          })
        : [];

      return NextResponse.json({
        success: true,
        data: {
          periods: periodRows.map((p) => p.periodEnd).filter((p): p is string => !!p),
          groups,
          users: {
            preparers: prepRows.map((u) => ({ id: u.preparedById!, name: u.preparedByName })),
            reviewers: revRows.map((u) => ({ id: u.reviewedById!, name: u.reviewedByName })),
            approvers: apprRows.map((u) => ({ id: u.approvedById!, name: u.approvedByName })),
          },
        },
      });
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في جلب خيارات الفلاتر: " + msg : msg },
        { status }
      );
    }
  });
}

// قراءة فقط
export function POST() { return NextResponse.json({ error: "غير مسموح" }, { status: 405 }); }
export function PUT() { return NextResponse.json({ error: "غير مسموح" }, { status: 405 }); }
export function PATCH() { return NextResponse.json({ error: "غير مسموح" }, { status: 405 }); }
export function DELETE() { return NextResponse.json({ error: "غير مسموح" }, { status: 405 }); }
