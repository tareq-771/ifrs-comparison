// Phase 6.1 — توحيد شرط رؤية التقارير (المصدر الواحد الخادمي).
//
// المشكلة المعالجة: كان شرط الرؤية (مالك/مجموعة مرتبطة/مشارك أدوار/مدير) مكررًا
// في GET /api/reports وbuildDashboardVisibility وcanViewReportRow — ثلاثة مواضع
// قد تتباعد. الآن كلها تنتج من هذه الوحدة حرفيًا.
//
// قاعدة التوافق الانتقالي (تعليمات 6.1 §15 — حرفيًا):
//   - رؤية التقارير القديمة (legacy) تظل كما هي حرفيًا: المدير | المالك |
//     مجموعة مرتبطة (permissions.groupIds) | مشارك أدوار (معد/مراجع/معتمد).
//   - رؤية الشركات الجديدة (fail-closed عبر company-access.ts) تحكم الكيانات
//     المرتبطة بالشركات (شركة/سنة/فترة/سياسة) فقط — لا تستبدل رؤية التقارير.
//   - التقارير المربوطة بشركة (backfill) تبقى خاضعة لشرط legacy نفسه؛ فلتر
//     companyId الاختياري في GET /api/reports يشترط الوفاق: رؤية legacy ∧ رؤية
//     الشركة (فشل مغلق — لا توسيع).

import { Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/session";
import { companyVisible } from "@/lib/company-access";

export type ReportVisibilityWhere = Prisma.ReportWhereInput;

export interface ReportRowForVisibility {
  userId: string | null;
  groupId: string | null;
  preparedById: string | null;
  reviewedById: string | null;
  approvedById: string | null;
}

/** معرفات المجموعات المرتبطة الفعالة (نفس دلالة القديم حرفيًا). */
function linkedGroupIdsOf(user: SessionUser): string[] {
  return Array.isArray(user.permissions.groupIds) ? user.permissions.groupIds : [];
}

/**
 * شرط الرؤية الأم للتقارير (legacy — سلوك المراحل 2/3/3.5 كما هو بلا أي تغيير):
 *   المدير الكل | المالك | مجموعة مرتبطة | مشارك أدوار.
 */
export function buildLegacyReportVisibilityWhere(user: SessionUser): ReportVisibilityWhere {
  if (user.role === "admin") return {};
  const linkedGroupIds = linkedGroupIdsOf(user);
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

/** الفحص الصفي المكافئ لشرط أعلاه (للمسارات التي تقرأ صفًا واحدًا). */
export function canViewLegacyReportRow(report: ReportRowForVisibility, user: SessionUser): boolean {
  if (user.role === "admin") return true;
  if (report.userId === user.id) return true;
  const linked = linkedGroupIdsOf(user);
  if (report.groupId !== null && linked.includes(report.groupId)) return true;
  return (
    report.preparedById === user.id ||
    report.reviewedById === user.id ||
    report.approvedById === user.id
  );
}

/**
 * فلتر الشركة الاختياري (6.1): يُدمج فقط عند تمرير companyId صريح، ويشترط
 * رؤية الشركة fail-closed — طلب تقارير شركة غير مرئية ⇒ رفض هنا (لا صفوف).
 * التقارير غير المربوطة بشركة تبقى خارجة عن هذا الفلتر تمامًا.
 */
export function companyFilterToWhere(
  user: SessionUser,
  companyId: string
): { ok: true; where: ReportVisibilityWhere } | { ok: false; reason: "COMPANY_NOT_VISIBLE" } {
  if (!companyVisible(user, companyId)) return { ok: false, reason: "COMPANY_NOT_VISIBLE" };
  return { ok: true, where: { companyId } };
}
