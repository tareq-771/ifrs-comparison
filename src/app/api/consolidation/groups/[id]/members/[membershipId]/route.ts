// 6.7 — DELETE /api/consolidation/groups/[id]/members/[membershipId] (إزالة عضوية)
import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { removeGroupMember } from "@/lib/consolidation-server";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; membershipId: string }> }) {
  return guardWrite("/api/consolidation/groups/[id]/members/[membershipId]", async () => {
    try {
      const user = await requireManageTrialBalances();
      const { id, membershipId } = await params;
      const body = await req.json().catch(() => ({}));
      const reason = typeof body?.reason === "string" ? body.reason : undefined;
      const result = await removeGroupMember({ user, ip: getClientIp(req), groupId: id, membershipId, reason });
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status = error.code === "NOT_FOUND" ? 403 : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  });
}
