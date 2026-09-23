// Phase 6.2A — GET/POST /api/account-nature/overrides (استثناءات الحسابات المحددة)
//               PATCH/DELETE /api/account-nature/overrides/[id] عبر مسار [id].
//
// الاستثناء أولويته حاكمة فوق أي بادئة (شركة أو نظامية) في resolveAccountMapping.
// كل المسارات خلف requireManageAccountNature + رؤية الشركة (fail-closed) +
// optimistic locking (version) + تدقيق before/after/reason عبر writeAudit.

import { NextRequest, NextResponse } from "next/server";
import { requireManageAccountNature } from "@/lib/session";
import { guardWrite, guardRead } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { AccountNatureError } from "@/lib/account-nature";
import {
  createMappingOverride,
  listMappingOverrides,
} from "@/lib/account-nature-server";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof AccountNatureError) {
    const status =
      error.code === "VERSION_CONFLICT" || error.code === "OVERRIDE_DUPLICATE"
        ? 409
        : error.code === "RULE_NOT_FOUND" || error.code === "OVERRIDE_NOT_FOUND"
          ? 403
          : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return NextResponse.json({ error: status === 500 ? `${fallback}: ${msg}` : msg }, { status });
}

export async function GET(req: NextRequest) {
  return guardRead("/api/account-nature/overrides", async () => {
    try {
      const user = await requireManageAccountNature();
      const companyId = req.nextUrl.searchParams.get("companyId");
      const overrides = await listMappingOverrides(user, companyId && companyId.length > 0 ? companyId : null);
      return NextResponse.json(overrides);
    } catch (error) {
      return errorResponse(error, "فشل في جلب استثناءات الحسابات");
    }
  });
}

export async function POST(req: NextRequest) {
  return guardWrite("/api/account-nature/overrides", async () => {
    try {
      const user = await requireManageAccountNature();
      const body = await req.json().catch(() => ({}));
      const created = await createMappingOverride({ user, ip: getClientIp(req), input: body });
      return NextResponse.json(created, { status: 201 });
    } catch (error) {
      return errorResponse(error, "فشل في إنشاء استثناء حساب");
    }
  });
}
