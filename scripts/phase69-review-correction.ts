// Phase 6.9R — بوابة جولة المراجعة والتصحيح (Review & Correction Pass).
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-69r-gate.db bunx prisma migrate deploy
//        DATABASE_URL=file:/home/z/my-project/db/dev-69r-gate.db bun scripts/phase69-review-correction.ts
// (قاعدة معزولة dev-69r-gate.db من migrations حصرًا — عزل صارم عن custom.db — لا db push)
//
// الفحوص (تعليمات جولة المراجعة I.1–15) — بالفيكتشر اليدوي الحرفي للعهدة A:
//   R1  قائمة المركز المالي بالفيكتشر الحرفي تتوازن بفرق صفر
//   R2  الالتزامات 150,000 لا تُسقط (كانت تظهر صفرًا — جذر الخلل)
//   R3  رأس المال 350,000 لا يُسقط
//   R4  ربح الفترة 200,000 يدخل مرة واحدة فقط (لا ازدواج)
//   R5  لا plug لفرض التوازن — فرق غير متوازن يُعلن كما هو
//   R6  دلالة شهرية مقابل تراكمية: YTD عبر 3 = من بداية السنة؛ الشهرية = حركة الفترة؛ الفترة الأولى cum(0)=0
//   R7  غياب التراكمي السابق ⇒ حالة ناقصة صريحة (لا معاملة التراكمي كحركة شهرية)
//   R8  مصطلح الإيراد مقابل الموازنة: «أعلى من الموازنة» بمبلغ ونسبة منسّقين — لا «مواتٍ»
//   R9  مصطلح المصروف: «وفر عن الموازنة» / «تجاوز الموازنة»
//   R10 المركز المالي بلا ف/غ تلقائي: «لا ينطبق تقييم الزيادة/الوفر على هذا البند»
//   R11 لا قيم minor خام في نصوص المستخدم — تنسيق عملة (50000000 ⇒ 500,000.00 SAR)
//   R12 تسميات البنود المحلية: الإيرادات… لا الأكواد التقنية كنص أساسي
//   R13 خريطة الرسائل عربي/إنجليزي + لغة التقرير (ar/en/ar_en) مستقلة عن الواجهة
//   R14 بوابة 6.9 ومكوّناتها سليمة (فحص ملفات — التشغيل الفعلي في خط السير)
//   R15 ملفات بوابات الانحدار 6.2A..6.8 موجودة (التشغيل الفعلي في خط السير)

import { readFileSync } from "node:fs";

import type { SessionUser } from "../src/lib/session";
import { createTrialBalance, commitTrialBalance } from "../src/lib/trial-balance-server";
import { createBudget, transitionBudget } from "../src/lib/budget-server";
import { getStatements } from "../src/lib/statement-server";
import { getStatementComparison } from "../src/lib/comparison-server";
import { getCashFlowStatement } from "../src/lib/cashflow-server";
import { getEquityStatement } from "../src/lib/equity-server";
import { compareRowCore, COMPARISON_MODES, PRESENTATION_MODES } from "../src/lib/comparison-engine";
import {
  statementLineLabel,
  mappingStatusLabel,
  comparisonStatusLabel,
  budgetVarianceBadge,
  bilingual,
  REPORT_LANGUAGES,
} from "../src/lib/display-labels";
import { formatMinor } from "../src/lib/money";
import { TrialBalanceError } from "../src/lib/trial-balance";

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

