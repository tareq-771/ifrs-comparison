// Phase 6.2B — GET  /api/trial-balances?companyId=… (قائمة بالميزانيات المحفوظة برؤية fail-closed)
//               POST /api/trial-balances (حفظ استيراد: مسودة/غير متوازن — بلا اعتماد)
//
// كل المسارات خلف requireManageTrialBalances + نطاق الشركات داخل الخدمة.
// سياسة التكرار المحافظة داخل الخدمة (DUPLICATE_IMPORT/DUPLICATE_COMMITTED).

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardWrite, guardRead } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import {
  createTrialBalance,
  listTrialBalances,
} from "@/lib/trial-balance-server";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof TrialBalanceError) {
    const status =
      error.code === "VERSION_CONFLICT" ||
      error.code === "DUPLICATE_IMPORT" ||
      error.code === "DUPLICATE_COMMITTED"
        ? 409
        : error.code === "NOT_FOUND"
          ? 403
          : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return NextResponse.json({ error: status === 500 ? `${fallback}: ${msg}` : msg }, { status });
}

export async function GET(req: NextRequest) {
  return guardRead("/api/trial-balances", async () => {
    try {
      const user = await requireManageTrialBalances();
      const companyId = req.nextUrl.searchParams.get("companyId");
      const rows = await listTrialBalances(user, companyId && companyId.length > 0 ? companyId : null);
      return NextResponse.json(rows);
    } catch (error) {
      return errorResponse(error, "فشل في جلب ميزان المراجعة المحفوظ");
    }
  });
}

export async function POST(req: NextRequest) {
  return guardWrite("/api/trial-balances", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = await req.json().catch(() => ({}));
      const result = await createTrialBalance({ user, ip: getClientIp(req), input: body });
      return NextResponse.json(result, { status: 201 });
    } catch (error) {
      return errorResponse(error, "فشل في حفظ ميزان المراجعة");
    }
  });
}
