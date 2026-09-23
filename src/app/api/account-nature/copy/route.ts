// Phase 6.2A — POST /api/account-nature/copy (نسخ خريطة شركة إلى شركة)
//
// المدخل: { fromCompanyId, toCompanyId, replaceExisting?: boolean, reason? }
// الناتج: { rulesCopied, overridesCopied, replaced }
//
// النسخة مستقلة تمامًا بعد الإنشاء (تعديل المصدر لا يمس الهدف) — المعاملة
// واحدة (استبدال + نسخ) أو لا شيء. خلف requireManageAccountNature + رؤية
// الشركتين + تدقيق ACCOUNT_NATURE_MAPPING_COPIED داخل نفس المعاملة.

import { NextRequest, NextResponse } from "next/server";
import { requireManageAccountNature } from "@/lib/session";
import { guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { AccountNatureError } from "@/lib/account-nature";
import { copyCompanyMapping } from "@/lib/account-nature-server";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof AccountNatureError) {
    const status =
      error.code === "RULE_NOT_FOUND" ? 403
      : error.code === "COPY_NOT_ALLOWED" ? 409
      : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return NextResponse.json({ error: status === 500 ? `${fallback}: ${msg}` : msg }, { status });
}

export async function POST(req: NextRequest) {
  return guardWrite("/api/account-nature/copy", async () => {
    try {
      const user = await requireManageAccountNature();
      const body = await req.json().catch(() => ({}));
      const result = await copyCompanyMapping({ user, ip: getClientIp(req), input: body });
      return NextResponse.json(result, { status: 201 });
    } catch (error) {
      return errorResponse(error, "فشل في نسخ خريطة الشركة");
    }
  });
}
