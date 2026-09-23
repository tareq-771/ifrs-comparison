// Phase 6.2D — بوابة إثبات القوائم المالية الآلية (fixture معروف النتيجة).
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-62d-gate.db bun scripts/phase62d-statements.ts
//
// الفيكتشر المعتمد (شركة A — سنة غير تقويمية يوليو 2027 → يونيو 2028):
//   استيراد CUMULATIVE_YTD معتمد 2027-07-01 → 2027-09-30 (endOrdinal=3) متوازن:
//     مدين:  النقدية 500 + ذمم 200 + مخزون 300 + ممتلكات 1000 + تكلفة 700 + إدارية 200 = 2900
//     دائن:  دائنون 250 + قرض طويل 550 + رأس مال 800 + محتجزة 100 + مبيعات 1200 = 2900
//   المتوقع:
//     P&L (YTD حتى 3): إيرادات 1200 − تكلفة 700 − إدارية 200 ⇒ ربح 300 (OCI بلا بيانات)
//     SFP (as-of 3): أصول 2000 = التزامات 800 + حقوق 900 + نتيجة 300 ⇒ Δ = 0
//   + سيناريو حسابات غير مصنفة (فترة 4) ⇒ قائمة غير مكتملة NOT READY.
//
// لا لمس custom.db إطلاقًا — الأداة ترفض أي DATABASE_URL غير dev-62d*.

import { PrismaClient } from "@prisma/client";

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

const admin = {
  id: "g", username: "gate-admin", name: "G", role: "admin",
  permissions: { view: true, add: true, edit: true, delete: true, groups: false, export: true, settings: false, manageUsers: false, companyIds: [], viewAllCompanies: true, manageAccountNature: true, manageTrialBalances: true },
};

