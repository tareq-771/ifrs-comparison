// Phase 6.5 — GET قائمة الموازنات | POST إنشاء مسودة موازنة
import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead, guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { createBudget, listBudgets } from "@/lib/budget-server";

export async function GET() {
  return guardRead("/api/budgets", async () => {
    try {
      const user = await requireManageTrialBalances();
      return NextResponse.json(await listBudgets(user));
    } catch (error) {
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: status === 500 ? `فشل في جلب الموازنات: ${msg}` : msg }, { status });
    }
  });
}

export async function POST(req: NextRequest) {
  return guardWrite("/api/budgets", async () => {
    try {
      const user = await requireManageTrialBalances();
      const body = await req.json().catch(() => ({}));
      const row = await createBudget({ user, ip: getClientIp(req), input: body });
      return NextResponse.json(row, { status: 201 });
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.code === "NOT_FOUND" ? 403 : 400 });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: status === 500 ? `فشل في إنشاء الموازنة: ${msg}` : msg }, { status });
    }
  });
}
