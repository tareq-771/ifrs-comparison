// Phase 6.1 — /api/companies/[id] — قراءة/تعديل/إبطال-تفعيل/حذف شركة.
//
// الرؤية: fail-closed عبر companyVisible — شركة غير مرئية ⇒ 404 (لا كشف وجود).
// التعديل/الحذف: requireManageCompanies + رؤية.
// الحذف الصلب (القاعدة النهائية 6.1): شركة غير مستخدمة تمامًا فقط —
//   أي تقارير مرتبطة (مباشرة أو عبر مجموعة legacy) أو سنوات مالية أو سياسة
//   إقفال أو ربط legacy ⇒ رفض 409 COMPANY_DELETE_BLOCKED + حدث تدقيق رفض.
//   وإلا فالسياسة المعمارية: التعطيل INACTIVE (يحفظ الرؤية التاريخية).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, requireManageCompanies } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, writeAuditSafe, getClientIp } from "@/lib/audit";
import { guardWrite, guardRead } from "@/lib/api-guard";
import { companyVisible } from "@/lib/company-access";
import {
  normalizeCompanyInput,
  isCompanyStatus,
  COMPANY_STATUS,
  inspectCompanyUsage,
  isCompanyDeletable,
  CompanyValidationError,
} from "@/lib/company";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status =
    msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

// GET /api/companies/[id]
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return guardRead("/api/companies/[id]", async () => {
    try {
      const user = await requireAuth();
      const { id } = await params;
      const company = await db.company.findUnique({ where: { id } });
      if (!company || !companyVisible(user, company.id)) {
        return NextResponse.json({ error: "الشركة غير موجودة" }, { status: 404 });
      }
      const usage = await inspectCompanyUsage(company.id);
      return NextResponse.json({ ...company, usage });
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في جلب الشركة: " + msg : msg },
        { status }
      );
    }
  });
}

// PUT /api/companies/[id] — تعديل الحقول + إبطال/تفعيل عبر status (خادمي التحقق)
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return guardWrite("/api/companies/[id]", async () => {
    try {
      const user = await requireManageCompanies();
      const { id } = await params;
      const existing = await db.company.findUnique({ where: { id } });
      if (!existing || !companyVisible(user, existing.id)) {
        return NextResponse.json({ error: "الشركة غير موجودة" }, { status: 404 });
      }
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

      // تفرد الكود (إن تغيّر)
      if (input.code && input.code !== existing.code) {
        const dup = await db.company.findUnique({ where: { code: input.code }, select: { id: true } });
        if (dup && dup.id !== existing.id) {
          return NextResponse.json(
            { error: `كود الشركة «${input.code}» مستخدم مسبقًا.`, code: "COMPANY_CODE_DUPLICATE" },
            { status: 409 }
          );
        }
      }

      // انتقال الحالة — تحقق خادمي صريح (بلا تغيير حالة ضمني)
      let statusChange: { from: string; to: string } | null = null;
      if (body.status !== undefined && body.status !== null && body.status !== "") {
        if (!isCompanyStatus(body.status)) {
          return NextResponse.json(
            { error: "حالة الشركة غير صالحة — ACTIVE أو INACTIVE فقط.", code: "COMPANY_STATUS_INVALID" },
            { status: 400 }
          );
        }
        if (body.status !== existing.status) statusChange = { from: existing.status, to: body.status };
      }

      const data: Record<string, unknown> = {};
      if (input.code !== undefined) data.code = input.code;
      if (input.nameAr !== undefined) data.nameAr = input.nameAr;
      if (input.nameEn !== undefined) data.nameEn = input.nameEn;
      if (input.functionalCurrency !== undefined) data.functionalCurrency = input.functionalCurrency;
      if (input.reportingCurrency !== undefined) data.reportingCurrency = input.reportingCurrency;
      if (input.notes !== undefined) data.notes = input.notes;
      if (statusChange) data.status = statusChange.to;

      if (Object.keys(data).length === 0) {
        return NextResponse.json(
          { error: "لا توجد حقول قابلة للتعديل في الطلب.", code: "NOTHING_TO_UPDATE" },
          { status: 400 }
        );
      }

      const company = await db.$transaction(async (tx) => {
        const updated = await tx.company.update({ where: { id: existing.id }, data });
        if (statusChange) {
          await writeAudit(tx, {
            user,
            action:
              statusChange.to === COMPANY_STATUS.INACTIVE
                ? AUDIT_ACTIONS.COMPANY_DEACTIVATED
                : AUDIT_ACTIONS.COMPANY_REACTIVATED,
            entityType: AUDIT_ENTITY_TYPES.Company,
            entityId: updated.id,
            description:
              statusChange.to === COMPANY_STATUS.INACTIVE
                ? `إيقاف شركة «${updated.nameAr}» (${updated.code}) — الرؤية التاريخية محفوظة`
                : `إعادة تفعيل شركة «${updated.nameAr}» (${updated.code})`,
            before: { status: statusChange.from },
            after: { status: statusChange.to },
            ip: getClientIp(req),
          });
        }
        if (Object.keys(data).length > (statusChange ? 1 : 0)) {
          await writeAudit(tx, {
            user,
            action: AUDIT_ACTIONS.COMPANY_UPDATED,
            entityType: AUDIT_ENTITY_TYPES.Company,
            entityId: updated.id,
            description: `تعديل شركة «${updated.nameAr}» (${updated.code})`,
            before: {
              ...(input.code !== undefined ? { code: existing.code } : {}),
              ...(input.nameAr !== undefined ? { nameAr: existing.nameAr } : {}),
              ...(input.nameEn !== undefined ? { nameEn: existing.nameEn } : {}),
              ...(input.functionalCurrency !== undefined ? { functionalCurrency: existing.functionalCurrency } : {}),
              ...(input.reportingCurrency !== undefined ? { reportingCurrency: existing.reportingCurrency } : {}),
              ...(input.notes !== undefined ? { notes: existing.notes } : {}),
            },
            after: data,
            ip: getClientIp(req),
          });
        }
        return updated;
      });
      return NextResponse.json(company);
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في تحديث الشركة: " + msg : msg },
        { status }
      );
    }
  });
}

