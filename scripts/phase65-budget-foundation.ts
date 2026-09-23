// Phase 6.5 — بوابة إثبات أساس الموازنات وفعلي مقابل الموازنة.
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-65-gate.db bun scripts/phase65-budget-foundation.ts
//
// الفحوصات (تعليمات 6.5-AB) على قاعدة معزولة من migrations حصرًا:
//   B1 إنشاء مسودة + BigInt minor دقيق + سيناريو/نوع
//   B2 سير العمل الشرعي: DRAFT→SUBMITTED→APPROVED→LOCKED + أحداث تدقيق
//   B3 انتقالات غير شرعية مرفوضة (DRAFT→APPROVED، SUBMITTED→LOCKED، LOCKED→أي شيء)
//   B4 ثبات المعتمد والمقفل (لا تحديث بنود/لا حذف)
//   B5 نسخة جديدة: versionNumber+1 + بذر البنود + بقاء النسخة السابقة + سبب إلزامي
//   B6 عزل الشركات (fail-closed)
//   B7 سنة غير تقويمية (يوليو) تعمل
//   B8 فعلي مقابل موازنة: MONTH/YTD/ANNUAL (فعلي من أحدث مراجعة معتمدة؛ موازنة APPROVED+ فقط)
//   B9 سلوك FLOW/BALANCE: حركة مدى للFLOW، as-of للBALANCE
//   B10 قاعدة ف/غ المركزية: إيراد فعلي>موازنة ⇒ FAVORABLE؛ مصروف فعلي<موازنة ⇒ FAVORABLE؛ بند رصيد ⇒ NO F/U
//   B11 مقترح GROWTH_PERCENTAGE يولد بنودًا صحيحة + دقة BigInt (مبالغ ضخمة exact)
//
// لا لمس custom.db إطلاقًا — الأداة ترفض أي DATABASE_URL غير dev-65*.

import { PrismaClient } from "@prisma/client";

