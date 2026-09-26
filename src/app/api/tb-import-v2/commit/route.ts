// Phase 7.0 (V1 closure) — POST /api/tb-import-v2/commit
// اعتماد مسودة مستورد ميزان المراجعة V1 بعد إعادة تحقق المصدر الخام إلزاميًا:
//   • الطلب يحمل المصدر الخام حصرًا (+ معرف المسودة ونسختها) — أي إسناد/دلالات
//     من العميل ليست ضمن العقد إطلاقًا؛ مصدر الحقيقة إثبات المسودة المحفوظ.
//   • غياب المصدر ⇒ SOURCE_REVALIDATION_REQUIRED (إعادة اختيار الملف).
//   • النجاح يمر حصرًا عبر دورة الاعتماد القائمة (حراس 6.1 + قفل النسخ + ذرية).

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { commitTbImportDraft, type TbImportCommitInput } from "@/lib/tb-import-server";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof TrialBalanceError) {
    const status =
      error.code === "NOT_FOUND"
        ? 403
        : error.code === "VERSION_CONFLICT" || error.code === "DUPLICATE_COMMITTED"
          ? 409
          : 400;
    return NextResponse.json({ error: error.message, code: error.code, detail: error.detail }, { status });
  }
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return NextResponse.json({ error: status === 500 ? `${fallback}: ${msg}` : msg }, { status });
}

export async function POST(req: NextRequest) {
  return guardWrite("/api/tb-import-v2/commit", async () => {
    try {
      const user = await requireManageTrialBalances();
      const ip = getClientIp(req);
      const body = (await req.json()) as TbImportCommitInput;
      const result = await commitTbImportDraft(user, ip, body);
      return NextResponse.json(result);
    } catch (error) {
      return errorResponse(error, "فشل اعتماد مسودة مستورد ميزان المراجعة V1");
    }
  });
}
