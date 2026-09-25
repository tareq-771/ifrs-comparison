// 6.8 — بذر قاعدة اختبار محلية معزولة (Windows Local Test Package / بيئات العرض الآمنة).
// أمان صارم: ترفض أي DATABASE_URL لا يحتوي "local-test" — لا تلمس custom.db إطلاقًا.
// المحتوى: مدير اختبار + شركتان + سنوات وفترات + قواعد تصنيف متوافقة مع الجذور 1-4
//          + ميزان مراجعة معتمد (مراجعة 2 بعد تصنيف كامل) + موازنة معتمدة + مجموعة توحيد.
// تشغيل: DATABASE_URL=file:<path>/phase68-local-test.db bun scripts/seed-local-test.ts
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";

const ADMIN_PASSWORD = process.env.LOCAL_TEST_ADMIN_PASSWORD ?? "Preview-68-Admin!";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("local-test")) {
    throw new Error("رفض البذر: هذه الأداة تعمل على قاعدة اختبار *local-test* حصرًا (عزل صارم عن production).");
  }
  const db = new PrismaClient({ log: [], datasources: { db: { url } } });

  // 1) مستخدم مدير اختبار (بيانات اعتماد اختبار معلنة في README — ليست إنتاج)
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await db.user.create({
    data: {
      username: "admin",
      passwordHash,
      displayName: "مدير النظام",
      role: "admin",
      active: true,
      permissions: JSON.stringify({
        view: true, add: true, edit: true, delete: true, groups: true, export: true, settings: true,
        manageUsers: true, manageBackups: true, manageCompanies: true, manageFiscalYears: true,
        managePeriods: true, manageAccountNature: true, manageTrialBalances: true, viewAllCompanies: true,
      }),
    },
  });

  // 2) شركتان وسنتان تقويميتان 2026
  const co = await db.company.create({ data: { code: "SHARIK-1", nameAr: "شركة النموذج", functionalCurrency: "SAR", reportingCurrency: "SAR", status: "ACTIVE" } });
  const co2 = await db.company.create({ data: { code: "SHARIK-2", nameAr: "شركة الفرع", functionalCurrency: "SAR", reportingCurrency: "SAR", status: "ACTIVE" } });
  for (const c of [co, co2]) {
    const fy = await db.fiscalYear.create({ data: { companyId: c.id, code: "FY2026", displayNameAr: "السنة 2026", startDate: "2026-01-01", endDate: "2026-12-31", periodCount: 12 } });
    for (let i = 0; i < 12; i++) {
      const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
      const mm = String(i + 1).padStart(2, "0");
      await db.fiscalPeriod.create({ data: { fiscalYearId: fy.id, ordinal: i + 1, code: `2026-${mm}`, startDate: `2026-${mm}-01`, endDate: `2026-${mm}-${last}`, displayLabel: `شهر ${i + 1}` } });
    }
  }

  // 3) قواعد تصنيف لكل شركة (متوافقة مع الجذور النظامية 1-4)
  for (const [prefix, classification, behavior, lineCode] of [
    ["1101", "ASSET", "BALANCE", "SFP-CASH"],
    ["1102", "ASSET", "BALANCE", "SFP-RECEIVABLES"],
    ["2101", "LIABILITY", "BALANCE", "SFP-LIA-CL"],
    ["2301", "EQUITY", "BALANCE", "SFP-EQUITY"],
    ["3301", "EXPENSE", "FLOW", "PNL-ADMIN-EXPENSES"],
    ["4101", "REVENUE", "FLOW", "PNL-REVENUE"],
  ] as const) {
    const sl = await db.financialStatementLine.findUniqueOrThrow({ where: { code: lineCode } });
    await db.accountNatureRule.create({ data: { companyId: co.id, prefix, classification, aggregationBehavior: behavior, source: "MANUAL", statementLineId: sl.id } });
    await db.accountNatureRule.create({ data: { companyId: co2.id, prefix, classification, aggregationBehavior: behavior, source: "MANUAL", statementLineId: sl.id } });
  }
  await db.equityComponentMapping.create({ data: { companyId: co.id, prefix: "23", componentCode: "SHARE_CAPITAL" } });
  await db.equityComponentMapping.create({ data: { companyId: co2.id, prefix: "23", componentCode: "SHARE_CAPITAL" } });

  // 4) ميزان مراجعة معتمد (سيرفيسات النظام نفسها — لا كتابة مباشرة)
  const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
  const admin = {
    id: "seed", username: "seed", name: "seed", role: "admin",
    permissions: { view: true, add: true, edit: true, delete: true, viewAllCompanies: true, manageTrialBalances: true },
  } as never;
  const fy = await db.fiscalYear.findFirstOrThrow({ where: { companyId: co.id } });
  const line = (code: string, debit: number, credit: number, name = "") => ({ accountCode: code, accountName: name, debit, credit });
  const tb = await createTrialBalance({
    user: admin, ip: "seed",
    input: {
      companyId: co.id, fiscalYearId: fy.id, fromDate: "2026-01-01", toDate: "2026-03-31",
      dataType: "CUMULATIVE_YTD", reason: "بذر قاعدة الاختبار المحلية",
      lines: [
        line("110101", 500000, 0, "الصندوق"),
        line("110201", 200000, 0, "العملاء"),
        line("210101", 0, 150000, "الموردون"),
        line("230101", 0, 350000, "رأس المال"),
        line("410101", 0, 300000, "المبيعات"),
        line("330101", 100000, 0, "الرواتب"),
      ],
    },
  });
  await commitTrialBalance({ user: admin, ip: "seed", id: tb.import.id, input: { version: tb.import.version, reason: "بذر" } });

  // 5) موازنة ربع أول معتمدة (بنود موزعة على الفترات)
  const { createBudget, transitionBudget } = await import("../src/lib/budget-server");
  const p = await db.fiscalPeriod.findMany({ where: { fiscalYearId: fy.id, ordinal: { gte: 1, lte: 3 } }, orderBy: { ordinal: "asc" } });
  const b = await createBudget({
    user: admin, ip: "seed",
    input: {
      companyId: co.id, fiscalYearId: fy.id, budgetType: "MONTHLY", scenario: "BASE", startOrdinal: 1, endOrdinal: 3,
      lines: p.map((pp, i) => ({ statementLineCode: "PNL-REVENUE", fiscalPeriodId: pp.id, amountMinor: ["8000000", "9000000", "12000000"][i] })),
    },
  });
  const s = await transitionBudget({ user: admin, ip: "seed", id: b.id, input: { action: "SUBMIT", version: b.version, reason: "بذر" } });
  await transitionBudget({ user: admin, ip: "seed", id: b.id, input: { action: "APPROVE", version: s.version, reason: "بذر" } });

  // 6) مجموعة توحيد أولي (الشركة الثانية بلا بيانات ⇒ INCOMPLETE_DATA تعليميًا)
  const { createConsolidationGroup } = await import("../src/lib/consolidation-server");
  await createConsolidationGroup({
    user: admin, ip: "seed",
    input: {
      code: "GRP-1", nameAr: "مجموعة النموذج",
      members: [
        { companyId: co.id, effectiveFrom: "2026-01-01", ownershipPercentage: 100 },
        { companyId: co2.id, effectiveFrom: "2026-01-01", ownershipPercentage: 60 },
      ],
    },
  });

  console.log(`SEEDED OK: admin / ${ADMIN_PASSWORD} — شركتان + ميزان معتمد + موازنة + مجموعة`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error("فشل البذر:", e instanceof Error ? e.message : e);
  process.exit(1);
});
