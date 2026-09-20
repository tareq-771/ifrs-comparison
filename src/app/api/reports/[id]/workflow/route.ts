import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, getClientIp } from "@/lib/audit";
import {
  buildWorkflowInfo,
  buildRoleSnapshot,
  canViewReportRow,
  writeWorkflowHistory,
} from "@/lib/workflow-server";
import {
  WORKFLOW_ACTION,
  WORKFLOW_HISTORY_ACTION,
  WORKFLOW_STATUS,
  WORKFLOW_STATUS_LABELS,
  transitionTarget,
  validateSoD,
  SoDViolationMessage,
  isWorkflowStatus,
  type WorkflowAction,
} from "@/lib/workflow";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

const MAX_REASON_LEN = 2000;

/**
 * POST /api/reports/[id]/workflow — نقطة واحدة لكل انتقالات دورة الاعتماد.
 *
 * العقد (المرحلة 3):
 *  - الجسم: { action: SUBMIT|START_REVIEW|RETURN|APPROVE|REOPEN|RESUME_EDIT,
 *             version (إلزامية — القفل التفاؤلي), reason? (إلزامي لـ RETURN/REOPEN), comment? }
 *  - لا انتقال إلا وفق مصفوفة الحالات — لا قفز مباشر بين الحالات إطلاقًا.
 *  - كل انتقال ذري: التحديث المشروط بـ {id, version, status=fromStatus} + صف
 *    WorkflowHistory + AuditLog داخل معاملة واحدة — فشل أي جزء يعني بقاء الحالة كما هي.
 *  - فصل المهام: الفاعل هو المعد/المراجع/المعتمد المعيّن فقط؛ فحص SoD يعاد قبل التنفيذ.
 *  - المدير لا يتجاوز SoD ولا يصبح تلقائيًا مراجعًا/معتمدًا؛ REOPEN وحده إداري.
 *  - عند التعارض: 409 VERSION_CONFLICT structured (currentVersion/currentStatus) بلا أي تغيير.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireAuth();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    const existing = await db.report.findUnique({ where: { id } });
    if (!existing || !canViewReportRow(existing, user)) {
      return NextResponse.json({ error: "التقرير غير موجود" }, { status: 404 });
    }

    /* ── 1) التحقق من النسخة (القفل التفاؤلي — إلزامي في كل انتقال) ─────── */
    const clientVersion = body.version;
    if (clientVersion === undefined || clientVersion === null || clientVersion === "") {
      return NextResponse.json(
        {
          error: "العملية تتطلب إرسال نسخة التقرير (version) التي فتحتها. أعد تحميل التقرير ثم حاول مجددًا.",
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
        {
          error: "قيمة النسخة (version) غير صحيحة — يجب أن تكون عددًا صحيحًا موجبًا.",
          code: "VERSION_INVALID",
          currentVersion: existing.version,
          currentStatus: existing.status,
        },
        { status: 400 }
      );
    }

    /* ── 2) التحقق من الإجراء ──────────────────────────────────────────── */
    const action = body.action as WorkflowAction;
    if (!action || !Object.values(WORKFLOW_ACTION).includes(action)) {
      return NextResponse.json(
        { error: "إجراء workflow غير معروف.", code: "INVALID_ACTION" },
        { status: 400 }
      );
    }

    const fromStatus = existing.status;
    if (!isWorkflowStatus(fromStatus)) {
      return NextResponse.json(
        { error: "حالة التقرير غير معروفة.", code: "INVALID_TRANSITION" },
        { status: 500 }
      );
    }
    const toStatus = transitionTarget(fromStatus, action);
    if (!toStatus) {
      const fromLabel = WORKFLOW_STATUS_LABELS[fromStatus];
      return NextResponse.json(
        {
          error: `انتقال غير مسموح: لا يمكن تنفيذ هذا الإجراء والحالة الحالية «${fromLabel}».`,
          code: "INVALID_TRANSITION",
          currentVersion: existing.version,
          currentStatus: fromStatus,
        },
        { status: 409 }
      );
    }

    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, MAX_REASON_LEN) : "";
    const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, MAX_REASON_LEN) : "";
    const isAdmin = user.role === "admin";

    /* ── 3) فاعل الإجراء + الشروط الإضافية لكل انتقال ──────────────────── */
    // SoD دفاعي: يعاد الفحص قبل كل انتقال (ضد بيانات قديمة/سباقات إسناد)
    const sodViolations = validateSoD({
      preparedById: existing.preparedById,
      reviewedById: existing.reviewedById,
      approvedById: existing.approvedById,
    });

    let auditAction: string | null;
    let historyAction: string;
    let data: Prisma.ReportUpdateManyMutationInput = {};
    let historyMetadata: Record<string, unknown> = {};
    let description: string;

    switch (action) {
      case WORKFLOW_ACTION.SUBMIT: {
        if (existing.preparedById !== user.id) {
          return NextResponse.json(
            {
              error: "الإرسال يتم من المعدّ المعيّن لهذا التقرير فقط.",
              code: "NOT_ASSIGNED",
              currentStatus: fromStatus,
            },
            { status: 403 }
          );
        }
        if (sodViolations.length > 0) {
          return NextResponse.json(
            {
              error: SoDViolationMessage(sodViolations),
              code: "SEGREGATION_VIOLATION",
              currentStatus: fromStatus,
            },
            { status: 400 }
          );
        }
        if (!existing.reviewedById) {
          return NextResponse.json(
            {
              error: "لا يمكن الإرسال قبل تعيين المراجع لهذا التقرير.",
              code: "REVIEWER_NOT_ASSIGNED",
              currentStatus: fromStatus,
            },
            { status: 400 }
          );
        }
        // preparedAt = وقت الخادم عند الإرسال — يمثل اكتمال إعداد المطابقة (تعديل المستخدم رقم 1)
        const isResubmission = !!existing.returnedAt || !!existing.reopenedAt;
        data = {
          status: WORKFLOW_STATUS.SUBMITTED,
          preparedAt: new Date(),
          // تنظيف حقول الإرشاد (سبب الإرجاع/إعادة الفتح) عند الإرسال — الأصل محفوظ في التاريخ
          returnedById: null, returnedByName: "", returnedAt: null, returnReason: "",
          reopenedById: null, reopenedByName: "", reopenedAt: null, reopenReason: "",
        };
        auditAction = isResubmission ? AUDIT_ACTIONS.REPORT_RESUBMITTED : AUDIT_ACTIONS.REPORT_SUBMITTED;
        historyAction = isResubmission ? WORKFLOW_HISTORY_ACTION.RESUBMITTED : WORKFLOW_HISTORY_ACTION.SUBMITTED;
        historyMetadata = {
          reviewer: existing.reviewedByName || existing.reviewedById,
          preparedAtSet: true,
        };
        description = `${isResubmission ? "إعادة إرسال" : "إرسال"} التقرير «${existing.name}» للمراجعة (v${versionNum} → v${versionNum + 1}) — المراجع: ${existing.reviewedByName || "—"}${comment ? " · ملاحظة: " + comment : ""}`;
        break;
      }

      case WORKFLOW_ACTION.START_REVIEW: {
        if (existing.reviewedById !== user.id) {
          return NextResponse.json(
            {
              error: "بدء المراجعة يتم من المراجع المعيّن لهذا التقرير فقط.",
              code: "NOT_ASSIGNED",
              currentStatus: fromStatus,
            },
            { status: 403 }
          );
        }
        data = { status: WORKFLOW_STATUS.UNDER_REVIEW, reviewedAt: new Date() };
        auditAction = AUDIT_ACTIONS.REVIEW_STARTED;
        historyAction = WORKFLOW_HISTORY_ACTION.REVIEW_STARTED;
        historyMetadata = {};
        description = `بدء مراجعة التقرير «${existing.name}» (v${versionNum} → v${versionNum + 1})${comment ? " · ملاحظة: " + comment : ""}`;
        break;
      }

      case WORKFLOW_ACTION.RETURN: {
        if (existing.reviewedById !== user.id) {
          return NextResponse.json(
            {
              error: "الإرجاع يتم من المراجع المعيّن لهذا التقرير فقط.",
              code: "NOT_ASSIGNED",
              currentStatus: fromStatus,
            },
            { status: 403 }
          );
        }
        if (!reason) {
          return NextResponse.json(
            {
              error: "سبب الإرجاع إلزامي.",
              code: "REASON_REQUIRED",
              currentStatus: fromStatus,
            },
            { status: 400 }
          );
        }
        data = {
          status: WORKFLOW_STATUS.RETURNED,
          returnedById: user.id,
          returnedByName: user.name || user.username,
          returnedAt: new Date(),
          returnReason: reason,
        };
        auditAction = AUDIT_ACTIONS.REPORT_RETURNED;
        historyAction = WORKFLOW_HISTORY_ACTION.RETURNED;
        historyMetadata = { reasonSet: true };
        description = `إرجاع التقرير «${existing.name}» للتصحيح (v${versionNum} → v${versionNum + 1}) — السبب: ${reason}`;
        break;
      }

      case WORKFLOW_ACTION.APPROVE: {
        if (existing.approvedById !== user.id) {
          return NextResponse.json(
            {
              error: "الاعتماد يتم من المعتمد المعيّن لهذا التقرير فقط.",
              code: "NOT_ASSIGNED",
              currentStatus: fromStatus,
            },
            { status: 403 }
          );
        }
        if (!existing.reviewedAt || !existing.reviewedById) {
          return NextResponse.json(
            {
              error: "لا يمكن الاعتماد قبل أن تبدأ المراجعة بصورة صحيحة.",
              code: "REVIEW_NOT_STARTED",
              currentStatus: fromStatus,
            },
            { status: 400 }
          );
        }
        if (sodViolations.length > 0) {
          return NextResponse.json(
            {
              error: SoDViolationMessage(sodViolations),
              code: "SEGREGATION_VIOLATION",
              currentStatus: fromStatus,
            },
            { status: 400 }
          );
        }
        data = { status: WORKFLOW_STATUS.APPROVED, approvedAt: new Date() };
        auditAction = AUDIT_ACTIONS.REPORT_APPROVED;
        historyAction = WORKFLOW_HISTORY_ACTION.APPROVED;
        historyMetadata = {};
        description = `اعتماد التقرير «${existing.name}» (v${versionNum} → v${versionNum + 1}) — الدورة ${existing.cycle}${comment ? " · ملاحظة: " + comment : ""}`;
        break;
      }

      case WORKFLOW_ACTION.REOPEN: {
        // صلاحية خاصة: المدير أو حائز reopenReport (لا تُمنح تلقائيًا لأي دور آخر)
        const canReopen = isAdmin || user.permissions.reopenReport === true;
        if (!canReopen) {
          return NextResponse.json(
            {
              error: "إعادة الفتح تتطلب صلاحية خاصة (reopenReport) لا تملكها.",
              code: "FORBIDDEN",
              currentStatus: fromStatus,
            },
            { status: 403 }
          );
        }
        if (!reason) {
          return NextResponse.json(
            {
              error: "سبب إعادة الفتح إلزامي.",
              code: "REASON_REQUIRED",
              currentStatus: fromStatus,
            },
            { status: 400 }
          );
        }
        // أرشفة الدورة المعتمدة أولًا (داخل نفس المعاملة أدناه) ثم مسح حقول الاعتماد — لا فقد تاريخ إطلاقًا
        data = {
          status: WORKFLOW_STATUS.REOPENED,
          reopenedById: user.id,
          reopenedByName: user.name || user.username,
          reopenedAt: new Date(),
          reopenReason: reason,
          cycle: existing.cycle + 1, // الدورة تزداد عند REOPEN فقط (لا عند RETURN/إعادة إرسال)
          approvedById: null,
          approvedByName: "",
          approvedAt: null,
        };
        historyMetadata = {
          previousApproval: {
            approvedBy: existing.approvedByName || existing.approvedById,
            approvedAt: existing.approvedAt ? existing.approvedAt.toISOString() : null,
            reviewedBy: existing.reviewedByName || existing.reviewedById,
            reviewedAt: existing.reviewedAt ? existing.reviewedAt.toISOString() : null,
            cycle: existing.cycle,
          },
        };
        auditAction = AUDIT_ACTIONS.REPORT_REOPENED;
        historyAction = WORKFLOW_HISTORY_ACTION.REOPENED;
        description = `إعادة فتح التقرير «${existing.name}» المعتمد (v${versionNum} → v${versionNum + 1}) — السبب: ${reason}`;
        break;
      }

      case WORKFLOW_ACTION.RESUME_EDIT: {
        if (existing.preparedById !== user.id) {
          return NextResponse.json(
            {
              error: "استئناف التعديل يتم من المعدّ المعيّن لهذا التقرير فقط.",
              code: "NOT_ASSIGNED",
              currentStatus: fromStatus,
            },
            { status: 403 }
          );
        }
        // العودة إلى DRAFT — أسباب الإرجاع/إعادة الفتح تبقى ظاهرة كإرشاد للتصحيح
        // (تُمسح عند الإرسال القادم)، والتاريخ الكامل محفوظ في WorkflowHistory دائمًا.
        data = { status: WORKFLOW_STATUS.DRAFT };
        auditAction = null; // RESUME_EDIT يوثق في WorkflowHistory فقط (قرار D-2 المعتمد)
        historyAction = WORKFLOW_HISTORY_ACTION.RESUMED_EDIT;
        historyMetadata = {};
        description = `استئناف تعديل التقرير «${existing.name}» (v${versionNum} → v${versionNum + 1})`;
        break;
      }

      default:
        return NextResponse.json({ error: "إجراء غير معروف", code: "INVALID_ACTION" }, { status: 400 });
    }

    /* ── 4) التنفيذ الذري: تحديث مشروط + WorkflowHistory + AuditLog ─────── */
    const result = await db.$transaction(async (tx) => {
      // UPDATE ... WHERE id=? AND version=? AND status=? — عبارة واحدة ذرية:
      // لا يمكن لطلبين بنفس النسخة أن ينجحا معًا، ولا انتقال من حالة تغيّرت بين القراءة والكتابة.
      const res = await tx.report.updateMany({
        where: { id, version: versionNum, status: fromStatus },
        data: { ...data, version: { increment: 1 } },
      });
      if (res.count === 0) return { ok: false as const };

      // الأرشفة داخل نفس المعاملة — snapshot الأدوار لحظة الحدث.
      // لمعظم الانتقالات نستخدم الحالة اللاحقة للانتقال حتى يحمل الصف الأثر المُثبَت
      // (SUBMITTED: preparedAt=الآن، REVIEW_STARTED: reviewedAt=الآن، APPROVED: approvedAt=الآن)
      // أما REOPEN فيأخذ الحالة السابقة للانتقال — snapshot الاعتماد قبل مسح حقوله
      // (تعديل المستخدم رقم 3: الأرشفة أولًا داخل نفس المعاملة قبل أي مسح).
      const postState = { ...existing, ...data } as typeof existing;
      const snapSource = action === WORKFLOW_ACTION.REOPEN ? existing : postState;
      await writeWorkflowHistory(tx, {
        reportId: id,
        cycle: existing.cycle,
        action: historyAction as never,
        fromStatus,
        toStatus,
        actorId: user.id,
        actorUsername: user.username || user.name,
        reason: action === WORKFLOW_ACTION.RETURN || action === WORKFLOW_ACTION.REOPEN ? reason : comment,
        comment,
        roleSnapshot: buildRoleSnapshot(snapSource),
        metadata: historyMetadata,
      });

      if (auditAction) {
        await writeAudit(tx, {
          user,
          action: auditAction,
          entityType: AUDIT_ENTITY_TYPES.Report,
          entityId: id,
          description,
          metadata: {
            cycle: existing.cycle,
            fromStatus,
            toStatus,
            clientVersion: versionNum,
            newVersion: versionNum + 1,
            ...(reason ? { reason } : {}),
            ...historyMetadata,
          },
          ip: getClientIp(req),
        });
      }
      return { ok: true as const };
    });

    if (!result.ok) {
      /* ── 5) تعارض نسخة/حالة: لا تغيير إطلاقًا ─────────────────────────── */
      const current = await db.report.findUnique({
        where: { id },
        select: { version: true, status: true, name: true, updatedAt: true },
      });
      if (!current) {
        return NextResponse.json({ error: "التقرير غير موجود" }, { status: 404 });
      }
      return NextResponse.json(
        {
          error:
            "تعذر تنفيذ العملية لأن هذا التقرير تم تعديله من مستخدم آخر بعد فتحه لديك.",
          code: "VERSION_CONFLICT",
          clientVersion: versionNum,
          currentVersion: current.version,
          currentStatus: current.status,
          updatedAt: current.updatedAt.toISOString(),
        },
        { status: 409 }
      );
    }

    /* ── 6) نجاح: أعِد التقرير الكامل الجديد + كائن workflow ────────────── */
    const updated = await db.report.findUnique({ where: { id } });
    const workflow = updated ? await buildWorkflowInfo(updated, user) : null;
    return NextResponse.json({ ...(updated ?? {}), workflow });
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل تنفيذ العملية: " + msg : msg },
      { status }
    );
  }
}

// الانتقالات POST فقط — لا GET/PUT/DELETE على مسار workflow (التاريخ append-only)
export function GET() {
  return NextResponse.json({ error: "غير مسموح" }, { status: 405 });
}
export function PUT() {
  return NextResponse.json({ error: "غير مسموح" }, { status: 405 });
}
export function DELETE() {
  return NextResponse.json({ error: "غير مسموح" }, { status: 405 });
}
