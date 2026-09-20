import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, getClientIp, reportBlobSizes } from "@/lib/audit";
import { normalizeDueDateStrict, normalizePeriodEndStrict, WORKFLOW_STATUS } from "@/lib/workflow";
import { canAssignWorkflow } from "@/lib/permissions";
import { buildRoleSnapshot, buildWorkflowInfo, writeWorkflowHistory } from "@/lib/workflow-server";
import { WORKFLOW_HISTORY_ACTION } from "@/lib/workflow";
import { guardWrite, guardRead } from "@/lib/api-guard";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

// GET /api/reports — list reports for current user (filterable by groupId)
// Query params:
//   groupId=<id>   → only reports in that group (must belong to current user OR be linked)
//   groupId=null   → only ungrouped reports (owned by current user)
//   status=<code>  → optional workflow-status filter (DRAFT/SUBMITTED/...)
//
// Visibility rules (المرحلة 3):
//   - Reports owned by the current user (always visible)
//   - Reports whose groupId is in the user's `permissions.groupIds` (linked groups)
//   - Reports where the user is a workflow participant (prepared/reviewed/approved)
//   - Admin sees all reports (governance)
export async function GET(req: NextRequest) {
  return guardRead("/api/reports", async () => {
    try {
      const user = await requireAuth();
      const { searchParams } = new URL(req.url);
      const groupIdParam = searchParams.get("groupId");
      const statusParam = searchParams.get("status");

      const linkedGroupIds = Array.isArray(user.permissions.groupIds)
        ? user.permissions.groupIds
        : [];
      const isAdmin = user.role === "admin";

      // شرط الرؤية المشترك: مالك / مجموعة مرتبطة / مشارك أدوار / (المدير: الكل)
      const baseVisibility: Prisma.ReportWhereInput = isAdmin
        ? {}
        : {
            OR: [
              { userId: user.id },
              ...(linkedGroupIds.length > 0
                ? [{ groupId: { in: linkedGroupIds } } as Prisma.ReportWhereInput]
                : []),
              { preparedById: user.id },
              { reviewedById: user.id },
              { approvedById: user.id },
            ],
          };

      let where: Prisma.ReportWhereInput;

      if (groupIdParam === "null") {
        // Ungrouped reports — only owned by the user (linked groups can't have null groupId)
        where = { AND: [baseVisibility, { userId: user.id, groupId: null }] };
      } else if (groupIdParam) {
        // Verify the group is either owned by the current user OR linked via groupIds
        // (or the user is a workflow participant in one of its reports — same group access)
        const group = await db.group.findUnique({
          where: { id: groupIdParam },
          select: { id: true, userId: true },
        });
        if (
          !group ||
          (group.userId !== user.id &&
            !linkedGroupIds.includes(groupIdParam) &&
            !isAdmin)
        ) {
          return NextResponse.json(
            { error: "المجموعة غير موجودة" },
            { status: 404 }
          );
        }
        where = { AND: [baseVisibility, { groupId: groupIdParam }] };
      } else {
        where = baseVisibility;
      }

      if (statusParam) {
        where = { AND: [where, { status: statusParam }] };
      }

      const reports = await db.report.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          name: true,
          label1: true,
          label2: true,
          compareMode: true,
          numMonths: true,
          groupId: true,
          userId: true,
          version: true,
          status: true,
          cycle: true,
          periodEnd: true,
          preparedById: true,
          preparedByName: true,
          reviewedById: true,
          approvedById: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return NextResponse.json(reports);
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في جلب التقارير: " + msg : msg },
        { status }
      );
    }
  });
}

