// Phase 6.2B — POST /api/trial-balances/[id]/commit (اعتماد وتجميد نهائي)
// حراس: DRAFT + متوازن + version + سنة OPEN + الفترات المغطاة OPEN (دورة حياة 6.1).

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { commitTrialBalance } from "@/lib/trial-balance-server";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/trial-balances/[id]/commit", async () => {
    try {
      const user = await requireManageTrialBalances();
      const { id } = await ctx.params;
      const body = await req.json().catch(() => ({}));
      const row = await commitTrialBalance({ user, ip: getClientIp(req), id, input: body });
      return NextResponse.json(row);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status =
          error.code === "VERSION_CONFLICT" ? 409
          : error.code === "NOT_FOUND" ? 403
          : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json(
        { error: status === 500 ? `فشل في اعتماد ميزان المراجعة: ${msg}` : msg },
        { status }
      );
    }
  });
}
