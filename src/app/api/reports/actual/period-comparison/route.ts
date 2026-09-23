// Phase 6.2C — POST /api/reports/actual/period-comparison
// «الفترة الحالية مقابل الفترة السابقة» من ميزان المراجعة المحفوظ (بلا رفع ملف).
// المدخل: { companyId, fiscalYearId, currentOrdinal } — الفترة السابقة يحددها
// النظام تلقائيًا إن وُجدت ولا تُخترع (NO_PREVIOUS_PERIOD صريحة).

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";
import { TrialBalanceError } from "@/lib/trial-balance";
import { getSavedPeriodComparison } from "@/lib/reporting-server";

export async function POST(req: NextRequest) {
  return guardRead("/api/reports/actual/period-comparison", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = await req.json().catch(() => ({}));
      const result = await getSavedPeriodComparison(user, body);
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status = error.code === "NOT_FOUND" ? 403 : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json(
        { error: status === 500 ? `فشل في تقرير مقارنة الفترات: ${msg}` : msg },
        { status }
      );
    }
  });
}
