// Phase 6.10 — إعدادات الأعمار: الشرائط + حسابات المدينين (المطابقة) + قواعد الرؤى.
// القراءة بـ viewAging؛ التعديل بـ configureAging (وقواعد الرؤى بمفتاحها الخاص).

import { NextRequest, NextResponse } from "next/server";
import { guardRead, guardWrite } from "@/lib/api-guard";
import { requireConfigureAging, requireViewAging } from "@/lib/session";
import { getClientIp } from "@/lib/audit";
import { getAgingConfig, updateAgingConfig } from "@/lib/aging-server";
import { agingErrorResponse } from "@/lib/aging-http";

export async function GET(req: NextRequest) {
  return guardRead("/api/aging/config", async () => {
    try {
      const user = await requireViewAging();
      const companyId = req.nextUrl.searchParams.get("companyId") ?? "";
      const config = await getAgingConfig(user, companyId);
      return NextResponse.json(config);
    } catch (error) {
      return agingErrorResponse(error) ?? NextResponse.json({ error: "فشل جلب الإعدادات" }, { status: 500 });
    }
  });
}

export async function PUT(req: NextRequest) {
  return guardWrite("/api/aging/config", async () => {
    try {
      const user = await requireConfigureAging();
      const body = await req.json().catch(() => ({}));
      await updateAgingConfig(
        user,
        {
          companyId: String(body.companyId ?? ""),
          buckets: Array.isArray(body.buckets) ? body.buckets : undefined,
          receivableAccounts: Array.isArray(body.receivableAccounts) ? body.receivableAccounts : undefined,
          insightRules: Array.isArray(body.insightRules) ? body.insightRules : undefined,
        },
        getClientIp(req)
      );
      return NextResponse.json({ ok: true });
    } catch (error) {
      return agingErrorResponse(error) ?? NextResponse.json({ error: "فشل حفظ الإعدادات" }, { status: 500 });
    }
  });
}
