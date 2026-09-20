import { NextRequest, NextResponse } from "next/server";
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
  WORKFLOW_HISTORY_ACTION,
  WORKFLOW_STATUS,
  WORKFLOW_STATUS_LABELS,
  validateSoD,
  SoDViolationMessage,
  isWorkflowStatus,
} from "@/lib/workflow";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

const ASSIGNABLE_STATUSES = [WORKFLOW_STATUS.DRAFT, WORKFLOW_STATUS.RETURNED, WORKFLOW_STATUS.REOPENED];
// المرحلة 3.5: الدورة الجارية تشمل PENDING_APPROVAL — دور المراجع/المعتمد فيه يُستبدل ولا يُفرّغ
// (استبدال المراجع بعد التوقيع يبطل التوقيع ويعيد إلى SUBMITTED — لا يُحتمل أن يبدو الجديد هو الموقّع)
const MID_CYCLE_REVIEWER_STATUSES = [WORKFLOW_STATUS.SUBMITTED, WORKFLOW_STATUS.UNDER_REVIEW, WORKFLOW_STATUS.PENDING_APPROVAL];
const MAX_REASON_LEN = 2000;

interface AssignmentChange {
  role: "prepared" | "reviewed" | "approved";
  from: { id: string | null; name: string } | null;
  to: { id: string | null; name: string } | null;
}

