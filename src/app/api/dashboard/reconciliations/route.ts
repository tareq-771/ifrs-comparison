import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import {
  buildListWhere,
  DashboardParamError,
  parseListParams,
  type ListFilters,
} from "@/lib/dashboard-server";
import { businessToday, businessTzOffsetMinutes } from "@/lib/business-time";
import {
  BUSINESS_STAGE_LABELS,
  computeOverdue,
  deriveOwner,
  deriveStage,
  type BusinessStage,
} from "@/lib/reconciliation";
import { WORKFLOW_STATUS_LABELS, computeMyActions } from "@/lib/workflow";
import type { WorkflowMyActions } from "@/lib/workflow";
import { guardRead } from "@/lib/api-guard";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

/** رموز LIKE الخاصة تحتاج مسارًا حرفيًا مع ESCAPE — Prisma contains لا يهربها. */
function hasLikeWildcards(q: string): boolean {
  return /[%_\\]/.test(q);
}

function iso(v: Date | null | undefined): string | null {
  return v ? v.toISOString() : null;
}

type ReportRowFull = Prisma.ReportGetPayload<{
  select: {
    id: true; name: true; groupId: true; userId: true; periodEnd: true; dueDate: true;
    status: true; cycle: true; version: true; updatedAt: true;
    preparedById: true; preparedByName: true; preparedAt: true;
    reviewedById: true; reviewedByName: true; reviewStartedAt: true; reviewedAt: true;
    approvedById: true; approvedByName: true; approvedAt: true;
    returnedAt: true; reopenedAt: true;
    group: { select: { name: true } };
  };
}>;

function toRow(
  r: ReportRowFull,
  user: Awaited<ReturnType<typeof requireAuth>>,
  today: string
) {
  const stage: BusinessStage = deriveStage(r);
  const { overdue, daysOverdue } = computeOverdue(r, today);
  const owner = deriveOwner(r);

  // myActions من computeMyActions الخادمية حصرًا — نفس مصدر لوحة Workflow داخل التقرير
  const linked = Array.isArray(user.permissions.groupIds) ? user.permissions.groupIds : [];
  const myActions: WorkflowMyActions = computeMyActions(
    {
      status: r.status,
      cycle: r.cycle,
      preparedById: r.preparedById,
      reviewedById: r.reviewedById,
      approvedById: r.approvedById,
      reviewStartedAt: r.reviewStartedAt,
      reviewedAt: r.reviewedAt,
      preparedByName: r.preparedByName,
      reviewedByName: r.reviewedByName,
      approvedByName: r.approvedByName,
      returnedAt: r.returnedAt,
      reopenedAt: r.reopenedAt,
      periodEnd: r.periodEnd,
      dueDate: r.dueDate,
    },
    {
      id: user.id,
      role: user.role,
      permissions: {
        edit: user.permissions.edit,
        view: user.permissions.view,
        assignWorkflow: user.role === "admin" || user.permissions.assignWorkflow === true,
        reopenReport: user.role === "admin" || user.permissions.reopenReport === true,
        groupIds: linked,
      },
      isOwner: r.userId === user.id,
      isLinkedToReportGroup: r.groupId !== null && linked.includes(r.groupId),
    }
  );

  return {
    id: r.id,
    name: r.name,
    groupId: r.groupId,
    groupName: r.group?.name ?? null,
    periodEnd: r.periodEnd,
    status: r.status,
    statusLabel: WORKFLOW_STATUS_LABELS[r.status as keyof typeof WORKFLOW_STATUS_LABELS] ?? r.status,
    stage,
    stageLabel: BUSINESS_STAGE_LABELS[stage],
    cycle: r.cycle,
    version: r.version,
    preparedBy: r.preparedById ? { id: r.preparedById, name: r.preparedByName } : null,
    reviewedBy: r.reviewedById ? { id: r.reviewedById, name: r.reviewedByName } : null,
    approvedBy: r.approvedById ? { id: r.approvedById, name: r.approvedByName } : null,
    currentOwner: owner,
    dueDate: r.dueDate,
    overdue,
    daysOverdue,
    updatedAt: iso(r.updatedAt),
    submittedAt: iso(r.preparedAt), // اكتمال الإعداد = آخر إرسال (تعديل رقم 1 من المرحلة 3)
    reviewStartedAt: iso(r.reviewStartedAt),
    reviewedAt: iso(r.reviewedAt), // وقت توقيع المراجع (إتمام المراجعة)
    approvedAt: iso(r.approvedAt),
    myActions,
  };
}

