// Phase 6.2A — POST /api/account-nature/resolve (الحل الخادمي المركزي لأكواد الحسابات)
//
// المدخل: { companyId?: string | null, codes: string[] }
// الناتج: [{code, status, classification?, aggregationBehavior?, matchedPrefix?, scope?}]
//         + ملخص {total, resolved, needsClassification}
//
// NEEDS_CLASSIFICATION يعود كحالة صريحة (لا استثناء HTTP) — الواجهة تُبرزها؛
// الحسابات الرقمية (aggregateYTD...) هي التي ترفض الصمت عبر AggregationError.

import { NextRequest, NextResponse } from "next/server";
import { requireManageAccountNature } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";
import { companyVisible } from "@/lib/company-access";
import { resolveCodesForCompany } from "@/lib/account-nature-server";

const MAX_CODES = 5000;

export async function POST(req: NextRequest) {
  return guardRead("/api/account-nature/resolve", async () => {
    try {
      const user = await requireManageAccountNature();
      const body = await req.json().catch(() => ({}));
      const companyId =
        typeof body?.companyId === "string" && body.companyId.trim().length > 0
          ? body.companyId.trim()
          : null;
      if (companyId && !companyVisible(user, companyId)) {
        return NextResponse.json(
          { error: "لا تملك الوصول لهذه الشركة.", code: "COMPANY_FORBIDDEN" },
          { status: 403 }
        );
      }
      const codes = Array.isArray(body?.codes) ? body.codes : [];
      if (codes.length === 0) {
        return NextResponse.json(
          { error: "قائمة أكواد الحسابات فارغة.", code: "NO_CODES" },
          { status: 400 }
        );
      }
      if (codes.length > MAX_CODES) {
        return NextResponse.json(
          { error: `عدد الأكواد يتجاوز الحد المسموح (${MAX_CODES}).`, code: "TOO_MANY_CODES" },
          { status: 400 }
        );
      }
      const result = await resolveCodesForCompany(companyId, codes);
      return NextResponse.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json(
        { error: status === 500 ? `فشل في حل طبيعة الحسابات: ${msg}` : msg },
        { status }
      );
    }
  });
}
