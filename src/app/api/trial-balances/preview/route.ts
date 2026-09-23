// Phase 6.2B — POST /api/trial-balances/preview (معاينة/تحقق بلا أي حفظ)
//
// المدخل: { companyId, fiscalYearId, fromDate, toDate, dataType, lines[] }
// الناتج: الحل الزمني + الإجماليات + الفرق + خلاصة الحالات (FULLY_MAPPED/…)
//         + قائمة الحسابات غير المكتملة بوضوح — من الحل المركزي (6.2A) حصرًا.

import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";
import { TrialBalanceError } from "@/lib/trial-balance";
import { previewTrialBalance } from "@/lib/trial-balance-server";

export async function POST(req: NextRequest) {
  return guardRead("/api/trial-balances/preview", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = await req.json().catch(() => ({}));
      const result = await previewTrialBalance({ user, input: body });
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json(
        { error: status === 500 ? `فشل في معاينة ميزان المراجعة: ${msg}` : msg },
        { status }
      );
    }
  });
}
