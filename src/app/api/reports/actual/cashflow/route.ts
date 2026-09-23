// Phase 6.4B — POST /api/reports/actual/cashflow
// قائمة التدفقات النقدية (IAS 7 — الطريقة غير المباشرة) من أحدث المراجعات المعتمدة حصرًا.
// المدخل: { companyId, fiscalYearId, startOrdinal, endOrdinal }

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";
import { TrialBalanceError } from "@/lib/trial-balance";
import { getCashFlowStatement } from "@/lib/cashflow-server";

export async function POST(req: NextRequest) {
  return guardRead("/api/reports/actual/cashflow", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = await req.json().catch(() => ({}));
      const result = await getCashFlowStatement(user, body);
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status = error.code === "NOT_FOUND" ? 403 : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json(
        { error: status === 500 ? `فشل في بناء قائمة التدفقات النقدية: ${msg}` : msg },
        { status }
      );
    }
  });
}
