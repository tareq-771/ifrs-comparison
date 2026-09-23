// 6.7 — POST /api/consolidation/groups/[id]/members (إضافة عضو + بذر خرائطه)
import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { addGroupMember } from "@/lib/consolidation-server";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/consolidation/groups/[id]/members", async () => {
    try {
      const user = await requireManageTrialBalances();
      const { id } = await params;
      const body = await req.json().catch(() => ({}));
      const result = await addGroupMember({ user, ip: getClientIp(req), groupId: id, input: body });
      return NextResponse.json(result, { status: 201 });
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status = error.code === "DUPLICATE_IMPORT" ? 409 : error.code === "NOT_FOUND" ? 403 : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  });
}
