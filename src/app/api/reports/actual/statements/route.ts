// Phase 6.2D — POST /api/reports/actual/statements
// قائمتا الربح أو الخسارة والمركز المالي من البيانات المحفوظة (+ تهيئة OCI).
// المدخل: { companyId, fiscalYearId, ordinal, basis?: "YTD" | "PERIOD" }

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";
import { TrialBalanceError } from "@/lib/trial-balance";
import { getStatements } from "@/lib/statement-server";

export async function POST(req: NextRequest) {
  return guardRead("/api/reports/actual/statements", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = await req.json().catch(() => ({}));
      const result = await getStatements(user, body);
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status = error.code === "NOT_FOUND" ? 403 : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json(
        { error: status === 500 ? `فشل في بناء القوائم المالية: ${msg}` : msg },
        { status }
      );
    }
  });
}
