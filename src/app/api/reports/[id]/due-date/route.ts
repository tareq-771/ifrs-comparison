import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, getClientIp } from "@/lib/audit";
import { canAssignWorkflow } from "@/lib/permissions";
import { buildWorkflowInfo, canViewReportRow } from "@/lib/workflow-server";
import {
  WORKFLOW_STATUS,
  WORKFLOW_STATUS_LABELS,
  normalizeDueDateStrict,
} from "@/lib/workflow";
import { guardWrite } from "@/lib/api-guard";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

/**
 * PATCH /api/reports/[id]/due-date — الحوكمة الرقابية لتاريخ الاستحقاق (المرحلة 3.5 — قرار D-1).
 *
 * العقد:
 *  - سماوية: المدير أو حائز assignWorkflow فقط (403 FORBIDDEN).
 *    المعدّ لا يغيّر dueDate لمجرد امتلاكه edit — الحقل رقابي لا بيانات عادية.
 *  - الحالات: كل الحالات عدا APPROVED (القفل يحكم الجميع — إعادة الفتح أولًا).
 *  - الجسم: { dueDate: "YYYY-MM-DD" | null, version إلزامية } — null = مسح الاستحقاق.
 *  - ذرية: UPDATE ... WHERE id=? AND version=? AND status=? (القفل التفاؤلي يحمي من
 *    السباق مع انتقالات Workflow) + version+1 — بلا أي تغيير آخر في بيانات المطابقة.
 *  - تدقيق: DUE_DATE_CHANGED في نفس المعاملة مع oldDueDate/newDueDate/cycle/changedBy
 *    (قرار D-1) — ولا صف في WorkflowHistory لأنه ليس انتقال Workflow (قرار D-1).
 *  - لا مسارات أخرى تُعدّل dueDate: PUT (تعديل المعدّ) يتجاهل الحقل عمدًا.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return guardWrite("/api/reports/[id]/due-date", async () => {
    try {
      const user = await requireAuth();
      const { id } = await params;

      const canGovern = canAssignWorkflow(user.permissions, user.role);
      if (!canGovern) {
        return NextResponse.json(
          { error: "تغيير تاريخ الاستحقاق حقل رقابي — يتطلب صلاحية assignWorkflow لا تملكها.", code: "FORBIDDEN" },
          { status: 403 }
        );
      }

      const existing = await db.report.findUnique({ where: { id } });
      if (!existing || !canViewReportRow(existing, user)) {
        return NextResponse.json({ error: "التقرير غير موجود" }, { status: 404 });
      }

      if (existing.status === WORKFLOW_STATUS.APPROVED) {
        return NextResponse.json(
          {
            error: `التقرير معتمد — لا تغيير للاستحقاق قبل إعادة الفتح (الحالة الحالية: «${WORKFLOW_STATUS_LABELS.APPROVED}»).`,
            code: "WORKFLOW_LOCKED",
            currentStatus: existing.status,
            currentVersion: existing.version,
          },
          { status: 403 }
        );
      }

      const body = await req.json().catch(() => ({}));
      const clientVersion = body.version;
      if (clientVersion === undefined || clientVersion === null || clientVersion === "") {
        return NextResponse.json(
          {
            error: "تغيير الاستحقاق يتطلب إرسال نسخة التقرير (version). أعد تحميل التقرير ثم حاول مجددًا.",
            code: "VERSION_REQUIRED",
            currentVersion: existing.version,
            currentStatus: existing.status,
          },
          { status: 400 }
        );
      }
      const versionNum = Number(clientVersion);
      if (!Number.isInteger(versionNum) || versionNum < 1) {
        return NextResponse.json(
          { error: "قيمة النسخة (version) غير صحيحة.", code: "VERSION_INVALID", currentVersion: existing.version },
          { status: 400 }
        );
      }

      const dd = normalizeDueDateStrict(body.dueDate);
      if (dd.invalid) {
        return NextResponse.json(
          { error: "تاريخ استحقاق المطابقة غير صحيح — الصيغة المطلوبة YYYY-MM-DD.", code: "DUE_DATE_INVALID" },
          { status: 400 }
        );
      }
      if (dd.value === undefined) {
        return NextResponse.json(
          { error: "لم تُرسل قيمة dueDate (تاريخ YYYY-MM-DD أو null للمسح).", code: "DUE_DATE_REQUIRED" },
          { status: 400 }
        );
      }

      const newDueDate = dd.value;
      const oldDueDate = existing.dueDate;
      if (newDueDate === oldDueDate) {
        return NextResponse.json(
          { error: "لا يوجد تغيير فعلي في تاريخ الاستحقاق.", code: "NO_CHANGES", currentVersion: existing.version },
          { status: 400 }
        );
      }

      const result = await db.$transaction(async (tx) => {
        const res = await tx.report.updateMany({
          where: { id, version: versionNum, status: existing.status },
          data: { dueDate: newDueDate, version: { increment: 1 } },
        });
        if (res.count === 0) return { ok: false as const };

        await writeAudit(tx, {
          user,
          action: AUDIT_ACTIONS.DUE_DATE_CHANGED,
          entityType: AUDIT_ENTITY_TYPES.Report,
          entityId: id,
          description: `تغيير تاريخ استحقاق التقرير «${existing.name}» من ${oldDueDate ?? "—"} إلى ${newDueDate ?? "—"} (v${versionNum} → v${versionNum + 1})`,
          before: { dueDate: oldDueDate },
          after: { dueDate: newDueDate },
          metadata: {
            // قرار D-1: حقول التدقيق الإلزامية للتغيير
            oldDueDate,
            newDueDate,
            changedBy: user.username || user.name,
            cycle: existing.cycle,
            reportStatus: existing.status,
            fromVersion: versionNum,
            toVersion: versionNum + 1,
          },
          ip: getClientIp(req),
        });
        return { ok: true as const };
      });

      if (!result.ok) {
        const current = await db.report.findUnique({
          where: { id },
          select: { version: true, status: true, name: true, updatedAt: true },
        });
        if (!current) {
          return NextResponse.json({ error: "التقرير غير موجود" }, { status: 404 });
        }
        return NextResponse.json(
          {
            error: "تعذر تغيير الاستحقاق لأن التقرير تغيّر من مستخدم آخر بعد فتحه لديك.",
            code: "VERSION_CONFLICT",
            clientVersion: versionNum,
            currentVersion: current.version,
            currentStatus: current.status,
            updatedAt: current.updatedAt.toISOString(),
          },
          { status: 409 }
        );
      }

      const updated = await db.report.findUnique({ where: { id } });
      const workflow = updated ? await buildWorkflowInfo(updated, user) : null;
      return NextResponse.json({ ...(updated ?? {}), workflow });
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل تغيير تاريخ الاستحقاق: " + msg : msg },
        { status }
      );
    }
  });
}

// حوكمة نقطة واحدة — لا GET/PUT/POST/DELETE على هذا المسار
export function GET() {
  return NextResponse.json({ error: "غير مسموح" }, { status: 405 });
}
export function POST() {
  return NextResponse.json({ error: "غير مسموح" }, { status: 405 });
}
export function PUT() {
  return NextResponse.json({ error: "غير مسموح" }, { status: 405 });
}
export function DELETE() {
  return NextResponse.json({ error: "غير مسموح" }, { status: 405 });
}
