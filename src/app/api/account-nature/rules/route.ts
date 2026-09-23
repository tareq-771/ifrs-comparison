// Phase 6.2A — GET /api/account-nature/rules (الجذور النظامية + بادئات الشركات المرئية)
//               POST /api/account-nature/rules (إنشاء بادئة شركة تفصيلية — manageAccountNature)
//
// كل المسارات خلف requireManageAccountNature (المدير ضمنيًا بالدور — نمط 6.1).
// الجذور النظامية 1/2/3/4 (companyId=null) للقراءة فقط — إنشاء قواعد نظامية
// جديدة يُرفض خادميًا (SYSTEM_IMMUTABLE) — التصنيف التفصيلي يُعرَّف داخل كل شركة.
// القراءة نفسها مقيّدة بالصلاحية عمدًا: القواعد metadata مالية حساسة، و6.2B
// ستقرر صلاحية قراءة أوسع للتيارات التقريرية بقرار مستقل.

import { NextRequest, NextResponse } from "next/server";
import { requireManageAccountNature } from "@/lib/session";
import { guardWrite, guardRead } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { AccountNatureError } from "@/lib/account-nature";
import {
  createNatureRule,
  listNatureRules,
} from "@/lib/account-nature-server";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof AccountNatureError) {
    const status =
      error.code === "VERSION_CONFLICT" || error.code === "RULE_PREFIX_DUPLICATE"
        ? 409
        : error.code === "RULE_NOT_FOUND" || error.code === "SYSTEM_IMMUTABLE"
          ? 403
          : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return NextResponse.json({ error: status === 500 ? `${fallback}: ${msg}` : msg }, { status });
}

export async function GET() {
  return guardRead("/api/account-nature/rules", async () => {
    try {
      const user = await requireManageAccountNature();
      const rules = await listNatureRules(user);
      return NextResponse.json(rules);
    } catch (error) {
      return errorResponse(error, "فشل في جلب قواعد دليل الحسابات");
    }
  });
}

export async function POST(req: NextRequest) {
  return guardWrite("/api/account-nature/rules", async () => {
    try {
      const user = await requireManageAccountNature();
      const body = await req.json().catch(() => ({}));
      const created = await createNatureRule({
        user,
        ip: getClientIp(req),
        input: body,
      });
      return NextResponse.json(created, { status: 201 });
    } catch (error) {
      return errorResponse(error, "فشل في إنشاء بادئة شركة تفصيلية");
    }
  });
}
