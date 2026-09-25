// Phase 6.11R — بوابة تصحيح جذور دليل الحسابات (ACR — Account Root Correction).
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-acr-gate.db bun scripts/phase-account-root-correction.ts
//
// الغاية (القرار المحاسبي المعتمد — إعادة تطبيق الاسترداد):
//   1xxx = ASSET | 3xxx = EXPENSE (3101 = EXPENSE ولا يجوز EQUITY أبدًا)
//   4xxx = REVENUE — والجذر 2 هو الجذر المركّب الوحيد: بادئاته التفصيلية
//   (21/23…) هي ما يحدد LIABILITY مقابل EQUITY.
//   أي بادئة/استثناء/نسخ يخالف جذره ⇒ مرفوض عند الإدخال (PREFIX_ROOT_CONFLICT /
//   OVERRIDE_ROOT_CONFLICT) ومُهمل عند الحل (دفاع عميق ضد قواعد قديمة فاسدة) —
//   لا OTHER صامت أبدًا، والحالة NEEDS_* معلنة كما هي.
//
// 18 فحصًا: A1 مرآة الجذور | A2-A6 الحل الجذري | A7-A8 البادئات المشروعة
//            A9-A12 رفض تناقض البادئات | A13-A15 رفض/إهمال تناقض الاستثناءات
//            A16 عبارة الجذر 2 المعتمدة | A17 حاجز بنود القوائم | A18 خلاصة التغطية + حاجز النسخ
//
// لا لمس custom.db إطلاقًا — الأداة ترفض أي DATABASE_URL غير dev-acr*.

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