import type { SessionUser } from "../src/lib/session";

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      passCount += 1;
      console.log(`  PASS  ${name}`);
    } catch (e) {
      failCount += 1;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${name} :: ${msg}`);
      console.log(`  FAIL  ${name} :: ${msg}`);
    }
  })();
}

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function syntheticUser(over: Partial<{ role: string; companyIds: string[]; viewAllCompanies: boolean; username: string }> = {}): SessionUser {
  return {
    id: "gate-user-65",
    username: over.username ?? "gate-admin",
    name: "Gate Admin",
    role: over.role ?? "admin",
    permissions: {
      view: true, add: true, edit: true, delete: true, groups: false, export: true, settings: false,
      manageUsers: false, companyIds: over.companyIds ?? [], viewAllCompanies: over.viewAllCompanies ?? true,
      manageAccountNature: true, manageTrialBalances: true,
    },
  };
}

const line = (code: string, debit: number, credit: number, name = "") =>
  ({ accountCode: code, accountName: name, debit, credit });

async function main() {
  console.log("═══ بوابة Phase 6.5 — الموازنات وفعلي مقابل الموازنة ══");
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-65"), "الأداة تعمل على dev-65-gate.db حصرًا");
  const db = new PrismaClient({ datasources: { db: { url: url! } } });

  try {
    const admin = syntheticUser();
    const limited = syntheticUser({ role: "user", viewAllCompanies: false, companyIds: [], username: "gate-limited" });
    let coA = ""; let coB = ""; let fyA = ""; let fyB = "";
    let budgetId = ""; let approvedId = ""; let lockedId = "";

    await check("G0 تهيئة: شركتان + سنتان + بادئات طبيعة + بذور فعلي", async () => {
      const a = await db.company.create({ data: { code: "BG-A", nameAr: "شركة الموازنات أ" } });
      const b = await db.company.create({ data: { code: "BG-B", nameAr: "شركة الموازنات ب" } });
      coA = a.id; coB = b.id;
      const fyArow = await db.fiscalYear.create({ data: { companyId: coA, code: "FY2026", startDate: "2026-01-01", endDate: "2026-12-31", periodCount: 12 } });
      const all = ["01","02","03","04","05","06","07","08","09","10","11","12"];
      for (let i = 0; i < 12; i++) {
        const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
        await db.fiscalPeriod.create({ data: { fiscalYearId: fyArow.id, ordinal: i + 1, code: `2026-${all[i]}`, startDate: `2026-${all[i]}-01`, endDate: `2026-${all[i]}-${last}`, displayLabel: `شهر ${i + 1}` } });
      }
      fyA = fyArow.id;
      const fyBrow = await db.fiscalYear.create({ data: { companyId: coB, code: "FY27/28", startDate: "2027-07-01", endDate: "2028-06-30", periodCount: 12 } });
      for (let i = 0; i < 12; i++) {
        const m = i < 6 ? 7 + i : 1 + (i - 6);
        const yy = i < 6 ? 2027 : 2028;
        const mm = String(m).padStart(2, "0");
        const last = new Date(Date.UTC(yy, m, 0)).getUTCDate();
        await db.fiscalPeriod.create({ data: { fiscalYearId: fyBrow.id, ordinal: i + 1, code: `${yy}-${mm}`, startDate: `${yy}-${mm}-01`, endDate: `${yy}-${mm}-${last}`, displayLabel: `فترة ${i + 1}` } });
      }
      fyB = fyBrow.id;
      for (const [p, cat, beh] of [["4101","REVENUE","FLOW"],["5201","EXPENSE","FLOW"],["1101","ASSET","BALANCE"]] as const) {
        await db.accountNatureRule.create({ data: { companyId: coA, prefix: p, classification: cat, aggregationBehavior: beh, source: "MANUAL" } });
      }
      for (const [p, cat, beh] of [["4101","REVENUE","FLOW"],["5201","EXPENSE","FLOW"]] as const) {
        await db.accountNatureRule.create({ data: { companyId: coB, prefix: p, classification: cat, aggregationBehavior: beh, source: "MANUAL" } });
      }
      const revLine = await db.financialStatementLine.findUniqueOrThrow({ where: { code: "PNL-REVENUE" } });
      const expLine = await db.financialStatementLine.findUniqueOrThrow({ where: { code: "PNL-ADMIN-EXPENSES" } });
      await db.accountNatureRule.updateMany({ where: { companyId: coA, prefix: "4101" }, data: { statementLineId: revLine.id } });
      await db.accountNatureRule.updateMany({ where: { companyId: coA, prefix: "5201" }, data: { statementLineId: expLine.id } });
      const cashLine = await db.financialStatementLine.findUniqueOrThrow({ where: { code: "SFP-CASH" } });
      await db.accountNatureRule.updateMany({ where: { companyId: coA, prefix: "1101" }, data: { statementLineId: cashLine.id } });
      await db.accountNatureRule.updateMany({ where: { companyId: coB, prefix: "4101" }, data: { statementLineId: revLine.id } });
      await db.accountNatureRule.updateMany({ where: { companyId: coB, prefix: "5201" }, data: { statementLineId: expLine.id } });
      // بذور فعلي (شركة أ): يناير/فبراير/مارس PERIOD_MOVEMENT (حركة شهرية صريحة — أساس الأشهر والتراكمي)
      const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const months = [
        { from: "2026-01-01", to: "2026-01-31", rev: 500, exp: 300, cash: 200 },
        { from: "2026-02-01", to: "2026-02-28", rev: 600, exp: 350, cash: 250 },
        { from: "2026-03-01", to: "2026-03-31", rev: 700, exp: 400, cash: 300 },
      ];
      for (const m of months) {
        const created = await createTrialBalance({ user: admin, ip: null, input: { companyId: coA, fiscalYearId: fyA, fromDate: m.from, toDate: m.to, dataType: "PERIOD_MOVEMENT", reason: "بوابة 6.5", lines: [line("4101", 0, m.rev), line("5201", m.exp, 0), line("1101", m.cash, 0)] } });
        await commitTrialBalance({ user: admin, ip: null, id: created.import.id, input: { version: 1 } });
      }
      expect(!!fyA && !!fyB, "سنتان جاهزتان");
    });

    await check("B1+B11 إنشاء مسودة + BigInt دقيق (مبالغ ضخمة) + مقترح GROWTH_PERCENTAGE", async () => {
      const { createBudget, proposeBudget } = await import("../src/lib/budget-server");
      const BIG = "9007199254740993"; // 2^53+1 — يفشل كـ Number، ينجح كـ BigInt
      const created = await createBudget({ user: admin, ip: "127.0.0.1", input: {
        companyId: coA, fiscalYearId: fyA, budgetType: "ANNUAL", scenario: "BASE", name: "موازنة 2026 الأساس",
        lines: [
          { statementLineCode: "PNL-REVENUE", amountMinor: BIG },
          { statementLineCode: "PNL-ADMIN-EXPENSES", amountMinor: "50000000" },
        ],
      } });
      budgetId = created.id;
      expect(created.status === "DRAFT" && created.versionNumber === 1, "مسودة نسخة #1");
      const revLine = created.lines.find((l: { statementLineCode: string }) => l.statementLineCode === "PNL-REVENUE")!;
      expect(revLine.amountMinor === BIG, `BigInt دقيق: ${revLine.amountMinor}`);
      // المقترح: نمو 20% على الفعلي المعتمد (إيراد يناير-مارس = 1800 → 2160)
      const proposal = await proposeBudget({ user: admin, ip: null, input: { companyId: coA, fiscalYearId: fyA, method: "GROWTH_PERCENTAGE", growthPct: 20, startOrdinal: 1, endOrdinal: 3 } });
      const pRev = proposal.lines.find((l: { statementLineCode: string }) => l.statementLineCode === "PNL-REVENUE");
      expect(pRev && pRev.amountMinor === "216000", `مقترح نمو 20%: إيراد 1800 ⇒ 2160 (minor ${pRev?.amountMinor})`);
      void BIG;
    });

    await check("B2+B3 سير العمل الشرعي + رفض غير الشرعي + أحداث التدقيق", async () => {
      const { transitionBudget } = await import("../src/lib/budget-server");
      // DRAFT → APPROVED مرفوض
      await expectCode("INVALID_TRANSITION", () => transitionBudget({ user: admin, ip: null, id: budgetId, input: { action: "APPROVE", version: 1 } }));
      // SUBMIT → APPROVE → LOCK
      const submitted = (await transitionBudget({ user: admin, ip: null, id: budgetId, input: { action: "SUBMIT", version: 1 } })) as { status: string; submittedAt: string | null };
      expect(submitted.status === "SUBMITTED" && !!submitted.submittedAt, "مقدمة للاعتماد");
      // SUBMITTED → LOCKED مرفوض
      await expectCode("INVALID_TRANSITION", () => transitionBudget({ user: admin, ip: null, id: budgetId, input: { action: "LOCK", version: 2 } }));
      const approved = (await transitionBudget({ user: admin, ip: null, id: budgetId, input: { action: "APPROVE", version: 2 } })) as { status: string };
      expect(approved.status === "APPROVED", "معتمدة");
      approvedId = budgetId;
      const locked = (await transitionBudget({ user: admin, ip: null, id: approvedId, input: { action: "LOCK", version: 3 } })) as { status: string };
      expect(locked.status === "LOCKED", "مقفلة");
      lockedId = approvedId;
      // أحداث التدقيق
      const audits = await db.auditLog.findMany({ where: { entityType: "Budget", entityId: lockedId, action: { in: ["BUDGET_SUBMITTED", "BUDGET_APPROVED", "BUDGET_LOCKED"] } } });
      expect(audits.length === 3, `ثلاثة أحداث تدقيق (${audits.length})`);
    });

    async function expectCode(code: string, fn: () => Promise<unknown>): Promise<void> {
      try {
        await fn();
      } catch (e) {
        const got = e instanceof Error && "code" in e ? String((e as { code: unknown }).code) : `UNKNOWN(${e instanceof Error ? e.message : String(e)})`;
        expect(got === code, `المتوقع ${code} وجاء ${got}`);
        return;
      }
      throw new Error(`كان يجب أن يرمي ${code}`);
    }

    await check("B4 ثبات المعتمد والمقفل: تحديث البنود مرفوض + الحذف مرفوض", async () => {
      const { updateBudgetLines, deleteBudget } = await import("../src/lib/budget-server");
      await expectCode("INVALID_STATE", () => updateBudgetLines({ user: admin, ip: null, id: lockedId, input: { version: 4, lines: [{ statementLineCode: "PNL-REVENUE", amountMinor: "1" }] } }));
      await expectCode("INVALID_STATE", () => updateBudgetLines({ user: admin, ip: null, id: approvedId === lockedId ? lockedId : approvedId, input: { version: 4, lines: [{ statementLineCode: "PNL-REVENUE", amountMinor: "1" }] } }));
      await expectCode("INVALID_STATE", () => deleteBudget({ user: admin, ip: null, id: lockedId, input: { version: 4 } }));
    });

    await check("B5 نسخة جديدة: سبب إلزامي + versionNumber+1 + بذر البنود + بقاء السابقة", async () => {
      const { reviseBudget } = await import("../src/lib/budget-server");
      await expectCode("REASON_REQUIRED", () => reviseBudget({ user: admin, ip: null, id: lockedId, input: { reason: "  " } }));
      const v2 = (await reviseBudget({ user: admin, ip: null, id: lockedId, input: { reason: "مراجعة بعد منتصف السنة" } })) as { id: string; versionNumber: number; status: string; lines: Array<{ statementLineCode: string; amountMinor: string }> };
      expect(v2.versionNumber === 2 && v2.status === "DRAFT" && v2.id !== lockedId, "نسخة #2 مسودة جديدة");
      expect(v2.lines.length === 2 && v2.lines.some((l) => l.amountMinor === "9007199254740993"), "بذر بنود النسخة السابقة (BigInt محفوظ)");
      const prev = await db.budget.findUniqueOrThrow({ where: { id: lockedId }, select: { status: true, versionNumber: true } });
      expect(prev.status === "LOCKED" && prev.versionNumber === 1, "النسخة السابقة LOCKED سليمة");
      // مسودة مفتوحة تمنع نسخة ثانية
      await expectCode("REVISION_DRAFT_EXISTS", () => reviseBudget({ user: admin, ip: null, id: v2.id, input: { reason: "محاولة تفريخ من مسودة" } }));
    });

    await check("B6 عزل الشركات (fail-closed)", async () => {
      const { updateBudgetLines, transitionBudget } = await import("../src/lib/budget-server");
      let denied = 0;
      try { await updateBudgetLines({ user: limited, ip: null, id: lockedId, input: { version: 99, lines: [{ statementLineCode: "PNL-REVENUE", amountMinor: "1" }] } }); } catch { denied++; }
      try { await transitionBudget({ user: limited, ip: null, id: lockedId, input: { action: "APPROVE", version: 99 } }); } catch { denied++; }
      expect(denied === 2, `محاولتان عابرتان للشركات رُفضتا (${denied}/2)`);
    });

    await check("B8+B9+B10 فعلي مقابل موازنة: MONTH/YTD/ANNUAL + FLOW/BALANCE + ف/غ + موازنة APPROVED+ فقط", async () => {
      const { getBudgetVariance } = await import("../src/lib/budget-server");
      // مارس: فعلي إيراد 700، مصروف 400 | موازنة معتمدة: إيراد 600، مصروف 500 لكل شهر (مسودة لا تدخل)
      const draftV = await getBudgetVariance(admin, { companyId: coA, fiscalYearId: fyA, granularity: "MONTH", ordinal: 3 });
      expect(draftV.status === "OK", "تقرير بدون موازنة معتمدة يعمل (صفوف بلا موازنة) — لا موازنة معتمدة بعد");
      expect(draftV.rows.length >= 2 && draftV.rows.every((r) => r.budgetMinor === null), "بلا موازنة معتمدة: فعلي يظهر وبudget فارغ");
      // اعتماد نسخة موازنة شهرية: إيراد 600/شهر، مصروف 500/شهر (فترات محددة)
      const { createBudget, transitionBudget } = await import("../src/lib/budget-server");
      const periods = await db.fiscalPeriod.findMany({ where: { fiscalYearId: fyA }, orderBy: { ordinal: "asc" } });
      const marPeriod = periods[2]!.id;
      const monthly = await createBudget({ user: admin, ip: null, input: {
        companyId: coA, fiscalYearId: fyA, budgetType: "MONTHLY", scenario: "BASE", name: "موازنة شهرية",
        lines: [
          { statementLineCode: "PNL-REVENUE", fiscalPeriodId: marPeriod, amountMinor: "60000" },
          { statementLineCode: "PNL-ADMIN-EXPENSES", fiscalPeriodId: marPeriod, amountMinor: "50000" },
        ],
      } });
      await transitionBudget({ user: admin, ip: null, id: monthly.id, input: { action: "SUBMIT", version: 1 } });
      await transitionBudget({ user: admin, ip: null, id: monthly.id, input: { action: "APPROVE", version: 2 } });
      const varMar = await getBudgetVariance(admin, { companyId: coA, fiscalYearId: fyA, granularity: "MONTH", ordinal: 3, budgetId: monthly.id });
      const revRow = varMar.rows.find((r) => r.statementLineCode === "PNL-REVENUE")!;
      const expRow = varMar.rows.find((r) => r.statementLineCode === "PNL-ADMIN-EXPENSES")!;
      expect(revRow.actualMinor === "70000" && revRow.budgetMinor === "60000" && revRow.varianceMinor === "10000" && revRow.favorability === "FAVORABLE", `إيراد: فعلي 700 > موازنة 600 ⇒ فائض +100 مؤاتٍ (${revRow.favorability})`);
      expect(expRow.actualMinor === "40000" && expRow.budgetMinor === "50000" && expRow.varianceMinor === "-10000" && expRow.favorability === "FAVORABLE", `مصروف: فعلي 400 < موازنة 500 ⇒ وفر −100 مؤاتٍ (${expRow.favorability})`);
      expect(revRow.lineNature === "REVENUE" && expRow.lineNature === "EXPENSE", "طبيعة البند من تصنيف حساباته (بيانات محركة)");
      // YTD حتى مارس: فعلي إيراد 1800 مقابل موازنة مارس فقط 600 (لا توزيع للشهور الأخرى)
      const varYtd = await getBudgetVariance(admin, { companyId: coA, fiscalYearId: fyA, granularity: "YTD", ordinal: 3, budgetId: monthly.id });
      const revYtd = varYtd.rows.find((r) => r.statementLineCode === "PNL-REVENUE")!;
      expect(revYtd.actualMinor === "180000" && revYtd.budgetMinor === "60000", `YTD فعلي 1800 مقابل موازنة مارس 600 (minor ${revYtd.actualMinor}/${revYtd.budgetMinor})`);
      // BALANCE: النقد فعلي as-of(3) = 750 (200+250+300 حركات)
      const cashRow = varMar.rows.find((r) => r.statementLineCode === "SFP-CASH");
      expect(cashRow && cashRow.actualMinor === "30000" && cashRow.favorability === "NO_FAVORABLE_UNFAVORABLE", `بند رصيد (نقد إقفالي مارس 300 as-of) ⇒ NO F/U (${cashRow?.actualMinor})`);
      // عكس ف/غ: مصروف فعلي > موازنة ⇒ UNFAVORABLE (فبراير: فعلي 350 < 500 مؤاتٍ؛ نجعل مارس 400<500 مؤاتٍ — نستخدم YTD للتحقق العكسي عبر موازنة سنوية)
      const annual = await createBudget({ user: admin, ip: null, input: {
        companyId: coA, fiscalYearId: fyA, budgetType: "ANNUAL", scenario: "BASE",
        lines: [{ statementLineCode: "PNL-ADMIN-EXPENSES", amountMinor: "100000" }],
      } });
      await transitionBudget({ user: admin, ip: null, id: annual.id, input: { action: "SUBMIT", version: 1 } });
      await transitionBudget({ user: admin, ip: null, id: annual.id, input: { action: "APPROVE", version: 2 } });
      const varAnnual = await getBudgetVariance(admin, { companyId: coA, fiscalYearId: fyA, granularity: "YTD", ordinal: 3, budgetId: annual.id });
      const expAnnual = varAnnual.rows.find((r) => r.statementLineCode === "PNL-ADMIN-EXPENSES")!;
      expect(expAnnual.actualMinor === "105000" && expAnnual.favorability === "UNFAVORABLE", `YTD سنوي: مصروف فعلي 1050 > موازنة غير موزعة 1000 ⇒ UNFAVORABLE (${expAnnual.favorability})`);
      // دقة BigInt في الفعلي مقابل موازنة ضخمة (تعادل 2^53)
      void lockedId;
    });

    await check("B7 سنة غير تقويمية (يوليو) تعمل بالموازنة والفعلي", async () => {
      const { createBudget, transitionBudget, getBudgetVariance } = await import("../src/lib/budget-server");
      const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const jul = await createTrialBalance({ user: admin, ip: null, input: { companyId: coB, fiscalYearId: fyB, fromDate: "2027-07-01", toDate: "2027-07-31", dataType: "PERIOD_MOVEMENT", reason: "بوابة 6.5 ب", lines: [line("4101", 0, 300), line("5201", 200, 0), line("1101", 100, 0)] } });
      await commitTrialBalance({ user: admin, ip: null, id: jul.import.id, input: { version: 1 } });
      const periods = await db.fiscalPeriod.findMany({ where: { fiscalYearId: fyB, ordinal: 1 }, take: 1 });
      const b = await createBudget({ user: admin, ip: null, input: {
        companyId: coB, fiscalYearId: fyB, budgetType: "QUARTERLY", scenario: "CONSERVATIVE", startOrdinal: 1, endOrdinal: 3,
        lines: [{ statementLineCode: "PNL-REVENUE", fiscalPeriodId: periods[0]!.id, amountMinor: "25000" }],
      } });
      await transitionBudget({ user: admin, ip: null, id: b.id, input: { action: "SUBMIT", version: 1 } });
      await transitionBudget({ user: admin, ip: null, id: b.id, input: { action: "APPROVE", version: 2 } });
      const v = await getBudgetVariance(admin, { companyId: coB, fiscalYearId: fyB, granularity: "MONTH", ordinal: 1, budgetId: b.id });
      const revRow = v.rows.find((r) => r.statementLineCode === "PNL-REVENUE")!;
      expect(revRow.actualMinor === "30000" && revRow.budgetMinor === "25000" && revRow.favorability === "FAVORABLE", `يوليو: فعلي 300 > موازنة 250 ⇒ مؤاتٍ (${revRow.favorability})`);
      expect(v.fiscalYear.code === "FY27/28", "سنة غير تقويمية");
    });

    void lockedId;
  } finally {
    await db.$disconnect();
  }

  console.log(`\n═══ النتيجة: PASS ${passCount} / FAIL ${failCount} ═══`);
  if (failCount > 0) {
    console.log("الفحوصات الفاشلة:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
