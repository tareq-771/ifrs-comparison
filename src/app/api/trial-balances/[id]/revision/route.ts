// Phase 6.3 — POST /api/trial-balances/[id]/revision
// إنشاء مسودة مراجعة لميزان مراجعة معتمد: revisionNumber+1 + سبب إلزامي +
// supersedesImportId ⇒ مسار COMMITTED → CREATE REVISION → DRAFT → VALIDATE → COMMIT.
// المعتمد السابق لا يُعدّل ولا يُحذف — يبقى سليماً للتتبع التاريخي.

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { createTrialBalanceRevision } from "@/lib/trial-balance-server";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/trial-balances/[id]/revision", async () => {
    try {
      const user = await requireManageTrialBalances();
      const { id } = await ctx.params;
      const body = await req.json().catch(() => ({}));
      const row = await createTrialBalanceRevision({ user, ip: getClientIp(req), id, input: body });
      return NextResponse.json(row, { status: 201 });
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status =
          error.code === "NOT_FOUND" ? 403
          : error.code === "VERSION_CONFLICT" ? 409
          : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json(
        { error: status === 500 ? `فشل في إنشاء مراجعة ميزان المراجعة: ${msg}` : msg },
        { status }
      );
    }
  });
}
