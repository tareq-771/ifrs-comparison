// Phase 6.8 — بوابة إثبات التقارير والطباعة والتصدير.
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-68-gate.db bun scripts/phase68-report-print.ts
// (يُنشأ dev-68-gate.db من migrations حصرًا: bunx prisma migrate deploy — عزل صارم عن custom.db)
//
// الفحوصات (تعليمات 6.8-K) — قاعدة معزولة + فحوص نقية + فحص مصدر الواجهات:
//   H1  الترويسة الموحدة تعرض الشركة/السنة/الفترة/العملة الصحيحة (من DTO لا من hard-code)
//   H2  سنة مالية غير تقويمية — تواريخ الفترات تمر كما هي (أبريل→مارس) بلا افتراض تقويمي
//   H3  RTL في الطباعة: منفذ #print-root + dir=rtl + قواعد @media print الموحدة
//   H4  دعم A4 Landscape للتقارير العريضة (AvB + التوحيد) عبر @page size
//   H5  دعم A4 Portrait للقوائم الأقل عرضًا (القوائم الأربع)
//   H6  INCOMPLETE_DATA ظاهرة في الترويسة (شارة + إشعار) لا تُخفى
//   H7  UNCLASSIFIED يبقى نصًا ظاهرًا — لا تحويل إلى رقم صامت (null ⇒ "—" لا 0)
//   H8  علامة التوحيد الأولي PRELIMINARY ظاهرة (خدمة + ترويسة)
//   H9  عضو بلا بيانات ⇒ INCOMPLETE_DATA لا صفر صامت (خدمة + CSV نصي)
//   H10 الاستبعادات عمود منفصل عن أرقام الشركات (عقد DTO + هوية before+adj=consolidated)
//   H11 BigInt > 2^53 يمر دقيقًا عبر مسار التقرير (formatMinor + CSV بلا فقد)
//   H12 قاعدة ف/غ المركزية لم تتغير (إيراد أعلى ⇒ مواتٍ، مصروف أقل ⇒ مواتٍ، أرصدة بلا ف/غ)
//   H13 عزل صلاحيات company scope (fail-closed) لم يتأثر بطبقة العرض
//   H14 أدوات التحكم مخفية في وسيط الطباعة (.no-print + إخفاء كل ما عدا المنفذ)
//   H15 ملفات بوابات الانحدار 62A–6.7 كلها موجودة (تُشغَّل منفصلة على قواعدها)

import { readFileSync } from "node:fs";

import type { SessionUser } from "../src/lib/session";
import { buildReportHeaderMeta } from "../src/lib/report-header";
import { formatMinor } from "../src/lib/money";
import { buildCsv, type ExportColumn } from "../src/lib/report-export";
import { favorabilityFor } from "../src/lib/budget";
import {
  listTrialBalances, createTrialBalance, commitTrialBalance,
} from "../src/lib/trial-balance-server";
import { getConsolidatedStatements, createConsolidationGroup } from "../src/lib/consolidation-server";

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
    id: "gate-user-68",
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

/** فترات سنة غير تقويمية (أبريل 2026 → مارس 2027) — نفس أسلوب بوابة 6.7 T9. */
function nonCalendarPeriods() {
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 3 + i, 1));
    const end = new Date(Date.UTC(2026, 4 + i, 0));
    const iso = (x: Date) => x.toISOString().slice(0, 10);
    return { id: `p${i + 1}`, ordinal: i + 1, code: `P${i + 1}`, startDate: iso(d), endDate: iso(end), status: "OPEN", displayLabel: `شهر ${i + 1}` };
  });
}

