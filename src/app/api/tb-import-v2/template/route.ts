// Phase 7.0 (V1 closure) — GET /api/tb-import-v2/template
// تنزيل قالب/مثال الاستيراد — ?format=xlsx (افتراضي) | csv
// توليد حتمي من مكتبة نقية — بلا أي بيانات إنتاج. قراءة صرفة (لا كتابة إطلاقًا).

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";
import {
  buildTbImportTemplateCsv,
  buildTbImportTemplateXlsx,
} from "@/lib/tb-import-template";

export async function GET(req: NextRequest) {
  return guardRead("/api/tb-import-v2/template", async () => {
    try {
      await requireManageTrialBalances();
      const format = (req.nextUrl.searchParams.get("format") ?? "xlsx").toLowerCase();
      if (format === "csv") {
        const { text, fileName } = buildTbImportTemplateCsv();
        return new NextResponse(text, {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${fileName}"`,
            "Cache-Control": "no-store",
          },
        });
      }
      const { bytes, fileName } = buildTbImportTemplateXlsx();
      return new NextResponse(bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: status === 500 ? `فشل توليد قالب الاستيراد: ${msg}` : msg }, { status });
    }
  });
}
