// Phase 6.5 — POST فعلي مقابل الموازنة (MONTH/QUARTER/SEMI_ANNUAL/ANNUAL/YTD)
import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";
import { TrialBalanceError } from "@/lib/trial-balance";
import { getBudgetVariance } from "@/lib/budget-server";

export async function POST(req: NextRequest) {
  return guardRead("/api/budgets/variance", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = await req.json().catch(() => ({}));
      const result = await getBudgetVariance(user, body);
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.code === "NOT_FOUND" ? 403 : 400 });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  });
}
