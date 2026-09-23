// Phase 6.2C — بوابة إثبات التقارير من البيانات المحفوظة (Saved Actual Reporting).
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-62c-gate.db bun scripts/phase62c-reporting.ts
//
// الفixture المعتمد (سنة غير تقويمية يوليو 2027 → يونيو 2028، شركة A):
//   استيرادات CUMULATIVE_YTD معتمدة لثلاث فترات متتالية (يوليو/أغسطس/سبتمبر):
//     1101 (BALANCE): إقفال 100 / 140 / 125  (minor ×100)
//     4101 (FLOW):    تراكمي إيراد 100 / 220 / 300 (net سالب طبيعته الدائنة)
//   اختبارات 6.2C-9 + القاعدة الحرجة: حركة مارس = 80 وYTD = 300 — ليس 620.
//
// لا لمس custom.db إطلاقًا — الأداة ترفض أي DATABASE_URL غير dev-62c*.

import { PrismaClient } from "@prisma/client";

import {
  balanceAsOfFromPoints,
  flowMonthMovementFromPoints,
  flowYTDFromPoints,
} from "../src/lib/trial-balance-data";

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

async function expectIncomplete(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    expect(/INCOMPLETE_DATA|بيانات ناقصة|ناقص/.test(msg) || (e as { code?: string })?.code === "INCOMPLETE_DATA" || msg.includes("INCOMPLETE"), `${label}: متوقع INCOMPLETE_DATA وجاء ${msg}`);
    return;
  }
  throw new Error(`${label}: كان يجب أن يفشل INCOMPLETE_DATA`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-62c-gate"), "الأداة تعمل على dev-62c-gate.db حصرًا");
  const db = new PrismaClient({ datasources: { db: { url: url! } } });

  try {
    /* ── التهيئة: شركتان + سنتان + بادئة A ── */
    const coA = await db.company.create({ data: { code: "REP-A", nameAr: "شركة تقارير أ" } });
    const coB = await db.company.create({ data: { code: "REP-B", nameAr: "شركة تقارير ب" } });
const fyB = await db.fiscalYear.create({ data: { companyId: coB.id, code: "FY27/28-B", startDate: "2027-07-01", endDate: "2028-06-30", periodCount: 12 } });
    const fy = await db.fiscalYear.create({ data: { companyId: coA.id, code: "FY27/28", startDate: "2027-07-01", endDate: "2028-06-30", periodCount: 12 } });
    const fy2026 = await db.fiscalYear.create({ data: { companyId: coA.id, code: "FY2026", startDate: "2026-01-01", endDate: "2026-12-31", periodCount: 12 } });
    const monthsDef = [
      [2027, 7], [2027, 8], [2027, 9], [2027, 10], [2027, 11], [2027, 12],
      [2028, 1], [2028, 2], [2028, 3], [2028, 4], [2028, 5], [2028, 6],
    ];
    for (let i = 0; i < 12; i++) {
      const [y, m] = monthsDef[i];
      const mm = String(m).padStart(2, "0");
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      await db.fiscalPeriod.create({ data: { fiscalYearId: fy.id, ordinal: i + 1, code: `${y}-${mm}`, startDate: `${y}-${mm}-01`, endDate: `${y}-${mm}-${last}`, displayLabel: `فترة ${i + 1}` } });
    }
    for (let i = 0; i < 12; i++) {
      const mm = String(i + 1).padStart(2, "0");
      const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
      await db.fiscalPeriod.create({ data: { fiscalYearId: fy2026.id, ordinal: i + 1, code: `2026-${mm}`, startDate: `2026-${mm}-01`, endDate: `2026-${mm}-${last}`, displayLabel: `شهر ${i + 1}` } });
    }
    for (let i = 0; i < 12; i++) {
      const [y, m] = monthsDef[i];
      const mm = String(m).padStart(2, "0");
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      await db.fiscalPeriod.create({ data: { fiscalYearId: fyB.id, ordinal: i + 1, code: `B-${y}-${mm}`, startDate: `${y}-${mm}-01`, endDate: `${y}-${mm}-${last}`, displayLabel: `فترة B-${i + 1}` } });
    }

    const cashLine = await db.financialStatementLine.findUniqueOrThrow({ where: { code: "SFP-CASH" } });
    await db.accountNatureRule.create({ data: { companyId: coA.id, prefix: "1101", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineId: cashLine.id, source: "MANUAL" } });
    const revLine = await db.financialStatementLine.findUniqueOrThrow({ where: { code: "PNL-REVENUE" } });
    await db.accountNatureRule.create({ data: { companyId: coB.id, prefix: "1101", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineId: revLine.id, source: "MANUAL" } });

    /* إنشاء ثلاثة استيرادات تراكمية معتمدة لشركة A (خط الأنابيب الكامل عبر الخدمة) */
    const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
    const cumDefs = [
      { from: "2027-07-01", to: "2027-07-31", cash: "100.00", exp: "0",      rev: "100.00" }, // تراكمي يوليو: إيراد 100
      { from: "2027-08-01", to: "2027-08-31", cash: "140.00", exp: "80.00",  rev: "220.00" }, // تراكمي أغسطس: إيراد 220 + مصروف 80
      { from: "2027-09-01", to: "2027-09-30", cash: "125.00", exp: "175.00", rev: "300.00" }, // تراكمي سبتمبر: إيراد 300 + مصروف 175
    ];
    for (const [i, d] of cumDefs.entries()) {
      const created = await createTrialBalance({
        user: { id: "g", username: "gate-admin", name: "G", role: "admin", permissions: { view: true, add: true, edit: true, delete: true, groups: false, export: true, settings: false, manageUsers: false, companyIds: [], viewAllCompanies: true, manageAccountNature: true, manageTrialBalances: true } },
        ip: null,
        input: {
          companyId: coA.id, fiscalYearId: fy.id, fromDate: d.from, toDate: d.to,
          dataType: "CUMULATIVE_YTD", originalFileName: `cum-${i + 1}.xlsx`,
          lines: [
            { accountCode: "1101", accountName: "النقدية", debit: d.cash, credit: "0" },
            ...(d.exp !== "0" ? [{ accountCode: "3101", accountName: "تكلفة ومصروفات", debit: d.exp, credit: "0" }] : []),
            { accountCode: "4101", accountName: "المبيعات", debit: "0", credit: d.rev },
          ],
        },
      });
      // موازنة الـ 9999 الصغيرة: اجعل الميزان متوازنًا بإضافة سطر دائن مقابل
      await commitTrialBalance({ user: { id: "g", username: "gate-admin", name: "G", role: "admin", permissions: { view: true, add: true, edit: true, delete: true, groups: false, export: true, settings: false, manageUsers: false, companyIds: [], viewAllCompanies: true, manageAccountNature: true, manageTrialBalances: true } }, ip: null, id: created.import.id, input: { version: 1, reason: "بوابة 6.2C" } });
    }

    await check("تهيئة: ثلاثة استيرادات تراكمية معتمدة (يوليو/أغسطس/سبتمبر)", async () => {
      const count = await db.trialBalanceImport.count({ where: { companyId: coA.id, status: "COMMITTED" } });
      expect(count === 3, `متوقع 3 وجاء ${count}`);
    });

    /* 6.2C-2 — FLOW normalization من تراكمي */
    await check("C2-normalize حركة مارس = 80 (8000) وYTD مارس = 300 (30000) — ليس 620", () => {
      const pts = [{ startOrdinal: 1, endOrdinal: 1, dataType: "CUMULATIVE_YTD", netMinor: BigInt(-10000) },
                   { startOrdinal: 2, endOrdinal: 2, dataType: "CUMULATIVE_YTD", netMinor: BigInt(-22000) },
                   { startOrdinal: 3, endOrdinal: 3, dataType: "CUMULATIVE_YTD", netMinor: BigInt(-30000) }];
      const mar = flowMonthMovementFromPoints(pts, 3);
      expect(mar === BigInt(-8000), `حركة مارس = -8000 وجاء ${mar}`);
      const ytd = flowYTDFromPoints(pts, 3);
      expect(ytd === BigInt(-30000), `YTD مارس = -30000 وجاء ${ytd} (الجمع الأعمى كان سيصنع -62000)`);
      const jul = flowMonthMovementFromPoints(pts, 1);
      expect(jul === BigInt(-10000), "حركة يوليو = التراكمي نفسه (cum(0)=0)");
    });

    /* 6.2C-3 — BALANCE as-of (لا جمع) */
    await check("C3-balance as-of سبتمبر = 125 (12500) — لا جمع (365) ولا ترحيل", () => {
      const pts = [{ startOrdinal: 1, endOrdinal: 1, dataType: "CUMULATIVE_YTD", netMinor: BigInt(10000) },
                   { startOrdinal: 2, endOrdinal: 2, dataType: "CUMULATIVE_YTD", netMinor: BigInt(14000) },
                   { startOrdinal: 3, endOrdinal: 3, dataType: "PERIOD_MOVEMENT", netMinor: BigInt(12500) }];
      const asOf = balanceAsOfFromPoints(pts, 3);
      expect(asOf === BigInt(12500), `as-of = 12500 وجاء ${asOf}`);
      let threw = false;
      try { balanceAsOfFromPoints(pts, 2); } catch { threw = true; } // فترة 2 غير موجودة كسلسلة endOrdinal... موجودة فعلاً
      expect(!threw, "as-of فترة 2 متاح (14000)");
      expect(balanceAsOfFromPoints(pts, 2) === BigInt(14000), "as-of أغسطس = 140");
    });

    /* التقارير الخادمية — مقارنة الفترات */
    await check("C4 تقرير مقارنة الفترات: الحالية مارس/السابقة أغسطس بقيم صحيحة", async () => {
      const { getSavedPeriodComparison } = await import("../src/lib/reporting-server");
      const user = { id: "g", username: "gate-admin", name: "G", role: "admin", permissions: { view: true, add: true, edit: true, delete: true, groups: false, export: true, settings: false, manageUsers: false, companyIds: [], viewAllCompanies: true, manageAccountNature: true, manageTrialBalances: true } };
      const res = await getSavedPeriodComparison(user, { companyId: coA.id, fiscalYearId: fy.id, currentOrdinal: 3 });
      expect(res.previousPeriod?.ordinal === 2, "الفترة السابقة اكتُشفت تلقائيًا (2)");
      const cash = res.rows.find((r) => r.accountCode === "1101")!;
      expect(cash.currentMinor === "12500" && cash.previousMinor === "14000", `كاش 125/140 وجاء ${cash.currentMinor}/${cash.previousMinor}`);
      expect(cash.varianceMinor === "-1500", `الفرق -150 وجاء ${cash.varianceMinor}`);
      const rev = res.rows.find((r) => r.accountCode === "4101")!;
      expect(rev.currentMinor === "-8000" && rev.previousMinor === "-12000", `إيراد حركة 80/120 وجاء ${rev.currentMinor}/${rev.previousMinor}`);
      expect(rev.statementLineCode === null && rev.mappingStatus === "ROOT_ONLY", "4101 من الجذر فقط — ROOT_ONLY (لا بند مختلق)");
      expect(res.rows.every((r) => r.accountCode !== "9999"), "لا 9999 في هذا الفحص (يغطيه فحص لاحق)");
    });

    /* الشهر مقابل التراكمي */
    await check("C5 شهر مقابل تراكمي: FLOW حركة+YTD، BALANCE as-of فقط", async () => {
      const { getSavedMonthVsCumulative } = await import("../src/lib/reporting-server");
      const user = { id: "g", username: "gate-admin", name: "G", role: "admin", permissions: { view: true, add: true, edit: true, delete: true, groups: false, export: true, settings: false, manageUsers: false, companyIds: [], viewAllCompanies: true, manageAccountNature: true, manageTrialBalances: true } };
      const res = await getSavedMonthVsCumulative(user, { companyId: coA.id, fiscalYearId: fy.id, ordinal: 3 });
      const cash = res.rows.find((r) => r.accountCode === "1101")!;
      expect(cash.monthMinor === null, "BALANCE بلا «حركة شهر» مختلقة");
      expect(cash.ytdMinor === "12500", `BALANCE as-of = 125 وجاء ${cash.ytdMinor}`);
      const rev = res.rows.find((r) => r.accountCode === "4101")!;
      expect(rev.monthMinor === "-8000" && rev.ytdMinor === "-30000", `FLOW شهر 80 + YTD 300 وجاء ${rev.monthMinor}/${rev.ytdMinor}`);
    });

    /* 6.2C-8 فترات ناقصة — حركة فقط عند فترة متأخرة */
    await check("C8 فترات ناقصة: YTD من حركة متفرقة ⇒ INCOMPLETE_DATA صريح", async () => {
      const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const admin = { id: "g", username: "gate-admin", name: "G", role: "admin", permissions: { view: true, add: true, edit: true, delete: true, groups: false, export: true, settings: false, manageUsers: false, companyIds: [], viewAllCompanies: true, manageAccountNature: true, manageTrialBalances: true } };
      const created = await createTrialBalance({
        user: admin, ip: null,
        input: { companyId: coB.id, fiscalYearId: fyB.id, fromDate: "2027-09-01", toDate: "2027-09-30", dataType: "PERIOD_MOVEMENT", lines: [{ accountCode: "4101", accountName: "مبيعات B", debit: "0", credit: "80.00" }, { accountCode: "1101", accountName: "نقدية B", debit: "80.00", credit: "0" }] },
      });
      await commitTrialBalance({ user: admin, ip: null, id: created.import.id, input: { version: 1, reason: "فجوة" } });
      const pts = [{ startOrdinal: 3, endOrdinal: 3, dataType: "PERIOD_MOVEMENT", netMinor: BigInt(-8000) }];
      let incomplete = false;
      try { flowYTDFromPoints(pts, 3); } catch (e) {
        incomplete = (e as { code?: string })?.code === "INCOMPLETE_DATA" || String(e).includes("INCOMPLETE") || String(e).includes("ناقص");
      }
      expect(incomplete, "YTD بحركة فترة 3 فقط ⇒ INCOMPLETE_DATA (لا YTD كامل ظاهريًا)");
      expect(flowMonthMovementFromPoints(pts, 3) === BigInt(-8000), "حركة الفترة نفسها متاحة مباشرة");
    });

    await check("C9 حسابان مجهولان يظهران غير مصنفين في تقرير معتمد", async () => {
      const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const { getSavedMonthVsCumulative } = await import("../src/lib/reporting-server");
      const admin = { id: "g", username: "gate-admin", name: "G", role: "admin", permissions: { view: true, add: true, edit: true, delete: true, groups: false, export: true, settings: false, manageUsers: false, companyIds: [], viewAllCompanies: true, manageAccountNature: true, manageTrialBalances: true } };
      const created = await createTrialBalance({
        user: admin, ip: null,
        input: { companyId: coA.id, fiscalYearId: fy.id, fromDate: "2027-10-01", toDate: "2027-10-31", dataType: "PERIOD_MOVEMENT", lines: [{ accountCode: "9999", accountName: "غامض مدين", debit: "50.00", credit: "0" }, { accountCode: "8888", accountName: "غامض دائن", debit: "0", credit: "50.00" }] },
      });
      await commitTrialBalance({ user: admin, ip: null, id: created.import.id, input: { version: 1, reason: "مجهولون" } });
      const res = await getSavedMonthVsCumulative(admin, { companyId: coA.id, fiscalYearId: fy.id, ordinal: 4 });
      const u9999 = res.rows.find((r) => r.accountCode === "9999")!;
      const u8888 = res.rows.find((r) => r.accountCode === "8888")!;
      expect(u9999.mappingStatus === "NEEDS_CLASSIFICATION" && u8888.mappingStatus === "NEEDS_CLASSIFICATION", "كلاهما NEEDS_CLASSIFICATION");
      expect(u9999.monthMinor === "5000" && u8888.monthMinor === "-5000", "قيمهما تظهر (بلا بند ولا قائمة نهائية)");
      expect(res.summary.unclassifiedAccounts >= 2, "خلاصة غير المصنفين ترتفع");
    });

    /* العزل: شركات وسنوات */
    await check("C-iso عزل الشركات والسنوات: B مختلفة عن A، وFY2026 بلا بيانات", async () => {
      const { getSavedMonthVsCumulative } = await import("../src/lib/reporting-server");
      const user = { id: "g", username: "gate-admin", name: "G", role: "admin", permissions: { view: true, add: true, edit: true, delete: true, groups: false, export: true, settings: false, manageUsers: false, companyIds: [], viewAllCompanies: true, manageAccountNature: true, manageTrialBalances: true } };
      const resB = await getSavedMonthVsCumulative(user, { companyId: coB.id, fiscalYearId: fyB.id, ordinal: 3 });
      const b1101 = resB.rows.find((r) => r.accountCode === "1101");
      // B لديها بادئة 1101 ⇒ بند إيراد (مختلف عمدًا) — ولا رصيد نقدي A
      expect(b1101?.statementLineCode === "PNL-REVENUE", `B: 1101 ⇒ بند إيراد (${b1101?.statementLineCode})`);
      const res26 = await getSavedMonthVsCumulative(user, { companyId: coA.id, fiscalYearId: fy2026.id, ordinal: 1 });
      expect(res26.rows.length === 0, "FY2026 لنفس الشركة بلا بيانات (عزل سنوات)");
    });

    /* 6.2C-7 — بلا إعادة رفع: تقريران من نفس البيانات المحفوظة بلا أي رفع */
    await check("C7 بلا إعادة رفع: تقريران متتاليان يقرآن من المحفوظ حصرًا", async () => {
      const { getSavedPeriodComparison, getSavedMonthVsCumulative } = await import("../src/lib/reporting-server");
      const user = { id: "g", username: "gate-admin", name: "G", role: "admin", permissions: { view: true, add: true, edit: true, delete: true, groups: false, export: true, settings: false, manageUsers: false, companyIds: [], viewAllCompanies: true, manageAccountNature: true, manageTrialBalances: true } };
      const before = await db.trialBalanceImport.count();
      const a = await getSavedPeriodComparison(user, { companyId: coA.id, fiscalYearId: fy.id, currentOrdinal: 3 });
      const b = await getSavedMonthVsCumulative(user, { companyId: coA.id, fiscalYearId: fy.id, ordinal: 2 });
      const after = await db.trialBalanceImport.count();
      expect(before === after, "لا استيرادات جديدة أثناء التقارير");
      expect(a.rows.length > 0 && b.rows.length > 0, "التقريران أعادا بيانات من المحفوظ");
      const b4101 = b.rows.find((r) => r.accountCode === "4101")!;
      expect(b4101.ytdMinor === "-22000", `YTD أغسطس من التراكمي = 220 وجاء ${b4101.ytdMinor}`);
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
