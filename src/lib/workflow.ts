// وحدة Workflow النقية — المرحلة 3.
// آمنة للاستيراد في العميل والخادم: لا تستورد أي شيء من الخادم (Prisma/db إلخ).
// هي مصدر الحقيقة الوحيد للحالات والتسميات ومصفوفة الانتقالات وقواعد فصل المهام.

/* ──────────────────────────────────────────────────────────────────────── */
/*  الحالات                                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

export const WORKFLOW_STATUS = {
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  RETURNED: "RETURNED",
  APPROVED: "APPROVED",
  REOPENED: "REOPENED",
} as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUS)[keyof typeof WORKFLOW_STATUS];

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  DRAFT: "مسودة",
  SUBMITTED: "مُرسَل للمراجعة",
  UNDER_REVIEW: "تحت المراجعة",
  RETURNED: "مُرجَع للتصحيح",
  APPROVED: "معتمد",
  REOPENED: "مُعاد فتحه",
};

/** أصناف شارة الحالة في الواجهة (Tailwind) — ألوان محايدة بلا أزرق/نيلي. */
export const WORKFLOW_STATUS_BADGE_CLASS: Record<WorkflowStatus, string> = {
  DRAFT: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  SUBMITTED: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400",
  UNDER_REVIEW: "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  RETURNED: "bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-400",
  APPROVED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400",
  REOPENED: "bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300",
};

/** الحالات التي يجوز فيها تعديل بيانات المطابقة (PUT) — للمعد المعيّن فقط. */
export const EDITABLE_STATUSES: WorkflowStatus[] = [
  WORKFLOW_STATUS.DRAFT,
  WORKFLOW_STATUS.RETURNED,
  WORKFLOW_STATUS.REOPENED,
];

export function isEditableStatus(status: string): boolean {
  return (EDITABLE_STATUSES as string[]).includes(status);
}