async function main() {
  console.log("═══ بوابة Phase 6.8 — التقارير والطباعة والتصدير ══");
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-68"), "الأداة تعمل على dev-68-gate.db حصرًا (عزل صارم)");

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ log: [], datasources: { db: { url: url! } } });

  const admin = syntheticUser();
  const limited = syntheticUser({ role: "user", viewAllCompanies: false, companyIds: [], username: "gate-limited" });

  let coA = ""; let coB = ""; let fyA = "";

  // ── H1: الترويسة الموحدة من مكونات DTO ──
  await check("H1 الترويسة تعرض الشركة/السنة/الفترة/العملة من DTO (بلا hard-code)", () => {
    const meta = buildReportHeaderMeta({
      companyCode: "SHK-99",
      companyName: "شركة الاختبار الصناعية",
      reportTitle: "قائمة المركز المالي",
      fiscalYearCode: "FY26-27",
      fiscalYearLabel: "السنة المالية 2026-2027",
      periodLabel: "حتى نهاية فترة 3 — شهر 3",
      fromDate: "2026-04-01",
      toDate: "2026-06-30",
      currency: "YER",
      dataType: "CUMULATIVE_YTD",
      status: "APPROVED",
      printedAt: new Date("2026-09-24T10:30:00Z"),
    });
    expect(meta.companyLine === "SHK-99 — شركة الاختبار الصناعية", `سطر الشركة: ${meta.companyLine}`);
    expect(meta.fiscalYearCode === "FY26-27" && meta.fiscalYearLabel.includes("2026"), `السنة: ${meta.fiscalYearCode}/${meta.fiscalYearLabel}`);
    expect(meta.periodLine.includes("2026-04-01") && meta.periodLine.includes("2026-06-30"), `سطر الفترة بالتواريخ الفعلية: ${meta.periodLine}`);
    expect(meta.currency === "YER", `العملة من DTO: ${meta.currency}`);
    expect(meta.dataTypeLabel?.includes("CUMULATIVE_YTD"), `نوع البيانات معلن: ${meta.dataTypeLabel}`);
    expect(meta.statusLabel === "معتمد", `الحالة: ${meta.statusLabel}`);
    expect(meta.printedAtLabel.length > 0, "تاريخ ووقت الطباعة ظاهران");
    expect(meta.documentTitle.includes("شركة الاختبار الصناعية"), `عنوان المستند: ${meta.documentTitle}`);
    // بلا قيم ممررة ⇒ شرطات معلنة لا أسماء مختلقة
    const empty = buildReportHeaderMeta({ companyCode: null, companyName: null, reportTitle: "ت", fiscalYearCode: null, status: "DRAFT" });
    expect(empty.companyLine === "— — —" || empty.companyLine.includes("—"), `غياب الشركة يعلن بشرطة: ${empty.companyLine}`);
  });

  // ── H2: سنة مالية غير تقويمية ──
  await check("H2 سنة غير تقويمية — تواريخ الفترات تمر بلا افتراض تقويمي", () => {
    const periods = nonCalendarPeriods();
    const p3 = periods[2]; // يونيو 2026
    const meta = buildReportHeaderMeta({
      companyCode: "NC-1", companyName: "غير تقويمية", reportTitle: "قائمة الربح أو الخسارة",
      fiscalYearCode: "FY26-27", periodLabel: `حتى نهاية فترة ${p3.ordinal}`,
      fromDate: p3.startDate, toDate: p3.endDate, status: "APPROVED",
    });
    expect(meta.periodLine.includes("2026-06-01") && meta.periodLine.includes("2026-06-30"), `يونيو ⇒ فترة 3 بتواريخها: ${meta.periodLine}`);
    expect(meta.fromDate === "2026-06-01" && meta.toDate === "2026-06-30", "from/to مطابقان للفترة الفعلية");
  });

  // ── H3/H4/H5/H14: فحوص بنية الطباعة (CSS + المحرك + التوصيل) ──
  await check("H3/H14 منفذ الطباعة + RTL + إخفاء أدوات التحكم في وسيط الطباعة", () => {
    expect(fileExports("src/app/globals.css", "body > *:not(#print-root)"), "قاعدة إخفاء كل شيء عدا المنفذ موجودة");
    expect(fileExports("src/app/globals.css", "@media print"), "كتلة @media print موحدة");
    expect(fileExports("src/app/globals.css", "display: table-header-group"), "تكرار رؤوس الجداول");
    expect(fileExports("src/app/globals.css", ".no-print"), "أدوات التحكم تُخفى");
    expect(fileExports("src/app/globals.css", "page-break-inside: avoid"), "منع قص الصفوف");
    expect(fileExports("src/components/reporting/report-print.tsx", '"rtl"'), "منفذ الطباعة dir=rtl");
    expect(fileExports("src/components/reporting/report-print.tsx", 'setAttribute("lang", "ar")'), "lang=ar على المنفذ");
  });

  await check("H4 Landscape للتقارير العريضة (AvB + التوحيد + ميزان المراجعة)", () => {
    expect(fileExports("src/components/reporting/report-print.tsx", 'size: A4 ${orientation}'), "حقن @page size A4 حسب الاتجاه");
    expect(fileExports("src/components/reporting/budget-view.tsx", 'orientation="landscape"'), "فعلي مقابل موازنة أفقي");
    expect(fileExports("src/components/reporting/consolidation-view.tsx", 'orientation="landscape"'), "التقرير الموحد أفقي");
    expect(fileExports("src/components/admin/trial-balance-tab.tsx", 'orientation="landscape"'), "تفاصيل ميزان المراجعة أفقي");
  });

  await check("H5 Portrait للقوائم الأقل عرضًا (القوائم الأربع)", () => {
    const src = readFileSync("src/components/reporting/statements-view.tsx", "utf8");
    const count = (src.match(/orientation="portrait"/g) ?? []).length;
    expect(count >= 4, `أربع قوائم بطباعة رأسية (ناتج ${count})`);
    expect(fileExports("src/components/reporting/report-print.tsx", 'export function PrintButton'), "زر الطباعة الموحد موجود");
  });

  // ── H6/H7: الحالات الصادقة في العرض ──
  await check("H6 INCOMPLETE_DATA ظاهرة في الترويسة (شارة + إشعار إلزامي)", () => {
    const meta = buildReportHeaderMeta({
      companyCode: "C", companyName: "N", reportTitle: "R", fiscalYearCode: "FY", status: "INCOMPLETE_DATA",
    });
    expect(meta.statusLabel.includes("INCOMPLETE_DATA"), `الحالة معلنة: ${meta.statusLabel}`);
    expect(meta.statusNotice?.includes("لا تُعوَّض") || meta.statusNotice?.includes("معلنة"), `إشعار صادق: ${meta.statusNotice?.slice(0, 40)}`);
    expect(fileExports("src/components/reporting/statements-view.tsx", 'completeness.ready ? "APPROVED" : "INCOMPLETE_DATA"'), "القوائم تربط الحالة بالاكتمال الفعلي");
  });

  await check("H7 UNCLASSIFIED يبقى ظاهرًا — القيمة الناقصة «—» لا صفر", () => {
    expect(formatMinor(null) === "—", `null ⇒ — لا 0 (ناتج ${formatMinor(null)})`);
    expect(formatMinor("0") === "0.00", "الصفر الحقيقي يبقى صفرًا ظاهرًا");
    expect(fileExports("src/components/reporting/statements-view.tsx", "unclassified.rows.length > 0"), "لوحة غير المصنف معروضة");
    expect(fileExports("src/components/reporting/statements-view.tsx", "بيانات ناقصة"), "Money: القيمة غير المتاحة معلنة نصيًا");
  });

  // ── تهيئة قاعدة معزولة: شركتان + قواعد + سنة + ميزان معتمد + مجموعة ──
  await check("G0 تهيئة: شركتان + قواعد + سنة + ميزان معتمد + مجموعة توحيد", async () => {
    const a = await db.company.create({ data: { code: "RP-A", nameAr: "شركة تقارير أ" } });
    const b = await db.company.create({ data: { code: "RP-B", nameAr: "شركة تقارير ب" } });
    coA = a.id; coB = b.id;
    for (const [prefix, classification, behavior, lineCode] of [
      ["1101", "ASSET", "BALANCE", "SFP-CASH"],
      ["2101", "LIABILITY", "BALANCE", "SFP-LIA-CL"],
      ["2301", "EQUITY", "BALANCE", "SFP-EQUITY"],
      ["4101", "REVENUE", "FLOW", "PNL-REVENUE"],
      ["5201", "EXPENSE", "FLOW", "PNL-ADMIN-EXPENSES"],
    ] as const) {
      const sl = await db.financialStatementLine.findUniqueOrThrow({ where: { code: lineCode } });
      await db.accountNatureRule.create({ data: { companyId: coA, prefix, classification, aggregationBehavior: behavior, source: "MANUAL", statementLineId: sl.id } });
    }
    const fy = await db.fiscalYear.create({ data: { companyId: coA, code: "FY2026-A", startDate: "2026-01-01", endDate: "2026-12-31", periodCount: 12 } });
    fyA = fy.id;
    for (let i = 0; i < 12; i++) {
      const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
      const mm = String(i + 1).padStart(2, "0");
      await db.fiscalPeriod.create({ data: { fiscalYearId: fy.id, ordinal: i + 1, code: `2026-${mm}`, startDate: `2026-${mm}-01`, endDate: `2026-${mm}-${last}`, displayLabel: `شهر ${i + 1}` } });
    }
    const fyB = await db.fiscalYear.create({ data: { companyId: coB, code: "FY2026-B", startDate: "2026-01-01", endDate: "2026-12-31", periodCount: 12 } });
    for (let i = 0; i < 12; i++) {
      const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
      const mm = String(i + 1).padStart(2, "0");
      await db.fiscalPeriod.create({ data: { fiscalYearId: fyB.id, ordinal: i + 1, code: `2026-${mm}`, startDate: `2026-${mm}-01`, endDate: `2026-${mm}-${last}`, displayLabel: `شهر ${i + 1}` } });
    }
    const created = await createTrialBalance({
      user: admin, ip: "gate",
      input: {
        companyId: coA, fiscalYearId: fy.id, fromDate: "2026-01-01", toDate: "2026-03-31",
        dataType: "CUMULATIVE_YTD", reason: "بوابة 6.8",
        lines: [
          line("110101", 700000, 0, "نقدية"),
          line("210101", 0, 150000, "دائنون"),
          line("230101", 0, 350000, "رأس المال"),
          line("410101", 0, 300000, "مبيعات"),
          line("520101", 100000, 0, "رواتب"),
        ],
      },
    });
    const committed = await commitTrialBalance({ user: admin, ip: "gate", id: created.import.id, input: { version: created.import.version, reason: "بوابة" } });
    expect(committed.status === "COMMITTED", "اعتماد الميزان");
    await db.equityComponentMapping.create({ data: { companyId: coA, prefix: "23", componentCode: "SHARE_CAPITAL" } });
    await createConsolidationGroup({
      user: admin, ip: "gate",
      input: {
        code: "GRP-68", nameAr: "مجموعة بوابة 6.8",
        members: [
          { companyId: coA, effectiveFrom: "2026-01-01", ownershipPercentage: 100 },
          { companyId: coB, effectiveFrom: "2026-01-01", ownershipPercentage: 60 },
        ],
      },
    });
  });

  // ── H8/H9/H10: التقرير الموحد على قاعدة معزولة ──
  let consolidated: Awaited<ReturnType<typeof getConsolidatedStatements>> | null = null;
  await check("H8/H9 التوحيد الأولي: preliminary ظاهرة + عضو بلا بيانات ⇒ INCOMPLETE_DATA", async () => {
    const groups = await db.consolidationGroup.findMany({ where: { code: "GRP-68" } });
    expect(groups.length === 1, "المجموعة موجودة");
    consolidated = await getConsolidatedStatements(admin, { groupId: groups[0].id, startDate: "2026-01-01", endDate: "2026-03-31" });
    expect(consolidated.preliminary === true, `preliminary: true (ناتج ${String(consolidated.preliminary)})`);
    expect(consolidated.status === "INCOMPLETE_DATA", `الشركة ب بلا بيانات ⇒ INCOMPLETE_DATA (ناتج ${consolidated.status})`);
    const memberB = consolidated.members.find((m) => m.companyId === coB);
    expect(memberB?.dataStatus === "INCOMPLETE_DATA" || memberB?.dataStatus !== "OK", `حالة العضو ب معلنة: ${memberB?.dataStatus}`);
    const revenueRow = consolidated.workingPaper.find((r) => r.groupLineCode === "PNL-REVENUE");
    const bVal = revenueRow?.companyValues.find((cv) => cv.companyId === coB);
    expect(bVal !== undefined && bVal.valueMinor === null, `بلا بيانات ⇒ null معلن لا صفر (ناتج ${String(bVal?.valueMinor)})`);
    expect(fileExports("src/components/reporting/consolidation-view.tsx", "INCOMPLETE"), "الواجهة تعرض حالة INCOMPLETE نصيًا");
  });

  await check("H10 الاستبعادات منفصلة: before + adjustments = consolidated (هوية الأعمدة)", async () => {
    expect(!!consolidated, "بيانات التوحيد من الفحص السابق");
    const c = consolidated!;
    for (const row of c.workingPaper) {
      expect("totalBeforeEliminationsMinor" in row && "adjustmentsMinor" in row && "consolidatedTotalMinor" in row, "الأعمدة الثلاثة منفصلة في العقد");
      const before = BigInt(row.totalBeforeEliminationsMinor ?? "0");
      const adj = BigInt(row.adjustmentsMinor ?? "0");
      const consol = BigInt(row.consolidatedTotalMinor ?? "0");
      expect(before + adj === consol, `هوية ${row.groupLineCode}: ${before} + ${adj} = ${consol}`);
    }
    // شركة أ فقط معتمدة والعضو ب بلا بيانات: before إما null معلن (لا صفر صامت) أو يساوي قيمة الشركة أ حصرًا
    const revenueRow = c.workingPaper.find((r) => r.groupLineCode === "PNL-REVENUE");
    const aVal = revenueRow?.companyValues.find((cv) => cv.companyId === coA);
    expect(
      revenueRow?.totalBeforeEliminationsMinor === null || revenueRow?.totalBeforeEliminationsMinor === aVal?.valueMinor,
      `before إما معلن null أو قابل للتتبع من شركة أ (ناتج ${String(revenueRow?.totalBeforeEliminationsMinor)} مقابل ${String(aVal?.valueMinor)})`,
    );
  });

  // ── H11: BigInt عبر مسار التقرير والتصدير ──
  await check("H11 BigInt > 2^53 دقيق عبر formatMinor و CSV", () => {
    const huge = "9007199254740993"; // 2^53 + 1 minor = 90,071,992,547,409.93
    const formatted = formatMinor(huge, 2);
    expect(formatted === "90,071,992,547,409.93", `تنسيق كامل بلا فقد: ${formatted}`);
    const digits = formatted.replace(/[(),]/g, "");
    expect(digits === "90071992547409.93", `الأرقام الحرفية محفوظة: ${digits}`);
    const cols: ExportColumn<{ v: string }>[] = [{ key: "v", label: "القيمة (minor)", numeric: true, value: (r) => r.v }];
    const csv = buildCsv(cols, [{ v: huge }, { v: "9007199254740994" }]);
    expect(csv.includes("9007199254740993") && csv.includes("9007199254740994"), "CSV يحمل القيمتين المتتاليتين فوق 2^53 كما هما");
    expect(!csv.includes("e+") && !csv.includes("E+"), "لا تدوين علمي");
    expect(csv.charCodeAt(0) === 0xfeff, "BOM عربي لExcel");
  });

  // ── H12: ف/غ ──
  await check("H12 قاعدة ف/غ المركزية لم تتغير", () => {
    expect(favorabilityFor("REVENUE", BigInt(120), BigInt(100)) === "FAVORABLE", "إيراد أعلى ⇒ مواتٍ");
    expect(favorabilityFor("REVENUE", BigInt(90), BigInt(100)) === "UNFAVORABLE", "إيراد أقل ⇒ غير مواتٍ");
    expect(favorabilityFor("EXPENSE", BigInt(80), BigInt(100)) === "FAVORABLE", "مصروف أقل ⇒ مواتٍ");
    expect(favorabilityFor("EXPENSE", BigInt(120), BigInt(100)) === "UNFAVORABLE", "مصروف أعلى ⇒ غير مواتٍ");
    expect(favorabilityFor("OTHER", BigInt(10), BigInt(5)) === "NO_FAVORABLE_UNFAVORABLE", "أرصدة ⇒ بلا ف/غ");
    // 6.9R: الواجهة تستخدم الأساس الموحد (display-labels) بدل FAVORABILITY_LABELS — الأكواد الداخلية كما هي
    expect(!fileExports("src/components/reporting/budget-view.tsx", "FAVORABILITY_LABELS"), "لا تسميات ف/غ المباشرة في الواجهة (جولة المراجعة C/H)");
    expect(fileExports("src/components/reporting/budget-view.tsx", "budgetVarianceBadge"), "العرض يستخدم الأساس الموحد للمصطلح السياقي");
  });

  // ── H13: عزل الصلاحيات ──
  await check("H13 company scope fail-closed لم يتأثر بطبقة العرض", async () => {
    const all = await listTrialBalances(admin);
    expect(all.some((r) => r.companyId === coA), "المدير يرى شركة أ");
    const scoped = await listTrialBalances({ ...limited, permissions: { ...limited.permissions, companyIds: [coB] } });
    expect(scoped.every((r) => r.companyId !== coA), "المحدود لا يرى شركة أ نهائيًا");
    expect(fileExports("src/components/reporting/statements-view.tsx", "canManageTrialBalances"), "بوابة الواجهة = بوابة الخادم (عرض فقط)");
  });

  // ── H15: ملفات بوابات الانحدار ──
  await check("H15 بوابات الانحدار 62A–6.7 موجودة (تُشغَّل منفصلة على قواعدها)", () => {
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
  console.log("PHASE 6.8 GATE: ALL PASS");
}

main().catch((e) => {
  console.error("فشل تشغيل البوابة:", e);
  process.exit(1);
});
