// Phase 6.6 — POST /api/consolidation/adjustments (قيد توحيد/استبعاد متوازن)
import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { createConsolidationAdjustment } from "@/lib/consolidation-server";

export async function POST(req: NextRequest) {
  return guardWrite("/api/consolidation/adjustments", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = await req.json().catch(() => ({}));
      const result = await createConsolidationAdjustment({ user, ip: getClientIp(req), input: body });
      return NextResponse.json(result, { status: 201 });
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status = error.code === "NOT_BALANCED" ? 422 : error.code === "NOT_FOUND" ? 403 : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  });
}
