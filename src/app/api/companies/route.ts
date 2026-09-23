// Phase 6.1 — GET /api/companies (قائمة الشركات برؤية fail-closed)
//               POST /api/companies (إنشاء — manageCompanies)
//
// الرؤية: كل المسارات تمر عبر resolveCompanyScope (company-access.ts):
//   admin ⇒ الكل (قاعدة الدور الموثقة) | viewAllCompanies ⇒ الكل صريح |
//   companyIds غير فارغة ⇒ قائمة حصرًا | فارغة/مفقودة ⇒ لا شيء (fail-closed).
// الإبطال (INACTIVE) لا يخفي الشركة — الرؤية التاريخية محفوظة (قرار 6.0A).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, requireManageCompanies } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, getClientIp } from "@/lib/audit";
import { guardWrite, guardRead } from "@/lib/api-guard";
import { buildCompanyVisibilityWhere } from "@/lib/company-access";
import { normalizeCompanyInput, CompanyValidationError } from "@/lib/company";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status =
    msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

const COMPANY_SELECT = {
  id: true,
  code: true,
  nameAr: true,
  nameEn: true,
  status: true,
  functionalCurrency: true,
  reportingCurrency: true,
  notes: true,
  legacyGroupId: true,
  createdAt: true,
  updatedAt: true,
} as const;

// GET /api/companies — قائمة الشركات المرئية للمستخدم (رؤية fail-closed)
export async function GET(req: NextRequest) {
  return guardRead("/api/companies", async () => {
    try {
      const user = await requireAuth();
      const { searchParams } = new URL(req.url);
      const includeCounts = searchParams.get("counts") === "1";
      const companies = await db.company.findMany({
        where: buildCompanyVisibilityWhere(user),
        orderBy: [{ status: "asc" }, { code: "asc" }],
        select: COMPANY_SELECT,
      });
      if (!includeCounts) return NextResponse.json(companies);
      // عدّادات موجزة للعرض (لكل شركة على حدة — ضمن نطاق الرؤية فقط)
      const enriched = await Promise.all(
        companies.map(async (c) => {
          const [reportsLinked, fiscalYears] = await Promise.all([
            db.report.count({ where: { companyId: c.id } }),
            db.fiscalYear.count({ where: { companyId: c.id } }),
          ]);
          return { ...c, reportsLinked, fiscalYears };
        })
      );
      return NextResponse.json(enriched);
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في جلب الشركات: " + msg : msg },
        { status }
      );
    }
  });
}

// POST /api/companies — إنشاء شركة (manageCompanies + رؤية لا تقيّد الإنشاء)
export async function POST(req: NextRequest) {
  return guardWrite("/api/companies", async () => {
    try {
      const user = await requireManageCompanies();
      const body = await req.json();

      let input;
      try {
        input = normalizeCompanyInput(body);
      } catch (e) {
        if (e instanceof CompanyValidationError) {
          return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
        }
        throw e;
      }
      if (!input.code) {
        return NextResponse.json(
          { error: "كود الشركة إلزامي.", code: "COMPANY_CODE_REQUIRED" },
          { status: 400 }
        );
      }
      if (!input.nameAr) {
        return NextResponse.json(
          { error: "الاسم العربي للشركة إلزامي.", code: "COMPANY_NAME_REQUIRED" },
          { status: 400 }
        );
      }

      const dup = await db.company.findUnique({ where: { code: input.code }, select: { id: true } });
      if (dup) {
        return NextResponse.json(
          { error: `كود الشركة «${input.code}» مستخدم مسبقًا.`, code: "COMPANY_CODE_DUPLICATE" },
          { status: 409 }
        );
      }

      const company = await db.$transaction(async (tx) => {
        const created = await tx.company.create({
          data: {
            code: input.code!,
            nameAr: input.nameAr!,
            nameEn: input.nameEn ?? "",
            functionalCurrency: input.functionalCurrency ?? "",
            reportingCurrency: input.reportingCurrency ?? "",
            notes: input.notes ?? "",
            status: "ACTIVE",
          },
        });
        await writeAudit(tx, {
          user,
          action: AUDIT_ACTIONS.COMPANY_CREATED,
          entityType: AUDIT_ENTITY_TYPES.Company,
          entityId: created.id,
          description: `إنشاء شركة «${created.nameAr}» (${created.code})`,
          after: {
            code: created.code,
            nameAr: created.nameAr,
            nameEn: created.nameEn,
            status: created.status,
            functionalCurrency: created.functionalCurrency,
            reportingCurrency: created.reportingCurrency,
          },
          ip: getClientIp(req),
        });
        return created;
      });
      return NextResponse.json(company, { status: 201 });
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في إنشاء الشركة: " + msg : msg },
        { status }
      );
    }
  });
}