function expectError(code: string, fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    const got = (e as { code?: string })?.code ?? "";
    expect(got === code, `الرمز المتوقع ${code} وجاء ${got} (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  throw new Error(`كان يجب رفض العملية بالرمز ${code} لكنها نجحت`);
}

async function expectErrorAsync(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const got = (e as { code?: string })?.code ?? "";
    expect(got === code, `الرمز المتوقع ${code} وجاء ${got} (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  throw new Error(`كان يجب رفض العملية بالرمز ${code} لكنها نجحت`);
}

function syntheticUser(over: Partial<{ role: string; companyIds: string[]; viewAllCompanies: boolean; username: string }> = {}): SessionUser {
  return {
    id: "gate-user-acr",
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

async function main() {
  console.log("═══ بوابة تصحيح جذور دليل الحسابات (ACR) — 3101=EXPENSE والجذر 2 مركّب ══");
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-acr"), "الأداة تعمل على dev-acr-gate.db حصرًا");
  const db = new PrismaClient({ datasources: { db: { url: url! } } });
  const admin = syntheticUser();

  try {
    let co = ""; let coSrc = "";

    await check("A0 تهيئة: شركتان معزولتان على قاعدة بوابة جديدة", async () => {
      const a = await db.company.create({ data: { code: "ACR-A", nameAr: "شركة بوابة الجذور أ" } });
      const b = await db.company.create({ data: { code: "ACR-SRC", nameAr: "شركة مصدر النسخ المسمومة" } });
      co = a.id; coSrc = b.id;
      expect(!!co && !!coSrc && co !== coSrc, "شركتان جاهزتان");
    });

    await check("A1 مرآة الجذور النظامية: 1=ASSET | 2=مركّب بلا تصنيف | 3=EXPENSE | 4=REVENUE", async () => {
      const rows = await db.accountNatureRule.findMany({ where: { companyId: null, source: "SYSTEM" }, orderBy: { prefix: "asc" } });
      const by = new Map(rows.map((r) => [r.prefix, r]));
      expect(by.get("1")?.mainCategory === "ASSETS" && by.get("1")?.classification === "ASSET" && by.get("1")?.aggregationBehavior === "BALANCE", "الجذر 1 = ASSETS/ASSET/BALANCE");
      expect(by.get("2")?.mainCategory === "LIABILITIES_EQUITY" && by.get("2")?.classification === null && by.get("2")?.aggregationBehavior === "BALANCE", "الجذر 2 = LIABILITIES_EQUITY/بلا تصنيف/BALANCE (مركّب)");
      expect(by.get("3")?.mainCategory === "EXPENSES" && by.get("3")?.classification === "EXPENSE" && by.get("3")?.aggregationBehavior === "FLOW", "الجذر 3 = EXPENSES/EXPENSE/FLOW");
      expect(by.get("4")?.mainCategory === "REVENUE" && by.get("4")?.classification === "REVENUE" && by.get("4")?.aggregationBehavior === "FLOW", "الجذر 4 = REVENUE/REVENUE/FLOW");
    });

    await check("A2 الجذر 1 يحسم: 110199 ⇒ ASSET/BALANCE من SYSTEM_ROOT (ROOT_ONLY بلا بند)", async () => {
      const { resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      const r = (await resolveCodesForCompany(co, ["110199"])).results[0]!;
      expect(r.classification === "ASSET" && r.aggregationBehavior === "BALANCE" && r.source === "SYSTEM_ROOT", `110199 ⇒ ASSET وجاء ${JSON.stringify(r)}`);
      expect(r.mainCategory === "ASSETS" && r.mappingStatus === "ROOT_ONLY" && r.statementLineCode === null, "ROOT_ONLY بلا بند مالي (لا تخمين)");
    });

    await check("A3 الجذر 3 يحسم: 3101 و 310199 ⇒ EXPENSE حصرًا — 3101 لا يجوز EQUITY أبدًا", async () => {
      const { resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      const res = (await resolveCodesForCompany(co, ["3101", "310199"])).results;
      for (const r of res) {
        expect(r.classification === "EXPENSE" && r.aggregationBehavior === "FLOW" && r.source === "SYSTEM_ROOT", `${r.accountCode} ⇒ EXPENSE وجاء ${JSON.stringify(r)}`);
        expect(String(r.classification) !== "EQUITY", `${r.accountCode}: ليس EQUITY`);
      }
    });

    await check("A4 الجذر 4 يحسم: 410199 ⇒ REVENUE/FLOW من SYSTEM_ROOT", async () => {
      const { resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      const r = (await resolveCodesForCompany(co, ["410199"])).results[0]!;
      expect(r.classification === "REVENUE" && r.aggregationBehavior === "FLOW" && r.source === "SYSTEM_ROOT", `410199 ⇒ REVENUE وجاء ${JSON.stringify(r)}`);
    });

    await check("A5 الجذر 2 بلا بادئة ⇒ NEEDS_DETAILED_CLASSIFICATION (2101 يبقى غير محسوم)", async () => {
      const { resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      const r = (await resolveCodesForCompany(co, ["210199"])).results[0]!;
      expect(r.mainCategory === "LIABILITIES_EQUITY" && r.classification === null && r.mappingStatus === "NEEDS_DETAILED_CLASSIFICATION", `210199 يحتاج تفصيلًا وجاء ${JSON.stringify(r)}`);
      expect(r.classification !== "LIABILITY" && r.classification !== "EQUITY", "لا تخمين LIABILITY/EQUITY للجذر المركّب");
    });

    await check("A6 كود خارج الجذور ⇒ NEEDS_CLASSIFICATION (لا OTHER صامت)", async () => {
      const { resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      const r = (await resolveCodesForCompany(co, ["9999"])).results[0]!;
      expect(r.classification === null && r.mainCategory === null && r.mappingStatus === "NEEDS_CLASSIFICATION" && r.source === null, `9999 غير مصنف وجاء ${JSON.stringify(r)}`);
    });

    await check("A7 البادئات المشروعة للجذر 2: 21⇒LIABILITY و 23⇒EQUITY (COMPANY_PREFIX)", async () => {
      const { createNatureRule, resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      await createNatureRule({ user: admin, ip: "gate-acr", input: { companyId: co, prefix: "21", classification: "LIABILITY", aggregationBehavior: "BALANCE", statementLineCode: "SFP-LIA-CL", reason: "بوابة ACR" } });
      await createNatureRule({ user: admin, ip: "gate-acr", input: { companyId: co, prefix: "23", classification: "EQUITY", aggregationBehavior: "BALANCE", statementLineCode: "SFP-EQUITY", reason: "بوابة ACR" } });
      const l = (await resolveCodesForCompany(co, ["210101"])).results[0]!;
      const e = (await resolveCodesForCompany(co, ["230101"])).results[0]!;
      expect(l.classification === "LIABILITY" && l.companyPrefix === "21" && l.source === "COMPANY_PREFIX", `210101 ⇒ LIABILITY وجاء ${JSON.stringify(l)}`);
      expect(e.classification === "EQUITY" && e.companyPrefix === "23" && e.source === "COMPANY_PREFIX", `230101 ⇒ EQUITY وجاء ${JSON.stringify(e)}`);
    });

    await check("A8 الأطول يفوز داخل الجذر 2: 230101 يتبع بادئة 23 (EQUITY) لا الجذر", async () => {
      const { resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      const e = (await resolveCodesForCompany(co, ["230101"])).results[0]!;
      expect(e.matchedPrefix === "23" && e.mainCategory === "LIABILITIES_EQUITY" && e.classification === "EQUITY", `matchedPrefix=23 وجاء ${JSON.stringify(e)}`);
    });

    await check("A9 رفض 31⇒EQUITY (PREFIX_ROOT_CONFLICT) — 31xx = EXPENSE حصرًا", async () => {
      const { createNatureRule } = await import("../src/lib/account-nature-server");
      await expectErrorAsync("PREFIX_ROOT_CONFLICT", () =>
        createNatureRule({ user: admin, ip: "gate-acr", input: { companyId: co, prefix: "31", classification: "EQUITY", aggregationBehavior: "BALANCE" } })
      );
    });

    await check("A10 رفض 11⇒LIABILITY (الجذر 1 يقبل ASSET حصرًا)", async () => {
      const { createNatureRule } = await import("../src/lib/account-nature-server");
      await expectErrorAsync("PREFIX_ROOT_CONFLICT", () =>
        createNatureRule({ user: admin, ip: "gate-acr", input: { companyId: co, prefix: "11", classification: "LIABILITY", aggregationBehavior: "BALANCE" } })
      );
    });

    await check("A11 رفض 41⇒EXPENSE (الجذر 4 يقبل REVENUE حصرًا)", async () => {
      const { createNatureRule } = await import("../src/lib/account-nature-server");
      await expectErrorAsync("PREFIX_ROOT_CONFLICT", () =>
        createNatureRule({ user: admin, ip: "gate-acr", input: { companyId: co, prefix: "41", classification: "EXPENSE", aggregationBehavior: "FLOW" } })
      );
    });

    await check("A12 رفض استثناء 310199⇒EQUITY (OVERRIDE_ROOT_CONFLICT) — 3101 لا يجوز EQUITY أبدًا", async () => {
      const { createMappingOverride } = await import("../src/lib/account-nature-server");
      await expectErrorAsync("OVERRIDE_ROOT_CONFLICT", () =>
        createMappingOverride({ user: admin, ip: "gate-acr", input: { companyId: co, accountCode: "310199", classification: "EQUITY", aggregationBehavior: "BALANCE" } })
      );
    });

    await check("A13 رفض استثناء 110101⇒REVENUE (OVERRIDE_ROOT_CONFLICT)", async () => {
      const { createMappingOverride } = await import("../src/lib/account-nature-server");
      await expectErrorAsync("OVERRIDE_ROOT_CONFLICT", () =>
        createMappingOverride({ user: admin, ip: "gate-acr", input: { companyId: co, accountCode: "110101", classification: "REVENUE", aggregationBehavior: "FLOW" } })
      );
    });

    await check("A14 دفاع عميق: قاعدة 31⇒EQUITY فاسدة (SQL مباشر) تُهمل في الحل — 310101 يبقى EXPENSE من الجذر", async () => {
      await db.$executeRawUnsafe(`INSERT INTO "AccountNatureRule" ("id","companyId","prefix","classification","aggregationBehavior","source","isActive","version","createdAt","updatedAt") VALUES ('anr-acr-poison', '${co}', '31', 'EQUITY', 'BALANCE', 'MANUAL', 1, 1, 1767225600000, 1767225600000)`);
      try {
        const { resolveCodesForCompany } = await import("../src/lib/account-nature-server");
        const r = (await resolveCodesForCompany(co, ["310101"])).results[0]!;
        expect(r.classification === "EXPENSE" && r.source === "SYSTEM_ROOT" && r.companyPrefix === null, `القاعدة الفاسدة أُهملت وجاء ${JSON.stringify(r)}`);
        expect(String(r.classification) !== "EQUITY", "310101 ليس EQUITY حتى مع قاعدة فاسدة");
      } finally {
        await db.accountNatureRule.deleteMany({ where: { id: "anr-acr-poison" } });
      }
    });

    await check("A15 دفاع عميق: استثناء 230101⇒EXPENSE فاسد (SQL مباشر) يُهمل — البادئة 23 (EQUITY) تقود", async () => {
      await db.$executeRawUnsafe(`INSERT INTO "AccountMappingOverride" ("id","companyId","accountCode","classification","aggregationBehavior","isActive","version","createdAt","updatedAt") VALUES ('ov-acr-poison', '${co}', '230101', 'EXPENSE', 'FLOW', 1, 1, 1767225600000, 1767225600000)`);
      try {
        const { resolveCodesForCompany } = await import("../src/lib/account-nature-server");
        const r = (await resolveCodesForCompany(co, ["230101"])).results[0]!;
        expect(r.classification === "EQUITY" && r.source === "COMPANY_PREFIX", `الاستثناء الفاسد أُهمل وجاء ${JSON.stringify(r)}`);
      } finally {
        await db.accountMappingOverride.deleteMany({ where: { id: "ov-acr-poison" } });
      }
    });

    await check("A16 عبارة الجذر 2 المعتمدة: يُحدد حسب البادئة التفصيلية / Determined by detailed prefix", async () => {
      const { ROOT2_CLASSIFICATION_HINT } = await import("../src/lib/account-nature");
      const { ROOT2_PREFIX_HINT, root2PrefixHint } = await import("../src/lib/display-labels");
      expect(ROOT2_CLASSIFICATION_HINT.ar === "يُحدد حسب البادئة التفصيلية", `AR: ${ROOT2_CLASSIFICATION_HINT.ar}`);
      expect(ROOT2_CLASSIFICATION_HINT.en === "Determined by detailed prefix", `EN: ${ROOT2_CLASSIFICATION_HINT.en}`);
      expect(ROOT2_PREFIX_HINT.ar === ROOT2_CLASSIFICATION_HINT.ar && ROOT2_PREFIX_HINT.en === ROOT2_CLASSIFICATION_HINT.en, "المرآة ثنائية اللغة مطابقة");
      expect(root2PrefixHint("ar_en") === "يُحدد حسب البادئة التفصيلية — Determined by detailed prefix", "الصيغة الثنائية مركبة كما هو معتمد");
    });

    await check("A17 حاجز بنود القوائم سليم: EXPENSE لا يجلس على المركز المالي و EQUITY لا يجلس على الأرباح", async () => {
      const { isStatementLineConsistent } = await import("../src/lib/account-nature");
      expect(isStatementLineConsistent("EXPENSE", "STATEMENT_OF_FINANCIAL_POSITION") === false, "EXPENSE + مركز مالي ⇒ مرفوض");
      expect(isStatementLineConsistent("EQUITY", "PROFIT_OR_LOSS") === false, "EQUITY + أرباح ⇒ مرفوض");
      expect(isStatementLineConsistent("EQUITY", "STATEMENT_OF_FINANCIAL_POSITION") === true, "EQUITY + مركز مالي ⇒ مقبول");
      expect(isStatementLineConsistent("EXPENSE", "PROFIT_OR_LOSS") === true, "EXPENSE + أرباح ⇒ مقبول");
    });

    await check("A18 خلاصة التغطية + حاجز النسخ: شركة مسومة لا تُنسخ قواعدها الفاسدة (PREFIX_ROOT_CONFLICT)", async () => {
      const { resolveCodesForCompany } = await import("../src/lib/account-nature-server");
      const { summary } = await resolveCodesForCompany(co, ["110199", "310199", "410199", "210101", "230101", "9999"]);
      expect(summary.total === 6 && summary.byStatus.ROOT_ONLY === 3 && summary.byStatus.FULLY_MAPPED === 2 && summary.byStatus.NEEDS_CLASSIFICATION === 1, `خلاصة 6/3/2/1 وجاءت ${JSON.stringify(summary)}`);
      expect(summary.fullyMapped === 2 && summary.needsAttention === 3 && summary.unclassified === 1, "خلاصة الاكتمال متسقة");
      // شركة المصدر: قاعدة 31⇒EQUITY فاسدة (SQL مباشر) ⇒ النسخ مرفوض كله أو لا شيء
      await db.$executeRawUnsafe(`INSERT INTO "AccountNatureRule" ("id","companyId","prefix","classification","aggregationBehavior","source","isActive","version","createdAt","updatedAt") VALUES ('anr-acr-src-poison', '${coSrc}', '31', 'EQUITY', 'BALANCE', 'MANUAL', 1, 1, 1767225600000, 1767225600000)`);
      try {
        const { copyCompanyMapping } = await import("../src/lib/account-nature-server");
        await expectErrorAsync("PREFIX_ROOT_CONFLICT", () =>
          copyCompanyMapping({ user: admin, ip: "gate-acr", input: { fromCompanyId: coSrc, toCompanyId: co, replaceExisting: true, reason: "بوابة ACR" } })
        );
      } finally {
        await db.accountNatureRule.deleteMany({ where: { id: "anr-acr-src-poison" } });
      }
    });
  } finally {
    await db.$disconnect();
  }

  console.log("═══ الخلاصة ═══");
  console.log(`PASS: ${passCount} | FAIL: ${failCount}`);
  if (failCount > 0) {
    console.log("الإخفاقات:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("ACR GATE: 18/18 PASS");
}

main().catch((e) => {
  console.error("فشل بوابة ACR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
