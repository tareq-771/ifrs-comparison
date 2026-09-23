// Phase 6.7 — بوابة إثبات واجهة الاستخدام والتكامل والحوكمة.
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-67-gate.db bun scripts/phase67-ui-governance.ts
// (يُنشأ dev-67-gate.db من migrations حصرًا: bunx prisma migrate deploy)
//
// الفحوصات (تعليمات 6.7-T) على قاعدة معزولة من migrations حصرًا — لا لمس custom.db إطلاقًا:
//   T2  مسارات الملاحة موجودة فعليًا (ملفات صفحات/مكونات + تصدير الدوال)
//   T3  company scoping — مستخدم محدود النطاق لا يرى غير شركاته
//   T4  أطول بادئة مطابقة تفوز (110101 ⇒ 1101 وليس 11 أو 1)
//   T5  أولوية تجاوز الحساب فوق البادئات
//   T6  الحسابات غير المصنفة ظاهرة (NEEDS_CLASSIFICATION حالة معلنة لا OTHER صامت)
//   T7  CUMULATIVE_YTD لا يُجمع مرتين (100/220/300 ⇒ YTD مارس=300، حركة مارس=80)
//   T8  PERIOD_MOVEMENT يُجمع صحيحًا
//   T9  سنة مالية غير تقويمية (تبدأ أبريل) — محاذاة الفترات صحيحة
//   T10 المعتمد لا يُكتب فوقه (DUPLICATE_COMMITTED)
//   T11 مسار المراجعات: revision ⇒ استبدال سطور المسودة ⇒ اعتماد
//   T12 عقد بيانات SOCIE (opening/movement/closing + reconciled)
//   T13 فرق مطابقة التدفقات معروض في العقد (حتى لو =0)
//   T14 الموازنة LOCKED غير قابلة للتعديل (INVALID_STATE)
//   T15 ف/غ: إيراد فعلي>موازنة مواتٍ، مصروف فعلي<موازنة مواتٍ
//   T16 عضو بلا بيانات ⇒ INCOMPLETE_DATA (لا صفر صامت)
//   T17 علامة preliminary ظاهرة في نتيجة التوحيد
//   T18 لا فقد دقة BigInt (9007199254740993 minor يتجاوز 2^53)
//   T19 رفض الوصول لشركة غير مصرح بها (fail-closed)
//   T20 كل المسارات المستخدمة في الملاحة تعرض الدوال المتوقعة (فحص ملفات)
//
// الانحدار 62A→66 يُشغَّل منفصلًا على قواعده المعزولة.

import { readFileSync } from "node:fs";

import type { SessionUser } from "../src/lib/session";
import { resolveAccountMapping } from "../src/lib/account-nature";
import { decimalToMinor } from "../src/lib/trial-balance";
import {
  flowYTDFromPoints, flowMonthMovementFromPoints, balanceAsOfFromPoints,
} from "../src/lib/trial-balance-data";
import { favorabilityFor } from "../src/lib/budget";
import {
  listTrialBalances, createTrialBalance, commitTrialBalance, createTrialBalanceRevision,
  replaceRevisionDraftLines, getTrialBalance,
} from "../src/lib/trial-balance-server";
import { getEquityStatement } from "../src/lib/equity-server";
import { getCashFlowStatement } from "../src/lib/cashflow-server";
import { getBudgetVariance, createBudget, transitionBudget, updateBudgetLines } from "../src/lib/budget-server";
import { getConsolidatedStatements, listConsolidationGroups, createConsolidationGroup } from "../src/lib/consolidation-server";

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
    id: "gate-user-67",
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
    const src = readFileSync(path, "utf8");
    return src.includes(needle);
  } catch {
    return false;
  }
}

