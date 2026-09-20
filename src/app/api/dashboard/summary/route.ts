import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import {
  buildDashboardVisibility,
  parseScopeParams,
  scopeToWhere,
  DashboardParamError,
} from "@/lib/dashboard-server";
import { businessToday, businessTzOffsetMinutes } from "@/lib/business-time";
import {
  BUSINESS_STAGE,
  KPI_CARDS,
  buildOverdueWhere,
  stageToWhere,
  type BusinessStage,
} from "@/lib/reconciliation";
import { Prisma } from "@prisma/client";
import { guardRead } from "@/lib/api-guard";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

/**
 * GET /api/dashboard/summary — بطاقات KPI (قراءة فقط — قرار D-8: تتجاوب مع
 * فلاتر النطاق فقط: المجموعة والفترة، لا مع فلاتر الجدول كاملة).
 *
 * كل الأعداد تُحسب من نفس شرط الرؤية (buildDashboardVisibility) ونفس دوال
 * الاشتقاق النقية (stageToWhere/buildOverdueWhere) المستخدمة في الجدول —
 * فلا يمكن أن يظهر رقم بطاقة لا يطابق نتيجة الفلترة عليها إطلاقًا.
 *
 * الاستجابة:
 * { success, data: { counts: { total, newDraft, submitted, underReview, pendingApproval,
 *   returned, reopenedAwaiting, approved, overdue, everReopened },
 *   scope: { groupIds, periods }, today, tzOffsetMinutes, computedAt } }
 */
export async function GET(req: NextRequest) {
  return guardRead("/api/dashboard/summary", async () => {
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

      const today = businessToday();
      const baseWhere: Prisma.ReportWhereInput = {
        AND: [buildDashboardVisibility(user), scopeToWhere(scope)],
      };

      const countWith = (extra?: Prisma.ReportWhereInput) =>
        db.report.count({ where: extra ? ({ AND: [baseWhere, extra] } as Prisma.ReportWhereInput) : baseWhere });

      const stageKeys: BusinessStage[] = [
        BUSINESS_STAGE.NEW_DRAFT,
        BUSINESS_STAGE.SUBMITTED,
        BUSINESS_STAGE.UNDER_REVIEW,
        BUSINESS_STAGE.RETURNED,
        BUSINESS_STAGE.PENDING_APPROVAL,
        BUSINESS_STAGE.REOPENED,
        BUSINESS_STAGE.APPROVED,
      ];

      const [total, ...rest] = await Promise.all([
        countWith(),
        ...stageKeys.map((s) => countWith(stageToWhere(s) as Prisma.ReportWhereInput)),
        countWith(buildOverdueWhere("true", today) as Prisma.ReportWhereInput),
        countWith({ cycle: { gt: 1 } }),
      ]);

      const counts = {
        total,
        newDraft: rest[0],
        submitted: rest[1],
        underReview: rest[2],
        returned: rest[3],
        pendingApproval: rest[4],
        reopenedAwaiting: rest[5],
        approved: rest[6],
        overdue: rest[7],
        everReopened: rest[8],
      };

      return NextResponse.json({
        success: true,
        data: {
          counts,
          scope: { groupIds: scope.groupId ?? [], periods: scope.period ?? [] },
          today,
          tzOffsetMinutes: businessTzOffsetMinutes(),
          computedAt: new Date().toISOString(),
          cards: KPI_CARDS.map((c) => ({ key: c.key, label: c.label, kind: c.kind })), // عقد العرض — الثابت الخادمي
        },
      });
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في حساب ملخص اللوحة: " + msg : msg },
        { status }
      );
    }
  });
}

// قراءة فقط — لا كتابة من اللوحة إطلاقًا
export function POST() { return NextResponse.json({ error: "غير مسموح" }, { status: 405 }); }
export function PUT() { return NextResponse.json({ error: "غير مسموح" }, { status: 405 }); }
export function PATCH() { return NextResponse.json({ error: "غير مسموح" }, { status: 405 }); }
export function DELETE() { return NextResponse.json({ error: "غير مسموح" }, { status: 405 }); }