/**
 * GET /api/dashboard/reconciliations — جدول المتابعة (قراءة فقط).
 * رؤية ⇒ فلاتر ⇒ ترتيب وترقيم — كلها خادمية. count وfindMany بنفس WHERE بالتوازي.
 * الباراميترات: page, pageSize(20|50|100), sort(قائمة بيضاء), dir, q, groupId, period,
 * status, stage, preparedById, reviewedById, approvedById, ownerRole, ownerMe, overdue, cycle.
 * خارج العقد ⇒ 400 DASHBOARD_INVALID_PARAM بلا أي استعلام مكلف.
 */
export async function GET(req: NextRequest) {
  return guardRead("/api/dashboard/reconciliations", async () => {
    try {
      const user = await requireAuth();
      const { searchParams } = new URL(req.url);

      let f: ListFilters;
      try {
        f = parseListParams(searchParams);
      } catch (e) {
        if (e instanceof DashboardParamError) {
          return NextResponse.json({ error: "باراميترات غير صالحة", code: e.code, detail: e.message }, { status: 400 });
        }
        throw e;
      }

      const today = businessToday();

      // بحث بالاسم: رموز LIKE الخاصة تُحل حرفيًا عبر SQL مع ESCAPE (بدل wildcards)
      let qIds: string[] | undefined;
      if (f.q && hasLikeWildcards(f.q)) {
        const escaped = f.q.replace(/[\\%_]/g, (ch) => "\\" + ch);
        const rows = await db.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM Report WHERE name LIKE ? ESCAPE '\\'`,
          `%${escaped}%`
        );
        qIds = rows.map((r) => r.id);
      }

      const where = buildListWhere(user, f, today, qIds);
      const orderBy: Prisma.ReportOrderByWithRelationInput = { [f.sort]: f.dir };

      const [total, rowsRaw] = await Promise.all([
        db.report.count({ where }),
        db.report.findMany({
          where,
          orderBy,
          skip: (f.page - 1) * f.pageSize,
          take: f.pageSize,
          select: {
            id: true, name: true, groupId: true, userId: true, periodEnd: true, dueDate: true,
            status: true, cycle: true, version: true, updatedAt: true,
            preparedById: true, preparedByName: true, preparedAt: true,
            reviewedById: true, reviewedByName: true, reviewStartedAt: true, reviewedAt: true,
            approvedById: true, approvedByName: true, approvedAt: true,
            returnedAt: true, reopenedAt: true,
            group: { select: { name: true } },
          },
        }),
      ]);

      return NextResponse.json({
        success: true,
        data: {
          rows: rowsRaw.map((r) => toRow(r, user, today)),
          pagination: {
            page: f.page,
            pageSize: f.pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / f.pageSize)),
          },
          sort: f.sort,
          dir: f.dir,
          today,
          tzOffsetMinutes: businessTzOffsetMinutes(),
          stageLabels: BUSINESS_STAGE_LABELS,
        },
      });
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في جلب بيانات اللوحة: " + msg : msg },
        { status }
      );
    }
  });
}

// قراءة فقط — اللوحة لا تنشئ منطق workflow موازيًا ولا تكتب أي بيانات
export function POST() { return NextResponse.json({ error: "غير مسموح" }, { status: 405 }); }
export function PUT() { return NextResponse.json({ error: "غير مسموح" }, { status: 405 }); }
export function PATCH() { return NextResponse.json({ error: "غير مسموح" }, { status: 405 }); }
export function DELETE() { return NextResponse.json({ error: "غير مسموح" }, { status: 405 }); }