// DELETE /api/companies/[id] — الحذف الصلب: شركة غير مستخدمة تمامًا فقط.
// أي استخدام ⇒ 409 + حدث COMPANY_DELETE_DENIED (بلا أي حذف — التعطيل هو البديل).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return guardWrite("/api/companies/[id]", async () => {
    try {
      const user = await requireManageCompanies();
      const { id } = await params;
      const existing = await db.company.findUnique({ where: { id } });
      if (!existing || !companyVisible(user, existing.id)) {
        return NextResponse.json({ error: "الشركة غير موجودة" }, { status: 404 });
      }
      const usage = await inspectCompanyUsage(existing.id);
      const check = isCompanyDeletable(usage);
      if (!check.ok) {
        // حدث الرفض يسجل بأمان — فشل التدقيق لا يمنع الرفض نفسه
        await writeAuditSafe({
          user,
          action: AUDIT_ACTIONS.COMPANY_DELETE_DENIED,
          entityType: AUDIT_ENTITY_TYPES.Company,
          entityId: existing.id,
          description: `رفض حذف شركة «${existing.nameAr}» (${existing.code}) — المعوقات: ${check.blockers.join(", ")}`,
          metadata: { blockers: check.blockers, usage },
          ip: getClientIp(req),
        }).catch(() => undefined);
        return NextResponse.json(
          {
            error:
              "لا يمكن حذف الشركة لوجود سجلات مرتبطة بها — استخدم الإيقاف (INACTIVE) الذي يحفظ الرؤية التاريخية.",
            code: "COMPANY_DELETE_BLOCKED",
            blockers: check.blockers,
            usage,
          },
          { status: 409 }
        );
      }
      await db.$transaction(async (tx) => {
        await tx.company.delete({ where: { id: existing.id } });
        await writeAudit(tx, {
          user,
          action: AUDIT_ACTIONS.COMPANY_UPDATED,
          entityType: AUDIT_ENTITY_TYPES.Company,
          entityId: existing.id,
          description: `حذف شركة فارغة تمامًا «${existing.nameAr}» (${existing.code}) — بلا أي سجلات مرتبطة`,
          before: {
            code: existing.code,
            nameAr: existing.nameAr,
            status: existing.status,
          },
          metadata: { hardDelete: true, emptyCompany: true },
          ip: getClientIp(req),
        });
      });
      return NextResponse.json({ success: true });
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في حذف الشركة: " + msg : msg },
        { status }
      );
    }
  });
}
