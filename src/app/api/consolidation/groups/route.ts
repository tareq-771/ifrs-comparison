// 6.7 — GET /api/consolidation/groups (قائمة المجموعات المرئية) + POST (إنشاء مجموعة بأعضائها)
import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead, guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { createConsolidationGroup, listConsolidationGroups } from "@/lib/consolidation-server";

export async function GET() {
  return guardRead("/api/consolidation/groups", async () => {
    try {
      const user = await requireManageTrialBalances();
      const groups = await listConsolidationGroups(user);
      return NextResponse.json(groups);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  });
}

export async function POST(req: NextRequest) {
  return guardWrite("/api/consolidation/groups", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = await req.json().catch(() => ({}));
      const result = await createConsolidationGroup({ user, ip: getClientIp(req), input: body });
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
