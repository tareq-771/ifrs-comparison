// المرحلة 3.5B — اشتقاقات لوحة متابعة المطابقات (وحدة نقية — آمنة للعميل والخادم).
// المصدر الواحد: مرحلة الأعمال (Business Stage) + المسؤولية الحالية + المتأخر —
// تُستخدم في البطاقات والفلاتر وقيم الصفوف معًا فلا يمكن أن يختلف رقم بطاقة
// عن نتيجة الفلترة عليها (خاصية التكافؤ المُختبرة إلزاميًا).
// تُكمل src/lib/workflow.ts (deriveOwnerRole) ولا تكرر أي منطق حالة.

import {
  OWNER_ROLE_LABELS,
  WORKFLOW_STATUS,
  deriveOwnerRole,
  type OwnerRole,
} from "@/lib/workflow";
import { calendarDaysBetween } from "@/lib/business-time";

/* ──────────────────────────────────────────────────────────────────────── */
/*  مرحلة الأعمال — دالة خادمية نقية حصرية التمثّم (تقسيم للكل)              */
/* ──────────────────────────────────────────────────────────────────────── */

export const BUSINESS_STAGE = {
  APPROVED: "APPROVED",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  UNDER_REVIEW: "UNDER_REVIEW",
  SUBMITTED: "SUBMITTED",
  RETURNED: "RETURNED",
  REOPENED: "REOPENED",
  NEW_DRAFT: "NEW_DRAFT",
} as const;

export type BusinessStage = (typeof BUSINESS_STAGE)[keyof typeof BUSINESS_STAGE];

export const BUSINESS_STAGE_LABELS: Record<BusinessStage, string> = {
  APPROVED: "معتمدة",
  PENDING_APPROVAL: "بانتظار الاعتماد",
  UNDER_REVIEW: "قيد المراجعة",
  SUBMITTED: "بانتظار المراجعة",
  RETURNED: "معادة للتعديل",
  REOPENED: "معاد فتحها — بانتظار إعادة الإعداد",
  NEW_DRAFT: "مسودة جديدة",
};

/** مفتاح تقييم لمرحلة الأعمال (خادمية) — تُفحص بالترتيب وأول ما يصيب يفوز. */
export function deriveStage(report: {
  status: string;
  returnedAt?: string | Date | null;
  reopenedAt?: string | Date | null;
  preparedAt?: string | Date | null;
}): BusinessStage {
  switch (report.status) {
    case WORKFLOW_STATUS.APPROVED:
      return BUSINESS_STAGE.APPROVED;
    case WORKFLOW_STATUS.PENDING_APPROVAL:
      return BUSINESS_STAGE.PENDING_APPROVAL;
    case WORKFLOW_STATUS.UNDER_REVIEW:
      return BUSINESS_STAGE.UNDER_REVIEW;
    case WORKFLOW_STATUS.SUBMITTED:
      return BUSINESS_STAGE.SUBMITTED;
    case WORKFLOW_STATUS.RETURNED:
      return BUSINESS_STAGE.RETURNED;
    case WORKFLOW_STATUS.REOPENED:
      return BUSINESS_STAGE.REOPENED;
    case WORKFLOW_STATUS.DRAFT: {
      // المسودة البعدية: أسباب الإرجاع/إعادة الفتح تبقى معبأة حتى إعادة الإرسال
      if (report.returnedAt) return BUSINESS_STAGE.RETURNED;
      if (report.reopenedAt && report.preparedAt) return BUSINESS_STAGE.REOPENED;
      // (DRAFT بلا returnedAt بلا reopenedAt مع preparedAt) مستحيلة نظريًا عبر
      // الانتقالات — fallback دفاعي إلى مسودة جديدة
      return BUSINESS_STAGE.NEW_DRAFT;
    }
    default:
      return BUSINESS_STAGE.NEW_DRAFT; // حالة غير معروفة — دفاعي
  }
}

/**
 * الترجمة المكافئة لـ deriveStage إلى شرط WHERE خادمي (Prisma) —
 * التطابق حرفي مع الدالة أعلاه (يُختبر تكافؤ بطاقة↔فلتر إلزاميًا).
 */
