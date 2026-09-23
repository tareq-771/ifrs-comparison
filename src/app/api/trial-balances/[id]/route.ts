// Phase 6.2B — GET    /api/trial-balances/[id] (تفاصيل مع السطور — مبالغ نصية آمنة)
//               DELETE /api/trial-balances/[id] (مسودات فقط — version-guarded + تدقيق)

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardWrite, guardRead } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import {
  deleteTrialBalance,
  getTrialBalance,
} from "@/lib/trial-balance-server";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof TrialBalanceError) {
    const status =
      error.code === "VERSION_CONFLICT" ? 409
      : error.code === "NOT_FOUND" ? 403
      : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return NextResponse.json({ error: status === 500 ? `${fallback}: ${msg}` : msg }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardRead("/api/trial-balances/[id]", async () => {
    try {
      const user = await requireManageTrialBalances();
      const { id } = await ctx.params;
      const row = await getTrialBalance(user, id);
      return NextResponse.json(row);
    } catch (error) {
      return errorResponse(error, "فشل في جلب ميزان المراجعة");
    }
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/trial-balances/[id]", async () => {
    try {
      const user = await requireManageTrialBalances();
      const { id } = await ctx.params;
      const body = await req.json().catch(() => ({}));
      const deleted = await deleteTrialBalance({ user, ip: getClientIp(req), id, input: body });
      return NextResponse.json(deleted);
    } catch (error) {
      return errorResponse(error, "فشل في حذف ميزان المراجعة");
    }
  });
}
