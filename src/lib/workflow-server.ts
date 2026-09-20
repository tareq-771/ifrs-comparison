// مساعدات Workflow الخادمية — تستورد Prisma/db فقط في الخادم.
// تكمل src/lib/workflow.ts (النقي) بما يحتاج قاعدة بيانات.

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import {
  computeMyActions,
  WORKFLOW_HISTORY_ACTION_LABELS,
  type WorkflowReportSnapshot,
  type WorkflowMyActions,
  type WorkflowHistoryAction,
} from "@/lib/workflow";
import { canAssignWorkflow, canReopenReport } from "@/lib/permissions";
import type { SessionUser } from "@/lib/session";

type ReportRow = Prisma.ReportGetPayload<{ select: Record<string, true> }>;

/** بيانات مستخدم موجزة للـ snapshot (بلا أي بيانات حساسة). */
interface ActorInfo {
  id: string | null;
  name: string;
  at: string | null;
}

function actorInfo(id: string | null, name: string, at: Date | string | null | undefined): ActorInfo {
  return {
    id: id ?? null,
    name: name || "",
    at: at ? (typeof at === "string" ? at : at.toISOString()) : null,
  };
}

/** بناء snapshot الأدوار لحظة حدث — يُخزن في WorkflowHistory.roleSnapshot (JSON صغير). */
export function buildRoleSnapshot(report: {
  preparedById: string | null; preparedByName: string; preparedAt: Date | null;
  reviewedById: string | null; reviewedByName: string; reviewStartedAt: Date | null; reviewedAt: Date | null;
  approvedById: string | null; approvedByName: string; approvedAt: Date | null;
}): string {
  return JSON.stringify({
    preparedBy: actorInfo(report.preparedById, report.preparedByName, report.preparedAt),
    // المرحلة 3.5: بدء المراجعة (reviewStartedAt) منفصل عن إتمامها (reviewedAt = توقيع المراجع)
    reviewedBy: report.reviewedById
      ? {
          ...actorInfo(
            report.reviewedById,
            report.reviewedByName,
            report.reviewedAt
          ),
          reviewStartedAt: report.reviewStartedAt ? report.reviewStartedAt.toISOString() : null,
        }
      : null,
    approvedBy: report.approvedById
      ? actorInfo(report.approvedById, report.approvedByName, report.approvedAt)
      : null,
  });
}

/**
 * كتابة صف WorkflowHistory داخل معاملة — append-only.
 * لا يوجد أي مسار تعديل/حذف لهذا الجدول في النظام كله.
 */