async function main() {
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-62d-gate"), "الأداة تعمل على dev-62d-gate.db حصرًا");
  const db = new PrismaClient({ datasources: { db: { url: url! } } });

  try {
    /* ── التهيئة ── */
    const coA = await db.company.create({ data: { code: "ST-A", nameAr: "شركة قوائم أ" } });
    const coB = await db.company.create({ data: { code: "ST-B", nameAr: "شركة قوائم ب" } });
    const mkFy = async (companyId: string, code: string) => {
      const monthsDef = [[2027, 7], [2027, 8], [2027, 9], [2027, 10], [2027, 11], [2027, 12], [2028, 1], [2028, 2], [2028, 3], [2028, 4], [2028, 5], [2028, 6]];
      const fy = await db.fiscalYear.create({ data: { companyId, code, startDate: "2027-07-01", endDate: "2028-06-30", periodCount: 12 } });
      for (let i = 0; i < 12; i++) {
        const [y, m] = monthsDef[i];
        const mm = String(m).padStart(2, "0");
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        await db.fiscalPeriod.create({ data: { fiscalYearId: fy.id, ordinal: i + 1, code: `${code}-${y}-${mm}`, startDate: `${y}-${mm}-01`, endDate: `${y}-${mm}-${last}`, displayLabel: `فترة ${i + 1}` } });
      }
      return fy;
    };
    const fyA = await mkFy(coA.id, "A");
    const fyB = await mkFy(coB.id, "B");

    const lineMapping: Array<[string, string, string, string]> = [
      // [prefix, lineCode, classification, behavior]
      ["1101", "SFP-CASH", "ASSET", "BALANCE"],
      ["1102", "SFP-RECEIVABLES", "ASSET", "BALANCE"],
      ["1103", "SFP-INVENTORY", "ASSET", "BALANCE"],
      ["1201", "SFP-PPE", "ASSET", "BALANCE"],
      ["2101", "SFP-PAYABLES", "LIABILITY", "BALANCE"],
      ["2201", "SFP-LT-LOANS", "LIABILITY", "BALANCE"],
      ["2301", "SFP-CAPITAL", "EQUITY", "BALANCE"],
      ["2302", "SFP-RETAINED", "EQUITY", "BALANCE"],
      ["3101", "PNL-COST-OF-SALES", "EXPENSE", "FLOW"],
      ["3201", "PNL-ADMIN-EXPENSES", "EXPENSE", "FLOW"],
      ["4101", "PNL-REVENUE", "REVENUE", "FLOW"],
    ];
    for (const [prefix, lineCode, classification, behavior] of lineMapping) {
      const line = await db.financialStatementLine.findUniqueOrThrow({ where: { code: lineCode } });
      await db.accountNatureRule.create({ data: { companyId: coA.id, prefix, classification, aggregationBehavior: behavior, statementLineId: line.id, source: "MANUAL" } });
    }

    const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
    const fixtureLines = [
      { accountCode: "1101", accountName: "النقدية", debit: "500.00", credit: "0" },
      { accountCode: "1102", accountName: "المدينون", debit: "200.00", credit: "0" },
      { accountCode: "1103", accountName: "المخزون", debit: "300.00", credit: "0" },
      { accountCode: "1201", accountName: "الممتلكات", debit: "1000.00", credit: "0" },
      { accountCode: "2101", accountName: "الدائنون", debit: "0", credit: "250.00" },
      { accountCode: "2201", accountName: "قرض طويل", debit: "0", credit: "550.00" },
      { accountCode: "2301", accountName: "رأس المال", debit: "0", credit: "800.00" },
      { accountCode: "2302", accountName: "محتجزة", debit: "0", credit: "100.00" },
      { accountCode: "3101", accountName: "تكلفة المبيعات", debit: "700.00", credit: "0" },
      { accountCode: "3201", accountName: "مصروفات إدارية", debit: "200.00", credit: "0" },
      { accountCode: "4101", accountName: "المبيعات", debit: "0", credit: "1200.00" },
    ];
    const created = await createTrialBalance({
      user: admin, ip: null,
      input: { companyId: coA.id, fiscalYearId: fyA.id, fromDate: "2027-07-01", toDate: "2027-09-30", dataType: "CUMULATIVE_YTD", originalFileName: "fixture-q1.xlsx", lines: fixtureLines },
    });
    expect(created.import.totalDebitMinor === created.import.totalCreditMinor, "fixture متوازن (2900=2900)");
    await commitTrialBalance({ user: admin, ip: null, id: created.import.id, input: { version: 1, reason: "بوابة 6.2D" } });

    const { getStatements } = await import("../src/lib/statement-server");

    await check("D-P&L قائمة الربح أو الخسارة: 1200 − 700 − 200 = ربح 300 (OCI بلا بيانات بصدق)", async () => {
      const res = await getStatements(admin, { companyId: coA.id, fiscalYearId: fyA.id, ordinal: 3, basis: "YTD" });
      const p = res.profitOrLoss;
      expect(p.revenue.totalMinor === "120000", `إيرادات 120000 وجاء ${p.revenue.totalMinor}`);
      expect(p.expenses.totalMinor === "90000", `مصروفات 90000 وجاء ${p.expenses.totalMinor}`);
      expect(p.netResultMinor === "30000", `صافي 30000 وجاء ${p.netResultMinor}`);
      expect(p.oci === null && p.ociStatus === "NO_DATA", "لا قسم OCI مختلق بلا بيانات");
      expect(p.totalComprehensiveIncomeMinor === "30000", "الدخل الشامل = صافي النتيجة");
      const revRow = p.revenue.rows.find((r) => r.statementLineCode === "PNL-REVENUE")!;
      expect(revRow.accounts?.some((a) => a.accountCode === "4101"), "الحساب 4101 تحت بند الإيراد (بلا hard-code)");
      expect(p.completeness.ready === true, "الفيكتشر كامل الخريطة ⇒ READY");
    });

    await check("D-SFP قائمة المركز المالي: أصول 2000 = التزامات 800 + حقوق 1200 (بنتيجة 300)", async () => {
      const res = await getStatements(admin, { companyId: coA.id, fiscalYearId: fyA.id, ordinal: 3, basis: "YTD" });
      const f = res.financialPosition;
      expect(f.assets.totalMinor === "200000", `أصول 200000 وجاء ${f.assets.totalMinor}`);
      expect(f.liabilities.totalMinor === "80000", `التزامات 80000 وجاء ${f.liabilities.totalMinor}`);
      // حقوق الملكية تشمل نتيجة الفترة 300 (قرار العرض المعتمد)
      expect(f.equation.assetsMinor === "200000" && f.equation.liabilitiesPlusEquityMinor === "200000", `L+E = ${f.equation.liabilitiesPlusEquityMinor}`);
      expect(f.equation.balanced === true && f.equation.differenceMinor === "0", "المعادلة متوازنة Δ=0");
      // BALANCE لا تُجمع: النقدية = إقفال 500 (وليس مجموع أي سلاسل)
      const cash = f.assets.rows.find((r) => r.statementLineCode === "SFP-CASH")!;
      expect(cash.valueMinor === "50000", `نقدية as-of = 50000 وجاء ${cash.valueMinor}`);
      const ca = f.assets.rows.find((r) => r.statementLineCode === "SFP-ASSET-CA")!;
      expect(ca.valueMinor === "100000", "مجموعة الأصول المتداولة = Σ أبنائها (1000)");
    });

    await check("D-prev غياب الفترة السابقة لا يمنع عرض الحالية (أعمدة مقارنة اختيارية)", async () => {
      const res = await getStatements(admin, { companyId: coA.id, fiscalYearId: fyA.id, ordinal: 3, basis: "YTD" });
      const revRow = res.profitOrLoss.revenue.rows.find((r) => r.statementLineCode === "PNL-REVENUE")!;
      expect(revRow.previousValueMinor === null, "لا بيانات فترة سابقة ⇒ عمود السابقة — بلا اختراع");
      expect(revRow.valueMinor === "120000", "الحالية معروضة كاملة");
    });

    await check("D-FLOW accumulated: YTD تراكمي حتى 3 (1200) وليس حركة فترة واحدة", async () => {
      const res = await getStatements(admin, { companyId: coA.id, fiscalYearId: fyA.id, ordinal: 3, basis: "PERIOD" });
      // أساس PERIOD عند 3: حركة = cum(3)−cum(2) وcum(2) غير موجودة ⇒ INCOMPLETE صريح (لا رقم مختلق)
      const p = res.profitOrLoss;
      const revRow = p.revenue.rows.find((r) => r.statementLineCode === "PNL-REVENUE")!;
      expect(revRow.valueStatus === "INCOMPLETE_DATA", `أساس PERIOD بتراكمي مفرد ⇒ INCOMPLETE وجاء ${revRow.valueStatus}`);
      // أساس YTD يعطي التراكمي الكامل
      const res2 = await getStatements(admin, { companyId: coA.id, fiscalYearId: fyA.id, ordinal: 3, basis: "YTD" });
      expect(res2.profitOrLoss.revenue.totalMinor === "120000", "YTD = 1200 (FLOW مُجمّع صحيحًا)");
    });

    await check("D-notready حسابات غير مصنفة (فترة 4) ⇒ القائمة غير مكتملة + كشف شفاف", async () => {
      const created4 = await createTrialBalance({
        user: admin, ip: null,
        input: { companyId: coA.id, fiscalYearId: fyA.id, fromDate: "2027-10-01", toDate: "2027-10-31", dataType: "PERIOD_MOVEMENT", lines: [
          { accountCode: "9999", accountName: "غامض مدين", debit: "50.00", credit: "0" },
          { accountCode: "8888", accountName: "غامض دائن", debit: "0", credit: "50.00" },
        ] },
      });
      await commitTrialBalance({ user: admin, ip: null, id: created4.import.id, input: { version: 1, reason: "غير مصنف" } });
      const res = await getStatements(admin, { companyId: coA.id, fiscalYearId: fyA.id, ordinal: 4, basis: "YTD" });
      const f = res.financialPosition;
      expect(f.completeness.ready === false, "القائمة غير مكتملة (NOT READY)");
      expect(f.completeness.incompleteAccounts.some((a) => a.accountCode === "9999"), "9999 في قائمة النقص");
      expect(f.unclassified.rows.length === 2, `حسابان خارج الأقسام وجاء ${f.unclassified.rows.length}: ${f.unclassified.rows.map(r=>r.accountCode).join(",")}`);
      expect(f.unclassified.totalMinor === "0", "مجموع غير المصنفين متعادل (50−50)");
      const p4 = res.profitOrLoss;
      expect(p4.completeness.ready === false, "قائمة الأرباح أيضًا غير مكتملة");
    });

    await check("D-iso عزل الشركات: نفس البادئات بفيكتشر مختلف ⇒ قائمة مختلفة", async () => {
      for (const [prefix, lineCode, classification, behavior] of lineMapping) {
        const line = await db.financialStatementLine.findUniqueOrThrow({ where: { code: lineCode } });
        await db.accountNatureRule.create({ data: { companyId: coB.id, prefix, classification, aggregationBehavior: behavior, statementLineId: line.id, source: "MANUAL" } });
      }
      const createdB = await createTrialBalance({
        user: admin, ip: null,
        input: { companyId: coB.id, fiscalYearId: fyB.id, fromDate: "2027-07-01", toDate: "2027-09-30", dataType: "CUMULATIVE_YTD", lines: [
          { accountCode: "1101", accountName: "النقدية", debit: "80.00", credit: "0" },
          { accountCode: "2301", accountName: "رأس المال", debit: "0", credit: "80.00" },
        ] },
      });
      await commitTrialBalance({ user: admin, ip: null, id: createdB.import.id, input: { version: 1, reason: "بوابة B" } });
      const res = await getStatements(admin, { companyId: coB.id, fiscalYearId: fyB.id, ordinal: 3, basis: "YTD" });
      expect(res.financialPosition.assets.totalMinor === "8000", `B: أصول 80 وجاء ${res.financialPosition.assets.totalMinor}`);
      expect(res.financialPosition.equation.balanced === true, "B: معادلة متوازنة مستقلة");
      const resA = await getStatements(admin, { companyId: coA.id, fiscalYearId: fyA.id, ordinal: 3, basis: "YTD" });
      expect(resA.financialPosition.assets.totalMinor === "200000", "A لم تتأثر بشركة B (عزل)");
    });
  } finally {
    await db.$disconnect();
  }

  console.log("\n═══ الخلاصة ═══");
  console.log(`PASS: ${passCount}  FAIL: ${failCount}`);
  if (failures.length > 0) for (const f of failures) console.log(`  - ${f}`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("فشل تشغيل البوابة:", e);
  process.exit(1);
});
