// Phase 6.2A — بوابة إثبات «دليل الحسابات وقواعد التصنيف» (التصميم النهائي المعتمد).
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-62a-gate.db bun scripts/phase62a-account-nature.ts
//
// الجزء A — دوال نقية (بلا DB):
//   (J) FLOW 100/120/80 ⇒ YTD مارس 300 | (K) BALANCE 100/140/125 ⇒ as-of 125 وليس 365
//   (L) سنة غير تقويمية تبدأ يوليو | (A) الجذور 1/2/3/4 | (B) لا جذور 5/6/7
//   (C) هرمية 1/11/1101 وأطول بادئة | (D/E) الفصل داخل الجذر 2 (21⇒LIABILITY/23⇒EQUITY)
//   (F) Override يفوز على البادئة | (G) عزل الشركات | (H/I) ROOT_ONLY ≠ FULLY_MAPPED
//   + الجسور والفجوات والافتتاح + حاجز الاتساق + requireBehavior.
// الجزء B — قاعدة معزولة (dev-62a-gate.db من migrations حصرًا): seed/حل خادمي/
//   بادئات شركات/استثناءات/نسخ خرائط/optimistic locking/تدقيق before-after-reason/
//   التفرد الفيزيائي/عزل الشركات/Cascade/الجذور للقراءة فقط.
//
// لا لمس custom.db إطلاقًا — الأداة ترفض أي DATABASE_URL غير dev-62a*.

import { PrismaClient } from "@prisma/client";

import {
  AccountNatureError,
  isStatementLineConsistent,
  MAPPING_STATUSES,
  resolveAccountMapping,
  STATEMENT_LINE_SEED,
  SYSTEM_ROOT_SEED,
  type MappingOverrideLike,
  type MappingRuleLike,
  type ResolvedAccountMapping,
  type StatementLineLike,
} from "../src/lib/account-nature";
import {
  aggregateForPeriod,
  aggregateYTD,
  AggregationError,
  cumulativeFromMovements,
  getAsOfBalance,
  latestOrdinal,
  monthlyMovementsFromCumulative,
  reconcileBalanceMovements,
  requireBehavior,
  type PeriodAmountEntry,
} from "../src/lib/temporal-aggregation";
import { canManageAccountNature } from "../src/lib/permissions";
import type { SessionUser } from "../src/lib/session";

/* ── سقالة النتائج ── */
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

function errorCode(e: unknown): string {
  return e instanceof AccountNatureError || e instanceof AggregationError
    ? (e as { code: string }).code
    : `UNKNOWN(${e instanceof Error ? e.message : String(e)})`;
}

function expectError(code: string, fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    expect(errorCode(e) === code, `رمز الخطأ المتوقع ${code} لكن جاء ${errorCode(e)}`);
    return;
  }
  throw new Error(`كان يجب أن يرمي ${code} ولم يرمِ شيئًا`);
}

async function expectErrorAsync(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(errorCode(e) === code, `رمز الخطأ المتوقع ${code} لكن جاء ${errorCode(e)}`);
    return;
  }
  throw new Error(`كان يجب أن يرمي ${code} ولم يرمِ شيئًا`);
}

const entry = (o: number, amount: bigint): PeriodAmountEntry => ({ periodOrdinal: o, amountMinor: amount });

function syntheticUser(over: Partial<{ role: string; companyIds: string[]; viewAllCompanies: boolean; manageAccountNature: boolean; username: string }> = {}): SessionUser {
  return {
    id: "gate-user",
    username: over.username ?? "gate-admin",
    name: "Gate Admin",
    role: over.role ?? "admin",
    permissions: {
      view: true,
      add: true,
      edit: true,
      delete: true,
      groups: false,
      export: true,
      settings: false,
      manageUsers: false,
      companyIds: over.companyIds ?? [],
      viewAllCompanies: over.viewAllCompanies ?? true,
      manageAccountNature: over.manageAccountNature ?? true,
    },
  };
}

/* ── بنّائو النقي: مرايا seed كقواعد/بنود للحل النقي ── */
const seedRules: MappingRuleLike[] = SYSTEM_ROOT_SEED.map((r) => ({
  id: r.id,
  companyId: null,
  prefix: r.prefix,
  mainCategory: r.mainCategory,
  classification: r.classification,
  aggregationBehavior: r.aggregationBehavior,
  statementLineCode: null,
  source: "SYSTEM",
  isActive: true,
}));

const seedLines: StatementLineLike[] = STATEMENT_LINE_SEED.map((l) => ({
  code: l.code,
  nameAr: l.nameAr,
  statementType: l.statementType,
  isActive: true,
}));

function companyRule(id: string, companyId: string, prefix: string, classification: string, behavior: string, lineCode: string | null): MappingRuleLike {
  return { id, companyId, prefix, mainCategory: null, classification, aggregationBehavior: behavior, statementLineCode: lineCode, source: "MANUAL", isActive: true };
}

function override(companyId: string, accountCode: string, classification: string, behavior: string, lineCode: string | null): MappingOverrideLike {
  return { id: `ov-${companyId}-${accountCode}`, companyId, accountCode, classification, aggregationBehavior: behavior, statementLineCode: lineCode, isActive: true };
}

function one(code: string, rules: MappingRuleLike[], overrides: MappingOverrideLike[] = [], companyId: string | null = null): ResolvedAccountMapping {
  return resolveAccountMapping({ accountCode: code, rules, overrides, lines: seedLines, companyId });
}

/* ════════════════════════════════════════════════════════════════════════
 * الجزء A — الدوال النقية
 * ════════════════════════════════════════════════════════════════════════ */

