// Phase 6.9 — POST /api/reports/actual/statement-comparison
// عرض ومقارنة القوائم المالية بأوضاع عرض متعددة (كل الحسابات/الرئيسية/الفرعية/المستوى/
// تصنيف القوائم) وأوضاع مقارنة موحدة (بلا/الفترة السابقة/مناظر السنة السابقة/الموازنة/
// التراكمي/متوسط التراكمي) — من المصدر المعتمد حصرًا عبر getStatementComparison.
// المدخل: { companyId, fiscalYearId, ordinal, basis?, statementScope?,
//           presentationMode?, accountLevel?, comparisonMode? }

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";
import { TrialBalanceError } from "@/lib/trial-balance";
import { getStatementComparison } from "@/lib/comparison-server";

export async function POST(req: NextRequest) {
  return guardRead("/api/reports/actual/statement-comparison", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = await req.json().catch(() => ({}));
      const result = await getStatementComparison({ user, input: body });
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status = error.code === "NOT_FOUND" ? 403 : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json(
        { error: status === 500 ? `فشل في بناء العرض والمقارنة: ${msg}` : msg },
        { status }
      );
    }
  });
}
