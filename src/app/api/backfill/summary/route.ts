// Phase 6.1 — GET /api/backfill/summary — ملخص إداري لعملية الربط الخلفي.
//
// الحد الأدنى للواجهة (تعليمات 6.1 §19): ملخص مرئي للمدير فقط —
//   لا مركز معالجة كبير في هذه المرحلة. يعيد العدّادات بحسب backfillStatus
//   + عينات العزل (NO_COMPANY/NO_PERIOD) + شركات legacy المرتبطة.
// الأداة التنفيذية الفعلية هي CLI خادمي (scripts/phase61-backfill.ts) — هذا
// المسار قراءة فقط ولا يكتب شيئًا إطلاقًا.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status =
    msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

export async function GET() {
  return guardRead("/api/backfill/summary", async () => {
    try {
      await requireAdmin();
      const [byStatus, noCompanySample, noPeriodSample, pendingSample, legacyCompanies, total] =
        await Promise.all([
          db.report.groupBy({ by: ["backfillStatus"], _count: { backfillStatus: true } }),
          db.report.findMany({
            where: { backfillStatus: "NO_COMPANY" },
            select: { id: true, name: true, groupId: true, periodEnd: true, backfillStatus: true },
            take: 10,
            orderBy: { updatedAt: "desc" },
          }),
          db.report.findMany({
            where: { backfillStatus: "NO_PERIOD" },
            select: { id: true, name: true, companyId: true, periodEnd: true, backfillStatus: true },
            take: 10,
            orderBy: { updatedAt: "desc" },
          }),
          db.report.findMany({
            where: { backfillStatus: "PENDING" },
            select: { id: true, name: true, companyId: true, periodEnd: true, backfillStatus: true },
            take: 10,
            orderBy: { updatedAt: "desc" },
          }),
          db.company.findMany({
            where: { legacyGroupId: { not: null } },
            select: { id: true, code: true, nameAr: true, status: true, legacyGroupId: true },
            orderBy: { code: "asc" },
          }),
          db.report.count(),
        ]);
      const statusCounts: Record<string, number> = {};
      for (const row of byStatus) {
        statusCounts[row.backfillStatus ?? "UNSET"] = row._count.backfillStatus;
      }
      const provisionalYears = await db.fiscalYear.count({
        where: { origin: "PROVISIONAL_IMPORTED" },
      });
      return NextResponse.json({
        totalReports: total,
        statusCounts,
        quarantine: {
          noCompany: noCompanySample,
          noPeriod: noPeriodSample,
          pending: pendingSample,
        },
        legacyCompanies,
        provisionalFiscalYears: provisionalYears,
        note:
          "الربط الخلفي التنفيذي عبر الأداة الخادمية scripts/phase61-backfill.ts (dry-run ثم apply) — هذا الملخص قراءة فقط.",
      });
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في جلب ملخص الربط: " + msg : msg },
        { status }
      );
    }
  });
}