async function partA() {
  console.log("\n── الجزء A: الدوال النقية (بلا DB) ──");

  const flowSeries = [entry(1, BigInt(10_000)), entry(2, BigInt(12_000)), entry(3, BigInt(8_000))];
  const balanceSeries = [entry(1, BigInt(10_000)), entry(2, BigInt(14_000)), entry(3, BigInt(12_500))];

  await check("J  FLOW: يناير100 فبراير120 مارس80 ⇒ YTD مارس = 300 (30000 minor)", () => {
    const ytd = aggregateYTD(flowSeries, "FLOW", 3);
    expect(ytd === BigInt(30_000), `متوقع BigInt(30000) وجاء ${ytd}`);
  });

  await check("K  BALANCE: إقفال 100/140/125 ⇒ as-of مارس = 125 وليس 365", () => {
    const asOf = getAsOfBalance(balanceSeries, 3);
    expect(asOf === BigInt(12_500), `متوقع BigInt(12500) وجاء ${asOf}`);
    const naiveSum = balanceSeries.reduce((acc, e) => acc + e.amountMinor, BigInt(0));
    expect(naiveSum === BigInt(36_500), "التحقق المرجعي: الجمع الأعمى = 365 (نثبت أننا لم نفعله)");
    expect(aggregateYTD(balanceSeries, "BALANCE", 3) === BigInt(12_500), "aggregateYTD(BALANCE) = رصيد الوقف نفسه");
  });

  await check("L  سنة غير تقويمية (يوليو=1 أغسطس=2 سبتمبر=3): YTD يبدأ من يوليو", () => {
    const fyJul = [entry(1, BigInt(10_000)), entry(2, BigInt(12_000)), entry(3, BigInt(8_000))];
    expect(aggregateYTD(fyJul, "FLOW", 3) === BigInt(30_000), "YTD سبتمبر (ترتيب 3) = 300 من بداية السنة المالية");
    expect(aggregateForPeriod(fyJul, "FLOW", 3) === BigInt(8_000), "حركة سبتمبر وحدها = 80");
    expect(getAsOfBalance([entry(1, BigInt(5_000)), entry(2, BigInt(6_500)), entry(3, BigInt(6_200))], 3) === BigInt(6_200), "as-of سبتمبر = 62");
    expect(latestOrdinal(fyJul) === 3, "أحدث فترة = 3");
  });

  await check("A  الجذور النظامية 1/2/3/4 بقيم القرار المعتمد", () => {
    const r1 = one("1000000", seedRules);
    expect(r1.mainCategory === "ASSETS" && r1.classification === "ASSET" && r1.aggregationBehavior === "BALANCE", `1 ⇒ ASSETS/ASSET/BALANCE وجاء ${JSON.stringify(r1)}`);
    expect(r1.mappingStatus === "ROOT_ONLY" && r1.rootPrefix === "1", "الجذر وحده ⇒ ROOT_ONLY (لا بند مالي)");
    const r3 = one("3000001", seedRules);
    expect(r3.mainCategory === "EXPENSES" && r3.classification === "EXPENSE" && r3.aggregationBehavior === "FLOW", "3 ⇒ EXPENSES/EXPENSE/FLOW");
    const r4 = one("4000001", seedRules);
    expect(r4.mainCategory === "REVENUE" && r4.classification === "REVENUE" && r4.aggregationBehavior === "FLOW", "4 ⇒ REVENUE/REVENUE/FLOW");
    const r2 = one("210101", seedRules);
    expect(r2.mainCategory === "LIABILITIES_EQUITY" && r2.classification === null && r2.aggregationBehavior === "BALANCE", "2 ⇒ LIABILITIES_EQUITY/BALANCE والتصنيف غير محسوم (جذر مركّب)");
    expect(r2.mappingStatus === "NEEDS_DETAILED_CLASSIFICATION", "2 بلا بادئة شركة ⇒ NEEDS_DETAILED_CLASSIFICATION");
  });

  await check("B  لا جذور نظامية 5/6/7 في المحرك الجديد + خارج 1-4 ⇒ NEEDS_CLASSIFICATION", () => {
    expect(SYSTEM_ROOT_SEED.length === 4, `عدد الجذور النظامية = 4 وجاء ${SYSTEM_ROOT_SEED.length}`);
    expect(SYSTEM_ROOT_SEED.map((r) => r.prefix).join(",") === "1,2,3,4", "الجذور = 1,2,3,4 حصرًا");
    for (const code of ["5100001", "6100001", "7100001", "9100"]) {
      const r = one(code, seedRules);
      expect(r.mappingStatus === "NEEDS_CLASSIFICATION" && r.mainCategory === null, `${code} ⇒ NEEDS_CLASSIFICATION (فشل واضح لا رقم مضلل)`);
    }
  });

  await check("C  هرمية 1/11/1101 — أطول بادئة تفوز: 11010105 ⇒ 1101", () => {
    const rules = [
      ...seedRules,
      companyRule("c1", "CO", "1", "ASSET", "BALANCE", null),
      companyRule("c11", "CO", "11", "ASSET", "BALANCE", null),
      companyRule("c1101", "CO", "1101", "ASSET", "BALANCE", "SFP-CASH"),
      companyRule("c1102", "CO", "1102", "ASSET", "BALANCE", "SFP-RECEIVABLES"),
      companyRule("c12", "CO", "12", "ASSET", "BALANCE", "SFP-PPE"),
    ];
    const r = one("11010105", rules, [], "CO");
    expect(r.matchedPrefix === "1101" && r.source === "COMPANY_PREFIX", `matchedPrefix=1101 وجاء ${r.matchedPrefix}`);
    expect(r.statementLineCode === "SFP-CASH" && r.mappingStatus === "FULLY_MAPPED", "11010105 ⇒ FULLY_MAPPED ببند النقدية");
    expect(one("11020105", rules, [], "CO").matchedPrefix === "1102", "1102… ⇒ 1102");
    expect(one("12010105", rules, [], "CO").matchedPrefix === "12", "1201… ⇒ 12 (لا 1)");
    expect(one("13010105", rules, [], "CO").matchedPrefix === "1", "1301… ⇒ 1 (لا بادئة أطول)");
    expect(one("190999", rules, [], "CO").mappingStatus === "ROOT_ONLY", "190999 ⇒ ROOT_ONLY (الجذر وحده لا يصدر بندًا)");
  });

  await check("D+E  الجذر 2: 21⇒LIABILITY و23⇒EQUITY — لا تصنيف كل حسابات 2 كخصوم", () => {
    const rules = [
      ...seedRules,
      companyRule("c21", "CO", "21", "LIABILITY", "BALANCE", null),
      companyRule("c23", "CO", "23", "EQUITY", "BALANCE", null),
    ];
    const d = one("210101", rules, [], "CO");
    expect(d.mainCategory === "LIABILITIES_EQUITY" && d.classification === "LIABILITY" && d.companyPrefix === "21", `210101 ⇒ LIABILITIES_EQUITY/LIABILITY وجاء ${JSON.stringify(d)}`);
    expect(d.mappingStatus === "ROOT_ONLY", "بلا بند مالي ⇒ ROOT_ONLY (لا FULLY_MAPPED)");
    const e = one("230101", rules, [], "CO");
    expect(e.mainCategory === "LIABILITIES_EQUITY" && e.classification === "EQUITY" && e.companyPrefix === "23", "230101 ⇒ LIABILITIES_EQUITY/EQUITY");
    expect(one("299999", rules, [], "CO").mappingStatus === "NEEDS_DETAILED_CLASSIFICATION", "حساب 2 بلا بادئة تفصيلية ⇒ يحتاج تصنيفًا تفصيليًا");
  });

  await check("F  Account Override يفوز على البادئة: 310199 ⇒ مصروفات إدارية", () => {
    const rules = [
      ...seedRules,
      companyRule("c31", "CO", "31", "EXPENSE", "FLOW", "PNL-COST-OF-SALES"),
    ];
    const overrides = [override("CO", "310199", "EXPENSE", "FLOW", "PNL-ADMIN-EXPENSES")];
    const f = one("310199", rules, overrides, "CO");
    expect(f.source === "ACCOUNT_OVERRIDE" && f.statementLineCode === "PNL-ADMIN-EXPENSES" && f.matchedPrefix === "310199", `الاستثناء يفوز وجاء ${JSON.stringify(f)}`);
    expect(f.mappingStatus === "FULLY_MAPPED", "الاستثناء مع بند ⇒ FULLY_MAPPED");
    const sibling = one("310101", rules, overrides, "CO");
    expect(sibling.source === "COMPANY_PREFIX" && sibling.statementLineCode === "PNL-COST-OF-SALES", "حساب آخر تحت نفس البادئة يبقى على قاعدة البادئة");
  });

  await check("G  عزل الشركات: نفس الكود 1101 ببندين مختلفين لشركتين", () => {
    const rules = [
      ...seedRules,
      companyRule("a1101", "CO-A", "1101", "ASSET", "BALANCE", "SFP-CASH"),
      companyRule("b1101", "CO-B", "1101", "ASSET", "BALANCE", "SFP-RECEIVABLES"),
    ];
    const a = one("11010001", rules, [], "CO-A");
    const b = one("11010001", rules, [], "CO-B");
    expect(a.statementLineCode === "SFP-CASH", "شركة A: 1101 ⇒ النقدية");
    expect(b.statementLineCode === "SFP-RECEIVABLES", "شركة B: 1101 ⇒ الذمم المدينة");
    expect(a.companyPrefix === "1101" && b.companyPrefix === "1101", "نفس البادئة المطابقة — بند مختلف (مسموح ومعتمد)");
  });

  await check("H+I  ROOT_ONLY ليست FULLY_MAPPED + بلا بند مالي لا يصدر مصنفًا كاملًا", () => {
    const rules = [...seedRules, companyRule("g21", "CO", "21", "LIABILITY", "BALANCE", null)];
    const noLine = one("210101", rules, [], "CO");
    expect(noLine.mappingStatus === "ROOT_ONLY", "بادئة بلا بند ⇒ ROOT_ONLY");
    expect((MAPPING_STATUSES.ROOT_ONLY as string) !== (MAPPING_STATUSES.FULLY_MAPPED as string), "ROOT_ONLY ليست FULLY_MAPPED (حالتان مختلفتان تمامًا)");
    expect(noLine.statementLineCode === null && noLine.statementType === null, "لا بند ولا نوع قائمة");
    // استثناء بلا بند — كذلك لا FULLY_MAPPED
    const ovNoLine = one("1999", seedRules, [override("CO-X", "1999", "ASSET", "BALANCE", null)], "CO-X");
    expect(ovNoLine.source === "ACCOUNT_OVERRIDE" && ovNoLine.mappingStatus === "ROOT_ONLY", "استثناء بلا بند ⇒ ROOT_ONLY (ليس FULLY_MAPPED)");
  });

  await check("I+  كود بند غير موجود/غير نشط ⇒ لا بند (فشل مغلق — لا FULLY_MAPPED بصمت)", () => {
    const rules = [...seedRules, companyRule("ghost", "CO", "15", "ASSET", "BALANCE", "SFP-NO-SUCH-LINE")];
    const r = one("1500001", rules, [], "CO");
    expect(r.statementLineCode === null && r.statementType === null && r.mappingStatus === "ROOT_ONLY", "كود بند شبح ⇒ ROOT_ONLY بلا بند");
  });

  await check("حاجز الاتساق: أصل لا يقع على قائمة أرباح — قواعد التصنيف↔القائمة", () => {
    expect(isStatementLineConsistent("ASSET", "PROFIT_OR_LOSS") === false, "ASSET + قائمة أرباح ⇒ مرفوض");
    expect(isStatementLineConsistent("ASSET", "STATEMENT_OF_FINANCIAL_POSITION") === true, "ASSET + مركز مالي ⇒ مقبول");
    expect(isStatementLineConsistent("LIABILITY", "PROFIT_OR_LOSS") === false, "LIABILITY + أرباح ⇒ مرفوض");
    expect(isStatementLineConsistent("EQUITY", "OTHER_COMPREHENSIVE_INCOME") === true, "EQUITY + دخل شامل آخر ⇒ مقبول (إعادة تقييم)");
    expect(isStatementLineConsistent("EXPENSE", "STATEMENT_OF_FINANCIAL_POSITION") === false, "EXPENSE + مركز مالي ⇒ مرفوض");
    expect(isStatementLineConsistent("REVENUE", "PROFIT_OR_LOSS") === true, "REVENUE + أرباح ⇒ مقبول");
    expect(isStatementLineConsistent("OTHER", "PROFIT_OR_LOSS") === true, "OTHER بلا قيد");
  });

  await check("requireBehavior: ROOT_ONLY/FULLY_MAPPED تحسمان السلوك — NEEDS_* تُرفض", () => {
    expect(requireBehavior({ status: "ROOT_ONLY", aggregationBehavior: "BALANCE" }) === "BALANCE", "ROOT_ONLY يمر بالسلوك");
    expect(requireBehavior({ status: "FULLY_MAPPED", aggregationBehavior: "FLOW" }) === "FLOW", "FULLY_MAPPED يمر بالسلوك");
    expectError("NEEDS_CLASSIFICATION", () => requireBehavior({ status: "NEEDS_CLASSIFICATION" }));
    expectError("NEEDS_CLASSIFICATION", () => requireBehavior({ status: "NEEDS_DETAILED_CLASSIFICATION", aggregationBehavior: "BALANCE" }));
  });

  await check("فجوة ⇒ INCOMPLETE_DATA + الجسور (تراكمي⇄حركات) + الافتتاح بلا اختراع", () => {
    const gappy = [entry(1, BigInt(10_000)), entry(3, BigInt(8_000))];
    expectError("INCOMPLETE_DATA", () => aggregateYTD(gappy, "FLOW", 3));
    expectError("INCOMPLETE_DATA", () => aggregateYTD([entry(1, BigInt(10_000))], "BALANCE", 2));
    const cumulative = [entry(1, BigInt(10_000)), entry(2, BigInt(22_000)), entry(3, BigInt(30_000))];
    const movements = monthlyMovementsFromCumulative(cumulative, "FLOW");
    expect(movements.map((m) => m.amountMinor).join(",") === "10000,12000,8000", "تراكمي ⇒ حركات 100/120/80");
    expect(cumulativeFromMovements(movements).map((m) => m.amountMinor).join(",") === "10000,22000,30000", "حركات ⇒ تراكمي (round-trip)");
    expect(monthlyMovementsFromCumulative(balanceSeries, "BALANCE").map((m) => m.amountMinor).join(",") === "10000,14000,12500", "BALANCE تمر كما هي");
    expectError("INCOMPLETE_DATA", () => monthlyMovementsFromCumulative([entry(1, BigInt(10_000)), entry(3, BigInt(30_000))], "FLOW"));
    const rec = reconcileBalanceMovements(BigInt(50_000), [entry(1, BigInt(3_000)), entry(2, BigInt(2_000)), entry(3, BigInt(1_000))]);
    expect(rec.computedClosingMinor === BigInt(56_000) && rec.sumOfMovementsMinor === BigInt(6_000), "closing = opening + Σ الحركات (560)");
    expectError("INCOMPLETE_DATA", () => aggregateForPeriod(flowSeries, "FLOW", 5));
    expectError("DUPLICATE_PERIOD", () => aggregateYTD([entry(1, BigInt(1)), entry(1, BigInt(2))], "FLOW", 1));
    expectError("EMPTY_SERIES", () => aggregateYTD([], "FLOW", 1));
  });
}

