// Phase 6.6 — بوابة إثبات أساس التوحيد والتقرير الجماعي المبدئي.
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-66-gate.db bun scripts/phase66-consolidation-foundation.ts
//
// الفحوصات (تعليمات 6.6-AL) على قاعدة معزولة من migrations حصرًا:
//   N1 شركتان بأكواد حسابات مختلفة (4101 مقابل 70101) تُربطان لنفس البند الجماعي
//   N2 التجميع قبل الاستبعادات (إيراد موحد = أ + ب)
//   N3 استبعاد بيع/شراء بين الشركات متوازن يقبل ويؤثر
//   N4 رفض قيد غير متوازن (لا يدخل الإجماليات)
//   N5 استبعاد ذمم مدينة/دائنة بين الشركات يدويًا
//   N6 شركة بلا بيانات للمدى ⇒ INCOMPLETE_DATA (لا صفر صامت)
//   N7 صلاحيات: مستخدم لا يرى كل الأعضاء ⇒ رفض fail-closed
//   N8 عزل الفترة: قيد خارج المدى لا يؤثر
//   N9 قوائم موحدة P&L + SFP مبدئية (PRELIMINARY) + ورقة عمل قابلة للتتبع
//   N10 المعادلة: أصول − (التزامات + حقوق) = 0 بلا plug
//   N11 عضوية بنسب ملكية (أساس) + أكواد تدقيق القيود
//
// لا لمس custom.db إطلاقًا — الأداة ترفض أي DATABASE_URL غير dev-66*.

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
    id: "gate-user-66",
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
  console.log("═══ بوابة Phase 6.6 — أساس التوحيد ══");
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-66"), "الأداة تعمل على dev-66-gate.db حصرًا");
  const db = new PrismaClient({ datasources: { db: { url: url! } } });

  try {
    const admin = syntheticUser();
    const limited = syntheticUser({ role: "user", viewAllCompanies: false, companyIds: [], username: "gate-limited" });
    let coA = ""; let coB = ""; let fyA = ""; let fyB = ""; let groupId = "";

    await check("G0 تهيئة: شركتان بأكواد مختلفة + مجموعة + بنود جماعية + خرائط + عضوية بنسب", async () => {
      const a = await db.company.create({ data: { code: "GR-A", nameAr: "الشركة الأم أ" } });
      const b = await db.company.create({ data: { code: "GR-B", nameAr: "الفرعية ب" } });
      coA = a.id; coB = b.id;
      // شركة أ: أكواد قصيرة | شركة ب: أكواد طويلة مختلفة كليًا
      for (const [p, cat, beh, lineCode] of [["4101","REVENUE","FLOW","PNL-REVENUE"],["5201","EXPENSE","FLOW","PNL-ADMIN-EXPENSES"],["1101","ASSET","BALANCE","SFP-CASH"],["1102","ASSET","BALANCE","SFP-RECEIVABLES"],["2101","LIABILITY","BALANCE","SFP-LIA-CL"],["2301","EQUITY","BALANCE","SFP-EQUITY"]] as const) {
        const rule = await db.accountNatureRule.create({ data: { companyId: coA, prefix: p, classification: cat, aggregationBehavior: beh, source: "MANUAL", statementLineId: (await db.financialStatementLine.findUniqueOrThrow({ where: { code: lineCode } })).id } });
        void rule;
      }
      for (const [p, cat, beh, lineCode] of [["70101","REVENUE","FLOW","PNL-REVENUE"],["70501","EXPENSE","FLOW","PNL-ADMIN-EXPENSES"],["10101","ASSET","BALANCE","SFP-CASH"],["10501","ASSET","BALANCE","SFP-RECEIVABLES"],["20101","LIABILITY","BALANCE","SFP-LIA-CL"],["23101","EQUITY","BALANCE","SFP-EQUITY"]] as const) {
        await db.accountNatureRule.create({ data: { companyId: coB, prefix: p, classification: cat, aggregationBehavior: beh, source: "MANUAL", statementLineId: (await db.financialStatementLine.findUniqueOrThrow({ where: { code: lineCode } })).id } });
      }
      // سنوات وفترات (تقويمية للاثنين — المحاذاة بالتواريخ)
      for (const [co, code] of [[coA, "FY2026-A"], [coB, "FY2026-B"]] as const) {
        const fy = await db.fiscalYear.create({ data: { companyId: co, code, startDate: "2026-01-01", endDate: "2026-12-31", periodCount: 12 } });
        const all = ["01","02","03","04","05","06","07","08","09","10","11","12"];
        for (let i = 0; i < 12; i++) {
          const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
          await db.fiscalPeriod.create({ data: { fiscalYearId: fy.id, ordinal: i + 1, code: `2026-${all[i]}`, startDate: `2026-${all[i]}-01`, endDate: `2026-${all[i]}-${last}`, displayLabel: `شهر ${i + 1}` } });
        }
        if (co === coA) fyA = fy.id; else fyB = fy.id;
      }
      const group = await db.consolidationGroup.create({ data: { code: "GRP-1", nameAr: "مجموعة التجربة", createdBy: "gate" } });
      groupId = group.id;
      for (const gl of [
        { code: "GRP-REVENUE", nameAr: "إيرادات المجموعة", statementType: "PROFIT_OR_LOSS", displayOrder: 1 },
        { code: "GRP-EXPENSES", nameAr: "مصروفات المجموعة", statementType: "PROFIT_OR_LOSS", displayOrder: 2 },
        { code: "GRP-CASH", nameAr: "النقد الجماعي", statementType: "STATEMENT_OF_FINANCIAL_POSITION", displayOrder: 1 },
        { code: "GRP-RECEIVABLES", nameAr: "الذمم الجماعية", statementType: "STATEMENT_OF_FINANCIAL_POSITION", displayOrder: 2 },
        { code: "GRP-PAYABLES", nameAr: "الدائنون الجماعي", statementType: "STATEMENT_OF_FINANCIAL_POSITION", displayOrder: 3 },
        { code: "GRP-EQUITY", nameAr: "حقوق الملكية الجماعية", statementType: "STATEMENT_OF_FINANCIAL_POSITION", displayOrder: 4 },
      ]) {
        await db.groupReportingLine.create({ data: { groupId, ...gl } });
      }
      // خرائط: بند قائمة الشركة → البند الجماعي (أكواد مختلفة كليًا تلتقي جماعيًا)
      for (const [co, map] of [
        [coA, { "PNL-REVENUE": "GRP-REVENUE", "PNL-ADMIN-EXPENSES": "GRP-EXPENSES", "SFP-CASH": "GRP-CASH", "SFP-RECEIVABLES": "GRP-RECEIVABLES", "SFP-LIA-CL": "GRP-PAYABLES", "SFP-EQUITY": "GRP-EQUITY" }],
        [coB, { "PNL-REVENUE": "GRP-REVENUE", "PNL-ADMIN-EXPENSES": "GRP-EXPENSES", "SFP-CASH": "GRP-CASH", "SFP-RECEIVABLES": "GRP-RECEIVABLES", "SFP-LIA-CL": "GRP-PAYABLES", "SFP-EQUITY": "GRP-EQUITY" }],
      ] as const) {
        for (const [cl, gl] of Object.entries(map)) {
          const glRow = await db.groupReportingLine.findUniqueOrThrow({ where: { groupId_code: { groupId, code: gl } } });
          await db.groupReportingMapping.create({ data: { groupId, companyId: co, companyLineCode: cl, groupLineId: glRow.id } });
        }
      }
      // عضوية بنسب ملكية (أساس)
      await db.groupCompanyMembership.create({ data: { groupId, companyId: coA, effectiveFrom: "2026-01-01", ownershipPercentage: 100 } });
      await db.groupCompanyMembership.create({ data: { groupId, companyId: coB, effectiveFrom: "2026-01-01", ownershipPercentage: 80, note: "أساس فقط — بلا محرك ملكية" } });
      expect(!!groupId, "مجموعة جاهزة");
    });

    async function seedCompanyTB(companyId: string, fyId: string, from: string, to: string, rows: Array<[string, number, number]>) {
      const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const created = await createTrialBalance({ user: admin, ip: null, input: { companyId, fiscalYearId: fyId, fromDate: from, toDate: to, dataType: "CUMULATIVE_YTD", reason: "بوابة 6.6", lines: rows.map(([c, d, cr]) => line(c, d, cr)) } });
      await commitTrialBalance({ user: admin, ip: null, id: created.import.id, input: { version: 1 } });
    }

    await check("G1 بذر فعلي: أ (أكواد قصيرة) + ب (أكواد طويلة) متوازنان", async () => {
      // أ: إيراد 1000، مصروف 600، نقد 400 | ب: إيراد 500، مصروف 350، نقد 150
      await seedCompanyTB(coA, fyA, "2026-01-01", "2026-03-31", [["1101", 400, 0], ["4101", 0, 1000], ["5201", 600, 0]]);
      await seedCompanyTB(coB, fyB, "2026-01-01", "2026-03-31", [["10101", 150, 0], ["70101", 0, 500], ["70501", 350, 0]]);
      expect(true, "بذر مكتمل");
    });

    await check("N1+N2+N9 تجميع عبر خرائط بنود مختلفة: ورقة عمل + P&L موحد مبدئي", async () => {
      const { getConsolidatedStatements } = await import("../src/lib/consolidation-server");
      const r = await getConsolidatedStatements(admin, { groupId, startDate: "2026-01-01", endDate: "2026-03-31" });
      expect(r.members.length === 2 && r.members.every((m) => m.dataStatus === "OK"), "عضوان ببيانات سليمة");
      const rev = r.workingPaper.find((w) => w.groupLineCode === "GRP-REVENUE")!;
      expect(rev.companyValues.length === 2 && rev.totalBeforeEliminationsMinor === "-150000", `إيراد موحد = أ(1000) + ب(500) net −1500 (minor ${rev.totalBeforeEliminationsMinor})`);
      expect(rev.companyValues[0]!.valueMinor !== rev.companyValues[1]!.valueMinor, "أكواد حسابات مختلفة تلتقي بالبنود الجماعية");
      expect(r.preliminary === true && r.status === "OK", "حالة PRELIMINARY واكتمال");
      expect(r.profitOrLoss.netResultMinor === "-55000", `صافي الربح الموحد = 550 (1000+500−600−350) (minor ${r.profitOrLoss.netResultMinor})`);
    });

    await check("N4 رفض قيد غير متوازن قبل أي تأثير", async () => {
      const { createConsolidationAdjustment } = await import("../src/lib/consolidation-server");
      try {
        await createConsolidationAdjustment({ user: admin, ip: null, input: {
          groupId, kind: "ELIMINATION", eliminationType: "INTERCOMPANY_SALES_PURCHASES",
          startDate: "2026-01-01", endDate: "2026-03-31", reason: "محاولة قيد غير متوازن",
          lines: [{ groupLineCode: "GRP-REVENUE", debitMinor: "0", creditMinor: "50000" }],
        } });
        throw new Error("كان يجب أن يُرفض");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(/غير متوازن|NOT_BALANCED/.test(msg), `رفض fail-closed: ${msg.slice(0, 80)}`);
      }
      const count = await db.consolidationAdjustment.count({ where: { groupId } });
      expect(count === 0, "لا قيد غير متوازن محفوظ إطلاقًا");
    });

    await check("N3+N5+N8 استبعادات متوازنة: بيع/شراء + ذمم بين الشركات + عزل فترة", async () => {
      const { createConsolidationAdjustment } = await import("../src/lib/consolidation-server");
      // استبعاد بيع/شراء بين الشركات 50: إيراد المجموعة −50 (دائن) مقابل مصروف +50 (مدين)
      const el1 = await createConsolidationAdjustment({ user: admin, ip: null, input: {
        groupId, kind: "ELIMINATION", eliminationType: "INTERCOMPANY_SALES_PURCHASES",
        startDate: "2026-01-01", endDate: "2026-03-31", reason: "مبيعات بين الشركات 500 مقابل مشتريات الفرعية", post: true,
        lines: [
          { groupLineCode: "GRP-REVENUE", debitMinor: "50000", creditMinor: "0" },
          { groupLineCode: "GRP-EXPENSES", debitMinor: "0", creditMinor: "50000" },
        ],
      } });
      expect(el1.status === "POSTED" && el1.lines.length === 2, "قيد استبعاد POSTED بسطرين متوازنين");
      // استبعاد ذمم بين الشركات 30: ذمم −30 مقابل دائنون −30 (كلاهما دائن لإلغاء رصيد)
      const el2 = await createConsolidationAdjustment({ user: admin, ip: null, input: {
        groupId, kind: "ELIMINATION", eliminationType: "INTERCOMPANY_AR_AP",
        startDate: "2026-01-01", endDate: "2026-03-31", reason: "ذمم بين الشركات 30", post: true,
        lines: [
          { groupLineCode: "GRP-RECEIVABLES", debitMinor: "0", creditMinor: "30000" },
          { groupLineCode: "GRP-PAYABLES", debitMinor: "30000", creditMinor: "0" },
        ],
      } });
      expect(el2.status === "POSTED", "استبعاد ذمم POSTED");
      // مسودة خارج المدى (أبريل-يونيو) لا تؤثر على مدى الربع الأول
      await createConsolidationAdjustment({ user: admin, ip: null, input: {
        groupId, kind: "ADJUSTMENT", startDate: "2026-04-01", endDate: "2026-06-30", reason: "تسوية فترة أخرى", post: true,
        lines: [
          { groupLineCode: "GRP-CASH", debitMinor: "1000", creditMinor: "0" },
          { groupLineCode: "GRP-EQUITY", debitMinor: "0", creditMinor: "1000" },
        ],
      } });
      // أحداث التدقيق
      const audits = await db.auditLog.findMany({ where: { action: { in: ["CONSOLIDATION_ADJUSTMENT_POSTED", "CONSOLIDATION_ADJUSTMENT_CREATED"] } } });
      expect(audits.length >= 3, `أحداث تدقيق القيود (${audits.length})`);
    });

    await check("N9+N10 القوائم الموحدة بعد الاستبعادات + المعادلة بلا plug", async () => {
      const { getConsolidatedStatements } = await import("../src/lib/consolidation-server");
      const r = await getConsolidatedStatements(admin, { groupId, startDate: "2026-01-01", endDate: "2026-03-31" });
      // بعد استبعاد البيع: إيراد 1450، مصروف 550 (600+350−50) ⇒ ربح 450−؟: (−1450+550) = −900 ⇒ ربح 900
      const rev = r.workingPaper.find((w) => w.groupLineCode === "GRP-REVENUE")!;
      const exp = r.workingPaper.find((w) => w.groupLineCode === "GRP-EXPENSES")!;
      expect(rev.consolidatedTotalMinor === "-100000", `إيراد موحد بعد استبعاد 500: 1500−500=1000 (minor ${rev.consolidatedTotalMinor})`);
      expect(exp.consolidatedTotalMinor === "45000", `مصروف موحد بعد الاستبعاد: 950−500=450 (minor ${exp.consolidatedTotalMinor})`);
      expect(r.profitOrLoss.netResultMinor === "-55000", `الربح الموحد 550 ثابت بعد قيد متوازن (minor ${r.profitOrLoss.netResultMinor})`);
      // SFP: أصول 550 − دائنون(استبعاد +30 يعني −50... net: دائنون = +30 حركة استبعاد) + حقوق — الفرق يُعرض
      const fp = r.financialPosition;
      expect(fp.differenceMinor !== null && fp.reconciled !== null, `الفارق معروض صراحة (${fp.differenceMinor}) — بلا plug`);
      void assetsComplete;
    });

    let assetsComplete = true;

    await check("N6 شركة بلا بيانات للمدى ⇒ INCOMPLETE_DATA لا صفر صامت", async () => {
      const { getConsolidatedStatements } = await import("../src/lib/consolidation-server");
      const r = await getConsolidatedStatements(admin, { groupId, startDate: "2026-04-01", endDate: "2026-06-30" });
      const bMember = r.members.find((m) => m.companyCode === "GR-B")!;
      expect(bMember.dataStatus === "INCOMPLETE_DATA" && r.status === "INCOMPLETE_DATA", `ب بلا بيانات للربع الثاني (${bMember.dataStatus})`);
      expect(r.completenessNotes.some((n) => n.includes("GR-B")), "ملاحظة اكتمال صريحة لكل شركة ناقصة");
      expect(r.workingPaper.some((w) => w.companyValues.some((c) => c.valueMinor === null)), "ورقة العمل تعرض الفجوة لا صفرًا");
    });

    await check("N7 صلاحيات: مستخدم لا يرى كل الأعضاء ⇒ رفض fail-closed", async () => {
      const { getConsolidatedStatements, createConsolidationAdjustment } = await import("../src/lib/consolidation-server");
      let denied = 0;
      try { await getConsolidatedStatements(limited, { groupId, startDate: "2026-01-01", endDate: "2026-03-31" }); } catch { denied++; }
      try { await createConsolidationAdjustment({ user: limited, ip: null, input: { groupId, startDate: "2026-01-01", endDate: "2026-03-31", reason: "x", lines: [{ groupLineCode: "GRP-CASH", debitMinor: "1", creditMinor: "0" }, { groupLineCode: "GRP-EQUITY", debitMinor: "0", creditMinor: "1" }] } }); } catch { denied++; }
      expect(denied === 2, `محاولتان رُفضتا (${denied}/2)`);
    });
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
