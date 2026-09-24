// Phase 6.10 — تفصيل/حذف استيراد أعمار (الحذف للمسودات بلا لقطات فقط).

import { NextRequest, NextResponse } from "next/server";
import { guardRead, guardWrite } from "@/lib/api-guard";
import { requireDeleteDraftAging, requireViewAging } from "@/lib/session";
import { getClientIp } from "@/lib/audit";
import { deleteAgingImport, getAgingImport } from "@/lib/aging-server";
import { agingErrorResponse } from "@/lib/aging-http";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardRead("/api/aging/imports/[id]", async () => {
    try {
      const user = await requireViewAging();
      const { id } = await ctx.params;
      const companyId = req.nextUrl.searchParams.get("companyId") ?? "";
      const limit = Number(req.nextUrl.searchParams.get("limit") ?? 200);
      const result = await getAgingImport(user, companyId, id, Number.isFinite(limit) ? limit : 200);
      return NextResponse.json(result);
    } catch (error) {
      return agingErrorResponse(error) ?? NextResponse.json({ error: "فشل جلب الاستيراد" }, { status: 500 });
    }
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/aging/imports/[id]", async () => {
    try {
      const user = await requireDeleteDraftAging();
      const { id } = await ctx.params;
      await deleteAgingImport(user, id, getClientIp(req));
      return NextResponse.json({ ok: true });
    } catch (error) {
      return agingErrorResponse(error) ?? NextResponse.json({ error: "فشل حذف الاستيراد" }, { status: 500 });
    }
  });
}
