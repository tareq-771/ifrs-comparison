// Phase 6.11 — بذر موازنة معتمدة لقاعدة واجهات dev-ui-610* (لقبول المتصفح).
// أمان صارم: تعمل على DATABASE_URL يحتوي "dev-ui-610" حصرًا — لا تلمس custom.db إطلاقًا.
// المحتوى: موازنة MONTHLY/BASE لفترات 1-3 على شركة الأعمار + اعتماد عبر دوال الخادم الرسمية
//          (createBudget + transitionBudget — بلا تعديل مباشر للجداول).
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-ui-610-accept.db bun scripts/seed-611-budget.ts
import { PrismaClient } from "@prisma/client";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("dev-ui-610")) {
    throw new Error("رفض البذر: هذه الأداة تعمل على قاعدة *dev-ui-610* حصرًا.");
  }
  const db = new PrismaClient({ log: [], datasources: { db: { url } } });
  const admin = {
    id: "seed", username: "seed", name: "seed", role: "admin",
    permissions: { view: true, add: true, edit: true, delete: true, viewAllCompanies: true, manageTrialBalances: true },
  } as never;

  const co = await db.company.findFirstOrThrow({ where: { code: "AGING-CO" } });
  const fy = await db.fiscalYear.findFirstOrThrow({ where: { companyId: co.id, code: "FY2026" } });

  const existing = await db.budget.count({ where: { companyId: co.id, status: { in: ["APPROVED", "LOCKED"] } } });
  const { createBudget, transitionBudget } = await import("../src/lib/budget-server");
  const periods = await db.fiscalPeriod.findMany({ where: { fiscalYearId: fy.id, ordinal: { gte: 1, lte: 3 } }, orderBy: { ordinal: "asc" } });
  const revenueAmounts = ["8000000", "9000000", "12000000"]; // فعلي أعلى في الفترة 3 ⇒ "أعلى من الموازنة"
  const expenseAmounts = ["2000000", "2500000", "5000000"]; // الفترة 3 فعلي أعلى ⇒ "تجاوز الموازنة" (وفق ميزان 610)
  const lines = [
    ...periods.map((pp, i) => ({ statementLineCode: "PNL-REVENUE", fiscalPeriodId: pp.id, amountMinor: revenueAmounts[i] })),
    ...periods.map((pp, i) => ({ statementLineCode: "PNL-ADMIN-EXPENSES", fiscalPeriodId: pp.id, amountMinor: expenseAmounts[i] })),
  ];
  let bId = "(موجودة مسبقًا)";
  if (existing === 0) {
  const b = await createBudget({
    user: admin, ip: "seed-611",
    input: { companyId: co.id, fiscalYearId: fy.id, budgetType: "MONTHLY", scenario: "BASE", startOrdinal: 1, endOrdinal: 3, lines },
  });
  const s = await transitionBudget({ user: admin, ip: "seed-611", id: b.id, input: { action: "SUBMIT", version: b.version, reason: "بذر 6.11" } });
  await transitionBudget({ user: admin, ip: "seed-611", id: b.id, input: { action: "APPROVE", version: s.version, reason: "بذر 6.11" } });
  bId = b.id;
  }

  // مراجعة صريحة (مسار Revision الإلزامي) على الميزان المعتمد: إضافة إيراد/مصروف فعلي للمقارنة
  // (متوازن: 33,200,000 = 33,200,000 — نفس المدى/النوع إجباريًا)
  const { createTrialBalanceRevision, createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
  const committedTb = await db.trialBalanceImport.findFirstOrThrow({
    where: { companyId: co.id, fiscalYearId: fy.id, status: "COMMITTED" },
    orderBy: { committedAt: "desc" },
    select: { id: true, fromDate: true, toDate: true, dataType: true },
  });
  // مسودة مفتوحة من تشغيل سابق؟ أعد استخدامها (بذر idempotent) وإلا أنشئ مراجعة جديدة
  const openDraft = await db.trialBalanceImport.findFirst({
    where: { companyId: co.id, status: "DRAFT", supersedesImportId: committedTb.id },
    orderBy: { revisionNumber: "desc" },
    select: { id: true, version: true },
  });
  const draft = openDraft
    ? ({ id: openDraft.id, version: openDraft.version } as { id: string; version: number })
    : ((await createTrialBalanceRevision({
        user: admin, ip: "seed-611", id: committedTb.id, input: { reason: "بذر 6.11 — إضافة إيراد ومصروف فعلي للمقارنة" },
      })) as { id: string; version: number });
  const replaced = await createTrialBalance({
    user: admin, ip: "seed-611",
    input: {
      revisionTargetId: draft.id, version: draft.version,
      fromDate: committedTb.fromDate, toDate: committedTb.toDate, dataType: committedTb.dataType, reason: "بذر 6.11 — سطور الفعلي الكاملة",
      lines: [
        { accountCode: "1101", accountName: "النقدية", debit: 19500000, credit: 0 },
        { accountCode: "1102", accountName: "الذمم المدينة", debit: 1200000, credit: 0 },
        { accountCode: "3301", accountName: "مصروفات إدارية", debit: 12500000, credit: 0 },
        { accountCode: "2101", accountName: "الدائنون", debit: 0, credit: 1200000 },
        { accountCode: "4101", accountName: "الإيرادات", debit: 0, credit: 30000000 },
        { accountCode: "3101", accountName: "رأس المال", debit: 0, credit: 2000000 },
      ] as never,
    },
  });
  const replacedVersion = (replaced as { import?: { version?: number } })?.import?.version ?? draft.version;
  await commitTrialBalance({ user: admin, ip: "seed-611", id: draft.id, input: { version: replacedVersion, reason: "بذر 6.11" } });
  console.log(`SEEDED BUDGET OK: ${bId} + TB revision ${draft.id} (v${replacedVersion})`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error("فشل البذر:", e instanceof Error ? e.message : e);
  process.exit(1);
});