export function isWorkflowStatus(v: unknown): v is WorkflowStatus {
  return typeof v === "string" && (Object.values(WORKFLOW_STATUS) as string[]).includes(v);
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  أكواد أخطاء Workflow (structured responses)                              */
/* ──────────────────────────────────────────────────────────────────────── */

export const WORKFLOW_ERROR_CODES = {
  INVALID_TRANSITION: "INVALID_TRANSITION",
  NOT_ASSIGNED: "NOT_ASSIGNED",
  SEGREGATION_VIOLATION: "SEGREGATION_VIOLATION",
  REASON_REQUIRED: "REASON_REQUIRED",
  REVIEWER_NOT_ASSIGNED: "REVIEWER_NOT_ASSIGNED",
  REVIEW_NOT_STARTED: "REVIEW_NOT_STARTED",
  WORKFLOW_LOCKED: "WORKFLOW_LOCKED",
  FORBIDDEN: "FORBIDDEN",
  ASSIGNMENT_TARGET_INVALID: "ASSIGNMENT_TARGET_INVALID",
} as const;

export type WorkflowErrorCode =
  (typeof WORKFLOW_ERROR_CODES)[keyof typeof WORKFLOW_ERROR_CODES];

/* ──────────────────────────────────────────────────────────────────────── */
/*  إجراءات الانتقال + أحداث التاريخ                                         */
/* ──────────────────────────────────────────────────────────────────────── */

export const WORKFLOW_ACTION = {
  SUBMIT: "SUBMIT",
  START_REVIEW: "START_REVIEW",
  RETURN: "RETURN",
  APPROVE: "APPROVE",
  REOPEN: "REOPEN",
  RESUME_EDIT: "RESUME_EDIT",
} as const;

export type WorkflowAction = (typeof WORKFLOW_ACTION)[keyof typeof WORKFLOW_ACTION];

/** أحداث WorkflowHistory (append-only) */
export const WORKFLOW_HISTORY_ACTION = {
  CREATED: "CREATED",
  SUBMITTED: "SUBMITTED",
  RESUBMITTED: "RESUBMITTED",
  REVIEW_STARTED: "REVIEW_STARTED",
  RETURNED: "RETURNED",
  APPROVED: "APPROVED",
  REOPENED: "REOPENED",
  RESUMED_EDIT: "RESUMED_EDIT",
  ASSIGNMENT_CHANGED: "ASSIGNMENT_CHANGED",
} as const;

export type WorkflowHistoryAction =
  (typeof WORKFLOW_HISTORY_ACTION)[keyof typeof WORKFLOW_HISTORY_ACTION];

export const WORKFLOW_HISTORY_ACTION_LABELS: Record<WorkflowHistoryAction, string> = {
  CREATED: "إنشاء التقرير",
  SUBMITTED: "إرسال للمراجعة",
  RESUBMITTED: "إعادة إرسال بعد التصحيح",
  REVIEW_STARTED: "بدء المراجعة",
  RETURNED: "إرجاع للتصحيح",
  APPROVED: "اعتماد",
  REOPENED: "إعادة فتح",
  RESUMED_EDIT: "استئناف التعديل",
  ASSIGNMENT_CHANGED: "تغيير الإسناد",
};

/* ──────────────────────────────────────────────────────────────────────── */
/*  مصفوفة الانتقالات — لا قفز مباشر بين الحالات إطلاقًا                     */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * الانتقالات المسموحة: من الحالة → الإجراء → الحالة الهدف.
 * SUBMIT يتطلب مراجعًا معيّنًا (يفحصه الخادم قبل التنفيذ).
 * RETURN و REOPEN يتطلبان سببًا إلزاميًا (يفحصه الخادم).
 */
export const TRANSITIONS: Record<WorkflowStatus, Partial<Record<WorkflowAction, WorkflowStatus>>> = {
  [WORKFLOW_STATUS.DRAFT]: {
    [WORKFLOW_ACTION.SUBMIT]: WORKFLOW_STATUS.SUBMITTED,
  },
  [WORKFLOW_STATUS.SUBMITTED]: {
    [WORKFLOW_ACTION.START_REVIEW]: WORKFLOW_STATUS.UNDER_REVIEW,
  },
  [WORKFLOW_STATUS.UNDER_REVIEW]: {
    [WORKFLOW_ACTION.RETURN]: WORKFLOW_STATUS.RETURNED,
    [WORKFLOW_ACTION.APPROVE]: WORKFLOW_STATUS.APPROVED,
  },
  [WORKFLOW_STATUS.RETURNED]: {
    [WORKFLOW_ACTION.RESUME_EDIT]: WORKFLOW_STATUS.DRAFT,
  },
  [WORKFLOW_STATUS.APPROVED]: {
    [WORKFLOW_ACTION.REOPEN]: WORKFLOW_STATUS.REOPENED,
  },
  [WORKFLOW_STATUS.REOPENED]: {
    [WORKFLOW_ACTION.RESUME_EDIT]: WORKFLOW_STATUS.DRAFT,
  },
};

/** الحالة الهدف للانتقال، أو null إذا كان الانتقال ممنوعًا (قفزة مباشرة). */
export function transitionTarget(from: string, action: WorkflowAction): WorkflowStatus | null {
  if (!isWorkflowStatus(from)) return null;
  return TRANSITIONS[from]?.[action] ?? null;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  فصل المهام (Segregation of Duties) — بلا أي استثناء في هذه المرحلة       */
/* ──────────────────────────────────────────────────────────────────────── */

export interface SoDTrio {
  preparedById?: string | null;
  reviewedById?: string | null;
  approvedById?: string | null;
}

export interface SoDViolation {
  roles: [string, string]; // مثال: ["prepared", "reviewer"]
  userId: string;
}

const SOD_PAIRS: Array<[keyof SoDTrio, keyof SoDTrio, string, string]> = [
  ["preparedById", "reviewedById", "prepared", "reviewer"],
  ["preparedById", "approvedById", "prepared", "approver"],
  ["reviewedById", "approvedById", "reviewer", "approver"],
];

/**
 * فحص فصل المهام على ثلاثية الأدوار (تُهمل القيم الفارغة).
 * يعيد قائمة التناقضات — فارغة = سليم.
 */
export function validateSoD(trio: SoDTrio): SoDViolation[] {
  const violations: SoDViolation[] = [];
  for (const [a, b, la, lb] of SOD_PAIRS) {
    const va = trio[a];
    const vb = trio[b];
    if (va && vb && va === vb) {
      violations.push({ roles: [la, lb], userId: va });
    }
  }
  return violations;
}

/** رسالة عربية جاهزة لأول تناقض — للاستخدام في الـ API والواجهة. */
export function SoDViolationMessage(violations: SoDViolation[]): string {
  const roleNames: Record<string, string> = {
    prepared: "المعدّ",
    reviewer: "المراجع",
    approver: "المعتمد",
  };
  const v = violations[0];
  if (!v) return "";
  return `فصل المهام: لا يجوز أن يكون ${roleNames[v.roles[0]]} و${roleNames[v.roles[1]]} نفس الشخص في نفس الدورة.`;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  periodEnd — مفهوم أعمال date-only بلا timezone                           */
/* ──────────────────────────────────────────────────────────────────────── */

/** نمط تاريخ فقط "YYYY-MM-DD" — يمنع تحول 31/12 إلى 30/12 أو 01/01 عند العرض. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateOnly(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_ONLY_RE.test(v)) return false;
  // فحص تاريخ صالح فعليًا (مثلاً 2026-02-30 مرفوض)
  const [y, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** تطابق قيمة periodEnd قادمة من العميل — يميز "غير مُرسَل" عن "غير صالح". */
export function normalizePeriodEndStrict(v: unknown): { value: string | null | undefined; invalid: boolean } {
  if (v === undefined) return { value: undefined, invalid: false }; // غير مُرسَل
  if (v === null || v === "") return { value: null, invalid: false }; // إفراغ صريح
  if (isValidDateOnly(v)) return { value: v, invalid: false };
  // يقبل "YYYY/MM/DD" أو "YYYY-MM-DDTHH:..." ويقتطع أول 10 أحرف إن كانت تاريخًا صالحًا
  if (typeof v === "string" && v.length >= 10) {
    const head = v.slice(0, 10).replace(/\//g, "-");
    if (isValidDateOnly(head)) return { value: head, invalid: false };
  }
  return { value: undefined, invalid: true }; // غير صالح
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  حساب الإجراءات المسموحة للمستخدم الحالي (myActions)                       */
/* ──────────────────────────────────────────────────────────────────────── */

export interface WorkflowReportSnapshot {
  status: string;
  cycle: number;
  preparedById: string | null;
  reviewedById: string | null;
  approvedById: string | null;
  reviewedAt: string | Date | null;
  // للعرض فقط
  preparedByName?: string;
  preparedAt?: string | Date | null;
  reviewedByName?: string;
  approvedByName?: string;
  approvedAt?: string | Date | null;
  returnedById?: string | null;
  returnedByName?: string;
  returnedAt?: string | Date | null;
  returnReason?: string;
  reopenedById?: string | null;
  reopenedByName?: string;
  reopenedAt?: string | Date | null;
  reopenReason?: string;
  periodEnd?: string | null;
}

export interface WorkflowUserContext {
  id: string;
  role: string;
  permissions: {
    edit?: boolean;
    view?: boolean;
    assignWorkflow?: boolean;
    reopenReport?: boolean;
    groupIds?: string[];
  };
  /** عضوية المجموعات المرتبطة تُحسب خارجيًا إن لزم — هنا نمرر نتيجة الفحص */
  isLinkedToReportGroup?: boolean;
  isOwner?: boolean;
}

export interface WorkflowMyActions {
  canView: boolean;
  canEdit: boolean;
  canSubmit: boolean;
  canStartReview: boolean;
  canReturn: boolean;
  canApprove: boolean;
  canReopen: boolean;
  canResume: boolean;
  canAssign: boolean;
  canDelete: boolean;
  isParticipant: boolean;
}

/**
 * الإجراءات المسموحة للمستخدم الحالي على التقرير — تُحسب في الخادم وتعرض في الواجهة كما هي.
 * القواعد:
 *  - التعديل: المعد المعيّن + صلاحية edit نظامية + حالة قابلة للتعديل.
 *  - المدير لا يتجاوز SoD ولا قفل APPROVED ولا يصبح تلقائيًا مراجعًا/معتمدًا؛
 *    صلاحياته الإدارية: الإسناد + REOPEN + القراءة + الإدارة.
 *  - REVIEW/APPROVE تتطلب إسنادًا فعليًا حتى للمدير.
 */
export function computeMyActions(
  report: WorkflowReportSnapshot,
  user: WorkflowUserContext
): WorkflowMyActions {
  const status = report.status;
  const isAdmin = user.role === "admin";
  const canAssign = isAdmin || user.permissions.assignWorkflow === true;
  const canReopenPerm = isAdmin || user.permissions.reopenReport === true;

  const isPreparer = !!report.preparedById && report.preparedById === user.id;
  const isReviewer = !!report.reviewedById && report.reviewedById === user.id;
  const isApprover = !!report.approvedById && report.approvedById === user.id;
  const isParticipant = isPreparer || isReviewer || isApprover;

  const canView =
    isAdmin ||
    user.isOwner === true ||
    isParticipant ||
    user.isLinkedToReportGroup === true ||
    user.permissions.view === true; // الوصول العام للقراءة يبقى وفق صلاحية view كما في بقية النظام

  const canEdit =
    isPreparer &&
    user.permissions.edit === true &&
    isEditableStatus(status);

  return {
    canView,
    canEdit,
    canSubmit: isPreparer && status === WORKFLOW_STATUS.DRAFT && !!report.reviewedById,
    canStartReview: isReviewer && status === WORKFLOW_STATUS.SUBMITTED,
    canReturn: isReviewer && status === WORKFLOW_STATUS.UNDER_REVIEW,
    canApprove:
      isApprover &&
      status === WORKFLOW_STATUS.UNDER_REVIEW &&
      !!report.reviewedAt, // المراجعة بدأت بصورة صحيحة
    canReopen: canReopenPerm && status === WORKFLOW_STATUS.APPROVED,
    canResume: isPreparer && (status === WORKFLOW_STATUS.RETURNED || status === WORKFLOW_STATUS.REOPENED),
    canAssign,
    canDelete: user.isOwner === true && user.permissions.delete === true && status === WORKFLOW_STATUS.DRAFT,
    isParticipant,
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  أنواع استجابة workflow للواجهة (متوافقة مع buildWorkflowInfo خادميًا)     */
/* ──────────────────────────────────────────────────────────────────────── */

export interface WorkflowActorInfo {
  id: string | null;
  name: string;
  at: string | null;
}

export interface WorkflowInfo {
  status: string;
  statusLabel: string;
  cycle: number;
  periodEnd: string | null;
  preparedBy: WorkflowActorInfo | null;
  reviewedBy: WorkflowActorInfo | null;
  approvedBy: WorkflowActorInfo | null;
  returned: { by: string; byName: string; at: string | null; reason: string } | null;
  reopened: { by: string; byName: string; at: string | null; reason: string } | null;
  myActions: WorkflowMyActions;
}

/** صف سجل الدورات كما يعيده GET /api/reports/[id]/workflow-history */
export interface WorkflowHistoryRow {
  id: string;
  reportId: string;
  cycle: number;
  action: string;
  fromStatus: string;
  toStatus: string;
  actorId: string | null;
  actorUsername: string;
  reason: string;
  comment: string;
  roleSnapshot: string;
  createdAt: string;
}

/** مرشح الإسناد كما يعيده GET /api/users?for=assignment (الحد الأدنى فقط) */
export interface AssignmentCandidate {
  id: string;
  username: string;
  displayName: string;
  active: boolean;
}

/** تنسيق تاريخ/وقت للعرض في الواجهة (نص ISO → محلي) — بلا تأثير على التخزين. */
export function fmtWorkflowDateTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  try {
    const d = typeof v === "string" ? new Date(v) : v;
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("ar", {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

/** تسمية عربية للدور في التقرير. */
export function workflowRoleLabel(role: "prepared" | "reviewed" | "approved" | "returned" | "reopened"): string {
  switch (role) {
    case "prepared": return "المعدّ";
    case "reviewed": return "المراجع";
    case "approved": return "المعتمد";
    case "returned": return "المُرجِع";
    case "reopened": return "مُعيد الفتح";
  }
}
