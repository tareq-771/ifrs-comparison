// Phase 6.10 — تفصيل لقطة أعمار (الرؤى مقيّدة بصلاحية viewInsights).

import { NextRequest, NextResponse } from "next/server";
import { guardRead } from "@/lib/api-guard";
import { requireViewAging } from "@/lib/session";
import { getAgingSnapshot } from "@/lib/aging-server";
import { agingErrorResponse } from "@/lib/aging-http";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardRead("/api/aging/snapshots/[id]", async () => {
    try {
      const user = await requireViewAging();
      const { id } = await ctx.params;
      const result = await getAgingSnapshot(user, id);
      return NextResponse.json(result);
    } catch (error) {
      return agingErrorResponse(error) ?? NextResponse.json({ error: "فشل جلب اللقطة" }, { status: 500 });
    }
  });
}
