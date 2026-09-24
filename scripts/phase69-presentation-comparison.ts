// Phase 6.9 — بوابة إثبات العرض والمقارنة (أوضاع العرض × أوضاع المقارنة).
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-69-gate.db bun scripts/phase69-presentation-comparison.ts
// (تُنشأ dev-69-gate.db من migrations حصرًا: bunx prisma migrate deploy — عزل صارم عن custom.db)
//
// الفحوص (تعليمات 6.9-18) — قاعدة معزولة + فحوص نقية + فحص ملفات الانحدار:
//   T1  عرض كافة الحسابات (ALL_ACCOUNTS)
//   T2  الحسابات الرئيسية/الفرعية — سلوك الهرمية المشتقة
//   T3  حسب مستوى الحساب — ترشيح/تجميع + فشل واضح لمستوى غير موجود
//   T4  عرض حسب تصنيف القوائم المالية (STATEMENT_MAPPING)
//   T5  مقارنة الفترة السابقة: 120 مقابل 100 ⇒ +20 و20%
//   T6  انخفاض: 80 مقابل 100 ⇒ −20 و−20%
//   T7  مقام صفر: لا Infinity ولا NaN إطلاقًا
//   T8  مقارنة ناقصة: حالة معلنة NO_COMPARISON_DATA لا صفر مُختلق
//   T9  سنة غير تقويمية: يوليو/أغسطس/سبتمبر بالترتيب الترتيبي + مناظر السنة السابقة بالordinal
//   T10 سلوك حسابات الحركة (FLOW): حركة الفترة والتراكمي من الجسور المركزية
//   T11 سلوك الأرصدة (BALANCE): أرصدة إقفال 100/140/125 ⇒ سبتمبر = 125 لا 365
//   T12 CUMULATIVE_YTD لا يُجمع مزدوجًا: تراكمي مارس = 300 لا 620
//   T13 PERIOD_MOVEMENT: تجميع YTD صحيح (100+120+80 = 300)
//   T14 فعلي مقابل موازنة: قاعدة ف/غ للإيراد والمصروف تختلف بشكل صحيح
//   T15 قائمة المركز المالي: بلا تسمية ف/غ افتراضيًا
//   T16 عزل الشركات: fail-closed للشركة خارج النطاق
//   T17 التتبع: كل صف يحتفظ بمراجع حساباته المصدرية
//   T18 مسارات ومكونات 6.8 تبقى سليمة + ملفات بوابات الانحدار موجودة
//   + فحوص نقية: نسب مئوية BigInt > 2^53، متوسط مقرّب، عتبات المراجعة

import { readFileSync } from "node:fs";

import type { SessionUser } from "../src/lib/session";
import {
  variancePercentString,
  averageRounded,
  absPercentAtLeast,
  compareRowCore,
  PRESENTATION_MODES,
  COMPARISON_MODES,
} from "../src/lib/comparison-engine";
import { deriveAccountHierarchy } from "../src/lib/account-hierarchy";
import { createTrialBalance, commitTrialBalance } from "../src/lib/trial-balance-server";
import { createBudget, transitionBudget } from "../src/lib/budget-server";
import { getStatementComparison } from "../src/lib/comparison-server";
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

function syntheticUser(over: Partial<{ role: string; companyIds: string[]; viewAllCompanies: boolean; username: string }> = {}): SessionUser {
  return {
    id: "gate-user-69",
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

async function createNonCalendarFy(db: any, companyId: string, code: string, startYear: number) {
  // يوليو startYear → يونيو startYear+1 — الفترة 1 = يوليو، 2 = أغسطس، 3 = سبتمبر
  const fy = await db.fiscalYear.create({ data: { companyId, code, startDate: `${startYear}-07-01`, endDate: `${startYear + 1}-06-30`, periodCount: 12 } });
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(startYear, 6 + i, 1));
    const end = new Date(Date.UTC(startYear, 7 + i, 0));
    const iso = (x: Date) => x.toISOString().slice(0, 10);
    await db.fiscalPeriod.create({ data: { fiscalYearId: fy.id, ordinal: i + 1, code: `${startYear}-P${i + 1}`, startDate: iso(d), endDate: iso(end), displayLabel: `فترة ${i + 1}` } });
  }
  return fy;
}

async function seedRules(db: any, companyId: string) {
  // أكواد متوافقة مع الجذور النظامية المجمدة (1=أصول 2=خصوم/حقوق 3=مصروفات 4=إيرادات)
  for (const [prefix, classification, behavior, lineCode] of [
    ["11", "ASSET", "BALANCE", "SFP-CASH"],
    ["21", "LIABILITY", "BALANCE", "SFP-LIA-CL"],
    ["22", "EQUITY", "BALANCE", "SFP-EQUITY"],
    ["33", "EXPENSE", "FLOW", "PNL-ADMIN-EXPENSES"],
    ["41", "REVENUE", "FLOW", "PNL-REVENUE"],
  ] as const) {
    const sl = await db.financialStatementLine.findUniqueOrThrow({ where: { code: lineCode } });
    await db.accountNatureRule.create({ data: { companyId, prefix, classification, aggregationBehavior: behavior, source: "MANUAL", statementLineId: sl.id } });
  }
}