async function main() {
  console.log("═══ بوابة Phase 6.7 — واجهة الاستخدام والتكامل والحوكمة ══");
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-67"), "الأداة تعمل على dev-67-gate.db حصرًا (عزل صارم)");

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ log: [], datasources: { db: { url: url! } } });

  const admin = syntheticUser();
  const limited = syntheticUser({ role: "user", viewAllCompanies: false, companyIds: [], username: "gate-limited" });

  let coA = ""; let coB = ""; let fyA = ""; let committedTbA = "";

  await check("T2/T20 ملفات الملاحة والصفحات موجعة وتصدر المتوقع", () => {
    const checks: Array<[string, string]> = [
      ["src/app/page.tsx", "نظام التقارير المالية الموحدة"],
      ["src/app/page.tsx", "StatementsView"],
      ["src/app/page.tsx", "BudgetView"],
      ["src/app/page.tsx", "ConsolidationView"],
      ["src/app/page.tsx", "TrialBalanceTab"],
      ["src/app/page.tsx", "CompareWorkspace"],
      ["src/app/page.tsx", "DashboardView"],
      ["src/app/admin/page.tsx", "FoundationTab"],
      ["src/app/admin/page.tsx", "AccountNatureTab"],
      ["src/components/reporting/dashboard-view.tsx", "export function DashboardView"],
      ["src/components/reporting/statements-view.tsx", "export function StatementsView"],
      ["src/components/reporting/budget-view.tsx", "export function BudgetView"],
      ["src/components/reporting/consolidation-view.tsx", "export function ConsolidationView"],
      ["src/components/compare/compare-workspace.tsx", "export function CompareWorkspace"],
      ["src/components/admin/trial-balance-tab.tsx", "export function TrialBalanceTab"],
      ["src/components/admin/account-nature-tab.tsx", "export function AccountNatureTab"],
      ["src/app/api/consolidation/groups/route.ts", "export async function GET"],
      ["src/app/api/consolidation/groups/route.ts", "export async function POST"],
      ["src/app/api/consolidation/groups/[id]/route.ts", "export async function GET"],
      ["src/app/api/consolidation/groups/[id]/members/route.ts", "export async function POST"],
      ["src/app/api/consolidation/groups/[id]/members/[membershipId]/route.ts", "export async function DELETE"],
      ["src/app/api/consolidation/adjustments/route.ts", "export async function GET"],
      ["src/app/api/consolidation/adjustments/route.ts", "export async function POST"],
      ["src/app/api/reports/actual/statements/route.ts", "export async function POST"],
      ["src/app/api/reports/actual/equity/route.ts", "export async function POST"],
      ["src/app/api/reports/actual/cashflow/route.ts", "export async function POST"],
      ["src/app/api/budgets/route.ts", "export async function GET"],
      ["src/app/api/budgets/variance/route.ts", "export async function POST"],
      ["src/app/api/trial-balances/route.ts", "export async function GET"],
      ["src/app/api/trial-balances/[id]/revision/route.ts", "export async function POST"],
      ["src/app/api/account-nature/rules/route.ts", "export async function GET"],
      ["src/lib/money.ts", "export function formatMinor"],
      ["src/proxy.ts", "manageAccountNature"],
    ];
    for (const [p, needle] of checks) {
      expect(fileExports(p, needle), `الملف ${p} لا يحتوي «${needle}»`);
    }
  });

  await check("T4/T5 أطول بادئة + أولوية التجاوز (حل مركزي)", () => {
    const mk = (prefix: string, companyId: string | null, classification: string, behavior: string) => ({
      id: `r-${prefix}-${companyId ?? "sys"}`, companyId, prefix, mainCategory: null,
      classification, aggregationBehavior: behavior, statementLineCode: null, source: "MANUAL", isActive: true,
    });
    const systemRoots = [mk("1", null, "ASSET", "BALANCE")];
    const r1 = resolveAccountMapping({ accountCode: "110101", rules: systemRoots, overrides: [] });
    expect(r1.matchedPrefix === "1", "بدون بادئات شركة ⇒ الجذر 1");
    const withCompany = [
      ...systemRoots,
      mk("11", "c1", "ASSET", "BALANCE"),
      mk("1101", "c1", "ASSET", "BALANCE"),
    ];
    const r2 = resolveAccountMapping({ accountCode: "110101", companyId: "c1", rules: withCompany, overrides: [] });
    expect(r2.matchedPrefix === "1101", `الأطول يفوز: 110101 ⇒ 1101 (الناتج ${r2.matchedPrefix})`);
    const r3 = resolveAccountMapping({
      accountCode: "110101", companyId: "c1", rules: withCompany,
      overrides: [{ id: "o1", companyId: "c1", accountCode: "110101", classification: "REVENUE", aggregationBehavior: "FLOW", statementLineCode: null, isActive: true }],
    });
    expect(r3.source === "ACCOUNT_OVERRIDE" && r3.classification === "REVENUE", `التجاوز يفوز على كل البادئات (ناتج ${r3.source}/${r3.classification})`);
  });

  await check("T7 CUMULATIVE_YTD بلا جمع مزدوج", () => {
    const points = [
      { startOrdinal: 1, endOrdinal: 1, dataType: "CUMULATIVE_YTD", netMinor: BigInt(10000) },
      { startOrdinal: 1, endOrdinal: 2, dataType: "CUMULATIVE_YTD", netMinor: BigInt(22000) },
      { startOrdinal: 1, endOrdinal: 3, dataType: "CUMULATIVE_YTD", netMinor: BigInt(30000) },
    ];
    expect(flowYTDFromPoints(points, 3) === BigInt(30000), "YTD مارس = 300");
    expect(flowMonthMovementFromPoints(points, 3) === BigInt(8000), "حركة مارس = 80");
    expect(flowMonthMovementFromPoints(points, 1) === BigInt(10000), "حركة يناير = 100");
  });

  await check("T8 PERIOD_MOVEMENT تجميع صحيح", () => {
    const points = [
      { startOrdinal: 1, endOrdinal: 1, dataType: "PERIOD_MOVEMENT", netMinor: BigInt(10000) },
      { startOrdinal: 2, endOrdinal: 2, dataType: "PERIOD_MOVEMENT", netMinor: BigInt(12000) },
      { startOrdinal: 3, endOrdinal: 3, dataType: "PERIOD_MOVEMENT", netMinor: BigInt(8000) },
    ];
    expect(flowYTDFromPoints(points, 3) === BigInt(30000), "YTD = 100+120+80");
    expect(flowMonthMovementFromPoints(points, 2) === BigInt(12000), "حركة فبراير = 120");
  });

  await check("T18 لا فقد دقة BigInt (>2^53)", () => {
    const minor = decimalToMinor("90071992547409.93", 2, "اختبار");
    expect(minor === BigInt("9007199254740993"), `التحويل الدقيق: ${minor}`);
    // فحص الجمع على الحد نفسه
    expect(minor + BigInt(1) === BigInt("9007199254740994"), "جمع صحيح فوق 2^53");
    // نقطة بيانات وأرصدة
    expect(balanceAsOfFromPoints([{ startOrdinal: 1, endOrdinal: 1, dataType: "PERIOD_MOVEMENT", netMinor: BigInt("9007199254740993") }], 1) === BigInt("9007199254740993"), "رصيد as-of دقيق");
  });

  await check("T15 ف/غ — القاعدة المركزية", () => {
    expect(favorabilityFor("REVENUE", BigInt(120), BigInt(100)) === "FAVORABLE", "إيراد فعلي>موازنة ⇒ مواتٍ");
    expect(favorabilityFor("REVENUE", BigInt(90), BigInt(100)) === "UNFAVORABLE", "إيراد أقل ⇒ غير مواتٍ");
    expect(favorabilityFor("EXPENSE", BigInt(80), BigInt(100)) === "FAVORABLE", "مصروف أقل ⇒ مواتٍ");
    expect(favorabilityFor("EXPENSE", BigInt(120), BigInt(100)) === "UNFAVORABLE", "مصروف أعلى ⇒ غير مواتٍ");
    expect(favorabilityFor("OTHER", BigInt(10), BigInt(5)) === "NO_FAVORABLE_UNFAVORABLE", "ميزانية المراكز ⇒ بلا ف/غ");
  });

  await check("T9 سنة مالية غير تقويمية — محاذاة الفترات", async () => {
    const { resolveFiscalContext } = await import("../src/lib/trial-balance");
    const fy = { id: "fy67x", code: "FY26-27", displayNameAr: "غير تقويمية", startDate: "2026-04-01", endDate: "2027-03-31", status: "OPEN" };
    const periods = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 3 + i, 1));
      const end = new Date(Date.UTC(2026, 4 + i, 0));
      const iso = (x: Date) => x.toISOString().slice(0, 10);
      return { id: `p${i + 1}`, ordinal: i + 1, code: `P${i + 1}`, startDate: iso(d), endDate: iso(end), status: "OPEN", displayLabel: `شهر ${i + 1}` };
    });
    const ctx = resolveFiscalContext(fy, periods, "2026-06-01", "2026-06-30");
    expect(ctx.startPeriod.ordinal === 3 && ctx.endPeriod.ordinal === 3, `يونيو 2026 ⇒ الفترة 3 (ناتج ${ctx.startPeriod.ordinal})`);
  });

  // ── تهيئة قاعدة البيانات: شركتان + قواعد تصنيف + سنة + ميزان معتمد للشركة أ ──
  await check("G0 تهيئة: شركتان + قواعد + سنة + ميزان معتمد", async () => {
    const a = await db.company.create({ data: { code: "UI-A", nameAr: "شركة الواجهة أ" } });
    const b = await db.company.create({ data: { code: "UI-B", nameAr: "شركة الواجهة ب" } });
    coA = a.id; coB = b.id;
    for (const [prefix, classification, behavior, lineCode] of [
      ["1101", "ASSET", "BALANCE", "SFP-CASH"],
      ["1102", "ASSET", "BALANCE", "SFP-RECEIVABLES"],
      ["2101", "LIABILITY", "BALANCE", "SFP-LIA-CL"],
      ["3101", "EQUITY", "BALANCE", "SFP-EQUITY"],
      ["4101", "REVENUE", "FLOW", "PNL-REVENUE"],
      ["5201", "EXPENSE", "FLOW", "PNL-ADMIN-EXPENSES"],
    ] as const) {
      const sl = await db.financialStatementLine.findUniqueOrThrow({ where: { code: lineCode } });
      await db.accountNatureRule.create({ data: { companyId: coA, prefix, classification, aggregationBehavior: behavior, source: "MANUAL", statementLineId: sl.id } });
    }
    // الشركة ب: بادئة واحدة فقط (لإثبات NEEDS_CLASSIFICATION)
    const slCash = await db.financialStatementLine.findUniqueOrThrow({ where: { code: "SFP-CASH" } });
    await db.accountNatureRule.create({ data: { companyId: coB, prefix: "101", classification: "ASSET", aggregationBehavior: "BALANCE", source: "MANUAL", statementLineId: slCash.id } });
    const fy = await db.fiscalYear.create({ data: { companyId: coA, code: "FY2026-A", startDate: "2026-01-01", endDate: "2026-12-31", periodCount: 12 } });
    fyA = fy.id;
    for (let i = 0; i < 12; i++) {
      const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
      const mm = String(i + 1).padStart(2, "0");
      await db.fiscalPeriod.create({ data: { fiscalYearId: fy.id, ordinal: i + 1, code: `2026-${mm}`, startDate: `2026-${mm}-01`, endDate: `2026-${mm}-${last}`, displayLabel: `شهر ${i + 1}` } });
    }
    // سنة وفترات الشركة ب (للتوحيد والمعاينة)
    const fyB = await db.fiscalYear.create({ data: { companyId: coB, code: "FY2026-B", startDate: "2026-01-01", endDate: "2026-12-31", periodCount: 12 } });
    for (let i = 0; i < 12; i++) {
      const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
      const mm = String(i + 1).padStart(2, "0");
      await db.fiscalPeriod.create({ data: { fiscalYearId: fyB.id, ordinal: i + 1, code: `2026-${mm}`, startDate: `2026-${mm}-01`, endDate: `2026-${mm}-${last}`, displayLabel: `شهر ${i + 1}` } });
    }
    // خريطة مفاهيم حقوق الملكية للشركة أ (أطول بادئة تفوز — عقد 6.4)
    await db.equityComponentMapping.create({ data: { companyId: coA, prefix: "31", componentCode: "SHARE_CAPITAL" } });
    const created = await createTrialBalance({
      user: admin, ip: "gate",
      input: {
        companyId: coA, fiscalYearId: fy.id, fromDate: "2026-01-01", toDate: "2026-03-31",
        dataType: "CUMULATIVE_YTD", reason: "بوابة 6.7",
        lines: [
          line("110101", 5000, 0, "نقدية"),
          line("110201", 2000, 0, "مدينون"),
          line("210101", 0, 1500, "دائنون"),
          line("310101", 0, 3500, "رأس المال"),
          line("410101", 0, 3000, "مبيعات"),
          line("520101", 1000, 0, "رواتب"),
        ],
      },
    });
    committedTbA = created.import.id;
    const committed = await commitTrialBalance({ user: admin, ip: "gate", id: committedTbA, input: { version: created.import.version, reason: "بوابة" } });
    expect(committed.status === "COMMITTED", "اعتماد الميزان");
  });

  await check("T10 المعتمد لا يُكتب فوقه", async () => {
    let code = "";
    try {
      await createTrialBalance({
        user: admin, ip: "gate",
        input: {
          companyId: coA, fiscalYearId: fyA, fromDate: "2026-01-01", toDate: "2026-03-31",
          dataType: "CUMULATIVE_YTD", reason: "محاولة overwrite",
          lines: [line("110101", 1, 0)],
        },
      });
    } catch (e) {
      code = (e as { code?: string }).code ?? (e instanceof Error ? e.message : String(e));
    }
    expect(code === "DUPLICATE_COMMITTED" || code === "DUPLICATE_IMPORT", `يُرفض بصمت فوق المعتمد (الناتج: ${code})`);
    // المعتمد ما زال سليمًا واحدًا لنفس المدى/النوع
    const list = await listTrialBalances(admin);
    const committedSameRange = list.filter((r) => r.companyId === coA && r.status === "COMMITTED" && r.dataType === "CUMULATIVE_YTD");
    expect(committedSameRange.length === 1, "المعتمد الأصلي لم يُستبدل");
  });

  await check("T3 company scoping — قوائم الميزانيات حسب النطاق", async () => {
    const all = await listTrialBalances(admin);
    expect(all.some((r) => r.companyId === coA), "المدير يرى شركة أ");
    const scoped = await listTrialBalances({ ...limited, permissions: { ...limited.permissions, companyIds: [coB] } });
    expect(scoped.every((r) => r.companyId !== coA), "المحدود لا يرى شركة أ نهائيًا (fail-closed)");
  });

  await check("T6 الحسابات غير المصنفة ظاهرة في المعاينة", async () => {
    // الشركة ب: حساب 999999 بلا أي تصنيف
    const fyB = await db.fiscalYear.findFirstOrThrow({ where: { companyId: coB } });
    const p1B = await db.fiscalPeriod.findFirstOrThrow({ where: { fiscalYearId: fyB.id, ordinal: 1 } });
    const preview = await import("../src/lib/trial-balance-server").then((m) =>
      m.previewTrialBalance({
        user: admin,
        input: {
          companyId: coB,
          fiscalYearId: fyB.id,
          fromDate: p1B.startDate,
          toDate: p1B.endDate,
          dataType: "CUMULATIVE_YTD",
          lines: [line("101001", 100, 0, "صندوق"), line("999999", 0, 100, "حساب غامض")],
        },
      }));
    expect(preview.mapping.needsClassification >= 1, `حساب غامض ⇒ needsClassification ≥ 1 (ناتج ${preview.mapping.needsClassification})`);
    expect(preview.mapping.incompleteAccounts.some((a) => a.accountCode === "999999"), "الحساب الغامض مُدرج بالاسم");
  });

  await check("T11 مسار المراجعات كاملًا", async () => {
    const rev = await createTrialBalanceRevision({ user: admin, ip: "gate", id: committedTbA, input: { reason: "تصحيح مبلغ" } });
    expect(rev.revisionNumber === 2 && rev.supersedesImportId === committedTbA, "مراجعة #2 تحل محل الأولى");
    const replaced = await replaceRevisionDraftLines({
      user: admin, ip: "gate", id: rev.id,
      input: {
        version: rev.version, dataType: "CUMULATIVE_YTD",
        fromDate: "2026-01-01", toDate: "2026-03-31",
        reason: "رفع ملف مصحح", lines: [line("110101", 5000, 0, "نقدية"), line("410101", 0, 3000, "مبيعات"), line("310101", 0, 2000, "رأس مال")],
      },
    });
    expect(replaced.import.lineCount === 3, `استبدال سطور المسودة من الواجهة (ناتج ${replaced.import.lineCount})`);
    const recommitted = await commitTrialBalance({ user: admin, ip: "gate", id: rev.id, input: { version: replaced.import.version, reason: "اعتماد المراجعة" } });
    expect(recommitted.status === "COMMITTED" && recommitted.revisionNumber === 2, "اعتماد المراجعة");
  });

  await check("T12 عقد بيانات SOCIE", async () => {
    const equity = await getEquityStatement(admin, { companyId: coA, fiscalYearId: fyA, startOrdinal: 1, endOrdinal: 3 });
    expect(Array.isArray(equity.rows) && equity.rows.length > 0, "صفوف المكونات موجودة");
    for (const row of equity.rows) {
      expect("openingMinor" in row && "movementMinor" in row && "closingMinor" in row, "opening/movement/closing في العقد");
    }
    expect(equity.totals.reconciled === null || typeof equity.totals.reconciled === "boolean", "reconciled منطقي (أو null معلن عند نقص الإجماليات)");
  });

  await check("T13 فرق مطابقة التدفقات في العقد", async () => {
    const cf = await getCashFlowStatement(admin, { companyId: coA, fiscalYearId: fyA, startOrdinal: 1, endOrdinal: 3 });
    expect("reconciliationDifferenceMinor" in cf, "reconciliationDifferenceMinor معلن دائمًا");
    expect(cf.reconciliationDifferenceMinor === null || typeof cf.reconciliationDifferenceMinor === "string", "الفرق نص minor (أو غير متاح)");
    expect("cashOpeningMinor" in cf && "cashClosingMinor" in cf && "netChangeMinor" in cf, "opening/closing/netChange في العقد");
  });

  // ── موازنة + فعلي مقابل موازنة ──
  let budgetId = "";
  await check("T14 الموازنة LOCKED غير قابلة للتعديل", async () => {
    // بنود موزعة على فترات الربع الأول (فترات 1-3) — تدخل مقارنة QUARTER
    const q1Periods = await db.fiscalPeriod.findMany({ where: { fiscalYearId: fyA, ordinal: { gte: 1, lte: 3 } }, orderBy: { ordinal: "asc" } });
    const amounts = ["66666", "66666", "66668"];
    const b = await createBudget({
      user: admin, ip: "gate",
      input: {
        companyId: coA, fiscalYearId: fyA, budgetType: "MONTHLY", scenario: "BASE",
        startOrdinal: 1, endOrdinal: 3,
        lines: q1Periods.map((p, i) => ({ statementLineCode: "PNL-REVENUE", fiscalPeriodId: p.id, amountMinor: amounts[i] })),
      },
    });
    budgetId = b.id;
    const submitted = await transitionBudget({ user: admin, ip: "gate", id: b.id, input: { action: "SUBMIT", version: b.version, reason: "بوابة" } });
    const approved = await transitionBudget({ user: admin, ip: "gate", id: b.id, input: { action: "APPROVE", version: submitted.version, reason: "بوابة" } });
    const locked = await transitionBudget({ user: admin, ip: "gate", id: b.id, input: { action: "LOCK", version: approved.version, reason: "بوابة" } });
    expect(locked.status === "LOCKED", "وصلت إلى LOCKED");
    let threwCode = "";
    try {
      await updateBudgetLines({ user: admin, ip: "gate", id: b.id, input: { version: locked.version, lines: [{ statementLineCode: "PNL-REVENUE", fiscalPeriodId: null, amountMinor: "1" }] } });
    } catch (e) {
      threwCode = (e as { code?: string }).code ?? (e instanceof Error ? e.message : String(e));
    }
    expect(threwCode === "INVALID_STATE", `تعديل المقفلة مرفوض INVALID_STATE (الناتج: ${threwCode.slice(0, 60)})`);
  });

  await check("T15 فعلي مقابل موازنة — ف/غ من الخدمة", async () => {
    // الربع الأول (فترات 1-3): الفعلي المعتمد يغطيها حصرًا
    const v = await getBudgetVariance(admin, { companyId: coA, fiscalYearId: fyA, granularity: "QUARTER", ordinal: 1 });
    const revenueRow = v.rows.find((r) => r.statementLineCode === "PNL-REVENUE");
    expect(!!revenueRow, "صف الإيراد موجود");
    // الفعلي 3000.00 > الموازنة 2000.00 (200000 minor) ⇒ مواتٍ للإيراد
    expect(revenueRow!.favorability === "FAVORABLE", `إيراد فعلي أعلى من الموازنة ⇒ FAVORABLE (ناتج ${revenueRow!.favorability}، فعلي ${revenueRow!.actualMinor})`);
    // القاعدة المزدوجة على مستوى الخدمة: مصروف أقل ⇒ مواتٍ (تُغطى القيم في T15 النقية أعلاه)
  });

  // ── التوحيد ──
  let groupId = "";
  await check("T16/T17 توحيد أولي: INCOMPLETE_DATA + preliminary ظاهرة", async () => {
    const g = await createConsolidationGroup({
      user: admin, ip: "gate",
      input: {
        code: "GRP-67", nameAr: "مجموعة بوابة 6.7",
        members: [
          { companyId: coA, effectiveFrom: "2026-01-01", ownershipPercentage: 100 },
          { companyId: coB, effectiveFrom: "2026-01-01", ownershipPercentage: 60 },
        ],
      },
    });
    groupId = g.id;
    const lines = await db.groupReportingLine.findMany({ where: { groupId }, select: { id: true, code: true } });
    expect(lines.length > 0, `بُذرت بنود جماعية (${lines.length})`);
    const mappings = await db.groupReportingMapping.findMany({ where: { groupId } });
    expect(mappings.length >= lines.length * 2, `خرائط الهوية لكل الأعضاء (${mappings.length})`);
    const result = await getConsolidatedStatements(admin, { groupId, startDate: "2026-01-01", endDate: "2026-03-31" });
    expect(result.preliminary === true, "العلامة preliminary: true ظاهرة في العقد");
    expect(result.status === "INCOMPLETE_DATA", `الشركة ب بلا بيانات ⇒ INCOMPLETE_DATA (ناتج ${result.status})`);
    expect(result.completenessNotes.some((n) => n.includes("لا بيانات") || n.includes("INCOMPLETE")), "ملاحظة اكتمال صريحة");
    const revenueRow = result.workingPaper.find((r) => r.groupLineCode === "PNL-REVENUE");
    const aVal = revenueRow?.companyValues.find((cv) => cv.companyId === coA);
    expect(aVal?.valueMinor === "-3000" || aVal?.valueMinor === "-3000.00" || aVal?.valueMinor?.startsWith("-3000"), `قيمة الشركة أ للإيراد قابلة للتتبع (${aVal?.valueMinor})`);
  });

  await check("T19 رفض الوصول لشركة غير مصرح بها (fail-closed)", async () => {
    let threw = "";
    try {
      await getTrialBalance({ ...limited, permissions: { ...limited.permissions, companyIds: [coB] } }, committedTbA);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    expect(threw.length > 0, "جلب ميزان شركة أ بمستخدم لا يراها ⇒ يفشل");
    let groupThrew = "";
    try {
      await listConsolidationGroups({ ...limited, permissions: { ...limited.permissions, companyIds: [coB] } });
    } catch {
      groupThrew = "threw";
    }
    const visible = groupThrew ? [] : await listConsolidationGroups({ ...limited, permissions: { ...limited.permissions, companyIds: [coB] } });
    expect(!visible.some((g) => (g as { id: string }).id === groupId), "المجموعة التي فيها شركة غير مرئية لا تظهر (fail-closed)");
  });

  await check("T3-إضافي مجموعات التوحيد محدودة بالنطاق للمستخدم المحدود", async () => {
    const scoped = await listConsolidationGroups({ ...limited, permissions: { ...limited.permissions, companyIds: [coA] } });
    // المجموعة فيها coA و coB — المستخدم لا يرى coB ⇒ لا يرى المجموعة
    expect(!scoped.some((g) => (g as { id: string }).id === groupId), "لا يرى مجموعة تحتوي شركة خارج نطاقه");
    const adminView = await listConsolidationGroups(admin);
    expect(adminView.some((g) => (g as { id: string }).id === groupId), "المدير يرى المجموعة");
  });

  await db.$disconnect();

  console.log(`\n═══ النتيجة: ${passCount} PASS / ${failCount} FAIL ══`);
  if (failures.length > 0) {
    console.log("الإخفاقات:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("فشل تشغيل البوابة:", e);
  process.exit(1);
});
