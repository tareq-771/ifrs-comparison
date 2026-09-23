// Phase 6.1 — /api/fiscal-years — GET (قائمة سنوات شركة مرئية) + POST (إنشاء سنة واحدة).
//
// الرؤية: fail-closed — لا يمكن حتى سرد سنوات شركة غير مرئية (404 بلا كشف وجود).
// الإنشاء: manageFiscalYears + شركة نشطة + بلا تداخل + كود وحيد + توليد فترات
// يمر عبر prevalidateFiscalYear/writeFiscalYearWithPeriods (fiscal-year.ts).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, requireManageFiscalYears } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, getClientIp } from "@/lib/audit";
import { guardWrite, guardRead } from "@/lib/api-guard";
import { companyVisible } from "@/lib/company-access";
import {
  prevalidateFiscalYear,
  writeFiscalYearWithPeriods,
  FiscalYearError,
} from "@/lib/fiscal-year";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status =
    msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

// GET /api/fiscal-years?companyId=<id> — سنوات شركة واحدة (يجب أن تكون مرئية)
export async function GET(req: NextRequest) {
  return guardRead("/api/fiscal-years", async () => {
    try {
      const user = await requireAuth();
      const { searchParams } = new URL(req.url);
      const companyId = searchParams.get("companyId") ?? "";
      if (!companyId) {
        return NextResponse.json(
          { error: "companyId إلزامي — السنوات تُسرد لشركة واحدة.", code: "COMPANY_ID_REQUIRED" },
          { status: 400 }
        );
      }
      const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!company || !companyVisible(user, companyId)) {
        return NextResponse.json({ error: "الشركة غير موجودة" }, { status: 404 });
      }
      const years = await db.fiscalYear.findMany({
        where: { companyId },
        orderBy: { startDate: "desc" },
        include: {
          periods: { orderBy: { ordinal: "asc" }, select: { id: true, ordinal: true, code: true, startDate: true, endDate: true, status: true, displayLabel: true, zeroActivityDeclared: true } },
        },
      });
      return NextResponse.json(years);
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في جلب السنوات المالية: " + msg : msg },
        { status }
      );
    }
  });
}

// POST /api/fiscal-years — إنشاء سنة مالية واحدة مع فتراتها الشهرية
export async function POST(req: NextRequest) {
  return guardWrite("/api/fiscal-years", async () => {
    try {
      const user = await requireManageFiscalYears();
      const body = await req.json();
      const companyId = typeof body.companyId === "string" ? body.companyId : "";
      if (!companyId) {
        return NextResponse.json({ error: "companyId إلزامي.", code: "COMPANY_ID_REQUIRED" }, { status: 400 });
      }
      const company = await db.company.findUnique({ where: { id: companyId } });
      if (!company || !companyVisible(user, companyId)) {
        return NextResponse.json({ error: "الشركة غير موجودة" }, { status: 404 });
      }

      const input = {
        companyId,
        code: typeof body.code === "string" ? body.code : "",
        displayNameAr: typeof body.displayNameAr === "string" ? body.displayNameAr : "",
        displayNameEn: typeof body.displayNameEn === "string" ? body.displayNameEn : "",
        startDate: typeof body.startDate === "string" ? body.startDate.trim() : "",
        endDate: typeof body.endDate === "string" ? body.endDate.trim() : "",
      };

      const pre = await prevalidateFiscalYear(input);
      if (!pre.ok) {
        const status = pre.code === "COMPANY_NOT_FOUND" || pre.code === "COMPANY_INACTIVE" ? (pre.code === "COMPANY_NOT_FOUND" ? 404 : 409) : 400;
        return NextResponse.json({ error: pre.message, code: pre.code }, { status });
      }

      const fy = await db.$transaction(async (tx) => {
        const created = await writeFiscalYearWithPeriods(
          tx,
          input,
          pre.periods,
          { origin: "USER_CREATED", actorId: user.id, actorName: user.name || user.username }
        );
        await writeAudit(tx, {
          user,
          action: AUDIT_ACTIONS.FISCAL_YEAR_CREATED,
          entityType: AUDIT_ENTITY_TYPES.FiscalYear,
          entityId: created.id,
          description: `إنشاء سنة مالية «${created.code}» لشركة «${company.nameAr}» — ${created.periodCount} فترة شهرية (${created.startDate} → ${created.endDate})`,
          after: {
            code: created.code,
            startDate: created.startDate,
            endDate: created.endDate,
            periodCount: created.periodCount,
            status: created.status,
            origin: created.origin,
          },
          ip: getClientIp(req),
        });
        return created;
      });
      return NextResponse.json(fy, { status: 201 });
    } catch (error) {
      if (error instanceof FiscalYearError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
      }
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في إنشاء السنة المالية: " + msg : msg },
        { status }
      );
    }
  });
}