async function main() {
  console.log("═══ بوابة Phase 6.9 — العرض والمقارنة ══");
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-69"), "الأداة تعمل على dev-69-gate.db حصرًا (عزل صارم)");

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ log: [], datasources: { db: { url: url! } } });

  const admin = syntheticUser();

  let coA = ""; let fyA = ""; let coC = ""; let fyC = ""; let coD = ""; let fyD26 = ""; let fyD25 = ""; let coB = ""; let fyB = "";

  /* ── فحوص نقية أولًا (بلا قاعدة) ── */

  await check("P1 نسب مئوية BigInt دقيقة > 2^53 (بلا Number)", () => {
    // current 9007199254740993 (2^53+1) مقابل base 4503599627370496 (2^52) ⇒ 200.0%
    const pct = variancePercentString(BigInt("9007199254740993"), BigInt("4503599627370496"));
    expect(pct === "200.0", `نسبة ضخمة دقيقة: ${pct}`);
    const neg = variancePercentString(BigInt("-9007199254740993"), BigInt("4503599627370496"));
    expect(neg === "-200.0", `نسبة سالبة دقيقة: ${neg}`);
    expect(variancePercentString(BigInt(100), BigInt(0)) === null, "مقام صفر ⇒ null لا Infinity");
    expect(variancePercentString(BigInt(100), null) === null, "مقام مفقود ⇒ null");
    expect(!variancePercentString(BigInt(20), BigInt(100))!.includes("Infinity"), "لا Infinity");
    expect(!JSON.stringify({ p: variancePercentString(BigInt(5), BigInt(100)) }).includes("NaN"), "لا NaN");
  });

  await check("P2 متوسط مقرّب BigInt + عتبات المراجعة المركزية", () => {
    expect(averageRounded(BigInt(100), 3) === BigInt(33), "100/3 مقرّب لأسفل: 33");
    expect(averageRounded(BigInt(101), 3) === BigInt(34), "101/3 مقرّب لأقرب: 34");
    expect(averageRounded(BigInt(-101), 3) === BigInt(-34), "سالب مقرّب بعيدًا عن الصفر: −34");
    expect(absPercentAtLeast(BigInt(30), BigInt(100), 25) === true, "30% ≥ 25%");
    expect(absPercentAtLeast(BigInt(20), BigInt(100), 25) === false, "20% < 25%");
    expect(absPercentAtLeast(BigInt("9007199254740993"), BigInt("4503599627370496"), 200) === true, "عتبة على قيم ضخمة بلا Number");
  });

  await check("P3 اشتقاق الهرمية: الرئيسية/الأوراق/المستويات + شواذ معلنة", () => {
    const h = deriveAccountHierarchy(["4101", "410101", "410199", "520101", "", "  "]);
    expect(h.mains.length === 1 && h.mains[0] === "4101", `الرئيسية = 4101: ${h.mains.join(",")}`);
    expect(h.leaves.includes("410101") && h.leaves.includes("410199") && h.leaves.includes("520101"), "الأوراق صحيحة");
    expect(h.levelOf.get("4101") === 1 && h.levelOf.get("410101") === 2, "المستويات: 4101=1، 410101=2");
    expect(h.parentOf.get("410101") === "4101", "أب 410101 = 4101");
    expect(h.maxLevel === 2, `أقصى مستوى 2: ${h.maxLevel}`);
    expect(h.anomalies.length === 2, `شواذ (أكواد فارغة) معلنة: ${h.anomalies.length}`);
  });

  await check("P4 نواة الصف: تفسير حتمي سياقي — إيراد أعلى من الموازنة، مصروف وفر، أرصدة بلا تقييم", () => {
    const rev = compareRowCore({ currentMinor: BigInt(120), currentStatus: "OK", comparisonMinor: BigInt(100), comparisonStatus: "OK", lineNature: "REVENUE", mappingStatus: "FULLY_MAPPED", basisLabel: "الفترة السابقة" });
    expect(rev.favorability === "FAVORABLE" && rev.direction === "INCREASE", "إيراد أعلى ⇒ مواتٍ (enum داخلي)");
    expect(rev.varianceMinor === "20" && rev.variancePercent === "20.0", `فارق/نسبة: ${rev.varianceMinor}/${rev.variancePercent}`);
    expect(rev.factText?.includes("ارتفع") && rev.factText?.includes("20.0%"), `نص حقيقة: ${rev.factText}`);
    const exp = compareRowCore({ currentMinor: BigInt(80), currentStatus: "OK", comparisonMinor: BigInt(100), comparisonStatus: "OK", lineNature: "EXPENSE", mappingStatus: "FULLY_MAPPED", basisLabel: "الموازنة المعتمدة" });
    expect(exp.favorability === "FAVORABLE" && exp.interpretationText?.includes("وفر"), `مصروف أقل ⇒ وفر: ${exp.interpretationText}`);
    const bal = compareRowCore({ currentMinor: BigInt(120), currentStatus: "OK", comparisonMinor: BigInt(100), comparisonStatus: "OK", lineNature: "OTHER", mappingStatus: "FULLY_MAPPED", basisLabel: "الفترة السابقة" });
    expect(bal.favorability === "NO_FAVORABLE_UNFAVORABLE", "أرصدة ⇒ بلا ف/غ (enum داخلي)");
    // جولة المراجعة C: صياغة صريحة بدل «بلا حكم ف/غ»
    expect(bal.interpretationText?.includes("لا ينطبق تقييم الزيادة/الوفر على هذا البند"), `تفسير رصيد محايد: ${bal.interpretationText}`);
    const flagged = compareRowCore({ currentMinor: BigInt(1000), currentStatus: "OK", comparisonMinor: BigInt(100), comparisonStatus: "OK", lineNature: "REVENUE", mappingStatus: "NEEDS_CLASSIFICATION", basisLabel: null });
    expect(flagged.flags.includes("LARGE_VARIANCE_PERCENT") && flagged.flags.includes("UNCLASSIFIED_ACCOUNT"), `علامات: ${flagged.flags.join(",")}`);
    expect(flagged.reviewGuidance?.includes("يوصى"), `إرشاد استشاري: ${flagged.reviewGuidance}`);
  });

  /* ── G0 تهيئة القاعدة المعزولة ── */

  await check("G0 تهيئة: شركات + سنوات (تقويمية وغير تقويمية) + قواعد + ميازين معتمدة + موازنة", async () => {
    const a = await db.company.create({ data: { code: "RP-A", nameAr: "شركة عرض أ", functionalCurrency: "YER" } });
    coA = a.id;
    const b = await db.company.create({ data: { code: "RP-B", nameAr: "شركة عرض ب" } });
    coB = b.id;
    const fyBcreated = await createCalendarFy(db, coB, "FY2026-B", 2026);
    fyB = fyBcreated.id;
    const c = await db.company.create({ data: { code: "RP-C", nameAr: "شركة عرض ج" } });
    coC = c.id;
    const d = await db.company.create({ data: { code: "RP-D", nameAr: "شركة غير تقويمية" } });
    coD = d.id;

    const fyA26 = await createCalendarFy(db, coA, "FY2026-A", 2026);
    fyA = fyA26.id;
    const fyC26 = await createCalendarFy(db, coC, "FY2026-C", 2026);
    fyC = fyC26.id;
    const fyD25created = await createNonCalendarFy(db, coD, "FY2025-NC", 2025);
    fyD25 = fyD25created.id;
    const fyD26created = await createNonCalendarFy(db, coD, "FY2026-NC", 2026);
    fyD26 = fyD26created.id;

    await seedRules(db, coA);
    await seedRules(db, coC);
    await seedRules(db, coD);

    // شركة أ — CUMULATIVE_YTD: يناير/فبراير/مارس (متوازن مدينًا=دائنًا — المدخلات بالوحدات الرئيسية ×100 minor)
    // الحركات: إيراد 410101 = 100/120/80؛ رئيسي 4101 (أب حقيقي) = 50/10/0؛ 410199 = 20/80/0
    // المصروف 520101 = 100/80/30؛ الأرصدة نقدية 100/140/125 (فحص BALANCE)
    const tbJan = await createTrialBalance({
      user: admin, ip: "gate-69",
      input: {
        companyId: coA, fiscalYearId: fyA, fromDate: "2026-01-01", toDate: "2026-01-31",
        dataType: "CUMULATIVE_YTD", reason: "بوابة 6.9 يناير",
        lines: [
          line("110101", 100, 0, "نقدية"),
          line("330101", 100, 0, "رواتب"),
          line("410101", 0, 100, "مبيعات"),
          line("4101", 0, 50, "إيرادات رئيسية"),
          line("410199", 0, 20, "إيراد أخرى"),
          line("210101", 0, 100, "دائنون"),
          line("220101", 70, 0, "عجز مرحّل"),
        ],
      },
    });
    await commitTrialBalance({ user: admin, ip: "gate-69", id: tbJan.import.id, input: { version: tbJan.import.version, reason: "بوابة" } });

    const tbFeb = await createTrialBalance({
      user: admin, ip: "gate-69",
      input: {
        companyId: coA, fiscalYearId: fyA, fromDate: "2026-01-01", toDate: "2026-02-28",
        dataType: "CUMULATIVE_YTD", reason: "بوابة 6.9 فبراير",
        lines: [
          line("110101", 140, 0, "نقدية"),
          line("330101", 180, 0, "رواتب"),
          line("410101", 0, 220, "مبيعات"),
          line("410199", 0, 100, "إيراد أخرى"),
          line("4101", 0, 60, "إيرادات رئيسية"),
          line("210101", 0, 100, "دائنون"),
          line("220101", 160, 0, "عجز مرحّل"),
        ],
      },
    });
    await commitTrialBalance({ user: admin, ip: "gate-69", id: tbFeb.import.id, input: { version: tbFeb.import.version, reason: "بوابة" } });
    const tbMar = await createTrialBalance({
      user: admin, ip: "gate-69",
      input: {
        companyId: coA, fiscalYearId: fyA, fromDate: "2026-01-01", toDate: "2026-03-31",
        dataType: "CUMULATIVE_YTD", reason: "بوابة 6.9 مارس",
        lines: [
          line("110101", 125, 0, "نقدية"),
          line("330101", 210, 0, "رواتب"),
          line("410101", 0, 300, "مبيعات"),
          line("410199", 0, 100, "إيراد أخرى"),
          line("4101", 0, 60, "إيرادات رئيسية"),
          line("210101", 0, 100, "دائنون"),
          line("220101", 225, 0, "عجز مرحّل"),
        ],
      },
    });
    await commitTrialBalance({ user: admin, ip: "gate-69", id: tbMar.import.id, input: { version: tbMar.import.version, reason: "بوابة" } });
    // شركة ج — PERIOD_MOVEMENT: حركات 100/120/80 (فحص تجميع YTD)
    const cP = [[100, 60, 100, 60], [120, 80, 140, 100], [80, 90, 125, 135]] as const;
    for (let i = 0; i < 3; i++) {
      const mm = String(i + 1).padStart(2, "0");
      const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
      const [rev, exp, cash, eq] = cP[i];
      const imp = await createTrialBalance({
        user: admin, ip: "gate-69",
        input: {
          companyId: coC, fiscalYearId: fyC, fromDate: `2026-${mm}-01`, toDate: `2026-${mm}-${last}`,
          dataType: "PERIOD_MOVEMENT", reason: `بوابة 6.9 حركة ${mm}`,
          lines: [
            line("110101", cash, 0, "نقدية"),
            line("330101", exp, 0, "رواتب"),
            line("410101", 0, rev, "مبيعات"),
            line("220101", 0, eq, "حقوق"),
          ],
        },
      });
      await commitTrialBalance({ user: admin, ip: "gate-69", id: imp.import.id, input: { version: imp.import.version, reason: "بوابة" } });
    }

    // شركة د — سنوات غير تقويمية: FY2025-NC حركات (يوليو/أغسطس/سبتمبر) + FY2026-NC فترة 2
    const nc25 = [[100, 100], [120, 120], [80, 80]] as const;
    for (let i = 0; i < 3; i++) {
      const p = await db.fiscalPeriod.findUniqueOrThrow({ where: { fiscalYearId_ordinal: { fiscalYearId: fyD25, ordinal: i + 1 } } });
      const [rev, exp] = nc25[i];
      const imp = await createTrialBalance({
        user: admin, ip: "gate-69",
        input: {
          companyId: coD, fiscalYearId: fyD25, fromDate: p.startDate, toDate: p.endDate,
          dataType: "PERIOD_MOVEMENT", reason: `بوابة 6.9 NC فترة ${i + 1}`,
          lines: [line("410101", 0, rev, "مبيعات"), line("330101", exp, 0, "رواتب")],
        },
      });
      await commitTrialBalance({ user: admin, ip: "gate-69", id: imp.import.id, input: { version: imp.import.version, reason: "بوابة" } });
    }
    const p2nc = await db.fiscalPeriod.findUniqueOrThrow({ where: { fiscalYearId_ordinal: { fiscalYearId: fyD26, ordinal: 2 } } });
    const impD26 = await createTrialBalance({
      user: admin, ip: "gate-69",
      input: {
        companyId: coD, fiscalYearId: fyD26, fromDate: p2nc.startDate, toDate: p2nc.endDate,
        dataType: "PERIOD_MOVEMENT", reason: "بوابة 6.9 NC26 فترة 2",
        lines: [
          line("410101", 0, 130, "مبيعات"),
          line("330101", 130, 0, "رواتب"),
          line("410105", 0, 25, "إيراد جديد (غائب عن السنة السابقة)"),
          line("330105", 25, 0, "مصروف جديد"),
        ],
      },
    });
    await commitTrialBalance({ user: admin, ip: "gate-69", id: impD26.import.id, input: { version: impD26.import.version, reason: "بوابة" } });

    // موازنة معتمدة لشركة أ (فترات 1-3): فترة 1 مصروف صفر حقيقي (مقام صفر)؛
    // فترة 2 (إيراد 100 / مصروف 100)؛ فترة 3 (إيراد 100 / مصروف 50)
    const p1 = await db.fiscalPeriod.findUniqueOrThrow({ where: { fiscalYearId_ordinal: { fiscalYearId: fyA, ordinal: 1 } } });
    const p2 = await db.fiscalPeriod.findUniqueOrThrow({ where: { fiscalYearId_ordinal: { fiscalYearId: fyA, ordinal: 2 } } });
    const p3 = await db.fiscalPeriod.findUniqueOrThrow({ where: { fiscalYearId_ordinal: { fiscalYearId: fyA, ordinal: 3 } } });
    const budget = await createBudget({
      user: admin, ip: "gate-69",
      input: {
        companyId: coA, fiscalYearId: fyA, budgetType: "MONTHLY", scenario: "BASE", startOrdinal: 1, endOrdinal: 3,
        lines: [
          { statementLineCode: "PNL-ADMIN-EXPENSES", fiscalPeriodId: p1.id, amountMinor: "0" },
          { statementLineCode: "PNL-REVENUE", fiscalPeriodId: p2.id, amountMinor: "10000" },
          { statementLineCode: "PNL-ADMIN-EXPENSES", fiscalPeriodId: p2.id, amountMinor: "10000" },
          { statementLineCode: "PNL-REVENUE", fiscalPeriodId: p3.id, amountMinor: "10000" },
          { statementLineCode: "PNL-ADMIN-EXPENSES", fiscalPeriodId: p3.id, amountMinor: "5000" },
        ],
      },
    });
    const submitted = await transitionBudget({ user: admin, ip: "gate-69", id: budget.id, input: { action: "SUBMIT", version: budget.version, reason: "بوابة" } });
    const approved = await transitionBudget({ user: admin, ip: "gate-69", id: submitted.id, input: { action: "APPROVE", version: submitted.version, reason: "بوابة" } });
    expect(approved.status === "APPROVED", `الموازنة معتمدة: ${approved.status}`);
  });

  /* ── T1..T4 أوضاع العرض (بلا مقارنة) ── */

  await check("T1 عرض كافة الحسابات: كل حسابات النطاق صفوف بقيم معايرة", async () => {
    const r = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.NONE },
    });
    expect(r.rows.length === 4, `4 حسابات حركة (4101/410101/410199/520101): ${r.rows.length}`);
    const sales = r.rows.find((x) => x.accountCode === "410101")!;
    expect(sales.kind === "ACCOUNT" && sales.currentAmount === "12000", `حركة فبراير معايرة دائن موجب (minor): ${sales.currentAmount}`);
    expect(sales.comparisonStatus === "NOT_COMPARABLE", "بلا مقارنة ⇒ NOT_COMPARABLE معلن");
    expect(sales.sourceAccountCodes.length === 1 && sales.sourceAccountCodes[0] === "410101", "تتبع الحساب المفرد");
    const unclassified = r.summary.unclassified;
    expect(unclassified === 0, `كل الحسابات مصنفة بالكامل: ${unclassified}`);
    expect(r.status === "OK", `الحالة: ${r.status}`);
  });

  await check("T2 الرئيسية/الفرعية: تجميع العقدة الرئيسية + صرامة الاكتمال في المقارنة", async () => {
    const main = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.MAIN_ACCOUNTS, comparisonMode: COMPARISON_MODES.PRIOR_PERIOD },
    });
    const group = main.rows.find((x) => x.accountCode === "4101")!;
    expect(group.kind === "GROUP" && group.depth === 0, "4101 عقدة رئيسية بالجذر");
    expect(group.currentAmount === "21000", `قيمة المجموعة = قيمتها 1000 + أبناؤها 20000 (minor): ${group.currentAmount}`);
    expect(group.comparisonAmount === "17000", `مقارنة المجموعة (يناير = 50+100+20)×100: ${group.comparisonAmount}`);
    expect(group.varianceAmount === "4000", `فارق المجموعة: ${group.varianceAmount}`);
    expect(group.sourceAccountCodes.includes("410101") && group.sourceAccountCodes.includes("410199"), "تتبع الأبناء داخل المجموعة");
    const child = main.rows.find((x) => x.accountCode === "410101")!;
    expect(child.depth === 1 && child.kind === "ACCOUNT", "الأبناء بعمق 1");
    expect(child.currentAmount === "12000" && child.comparisonAmount === "10000", `الابن مقارنة سليمة: ${child.currentAmount}/${child.comparisonAmount}`);
    const leaf = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.LEAF_ACCOUNTS, comparisonMode: COMPARISON_MODES.NONE },
    });
    expect(!leaf.rows.some((x) => x.accountCode === "4101"), "الرئيسية غائبة من عرض الأوراق");
    expect(leaf.rows.filter((x) => x.kind === "ACCOUNT").length === 3, `أوراق النطاق (410101/410199/520101): ${leaf.rows.length}`);
    expect(main.notes.some((n) => n.includes("مشتقة")), "ملاحظة شفافية اشتقاق الهرمية معلنة");
  });

  await check("T3 حسب مستوى الحساب: ترشيح وتجميع + فشل واضح لمستوى غير موجود", async () => {
    const lvl1 = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ACCOUNT_LEVEL, accountLevel: 1, comparisonMode: COMPARISON_MODES.NONE },
    });
    const g = lvl1.rows.find((x) => x.accountCode === "4101")!;
    expect(g.level === 1 && g.currentAmount === "21000", `مستوى 1 مجمّع (minor): ${g.currentAmount}`);
    expect(lvl1.rows.every((x) => x.level === 1), "كل صفوف المستوى الأول فقط");
    const lvl2 = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ACCOUNT_LEVEL, accountLevel: 2, comparisonMode: COMPARISON_MODES.NONE },
    });
    expect(lvl2.rows.some((x) => x.accountCode === "410101" && x.currentAmount === "12000"), "مستوى 2: 410101 بقيمته المفردة (minor)");
    expect(lvl2.rows.every((x) => x.accountCode !== "4101"), "الرئيسية غير مكررة في المستوى الثاني");
    const lvl99 = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ACCOUNT_LEVEL, accountLevel: 99, comparisonMode: COMPARISON_MODES.NONE },
    });
    expect(lvl99.rows.length === 0 && lvl99.hierarchyMaxLevel === 2, "فشل واضح: مستوى 99 غير موجود (أقصى 2)");
    expect(lvl99.statusDetail?.includes("أقصى مستوى"), `تفصيل الفشل: ${lvl99.statusDetail}`);
  });

  await check("T4 عرض حسب تصنيف القوائم: بنود مرتبة + تفصيل حسابات + ملاحظة عدم ادعاء IFRS", async () => {
    const r = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.STATEMENT_MAPPING, comparisonMode: COMPARISON_MODES.NONE },
    });
    const rev = r.rows.find((x) => x.statementLineCode === "PNL-REVENUE")!;
    expect(rev.kind === "LINE" && rev.currentAmount === "21000", `بند الإيراد = 1000+12000+8000 (minor): ${rev.currentAmount}`);
    expect((rev.accounts?.length ?? 0) === 3, `تفصيل الحسابات الثلاثة: ${rev.accounts?.length}`);
    const exp = r.rows.find((x) => x.statementLineCode === "PNL-ADMIN-EXPENSES")!;
    expect(exp.currentAmount === "8000", `بند المصروف (minor): ${exp.currentAmount}`);
    const totals = Object.fromEntries(r.totals.map((t) => [t.key, t]));
    expect(totals["total-revenue"].amount === "21000" && totals["total-expense"].amount === "8000", "إجماليات من كل الحسابات المصدرية");
    expect(totals["net-result"].amount === "13000", `صافي = 21000−8000: ${totals["net-result"].amount}`);
    expect(r.notes.some((n) => n.includes("لا يعني هذا العرض بذاته امتثالًا")), "إخلاء مسؤولية IFRS معلن");
  });

  /* ── T5..T9 المقارنات ── */

  await check("T5 الفترة السابقة: 120 مقابل 100 ⇒ +20 و20%", async () => {
    const r = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.PRIOR_PERIOD },
    });
    const sales = r.rows.find((x) => x.accountCode === "410101")!;
    expect(sales.comparisonAmount === "10000", `مقارنة يناير (minor): ${sales.comparisonAmount}`);
    expect(sales.varianceAmount === "2000" && sales.variancePercent === "20.0", `فارق/نسبة: ${sales.varianceAmount}/${sales.variancePercent}`);
    expect(sales.direction === "INCREASE", `الاتجاه: ${sales.direction}`);
    expect(sales.factText?.includes("الفترة السابقة"), `نص الحقيقة بالمرجع: ${sales.factText}`);
    expect(r.comparisonTarget?.fromDate === "2026-01-01" && r.comparisonTarget?.toDate === "2026-01-31", "هدف المقارنة = يناير بالتواريخ الفعلية");
  });

  await check("T6 انخفاض: 80 مقابل 100 ⇒ −20 و−20%", async () => {
    const r = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.PRIOR_PERIOD },
    });
    const salaries = r.rows.find((x) => x.accountCode === "330101")!;
    expect(salaries.varianceAmount === "-2000" && salaries.variancePercent === "-20.0", `فارق/نسبة: ${salaries.varianceAmount}/${salaries.variancePercent}`);
    expect(salaries.direction === "DECREASE", `الاتجاه: ${salaries.direction}`);
  });

  await check("T7 مقام صفر: موازنة صفر حقيقية ⇒ نسبة null لا Infinity + صفر ≠ موازنة غائبة", async () => {
    // فترة 1: مصروف فعلي 100 مقابل موازنة صفر حقيقية (0) ⇒ نسبة null؛ الإيراد بلا بند موازنة ⇒ NO_COMPARISON_DATA
    const r = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 1, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.STATEMENT_MAPPING, comparisonMode: COMPARISON_MODES.BUDGET },
    });
    const exp = r.rows.find((x) => x.statementLineCode === "PNL-ADMIN-EXPENSES")!;
    expect(exp.comparisonAmount === "0", `موازنة صفر حقيقية (ليست غائبة): ${exp.comparisonAmount}`);
    expect(exp.variancePercent === null, `النسبة null لا Infinity: ${exp.variancePercent}`);
    expect(exp.varianceAmount === "10000", `الفارق صحيح (minor): ${exp.varianceAmount}`);
    expect(exp.favorability === "UNFAVORABLE", `مصروف أعلى من موازنة ⇒ غير مؤاتٍ: ${exp.favorability}`);
    const rev = r.rows.find((x) => x.statementLineCode === "PNL-REVENUE")!;
    expect(rev.comparisonStatus === "NO_COMPARISON_DATA" && rev.comparisonAmount === null, "بند بلا موازنة ⇒ NO_COMPARISON_DATA لا صفر");
    expect(!JSON.stringify(r).includes("Infinity") && !JSON.stringify(r).includes("NaN"), "لا Infinity ولا NaN في العقد كاملًا");
  });

  await check("T8 مقارنة ناقصة: حساب جديد غائب عن السنة السابقة ⇒ NO_COMPARISON_DATA معلن", async () => {
    const r = await getStatementComparison({
      user: admin,
      input: { companyId: coD, fiscalYearId: fyD26, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.PRIOR_YEAR_PERIOD },
    });
    const newcomer = r.rows.find((x) => x.accountCode === "410105")!;
    expect(!!newcomer, "الحساب الجديد ظاهر (لا يُخفى)");
    expect(newcomer.currentAmount === "2500", `قيمته الحالية (minor): ${newcomer.currentAmount}`);
    expect(newcomer.comparisonAmount === null && newcomer.comparisonStatus === "NO_COMPARISON_DATA", `حالة معلنة: ${newcomer.comparisonStatus}`);
    expect(newcomer.direction === "NOT_COMPARABLE", "الاتجاه NOT_COMPARABLE");
    expect(newcomer.flags.includes("MISSING_COMPARISON"), "علامة MISSING_COMPARISON");
    expect(!JSON.stringify(r.rows).includes('"comparisonAmount":"0"'), "لا صفر مُختلق لمقارنة غائبة");
  });

  await check("T9 سنة غير تقويمية: يوليو/أغسطس/سبتمبر بالترتيب + مناظر السنة السابقة بالordinal", async () => {
    // الفترة الحالية فترة 2 (أغسطس 2026) مقابل الفترة المناظرة من FY2025-NC (أغسطس 2025)
    const r = await getStatementComparison({
      user: admin,
      input: { companyId: coD, fiscalYearId: fyD26, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.PRIOR_YEAR_PERIOD },
    });
    const sales = r.rows.find((x) => x.accountCode === "410101")!;
    expect(sales.currentAmount === "13000" && sales.comparisonAmount === "12000", `130 مقابل 120 (أغسطس مقابل أغسطس) minor: ${sales.currentAmount}/${sales.comparisonAmount}`);
    expect(r.comparisonTarget?.fromDate === "2025-08-01" && r.comparisonTarget?.toDate === "2025-08-31", `هدف المقارنة بالordinal: ${r.comparisonTarget?.fromDate}`);
    expect(sales.varianceAmount === "1000", `فارق (minor): ${sales.varianceAmount}`);
    // PRIOR_PERIOD داخل السنة غير التقويمية: سبتمبر (3) مقابل أغسطس (2) — تسلسل وليس تقويم
    const r2 = await getStatementComparison({
      user: admin,
      input: { companyId: coD, fiscalYearId: fyD25, ordinal: 3, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.PRIOR_PERIOD },
    });
    expect(r2.comparisonTarget?.fromDate === "2025-08-01" && r2.comparisonTarget?.toDate === "2025-08-31", `سبتمبر ← أغسطس تسلسليًا: ${r2.comparisonTarget?.fromDate}`);
    const s3 = r2.rows.find((x) => x.accountCode === "410101")!;
    expect(s3.currentAmount === "8000" && s3.comparisonAmount === "12000", `حركة سبتمبر 80 مقابل أغسطس 120 (minor): ${s3.currentAmount}/${s3.comparisonAmount}`);
  });

  /* ── T10..T13 دلالات البيانات ── */

  await check("T10 FLOW: حركة الفترة والتراكمي من الجسور المركزية (بلا حساب ثانٍ)", async () => {
    const ytd = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "YTD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.PRIOR_PERIOD },
    });
    const sales = ytd.rows.find((x) => x.accountCode === "410101")!;
    expect(sales.currentAmount === "22000" && sales.comparisonAmount === "10000", `تراكمي 220 مقابل تراكمي يناير 100 (minor): ${sales.currentAmount}/${sales.comparisonAmount}`);
    expect(sales.varianceAmount === "12000", `فارق التراكميين: ${sales.varianceAmount}`);
  });

  await check("T11 BALANCE: أرصدة 100/140/125 ⇒ سبتمبر (3) = 125 لا 365", async () => {
    const r = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 3, basis: "YTD", statementScope: "STATEMENT_OF_FINANCIAL_POSITION", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.NONE },
    });
    const cash = r.rows.find((x) => x.accountCode === "110101")!;
    expect(cash.currentAmount === "12500", `as-of مارس = 125×100 minor: ${cash.currentAmount}`);
    expect(String(cash.currentAmount) !== "36500", "ليس مجموع الأرصدة إطلاقًا");
    const totals = Object.fromEntries(r.totals.map((t) => [t.key, t]));
    expect(totals["total-assets"].amount === "12500", `إجمالي الأصول = 125×100: ${totals["total-assets"].amount}`);
  });

  await check("T12 CUMULATIVE_YTD لا جمع مزدوج: تراكمي مارس = 300 لا 620", async () => {
    const r = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 3, basis: "YTD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.NONE },
    });
    const sales = r.rows.find((x) => x.accountCode === "410101")!;
    expect(sales.currentAmount === "30000", `التراكمي المباشر من نقطة مارس (minor): ${sales.currentAmount}`);
    expect(String(sales.currentAmount) !== "62000", "لا 100+220+300");
  });

  await check("T13 PERIOD_MOVEMENT: YTD يُجمع من الحركات (100+120+80 = 300)", async () => {
    const r = await getStatementComparison({
      user: admin,
      input: { companyId: coC, fiscalYearId: fyC, ordinal: 3, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.YTD },
    });
    const sales = r.rows.find((x) => x.accountCode === "410101")!;
    expect(sales.currentAmount === "8000", `حركة الفترة الحالية (مارس) minor: ${sales.currentAmount}`);
    expect(sales.comparisonAmount === "30000", `التراكمي = 100+120+80 (minor): ${sales.comparisonAmount}`);
    expect(sales.varianceAmount === "-22000", `فارق حركة مقابل تراكمي: ${sales.varianceAmount}`);
    const cash = r.rows.find((x) => x.accountCode === "110101");
    expect(!cash, "حساب أصل خارج نطاق قائمة الربح — لا يظهر فيها إطلاقًا");
    // الأرصدة في نطاق المركز المالي: غير قابلة لمقارنة التراكمي — معلنة
    const sfp = await getStatementComparison({
      user: admin,
      input: { companyId: coC, fiscalYearId: fyC, ordinal: 3, basis: "PERIOD", statementScope: "STATEMENT_OF_FINANCIAL_POSITION", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.YTD },
    });
    const cashSfp = sfp.rows.find((x) => x.accountCode === "110101")!;
    expect(cashSfp.currentAmount === "12500", `رصيد as-of مارس (minor): ${cashSfp.currentAmount}`);
    expect(cashSfp.comparisonStatus === "NOT_COMPARABLE", "أرصدة غير قابلة لمقارنة التراكمي — معلنة");
    expect(r.notes.some((n) => n.includes("دلالة هذا الوضع")), "ملاحظة دلالة YTD معلنة");
    // YTD_AVERAGE: متوسط 300/3 = 100
    const avg = await getStatementComparison({
      user: admin,
      input: { companyId: coC, fiscalYearId: fyC, ordinal: 3, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.YTD_AVERAGE },
    });
    const salesAvg = avg.rows.find((x) => x.accountCode === "410101")!;
    expect(salesAvg.comparisonAmount === "10000", `متوسط التراكمي = 300/3 (minor): ${salesAvg.comparisonAmount}`);
    expect(salesAvg.varianceAmount === "-2000" && salesAvg.variancePercent === "-20.0", `فارق/نسبة مقابل المتوسط: ${salesAvg.varianceAmount}/${salesAvg.variancePercent}`);
  });

  /* ── T14..T15 ف/غ ── */

  await check("T14 ف/غ للموازنة: إيراد ومصروف بقاعدتين مختلفتين عبر المحرك", async () => {
    // فترة 2: إيراد فعلي 320 مقابل 100 ⇒ مؤاتٍ؛ مصروف 80 مقابل 100 ⇒ وفر مؤاتٍ
    const r2 = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.STATEMENT_MAPPING, comparisonMode: COMPARISON_MODES.BUDGET },
    });
    const rev2 = r2.rows.find((x) => x.statementLineCode === "PNL-REVENUE")!;
    expect(rev2.comparisonAmount === "10000" && rev2.favorability === "FAVORABLE", `إيراد أعلى ⇒ مواتٍ: ${rev2.comparisonAmount}/${rev2.favorability}`);
    const exp2 = r2.rows.find((x) => x.statementLineCode === "PNL-ADMIN-EXPENSES")!;
    expect(exp2.favorability === "FAVORABLE" && exp2.varianceAmount === "-2000", `مصروف أقل ⇒ وفر: ${exp2.varianceAmount}/${exp2.favorability}`);
    // فترة 3: إيراد 80 مقابل 100 ⇒ غير مؤاتٍ؛ مصروف 30 مقابل 50 ⇒ مؤاتٍ
    const r3 = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 3, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.STATEMENT_MAPPING, comparisonMode: COMPARISON_MODES.BUDGET },
    });
    const rev3 = r3.rows.find((x) => x.statementLineCode === "PNL-REVENUE")!;
    expect(rev3.favorability === "UNFAVORABLE" && rev3.varianceAmount === "-2000", `إيراد أقل ⇒ غير مؤاتٍ: ${rev3.varianceAmount}/${rev3.favorability}`);
    const exp3 = r3.rows.find((x) => x.statementLineCode === "PNL-ADMIN-EXPENSES")!;
    expect(exp3.favorability === "FAVORABLE" && exp3.varianceAmount === "-2000", `مصروف أقل ⇒ وفر: ${exp3.varianceAmount}/${exp3.favorability}`);
    expect(rev3.factText?.includes("الموازنة"), `نص الحقيقة بالموازنة: ${rev3.factText}`);
  });

  await check("T15 المركز المالي: بلا تسمية ف/غ افتراضيًا (ارتفاع رصيد بلا حكم)", async () => {
    const r = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "PERIOD", statementScope: "STATEMENT_OF_FINANCIAL_POSITION", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.PRIOR_PERIOD },
    });
    const cash = r.rows.find((x) => x.accountCode === "110101")!;
    expect(cash.currentAmount === "14000" && cash.comparisonAmount === "10000", `نقدية 140 مقابل 100 (minor): ${cash.currentAmount}/${cash.comparisonAmount}`);
    expect(cash.direction === "INCREASE", "ارتفاع رياضي");
    expect(cash.favorability === "NO_FAVORABLE_UNFAVORABLE", `بلا ف/غ للرصيد: ${cash.favorability}`);
    expect(cash.lineNature === "OTHER", `طبيعة البند OTHER: ${cash.lineNature}`);
  });

  /* ── T16..T17 الأمن والتتبع ── */

  await check("T16 عزل الشركات fail-closed عبر خدمة المقارنة", async () => {
    const limited = syntheticUser({ role: "user", viewAllCompanies: false, companyIds: [coB], username: "gate-limited-69" });
    let threw = false;
    try {
      await getStatementComparison({ user: limited, input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.NONE } });
    } catch (e) {
      threw = e instanceof TrialBalanceError && e.code === "NOT_FOUND";
    }
    expect(threw, "الشركة خارج النطاق ⇒ NOT_FOUND (لا تسريب بيانات)");
    // الشركة داخل النطاق تعمل حتى بلا بيانات (بلا انهيار ولا أرقام مختلقة)
    const own = await getStatementComparison({ user: limited, input: { companyId: coB, fiscalYearId: fyB, ordinal: 2, statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.ALL_ACCOUNTS, comparisonMode: COMPARISON_MODES.NONE } });
    expect(own.rows.length === 0, "شركة بلا بيانات ⇒ صفوف فارغة لا أصفار");
  });

  await check("T17 التتبع: كل إجمالي يحتفظ بمراجع حساباته المصدرية", async () => {
    const r = await getStatementComparison({
      user: admin,
      input: { companyId: coA, fiscalYearId: fyA, ordinal: 2, basis: "PERIOD", statementScope: "PROFIT_OR_LOSS", presentationMode: PRESENTATION_MODES.STATEMENT_MAPPING, comparisonMode: COMPARISON_MODES.PRIOR_PERIOD },
    });
    const rev = r.rows.find((x) => x.statementLineCode === "PNL-REVENUE")!;
    expect(rev.sourceAccountCodes.includes("410101") && rev.sourceAccountCodes.includes("410199") && rev.sourceAccountCodes.includes("4101"), `مصادر البند: ${rev.sourceAccountCodes.join(",")}`);
    const totals = Object.fromEntries(r.totals.map((t) => [t.key, t]));
    expect(totals["net-result"].sourceAccountCodes.length > 0, "صافي النتيجة قابل للتتبع للحسابات");
    for (const row of r.rows) {
      if (row.currentStatus === "OK") {
        expect(Array.isArray(row.sourceAccountCodes), `صف بمصادر: ${row.key}`);
      }
    }
  });

  /* ── T18 الانحدار ── */

  await check("T18 مسارات ومكونات 6.8 سليمة + بوابات الانحدار موجودة", () => {
    const routes = [
      "src/app/api/reports/actual/statements/route.ts",
      "src/app/api/reports/actual/period-comparison/route.ts",
      "src/app/api/reports/actual/month-vs-cumulative/route.ts",
      "src/app/api/reports/actual/equity/route.ts",
      "src/app/api/reports/actual/cashflow/route.ts",
      "src/app/api/budgets/variance/route.ts",
    ];
    for (const r0 of routes) expect(fileExports(r0, "export async function"), `مسار 6.8 موجود: ${r0}`);
    expect(fileExports("src/app/api/reports/actual/statement-comparison/route.ts", "getStatementComparison"), "مسار 6.9 الجديد موجود");
    expect(fileExports("src/components/reporting/report-print.tsx", "export function PrintButton"), "محرك الطباعة الموحد سليم");
    expect(fileExports("src/components/reporting/reports-center.tsx", "ReportsCenter"), "مركز التقارير سليم");
    expect(fileExports("src/lib/display-labels.ts", "budgetVarianceBadge"), "أساس التسميات السياقية الموحد (جولة المراجعة C/D/E)");
    expect(fileExports("src/lib/budget.ts", "export function favorabilityFor"), "قاعدة ف/غ المركزية لم تتغير");
    expect(fileExports("src/lib/comparison-server.ts", "favorabilityFor"), "محرك 6.9 يعيد استخدام ف/غ المركزية");
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
  console.log("PHASE 6.9 GATE: ALL PASS");
}

main().catch((e) => {
  console.error("فشل تشغيل البوابة:", e);
  process.exit(1);
});
