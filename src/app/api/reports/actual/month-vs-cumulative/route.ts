// Phase 6.2C — POST /api/reports/actual/month-vs-cumulative
// «الشهر مقابل التراكمي» من ميزان المراجعة المحفوظ — FLOW: حركة الشهر + YTD
// (بلا جمع ملفات تراكمية)، BALANCE: رصيد إقفال as-of فقط بلا صيغة جمع غير منطقية.

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";
import { TrialBalanceError } from "@/lib/trial-balance";
import { getSavedMonthVsCumulative } from "@/lib/reporting-server";

export async function POST(req: NextRequest) {
  return guardRead("/api/reports/actual/month-vs-cumulative", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = await req.json().catch(() => ({}));
      const result = await getSavedMonthVsCumulative(user, body);
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status = error.code === "NOT_FOUND" ? 403 : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json(
        { error: status === 500 ? `فشل في تقرير الشهر مقابل التراكمي: ${msg}` : msg },
        { status }
      );
    }
  });
}
