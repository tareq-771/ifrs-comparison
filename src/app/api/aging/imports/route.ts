// Phase 6.10 — رفع/سرد استيرادات أعمار الديون (نطاق شركة fail-closed).
// الرفع: JSON body (شبكة خام من العميل) — الخادم يتحقق من كل شيء (untrusted input).

import { NextRequest, NextResponse } from "next/server";
import { guardRead, guardWrite } from "@/lib/api-guard";
import { requireViewAging, requireUploadAging } from "@/lib/session";
import { getClientIp } from "@/lib/audit";
import { createAgingImport, listAgingImports } from "@/lib/aging-server";
import { agingErrorResponse } from "@/lib/aging-http";

export async function POST(req: NextRequest) {
  return guardWrite("/api/aging/imports", async () => {
    try {
      const user = await requireUploadAging();
      const body = await req.json().catch(() => ({}));
      const result = await createAgingImport(
        user,
        {
          companyId: String(body.companyId ?? ""),
          fileName: String(body.fileName ?? "upload"),
          fileType: String(body.fileType ?? ""),
          fileSize: Number(body.fileSize ?? 0),
          fileSha256: String(body.fileSha256 ?? ""),
          asOfDate: String(body.asOfDate ?? ""),
          periodLabel: body.periodLabel != null ? String(body.periodLabel) : undefined,
          grid: body.grid ?? { headers: [], rows: [] },
          mappingOverride: body.mappingOverride ?? undefined,
        },
        getClientIp(req)
      );
      return NextResponse.json(result, { status: 201 });
    } catch (error) {
      return agingErrorResponse(error) ?? NextResponse.json({ error: "فشل رفع ملف الأعمار" }, { status: 500 });
    }
  });
}

export async function GET(req: NextRequest) {
  return guardRead("/api/aging/imports", async () => {
    try {
      const user = await requireViewAging();
      const companyId = req.nextUrl.searchParams.get("companyId") ?? "";
      const imports = await listAgingImports(user, companyId);
      return NextResponse.json({ imports });
    } catch (error) {
      return agingErrorResponse(error) ?? NextResponse.json({ error: "فشل جلب الاستيرادات" }, { status: 500 });
    }
  });
}
