// المرحلة 3.5B — مساعدات لوحة المتابعة الخادمية.
// مصدر رؤية واحد: buildDashboardVisibility تُستخدم في endpoints الثلاثة
// (summary / reconciliations / facets) حرفيًا — أي رقم أو صف في اللوحة هو
// نتاج نفس شرط الرؤية المطبق في GET /api/reports (لا أكثر ولا أقل).
// كل الفلاتر تُترجم إلى WHERE خادمي فوق الرؤية — لا يمكن لأي فلتر توسيعها.

import { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/session";
import {
  SORT_WHITELIST,
  PAGE_SIZES,
  buildOverdueWhere,
  isBusinessStage,
  ownerMeToWhere,
  ownerRoleToWhere,
  stageToWhere,
  type BusinessStage,
  type SortField,
} from "@/lib/reconciliation";
import {
  isValidDateOnly,
  isWorkflowStatus,
  normalizeDueDateStrict,
  OWNER_ROLE,
  WORKFLOW_STATUS,
  type OwnerRole,
} from "@/lib/workflow";

export type ReportVisibilityWhere = Prisma.ReportWhereInput;

/**
 * شرط الرؤية الأم — نفس حشو baseVisibility في GET /api/reports:
 * المدير الكل | المالك | مجموعة مرتبطة | مشارك أدوار (معد/مراجع/معتمد).
 */
export function buildDashboardVisibility(user: SessionUser): ReportVisibilityWhere {
  if (user.role === "admin") return {};
  const linkedGroupIds = Array.isArray(user.permissions.groupIds)
    ? user.permissions.groupIds
    : [];
  return {
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
}

/** فلاتر النطاق (تؤثر على البطاقات أيضًا): المجموعة والفترة. */
export interface ScopeParams {
  groupId?: string[]; // CSV — مقيدة برؤية المستخدم داخل WHERE
  period?: string[]; // date-only أو "none" لبدون فترة
}

export class DashboardParamError extends Error {
  code = "DASHBOARD_INVALID_PARAM";
  constructor(message: string) {
    super(message);
    this.name = "DashboardParamError";
  }
}

function csv(raw: string | null): string[] | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return parts.length ? parts : undefined;
}

/** تحليل فلاتر النطاق مع التحقق الصارم (كل قيمة غير صالحة ⇒ 400). */
export function parseScopeParams(searchParams: URLSearchParams): ScopeParams {
  const groupId = csv(searchParams.get("groupId"));
  const periodRaw = csv(searchParams.get("period"));
  let period: string[] | undefined;
  if (periodRaw) {
    for (const p of periodRaw) {
      if (p === "none") continue;
      // نفس قواعد date-only الصارمة — تاريخ مرفوض الأصل مرفوض هنا حتى لو صحّت صيغته النصية
      if (!isValidDateOnly(p)) {
        throw new DashboardParamError(`قيمة فترة غير صالحة: ${p}`);
      }
    }
    period = periodRaw;
  }
  return { groupId, period };
}

/** WHERE لفلاتر النطاق (تُستخدم في summary وfacets معًا). */
export function scopeToWhere(scope: ScopeParams): Prisma.ReportWhereInput {
  const parts: Prisma.ReportWhereInput[] = [];
  if (scope.groupId?.length) parts.push({ groupId: { in: scope.groupId } });
  if (scope.period?.length) {
    const hasNone = scope.period.includes("none");
    const dates = scope.period.filter((p) => p !== "none");
    const or: Prisma.ReportWhereInput[] = [];
    if (dates.length) or.push({ periodEnd: { in: dates } });
    if (hasNone) or.push({ periodEnd: null });
    parts.push(or.length === 1 ? or[0] : { OR: or });
  }
  return parts.length ? { AND: parts } : {};
}

/** كل فلاتر الجدول — كلها اختيارية وتُترجم إلى WHERE فوق الرؤية. */
export interface ListFilters extends ScopeParams {
  q?: string;
  status?: string[];
  stage?: BusinessStage[];
  preparedById?: string;
  reviewedById?: string;
  approvedById?: string;
  ownerRole?: OwnerRole;
  ownerMe?: boolean;
  overdue?: "true" | "false" | "none";
  cycle?: { eq?: number; gt1?: boolean };
  sort: SortField;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
}

export function parseListParams(searchParams: URLSearchParams): ListFilters {
  const scope = parseScopeParams(searchParams);

  const q = searchParams.get("q");
  if (q && q.length > 200) throw new DashboardParamError("بحث الاسم طويل جدًا");

  const status = csv(searchParams.get("status"));
  if (status) {
    for (const s of status) {
      if (!isWorkflowStatus(s)) throw new DashboardParamError(`حالة workflow غير معروفة: ${s}`);
    }
  }

  const stageRaw = csv(searchParams.get("stage"));
  if (stageRaw) {
    for (const s of stageRaw) {
      if (!isBusinessStage(s)) throw new DashboardParamError(`مرحلة أعمال غير معروفة: ${s}`);
    }
  }

  const idParam = (key: string): string | undefined => {
    const v = searchParams.get(key);
    if (v === null || v === "") return undefined;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(v)) throw new DashboardParamError(`قيمة ${key} غير صالحة`);
    return v;
  };

  const ownerRoleRaw = searchParams.get("ownerRole");
  let ownerRole: OwnerRole | undefined;
  if (ownerRoleRaw) {
    const values = Object.values(OWNER_ROLE) as string[];
    if (!values.includes(ownerRoleRaw)) throw new DashboardParamError(`ownerRole غير صالح: ${ownerRoleRaw}`);
    ownerRole = ownerRoleRaw as OwnerRole;
  }

  const ownerMe = (() => {
    const v = searchParams.get("ownerMe");
    if (v === null) return undefined;
    if (v !== "true" && v !== "false") throw new DashboardParamError("ownerMe يقبل true|false فقط");
    return v === "true";
  })();

  const overdueRaw = searchParams.get("overdue");
  let overdue: "true" | "false" | "none" | undefined;
  if (overdueRaw) {
    if (overdueRaw !== "true" && overdueRaw !== "false" && overdueRaw !== "none") {
      throw new DashboardParamError("overdue يقبل true|false|none فقط");
    }
    overdue = overdueRaw;
  }

  const cycleRaw = searchParams.get("cycle");
  let cycle: { eq?: number; gt1?: boolean } | undefined;
  if (cycleRaw) {
    if (cycleRaw === ">1") cycle = { gt1: true };
    else {
      const n = Number(cycleRaw);
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new DashboardParamError("cycle يجب أن يكون عددًا صحيحًا ≥ 1 أو >1");
      cycle = { eq: n };
    }
  }

  const sortRaw = searchParams.get("sort");
  let sort: SortField = "updatedAt";
  if (sortRaw) {
    if (!(SORT_WHITELIST as readonly string[]).includes(sortRaw)) {
      throw new DashboardParamError(`sort غير مسموح: ${sortRaw}`);
    }
    sort = sortRaw as SortField;
  }

  const dirRaw = searchParams.get("dir");
  let dir: "asc" | "desc" = "desc";
  if (dirRaw) {
    if (dirRaw !== "asc" && dirRaw !== "desc") throw new DashboardParamError("dir يقبل asc|desc فقط");
    dir = dirRaw;
  }

  const pageRaw = searchParams.get("page");
  let page = 1;
  if (pageRaw !== null) {
    const n = Number(pageRaw);
    if (!Number.isInteger(n) || n < 1 || n > 100000) throw new DashboardParamError("page يجب أن يكون عددًا صحيحًا ≥ 1");
    page = n;
  }

  const sizeRaw = searchParams.get("pageSize");
  let pageSize: number = 20;
  if (sizeRaw !== null) {
    const n = Number(sizeRaw);
    if (!(PAGE_SIZES as readonly number[]).includes(n)) {
      throw new DashboardParamError(`pageSize مسموح فقط بالقيم: ${PAGE_SIZES.join(", ")}`);
    }
    pageSize = n;
  }

  return {
    ...scope,
    q: q ?? undefined,
    status,
    stage: stageRaw as BusinessStage[] | undefined,
    preparedById: idParam("preparedById"),
    reviewedById: idParam("reviewedById"),
    approvedById: idParam("approvedById"),
    ownerRole,
    ownerMe,
    overdue,
    cycle,
    sort,
    dir,
    page,
    pageSize,
  };
}

