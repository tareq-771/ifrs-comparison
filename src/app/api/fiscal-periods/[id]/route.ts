// Phase 6.1 — /api/fiscal-periods/[id] — إدارة حالة الفترة المحاسبية.
//
// القواعد:
//   - الإغلاق/الفتح: OPEN⇄CLOSED مع managePeriods (المدير ضمنيًا بالدور).
//   - السنة المقفلة (LOCKED) تمنع أي تغيير على فتراتها (القفل حقيقي لا شكلي).
//   - zeroActivityDeclared إعلان صريح من المشغّل — لا يُستنتج آليًا أبدًا (6.0A).
//   - كل تغيير: حدث تدقيق FISCAL_PERIOD_STATUS_CHANGED.
//   - الهوية الآلية ordinal/code — التغييرات هنا لا تمس الهوية إطلاقًا.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, requireManagePeriods } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, getClientIp } from "@/lib/audit";
import { guardWrite } from "@/lib/api-guard";
import {
  assertFiscalYearVisible,
  FISCAL_PERIOD_STATUS,
  FISCAL_YEAR_STATUS,
  FiscalYearError,
  type FiscalPeriodStatus,
} from "@/lib/fiscal-year";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status =
    msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

// PATCH /api/fiscal-periods/[id]
// body: { status?: "OPEN" | "CLOSED", zeroActivityDeclared?: boolean }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return guardWrite("/api/fiscal-periods/[id]", async () => {
    try {
      const user = await requireAuth();
      const { id } = await params;
      const period = await db.fiscalPeriod.findUnique({
        where: { id },
        include: { fiscalYear: { select: { id: true, code: true, status: true, companyId: true } } },
      });
      if (!period) {
        return NextResponse.json({ error: "الفترة غير موجودة" }, { status: 404 });
      }
      // الرؤية عبر سنة الفترة (فشل مغلق على مستوى الشركة)
      await assertFiscalYearVisible(period.fiscalYearId, user);
      // بوابة الصلاحية
      await requireManagePeriods();

      if (period.fiscalYear.status === FISCAL_YEAR_STATUS.LOCKED) {
        return NextResponse.json(
          {
            error: "السنة المالية مقفلة (LOCKED) — لا تغيير على فتراتها. فك القفل يتطلب سببًا وصلاحية lockFiscalYears.",
            code: "FY_LOCKED",
          },
          { status: 409 }
        );
      }

      const body = await req.json();
      const data: Record<string, unknown> = {};
      if (body.status !== undefined && body.status !== null && body.status !== "") {
        if (body.status !== FISCAL_PERIOD_STATUS.OPEN && body.status !== FISCAL_PERIOD_STATUS.CLOSED) {
          return NextResponse.json(
            { error: "حالة الفترة غير صالحة — OPEN أو CLOSED فقط.", code: "PERIOD_STATUS_INVALID" },
            { status: 400 }
          );
        }
        if (body.status !== period.status) data.status = body.status as FiscalPeriodStatus;
      }
      if (body.zeroActivityDeclared !== undefined) {
        if (typeof body.zeroActivityDeclared !== "boolean") {
          return NextResponse.json(
            { error: "zeroActivityDeclared يجب أن يكون قيمة منطقية (إعلان صريح).", code: "ZERO_ACTIVITY_INVALID" },
            { status: 400 }
          );
        }
        if (body.zeroActivityDeclared !== period.zeroActivityDeclared) {
          data.zeroActivityDeclared = body.zeroActivityDeclared;
        }
      }
      if (Object.keys(data).length === 0) {
        return NextResponse.json(
          { error: "لا توجد تغييرات في الطلب.", code: "NOTHING_TO_UPDATE" },
          { status: 400 }
        );
      }

      const ip = getClientIp(req);
      const updated = await db.$transaction(async (tx) => {
        const u = await tx.fiscalPeriod.update({ where: { id: period.id }, data });
        await writeAudit(tx, {
          user,
          action: AUDIT_ACTIONS.FISCAL_PERIOD_STATUS_CHANGED,
          entityType: AUDIT_ENTITY_TYPES.FiscalPeriod,
          entityId: period.id,
          description: `تغيير فترة «${period.displayLabel || period.code}» (ordinal ${period.ordinal}) في سنة «${period.fiscalYear.code}»`,
          before: { status: period.status, zeroActivityDeclared: period.zeroActivityDeclared },
          after: {
            ...(data.status !== undefined ? { status: data.status } : {}),
            ...(data.zeroActivityDeclared !== undefined ? { zeroActivityDeclared: data.zeroActivityDeclared } : {}),
          },
          metadata: { fiscalYearId: period.fiscalYearId, companyId: period.fiscalYear.companyId },
          ip,
        });
        return u;
      });
      return NextResponse.json(updated);
    } catch (error) {
      if (error instanceof FiscalYearError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.code === "FY_NOT_FOUND" ? 404 : 403 }
        );
      }
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في تحديث الفترة: " + msg : msg },
        { status }
      );
    }
  });
}
