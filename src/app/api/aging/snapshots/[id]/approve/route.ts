// Phase 6.10 — اعتماد لقطة أعمار (DRAFT → APPROVED) مع فصل مهام صريح.

import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/api-guard";
import { requireApproveAgingSnapshot } from "@/lib/session";
import { getClientIp } from "@/lib/audit";
import { approveAgingSnapshot } from "@/lib/aging-server";
import { agingErrorResponse } from "@/lib/aging-http";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/aging/snapshots/[id]/approve", async () => {
    try {
      const user = await requireApproveAgingSnapshot();
      const { id } = await ctx.params;
      await approveAgingSnapshot(user, id, getClientIp(req));
      return NextResponse.json({ ok: true });
    } catch (error) {
      return agingErrorResponse(error) ?? NextResponse.json({ error: "فشل اعتماد اللقطة" }, { status: 500 });
    }
  });
}
