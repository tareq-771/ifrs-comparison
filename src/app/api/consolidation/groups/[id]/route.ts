// 6.7 — GET /api/consolidation/groups/[id] (تفاصيل: أعضاء/بنود/خرائط/قيود) + PATCH (اسم)
import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead, guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { getConsolidationGroupDetail, updateConsolidationGroup } from "@/lib/consolidation-server";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return guardRead("/api/consolidation/groups/[id]", async () => {
    try {
      const user = await requireManageTrialBalances();
      const { id } = await params;
      const detail = await getConsolidationGroupDetail(user, id);
      return NextResponse.json(detail);
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

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/consolidation/groups/[id]", async () => {
    try {
      const user = await requireManageTrialBalances();
      const { id } = await params;
      const body = await req.json().catch(() => ({}));
      const result = await updateConsolidationGroup({ user, ip: getClientIp(req), groupId: id, input: body });
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status = error.code === "NOT_FOUND" ? 403 : error.code === "INVALID_LINE" ? 400 : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  });
}
