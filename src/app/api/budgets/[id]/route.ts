// Phase 6.5 — GET تفاصيل موازنة | PUT تحديث بنود المسودة | DELETE حذف مسودة
import { NextRequest, NextResponse } from "next/server";
import { requireManageTrialBalances } from "@/lib/session";
import { guardRead, guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { TrialBalanceError } from "@/lib/trial-balance";
import { companyVisible } from "@/lib/company-access";
import { db } from "@/lib/db";
import { deleteBudget, updateBudgetLines } from "@/lib/budget-server";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardRead("/api/budgets/[id]", async () => {
    try {
      const user = await requireManageTrialBalances();
      const { id } = await ctx.params;
      const row = await db.budget.findUnique({
        where: { id },
        include: {
          company: { select: { code: true, nameAr: true } },
          fiscalYear: { select: { code: true, displayNameAr: true, startDate: true, endDate: true, periodCount: true } },
          lines: { orderBy: [{ statementLineCode: "asc" }, { fiscalPeriodId: "asc" }] },
        },
      });
      if (!row || !companyVisible(user, row.companyId)) {
        return NextResponse.json({ error: "الموازنة غير موجودة.", code: "NOT_FOUND" }, { status: 403 });
      }
      return NextResponse.json({ ...row, lines: row.lines.map((l) => ({ ...l, amountMinor: l.amountMinor.toString() })) });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/budgets/[id]", async () => {
    try {
      const user = await requireManageTrialBalances();
      const { id } = await ctx.params;
      const body = await req.json().catch(() => ({}));
      const row = await updateBudgetLines({ user, ip: getClientIp(req), id, input: body });
      return NextResponse.json(row);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status = error.code === "VERSION_CONFLICT" ? 409 : error.code === "NOT_FOUND" ? 403 : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/budgets/[id]", async () => {
    try {
      const user = await requireManageTrialBalances();
      const { id } = await ctx.params;
      const body = await req.json().catch(() => ({}));
      const row = await deleteBudget({ user, ip: getClientIp(req), id, input: body });
      return NextResponse.json(row);
    } catch (error) {
      if (error instanceof TrialBalanceError) {
        const status = error.code === "VERSION_CONFLICT" ? 409 : error.code === "NOT_FOUND" ? 403 : 400;
        return NextResponse.json({ error: error.message, code: error.code }, { status });
      }
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  });
}
