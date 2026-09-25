// Phase 6.10 — بذر قاعدة اختبار واجهة معزولة لأعمار الديون.
// أمان صارم: تعمل على DATABASE_URL يحتوي "dev-ui-610" حصرًا — لا تلمس custom.db إطلاقًا.
// المحتوى: مدير + معتمد (للفصل بين الرفع والاعتماد) + شركة وسنة + قواعد تصنيف
//          + ميزان معتمد + ربط حسابات مدينين + استيراد أعمار مطابق + لقطة مسودة.
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-ui-610.db bunx prisma migrate deploy
//        DATABASE_URL=file:/home/z/my-project/db/dev-ui-610.db bun scripts/seed-610-ui.ts
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";

const ADMIN_PASSWORD = process.env.LOCAL_TEST_ADMIN_PASSWORD ?? "Preview-68-Admin!";
const APPROVER_PASSWORD = process.env.LOCAL_TEST_APPROVER_PASSWORD ?? "Preview-68-Approver!";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("dev-ui-610")) {
    throw new Error("رفض البذر: هذه الأداة تعمل على قاعدة *dev-ui-610* حصرًا (عزل صارم عن production).");
  }
  const db = new PrismaClient({ log: [], datasources: { db: { url } } });

  const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const admin = await db.user.create({
    data: {
      username: "admin", passwordHash: adminHash, displayName: "مدير النظام", role: "admin", active: true,
      permissions: JSON.stringify({
        view: true, add: true, edit: true, delete: true, groups: true, export: true, settings: true,
        manageUsers: true, manageBackups: true, manageCompanies: true, manageFiscalYears: true,
        managePeriods: true, manageAccountNature: true, manageTrialBalances: true, viewAllCompanies: true,
      }),
    },
  });
  const approverHash = await bcrypt.hash(APPROVER_PASSWORD, 10);
  await db.user.create({
    data: {
      username: "approver", passwordHash: approverHash, displayName: "معتمد الأعمار", role: "user", active: true,
      permissions: JSON.stringify({
        view: true, add: false, edit: false, delete: false, groups: false, export: true, settings: false,
        manageUsers: false, viewAging: true, viewInsights: true, approveAgingSnapshot: true,
        uploadAging: false, configureAging: false, viewAllCompanies: true,
      }),
    },
  });

  const co = await db.company.create({ data: { code: "AGING-CO", nameAr: "شركة الأعمار النموذجية", functionalCurrency: "SAR", reportingCurrency: "SAR", status: "ACTIVE" } });
  const fy = await db.fiscalYear.create({ data: { companyId: co.id, code: "FY2026", displayNameAr: "السنة 2026", startDate: "2026-01-01", endDate: "2026-12-31", periodCount: 12 } });
  for (let i = 0; i < 12; i++) {
    const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
    const mm = String(i + 1).padStart(2, "0");
    await db.fiscalPeriod.create({ data: { fiscalYearId: fy.id, ordinal: i + 1, code: `2026-${mm}`, startDate: `2026-${mm}-01`, endDate: `2026-${mm}-${last}`, displayLabel: `شهر ${i + 1}` } });
  }
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
  }

  const sessionAdmin = { id: admin.id, username: "admin", name: "مدير النظام", role: "admin", permissions: { view: true, export: true } as never };

  const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
  const created = await createTrialBalance({
    user: sessionAdmin as never, ip: "seed-610",
    input: {
      companyId: co.id, fiscalYearId: fy.id, fromDate: "2026-01-01", toDate: "2026-09-30", dataType: "CUMULATIVE_YTD", reason: "بذر واجهة 6.10",
      lines: [
        { accountCode: "1102", accountName: "الذمم المدينة", debit: 1200000, credit: 0 },
        { accountCode: "2101", accountName: "الدائنون", debit: 0, credit: 1200000 },
      ] as never,
    },
  });
  await commitTrialBalance({ user: sessionAdmin as never, ip: "seed-610", id: created.import.id, input: { version: created.import.version, reason: "بذر واجهة 6.10" } });

  const { updateAgingConfig, createAgingImport, createAgingSnapshot } = await import("../src/lib/aging-server");
  await updateAgingConfig(sessionAdmin as never, { companyId: co.id, receivableAccounts: [{ accountCode: "1102", label: "الذمم المدينة" }] }, "seed-610");

  const grid = {
    headers: ["Customer Code", "Customer Name", "Outstanding Balance", "Due Date", "Last Sale Date", "Last Collection Date", "Credit Limit", "Salesperson"],
    rows: [
      ["C001", "مؤسسة النور", "200000.00", "2026-10-05", "2026-09-20", "2026-09-25", "300000.00", "سالم"],
      ["C002", "شركة الأمل", "150000.00", "2026-09-15", "2026-08-30", "2026-09-01", "200000.00", "سالم"],
      ["C003", "متجر الخير", "150000.00", "2026-08-20", "2026-07-15", "2026-06-01", "150000.00", "هالة"],
      ["C004", "مكتب اليقين", "100000.00", "2026-07-25", "2026-06-10", "2025-12-15", "120000.00", "سالم"],
      ["C005", "مصنع الرازي", "100000.00", "2026-05-10", "2026-04-02", "2025-11-30", "100000.00", "هالة"],
      ["C006", "معرض الصفا", "100000.00", "2026-02-01", "2025-12-20", "2025-08-01", "90000.00", "عمر"],
      ["C007", "مجموعة الهدى", "300000.00", "2025-06-30", "2025-05-15", "2025-03-10", "250000.00", "عمر"],
      ["C008", "عميل نقدي", "100000.00", "", "", "", "", "سالم"],
    ],
  };
  const imp = await createAgingImport(
    sessionAdmin as never,
    { companyId: co.id, fileName: "aging-sept-2026.xlsx", fileType: "XLSX", fileSize: 15360, fileSha256: "a".repeat(64), asOfDate: "2026-09-30", periodLabel: "الربع الثالث 2026", grid },
    "seed-610"
  );
  const snap = await createAgingSnapshot(sessionAdmin as never, { importId: String(imp.importId) }, "seed-610");

  console.log(`SEEDED OK: admin / ${ADMIN_PASSWORD} — approver / ${APPROVER_PASSWORD}`);
  console.log(`company=${co.id} import=${String(imp.importId)} snapshot=${String(snap.snapshotId)} recon=${String(snap.reconciliationStatus)}`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error("فشل البذر:", e);
  process.exit(1);
});
