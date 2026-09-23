// Phase 6.6 — POST /api/consolidation/statements (قوائم موحدة مبدئية + ورقة عمل)
import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";
import { TrialBalanceError } from "@/lib/trial-balance";
import { getConsolidatedStatements } from "@/lib/consolidation-server";

export async function POST(req: NextRequest) {
  return guardRead("/api/consolidation/statements", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = await req.json().catch(() => ({}));
      const result = await getConsolidatedStatements(user, body);
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.code === "NOT_FOUND" ? 403 : 400 });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: status === 500 ? `فشل في بناء القوائم الموحدة: ${msg}` : msg }, { status });
    }
  });
}
