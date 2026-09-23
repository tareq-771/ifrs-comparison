// Phase 6.1 — كيان الشركة: الثوابت والتحقق وقواعد دورة الحياة (خادم + نقيات مشتركة).
//
// قرارات التصميم 6.0A المطبقة هنا:
//   - الهوية الآلية = code وحيد — الأسماء المعروضة ليست مفاتيح هوية.
//   - دورة الحياة: ACTIVE/INACTIVE — الإبطال يحفظ الرؤية التاريخية ولا يمس أي بيانات.
//   - الحذف الصلب: شركة غير مستخدمة تمامًا فقط — ووجود أي سجل ربط legacy
//     (legacyGroupId) يمنع الحذف حفاظًا على استقرار إعادة تشغيل أداة الربط.
//   - العملات عبر currencies.ts (ISO-4217-ready) — بلا تحويل/ترجمة/توحيد.

import { db } from "@/lib/db";
import { validateCurrencyCode, deriveReportingCurrency, CURRENCIES } from "@/lib/currencies";

export const COMPANY_STATUS = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
} as const;

export type CompanyStatus = (typeof COMPANY_STATUS)[keyof typeof COMPANY_STATUS];

export function isCompanyStatus(v: unknown): v is CompanyStatus {
  return v === COMPANY_STATUS.ACTIVE || v === COMPANY_STATUS.INACTIVE;
}

export const COMPANY_STATUS_LABELS: Record<CompanyStatus, string> = {
  ACTIVE: "نشطة",
  INACTIVE: "موقوفة",
};

/** انتقالات الحالة المسموحة: تفعيل/إبطال في الاتجاهين — بلا حذف ضمني. */
export const COMPANY_STATUS_TRANSITIONS: Record<CompanyStatus, CompanyStatus[]> = {
  ACTIVE: [COMPANY_STATUS.INACTIVE],
  INACTIVE: [COMPANY_STATUS.ACTIVE],
};

export class CompanyValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CompanyValidationError";
    this.code = code;
  }
}

/** صيغة الكود: 2..40 حرفًا/رقمًا/شرطة/شرطة سفلية — هوية آلية مستقرة. */
const CODE_RE = /^[A-Za-z0-9_-]{2,40}$/;

export function validateCompanyCode(raw: unknown): string {
  const code = typeof raw === "string" ? raw.trim() : "";
  if (!CODE_RE.test(code)) {
    throw new CompanyValidationError(
      "COMPANY_CODE_INVALID",
      "كود الشركة إلزامي — 2..40 حرفًا/رقمًا/شرطة (لاتيني) وهو وحيد في النظام."
    );
  }
  return code;
}

export interface CompanyInput {
  code?: unknown;
  nameAr?: unknown;
  nameEn?: unknown;
  functionalCurrency?: unknown;
  reportingCurrency?: unknown;
  notes?: unknown;
}

