// Phase 7.0 (Step 3) — /api/tb-import-v2/draft
//   POST — حفظ مسودة مستورد ميزان المراجعة V1: إعادة بناء حتمي كامل من المصدر
//   الخام، حوكمة السلسلة القائمة حصرًا (المعتمد لا يُمسّ)، إثبات AuditLog موجز.
//   GET ?id=… — قراءة الإثبات المحفوظ (قراءة صرفة).
// كل المسارات خلف requireManageTrialBalances + نطاق الشركات داخل الخدمة.

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardWrite, guardRead } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import {
  getTbImportProvenance,
  saveTbImportDraft,
  type TbImportServerInput,
} from "@/lib/tb-import-server";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof TrialBalanceError) {
    const status =
      error.code === "DUPLICATE_IMPORT" || error.code === "DUPLICATE_COMMITTED"
        ? 409
        : error.code === "NOT_FOUND"
          ? 403
          : 400;
    return NextResponse.json({ error: error.message, code: error.code, detail: error.detail }, { status });
  }
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return NextResponse.json({ error: status === 500 ? `${fallback}: ${msg}` : msg }, { status });
}

export async function POST(req: NextRequest) {
  return guardWrite("/api/tb-import-v2/draft", async () => {
    try {
      const user = await requireManageTrialBalances();
      const ip = getClientIp(req);
      const body = (await req.json()) as TbImportServerInput;
      const result = await saveTbImportDraft(user, ip, body);
      return NextResponse.json(result);
    } catch (error) {
      return errorResponse(error, "فشل حفظ مسودة مستورد ميزان المراجعة V1");
    }
  });
}

export async function GET(req: NextRequest) {
  return guardRead("/api/tb-import-v2/draft", async () => {
    try {
      const user = await requireManageTrialBalances();
      const id = req.nextUrl.searchParams.get("id") ?? "";
      const result = await getTbImportProvenance(user, id);
      return NextResponse.json(result);
    } catch (error) {
      return errorResponse(error, "فشل قراءة إثبات المستورد");
    }
  });
}
