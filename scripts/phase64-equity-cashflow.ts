// Phase 6.4 — بوابة إثبات قائمة التغيرات في حقوق الملكية + أساس IAS 7 (الطريقة غير المباشرة).
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-64-gate.db bun scripts/phase64-equity-cashflow.ts
//
// الفيكسشر أ متوازن محاسبيًا كل شهر (Σnet = 0) بلا أي حساب تسوية:
//   نقد 100/185/330 (rev2: 430) | مدينون 40/50/60 | مخزون 20/25/25 | قروض ممنوحة 1109: 0/10/15
//   متراكم إهلاك 10/30/50 | دائنون 30/60/95 | رأسمال 30 ثابت | إيراد 100/180/305 (rev2: 405) | إهلاك 10/30/50
//   ⇒ المدى [2..3]: Δنقد 230 = تشغيلية (ربح 165 + إهلاك 40 − مدينون 20 − مخزون 5 + دائنون 65) 245 + استثمارية (−15) ✓
//
// الفحوصات: E1 معادلة SOCIE | E2 فجوة حقوق ملكية معلنة | E3 سنة غير تقويمية | E4 عزل | E5 أحدث مراجعة
//           C1 تجاوز>بادئة | C2 إشارات مركزية | C3 لا جمع مزدوج + بلا افتتاحي ⇒ INCOMPLETE_DATA
//           C4 مطابقة النقد | C6 إفصاح NON_CASH | C7 عزل التدفقات
//
// لا لمس custom.db إطلاقًا — الأداة ترفض أي DATABASE_URL غير dev-64*.

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
    id: "gate-user-64",
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
  console.log("═══ بوابة Phase 6.4 — حقوق الملكية + IAS 7 (Foundation) ══");
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-64"), "الأداة تعمل على dev-64-gate.db حصرًا");
  const db = new PrismaClient({ datasources: { db: { url: url! } } });

  try {
    const admin = syntheticUser();
    const limited = syntheticUser({ role: "user", viewAllCompanies: false, companyIds: [], username: "gate-limited" });
    let coA = ""; let coB = ""; let fyA = ""; let fyB = "";
    let marchImportId = ""; let rev2Id = "";

    await check("G0 تهيئة: شركتان + سنتان + بادئات طبيعة + ربط حقوق ملكية + خريطة تدفقات", async () => {
      const a = await db.company.create({ data: { code: "EQ-A", nameAr: "شركة القوائم أ" } });
      const b = await db.company.create({ data: { code: "EQ-B", nameAr: "شركة القوائم ب" } });
      coA = a.id; coB = b.id;
      const fyArow = await db.fiscalYear.create({ data: { companyId: coA, code: "FY2026", startDate: "2026-01-01", endDate: "2026-12-31", periodCount: 12 } });
      const all = ["01","02","03","04","05","06","07","08","09","10","11","12"];
      for (let i = 0; i < 12; i++) {
        const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
        await db.fiscalPeriod.create({ data: { fiscalYearId: fyArow.id, ordinal: i + 1, code: `2026-${all[i]}`, startDate: `2026-${all[i]}-01`, endDate: `2026-${all[i]}-${last}`, displayLabel: `شهر ${i + 1}` } });
      }
      fyA = fyArow.id;
      const fyBrow = await db.fiscalYear.create({ data: { companyId: coB, code: "FY27/28", startDate: "2027-07-01", endDate: "2028-06-30", periodCount: 12 } });
      for (let i = 0; i < 12; i++) {
        const m = i < 6 ? 7 + i : 1 + (i - 6);
        const yy = i < 6 ? 2027 : 2028;
        const mm = String(m).padStart(2, "0");
        const last = new Date(Date.UTC(yy, m, 0)).getUTCDate();
        await db.fiscalPeriod.create({ data: { fiscalYearId: fyBrow.id, ordinal: i + 1, code: `${yy}-${mm}`, startDate: `${yy}-${mm}-01`, endDate: `${yy}-${mm}-${last}`, displayLabel: `فترة ${i + 1}` } });
      }
      fyB = fyBrow.id;
      for (const [p, cat, beh] of [["1101","ASSET","BALANCE"],["1102","ASSET","BALANCE"],["1201","ASSET","BALANCE"],["1109","ASSET","BALANCE"],["1591","ASSET","BALANCE"],["2101","LIABILITY","BALANCE"],["2301","EQUITY","BALANCE"],["2302","EQUITY","BALANCE"],["2399","EQUITY","BALANCE"],["4101","REVENUE","FLOW"],["5201","EXPENSE","FLOW"]] as const) {
        await db.accountNatureRule.create({ data: { companyId: coA, prefix: p, classification: cat, aggregationBehavior: beh, source: "MANUAL" } });
      }
      for (const [p, cat, beh] of [["1101","ASSET","BALANCE"],["1102","ASSET","BALANCE"],["2301","EQUITY","BALANCE"],["2399","EQUITY","BALANCE"],["4101","REVENUE","FLOW"],["5201","EXPENSE","FLOW"]] as const) {
        await db.accountNatureRule.create({ data: { companyId: coB, prefix: p, classification: cat, aggregationBehavior: beh, source: "MANUAL" } });
      }
      // ربط مفاهيم حقوق الملكية: أ تربط 2301+2302؛ ب تربط 2301 فقط (2399 تبقى غير مربوطة عمدًا — E2)
      await db.equityComponentMapping.create({ data: { companyId: coA, prefix: "2301", componentCode: "SHARE_CAPITAL" } });
      await db.equityComponentMapping.create({ data: { companyId: coA, prefix: "2302", componentCode: "OTHER_EQUITY_MOVEMENTS" } });
      await db.equityComponentMapping.create({ data: { companyId: coB, prefix: "2301", componentCode: "SHARE_CAPITAL" } });
      // خريطة التدفقات لشركة أ + تجاوز 1109 فوق بادئة 11
      const cfLine = async (code: string) => (await db.cashFlowStatementLine.findUniqueOrThrow({ where: { code } })).id;
      await db.cashFlowMapping.create({ data: { companyId: coA, prefix: "1101", activity: "CASH_AND_CASH_EQUIVALENTS" } });
      await db.cashFlowMapping.create({ data: { companyId: coA, prefix: "1102", activity: "OPERATING", lineId: await cfLine("CF-OP-WC-RECEIVABLES") } });
      await db.cashFlowMapping.create({ data: { companyId: coA, prefix: "1201", activity: "OPERATING", lineId: await cfLine("CF-OP-WC-INVENTORY") } });
      await db.cashFlowMapping.create({ data: { companyId: coA, prefix: "1591", activity: "NON_CASH" } });
      await db.cashFlowMapping.create({ data: { companyId: coA, prefix: "2101", activity: "OPERATING", lineId: await cfLine("CF-OP-WC-PAYABLES") } });
      await db.cashFlowMapping.create({ data: { companyId: coA, prefix: "5201", activity: "OPERATING", lineId: await cfLine("CF-OP-ADJ-DEPRECIATION") } });
      await db.cashFlowMapping.create({ data: { companyId: coA, prefix: "2301", activity: "FINANCING", lineId: await cfLine("CF-FIN-EQUITY-ISSUE") } });
      await db.cashFlowMapping.create({ data: { companyId: coA, prefix: "11", activity: "OPERATING", lineId: await cfLine("CF-OP-WC-OTHER") } });
      await db.cashFlowAccountOverride.create({ data: { companyId: coA, accountCode: "1109", activity: "INVESTING", lineId: await cfLine("CF-INV-OTHER") } });
      void coB;
      // خريطة ب: النقد والرأسمال فقط — 1102 و 2399 غير مربوطين عمدًا (C5/E2)
      await db.cashFlowMapping.create({ data: { companyId: coB, prefix: "1101", activity: "CASH_AND_CASH_EQUIVALENTS" } });
      await db.cashFlowMapping.create({ data: { companyId: coB, prefix: "2301", activity: "FINANCING", lineId: await cfLine("CF-FIN-EQUITY-ISSUE") } });
      expect(!!fyA && !!fyB, "سنتان جاهزتان");
    });

    async function commitSet(companyId: string, fyId: string, from: string, to: string, lines: ReturnType<typeof line>) {
      void lines; void from; void to; void companyId; void fyId;
    }
    void commitSet;

    await check("G1 بذر أ (يناير/فبراير/مارس تراكمي متوازن — لا صفوف صفرية) + اعتماد", async () => {
      const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const months = [
        { from: "2026-01-01", to: "2026-01-31", rows: [line("1101", 100, 0), line("1102", 40, 0), line("1201", 20, 0), line("1109", 5, 0), line("1591", 0, 10), line("2101", 0, 30), line("2301", 0, 30), line("2302", 0, 5), line("4101", 0, 100), line("5201", 10, 0)] },
        { from: "2026-02-01", to: "2026-02-28", rows: [line("1101", 185, 0), line("1102", 50, 0), line("1201", 25, 0), line("1109", 10, 0), line("1591", 0, 30), line("2101", 0, 60), line("2301", 0, 30), line("2302", 0, 5), line("4101", 0, 180), line("5201", 35, 0)] },
        { from: "2026-03-01", to: "2026-03-31", rows: [line("1101", 330, 0), line("1102", 60, 0), line("1201", 25, 0), line("1109", 15, 0), line("1591", 0, 50), line("2101", 0, 95), line("2301", 0, 30), line("2302", 0, 5), line("4101", 0, 300), line("5201", 50, 0)] },
      ];
      for (const m of months) {
        const debit = m.rows.reduce((s, l) => s + l.debit, 0);
        const credit = m.rows.reduce((s, l) => s + l.credit, 0);
        expect(debit === credit, `توازن ${m.from}: مدين ${debit} = دائن ${credit}`);
        const created = await createTrialBalance({ user: admin, ip: null, input: { companyId: coA, fiscalYearId: fyA, fromDate: m.from, toDate: m.to, dataType: "CUMULATIVE_YTD", reason: "بوابة 6.4", lines: m.rows } });
        const committed = await commitTrialBalance({ user: admin, ip: null, id: created.import.id, input: { version: 1 } });
        if (m.from.startsWith("2026-03")) marchImportId = committed.id;
      }
      expect(!!marchImportId, "استيراد مارس معتمد");
    });

    await check("E5-a قبل المراجعة: القيم من أحدث معتمد (الربح 160 والنقد 100→330)", async () => {
      const { getEquityStatement } = await import("../src/lib/equity-server");
      const { getCashFlowStatement } = await import("../src/lib/cashflow-server");
      const eq = await getEquityStatement(admin, { companyId: coA, fiscalYearId: fyA, startOrdinal: 2, endOrdinal: 3 });
      expect(eq.profitOrLossForPeriod.valueMinor === "16000" && eq.status === "OK", `الربح للمدى = 160 (minor ${eq.profitOrLossForPeriod.valueMinor}) وحالة ${eq.status}`);
      const cf = await getCashFlowStatement(admin, { companyId: coA, fiscalYearId: fyA, startOrdinal: 2, endOrdinal: 3 });
      expect(cf.cashOpeningMinor === "10000" && cf.cashClosingMinor === "33000", `نقد افتتاحي 100 وإقفالي 330 (minor: ${cf.cashOpeningMinor}/${cf.cashClosingMinor})`);
      expect(cf.startingMeasure.valueMinor === "16000", "بادئ القياس = صافي الربح 160");
      expect(cf.netChangeMinor === "23000" && cf.reconciled === true && cf.reconciliationDifferenceMinor === "0", `صافي الأقسام 230 = Δنقد (فرق ${cf.reconciliationDifferenceMinor})`);
    });

    await check("E1 المعادلة لكل مفهوم: افتتاحي+حركة=إقفالي + الإجمالي reconciled", async () => {
      const { getEquityStatement } = await import("../src/lib/equity-server");
      const eq = await getEquityStatement(admin, { companyId: coA, fiscalYearId: fyA, startOrdinal: 2, endOrdinal: 3 });
      expect(eq.rows.length >= 2, "صفان على الأقل (رأسمال + حقوق أخرى)");
      for (const row of eq.rows) {
        expect(row.openingStatus === "OK" && row.closingStatus === "OK" && row.movementStatus === "OK", `حالات ${row.componentCode} سليمة`);
        expect(BigInt(row.openingMinor!) + BigInt(row.movementMinor!) === BigInt(row.closingMinor!), `معادلة ${row.componentCode}: ${row.openingMinor}+${row.movementMinor}=${row.closingMinor}`);
      }
      expect(eq.totals.reconciled === true, "الإجمالي: افتتاحي+حركات=إقفالي");
      const cap = eq.rows.find((r) => r.componentCode === "SHARE_CAPITAL")!;
      expect(cap.openingMinor === "3000" && cap.closingMinor === "3000" && cap.movementMinor === "0", "رأسمال: رصيد دائن 30 معروضًا موجبًا (6.9R إشارة العرض) بلا حركة في المدى");
    });

    await check("C1+C2 الحل والإشارات: تجاوز 1109 يفوز على بادئة 11 + إشارات مركزية صحيحة", async () => {
      const { getCashFlowStatement } = await import("../src/lib/cashflow-server");
      const cf = await getCashFlowStatement(admin, { companyId: coA, fiscalYearId: fyA, startOrdinal: 2, endOrdinal: 3 });
      const wcReceivables = cf.operating.lines.find((l) => l.lineCode === "CF-OP-WC-RECEIVABLES")!;
      expect(wcReceivables.effectMinor === "-2000", `زيادة أصل (مدينون +20) ⇒ خارج −20 (minor ${wcReceivables.effectMinor})`);
      const wcPayables = cf.operating.lines.find((l) => l.lineCode === "CF-OP-WC-PAYABLES")!;
      expect(wcPayables.effectMinor === "6500", `زيادة التزام (دائنون +65) ⇒ داخل +65 (minor ${wcPayables.effectMinor})`);
      const wcInventory = cf.operating.lines.find((l) => l.lineCode === "CF-OP-WC-INVENTORY")!;
      expect(wcInventory.effectMinor === "-500", `زيادة مخزون +5 ⇒ خارج −5 (minor ${wcInventory.effectMinor})`);
      const dep = cf.operating.lines.find((l) => l.lineCode === "CF-OP-ADJ-DEPRECIATION")!;
      expect(dep.effectMinor === "4000", `إهلاك المدى (تسوية غير نقدية) ⇒ +40 بلا جمع مزدوج (minor ${dep.effectMinor})`);
      const inv = cf.investing.lines.find((l) => l.lineCode === "CF-INV-OTHER")!;
      expect(inv.effectMinor === "-1000" && inv.accounts.length === 1 && inv.accounts[0]!.accountCode === "1109", "تجاوز 1109 يفوز على بادئة 11 ⇒ استثمارية −10");
      expect(cf.investing.netMinor === "-1000", `صافي الاستثمارية −10 (minor ${cf.investing.netMinor})`);
      expect(cf.financing.netMinor === "0" && cf.financing.lines.every((l) => l.effectMinor === "0"), "التمويلية صفر (رأسمال بلا حركة)");
      expect(cf.operating.netMinor === "24000", `صافي التشغيلية = 160+40−20−5+65 = 240 (minor ${cf.operating.netMinor})`);
    });

    await check("C3 لا جمع تراكمي مزدوج + بداية بلا افتتاحي ⇒ INCOMPLETE_DATA بلا اختراع", async () => {
      const { getCashFlowStatement } = await import("../src/lib/cashflow-server");
      const cf = await getCashFlowStatement(admin, { companyId: coA, fiscalYearId: fyA, startOrdinal: 1, endOrdinal: 3 });
      expect(cf.cashOpeningStatus === "INCOMPLETE_DATA" && cf.cashOpeningMinor === null, "لا رصيد افتتاحي محفوظ لما قبل فترة 1 — لا اختراع");
      expect(cf.status === "INCOMPLETE_DATA" && cf.reconciled === null, "القائمة INCOMPLETE_DATA ولا حسم للمطابقة دون افتتاحي");
      // حركة [2..3] من تراكمي متتالٍ: الإهلاك 50−10=40 وليس 90 ولا 50
      const cf23 = await getCashFlowStatement(admin, { companyId: coA, fiscalYearId: fyA, startOrdinal: 2, endOrdinal: 3 });
      const dep = cf23.operating.lines.find((l) => l.lineCode === "CF-OP-ADJ-DEPRECIATION")!;
      expect(dep.effectMinor === "4000", `حركة المدى من تراكمي متتالٍ: 50−10=40 (minor ${dep.effectMinor})`);
    });

    await check("C6 NON_CASH: 1591 (متراكم الإهلاك) خارج التدفقات — إفصاح منفصل", async () => {
      const { getCashFlowStatement } = await import("../src/lib/cashflow-server");
      const cf = await getCashFlowStatement(admin, { companyId: coA, fiscalYearId: fyA, startOrdinal: 2, endOrdinal: 3 });
      const allSectionLines = [...cf.operating.lines, ...cf.investing.lines, ...cf.financing.lines];
      expect(!allSectionLines.some((l) => JSON.stringify(l.accounts).includes("1591")), "1591 لا يظهر في أي قسم تدفق");
      expect(cf.nonCashDisclosure.some((l) => l.accounts.some((a) => a.accountCode === "1591")), "1591 في منطقة الإفصاح غير النقدي");
      expect(cf.unclassifiedAccounts.every((u) => u.note.includes("بلا حركة")), "لا حسابات غير مصنفة ذات حركة في شركة أ (الثوابت بلا حركة تُوثق فقط)");
    });

    await check("E2+E3+C5+C7 شركة ب (يوليو): فجوة معلنة + سنة غير تقويمية + عزل", async () => {
      const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const jul = [line("1101", 50, 0), line("1102", 5, 0), line("2301", 0, 50), line("2399", 0, 5), line("4101", 0, 60), line("5201", 60, 0)];
      const aug = [line("1101", 80, 0), line("1102", 20, 0), line("2301", 0, 50), line("2399", 0, 15), line("4101", 0, 115), line("5201", 80, 0)];
      for (const [i, s] of [jul, aug].entries()) {
        const debit = s.reduce((x, l) => x + l.debit, 0);
        const credit = s.reduce((x, l) => x + l.credit, 0);
        expect(debit === credit, `توازن ب شهر ${i + 1}: ${debit}=${credit}`);
        const created = await createTrialBalance({ user: admin, ip: null, input: { companyId: coB, fiscalYearId: fyB, fromDate: i === 0 ? "2027-07-01" : "2027-08-01", toDate: i === 0 ? "2027-07-31" : "2027-08-31", dataType: "CUMULATIVE_YTD", reason: "بوابة 6.4 ب", lines: s } });
        await commitTrialBalance({ user: admin, ip: null, id: created.import.id, input: { version: 1 } });
      }
      const { getEquityStatement } = await import("../src/lib/equity-server");
      const { getCashFlowStatement } = await import("../src/lib/cashflow-server");
      // E3: سنة غير تقويمية تعمل
      const eqB = await getEquityStatement(admin, { companyId: coB, fiscalYearId: fyB, startOrdinal: 2, endOrdinal: 2 });
      expect(eqB.fiscalYear.code === "FY27/28" && eqB.range.startOrdinal === 2 && eqB.range.endOrdinal === 2, "مدى أغسطس في سنة يوليو");
      // E2: 2399 حقوق ملكية غير مربوطة بحركة 10 ⇒ INCOMPLETE_DATA مع قائمة صريحة (معروضة موجبة — 6.9R)
      expect(eqB.status === "INCOMPLETE_DATA" && eqB.unmappedAccounts.some((u) => u.accountCode === "2399" && u.movementMinor === "1000"), `3999 فجوة معلنة معروضة موجبة (unmapped: ${JSON.stringify(eqB.unmappedAccounts)})`);
      expect(eqB.rows.find((r) => r.componentCode === "SHARE_CAPITAL")!.movementMinor === "0", "المربوط (رأسمال) بلا حركة");
      // C5: مدينون غير مربوط بحركة 15 ⇒ قائمة صريحة منسّقة بعملة (لا أرقام خام — 6.9R) + الفرق يعرض ولا يُخفى
      const cfB = await getCashFlowStatement(admin, { companyId: coB, fiscalYearId: fyB, startOrdinal: 2, endOrdinal: 2 });
      expect(cfB.status === "INCOMPLETE_DATA" && cfB.unclassifiedAccounts.some((u) => u.accountCode === "1102" && u.note.includes("15.00") && !/-?\d{7,}/.test(u.note)), `1102 غير مربوط بحركة 15 ⇒ INCOMPLETE_DATA + قائمة منسّقة (${cfB.unclassifiedAccounts.map((u) => u.note).join(" | ")})`);
      expect(cfB.reconciled === false && cfB.reconciliationDifferenceMinor !== "0" && cfB.reconciliationDifferenceMinor !== null, `الفرق يُعرض ولا يُخفى (diff ${cfB.reconciliationDifferenceMinor})`);
      expect(cfB.startingMeasure.valueMinor === "3500", `بادئ القياس ب = إيراد 55 − إهلاك 20 = 35 (minor ${cfB.startingMeasure.valueMinor})`);
      // C7: عزل fail-closed
      let denied = 0;
      try { await getEquityStatement(limited, { companyId: coA, fiscalYearId: fyA, startOrdinal: 2, endOrdinal: 3 }); } catch (e) { denied++; }
      try { await getCashFlowStatement(limited, { companyId: coA, fiscalYearId: fyA, startOrdinal: 2, endOrdinal: 3 }); } catch (e) { denied++; }
      try { await getEquityStatement(limited, { companyId: coB, fiscalYearId: fyB, startOrdinal: 2, endOrdinal: 2 }); } catch (e) { denied++; }
      expect(denied === 3, `ثلاث محاولات عابرة للشركات رُفضت كلها (${denied}/3)`);
    });

    await check("E5-b مراجعة 6.3 تحرك القيم: بعد اعتماد مراجعة مارس ⇒ الربح 265 والنقد 100→430", async () => {
      const { createTrialBalanceRevision, createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const draft = (await createTrialBalanceRevision({ user: admin, ip: null, id: marchImportId, input: { reason: "تصحيح إيراد ونقد مارس (بوابة 6.4)" } })) as { id: string; revisionNumber: number };
      expect(draft.revisionNumber === 2, "مراجعة #2 لمارس");
      const rev2 = [line("1101", 430, 0), line("1102", 60, 0), line("1201", 25, 0), line("1109", 15, 0), line("1591", 0, 50), line("2101", 0, 95), line("2301", 0, 30), line("2302", 0, 5), line("4101", 0, 400), line("5201", 50, 0)];
      const debit = rev2.reduce((s, l) => s + l.debit, 0);
      const credit = rev2.reduce((s, l) => s + l.credit, 0);
      expect(debit === credit, `توازن rev2: ${debit}=${credit}`);
      await createTrialBalance({ user: admin, ip: null, input: { revisionTargetId: draft.id, version: 1, fromDate: "2026-03-01", toDate: "2026-03-31", dataType: "CUMULATIVE_YTD", reason: "رفع المصحح", lines: rev2 } });
      const committed = (await commitTrialBalance({ user: admin, ip: null, id: draft.id, input: { version: 2, reason: "اعتماد مراجعة مارس المصححة" } })) as { id: string; revisionNumber: number };
      rev2Id = committed.id;
      const { getEquityStatement } = await import("../src/lib/equity-server");
      const { getCashFlowStatement } = await import("../src/lib/cashflow-server");
      const eq = await getEquityStatement(admin, { companyId: coA, fiscalYearId: fyA, startOrdinal: 2, endOrdinal: 3 });
      expect(eq.profitOrLossForPeriod.valueMinor === "26000", `بعد المراجعة: الربح 260 (minor ${eq.profitOrLossForPeriod.valueMinor}) — أحدث معتمد حصرًا`);
      const cf = await getCashFlowStatement(admin, { companyId: coA, fiscalYearId: fyA, startOrdinal: 2, endOrdinal: 3 });
      expect(cf.cashClosingMinor === "43000" && cf.netChangeMinor === "33000" && cf.reconciled === true, `بعد المراجعة: نقد إقفالي 430 وصافي الأقسام 330 والمطابقة متحققة (diff ${cf.reconciliationDifferenceMinor})`);
      expect(cf.provenance.imports.some((p) => p.importId === rev2Id && p.revisionNumber === 2), "provenance يثبت أن مارس أصبح المراجعة #2");
    });

    void limited;
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
