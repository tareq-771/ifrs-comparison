// Phase 6.1 — إدارة صلاحيات الشركات (fail-closed) — وحدة خادمية.
//
// القاعدة الحاكمة (قرار المستخدم 6.0A حرفيًا):
//   - companyIds مفقود أو [] = لا وصول لأي شركة (fail-closed).
//   - viewAllCompanies=true = وصول صريح لكل الشركات (لا يُستنتج أبدًا من قائمة فارغة).
//   - المدير (role=admin) يُحلّ إلى كل الشركات كقاعدة تفويض موثقة صريحة هنا —
//     وليس كسلوك جانبي لقائمة فارغة.
//
// ⚠️ التوافق الانتقالي: رؤية التقارير القديمة (legacy) لم تتغير إطلاقًا —
//    هذه الوحدة تحكم الكيانات الجديدة المرتبطة بالشركات فقط (انظر report-visibility.ts).

import type { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/session";
import type { Permissions } from "@/lib/permissions";

export type CompanyScope =
  | { mode: "ALL"; reason: "ADMIN_ROLE" | "EXPLICIT_FLAG" }
  | { mode: "LIST"; companyIds: string[] }
  | { mode: "NONE"; reason: "EMPTY_OR_MISSING_COMPANY_IDS" };

/** تنظيف قائمة معرفات الشركات — إزالة التكرار والقيم الفارغة وغير النصية. */
function cleanIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.length > 0 && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * حلّ نطاق رؤية الشركات للمستخدم — fail-closed:
 *   admin ⇒ ALL (قاعدة تفويض موثقة)، viewAllCompanies ⇒ ALL صريح،
 *   وإلا LIST بقائمة غير فارغة أو NONE (لا وصول).
 */
export function resolveCompanyScope(user: {
  role: string;
  permissions: Pick<Permissions, "companyIds" | "viewAllCompanies">;
}): CompanyScope {
  if (user.role === "admin") return { mode: "ALL", reason: "ADMIN_ROLE" };
  if (user.permissions.viewAllCompanies === true) return { mode: "ALL", reason: "EXPLICIT_FLAG" };
  const ids = cleanIdList(user.permissions.companyIds);
  if (ids.length === 0) return { mode: "NONE", reason: "EMPTY_OR_MISSING_COMPANY_IDS" };
  return { mode: "LIST", companyIds: ids };
}

/** هل يرى المستخدم شركة بعينها؟ (قراءة/عرض — الإبطال لا يُخفي التاريخ) */
export function companyVisible(
  user: { role: string; permissions: Pick<Permissions, "companyIds" | "viewAllCompanies"> },
  companyId: string
): boolean {
  const scope = resolveCompanyScope(user);
  if (scope.mode === "ALL") return true;
  if (scope.mode === "NONE") return false;
  return scope.companyIds.includes(companyId);
}

/**
 * شرط Prisma لرؤية الشركات — يُدمج في كل استعلام شركة/سنة/فترة/سياسة خادمي.
 * NONE ⇒ شرط مستحيل الدلالة (لا تسرّب أي صف) — ليس شرطًا فارغًا أبدًا.
 */
export function buildCompanyVisibilityWhere(user: {
  role: string;
  permissions: Pick<Permissions, "companyIds" | "viewAllCompanies">;
}): Prisma.CompanyWhereInput {
  const scope = resolveCompanyScope(user);
  if (scope.mode === "ALL") return {};
  if (scope.mode === "NONE") return { id: { in: [] } }; // مستحيل عمدًا — fail-closed
  return { id: { in: scope.companyIds } };
}

/** شرط رؤية على جدول يحمل companyId (FiscalYear/FiscalPeriod عبر ربط متداخل). */
export function buildCompanyScopedWhere(
  user: { role: string; permissions: Pick<Permissions, "companyIds" | "viewAllCompanies"> },
  companyField: "companyId" | "fiscalYear" | "company"
): Record<string, unknown> {
  const scope = resolveCompanyScope(user);
  if (scope.mode === "ALL") return {};
  if (scope.mode === "NONE") {
    return companyField === "companyId"
      ? { companyId: { in: [] } }
      : { [companyField]: { id: { in: [] } } };
  }
  return companyField === "companyId"
    ? { companyId: { in: scope.companyIds } }
    : { [companyField]: { id: { in: scope.companyIds } } };
}

/** رموز رفض موحدة للمسارات الخادمية. */
export const COMPANY_ACCESS_ERRORS = {
  NOT_FOUND: "الشركة غير موجودة",
  FORBIDDEN: "لا تملك صلاحية الوصول لهذه الشركة",
} as const;