/* ════════════════════════════════════════════════════════════════════════
 * الجزء B — قاعدة معزولة (dev-62a-gate.db)
 * ════════════════════════════════════════════════════════════════════════ */

async function partB() {
  console.log("\n── الجزء B: قاعدة معزولة dev-62a-gate.db (من migrations حصرًا) ──");

  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-62a-gate"), "الأداة تعمل على dev-62a-gate.db حصرًا");
  const db = new PrismaClient({ datasources: { db: { url: url! } } });

  try {
    /* B1 — seed من migration */
    await check("B1 seed: 4 جذور نظامية فقط (2 بلا تصنيف) + 32 بند قائمة هرمية", async () => {
      const roots = await db.accountNatureRule.findMany({ where: { companyId: null }, orderBy: { prefix: "asc" } });
      expect(roots.length === 4, `متوقع 4 جذور وجاء ${roots.length}`);
      for (const seed of SYSTEM_ROOT_SEED) {
        const row = roots.find((r) => r.id === seed.id);
        expect(!!row, `جذر seed مفقود: ${seed.id}`);
        expect(row!.prefix === seed.prefix && row!.mainCategory === seed.mainCategory && row!.classification === seed.classification && row!.aggregationBehavior === seed.aggregationBehavior && row!.source === "SYSTEM" && row!.isActive, `قيم جذر غير مطابقة: ${seed.id}`);
      }
      expect(roots.find((r) => r.prefix === "2")!.classification === null, "الجذر 2 بلا تصنيف تفصيلي عمدًا (مركّب)");
      const companyRules = await db.accountNatureRule.count({ where: { companyId: { not: null } } });
      expect(companyRules === 0, "لا بادئات شركات في seed إطلاقًا (لكل شركة إعدادها)");
      const lines = await db.financialStatementLine.findMany({ orderBy: [{ statementType: "asc" }, { displayOrder: "asc" }], include: { parent: { select: { code: true } } } });
      expect(lines.length === STATEMENT_LINE_SEED.length, `عدد البنود = ${STATEMENT_LINE_SEED.length} وجاء ${lines.length}`);
      const cash = lines.find((l) => l.code === "SFP-CASH")!;
      expect(cash.parent?.code === "SFP-ASSET-CA", "SFP-CASH ابنة مجموعة الأصول المتداولة (هرمية فعلية)");
      const types = new Set(lines.map((l) => l.statementType));
      expect(types.size === 3, "ثلاثة أنواع قوائم: مركز مالي/ربح وخسارة/دخل شامل آخر");
    });

    /* B2 — الحل الخادمي بدون شركة */
    await check("B2 الحل الخادمي (نظام فقط): ROOT_ONLY وNEEDS_DETAILED وNEEDS_CLASSIFICATION", async () => {
      const { resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      const res = await resolveCodesForCompany(null, ["1101", "210101", "9100"]);
      const byCode = new Map(res.results.map((r) => [r.accountCode, r]));
      const a = byCode.get("1101")!;
      expect(a.mainCategory === "ASSETS" && a.classification === "ASSET" && a.aggregationBehavior === "BALANCE" && a.mappingStatus === "ROOT_ONLY", "1101 ⇒ ASSETS/ASSET/BALANCE/ROOT_ONLY (لا بند من الجذر)");
      const d = byCode.get("210101")!;
      expect(d.mainCategory === "LIABILITIES_EQUITY" && d.mappingStatus === "NEEDS_DETAILED_CLASSIFICATION", "210101 ⇒ يحتاج تصنيفًا تفصيليًا");
      const u = byCode.get("9100")!;
      expect(u.mappingStatus === "NEEDS_CLASSIFICATION", "9100 ⇒ غير مصنف");
      expect(res.summary.total === 3 && res.summary.fullyMapped === 0 && res.summary.needsAttention === 2 && res.summary.unclassified === 1, `ملخص: ${JSON.stringify(res.summary)}`);
    });

    /* B3 — شركتان + بادئات تفصيلية */
    const admin = syntheticUser();
    const limited = syntheticUser({ role: "user", viewAllCompanies: false, companyIds: [], username: "gate-limited" });
    let companyAId = "";
    let companyBId = "";

    await check("B3 إنشاء شركتين وبادئات تفصيلية مستقلة (إعداد مرة واحدة لكل شركة)", async () => {
      const { createNatureRule } = await import("../src/lib/account-nature-server");
      const a = await db.company.create({ data: { code: "GATE-A", nameAr: "شركة بوابة أ" } });
      const b = await db.company.create({ data: { code: "GATE-B", nameAr: "شركة بوابة ب" } });
      companyAId = a.id;
      companyBId = b.id;
      // شركة A: 1/11/1101/1102 + 21/23 + 31 (هرمية كاملة)
      await createNatureRule({ user: admin, ip: null, input: { companyId: a.id, prefix: "1", classification: "ASSET", aggregationBehavior: "BALANCE", note: "أصول (مستوى الشركة)", reason: "إعداد دليل A" } });
      await createNatureRule({ user: admin, ip: null, input: { companyId: a.id, prefix: "11", classification: "ASSET", aggregationBehavior: "BALANCE", reason: "إعداد دليل A" } });
      await createNatureRule({ user: admin, ip: null, input: { companyId: a.id, prefix: "1101", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineCode: "SFP-CASH", reason: "إعداد دليل A" } });
      await createNatureRule({ user: admin, ip: null, input: { companyId: a.id, prefix: "1102", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineCode: "SFP-RECEIVABLES", reason: "إعداد دليل A" } });
      await createNatureRule({ user: admin, ip: null, input: { companyId: a.id, prefix: "21", classification: "LIABILITY", aggregationBehavior: "BALANCE", reason: "إعداد دليل A" } });
      await createNatureRule({ user: admin, ip: null, input: { companyId: a.id, prefix: "23", classification: "EQUITY", aggregationBehavior: "BALANCE", reason: "إعداد دليل A" } });
      await createNatureRule({ user: admin, ip: null, input: { companyId: a.id, prefix: "31", classification: "EXPENSE", aggregationBehavior: "FLOW", statementLineCode: "PNL-COST-OF-SALES", reason: "إعداد دليل A" } });
      // شركة B: نفس الكود 1101 ببند مختلف تمامًا (عزل الشركات)
      await createNatureRule({ user: admin, ip: null, input: { companyId: b.id, prefix: "1101", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineCode: "SFP-RECEIVABLES", reason: "إعداد دليل B" } });
      const aCount = await db.accountNatureRule.count({ where: { companyId: a.id } });
      expect(aCount === 7, `شركة A لها 7 بادئات وجاء ${aCount}`);
    });

    await check("B4 الحل الخادمي لشركة A: هرمية/جذر 2/جذر 3/خارج الجذور", async () => {
      const { resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      const res = await resolveCodesForCompany(companyAId, ["11010105", "12010105", "210101", "230101", "299999", "310101", "9100"]);
      const byCode = new Map(res.results.map((r) => [r.accountCode, r]));
      const c = byCode.get("11010105")!;
      expect(c.matchedPrefix === "1101" && c.companyPrefix === "1101" && c.rootPrefix === "1", "11010105 ⇒ 1101 (أطول بادئة) والجذر 1 ظاهر للشفافية");
      expect(c.statementLineCode === "SFP-CASH" && c.mappingStatus === "FULLY_MAPPED", "11010105 ⇒ FULLY_MAPPED/النقدية");
      expect(byCode.get("12010105")!.matchedPrefix === "1", "1201… ⇒ الجذر 1 (لا بادئة أطول لـ A)");
      const d = byCode.get("210101")!;
      expect(d.mainCategory === "LIABILITIES_EQUITY" && d.classification === "LIABILITY" && d.mappingStatus === "ROOT_ONLY", "D: 210101 ⇒ LIABILITIES_EQUITY/LIABILITY (بادئة 21) بلا بند ⇒ ROOT_ONLY");
      const e = byCode.get("230101")!;
      expect(e.classification === "EQUITY" && e.mainCategory === "LIABILITIES_EQUITY", "E: 230101 ⇒ LIABILITIES_EQUITY/EQUITY (بادئة 23)");
      expect(byCode.get("299999")!.mappingStatus === "NEEDS_DETAILED_CLASSIFICATION", "299999 بلا بادئة تفصيلية ⇒ يحتاج تصنيفًا");
      expect(byCode.get("310101")!.statementLineCode === "PNL-COST-OF-SALES", "310101 ⇒ تكلفة المبيعات (بادئة 31)");
      expect(byCode.get("9100")!.mappingStatus === "NEEDS_CLASSIFICATION", "9100 ⇒ غير مصنف");
    });

    await check("B5+F استثناء حساب 310199 يفوز على بادئة 31 (خادميًا + تدقيق)", async () => {
      const { createMappingOverride, resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      const ov = await createMappingOverride({
        user: admin, ip: "127.0.0.1",
        input: { companyId: companyAId, accountCode: "310199", classification: "EXPENSE", aggregationBehavior: "FLOW", statementLineCode: "PNL-ADMIN-EXPENSES", note: "رواتب إدارية خارج التكلفة", reason: "إثبات أولوية الاستثناء" },
      });
      expect(ov.version === 1, "استثناء إداري v1");
      const res = await resolveCodesForCompany(companyAId, ["310199", "310101"]);
      const byCode = new Map(res.results.map((r) => [r.accountCode, r]));
      const f = byCode.get("310199")!;
      expect(f.source === "ACCOUNT_OVERRIDE" && f.statementLineCode === "PNL-ADMIN-EXPENSES" && f.matchedPrefix === "310199", `الاستثناء فاز وجاء ${JSON.stringify(f)}`);
      expect(byCode.get("310101")!.source === "COMPANY_PREFIX" && byCode.get("310101")!.statementLineCode === "PNL-COST-OF-SALES", "310101 يبقى على البادئة");
      const audit = await db.auditLog.findFirst({ where: { action: "ACCOUNT_NATURE_OVERRIDE_CREATED", entityId: ov.id } });
      expect(!!audit && JSON.parse(audit!.metadata || "{}").reason === "إثبات أولوية الاستثناء", "تدقيق إنشاء الاستثناء + السبب");
    });

    await check("B6+G عزل الشركات خادميًا: 1101 مختلف بين A وB — ولا تسرّب", async () => {
      const { resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      const a = (await resolveCodesForCompany(companyAId, ["1101"])).results[0];
      const b = (await resolveCodesForCompany(companyBId, ["1101"])).results[0];
      expect(a.statementLineCode === "SFP-CASH" && b.statementLineCode === "SFP-RECEIVABLES", `A=النقدية وB=الذمم وجاء ${a.statementLineCode}/${b.statementLineCode}`);
      expect(a.companyPrefix === "1101" && b.companyPrefix === "1101", "نفس الكود لا يعني نفس البند في جميع الشركات");
    });

    await check("B7 تكرار بادئة/استثناء مرفوض (409 دلالي)", async () => {
      const { createNatureRule, createMappingOverride } = await import("../src/lib/account-nature-server");
      await expectErrorAsync("RULE_PREFIX_DUPLICATE", () =>
        createNatureRule({ user: admin, ip: null, input: { companyId: companyAId, prefix: "21", classification: "LIABILITY", aggregationBehavior: "BALANCE" } })
      );
      await expectErrorAsync("OVERRIDE_DUPLICATE", () =>
        createMappingOverride({ user: admin, ip: null, input: { companyId: companyAId, accountCode: "310199", classification: "EXPENSE", aggregationBehavior: "FLOW" } })
      );
    });

    await check("B7-ROOT حاجز تناقض الجذر: 31⇒EQUITY و41⇒LIABILITY و11⇒LIABILITY واستثناء 3101⇒EQUITY كلها مرفوضة", async () => {
      const { createNatureRule, createMappingOverride } = await import("../src/lib/account-nature-server");
      await expectErrorAsync("PREFIX_ROOT_CONFLICT", () =>
        createNatureRule({ user: admin, ip: null, input: { companyId: companyAId, prefix: "31", classification: "EQUITY", aggregationBehavior: "BALANCE" } })
      );
      await expectErrorAsync("PREFIX_ROOT_CONFLICT", () =>
        createNatureRule({ user: admin, ip: null, input: { companyId: companyAId, prefix: "41", classification: "LIABILITY", aggregationBehavior: "BALANCE" } })
      );
      await expectErrorAsync("PREFIX_ROOT_CONFLICT", () =>
        createNatureRule({ user: admin, ip: null, input: { companyId: companyAId, prefix: "11", classification: "LIABILITY", aggregationBehavior: "BALANCE" } })
      );
      await expectErrorAsync("OVERRIDE_ROOT_CONFLICT", () =>
        createMappingOverride({ user: admin, ip: null, input: { companyId: companyAId, accountCode: "310199", classification: "EQUITY", aggregationBehavior: "BALANCE" } })
      );
    });

    await check("B8 الجذور النظامية للقراءة فقط: إنشاء/تعديل/حذف نظامي مرفوض (SYSTEM_IMMUTABLE)", async () => {
      const { createNatureRule, updateNatureRule, deleteNatureRule } = await import("../src/lib/account-nature-server");
      await expectErrorAsync("SYSTEM_IMMUTABLE", () =>
        createNatureRule({ user: admin, ip: null, input: { companyId: null, prefix: "9", classification: "OTHER", aggregationBehavior: "BALANCE" } })
      );
      const root2 = await db.accountNatureRule.findUniqueOrThrow({ where: { id: "anr-sys-02" } });
      await expectErrorAsync("SYSTEM_IMMUTABLE", () =>
        updateNatureRule({ user: admin, ip: null, id: root2.id, input: { aggregationBehavior: "FLOW", version: root2.version } })
      );
      await expectErrorAsync("SYSTEM_IMMUTABLE", () =>
        deleteNatureRule({ user: admin, ip: null, id: root2.id, input: { version: root2.version } })
      );
      const still = await db.accountNatureRule.findUniqueOrThrow({ where: { id: "anr-sys-02" } });
      expect(still.aggregationBehavior === "BALANCE" && still.version === 1, "الجذر 2 لم يُمس");
    });

    await check("B9+M optimistic locking + تدقيق قبل/بعد/سبب على بادئة شركة", async () => {
      const { updateNatureRule } = await import("../src/lib/account-nature-server");
      const target = await db.accountNatureRule.findFirstOrThrow({ where: { companyId: companyAId, prefix: "31" } });
      const updated = await updateNatureRule({
        user: admin, ip: "127.0.0.1", id: target.id,
        input: { statementLineCode: "PNL-OTHER-EXPENSES", reason: "إثبات التعديل", version: target.version },
      });
      expect(updated.version === target.version + 1, "النسخة زادت");
      await expectErrorAsync("VERSION_CONFLICT", () =>
        updateNatureRule({ user: admin, ip: null, id: target.id, input: { note: "متأخر", version: target.version } })
      );
      const audit = await db.auditLog.findFirst({ where: { action: "ACCOUNT_NATURE_RULE_UPDATED", entityId: target.id }, orderBy: { createdAt: "desc" } });
      expect(!!audit, "صف تدقيق التعديل موجود");
      const before = JSON.parse(audit!.beforeData || "{}");
      const after = JSON.parse(audit!.afterData || "{}");
      expect(after.statementLineId !== undefined && JSON.parse(audit!.metadata || "{}").reason === "إثبات التعديل", "after + السبب مدوَّنان");
      expect(before.statementLineId !== undefined, "before مدوَّن");
      // استعادة
      await updateNatureRule({ user: admin, ip: null, id: target.id, input: { statementLineCode: "PNL-COST-OF-SALES", version: updated.version, reason: "استعادة" } });
    });

    await check("B10+M حذف version-guarded ببادئة واستثناء + تدقيق الحذف", async () => {
      const { createNatureRule, deleteNatureRule, createMappingOverride, deleteMappingOverride } = await import("../src/lib/account-nature-server");
      const tempRule = await createNatureRule({ user: admin, ip: null, input: { companyId: companyAId, prefix: "35", classification: "EXPENSE", aggregationBehavior: "FLOW", reason: "مؤقتة للحذف" } });
      await expectErrorAsync("VERSION_CONFLICT", () => deleteNatureRule({ user: admin, ip: null, id: tempRule.id, input: { version: tempRule.version + 99 } }));
      await deleteNatureRule({ user: admin, ip: null, id: tempRule.id, input: { version: tempRule.version, reason: "تنظيف مؤقت" } });
      expect((await db.accountNatureRule.findUnique({ where: { id: tempRule.id } })) === null, "البادئة حُذفت فعليًا");
      const tempOv = await createMappingOverride({ user: admin, ip: null, input: { companyId: companyAId, accountCode: "359999", classification: "EXPENSE", aggregationBehavior: "FLOW" } });
      await deleteMappingOverride({ user: admin, ip: null, id: tempOv.id, input: { version: tempOv.version, reason: "تنظيف مؤقت" } });
      expect((await db.accountMappingOverride.findUnique({ where: { id: tempOv.id } })) === null, "الاستثناء المؤقت حُذف");
      expect(!!await db.auditLog.findFirst({ where: { action: "ACCOUNT_NATURE_RULE_DELETED", entityId: tempRule.id } }), "تدقيق حذف البادئة");
      expect(!!await db.auditLog.findFirst({ where: { action: "ACCOUNT_NATURE_OVERRIDE_DELETED", entityId: tempOv.id } }), "تدقيق حذف الاستثناء");
    });

    await check("B11+M fail-closed للنطاق: مستخدم بلا رؤية الشركة مرفوض + صلاحية نمط 6.1", async () => {
      const { createNatureRule } = await import("../src/lib/account-nature-server");
      await expectErrorAsync("RULE_NOT_FOUND", () =>
        createNatureRule({ user: limited, ip: null, input: { companyId: companyBId, prefix: "35", classification: "EXPENSE", aggregationBehavior: "FLOW" } })
      );
      expect(canManageAccountNature(syntheticUser().permissions, "admin") === true, "مدير ضمنيًا");
      expect(canManageAccountNature(syntheticUser({ role: "user", manageAccountNature: false }).permissions, "user") === false, "مستخدم بلا مفتاح = لا");
      expect(canManageAccountNature(syntheticUser({ role: "user", manageAccountNature: true }).permissions, "user") === true, "مفتاح صريح = نعم");
    });

    await check("B12 حاجز الاتساق خادميًا: أصل على قائمة أرباح مرفوض + بند غير موجود مرفوض", async () => {
      const { createNatureRule } = await import("../src/lib/account-nature-server");
      await expectErrorAsync("STATEMENT_LINE_MISMATCH", () =>
        createNatureRule({ user: admin, ip: null, input: { companyId: companyAId, prefix: "13", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineCode: "PNL-REVENUE" } })
      );
      await expectErrorAsync("INVALID_STATEMENT_LINE", () =>
        createNatureRule({ user: admin, ip: null, input: { companyId: companyAId, prefix: "13", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineCode: "SFP-NO-SUCH" } })
      );
    });

    await check("B13+12 نسخ خريطة A⇒B: استقلال تام بعد النسخ + تدقيق النسخ", async () => {
      const { copyCompanyMapping, updateNatureRule, resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      // B لديها بادئة 1101 قائمة ⇒ النسخ بلا استبدال يُرفض
      await expectErrorAsync("COPY_NOT_ALLOWED", () =>
        copyCompanyMapping({ user: admin, ip: null, input: { fromCompanyId: companyAId, toCompanyId: companyBId } })
      );
      const result = await copyCompanyMapping({ user: admin, ip: "127.0.0.1", input: { fromCompanyId: companyAId, toCompanyId: companyBId, replaceExisting: true, reason: "توحيد الدليل من A" } });
      expect(result.rulesCopied === 7 && result.overridesCopied === 1 && result.replaced === true, `نُسخت 7 بادئات و1 استثناء وجاء ${JSON.stringify(result)}`);
      const bResolve = await resolveCodesForCompany(companyBId, ["11010105", "310199"]);
      const bByCode = new Map(bResolve.results.map((r) => [r.accountCode, r]));
      expect(bByCode.get("11010105")!.statementLineCode === "SFP-CASH", "B بعد النسخ: 1101 ⇒ النقدية (كما A)");
      expect(bByCode.get("310199")!.source === "ACCOUNT_OVERRIDE" && bByCode.get("310199")!.statementLineCode === "PNL-ADMIN-EXPENSES", "نسخ الاستثناءات كذلك");
      // الاستقلال: تعديل A لاحقًا لا يمس B
      const a1101 = await db.accountNatureRule.findFirstOrThrow({ where: { companyId: companyAId, prefix: "1101" } });
      await updateNatureRule({ user: admin, ip: null, id: a1101.id, input: { note: "تعديل بعد النسخ", version: a1101.version, reason: "إثبات الاستقلال" } });
      const bAgain = await db.accountNatureRule.findFirst({ where: { companyId: companyBId, prefix: "1101" } });
      expect(bAgain!.note === "", "B لم تتأثر بتعديل A بعد النسخ (نسخة مستقلة)");
      const copyAudit = await db.auditLog.findFirst({ where: { action: "ACCOUNT_NATURE_MAPPING_COPIED", entityType: "Company", entityId: companyBId } });
      expect(!!copyAudit && JSON.parse(copyAudit!.metadata || "{}").rulesCopied === 7, "تدقيق ACCOUNT_NATURE_MAPPING_COPIED بتفاصيل النسخ");
    });

    await check("B14 حذف شركة يحذف بادئاته واستثناءاته فقط (Cascade) — الجذور والبنود باقية", async () => {
      const c = await db.company.create({ data: { code: "GATE-C", nameAr: "شركة بوابة ج" } });
      await db.accountNatureRule.create({ data: { companyId: c.id, prefix: "99", classification: "OTHER", aggregationBehavior: "BALANCE", source: "MANUAL" } });
      await db.accountMappingOverride.create({ data: { companyId: c.id, accountCode: "990001", classification: "OTHER", aggregationBehavior: "BALANCE" } });
      await db.company.delete({ where: { id: c.id } });
      expect((await db.accountNatureRule.count({ where: { companyId: c.id } })) === 0, "بادئات الشركة حُذفت معها");
      expect((await db.accountMappingOverride.count({ where: { companyId: c.id } })) === 0, "استثناءات الشركة حُذفت معها");
      expect((await db.accountNatureRule.count({ where: { companyId: null } })) === 4, "الجذور النظامية الأربعة باقية");
      expect((await db.financialStatementLine.count()) === STATEMENT_LINE_SEED.length, "بنود القوائم لم تُلمس");
    });

    await check("B15 التفرد الفيزيائي: تكرار جذر نظامي/بادئة شركة/استثناء يُرفض من DB", async () => {
      let rejected = 0;
      try {
        await db.$executeRawUnsafe(`INSERT INTO "AccountNatureRule" ("id","companyId","prefix","classification","aggregationBehavior") VALUES ('anr-dup-sys', NULL, '3', 'ASSET', 'BALANCE')`);
      } catch { rejected += 1; }
      try {
        await db.$executeRawUnsafe(`INSERT INTO "AccountNatureRule" ("id","companyId","prefix","classification","aggregationBehavior") VALUES ('anr-dup-co', '${companyAId}', '31', 'ASSET', 'BALANCE')`);
      } catch { rejected += 1; }
      try {
        await db.$executeRawUnsafe(`INSERT INTO "AccountMappingOverride" ("id","companyId","accountCode","classification","aggregationBehavior") VALUES ('ov-dup', '${companyAId}', '310199', 'EXPENSE', 'FLOW')`);
      } catch { rejected += 1; }
      expect(rejected === 3, `الثلاثة يجب أن يُرفضوا بالفهارس الفريدة وجاء ${rejected}`);
    });

    await check("B16 سلسلة migrations: الترحيلات الثلاثة مطبقة بلا فشل", async () => {
      const applied = await db.$queryRawUnsafe<{ migration_name: string }[]>(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY started_at`);
      const names = applied.map((r) => r.migration_name);
      expect(names.includes("0_init"), "ترحيل الأساس مطبق");
      expect(names.includes("20260922085424_phase61_financial_foundation"), "ترحيل 6.1 مطبق");
      expect(names.includes("20260922210011_phase62a_account_nature"), "ترحيل 6.2A النهائي مطبق");
    });
  } finally {
    await db.$disconnect();
  }
}

/* ── التشغيل ── */
async function main() {
  console.log("═══ بوابة Phase 6.2A — دليل الحسابات وقواعد التصنيف (التصميم النهائي) ═══");
  await partA();
  await partB();
  console.log("\n═══ الخلاصة ═══");
  console.log(`PASS: ${passCount}  FAIL: ${failCount}`);
  if (failures.length > 0) {
    console.log("الفواصل:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("فشل تشغيل البوابة:", e);
  process.exit(1);
});