export async function writeWorkflowHistory(
  tx: Prisma.TransactionClient,
  input: {
    reportId: string;
    cycle: number;
    action: WorkflowHistoryAction;
    fromStatus?: string;
    toStatus?: string;
    actorId?: string | null;
    actorUsername?: string;
    reason?: string;
    comment?: string;
    roleSnapshot?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.workflowHistory.create({
    data: {
      reportId: input.reportId,
      cycle: input.cycle,
      action: input.action,
      fromStatus: input.fromStatus ?? "",
      toStatus: input.toStatus ?? "",
      actorId: input.actorId ?? null,
      actorUsername: (input.actorUsername ?? "").slice(0, 120),
      reason: (input.reason ?? "").slice(0, 2000),
      comment: (input.comment ?? "").slice(0, 2000),
      roleSnapshot: input.roleSnapshot
        ? JSON.stringify({ roles: JSON.parse(input.roleSnapshot), ...(input.metadata ?? {}) })
        : JSON.stringify(input.metadata ?? {}),
    },
  });
}

/** تسمية عربية لحدث التاريخ (للاستخدام في القراءة). */
export function historyActionLabel(action: string): string {
  return WORKFLOW_HISTORY_ACTION_LABELS[action as WorkflowHistoryAction] ?? action;
}

/** هل يمكن للمستخدم رؤية التقرير؟ (مالك / مجموعة مرتبطة / مشارك في الأدوار / مدير) */
export function canViewReportRow(
  report: { userId: string | null; groupId: string | null; preparedById: string | null; reviewedById: string | null; approvedById: string | null },
  user: SessionUser
): boolean {
  if (user.role === "admin") return true;
  if (report.userId === user.id) return true;
  const linked = Array.isArray(user.permissions.groupIds) ? user.permissions.groupIds : [];
  if (report.groupId !== null && linked.includes(report.groupId)) return true;
  return (
    report.preparedById === user.id ||
    report.reviewedById === user.id ||
    report.approvedById === user.id
  );
}

/**
 * بناء كائن workflow الكامل لاستجابات API — محسوب خادميًا:
 * الحالة، الدورة، المشاركون بأسمائهم وتواريخهم، الأسباب، و myActions للمستخدم الحالي.
 * الواجهة تعرض ما يسمح به الخادم فقط (زر لكل إجراء مسموح).
 */
export async function buildWorkflowInfo(
  report: ReportRow,
  user: SessionUser
): Promise<{
  status: string;
  statusLabel: string;
  cycle: number;
  periodEnd: string | null;
  dueDate: string | null;
  preparedBy: ActorInfo | null;
  reviewedBy: ActorInfo | null;
  reviewStartedAt: string | null;
  approvedBy: ActorInfo | null;
  returned: { by: string; byName: string; at: string | null; reason: string } | null;
  reopened: { by: string; byName: string; at: string | null; reason: string } | null;
  myActions: WorkflowMyActions;
}> {
  // أسماء المُرجِع ومُعيد الفتح: snapshot على الصف + fallback للاستعلام عند الحاجة
  const missingIds = [report.returnedById, report.reopenedById].filter(
    (id): id is string => !!id
  );
  let resolved = new Map<string, string>();
  if (missingIds.length > 0) {
    const users = await db.user.findMany({
      where: { id: { in: missingIds } },
      select: { id: true, displayName: true, username: true },
    });
    resolved = new Map(users.map((u) => [u.id, u.displayName || u.username]));
  }
  const returnedByName =
    report.returnedByName || (report.returnedById ? resolved.get(report.returnedById) || "" : "");
  const reopenedByName =
    report.reopenedByName || (report.reopenedById ? resolved.get(report.reopenedById) || "" : "");

  const snapshot: WorkflowReportSnapshot = {
    status: report.status,
    cycle: report.cycle,
    preparedById: report.preparedById,
    reviewedById: report.reviewedById,
    approvedById: report.approvedById,
    reviewStartedAt: report.reviewStartedAt,
    reviewedAt: report.reviewedAt,
    preparedByName: report.preparedByName,
    preparedAt: report.preparedAt,
    reviewedByName: report.reviewedByName,
    approvedByName: report.approvedByName,
    approvedAt: report.approvedAt,
    returnedById: report.returnedById,
    returnedByName,
    returnedAt: report.returnedAt,
    returnReason: report.returnReason,
    reopenedById: report.reopenedById,
    reopenedByName,
    reopenedAt: report.reopenedAt,
    reopenReason: report.reopenReason,
    periodEnd: report.periodEnd,
    dueDate: report.dueDate,
  };

  const linked = Array.isArray(user.permissions.groupIds) ? user.permissions.groupIds : [];
  const myActions = computeMyActions(snapshot, {
    id: user.id,
    role: user.role,
    permissions: {
      edit: user.permissions.edit,
      view: user.permissions.view,
      assignWorkflow: canAssignWorkflow(user.permissions, user.role),
      reopenReport: canReopenReport(user.permissions, user.role),
      groupIds: linked,
    },
    isOwner: report.userId === user.id,
    isLinkedToReportGroup:
      report.groupId !== null && linked.includes(report.groupId),
  });

  const { WORKFLOW_STATUS_LABELS } = await import("@/lib/workflow");

  return {
    status: report.status,
    statusLabel: WORKFLOW_STATUS_LABELS[report.status as keyof typeof WORKFLOW_STATUS_LABELS] ?? report.status,
    cycle: report.cycle,
    periodEnd: report.periodEnd ?? null,
    dueDate: report.dueDate ?? null,
    preparedBy: report.preparedById
      ? actorInfo(report.preparedById, report.preparedByName, report.preparedAt)
      : null,
    reviewedBy: report.reviewedById
      ? actorInfo(report.reviewedById, report.reviewedByName, report.reviewedAt)
      : null,
    reviewStartedAt: report.reviewStartedAt ? report.reviewStartedAt.toISOString() : null,
    approvedBy: report.approvedById
      ? actorInfo(report.approvedById, report.approvedByName, report.approvedAt)
      : null,
    returned: report.returnedById
      ? {
          by: report.returnedById,
          byName: returnedByName,
          at: report.returnedAt ? report.returnedAt.toISOString() : null,
          reason: report.returnReason || "",
        }
      : null,
    reopened: report.reopenedById
      ? {
          by: report.reopenedById,
          byName: reopenedByName,
          at: report.reopenedAt ? report.reopenedAt.toISOString() : null,
          reason: report.reopenReason || "",
        }
      : null,
    myActions,
  };
}