export function stageToWhere(stage: BusinessStage): Record<string, unknown> {
  switch (stage) {
    case BUSINESS_STAGE.APPROVED:
      return { status: WORKFLOW_STATUS.APPROVED };
    case BUSINESS_STAGE.PENDING_APPROVAL:
      return { status: WORKFLOW_STATUS.PENDING_APPROVAL };
    case BUSINESS_STAGE.UNDER_REVIEW:
      return { status: WORKFLOW_STATUS.UNDER_REVIEW };
    case BUSINESS_STAGE.SUBMITTED:
      return { status: WORKFLOW_STATUS.SUBMITTED };
    case BUSINESS_STAGE.RETURNED:
      return {
        OR: [
          { status: WORKFLOW_STATUS.RETURNED },
          { AND: [{ status: WORKFLOW_STATUS.DRAFT }, { returnedAt: { not: null } }] },
        ],
      };
    case BUSINESS_STAGE.REOPENED:
      return {
        OR: [
          { status: WORKFLOW_STATUS.REOPENED },
          {
            AND: [
              { status: WORKFLOW_STATUS.DRAFT },
              { returnedAt: null },
              { reopenedAt: { not: null } },
              { preparedAt: { not: null } },
            ],
          },
        ],
      };
    case BUSINESS_STAGE.NEW_DRAFT:
      // DRAFT ∧ لا إرجاع ∧ ¬(إعادة فتح ∧ إعداد سابق) — يطابق فرع DRAFT في deriveStage حرفيًا
      return {
        AND: [
          { status: WORKFLOW_STATUS.DRAFT },
          { returnedAt: null },
          { OR: [{ reopenedAt: null }, { preparedAt: null }] },
        ],
      };
  }
}