/** تطبيع حقول الإنشاء/التعديل مع تحقق صارم (رموز أخطاء موثقة للمسارات الخادمية). */
export function normalizeCompanyInput(input: CompanyInput): {
  code?: string;
  nameAr?: string;
  nameEn?: string;
  functionalCurrency?: string;
  reportingCurrency?: string;
  notes?: string;
} {
  const out: ReturnType<typeof normalizeCompanyInput> = {};
  if (input.code !== undefined) out.code = validateCompanyCode(input.code);

  if (input.nameAr !== undefined) {
    const nameAr = typeof input.nameAr === "string" ? input.nameAr.trim() : "";
    if (nameAr.length < 2 || nameAr.length > 200) {
      throw new CompanyValidationError(
        "COMPANY_NAME_REQUIRED",
        "الاسم العربي للشركة إلزامي (2..200 حرفًا) وهو الاسم المعروض — الهوية الآلية هي الكود."
      );
    }
    out.nameAr = nameAr;
  }
  if (input.nameEn !== undefined) {
    out.nameEn = typeof input.nameEn === "string" ? input.nameEn.trim().slice(0, 200) : "";
  }
  if (input.notes !== undefined) {
    out.notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 2000) : "";
  }

  // العملات: إفراغ صريح "" = غير محددة بعد (مسموح حتى أول استخدام مالي)؛
  // قيمة موجبة يجب أن تكون ISO مدعومة.
  if (input.functionalCurrency !== undefined) {
    const raw = typeof input.functionalCurrency === "string" ? input.functionalCurrency.trim().toUpperCase() : "";
    if (raw === "") {
      out.functionalCurrency = "";
      // إفراغ الوظيفية يفرغ الاشتقاق أيضًا (لا تبقى إبلاغ بلا وظيفية)
      if (input.reportingCurrency === undefined) out.reportingCurrency = "";
    } else {
      const v = validateCurrencyCode(raw);
      if (!v.ok) {
        throw new CompanyValidationError(
          "CURRENCY_UNKNOWN",
          `العملة الوظيفية غير مدعومة — السجل يدعم أكواد ISO-4217 المسجلة (${Object.keys(CURRENCIES).join(", ")}).`
        );
      }
      out.functionalCurrency = v.code;
    }
  }
  if (input.reportingCurrency !== undefined) {
    const raw = typeof input.reportingCurrency === "string" ? input.reportingCurrency.trim().toUpperCase() : "";
    if (raw === "") {
      // الإفراغ الصريح يرجع للاشتقاق من الوظيفية إن وُجدت
      const fn = out.functionalCurrency;
      out.reportingCurrency = deriveReportingCurrency(fn ?? null);
    } else {
      const v = validateCurrencyCode(raw);
      if (!v.ok) {
        throw new CompanyValidationError(
          "CURRENCY_UNKNOWN",
          "عملة الإبلاغ غير مدعومة — استخدم كود ISO-4217 من سجل العملات."
        );
      }
      out.reportingCurrency = v.code;
    }
  } else if (out.functionalCurrency) {
    // اشتقاق منطقي موثق: ضبط الوظيفية دون إبلاغ صريح ⇒ الإبلاغ = الوظيفية
    out.reportingCurrency = deriveReportingCurrency(out.functionalCurrency);
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  قيود الحذف الصلب — الشركة تُحذف فقط إن كانت غير مستخدمة تمامًا           */
/* ──────────────────────────────────────────────────────────────────────── */

export interface CompanyUsage {
  reportsLinked: number;      // تقارير مرتبطة بالشركة مباشرة (companyId)
  reportsViaLegacyGroup: number; // تقارير مجموعة العمل القديمة المرتبطة (legacyGroupId)
  fiscalYears: number;        // سنوات مالية
  closingPolicy: boolean;     // سياسة إقفال قائمة
  hasLegacyMapping: boolean;  // ربط legacy حتمي — يمنع الحذف حفاظًا على إعادة التشغيل
}

/** فحص استخدام الشركة (قراءة فقط — بلا أي كتابة). */
export async function inspectCompanyUsage(companyId: string): Promise<CompanyUsage> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { legacyGroupId: true },
  });
  const [reportsLinked, reportsViaLegacyGroup, fiscalYears, closingPolicy] = await Promise.all([
    db.report.count({ where: { companyId } }),
    company?.legacyGroupId
      ? db.report.count({ where: { groupId: company.legacyGroupId } })
      : Promise.resolve(0),
    db.fiscalYear.count({ where: { companyId } }),
    db.companyClosingPolicy.findUnique({ where: { companyId }, select: { id: true } }),
  ]);
  return {
    reportsLinked,
    reportsViaLegacyGroup,
    fiscalYears,
    closingPolicy: !!closingPolicy,
    hasLegacyMapping: !!company?.legacyGroupId,
  };
}

/** هل الشركة قابلة للحذف الصلب؟ (شركة فارغة تمامًا فقط — وإلا فالتعطيل) */
export function isCompanyDeletable(usage: CompanyUsage): { ok: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (usage.reportsLinked > 0) blockers.push("REPORTS_LINKED");
  if (usage.reportsViaLegacyGroup > 0) blockers.push("REPORTS_VIA_LEGACY_GROUP");
  if (usage.fiscalYears > 0) blockers.push("FISCAL_YEARS_EXIST");
  if (usage.closingPolicy) blockers.push("CLOSING_POLICY_EXISTS");
  if (usage.hasLegacyMapping) blockers.push("LEGACY_MAPPING_ANCHOR");
  return { ok: blockers.length === 0, blockers };
}