/**
 * PUT /api/reports/[id]/assignments — تعيين/تغيير أدوار التقرير (المعد/المراجع/المعتمد).
 *
 * العقد (المرحلة 3):
 *  - سماوية: المدير أو حائز assignWorkflow فقط (403 FORBIDDEN).
 *  - الجسم: { preparedById?, reviewedById?, approvedById?, version إلزامية, reason? }
 *  - بوابات الحالة:
 *      · تغيير المعد: DRAFT/RETURNED/REOPENED فقط.
 *      · تغيير المراجع/المعتمد: DRAFT/RETURNED/REOPENED + استثناء تشغيلي واحد:
 *        الاستبدال (بقيمة جديدة غير فارغة) مسموح في SUBMITTED/UNDER_REVIEW (قرار D-4).
 *      · APPROVED: لا إسناد إطلاقًا — إعادة الفتح (REOPEN) أولًا.
 *  - أهلية الهدف: مستخدم موجود وactive (ASSIGNMENT_TARGET_INVALID).
 *  - SoD: الثلاثية الناتجة يجب أن تكون مختلفة (SEGREGATION_VIOLATION).
 *  - استبدال المراجع بعد بدء المراجعة (reviewStartedAt موجودة): تُمسح reviewStartedAt/reviewedAt
 *    وتعود الحالة إلى SUBMITTED — لا يُحتمل أن يبدو المراجع الجديد هو من راجع/وقّع سابقًا
 *    (تعديل المستخدم رقم 7 + قرار 3.5) — المراجعة تبدأ من جديد بيد المراجع الجديد.
 *    الاستبدال في PENDING_APPROVAL يبطل توقيع المراجع نفسه ويعيد إلى SUBMITTED.
 *  - ذرية: التحديث المشروط بـ {id, version, status} + WorkflowHistory + AuditLog في معاملة واحدة،
 *    وversion يزداد 1 مع أي تغيير إسناد (قرار D-6).
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireAuth();
    const { id } = await params;

    const isAdmin = user.role === "admin";
    const canAssign = isAdmin || user.permissions.assignWorkflow === true;
    if (!canAssign) {
      return NextResponse.json(
        { error: "تغيير الإسناد يتطلب صلاحية خاصة (assignWorkflow) لا تملكها.", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    const existing = await db.report.findUnique({ where: { id } });
    if (!existing || !canViewReportRow(existing, user)) {
      return NextResponse.json({ error: "التقرير غير موجود" }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const clientVersion = body.version;
    if (clientVersion === undefined || clientVersion === null || clientVersion === "") {
      return NextResponse.json(
        {
          error: "تغيير الإسناد يتطلب إرسال نسخة التقرير (version). أعد تحميل التقرير ثم حاول مجددًا.",
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
          error: "قيمة النسخة (version) غير صحيحة.",
          code: "VERSION_INVALID",
          currentVersion: existing.version,
          currentStatus: existing.status,
        },
        { status: 400 }
      );
    }

    const fromStatus = existing.status;
    if (!isWorkflowStatus(fromStatus)) {
      return NextResponse.json({ error: "حالة التقرير غير معروفة.", code: "INVALID_TRANSITION" }, { status: 500 });
    }
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, MAX_REASON_LEN) : "";

    // التحقق من الأهداف الجديدة (وجود + تفعيل) وجلب أسمائهم للـ snapshot
    const requested: { role: "prepared" | "reviewed" | "approved"; value: string | null }[] = [];
    for (const role of ["prepared", "reviewed", "approved"] as const) {
      const key = `${role}ById`;
      if (body[key] === undefined) continue;
      let value: string | null = body[key];
      if (value === "" ) value = null;
      if (value !== null && typeof value !== "string") {
        return NextResponse.json(
          { error: `قيمة ${key} غير صحيحة.`, code: "ASSIGNMENT_TARGET_INVALID" },
          { status: 400 }
        );
      }
      requested.push({ role, value });
    }
    if (requested.length === 0) {
      return NextResponse.json(
        { error: "لم يُرسل أي تغيير إسناد.", code: "NO_CHANGES" },
        { status: 400 }
      );
    }

    const targetIds = requested.map((r) => r.value).filter((v): v is string => !!v);
    const targetUsers = targetIds.length
      ? await db.user.findMany({
          where: { id: { in: targetIds } },
          select: { id: true, username: true, displayName: true, active: true },
        })
      : [];
    const targetMap = new Map(targetUsers.map((u) => [u.id, u]));
    for (const t of targetIds) {
      const u = targetMap.get(t);
      if (!u || !u.active) {
        return NextResponse.json(
          { error: "المستخدم المُرسَّح إليه غير موجود أو غير مفعّل.", code: "ASSIGNMENT_TARGET_INVALID" },
          { status: 400 }
        );
      }
    }

    /* ── بوابات الحالة لكل دور ─────────────────────────────────────────── */
    if (fromStatus === WORKFLOW_STATUS.APPROVED) {
      return NextResponse.json(
        {
          error: `التقرير معتمد — لا تغيير إسناد قبل إعادة الفتح (الحالة الحالية: «${WORKFLOW_STATUS_LABELS.APPROVED}»).`,
          code: "WORKFLOW_LOCKED",
          currentStatus: fromStatus,
          currentVersion: existing.version,
        },
        { status: 403 }
      );
    }
    for (const r of requested) {
      if (r.role === "prepared") {
        // تغيير المعد في SUBMITTED/UNDER_REVIEW ممنوع (البيانات قيد مراجعة)
        if (!ASSIGNABLE_STATUSES.includes(fromStatus)) {
          return NextResponse.json(
            {
              error: `تغيير المعدّ مسموح في المسودة/المُرجَع/المُعاد فتحه فقط (الحالة الحالية: «${WORKFLOW_STATUS_LABELS[fromStatus as keyof typeof WORKFLOW_STATUS_LABELS] ?? fromStatus}»).`,
              code: "WORKFLOW_LOCKED",
              currentStatus: fromStatus,
              currentVersion: existing.version,
            },
            { status: 403 }
          );
        }
      } else {
        // المراجع/المعتمد: في SUBMITTED/UNDER_REVIEW يُسمح بالاستبدال فقط (لا التفريغ) — قرار D-4
        if (MID_CYCLE_REVIEWER_STATUSES.includes(fromStatus) && r.value === null) {
          return NextResponse.json(
            {
              error: `لا يمكن تفريغ دور ${r.role === "reviewed" ? "المراجع" : "المعتمد"} أثناء الدورة — الاستبدال بمستخدم آخر فقط.`,
              code: "WORKFLOW_LOCKED",
              currentStatus: fromStatus,
              currentVersion: existing.version,
            },
            { status: 403 }
          );
        }
      }
    }

    /* ── بناء الثلاثية الناتجة + فحص SoD ───────────────────────────────── */
    const nextTrio = {
      preparedById: existing.preparedById,
      reviewedById: existing.reviewedById,
      approvedById: existing.approvedById,
    };
    const roleKeyMap = { prepared: "preparedById", reviewed: "reviewedById", approved: "approvedById" } as const;
    const nameKeyMap = { prepared: "preparedByName", reviewed: "reviewedByName", approved: "approvedByName" } as const;
    for (const r of requested) {
      nextTrio[roleKeyMap[r.role]] = r.value;
    }
    const sodViolations = validateSoD(nextTrio);
    if (sodViolations.length > 0) {
      return NextResponse.json(
        {
          error: SoDViolationMessage(sodViolations),
          code: "SEGREGATION_VIOLATION",
          currentStatus: fromStatus,
          currentVersion: existing.version,
        },
        { status: 400 }
      );
    }

    /* ── استبدال المراجع بعد بدء المراجعة: تصفير المراجعة + عودة إلى SUBMITTED ── */
    const reviewerChanging =
      requested.some((r) => r.role === "reviewed" && r.value !== existing.reviewedById);
    const reviewWasStarted = !!existing.reviewStartedAt || !!existing.reviewedAt;
    const resetReview = reviewerChanging && reviewWasStarted;

    const data: Record<string, unknown> = {};
    const changes: AssignmentChange[] = [];
    for (const r of requested) {
      const oldId = existing[roleKeyMap[r.role]];
      const oldNameField = existing[nameKeyMap[r.role]] as string;
      const changed = oldId !== r.value;
      if (!changed) continue;
      data[roleKeyMap[r.role]] = r.value;
      data[nameKeyMap[r.role]] = r.value ? (targetMap.get(r.value)?.displayName || targetMap.get(r.value)?.username || "") : "";
      changes.push({
        role: r.role,
        from: oldId ? { id: oldId, name: oldNameField || oldId } : null,
        to: r.value ? { id: r.value, name: targetMap.get(r.value)?.displayName || targetMap.get(r.value)?.username || "" } : null,
      });
    }
    if (changes.length === 0) {
      return NextResponse.json(
        { error: "لا يوجد تغيير فعلي في الإسناد.", code: "NO_CHANGES", currentVersion: existing.version },
        { status: 400 }
      );
    }
    if (resetReview) {
      // لا يُحتمل أن يبدو المراجع الجديد هو من راجع سابقًا — المراجعة تبدأ من جديد
      // المرحلة 3.5: يُمسح بدء المراجعة (reviewStartedAt) وإتمامها (reviewedAt) معًا
      data.reviewStartedAt = null;
      data.reviewedAt = null;
      if (fromStatus === WORKFLOW_STATUS.UNDER_REVIEW) {
        data.status = WORKFLOW_STATUS.SUBMITTED;
      }
      // المرحلة 3.5: استبدال المراجع في PENDING_APPROVAL يبطل التوقيع ويعيد إلى SUBMITTED
      if (fromStatus === WORKFLOW_STATUS.PENDING_APPROVAL) {
        data.status = WORKFLOW_STATUS.SUBMITTED;
      }
    }

    /* ── التنفيذ الذري ─────────────────────────────────────────────────── */
    const result = await db.$transaction(async (tx) => {
      const res = await tx.report.updateMany({
        where: { id, version: versionNum, status: fromStatus },
        data: { ...data, version: { increment: 1 } },
      });
      if (res.count === 0) return { ok: false as const };

      const snap = { ...existing, ...data } as typeof existing;
      await writeWorkflowHistory(tx, {
        reportId: id,
        cycle: existing.cycle,
        action: WORKFLOW_HISTORY_ACTION.ASSIGNMENT_CHANGED as never,
        fromStatus,
        toStatus: (data.status as string) ?? fromStatus,
        actorId: user.id,
        actorUsername: user.username || user.name,
        reason,
        roleSnapshot: buildRoleSnapshot(snap),
        metadata: {
          changes: changes.map((c) => ({
            role: c.role,
            from: c.from?.name ?? null,
            to: c.to?.name ?? null,
          })),
          reviewReset: resetReview,
        },
      });

      const roleLabels: Record<string, string> = {
        prepared: "المعدّ",
        reviewed: "المراجع",
        approved: "المعتمد",
      };
      await writeAudit(tx, {
        user,
        action: AUDIT_ACTIONS.ASSIGNMENT_CHANGED,
        entityType: AUDIT_ENTITY_TYPES.Report,
        entityId: id,
        description: `تغيير إسناد التقرير «${existing.name}» — ${changes
          .map((c) => `${roleLabels[c.role]}: ${c.from?.name ?? "فارغ"} → ${c.to?.name ?? "فارغ"}`)
          .join(" · ")}${reason ? ` — السبب: ${reason}` : ""}`,
        before: Object.fromEntries(
          changes.flatMap((c) => [
            [`${c.role}ById`, c.from?.id ?? null],
            [`${c.role}ByName`, c.from?.name ?? null],
          ])
        ),
        after: Object.fromEntries(
          changes.flatMap((c) => [
            [`${c.role}ById`, c.to?.id ?? null],
            [`${c.role}ByName`, c.to?.name ?? null],
          ])
        ),
        metadata: {
          cycle: existing.cycle,
          changes: changes.map((c) => ({ role: c.role, from: c.from?.name ?? null, to: c.to?.name ?? null })),
          reviewReset: resetReview,
          ...(reason ? { reason } : {}),
        },
        ip: getClientIp(req),
      });
      return { ok: true as const };
    });

    if (!result.ok) {
      const current = await db.report.findUnique({
        where: { id },
        select: { version: true, status: true, updatedAt: true },
      });
      if (!current) {
        return NextResponse.json({ error: "التقرير غير موجود" }, { status: 404 });
      }
      return NextResponse.json(
        {
          error: "تعذر تنفيذ تغيير الإسناد لأن التقرير تغيّر من مستخدم آخر بعد فتحه لديك.",
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
      { error: status === 500 ? "فشل تغيير الإسناد: " + msg : msg },
      { status }
    );
  }
}