export function isBusinessStage(v: unknown): v is BusinessStage {
  return typeof v === "string" && (Object.values(BUSINESS_STAGE) as string[]).includes(v);
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  المسؤولية الحالية — تُكمل قاعدة deriveOwnerRole بتحديد الشخص             */
/* ──────────────────────────────────────────────────────────────────────── */

export interface CurrentOwnerInfo {
  role: OwnerRole;
  roleLabel: string;
  userId: string | null;
  name: string;
}

export function deriveOwner(report: {
  status: string;
  preparedById?: string | null; preparedByName?: string | null;
  reviewedById?: string | null; reviewedByName?: string | null;
  approvedById?: string | null; approvedByName?: string | null;
}): CurrentOwnerInfo | null {
  const role = deriveOwnerRole(report.status);
  if (role === "PREPARER") {
    return { role, roleLabel: OWNER_ROLE_LABELS.PREPARER, userId: report.preparedById ?? null, name: report.preparedByName || "" };
  }
  if (role === "REVIEWER") {
    return { role, roleLabel: OWNER_ROLE_LABELS.REVIEWER, userId: report.reviewedById ?? null, name: report.reviewedByName || "" };
  }
  if (role === "APPROVER") {
    return { role, roleLabel: OWNER_ROLE_LABELS.APPROVER, userId: report.approvedById ?? null, name: report.approvedByName || "" };
  }
  return { role, roleLabel: OWNER_ROLE_LABELS.NONE, userId: null, name: "" };
}

/** ترجمة فلتر «المسؤول الحالي» إلى WHERE — مطابقة لـ deriveOwnerRole. */
export function ownerRoleToWhere(role: OwnerRole): Record<string, unknown> | null {
  switch (role) {
    case "PREPARER":
      return { AND: [{ status: { in: [WORKFLOW_STATUS.DRAFT, WORKFLOW_STATUS.RETURNED, WORKFLOW_STATUS.REOPENED] } }, { preparedById: { not: null } }] };
    case "REVIEWER":
      return { AND: [{ status: { in: [WORKFLOW_STATUS.SUBMITTED, WORKFLOW_STATUS.UNDER_REVIEW] } }, { reviewedById: { not: null } }] };
    case "APPROVER":
      return { AND: [{ status: WORKFLOW_STATUS.PENDING_APPROVAL }, { approvedById: { not: null } }] };
    case "NONE":
      return { status: WORKFLOW_STATUS.APPROVED };
  }
}

/** فلتر «المسؤول = أنا» — نفس دلالة deriveOwnerRole مع تقييد الشخص بالمستخدم الحالي. */
export function ownerMeToWhere(userId: string): Record<string, unknown> {
  return {
    OR: [
      { AND: [{ status: { in: [WORKFLOW_STATUS.DRAFT, WORKFLOW_STATUS.RETURNED, WORKFLOW_STATUS.REOPENED] } }, { preparedById: userId }] },
      { AND: [{ status: { in: [WORKFLOW_STATUS.SUBMITTED, WORKFLOW_STATUS.UNDER_REVIEW] } }, { reviewedById: userId }] },
      { AND: [{ status: WORKFLOW_STATUS.PENDING_APPROVAL }, { approvedById: userId }] },
    ],
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  المتأخر — علم متراكب (ليس حالة) — قرار D-3                                */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * overdue := dueDate ≠ null ∧ status ≠ APPROVED ∧ today > dueDate
 * الحد: dueDate = اليوم ⇒ ليس متأخرًا (يستحق اليوم) — التأخر يبدأ من اليوم التالي.
 * today يأتي من الخادم حصرًا (date-only بتوقيت الأعمال) — لا يُقبل توقيت العميل.
 */
export function computeOverdue(
  report: { dueDate: string | null; status: string },
  today: string
): { overdue: boolean; daysOverdue: number | null } {
  if (!report.dueDate) return { overdue: false, daysOverdue: null };
  if (report.status === WORKFLOW_STATUS.APPROVED) return { overdue: false, daysOverdue: null };
  const diff = calendarDaysBetween(report.dueDate, today); // today − dueDate
  if (diff <= 0) return { overdue: false, daysOverdue: null };
  return { overdue: true, daysOverdue: diff };
}

/** بناء WHERE للمتأخر بإدخال تاريخ اليوم من الخادم (مطابق لـ computeOverdue حرفيًا). */
export function buildOverdueWhere(mode: "true" | "false" | "none", today: string): Record<string, unknown> {
  if (mode === "none") return { dueDate: null };
  if (mode === "true") {
    return {
      AND: [
        { dueDate: { not: null } },
        { dueDate: { lt: today } },
        { status: { not: WORKFLOW_STATUS.APPROVED } },
      ],
    };
  }
  // false: كل ما عداه من ذوي dueDate (غير المتأخرين ممن لهم استحقاق)
  return {
    OR: [
      { dueDate: null },
      { dueDate: { gte: today } },
      { status: WORKFLOW_STATUS.APPROVED },
    ],
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  تعريفات البطاقات + الترتيب + الحجم                                        */
/* ──────────────────────────────────────────────────────────────────────── */

export interface KpiCardDef {
  key: string;
  label: string;
  /** نوع البطاقة: مرحلة حصرية | علم متراكب | إجمالي */
  kind: "total" | "stage" | "overlay";
  /** الفلتر الذي يطبقه النقر على البطاقة (تعريف خادمي ثابت) */
  filter: { stage?: BusinessStage; overdue?: "true"; cycleGt1?: boolean };
}

export const KPI_CARDS: KpiCardDef[] = [
  { key: "total", label: "إجمالي المطابقات", kind: "total", filter: {} },
  { key: "newDraft", label: "مسودة", kind: "stage", filter: { stage: BUSINESS_STAGE.NEW_DRAFT } },
  { key: "submitted", label: "بانتظار المراجعة", kind: "stage", filter: { stage: BUSINESS_STAGE.SUBMITTED } },
  { key: "underReview", label: "قيد المراجعة", kind: "stage", filter: { stage: BUSINESS_STAGE.UNDER_REVIEW } },
  { key: "returned", label: "معادة للتعديل", kind: "stage", filter: { stage: BUSINESS_STAGE.RETURNED } },
  { key: "pendingApproval", label: "بانتظار الاعتماد", kind: "stage", filter: { stage: BUSINESS_STAGE.PENDING_APPROVAL } },
  { key: "approved", label: "معتمدة", kind: "stage", filter: { stage: BUSINESS_STAGE.APPROVED } },
  { key: "reopenedAwaiting", label: "معاد فتحها", kind: "stage", filter: { stage: BUSINESS_STAGE.REOPENED } },
  { key: "overdue", label: "متأخرة", kind: "overlay", filter: { overdue: "true" } },
  { key: "everReopened", label: "أعيد فتحها بعد الاعتماد", kind: "overlay", filter: { cycleGt1: true } },
];

export const STAGE_ORDER: BusinessStage[] = [
  BUSINESS_STAGE.NEW_DRAFT,
  BUSINESS_STAGE.SUBMITTED,
  BUSINESS_STAGE.UNDER_REVIEW,
  BUSINESS_STAGE.RETURNED,
  BUSINESS_STAGE.PENDING_APPROVAL,
  BUSINESS_STAGE.REOPENED,
  BUSINESS_STAGE.APPROVED,
];

/** قائمة بيضاء لحقول الترتيب — خارجها 400 DASHBOARD_INVALID_PARAM */
export const SORT_WHITELIST = [
  "updatedAt", "name", "periodEnd", "dueDate", "cycle", "status",
  "preparedAt", "reviewStartedAt", "reviewedAt", "approvedAt",
] as const;
export type SortField = (typeof SORT_WHITELIST)[number];

export const PAGE_SIZES = [20, 50, 100] as const;

/* ──────────────────────────────────────────────────────────────────────── */
/*  نوع صف الجدول كما يعيده GET /api/dashboard/reconciliations                */
/* ──────────────────────────────────────────────────────────────────────── */

import type { WorkflowMyActions } from "@/lib/workflow";

export interface DashboardRow {
  id: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
  periodEnd: string | null;
  status: string;
  statusLabel: string;
  stage: BusinessStage;
  stageLabel: string;
  cycle: number;
  /** نسخة القفل التفاؤلي — للإجراءات عبر endpoint الانتقالات الحالي */
  version: number;
  preparedBy: { id: string; name: string } | null;
  reviewedBy: { id: string; name: string } | null;
  approvedBy: { id: string; name: string } | null;
  currentOwner: { role: OwnerRole; roleLabel: string; userId: string | null; name: string } | null;
  dueDate: string | null;
  overdue: boolean;
  daysOverdue: number | null;
  updatedAt: string | null;
  submittedAt: string | null;
  reviewStartedAt: string | null;
  reviewedAt: string | null;
  approvedAt: string | null;
  myActions: WorkflowMyActions;
}
