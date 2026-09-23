// Phase 6.1 — /api/companies/[id]/closing-policy — سياسة إقفال الشركة.
//
// GET: القراءة (رؤية fail-closed) + تقييم الجاهزية الصادق (6.1): كل مكوّن مطلوب
//      يُبلغ غير متاح (STATEMENT_LAYER_NOT_IMPLEMENTED) — طبقة القوائم في 6.2،
//      ولا تُختلق أي بيانات اعتماد.
// PUT: تعديل القائمة المطلوبة (manageCompanies) من القائمة المبيّضة حصرًا
//      (TRIAL_BALANCE | INCOME_STATEMENT | BALANCE_SHEET) + حدث تدقيق.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, requireManageCompanies } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, getClientIp } from "@/lib/audit";
import { guardWrite, guardRead } from "@/lib/api-guard";
import { companyVisible } from "@/lib/company-access";
import {
  getClosingPolicy,
  evaluateClosingReadiness,
  normalizeRequiredComponents,
  ClosingPolicyError,
} from "@/lib/closing-policy";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status =
    msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

// GET /api/companies/[id]/closing-policy
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return guardRead("/api/companies/[id]/closing-policy", async () => {
    try {
      const user = await requireAuth();
      const { id } = await params;
      const company = await db.company.findUnique({ where: { id }, select: { id: true } });
      if (!company || !companyVisible(user, id)) {
        return NextResponse.json({ error: "الشركة غير موجودة" }, { status: 404 });
      }
      const policy = await getClosingPolicy(id);
      const readiness = await evaluateClosingReadiness(id);
      return NextResponse.json({
        companyId: id,
        requiredComponents: policy?.requiredComponents ?? [],
        readiness,
      });
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في جلب سياسة الإقفال: " + msg : msg },
        { status }
      );
    }
  });
}

// PUT /api/companies/[id]/closing-policy
// body: { requiredComponents: ClosingComponent[] }
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return guardWrite("/api/companies/[id]/closing-policy", async () => {
    try {
      const user = await requireManageCompanies();
      const { id } = await params;
      const company = await db.company.findUnique({ where: { id } });
      if (!company || !companyVisible(user, id)) {
        return NextResponse.json({ error: "الشركة غير موجودة" }, { status: 404 });
      }
      const body = await req.json();
      if (body.requiredComponents === undefined) {
        return NextResponse.json(
          { error: "requiredComponents إلزامي (مصفوفة أكواد من القائمة المبيّضة).", code: "COMPONENTS_REQUIRED" },
          { status: 400 }
        );
      }
      let components;
      try {
        components = normalizeRequiredComponents(body.requiredComponents);
      } catch (e) {
        if (e instanceof ClosingPolicyError) {
          return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
        }
        throw e;
      }
      const ip = getClientIp(req);
      const actorName = user.name || user.username;
      const policy = await db.$transaction(async (tx) => {
        const before = await getClosingPolicy(id);
        const saved = await tx.companyClosingPolicy.upsert({
          where: { companyId: id },
          create: {
            companyId: id,
            requiredComponents: JSON.stringify(components),
            updatedById: user.id,
            updatedByName: actorName,
          },
          update: {
            requiredComponents: JSON.stringify(components),
            updatedById: user.id,
            updatedByName: actorName,
          },
        });
        await writeAudit(tx, {
          user,
          action: AUDIT_ACTIONS.CLOSING_POLICY_UPDATED,
          entityType: AUDIT_ENTITY_TYPES.ClosingPolicy,
          entityId: id,
          description: `تحديث سياسة إقفال شركة «${company.nameAr}» — المكوّنات المطلوبة: ${components.join(", ") || "(لا شيء)"}`,
          before: { requiredComponents: before?.requiredComponents ?? [] },
          after: { requiredComponents: components },
          ip,
        });
        return saved;
      });
      return NextResponse.json(policy);
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في تحديث سياسة الإقفال: " + msg : msg },
        { status }
      );
    }
  });
}
