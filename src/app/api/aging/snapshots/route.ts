// Phase 6.10 — إنشاء/سرد لقطات الأعمار (تجميد + تحليل + مطابقة + رؤى + مخاطر).

import { NextRequest, NextResponse } from "next/server";
import { guardRead, guardWrite } from "@/lib/api-guard";
import { requireUploadAging, requireViewAging } from "@/lib/session";
import { getClientIp } from "@/lib/audit";
import { createAgingSnapshot, listAgingSnapshots } from "@/lib/aging-server";
import { agingErrorResponse } from "@/lib/aging-http";

export async function POST(req: NextRequest) {
  return guardWrite("/api/aging/snapshots", async () => {
    try {
      const user = await requireUploadAging();
      const body = await req.json().catch(() => ({}));
      const result = await createAgingSnapshot(
        user,
        {
          importId: String(body.importId ?? ""),
          periodLabel: body.periodLabel != null ? String(body.periodLabel) : undefined,
          acknowledgeApprovedDuplicate: body.acknowledgeApprovedDuplicate === true,
        },
        getClientIp(req)
      );
      return NextResponse.json(result, { status: 201 });
    } catch (error) {
      return agingErrorResponse(error) ?? NextResponse.json({ error: "فشل إنشاء اللقطة" }, { status: 500 });
    }
  });
}

export async function GET(req: NextRequest) {
  return guardRead("/api/aging/snapshots", async () => {
    try {
      const user = await requireViewAging();
      const companyId = req.nextUrl.searchParams.get("companyId") ?? "";
      const result = await listAgingSnapshots(user, companyId);
      return NextResponse.json(result);
    } catch (error) {
      return agingErrorResponse(error) ?? NextResponse.json({ error: "فشل جلب اللقطات" }, { status: 500 });
    }
  });
}
