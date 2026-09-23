// Phase 6.5 — POST نسخة جديدة (versionNumber+1 مع نسخ البنود)
import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { reviseBudget } from "@/lib/budget-server";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/budgets/[id]/revision", async () => {
    try {
      const user = await requireManageTrialBalances();
      const { id } = await ctx.params;
      const body = await req.json().catch(() => ({}));
      const row = await reviseBudget({ user, ip: getClientIp(req), id, input: body });
      return NextResponse.json(row, { status: 201 });
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
