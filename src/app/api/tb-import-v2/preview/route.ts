// Phase 7.0 (Step 3) — POST /api/tb-import-v2/preview
// معاينة خادمية حتمية لمستورد ميزان المراجعة V1 — قراءة صرفة (لا كتابة إطلاقًا).
// العميل يرسل المصدر الخام + قراراته الصريحة حصرًا؛ كل قيمة محاسبية تُشتق خادميًا.

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardWrite } from "@/lib/api-guard";
import { TrialBalanceError } from "@/lib/trial-balance";
import { previewTbImport, type TbImportServerInput } from "@/lib/tb-import-server";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof TrialBalanceError) {
    const status = error.code === "NOT_FOUND" ? 403 : 400;
    return NextResponse.json({ error: error.message, code: error.code, detail: error.detail }, { status });
  }
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return NextResponse.json({ error: status === 500 ? `${fallback}: ${msg}` : msg }, { status });
}

export async function POST(req: NextRequest) {
  return guardWrite("/api/tb-import-v2/preview", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = (await req.json()) as TbImportServerInput;
      const preview = await previewTbImport(user, body);
      return NextResponse.json(preview);
    } catch (error) {
      return errorResponse(error, "فشل معاينة مستورد ميزان المراجعة V1");
    }
  });
}