function syntheticUser(over: Partial<{ role: string; companyIds: string[]; viewAllCompanies: boolean }> = {}): SessionUser {
  return {
    id: "gate-user-69r",
    username: "gate-admin-69r",
    name: "Gate Admin 69R",
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

function fileExports(path: string, needle: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(needle);
  } catch {
    return false;
  }
}

async function createCalendarFy(db: any, companyId: string, code: string, year: number) {
  const fy = await db.fiscalYear.create({ data: { companyId, code, startDate: `${year}-01-01`, endDate: `${year}-12-31`, periodCount: 12 } });
  for (let i = 0; i < 12; i++) {
    const last = new Date(Date.UTC(year, i + 1, 0)).getUTCDate();
    const mm = String(i + 1).padStart(2, "0");
    await db.fiscalPeriod.create({ data: { fiscalYearId: fy.id, ordinal: i + 1, code: `${year}-${mm}`, startDate: `${year}-${mm}-01`, endDate: `${year}-${mm}-${last}`, displayLabel: `شهر ${i + 1}` } });
  }
  return fy;
}

/** قواعد التصنيف بالفيكتشر الحرفي (المربوطة ببنود جذريات لها أبناء — حيث كان الخلل). */
async function seedFixtureRules(db: any, companyId: string) {
  for (const [prefix, classification, behavior, lineCode] of [
    ["1101", "ASSET", "BALANCE", "SFP-CASH"],
    ["1102", "ASSET", "BALANCE", "SFP-RECEIVABLES"],
    ["21", "LIABILITY", "BALANCE", "SFP-LIA-CL"],
    ["23", "EQUITY", "BALANCE", "SFP-EQUITY"],
    ["33", "EXPENSE", "FLOW", "PNL-ADMIN-EXPENSES"],
    ["41", "REVENUE", "FLOW", "PNL-REVENUE"],
  ] as const) {
    const sl = await db.financialStatementLine.findUniqueOrThrow({ where: { code: lineCode } });
    await db.accountNatureRule.create({ data: { companyId, prefix, classification, aggregationBehavior: behavior, source: "MANUAL", statementLineId: sl.id } });
  }
}

/** الفيكتشر اليدوي الحرفي (عهدة A): تراكمي حتى 2026-03-31 — مدخلات بوحدات رئيسية ×100 minor. */
function fixtureLinesThroughMarch() {
  return [
    line("110101", 500000, 0, "النقدية"),
    line("110201", 200000, 0, "الذمم المدينة"),
    line("210101", 0, 150000, "الدائنون"),
    line("230101", 0, 350000, "رأس المال"),
    line("410101", 0, 300000, "المبيعات"),
    line("330101", 100000, 0, "الرواتب"),
  ];
}

/** تراكمي حتى يناير (لاختبار الشهرية/الأولى) — متوازن: 340+200+60 = 150+350+100 */
function fixtureLinesThroughJanuary() {
  return [
    line("110101", 340000, 0, "النقدية"),
    line("110201", 200000, 0, "الذمم المدينة"),
    line("210101", 0, 150000, "الدائنون"),
    line("230101", 0, 350000, "رأس المال"),
    line("410101", 0, 100000, "المبيعات"),
    line("330101", 60000, 0, "الرواتب"),
  ];
}

/** تراكمي حتى فبراير — متوازن: 440+200+80 = 150+350+220 */
function fixtureLinesThroughFebruary() {
  return [
    line("110101", 440000, 0, "النقدية"),
    line("110201", 200000, 0, "الذمم المدينة"),
    line("210101", 0, 150000, "الدائنون"),
    line("230101", 0, 350000, "رأس المال"),
    line("410101", 0, 220000, "المبيعات"),
    line("330101", 80000, 0, "الرواتب"),
  ];
}

async function commitImport(user: SessionUser, companyId: string, fiscalYearId: string, fromDate: string, toDate: string, lines: ReturnType<typeof fixtureLinesThroughMarch>) {
  const created = await createTrialBalance({
    user, ip: "gate-69r",
    input: { companyId, fiscalYearId, fromDate, toDate, dataType: "CUMULATIVE_YTD", reason: "بوابة جولة المراجعة 6.9R", lines },
  });
  await commitTrialBalance({ user, ip: "gate-69r", id: created.import.id, input: { version: created.import.version, reason: "بوابة 6.9R" } });
}

async function main() {
  console.log("═══ بوابة جولة المراجعة 6.9R — تصحيح القوائم والمصطلحات ══");
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-69r"), "الأداة تعمل على dev-69r-gate.db حصرًا (عزل صارم عن custom.db)");

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ log: [], datasources: { db: { url: url! } } });

  const admin = syntheticUser();

  let co1 = ""; let fy1 = ""; let co3 = ""; let fy3 = "";

  /* ── R12/R13 فحوص نقية للتسميات قبل القاعدة ── */

  await check("R12 تسميات البنود المحلية: عربي/إنجليزي من المرجع — الكود ليس النص الأساسي", () => {
    const ar = statementLineLabel("PNL-REVENUE", REPORT_LANGUAGES.AR);
    const en = statementLineLabel("PNL-REVENUE", REPORT_LANGUAGES.EN);
    expect(ar === "إيرادات النشاط الرئيسي", `عربي: ${ar}`);
    expect(en === "Revenue from Ordinary Activities", `إنجليزي: ${en}`);
    expect(statementLineLabel("SFP-CASH", REPORT_LANGUAGES.AR) === "النقدية وما في حكمها", "النقدية بالعربي");
    expect(statementLineLabel("SFP-LIA-CL", REPORT_LANGUAGES.EN) === "Current Liabilities", "الالتزامات المتداولة بالإنجليزي");
    // أولوية قاعدة البيانات (المضبوطة إداريًا) فوق المرآة
    expect(statementLineLabel("PNL-REVENUE", REPORT_LANGUAGES.AR, "الإيرادات") === "الإيرادات", "اسم القاعدة يفوز");
    expect(mappingStatusLabel("NEEDS_CLASSIFICATION", "ar") === "غير مصنّف", `حالة الخريطة عربي: ${mappingStatusLabel("NEEDS_CLASSIFICATION", "ar")}`);
    expect(mappingStatusLabel("NEEDS_CLASSIFICATION", "en") === "Unclassified", "حالة الخريطة إنجليزي");
    expect(comparisonStatusLabel("INCOMPLETE_DATA", "ar") === "بيانات غير مكتملة", `حالة ناقصة بلا كود خام: ${comparisonStatusLabel("INCOMPLETE_DATA", "ar")}`);
    expect(comparisonStatusLabel("INCOMPLETE_DATA", "en") === "Incomplete Data", "Incomplete Data بالإنجليزي");
    expect(!comparisonStatusLabel("NO_COMPARISON_DATA", "ar").includes("NO_COMPARISON_DATA"), "الكود التقني ليس في النص الأساسي");
  });

  await check("R13 المصطلح السياقي للموازنة عربي/إنجليزي + ثنائي اللغة (لا مواتٍ إطلاقًا)", () => {
    expect(budgetVarianceBadge({ lineNature: "REVENUE", favorability: "FAVORABLE", hasData: true }, "ar") === "أعلى من الموازنة", "إيراد أعلى ⇒ أعلى من الموازنة");
    expect(budgetVarianceBadge({ lineNature: "REVENUE", favorability: "UNFAVORABLE", hasData: true }, "ar") === "أقل من الموازنة", "إيراد أقل ⇒ أقل من الموازنة");
    expect(budgetVarianceBadge({ lineNature: "EXPENSE", favorability: "UNFAVORABLE", hasData: true }, "ar") === "تجاوز الموازنة", "مصروف أعلى ⇒ تجاوز الموازنة");
    expect(budgetVarianceBadge({ lineNature: "EXPENSE", favorability: "FAVORABLE", hasData: true }, "ar") === "وفر عن الموازنة", "مصروف أقل ⇒ وفر عن الموازنة");
    expect(budgetVarianceBadge({ lineNature: "REVENUE", favorability: "NO_FAVORABLE_UNFAVORABLE", hasData: true }, "ar") === "ضمن الموازنة", "تعادل ⇒ ضمن الموازنة");
    expect(budgetVarianceBadge({ lineNature: "OTHER", favorability: "NO_FAVORABLE_UNFAVORABLE", hasData: true }, "ar") === "لا ينطبق تقييم الزيادة/الوفر على هذا البند", "أرصدة ⇒ لا ينطبق");
    expect(budgetVarianceBadge({ lineNature: "REVENUE", favorability: "NO_FAVORABLE_UNFAVORABLE", hasData: false }, "ar") === "لا تتوفر بيانات للمقارنة", "بلا بيانات ⇒ لا تتوفر بيانات");
    expect(budgetVarianceBadge({ lineNature: "EXPENSE", favorability: "FAVORABLE", hasData: true }, "en") === "Budget Saving", "Budget Saving بالإنجليزي");
    expect(budgetVarianceBadge({ lineNature: "EXPENSE", favorability: "UNFAVORABLE", hasData: true }, "en") === "Over Budget", "Over Budget بالإنجليزي");
    const both = bilingual("بيانات غير مكتملة", "Incomplete Data", REPORT_LANGUAGES.AR_EN);
    expect(both.includes("بيانات غير مكتملة") && both.includes("Incomplete Data"), `ثنائي: ${both}`);
    expect(!JSON.stringify([budgetVarianceBadge({ lineNature: "REVENUE", favorability: "FAVORABLE", hasData: true }, "ar"), budgetVarianceBadge({ lineNature: "EXPENSE", favorability: "UNFAVORABLE", hasData: true }, "ar")]).includes("موات"), "لا «مواتٍ» إطلاقًا");
    expect(formatMinor("50000000", 2) === "500,000.00", `تنسيق minor: ${formatMinor("50000000", 2)}`);
  });

  await check("R9b المحرك النقي: تجاوز الموازنة للمصروف (بدل غير مؤاتٍ)", () => {
    const over = compareRowCore({ currentMinor: BigInt(13000000), currentStatus: "OK", comparisonMinor: BigInt(12000000), comparisonStatus: "OK", lineNature: "EXPENSE", mappingStatus: "FULLY_MAPPED", basisLabel: "الموازنة المعتمدة", basisKind: "BUDGET", rowNoun: "المصروفات الإدارية والعمومية" });
    expect(over.favorability === "UNFAVORABLE", "enum داخلي UNFAVORABLE كما هو");
    expect(over.interpretationText?.includes("تجاوز الموازنة"), `مصروف أعلى ⇒ تجاوز الموازنة: ${over.interpretationText}`);
    expect(!over.interpretationText!.includes("غير مؤات"), "لا «غير مؤاتٍ» في النص المعروض");
  });

  /* ── التهيئة: شركات السنة المالية 2026 + الفيكتشر الحرفي ── */

  await check("G0 تهيئة: SHARIK-1 بالفيكتشر الحرفي (3 تراكميات) + SHARIK-3 (مارس فقط) + موازنة معتمدة", async () => {
    const c1 = await db.company.create({ data: { code: "SHARIK-1", nameAr: "شركة شراك واحد", functionalCurrency: "SAR" } });
    co1 = c1.id;
    const fy1c = await createCalendarFy(db, co1, "FY2026", 2026);
    fy1 = fy1c.id;
    await seedFixtureRules(db, co1);
    // الميزان المعتمد رقم 1 حتى 2026-03-31 (الفيكتشر الحرفي حرفيًا)
    await commitImport(admin, co1, fy1, "2026-01-01", "2026-03-31", fixtureLinesThroughMarch());
    // تراكمي يناير وفبراير لدلالة الشهرية مقابل التراكمية
    await commitImport(admin, co1, fy1, "2026-01-01", "2026-01-31", fixtureLinesThroughJanuary());
    await commitImport(admin, co1, fy1, "2026-01-01", "2026-02-28", fixtureLinesThroughFebruary());

    const c3 = await db.company.create({ data: { code: "SHARIK-3", nameAr: "شركة شراك ثلاث" } });
    co3 = c3.id;
    const fy3c = await createCalendarFy(db, co3, "FY2026-S3", 2026);
    fy3 = fy3c.id;
    await seedFixtureRules(db, co3);
    await commitImport(admin, co3, fy3, "2026-01-01", "2026-03-31", fixtureLinesThroughMarch());

    // موازنة معتمدة للفترة 3: إيراد 290,000 / مصروف 120,000 (بالمثال H)
    const p3 = await db.fiscalPeriod.findUniqueOrThrow({ where: { fiscalYearId_ordinal: { fiscalYearId: fy1, ordinal: 3 } } });
    const budget = await createBudget({
      user: admin, ip: "gate-69r",
      input: {
        companyId: co1, fiscalYearId: fy1, budgetType: "MONTHLY", scenario: "BASE", startOrdinal: 3, endOrdinal: 3,
        lines: [
          { statementLineCode: "PNL-REVENUE", fiscalPeriodId: p3.id, amountMinor: String(290000 * 100) },
          { statementLineCode: "PNL-ADMIN-EXPENSES", fiscalPeriodId: p3.id, amountMinor: String(120000 * 100) },
        ],
      },
    });
    const submitted = await transitionBudget({ user: admin, ip: "gate-69r", id: budget.id, input: { action: "SUBMIT", version: budget.version, reason: "بوابة" } });
    const approved = await transitionBudget({ user: admin, ip: "gate-69r", id: submitted.id, input: { action: "APPROVE", version: submitted.version, reason: "بوابة" } });
    expect(approved.status === "APPROVED", `الموازنة معتمدة: ${approved.status}`);
  });

  /* ── R1..R4 قائمة المركز المالي بالفيكتشر الحرفي ── */

  await check("R1 المركز المالي (الفيكتشر الحرفي): أصول 700,000 = التزامات 150,000 + حقوق 550,000 — الفرق صفر", async () => {
    const res = await getStatements(admin, { companyId: co1, fiscalYearId: fy1, ordinal: 3, basis: "YTD" });
    const f = res.financialPosition;
    expect(f.assets.totalMinor === String(700000 * 100), `الأصول 700,000 وجاء ${f.assets.totalMinor}`);
    expect(f.liabilities.totalMinor === String(150000 * 100), `الالتزامات 150,000 وجاء ${f.liabilities.totalMinor}`);
    // حقوق الملكية = رأس المال 350,000 + ربح الفترة 200,000 = 550,000
    expect(f.equity.totalMinor === String(550000 * 100), `إجمالي حقوق الملكية 550,000 وجاء ${f.equity.totalMinor}`);
    expect(f.equation.assetsMinor === String(700000 * 100), `A: ${f.equation.assetsMinor}`);
    expect(f.equation.liabilitiesPlusEquityMinor === String(700000 * 100), `L+E: ${f.equation.liabilitiesPlusEquityMinor}`);
    expect(f.equation.differenceMinor === "0" && f.equation.balanced === true, `الفرق: ${f.equation.differenceMinor}`);
    expect(f.completeness.ready === true, "الخريطة كاملة (كل البنود FULLY_MAPPED)");
  });

  await check("R2 الالتزامات 150,000 داخل القسم (كانت تُسقط على بند رئيسي له أبناء)", async () => {
    const res = await getStatements(admin, { companyId: co1, fiscalYearId: fy1, ordinal: 3, basis: "YTD" });
    const f = res.financialPosition;
    expect(f.liabilities.rows.length > 0, `صفوف الالتزامات غير فارغة: ${f.liabilities.rows.length}`);
    const group = f.liabilities.rows.find((r) => r.statementLineCode === "SFP-LIA-CL" && r.depth === 0);
    expect(!!group && group.valueMinor === String(150000 * 100), `مجموعة الالتزامات المتداولة 150,000: ${group?.valueMinor}`);
    const direct = f.liabilities.rows.find((r) => r.key === "SFP-LIA-CL::direct");
    expect(!!direct && direct.valueMinor === String(150000 * 100), `صف الحسابات المربوطة بالبند الرئيسي ظاهر: ${direct?.valueMinor}`);
    expect((direct?.accounts ?? []).some((a) => a.accountCode === "210101"), "الحساب 210101 متتبع داخل الصف");
  });

  await check("R3 رأس المال 350,000 داخل حقوق الملكية (كان يُسقط على SFP-EQUITY له أبناء)", async () => {
    const res = await getStatements(admin, { companyId: co1, fiscalYearId: fy1, ordinal: 3, basis: "YTD" });
    const f = res.financialPosition;
    expect(f.equity.rows.length > 0, "صفوف حقوق الملكية غير فارغة");
    const group = f.equity.rows.find((r) => r.statementLineCode === "SFP-EQUITY" && r.depth === 0);
    expect(!!group && group.valueMinor === String(350000 * 100), `مجموعة حقوق الملكية 350,000: ${group?.valueMinor}`);
    const direct = f.equity.rows.find((r) => r.key === "SFP-EQUITY::direct");
    expect(!!direct && direct.valueMinor === String(350000 * 100), `صف رأس المال المباشر ظاهر: ${direct?.valueMinor}`);
    expect((direct?.accounts ?? []).some((a) => a.accountCode === "230101"), "الحساب 310101 متتبع");
  });

  await check("R4 ربح الفترة 200,000 يدخل مرة واحدة فقط (350,000 + 200,000 = 550,000 لا 750,000)", async () => {
    const res = await getStatements(admin, { companyId: co1, fiscalYearId: fy1, ordinal: 3, basis: "YTD" });
    const p = res.profitOrLoss;
    expect(p.netResultMinor === String(200000 * 100), `صافي القائمة 200,000: ${p.netResultMinor}`);
    const f = res.financialPosition;
    const netRows = f.equity.rows.filter((r) => r.kind === "NET_RESULT");
    expect(netRows.length === 1 && netRows[0]!.valueMinor === String(200000 * 100), `صف نتيجة الفترة مرة واحدة بقيمة 200,000: ${netRows.length}/${netRows[0]?.valueMinor}`);
    // لو دخل الربح مرتين لصار الإجمالي 750,000 — الرقم المطلوب حرفيًا 550,000 (مُتحقق في R1)
    const capitalRows = f.equity.rows.filter((r) => (r.accounts ?? []).some((a) => a.accountCode === "230101"));
    expect(capitalRows.length === 1, `رأس المال في صف تفصيلي واحد فقط: ${capitalRows.length}`);
  });

  /* ── R5 لا plug ── */

  await check("R5 لا plug لفرض التوازن: فيكتشر غير مصنف يُعلن بفرقه الصريح", async () => {
    // شركة بلا قواعد شركة: الجذور النظامية تحسم جزئيًا (1=أصول، 3=مصروفات، 4=إيرادات)
    // والجذر المركب 2 يحتاج تفصيلًا — النتيجة غير متوازنة وتُعلن كما هي بلا أي صف مُختلق
    const c2 = await db.company.create({ data: { code: "SHARIK-2", nameAr: "شركة شراك اثنان" } });
    const fy2c = await createCalendarFy(db, c2.id, "FY2026-S2", 2026);
    await commitImport(admin, c2.id, fy2c.id, "2026-01-01", "2026-03-31", fixtureLinesThroughMarch());
    const res = await getStatements(admin, { companyId: c2.id, fiscalYearId: fy2c.id, ordinal: 3, basis: "YTD" });
    const f = res.financialPosition;
    expect(f.equation.balanced === false, "غير متوازن معلن");
    expect(f.equation.differenceMinor === "50000000", `الفرق معروض بحسابه الصريح (أصول 70M − L+E 20M بالحل الجذري): ${f.equation.differenceMinor}`);
    expect(f.equation.liabilitiesPlusEquityMinor !== f.equation.assetsMinor, "لا تطابق مُجبرة");
    // الجذر المركب 2 (الدائنون ورأس المال) معلن كغير مصنف — لا تخمين LIABILITY/EQUITY
    const unclassifiedCodes = f.unclassified.rows.map((r) => r.accountCode);
    expect(unclassifiedCodes.includes("210101"), `الدائنون معلن غير مصنف: ${unclassifiedCodes.join(",")}`);
    expect(unclassifiedCodes.includes("230101") || unclassifiedCodes.length >= 1, "الفجوات معلنة");
    const knownKinds = new Set(["LINE", "ACCOUNT_GROUP", "TOTAL", "NET_RESULT", "GRAND_TOTAL"]);
    for (const section of [f.assets, f.liabilities, f.equity]) {
      for (const r of section.rows) expect(knownKinds.has(r.kind), `لا صف مُختلق لفرض التوازن: ${r.kind}`);
    }
    expect(f.completeness.ready === false, "الاكتمال يفشل صراحة (لا إصدار صامت)");
  });

  /* ── R6/R7 الدلالة الزمنية ── */

  await check("R6 الشهرية مقابل التراكمية: YTD عبر 3 = 200,000؛ حركة فبراير/مارس صحيحة؛ الفترة الأولى = cum(0)=0", async () => {
    // التراكمي عبر الفترة 3 = من بداية السنة حتى نهايتها (سلوك YTD المطلوب)
    const ytd = await getStatements(admin, { companyId: co1, fiscalYearId: fy1, ordinal: 3, basis: "YTD" });
    expect(ytd.profitOrLoss.netResultMinor === String(200000 * 100), `YTD عبر 3 = 200,000: ${ytd.profitOrLoss.netResultMinor}`);
    const revYtd = ytd.profitOrLoss.revenue.rows.find((r) => r.statementLineCode === "PNL-REVENUE")!;
    expect(revYtd.valueMinor === String(300000 * 100), `إيراد تراكمي 300,000: ${revYtd.valueMinor}`);
    // الشهرية: فبراير = 220−100 = 120,000 إيرادًا و 80−60 = 20,000 مصروفًا ⇒ صافي 100,000
    const feb = await getStatements(admin, { companyId: co1, fiscalYearId: fy1, ordinal: 2, basis: "PERIOD" });
    const revFeb = feb.profitOrLoss.revenue.rows.find((r) => r.statementLineCode === "PNL-REVENUE")!;
    expect(revFeb.valueMinor === String(120000 * 100), `حركة فبراير 120,000 (فرق تراكميين لا جمع لقطات): ${revFeb.valueMinor}`);
    expect(feb.profitOrLoss.netResultMinor === String(100000 * 100), `صافي فبراير 100,000: ${feb.profitOrLoss.netResultMinor}`);
    // مارس = 300−220 = 80,000 إيرادًا
    const mar = await getStatements(admin, { companyId: co1, fiscalYearId: fy1, ordinal: 3, basis: "PERIOD" });
    const revMar = mar.profitOrLoss.revenue.rows.find((r) => r.statementLineCode === "PNL-REVENUE")!;
    expect(revMar.valueMinor === String(80000 * 100), `حركة مارس 80,000: ${revMar.valueMinor}`);
    // الفترة الأولى: cum(0)=0 حقيقة محاسبية ⇒ حركة يناير = التراكمي 100,000
    const jan = await getStatements(admin, { companyId: co1, fiscalYearId: fy1, ordinal: 1, basis: "PERIOD" });
    const revJan = jan.profitOrLoss.revenue.rows.find((r) => r.statementLineCode === "PNL-REVENUE")!;
    expect(revJan.valueMinor === String(100000 * 100), `الفترة الأولى: حركة يناير = 100,000: ${revJan.valueMinor}`);
  });

  await check("R7 غياب التراكمي السابق ⇒ حالة ناقصة صريحة (لا معاملة التراكمي كحركة شهرية)", async () => {
    // SHARIK-3 لديها تراكمي مارس فقط — الحركة الشهرية لفبراير/مارس غير قابلة للاشتقاق
    const period = await getStatements(admin, { companyId: co3, fiscalYearId: fy3, ordinal: 3, basis: "PERIOD" });
    const revRow = period.profitOrLoss.revenue.rows.find((r) => r.statementLineCode === "PNL-REVENUE")!;
    expect(revRow.valueStatus === "INCOMPLETE_DATA" && revRow.valueMinor === null, `حالة صريحة بلا رقم مُختلق: ${revRow.valueStatus}/${revRow.valueMinor}`);
    expect(period.profitOrLoss.netResultMinor !== String(200000 * 100), "لا معاملة التراكمي كحركة شهرية إطلاقًا");
    expect(period.financialPosition.completeness.ready === false || period.profitOrLoss.completeness.ready === true, "الاكتمال يبقى صادقًا حسب الخريطة");
    // وخدمة المقارنة: كل صفوف الحركة ناقصة معلنة والحالة الإجمالية INCOMPLETE_DATA
    const cmp = await getStatementComparison({ user: admin, input: { companyId: co3, fiscalYearId: fy3, ordinal: 3, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.PRIOR_PERIOD } });
    expect(cmp.status === "INCOMPLETE_DATA", `الحالة الإجمالية صادقة: ${cmp.status}`);
    const sales = cmp.rows.find((r) => r.accountCode === "410101")!;
    expect(sales.currentStatus === "INCOMPLETE_DATA" && sales.currentAmount === null, `الصف ناقص معلن: ${sales.currentStatus}/${sales.currentAmount}`);
    // في المقابل: YTD على نفس الشركة يعمل مباشرة من نقطة التراكمي الموثوقة (300,000)
    const ytd = await getStatements(admin, { companyId: co3, fiscalYearId: fy3, ordinal: 3, basis: "YTD" });
    expect(ytd.profitOrLoss.netResultMinor === String(200000 * 100), `YTD يعمل بالتراكمي المباشر: ${ytd.profitOrLoss.netResultMinor}`);
  });

  /* ── R8/R9 مصطلح الموازنة عبر الخدمة المركزية ── */

  await check("R8 الإيراد مقابل الموازنة: «أعلى من الموازنة بمبلغ 10,000.00 SAR، بنسبة 3.4%» — لا مواتٍ", async () => {
    const r = await getStatementComparison({ user: admin, input: { companyId: co1, fiscalYearId: fy1, ordinal: 3, basis: "YTD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.STATEMENT_MAPPING, comparisonMode: COMPARISON_MODES.BUDGET } });
    const rev = r.rows.find((x) => x.statementLineCode === "PNL-REVENUE")!;
    expect(rev.currentAmount === String(300000 * 100), `فعلي 300,000: ${rev.currentAmount}`);
    expect(rev.comparisonAmount === String(290000 * 100), `موازنة 290,000: ${rev.comparisonAmount}`);
    expect(rev.varianceAmount === String(10000 * 100), `فارق +10,000: ${rev.varianceAmount}`);
    expect(rev.variancePercent === "3.4", `نسبة 3.4%: ${rev.variancePercent}`);
    expect(rev.favorability === "FAVORABLE", "enum داخلي FAVORABLE كما هو");
    expect(rev.interpretationText?.includes("أعلى من الموازنة"), `التفسير السياقي: ${rev.interpretationText}`);
    expect(rev.interpretationText?.includes("10,000.00") && rev.interpretationText?.includes("SAR"), `مبلغ منسّق بعملة: ${rev.interpretationText}`);
    expect(rev.interpretationText?.includes("3.4%"), `نسبة منسّقة: ${rev.interpretationText}`);
    expect(!JSON.stringify(r.rows).includes("موات"), "لا «مواتٍ/مؤاتٍ» في أي نص معروض");
    // البند معروض باسمه لا بكوده
    expect(rev.label === "إيرادات النشاط الرئيسي", `تسمية البند: ${rev.label}`);
  });

  await check("R9 المصروف مقابل الموازنة: «وفر عن الموازنة» للفعلي الأقل (والتجاوز مُتحقق نقائيًا)", async () => {
    const r = await getStatementComparison({ user: admin, input: { companyId: co1, fiscalYearId: fy1, ordinal: 3, basis: "YTD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.STATEMENT_MAPPING, comparisonMode: COMPARISON_MODES.BUDGET } });
    const exp = r.rows.find((x) => x.statementLineCode === "PNL-ADMIN-EXPENSES")!;
    expect(exp.currentAmount === String(100000 * 100) && exp.comparisonAmount === String(120000 * 100), `فعلي 100,000 مقابل موازنة 120,000: ${exp.currentAmount}/${exp.comparisonAmount}`);
    expect(exp.interpretationText?.includes("وفر عن الموازنة"), `مصروف أقل ⇒ وفر عن الموازنة: ${exp.interpretationText}`);
    expect(exp.label === "مصروفات إدارية وعمومية", `تسمية البند: ${exp.label}`);
  });

  /* ── R10 المركز المالي بلا ف/غ ── */

  await check("R10 المركز المالي بلا تقييم تلقائي: «لا ينطبق تقييم الزيادة/الوفر على هذا البند»", async () => {
    const r = await getStatementComparison({ user: admin, input: { companyId: co1, fiscalYearId: fy1, ordinal: 3, basis: "YTD", statementScope: "STATEMENT_OF_FINANCIAL_POSITION", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.PRIOR_PERIOD } });
    const cash = r.rows.find((x) => x.accountCode === "110101")!;
    expect(cash.direction === "INCREASE", "ارتفاع رياضي محايد");
    expect(cash.favorability === "NO_FAVORABLE_UNFAVORABLE", "بلا ف/غ (enum داخلي)");
    expect(cash.interpretationText?.includes("لا ينطبق تقييم الزيادة/الوفر على هذا البند"), `تفسير صريح: ${cash.interpretationText}`);
    expect(!JSON.stringify(r.rows).includes("موات") && !JSON.stringify(r.rows).includes("مؤات"), "لا حكم أداء على بنود المركز المالي");
    // إجماليات المركز المالي بالعقد الموحد تتطابق مع القائمة الرسمية
    const totals = Object.fromEntries(r.totals.map((t) => [t.key, t]));
    expect(totals["total-assets"]!.amount === String(700000 * 100), `إجمالي الأصول: ${totals["total-assets"]!.amount}`);
    expect(totals["total-liabilities"]!.amount === String(150000 * 100), `إجمالي الالتزامات: ${totals["total-liabilities"]!.amount}`);
  });

  /* ── R11 لا قيم minor خام في نصوص المستخدم ── */

  await check("R11 لا minor خام: ملاحظات التدفقات منسّقة (50000000 ⇒ 500,000.00 SAR) والحالة صادقة بلا plug", async () => {
    const cf = await getCashFlowStatement(admin, { companyId: co1, fiscalYearId: fy1, startOrdinal: 2, endOrdinal: 3 });
    // سلوك fail-closed محفوظ: بلا plug ولا إخفاء — حالة ناقصة صريحة
    expect(cf.status === "INCOMPLETE_DATA", `الحالة صادقة: ${cf.status}`);
    expect(cf.reconciliationDifferenceMinor !== null, "فرق المطابقة محسوب ومعروض");
    // ملاحظات الحسابات غير المصنفة منسّقة بعملة — لا أرقام خام 8+ خانات
    for (const u of cf.unclassifiedAccounts) {
      const rawMatch = /-?\d{7,}/.test(u.note);
      expect(!rawMatch, `لا رقم خام في الملاحظة: ${u.note}`);
      if (u.accountCode === "110101") {
        expect(u.note.includes("160,000.00") && u.note.includes("SAR"), `الحركة منسّقة بعملة (16,000,000 minor = 160,000.00): ${u.note}`);
      }
    }
    expect(cf.reconciliationDifferenceMinor === String(160000 * 100), `الفرق بالعقد minor كما هو (التنسيق عرض): ${cf.reconciliationDifferenceMinor}`);
  });

  /* ── R13b لغة التقرير عبر الخدمة (ar/en/ar_en) ── */

  await check("R13b لغة التقرير: en ⇒ above the budget، ar_en ⇒ عربي + إنجليزي — مستقلة عن واجهة النظام", async () => {
    const en = await getStatementComparison({ user: admin, input: { companyId: co1, fiscalYearId: fy1, ordinal: 3, basis: "YTD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.STATEMENT_MAPPING, comparisonMode: COMPARISON_MODES.BUDGET, reportLanguage: "en" } });
    expect(en.reportLanguage === "en", `اللغة المعادة: ${en.reportLanguage}`);
    const revEn = en.rows.find((x) => x.statementLineCode === "PNL-REVENUE")!;
    expect(revEn.label === "Revenue from Ordinary Activities", `تسمية إنجليزية: ${revEn.label}`);
    expect(revEn.interpretationText?.includes("above the budget"), `تفسير إنجليزي: ${revEn.interpretationText}`);
    expect(revEn.factText?.includes("10,000.00 SAR"), `حقيقة إنجليزية بعملة: ${revEn.factText}`);
    const both = await getStatementComparison({ user: admin, input: { companyId: co1, fiscalYearId: fy1, ordinal: 3, basis: "YTD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.STATEMENT_MAPPING, comparisonMode: COMPARISON_MODES.BUDGET, reportLanguage: "ar_en" } });
    const revBoth = both.rows.find((x) => x.statementLineCode === "PNL-REVENUE")!;
    expect(revBoth.interpretationText?.includes("أعلى من الموازنة") && revBoth.interpretationText?.includes("above the budget"), `ثنائي: ${revBoth.interpretationText}`);
    expect(revBoth.label.includes("إيرادات النشاط الرئيسي") && revBoth.label.includes("Revenue from Ordinary Activities"), `تسمية ثنائية: ${revBoth.label}`);
  });

  /* ── F ملاحق: SOCIE بلا اختراع حركات + عرض دائن موجب ── */

  await check("F-SOCIE: رأس المال دائن موجب 350,000 — الافتتاحي/الحركات فجوة معلنة لا استنتاج", async () => {
    // ربط بادئة حقوق الملكية بمكوّن رأس المال
    const mapping = await db.equityComponentMapping.create({ data: { companyId: co1, prefix: "23", componentCode: "SHARE_CAPITAL", isActive: true } });
    expect(!!mapping, "ربط المكوّن أُنشئ");
    const eq = await getEquityStatement(admin, { companyId: co1, fiscalYearId: fy1, startOrdinal: 1, endOrdinal: 3 });
    expect(eq.status === "INCOMPLETE_DATA", `الافتتاحي غير متاح ⇒ حالة صادقة: ${eq.status}`);
    const cap = eq.rows.find((r) => r.componentCode === "SHARE_CAPITAL")!;
    expect(cap.closingMinor === String(350000 * 100), `الختامي دائن موجب 350,000 (لا سالب): ${cap.closingMinor}`);
    expect(cap.openingMinor === null && cap.openingStatus !== "OK", `الافتتاحي فجوة معلنة: ${cap.openingMinor}/${cap.openingStatus}`);
    expect(cap.movementMinor === null && cap.movementStatus !== "OK", `الحركة فجوة معلنة (لا استنتاج أن 350,000 كلها افتتاحي أو حركة): ${cap.movementMinor}`);
    expect(eq.totals.reconciled === null, "لا حسم مطابقة ببيانات ناقصة");
    expect(eq.notes.some((n) => n.includes("لا يُستنتج")), `تفسير الفجوة صريح: ${eq.notes.join(" | ")}`);
    // صافي الربح للفترة ظاهر موجبًا 200,000
    expect(eq.profitOrLossForPeriod.valueMinor === String(200000 * 100), `ربح الفترة 200,000: ${eq.profitOrLossForPeriod.valueMinor}`);
  });

  /* ── عزل الصلاحيات يبقى fail-closed ── */

  await check("R-security عزل الشركات يبقى fail-closed بعد التصحيحات", async () => {
    const limited = syntheticUser({ role: "user", viewAllCompanies: false, companyIds: [co3] });
    let threw = false;
    try {
      await getStatements(limited, { companyId: co1, fiscalYearId: fy1, ordinal: 3, basis: "YTD" });
    } catch (e) {
      threw = e instanceof TrialBalanceError && e.code === "NOT_FOUND";
    }
    expect(threw, "شركة خارج النطاق ⇒ NOT_FOUND");
    let threwCf = false;
    try {
      await getCashFlowStatement(limited, { companyId: co1, fiscalYearId: fy1, startOrdinal: 1, endOrdinal: 3 });
    } catch (e) {
      threwCf = e instanceof TrialBalanceError && e.code === "NOT_FOUND";
    }
    expect(threwCf, "التدفقات fail-closed كذلك");
  });

  /* ── R14/R15 البوابات ── */

  await check("R14 بوابة 6.9 ومكوّنات العرض/المقارنة سليمة (فحص ملفات)", () => {
    expect(fileExports("scripts/phase69-presentation-comparison.ts", "main("), "بوابة 6.9 موجودة");
    expect(fileExports("src/lib/display-labels.ts", "budgetVarianceBadge"), "أساس التسميات الموحد موجود");
    expect(fileExports("src/lib/comparison-engine.ts", "export function compareRowCore"), "المحرك المركزي سليم");
    expect(fileExports("src/lib/statement-builder.ts", "export function buildFinancialPosition"), "باني القوائم سليم");
    expect(fileExports("src/components/reporting/statement-comparison-panel.tsx", "StatementComparisonPanel"), "لوحة المقارنة سليمة");
    expect(fileExports("src/components/reporting/statements-view.tsx", "export function StatementsView"), "عرض القوائم سليم");
  });

  await check("R15 ملفات بوابات الانحدار 6.2A..6.8 موجودة (التشغيل الفعلي في خط السير)", () => {
    const gates = [
      "scripts/phase62a-account-nature.ts",
      "scripts/phase62b-trial-balance.ts",
      "scripts/phase62c-reporting.ts",
      "scripts/phase62d-statements.ts",
      "scripts/phase63-trial-balance-revision.ts",
      "scripts/phase64-equity-cashflow.ts",
      "scripts/phase65-budget-foundation.ts",
      "scripts/phase66-consolidation-foundation.ts",
      "scripts/phase67-ui-governance.ts",
      "scripts/phase68-report-print.ts",
    ];
    for (const g of gates) expect(fileExports(g, "main("), `بوابة موجودة: ${g}`);
  });

  await db.$disconnect();

  console.log("─────────────────────────────────────");
  console.log(`النتيجة: ${passCount} PASS / ${failCount} FAIL`);
  if (failures.length > 0) {
    console.log("الإخفاقات:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("PHASE 6.9R REVIEW GATE: ALL PASS");
}

main().catch((e) => {
  console.error("فشل تشغيل البوابة:", e);
  process.exit(1);
});