// POST /api/reports — create a new saved report
export async function POST(req: NextRequest) {
  return guardWrite("/api/reports", async () => {
    try {
      const user = await requireAuth();
      const body = await req.json();

      const linkedGroupIds = Array.isArray(user.permissions.groupIds)
        ? user.permissions.groupIds
        : [];

      // Optional groupId — must belong to current user OR be in the user's linked
      // groupIds (so a linked user can save reports into a shared group).
      let groupId: string | null = null;
      if (body.groupId !== undefined && body.groupId !== null && body.groupId !== "") {
        const gid = body.groupId.toString();
        const group = await db.group.findUnique({
          where: { id: gid },
          select: { id: true, userId: true },
        });
        if (!group || (group.userId !== user.id && !linkedGroupIds.includes(gid))) {
          return NextResponse.json(
            { error: "المجموعة غير موجودة" },
            { status: 404 }
          );
        }
        groupId = gid;
      }

      // periodEnd — date-only بلا timezone
      const pe = normalizePeriodEndStrict(body.periodEnd);
      if (pe.invalid) {
        return NextResponse.json(
          { error: "تاريخ نهاية الفترة المالية غير صحيح — الصيغة المطلوبة YYYY-MM-DD.", code: "PERIOD_END_INVALID" },
          { status: 400 }
        );
      }

      // المرحلة 3.5 (قرار D-1): dueDate حقل رقابي — يُضبط عند الإنشاء فقط لمن يملك
      // صلاحية الحوكمة (assignWorkflow)؛ المعدّ لا يضبطه لاحقًا لمجرد امتلاكه edit.
      let dueDate: string | null | undefined = undefined;
      if (body.dueDate !== undefined) {
        const dd = normalizeDueDateStrict(body.dueDate);
        if (dd.invalid) {
          return NextResponse.json(
            { error: "تاريخ استحقاق المطابقة غير صحيح — الصيغة المطلوبة YYYY-MM-DD.", code: "DUE_DATE_INVALID" },
            { status: 400 }
          );
        }
        // قيمة صريحة (تاريخ أو إفراغ) تتطلب الصلاحية — غياب الحقل تمامًا مسموح للجميع
        if (dd.value !== undefined && !canAssignWorkflow(user.permissions, user.role)) {
          return NextResponse.json(
            {
              error: "ضبط تاريخ الاستحقاق حقل رقابي — يتطلب صلاحية assignWorkflow لا تملكها.",
              code: "DUE_DATE_FORBIDDEN",
            },
            { status: 403 }
          );
        }
        dueDate = dd.value;
      }

      // إنشاء التقرير + إسناد المنشئ كمعدّ تلقائيًا + صف CREATED في سجل الدورات
      // + تسجيل الأثر الرقابي — كل ذلك في نفس المعاملة (ذرية كاملة)
      const report = await db.$transaction(async (tx) => {
        const created = await tx.report.create({
          data: {
            name: body.name || "تقرير بدون اسم",
            label1: body.label1 || "",
            label2: body.label2 || "",
            compareMode: body.compareMode || "period",
            numMonths: body.numMonths || 12,
            isSettings: JSON.stringify(body.isSettings || {}),
            bsSettings: JSON.stringify(body.bsSettings || {}),
            isFile1Data: JSON.stringify(body.isFile1Data || []),
            isFile2Data: JSON.stringify(body.isFile2Data || []),
            isFile1Headers: JSON.stringify(body.isFile1Headers || []),
            isFile2Headers: JSON.stringify(body.isFile2Headers || []),
            isFile1Cols: JSON.stringify(body.isFile1Cols || {}),
            isFile2Cols: JSON.stringify(body.isFile2Cols || {}),
            bsFileData: JSON.stringify(body.bsFile1Data ?? body.bsFileData ?? []),
            bsFileHeaders: JSON.stringify(body.bsFile1Headers ?? body.bsFileHeaders ?? []),
            bsFileCols: JSON.stringify(body.bsFile1Cols ?? body.bsFileCols ?? {}),
            bsFile2Data: JSON.stringify(body.bsFile2Data || []),
            bsFile2Headers: JSON.stringify(body.bsFile2Headers || []),
            bsFile2Cols: JSON.stringify(body.bsFile2Cols || {}),
            groupId,
            userId: user.id,
            status: WORKFLOW_STATUS.DRAFT,
            cycle: 1,
            periodEnd: pe.value ?? null,
            ...(dueDate !== undefined ? { dueDate } : {}),
            // المنشئ يصبح المعد تلقائيًا — preparedAt يُثبت عند أول SUBMIT (اكتمال الإعداد)
            preparedById: user.id,
            preparedByName: user.name || user.username,
          },
        });
        await writeWorkflowHistory(tx, {
          reportId: created.id,
          cycle: 1,
          action: WORKFLOW_HISTORY_ACTION.CREATED,
          toStatus: WORKFLOW_STATUS.DRAFT,
          actorId: user.id,
          actorUsername: user.username || user.name,
          roleSnapshot: buildRoleSnapshot(created),
        });
        await writeAudit(tx, {
          user,
          action: AUDIT_ACTIONS.REPORT_CREATED,
          entityType: AUDIT_ENTITY_TYPES.Report,
          entityId: created.id,
          description: `إنشاء تقرير «${created.name}»`,
          after: {
            name: created.name,
            label1: created.label1,
            label2: created.label2,
            compareMode: created.compareMode,
            numMonths: created.numMonths,
            groupId: created.groupId,
            periodEnd: created.periodEnd,
            dueDate: created.dueDate,
            status: created.status,
            preparedBy: created.preparedByName,
          },
          metadata: { blobSizes: reportBlobSizes(created as unknown as Record<string, unknown>) },
          ip: getClientIp(req),
        });
        return created;
      });
      // أعِد التقرير + كائن workflow (مصدر أزرار الواجهة بعد الإنشاء مباشرة)
      const workflow = await buildWorkflowInfo(report, user);
      return NextResponse.json({ ...report, workflow }, { status: 201 });
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في حفظ التقرير: " + msg : msg },
        { status }
      );
    }
  });
}