/**
 * بناء WHERE الكامل: الرؤية أولًا كشرط أساس ثم الفلاتر فوقها (AND) —
 * نفس دوال الاشتقاق النقية المستخدمة في البطاقات وقيم الصفوف.
 *
 * qIds: عندما يحوي البحث رموز LIKE خاصة (% أو _ أو \) تُحل المعرّفات المطابقة
 * حرفيًا في الroute عبر SQL مع ESCAPE — هنا تُحقن كفلتر معرفات (Prisma contains
 * لا يهرب رموز LIKE في SQLite — فتُعامل كبدل وليس حرفًا). غير معرف ⇒ بحث عادي.
 */
export function buildListWhere(
  user: SessionUser,
  f: ListFilters,
  today: string,
  qIds?: string[]
): Prisma.ReportWhereInput {
  const parts: Prisma.ReportWhereInput[] = [buildDashboardVisibility(user)];

  parts.push(scopeToWhere(f));

  if (qIds !== undefined) {
    parts.push({ id: { in: qIds.length > 0 ? qIds : ["__no_match__"] } });
  } else if (f.q) {
    // مسار لا يحوي رموز LIKE — contains عادي
    parts.push({ name: { contains: f.q } });
  }
  if (f.status?.length) parts.push({ status: { in: f.status } });
  if (f.stage?.length) {
    parts.push(f.stage.length === 1 ? (stageToWhere(f.stage[0]) as Prisma.ReportWhereInput) : { OR: f.stage.map((s) => stageToWhere(s) as Prisma.ReportWhereInput) });
  }
  if (f.preparedById) parts.push({ preparedById: f.preparedById });
  if (f.reviewedById) parts.push({ reviewedById: f.reviewedById });
  if (f.approvedById) parts.push({ approvedById: f.approvedById });
  if (f.ownerRole) parts.push(ownerRoleToWhere(f.ownerRole) as Prisma.ReportWhereInput);
  if (f.ownerMe === true) parts.push(ownerMeToWhere(user.id) as Prisma.ReportWhereInput);
  if (f.overdue) parts.push(buildOverdueWhere(f.overdue, today) as Prisma.ReportWhereInput);
  if (f.cycle) {
    if (f.cycle.gt1) parts.push({ cycle: { gt: 1 } });
    else if (f.cycle.eq !== undefined) parts.push({ cycle: f.cycle.eq });
  }

  return { AND: parts };
}
