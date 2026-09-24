// Phase 6.11 — GET /api/insights?companyId=&fiscalYearId=
// سطح واحد يجمع رؤى حتمية من مصادر يملك المستخدم رؤيتها أصلًا:
//   - ميزان المراجعة (يحتاج manageTrialBalances — نفس بوابة واجهات الميزان)
//   - الموازنة: فعلي مقابل موازنة (نفس بوابة getBudgetVariance — manageTrialBalances)
//   - الأعمار: آخر لقطة معتمدة (نفس بوابة الأعمار — viewAging + assertScope)
// لا حقيقة محاسبية ثانية: كل رؤية مشتقة من خدمات التقارير نفسها.
// الصلاحيات لكل مصدر على حدة (fail-closed): ما لا يملك المستخدم رؤيته
// يُحذف من النتيجة بصمت — لا خطأ يكشف وجوده.

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { companyVisible } from "@/lib/company-access";
import { canManageTrialBalances, canViewAging, canViewInsights } from "@/lib/permissions";
import { listTrialBalances, getTrialBalance } from "@/lib/trial-balance-server";
import { getBudgetVariance } from "@/lib/budget-server";
import { listAgingSnapshots, getAgingSnapshot } from "@/lib/aging-server";
import {
  agingStatusInsights, budgetVarianceInsights, countBySeverity, sortInsightsForDisplay,
  tbReadinessInsights, type UnifiedInsight,
} from "@/lib/insights";
import type { AgingInsight, AgingTotals } from "@/lib/aging";
import { guardRead } from "@/lib/api-guard";

export async function GET(req: NextRequest) {
  return guardRead("/api/insights", async () => {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
    if (!canViewInsights(user.permissions, user.role)) {
      return NextResponse.json({ error: "لا تملك صلاحية عرض الرؤى" }, { status: 403 });
    }

    const companyId = (req.nextUrl.searchParams.get("companyId") ?? "").trim();
    const fiscalYearId = (req.nextUrl.searchParams.get("fiscalYearId") ?? "").trim();
    if (!companyId) return NextResponse.json({ error: "companyId إلزامي" }, { status: 400 });
    // نطاق الشركة fail-closed — قبل أي استعلام
    if (!companyVisible(user, companyId)) {
      return NextResponse.json({ error: "الشركة غير موجودة" }, { status: 403 });
    }

    const insights: UnifiedInsight[] = [];
    const sources: Record<string, string> = {};

    // ── 1) ميزان المراجعة — بوابة manageTrialBalances (كواجهات الميزان نفسها) ──
    if (canManageTrialBalances(user.permissions, user.role)) {
      try {
        const tbs = await listTrialBalances(user, companyId);
        const committed = tbs
          .filter((t) => t.status === "COMMITTED")
          .sort((a, b) => (b.committedAt ?? "").localeCompare(a.committedAt ?? ""))[0];
        if (committed) {
          const det = (await getTrialBalance(user, committed.id)) as {
            totalDebitMinor?: string;
            totalCreditMinor?: string;
            lines?: Array<{ mappingStatus?: string }>;
          };
          const unclassified = (det.lines ?? []).filter(
            (l) => l.mappingStatus === "NEEDS_CLASSIFICATION" || l.mappingStatus === "NEEDS_DETAILED_CLASSIFICATION"
          ).length;
          insights.push(
            ...tbReadinessInsights({
              hasCommittedTB: true,
              unclassifiedCount: unclassified,
              totalDebitMinor: det.totalDebitMinor ?? null,
              totalCreditMinor: det.totalCreditMinor ?? null,
            })
          );
          sources.trialBalance = "OK";
        } else {
          insights.push(...tbReadinessInsights({ hasCommittedTB: false, unclassifiedCount: null, totalDebitMinor: null, totalCreditMinor: null }));
          sources.trialBalance = "NO_COMMITTED";
        }
      } catch {
        sources.trialBalance = "SKIPPED";
      }

      // ── 2) الموازنة — نفس خدمة فعلي مقابل الموازنة (YTD) ──
      if (fiscalYearId) {
        try {
          const variance = await getBudgetVariance(user, { companyId, fiscalYearId, granularity: "YTD" });
          insights.push(
            ...budgetVarianceInsights(
              (variance.rows ?? []).map((r) => ({
                statementLineCode: r.statementLineCode,
                lineNameAr: r.lineNameAr ?? null,
                lineNature: r.lineNature,
                budgetMinor: r.budgetMinor ?? null,
                actualMinor: r.actualMinor ?? null,
                favorability: r.favorability,
              }))
            )
          );
          sources.budget = "OK";
        } catch {
          // لا موازنة معتمدة أو بيانات غير مكتملة — لا رؤى موازنة (لا اختراع)
          sources.budget = "SKIPPED";
        }
      } else {
        sources.budget = "NO_FISCAL_YEAR";
      }
    } else {
      sources.trialBalance = "NO_PERMISSION";
      sources.budget = "NO_PERMISSION";
    }

    // ── 3) الأعمار — بوابة viewAging (نفس واجهات الأعمار) ──
    if (canViewAging(user.permissions, user.role)) {
      try {
        const list = (await listAgingSnapshots(user, companyId)) as {
          snapshots?: Array<{ id: string; status: string; reconciliationStatus: string | null; totals: AgingTotals | null }>;
        };
        const approved = (list.snapshots ?? []).filter((s) => s.status === "APPROVED")[0];
        if (approved) {
          insights.push(
            ...agingStatusInsights({
              hasApprovedSnapshot: true,
              reconciliationStatus: approved.reconciliationStatus ?? null,
              totals: approved.totals ?? null,
            })
          );
          // الرؤى المخزنة في اللقطة المعتمدة (مولّدة بقواعد 6.10) — تُمرَّر كما هي مع وحدة AGING
          try {
            const det = (await getAgingSnapshot(user, approved.id)) as {
              snapshot?: { insights?: AgingInsight[] | null };
            };
            for (const ins of det.snapshot?.insights ?? []) {
              insights.push({
                module: "AGING",
                code: `AGING_${ins.code}`,
                severity: ins.severity,
                kind: ins.kind,
                titleAr: ins.titleAr,
                titleEn: ins.titleEn,
                detailAr: ins.detailAr,
                detailEn: ins.detailEn,
                amountMinor: ins.amountMinor,
                pctBp: ins.pctBp,
                affectedCount: ins.affectedCount,
                suggestedActionAr: ins.suggestedActionAr,
                suggestedActionEn: ins.suggestedActionEn,
              });
            }
          } catch {
            // تفاصيل اللقطة غير متاحة — رؤى الحالة أعلاه تكفي
          }
          sources.aging = "OK";
        } else {
          insights.push(...agingStatusInsights({ hasApprovedSnapshot: false, reconciliationStatus: null, totals: null }));
          sources.aging = "NO_APPROVED_SNAPSHOT";
        }
      } catch {
        sources.aging = "SKIPPED";
      }
    } else {
      sources.aging = "NO_PERMISSION";
    }

    const sorted = sortInsightsForDisplay(insights);
    return NextResponse.json({
      companyId,
      fiscalYearId: fiscalYearId || null,
      generatedAt: new Date().toISOString(),
      sources,
      counts: countBySeverity(sorted),
      total: sorted.length,
      insights: sorted,
    });
  });
}
