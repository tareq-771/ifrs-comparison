// Phase 6.10 — بوابة أعمار الديون والتحصيل (Receivables Aging & Collections).
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-610-gate.db bunx prisma migrate deploy
//        DATABASE_URL=file:/home/z/my-project/db/dev-610-gate.db bun scripts/phase610-aging-analytics.ts
// (قاعدة معزولة dev-610-gate.db من migrations حصرًا — عزل صارم عن custom.db — لا db push)
//
// المجموعات:
//   G0  تهيئة (شركتان + سنة مالية + ميزان مراجعة معتمد بحسابات مدينين)
//   M1  تعيين الأعمدة (تلقائي EN/AR، يدوي، رفض تعيين ناقص/خاطئ)
//   M2  المال BigInt-آمن + أرقام عربية-هندية + قيم غير صالحة = ناقصة لا صفر
//   M3  الشرائط: حدود + لا تداخل + تقسيم كامل + شرائط قابلة للتخصيص
//   M4  دلالة الناقص (missing != zero) + شريط UNDETERMINED المعلن
//   M5  اشتقاق العمر: صريح > استحقاق > فاتورة (معلن) — لا اختراع تواريخ
//   M6  اللقطات: إنشاء/اعتماد/SoD/عدم استبدال معتمد/حذف مسودة
//   M7  عزل الشركات (fail-closed)
//   M8  المطابقة: RECONCILED/DIFFERENCE/NO_TB_DATA/NO_RECEIVABLE_MAPPING/INCOMPLETE_DATA
//   M9  المخاطر: ترتيب حتمي + أسباب + لا ادعاء ECL
//   M10 الرؤى: تشغيل/إيقاف/قيم enum صحيحة/اتجاه
//   M11 بيانات الرسوم: تقسيم متسق + ترتيب + لا NaN/Infinity
//   M12 الصلاحيات: نمط admin-ضمني + رفض الخدمة لغير المخوّل
//   M13 مدخلات غير صالحة (CSV اقتباسات، sha خاطئ، تاريخ أساس خاطئ)
//   M14 الأداء: 5000 صف عبر الخدمة خلال حد سخي + تناسق التقسيم

import { parseCsv } from "../src/lib/aging-csv";
import {
  createAgingImport,
  createAgingSnapshot,
  approveAgingSnapshot,
  getAgingSnapshot,
  listAgingSnapshots,
  listAgingImports,
  deleteAgingImport,
  getAgingConfig,
  updateAgingConfig,
  AgingError,
} from "../src/lib/aging-server";
import { createTrialBalance, commitTrialBalance } from "../src/lib/trial-balance-server";
import {
  canUploadAging, canViewAging, canConfigureAging, canApproveAgingSnapshot,
  canDeleteDraftAging, canEditAgingMapping, canViewInsights, canConfigureInsightRules,
  DEFAULT_USER_PERMISSIONS,
} from "../src/lib/permissions";
import { DEFAULT_AGING_BUCKETS, assignBucket, formatBp } from "../src/lib/aging";

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

type GateUser = {
  id: string; username: string; name: string; role: string;
  permissions: typeof DEFAULT_USER_PERMISSIONS & Record<string, unknown>;
};

function makeUser(id: string, over: Partial<{ role: string; companyIds: string[]; viewAllCompanies: boolean; uploadAging: boolean; approveAgingSnapshot: boolean; deleteDraftAging: boolean; configureAging: boolean; editAgingMapping: boolean }> = {}): GateUser {
  return {
    id,
    username: id,
    name: id,
    role: over.role ?? "admin",
    permissions: {
      ...DEFAULT_USER_PERMISSIONS,
      companyIds: over.companyIds ?? [],
      viewAllCompanies: over.viewAllCompanies ?? true,
      uploadAging: over.uploadAging ?? false,
      approveAgingSnapshot: over.approveAgingSnapshot ?? false,
      deleteDraftAging: over.deleteDraftAging ?? false,
      configureAging: over.configureAging ?? false,
      editAgingMapping: over.editAgingMapping ?? false,
    },
  };
}

const line = (code: string, debit: number, credit: number, name = "") => ({ accountCode: code, accountName: name, debit, credit });

async function createCalendarFy(db: any, companyId: string, code: string, year: number) {
  const fy = await db.fiscalYear.create({ data: { companyId, code, startDate: `${year}-01-01`, endDate: `${year}-12-31`, periodCount: 12 } });
  for (let i = 0; i < 12; i++) {
    const last = new Date(Date.UTC(year, i + 1, 0)).getUTCDate();
    const mm = String(i + 1).padStart(2, "0");
    await db.fiscalPeriod.create({ data: { fiscalYearId: fy.id, ordinal: i + 1, code: `${year}-${mm}`, startDate: `${year}-${mm}-01`, endDate: `${year}-${mm}-${last}`, displayLabel: `شهر ${i + 1}` } });
  }
  return fy;
}

async function commitTB(user: GateUser, companyId: string, fiscalYearId: string, fromDate: string, toDate: string, lines: Array<{ accountCode: string; accountName: string; debit: number; credit: number }>) {
  const created = await createTrialBalance({
    user: user as never, ip: "gate-610",
    input: { companyId, fiscalYearId, fromDate, toDate, dataType: "CUMULATIVE_YTD", reason: "بوابة 6.10", lines: lines as never },
  });
  await commitTrialBalance({ user: user as never, ip: "gate-610", id: created.import.id, input: { version: created.import.version, reason: "بوابة 6.10" } });
}

const AS_OF = "2026-09-30";

/** استيراد مطابق للميزان: مجموع 120,000,000 minor = 1,200,000.00 */
function reconciledGrid() {
  const headers = ["Customer Code", "Customer Name", "Outstanding Balance", "Due Date", "Notes"];
  const rows = [
    ["C001", "عميل النقد", "200000.00", "2026-10-05", "غير مستحق"],
    ["C002", "عميل 30", "150000.00", "2026-09-15", ""],
    ["C003", "عميل 60", "150000.00", "2026-08-20", ""],
    ["C004", "عميل 90", "100000.00", "2026-07-25", ""],
    ["C005", "عميل 180", "100000.00", "2026-05-10", ""],
    ["C006", "عميل 365", "100000.00", "2026-02-01", ""],
    ["C007", "عميل متقادم", "300000.00", "2025-06-30", ""],
    ["C008", "عميل بلا أساس", "100000.00", "", "لا تواريخ"],
    ["C009", "عميل بلا رصيد", "", "", "missing != zero"],
  ];
  return { headers, rows };
}

/** استيراد قيم شاذة/عريضة/عربية + عمر صريح + تاريخ غامض + فاتورة مستقبلية */
function miscGrid() {
  const headers = ["Customer Code", "Customer Name", "Outstanding Balance", "Due Date", "Age Days", "Invoice Date"];
  return {
    headers,
    rows: [
      ["C901", "سالب", "-20000.00", "", "", ""],
      ["C902", "عملاق", "1234567890123456.78", "", "", ""],
      ["C903", "أرقام عربية", "٥٠٠٠", "", "", ""],
      ["C904", "عمر صريح", "50000.00", "", "200", ""],
      ["C905", "نص غير رقمي", "abc", "", "", ""],
      ["C906", "تاريخ غامض", "10000.00", "05/03/2026", "", ""],
      ["C907", "فاتورة مستقبلية", "20000.00", "", "", "2026-10-15"],
    ],
  };
}

function juneGrid() {
  return { headers: ["Customer Code", "Customer Name", "Outstanding Balance", "Due Date"], rows: [["C601", "عميل يونيو", "600000.00", "2026-06-15"]] };
}

function emptyBalanceGrid() {
  return { headers: ["Customer Code", "Customer Name", "Outstanding Balance"], rows: [["C950", "بلا رصيد", ""]] };
}

async function main() {
  console.log("═══ بوابة المرحلة 6.10 — أعمار الديون والتحصيل ══");
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-610"), "الأداة تعمل على dev-610-gate.db حصرًا (عزل صارم عن custom.db)");

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ log: [], datasources: { db: { url: url! } } });

  const adminA = makeUser("gate-610-admin-a");
  const adminB = makeUser("gate-610-admin-b");
  const uploaderA = makeUser("gate-610-uploader", { role: "user", uploadAging: true, editAgingMapping: true });
  const scopeBUser = makeUser("gate-610-scope-b", { role: "user", companyIds: [], viewAllCompanies: false });

  let coA = ""; let fyA = ""; let coB = ""; let fyB = "";
  let importA1 = ""; let importA2 = ""; let snapA1 = "";

  /* ── G0 تهيئة ── */
  await check("G0-1 تهيئة شركتين وسنة مالية تقويمية لكل منهما", async () => {
    const a = await db.company.create({ data: { code: "GATE610-A", nameAr: "شركة بوابة أ", functionalCurrency: "SAR" } });
    coA = a.id;
    const b = await db.company.create({ data: { code: "GATE610-B", nameAr: "شركة بوابة ب", functionalCurrency: "SAR" } });
    coB = b.id;
    fyA = (await createCalendarFy(db, coA, "FY2026", 2026)).id;
    fyB = (await createCalendarFy(db, coB, "FY2026", 2026)).id;
    expect(!!coA && !!coB && !!fyA && !!fyB, "معرفات التهيئة مكتملة");
  });

  await check("G0-2 ميزان مراجعة معتمد بحسابات مدينين (1101=700k، 1102=500k) متوازن + ربط حسابات المطابقة", async () => {
    await commitTB(adminA, coA, fyA, "2026-01-01", "2026-09-30", [
      line("1101", 700000, 0, "الذمم المدينة أ"),
      line("1102", 500000, 0, "الذمم المدينة ب"),
      line("2101", 0, 1200000, "الدائنون"),
    ]);
    const tb = await db.trialBalanceImport.count({ where: { companyId: coA, status: "COMMITTED" } });
    expect(tb === 1, `ميزان معتمد واحد (${tb})`);
    await updateAgingConfig(adminA, { companyId: coA, receivableAccounts: [{ accountCode: "1101", label: "ذمم أ" }, { accountCode: "1102", label: "ذمم ب" }] }, "gate-610");
  });

  /* ── M1 تعيين الأعمدة ── */
  await check("M1-1 ترجيع تلقائي لعناوين إنجليزية (identity + balance مطلوبان)", async () => {
    const g = reconciledGrid();
    const r = await createAgingImport(adminA, { companyId: coA, fileName: "aging-en.csv", fileType: "CSV", fileSize: 1234, fileSha256: "a".repeat(64), asOfDate: AS_OF, grid: g }, "gate-610");
    importA1 = String(r.importId);
    expect(r.validRowCount === 9, `صفوف صالحة 9 (الهوية + الرصيد أو بلا رصيد معلن) (${r.validRowCount})`);
    expect(r.rejectedCount === 0, `لا صفوف مرفوضة (${r.rejectedCount})`);
  });

  await check("M1-2 ترجيع تلقائي لعناوين عربية", async () => {
    const g = { headers: ["كود العميل", "اسم العميل", "الرصيد المستحق", "تاريخ الاستحقاق"], rows: [["C100", "عميل عربي", "1000.00", "2026-09-01"]] };
    const r = await createAgingImport(adminA, { companyId: coA, fileName: "aging-ar.csv", fileType: "CSV", fileSize: 10, fileSha256: "b".repeat(64), asOfDate: AS_OF, grid: g }, "gate-610");
    expect(r.validRowCount === 1, `صف صالح (${r.validRowCount})`);
  });

  await check("M1-3 تعيين يدوي يقبل أعمدة، ورفض عمود غير موجود، ورفض غياب الرصيد", async () => {
    const g = { headers: ["X1", "X2", "X3"], rows: [["C1", "اسم", "500.00"]] };
    const r1 = await createAgingImport(adminA, { companyId: coA, fileName: "mapped.csv", fileType: "CSV", fileSize: 5, fileSha256: "c".repeat(64), asOfDate: AS_OF, grid: g, mappingOverride: { CUSTOMER_CODE: "X1", OUTSTANDING_BALANCE: "X3" } }, "gate-610");
    expect(r1.mappingSource === "USER", "المصدر USER");
    let threwMissing = false;
    try {
      await createAgingImport(adminA, { companyId: coA, fileName: "bad-col.csv", fileType: "CSV", fileSize: 5, fileSha256: "d".repeat(64), asOfDate: AS_OF, grid: g, mappingOverride: { CUSTOMER_CODE: "NOPE" } }, "gate-610");
    } catch (e) { threwMissing = e instanceof AgingError && e.code === "INVALID_MAPPING"; }
    expect(threwMissing, "عمود غير موجود يُرفض INVALID_MAPPING");
    let threwIncomplete = false;
    try {
      await createAgingImport(adminA, { companyId: coA, fileName: "no-balance.csv", fileType: "CSV", fileSize: 5, fileSha256: "e".repeat(64), asOfDate: AS_OF, grid: { headers: ["A"], rows: [["x"]] }, mappingOverride: { CUSTOMER_CODE: "A" } }, "gate-610");
    } catch (e) { threwIncomplete = e instanceof AgingError && e.code === "MAPPING_INCOMPLETE"; }
    expect(threwIncomplete, "غياب عمود الرصيد يُرفض MAPPING_INCOMPLETE");
  });

  /* ── M2/M4/M5 قيم واستيراد 2 ── */
  await check("M2-1 أرقام عملاقة (خارج 2^53) وأرقام عربية-هندية وسالبة تُحل BigInt-آمن", async () => {
    const r = await createAgingImport(adminA, { companyId: coA, fileName: "misc.csv", fileType: "CSV", fileSize: 99, fileSha256: "f".repeat(64), asOfDate: AS_OF, grid: miscGrid() }, "gate-610");
    importA2 = String(r.importId);
    expect(r.validRowCount === 7, `7 صفوف مخزنة (${r.validRowCount})`);
    expect(r.warningCount != null && Number(r.warningCount) >= 3, `تحذيرات ≥3 (${String(r.warningCount)})`);
    const det = await listAgingImports(adminA, coA);
    expect(det.length >= 2, "سرد الاستيرادات يعمل");
  });

  /* ── M3 حدود الشرائط (نقية) ── */
  await check("M3-1a حدود: 0 وأيام سالبة بأساس الاستحقاق → غير مستحق", () => {
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 0) === "NOT_DUE", "0 → NOT_DUE");
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", -5) === "NOT_DUE", "-5 → NOT_DUE");
  });
  await check("M3-1b حدود الشريط 1–30: 1 داخله و30 داخله", () => {
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 1) === "D1_30", "1 → D1_30");
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 30) === "D1_30", "30 → D1_30");
  });
  await check("M3-1c حدود الشريط 31–60: 31 و60 (لا تداخل مع الجارين)", () => {
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 31) === "D31_60", "31 → D31_60");
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 60) === "D31_60", "60 → D31_60");
  });
  await check("M3-1d حدود الشريط 61–90 و91–180: 61/90/91/180", () => {
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 61) === "D61_90", "61 → D61_90");
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 90) === "D61_90", "90 → D61_90");
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 91) === "D91_180", "91 → D91_180");
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 180) === "D91_180", "180 → D91_180");
  });
  await check("M3-1e حدود الشريط 181–365 و365+: 181/365/366/10000", () => {
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 181) === "D181_365", "181 → D181_365");
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 365) === "D181_365", "365 → D181_365");
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 366) === "D365_PLUS", "366 → D365_PLUS");
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "DUE_DATE", 10000) === "D365_PLUS", "10000 → D365_PLUS");
  });
  await check("M3-1f أساسات بديلة: فاتورة/عمر صريح يوم 0 → أدنى شريط، بلا أساس → غير محدد", () => {
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "INVOICE_DATE", 0) === "D1_30", "INVOICE_DATE 0 → D1_30");
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "EXPLICIT", 200) === "D181_365", "EXPLICIT 200 → D181_365");
    expect(assignBucket(DEFAULT_AGING_BUCKETS, "NONE", 50) === "UNDETERMINED", "NONE → UNDETERMINED");
  });

  /* ── M6 إنشاء اللقطات + المطابقة ── */
  await check("M6-1 لقطة الاستيراد المطابق: إجمالي 120,000,000 + تقسيم شرائط كامل بلا تداخل", async () => {
    const r = await createAgingSnapshot(adminA, { importId: importA1 }, "gate-610");
    snapA1 = String(r.snapshotId);
    const det = (await getAgingSnapshot(adminA, snapA1)) as any;
    const t = det.snapshot.totals;
    expect(t.totalMinor === "120000000", `الإجمالي 120000000 (${t.totalMinor})`);
    const buckets = det.snapshot.bucketTotals as Array<{ code: string; amountMinor: string; count: number }>;
    const sum = buckets.reduce((a, b) => a + BigInt(b.amountMinor), BigInt(0));
    expect(sum === BigInt(t.totalMinor), `تقسيم كامل: مجموع الشرائط = الإجمالي (${sum})`);
    const byCode = (c: string) => buckets.find((b) => b.code === c);
    expect(byCode("NOT_DUE")!.amountMinor === "20000000", "غير مستحق 20M");
    expect(byCode("D1_30")!.amountMinor === "15000000", "1-30 = 15M");
    expect(byCode("D31_60")!.amountMinor === "15000000", "31-60 = 15M");
    expect(byCode("D61_90")!.amountMinor === "10000000", "61-90 = 10M");
    expect(byCode("D91_180")!.amountMinor === "10000000", "91-180 = 10M");
    expect(byCode("D181_365")!.amountMinor === "10000000", "181-365 = 10M");
    expect(byCode("D365_PLUS")!.amountMinor === "30000000", "365+ = 30M");
    expect(byCode("UNDETERMINED")!.amountMinor === "10000000", "غير محدد 10M معلن");
  });

  await check("M6-2 المتأخر بأساس الاستحقاق فقط = 90,000,000 (75%) — لا مبالغة بالأساسات الأخرى", async () => {
    const det = (await getAgingSnapshot(adminA, snapA1)) as any;
    expect(det.snapshot.totals.overdueMinor === "90000000", `المتأخر (${det.snapshot.totals.overdueMinor})`);
    expect(det.snapshot.totals.overduePctBp === 7500, `النسبة 7500bp (${det.snapshot.totals.overduePctBp})`);
  });

  await check("M8-1 مطابقة الاستيراد المطابق: RECONCILED مع تفصيل حسابي", async () => {
    const det = (await getAgingSnapshot(adminA, snapA1)) as any;
    expect(det.snapshot.reconciliationStatus === "RECONCILED", `الحالة (${det.snapshot.reconciliationStatus})`);
    expect(det.snapshot.reconciliation.tbTotalMinor === "120000000", "إجمالي TB");
    expect(det.snapshot.reconciliation.differenceMinor === "0", "الفرق صفر");
    expect((det.snapshot.reconciliation.accounts as unknown[]).length === 2, "حسابان مربوطان");
  });

  await check("M8-2 فرق صريح DIFFERENCE لقيم شاذة — بلا أي plug", async () => {
    const r = await createAgingSnapshot(adminA, { importId: importA2 }, "gate-610");
    const det = (await getAgingSnapshot(adminA, String(r.snapshotId))) as any;
    expect(det.snapshot.reconciliationStatus === "DIFFERENCE", `الحالة (${det.snapshot.reconciliationStatus})`);
    expect(BigInt(det.snapshot.reconciliation.differenceMinor) !== BigInt(0), "فرق غير صفري معلن");
    expect(det.snapshot.totals.totalMinor === String(BigInt("-2000000") + BigInt("123456789012345678") + BigInt("500000") + BigInt("5000000") + BigInt("1000000") + BigInt("2000000")), "الإجمالي يجمع كل الأرصدة حتى السالبة بدقة");
  });

  await check("M4-1 الناقص ليس صفرًا: صف بلا رصيد خارج الإجمالي ومُعلن", async () => {
    const det = (await getAgingSnapshot(adminA, snapA1)) as any;
    expect(det.snapshot.totals.missingBalanceCount === 1, `ناقص واحد (${det.snapshot.totals.missingBalanceCount})`);
    expect(det.snapshot.totals.validRowCount === 8, "صفوف صالحة 8");
  });

  await check("M5-1 اشتقاق العمر: صريح يتفوق، غامض يعلن، مستقبل يُسقط بلا اختراع", async () => {
    const r = await createAgingSnapshot(adminA, { importId: importA2 }, "gate-610");
    const det = (await getAgingSnapshot(adminA, String(r.snapshotId))) as any;
    const rows = det.topRows as Array<{ customerKey: string; ageDays: number | null; basis: string }>;
    const c904 = rows.find((x) => x.customerKey === "c904");
    expect(c904?.basis === "EXPLICIT" && c904.ageDays === 200, "عمر صريح 200");
    const c907 = (rows as Array<Record<string, unknown>>).find((x) => x.customerKey === "c907");
    expect(c907 != null && c907.bucketCode === "UNDETERMINED", "فاتورة مستقبلية → غير محدد معلن");
  });

  /* ── M6 SoD والحوكمة ── */
  await check("M6-3 فصل المهام: منشئ الاستيراد لا يعتمد لقطته (SOD_VIOLATION) — غيره يعتمد", async () => {
    let sod = false;
    try { await approveAgingSnapshot(adminA, snapA1, "gate-610"); } catch (e) { sod = e instanceof AgingError && e.code === "SOD_VIOLATION"; }
    expect(sod, "رفض منشئ الاستيراد");
    await approveAgingSnapshot(adminB, snapA1, "gate-610");
    let dup = false;
    try { await approveAgingSnapshot(adminB, snapA1, "gate-610"); } catch (e) { dup = e instanceof AgingError && e.code === "CONFLICT"; }
    expect(dup, "إعادة الاعتماد تُرفض CONFLICT");
  });

  await check("M6-4 لا استبدال صامت للقطات المعتمدة: نفس تاريخ الأساس يتطلب إقرارًا صريحًا", async () => {
    let conflict = false;
    try { await createAgingSnapshot(adminA, { importId: importA1 }, "gate-610"); } catch (e) { conflict = e instanceof AgingError && e.code === "EXISTING_APPROVED_SNAPSHOT"; }
    expect(conflict, "409 بلا إقرار");
    const r = await createAgingSnapshot(adminA, { importId: importA1, acknowledgeApprovedDuplicate: true }, "gate-610");
    expect(!!r.snapshotId, "لقطة جديدة مسودة بالإقرار");
  });

  await check("M6-5 حذف استيراد مرتبط بلقطات ممنوع — وحذف المسودة الخالية مسموح", async () => {
    let conflict = false;
    try { await deleteAgingImport(adminA, importA1, "gate-610"); } catch (e) { conflict = e instanceof AgingError && e.code === "CONFLICT"; }
    expect(conflict, "حذف مرتبط بلقطات ممنوع");
    const g = { headers: ["Customer Code", "Customer Name", "Outstanding Balance"], rows: [["CD1", "قابل للحذف", "10.00"]] };
    const r = await createAgingImport(adminA, { companyId: coA, fileName: "deleteme.csv", fileType: "CSV", fileSize: 1, fileSha256: "1".repeat(64), asOfDate: AS_OF, grid: g }, "gate-610");
    await deleteAgingImport(adminA, String(r.importId), "gate-610");
    const list = (await listAgingImports(adminA, coA)) as unknown[];
    expect(!list.some((x) => (x as { importId?: string }).importId === r.importId), "حُذف فعليًا");
  });

  /* ── M8 حالات المطابقة الأخرى ── */
  await check("M8-3 NO_RECEIVABLE_MAPPING لشركة بلا ربط، ثم NO_TB_DATA بعد الربط بلا ميزان", async () => {
    const g = { headers: ["Customer Code", "Customer Name", "Outstanding Balance"], rows: [["B1", "عميل ب", "5000.00"]] };
    const imp1 = await createAgingImport(adminB, { companyId: coB, fileName: "b1.csv", fileType: "CSV", fileSize: 1, fileSha256: "2".repeat(64), asOfDate: AS_OF, grid: g }, "gate-610");
    const s1 = await createAgingSnapshot(adminB, { importId: String(imp1.importId) }, "gate-610");
    const d1 = (await getAgingSnapshot(adminB, String(s1.snapshotId))) as any;
    expect(d1.snapshot.reconciliationStatus === "NO_RECEIVABLE_MAPPING", `(${d1.snapshot.reconciliationStatus})`);
    await updateAgingConfig(adminB, { companyId: coB, receivableAccounts: [{ accountCode: "1101", label: "ذمم" }] }, "gate-610");
    const imp2 = await createAgingImport(adminB, { companyId: coB, fileName: "b2.csv", fileType: "CSV", fileSize: 1, fileSha256: "3".repeat(64), asOfDate: AS_OF, grid: g }, "gate-610");
    const s2 = await createAgingSnapshot(adminB, { importId: String(imp2.importId) }, "gate-610");
    const d2 = (await getAgingSnapshot(adminB, String(s2.snapshotId))) as any;
    expect(d2.snapshot.reconciliationStatus === "NO_TB_DATA", `(${d2.snapshot.reconciliationStatus})`);
  });

  await check("M8-4 INCOMPLETE_DATA عند غياب أي أرصدة صالحة (مطابقة مستحيلة بصدق)", async () => {
    const imp = await createAgingImport(adminA, { companyId: coA, fileName: "empty.csv", fileType: "CSV", fileSize: 1, fileSha256: "4".repeat(64), asOfDate: AS_OF, grid: emptyBalanceGrid() }, "gate-610");
    const s = await createAgingSnapshot(adminA, { importId: String(imp.importId), acknowledgeApprovedDuplicate: true }, "gate-610");
    const d = (await getAgingSnapshot(adminA, String(s.snapshotId))) as any;
    expect(d.snapshot.reconciliationStatus === "INCOMPLETE_DATA", `(${d.snapshot.reconciliationStatus})`);
    expect(d.snapshot.totals.totalMinor === null, "totalMinor=null لا صفر");
  });

  /* ── M7 عزل الشركات ── */
  await check("M7-1 مستخدم بنطاق شركة ب لا يرى شيئًا من شركة أ (403 إخفاء نطاق)", async () => {
    scopeBUser.permissions.companyIds = [coB];
    let denied = false;
    try { await getAgingSnapshot(scopeBUser, snapA1); } catch (e) { denied = e instanceof AgingError && e.code === "NOT_FOUND"; }
    expect(denied, "لقطة أ غير مرئية");
    let deniedList = false;
    try { await listAgingImports(scopeBUser, coA); } catch (e) { deniedList = e instanceof AgingError && e.code === "NOT_FOUND"; }
    expect(deniedList, "سرد استيرادات أ غير مرئي");
  });

  /* ── M10 الرؤى ── */
  await check("M10-1 رؤى اللقطة المعتمدة: OVERDUE_RATIO_HIGH مفعّل بمبلغ/نسبة + أنواع enum سليمة", async () => {
    const det = (await getAgingSnapshot(adminB, snapA1)) as any;
    const ins = det.snapshot.insights as Array<{ code: string; severity: string; kind: string; detailAr: string; pctBp?: number }>;
    const over = ins.find((x) => x.code === "OVERDUE_RATIO_HIGH");
    expect(!!over, "رؤية المتأخر مفعّلة");
    expect(over!.pctBp === 7500, `نسبة صحيحة (${over!.pctBp})`);
    expect(["INFO", "ATTENTION", "IMPORTANT", "CRITICAL"].includes(over!.severity), "شدة صحيحة");
    expect(["FACT", "ANALYSIS", "RECOMMENDATION"].includes(over!.kind), "نوع صحيح");
    expect(ins.every((x) => !/NaN|Infinity/.test(JSON.stringify(x))), "لا NaN/Infinity");
  });

  await check("M10-2 إيقاف قاعدة عبر الإعدادات يُسقط رؤيتها من اللقطات الجديدة (ثم تُعاد)", async () => {
    const cfg = (await getAgingConfig(adminA, coA)) as any;
    const rules = (cfg.insightRules as Array<Record<string, unknown>>).map((r) => ({ ...r, enabled: r.code === "NEGATIVE_BALANCES" ? false : r.enabled }));
    await updateAgingConfig(adminA, { companyId: coA, insightRules: rules as never }, "gate-610");
    const s = await createAgingSnapshot(adminA, { importId: importA2, acknowledgeApprovedDuplicate: true }, "gate-610");
    const d = (await getAgingSnapshot(adminA, String(s.snapshotId))) as any;
    const ins = d.snapshot.insights as Array<{ code: string }>;
    expect(!ins.some((x) => x.code === "NEGATIVE_BALANCES"), "قاعدة معطلة لا تُنتج رؤية");
    expect(ins.length > 0, "بقية القواعد تعمل (ركود التحصيل/الناقص)");
    await updateAgingConfig(adminA, { companyId: coA, insightRules: (cfg.insightRules as Array<Record<string, unknown>>).map((r) => ({ ...r })) as never }, "gate-610");
  });

  await check("M10-3 اتجاه AGING_TREND يقارن بآخر لقطة معتمدة سابقة (نمو 100% يُكتشف)", async () => {
    const june = await createAgingImport(adminA, { companyId: coA, fileName: "june.csv", fileType: "CSV", fileSize: 1, fileSha256: "5".repeat(64), asOfDate: "2026-06-30", grid: juneGrid() }, "gate-610");
    const js = await createAgingSnapshot(adminA, { importId: String(june.importId) }, "gate-610");
    await approveAgingSnapshot(adminB, String(js.snapshotId), "gate-610");
    const s = await createAgingSnapshot(adminA, { importId: importA1, acknowledgeApprovedDuplicate: true }, "gate-610");
    const d = (await getAgingSnapshot(adminA, String(s.snapshotId))) as any;
    const ins = d.snapshot.insights as Array<{ code: string }>;
    expect(ins.some((x) => x.code === "AGING_TREND"), "رؤية الاتجاه مفعّلة");
  });

  /* ── M9 المخاطر ── */
  await check("M9-1 المخاطر: ترتيب حتمي تنازلي بالرصيد + أسباب + إجراءات + مستويات ضمن الحدود", async () => {
    const det = (await getAgingSnapshot(adminA, snapA1)) as any;
    const risk = det.snapshot.risk as { rows: Array<{ customerKey: string; balanceMinor: string; score: number; level: string; reasonsAr: string[]; suggestedActionAr: string }>; highCount: number; mediumCount: number; lowCount: number };
    expect(risk.rows.length > 0, "صفوف مخاطر موجودة");
    for (let i = 1; i < risk.rows.length; i++) {
      expect(BigInt(risk.rows[i - 1].balanceMinor) >= BigInt(risk.rows[i].balanceMinor), "ترتيب تنازلي");
    }
    expect(risk.rows.every((r) => r.score >= 0 && r.score <= 100 && ["HIGH", "MEDIUM", "LOW"].includes(r.level)), "نقاط ومستويات سليمة");
    expect(risk.rows.every((r) => r.reasonsAr.length > 0 && r.suggestedActionAr.length > 0), "أسباب وإجراءات موجودة");
    const txt = JSON.stringify(det.snapshot);
    expect(!/ECL|خسائر ائتمانية متوقعة|expected credit loss/i.test(txt.split("قِيّم قابلية")[0]), "لا ادعاء ECL في المخاطر");
  });

  /* ── M11 بيانات الرسوم ── */
  await check("M11-1 بيانات الرسوم: أكبر المدينين مرتبون والاتجاه زمنيًا — قيم نصية دقيقة", async () => {
    const det = (await getAgingSnapshot(adminA, snapA1)) as any;
    const top = det.topRows as Array<{ balanceMinor: string }>;
    for (let i = 1; i < top.length; i++) expect(BigInt(top[i - 1].balanceMinor) >= BigInt(top[i].balanceMinor), "ترتيب تنازلي");
    const list = (await listAgingSnapshots(adminA, coA)) as any;
    const tr = list.trend as Array<{ asOfDate: string }>;
    for (let i = 1; i < tr.length; i++) expect(tr[i - 1].asOfDate <= tr[i].asOfDate, "اتجاه زمني تصاعدي");
    expect(!/NaN|Infinity/.test(JSON.stringify(det)), "لا NaN/Infinity في تفصيل اللقطة");
  });

  /* ── M3-2 تخصيص الشرائط ── */
  await check("M3-2 شرائط مخصصة بلا تداخل تُقبل، والمتداخلة تُرفض، والافتراضي يُستعاد", async () => {
    const custom = [
      { code: "NOT_DUE", labelAr: "غير مستحق", labelEn: "Not Due", fromDays: null as number | null, toDays: 0 as number | null, isNotDue: true, order: 1 },
      { code: "C1_15", labelAr: "1-15", labelEn: "1-15", fromDays: 1, toDays: 15, isNotDue: false, order: 2 },
      { code: "C16P", labelAr: "16+", labelEn: "16+", fromDays: 16, toDays: null, isNotDue: false, order: 3 },
    ];
    await updateAgingConfig(adminA, { companyId: coA, buckets: custom }, "gate-610");
    const cfg = (await getAgingConfig(adminA, coA)) as any;
    expect((cfg.buckets as unknown[]).length === 3, "ثلاث شرائط مخصصة");
    let overlap = false;
    try {
      await updateAgingConfig(adminA, { companyId: coA, buckets: [
        { code: "A", labelAr: "أ", labelEn: "A", fromDays: 1, toDays: 30, isNotDue: false, order: 1 },
        { code: "B", labelAr: "ب", labelEn: "B", fromDays: 30, toDays: 60, isNotDue: false, order: 2 },
      ] }, "gate-610");
    } catch (e) { overlap = e instanceof AgingError && e.code === "INVALID_INPUT"; }
    expect(overlap, "التداخل (30/30) يُرفض");
    const def = DEFAULT_AGING_BUCKETS.map((b, i) => ({ ...b, order: i + 1 }));
    await updateAgingConfig(adminA, { companyId: coA, buckets: def }, "gate-610");
  });

  /* ── M12 الصلاحيات ── */
  await check("M12-1a نمط الصلاحيات: المستخدم الافتراضي عرض فقط (viewAging/viewInsights true والبقية false)", () => {
    const userPerms = { ...DEFAULT_USER_PERMISSIONS };
    expect(canViewAging(userPerms, "user") === true, "viewAging افتراضي true");
    expect(canViewInsights(userPerms, "user") === true, "viewInsights افتراضي true");
    expect(canUploadAging(userPerms, "user") === false, "upload افتراضي false");
    expect(canConfigureAging(userPerms, "user") === false && canApproveAgingSnapshot(userPerms, "user") === false && canDeleteDraftAging(userPerms, "user") === false && canEditAgingMapping(userPerms, "user") === false && canConfigureInsightRules(userPerms, "user") === false, "بقية الإدارة false افتراضيًا");
  });
  await check("M12-1b نمط الصلاحيات: admin ضمني لكل مفاتيح 6.10 الثمانية", () => {
    const userPerms = { ...DEFAULT_USER_PERMISSIONS };
    for (const fn of [canViewAging, canUploadAging, canEditAgingMapping, canConfigureAging, canApproveAgingSnapshot, canDeleteDraftAging, canViewInsights, canConfigureInsightRules]) {
      expect(fn(userPerms, "admin") === true, "admin ضمني");
    }
  });

  await check("M12-2 رفض الخدمة لغير المخوّل (uploadAging=false) — fail-closed", async () => {
    const noPerm = makeUser("gate-610-noperm", { role: "user", uploadAging: false, viewAllCompanies: true });
    let denied = false;
    try {
      await createAgingImport(noPerm, { companyId: coA, fileName: "x.csv", fileType: "CSV", fileSize: 1, fileSha256: "6".repeat(64), asOfDate: AS_OF, grid: { headers: ["A"], rows: [] } }, "gate-610");
    } catch (e) { denied = e instanceof AgingError && e.code === "FORBIDDEN"; }
    expect(denied, "رفع بلا صلاحية → FORBIDDEN");
  });

  /* ── M13 مدخلات غير صالحة ── */
  await check("M13-1 CSV: اقتباسات وفواصل داخل الخلايا وفاصل منقوطة", () => {
    const g = parseCsv('a,b,c\n"1,5",x,"say ""hi"""\n');
    expect(g.headers.length === 3 && g.rows[0][0] === "1,5" && g.rows[0][2] === 'say "hi"', "اقتباسات RFC4180");
    const g2 = parseCsv("a;b\n1;2\n");
    expect(g2.headers.length === 2 && g2.rows[0][1] === "2", "كشف الفاصلة المنقوطة");
  });

  await check("M13-2a رفض بصمة SHA256 غير سليمة", async () => {
    let n1 = false; try { await createAgingImport(adminA, { companyId: coA, fileName: "v.csv", fileType: "CSV", fileSize: 1, fileSha256: "nothex", asOfDate: AS_OF, grid: { headers: ["Customer Code"], rows: [] } }, "gate-610"); } catch (e) { n1 = e instanceof AgingError && e.code === "INVALID_INPUT"; }
    expect(n1, "بصمة خاطئة → INVALID_INPUT");
  });
  await check("M13-2b رفض تاريخ أساس غير صالح", async () => {
    let n2 = false; try { await createAgingImport(adminA, { companyId: coA, fileName: "v.csv", fileType: "CSV", fileSize: 1, fileSha256: "7".repeat(64), asOfDate: "2026-13-40", grid: { headers: ["Customer Code"], rows: [] } }, "gate-610"); } catch (e) { n2 = e instanceof AgingError && e.code === "INVALID_INPUT"; }
    expect(n2, "تاريخ خاطئ → INVALID_INPUT");
  });
  await check("M13-2c رفض نوع ملف غير مدعوم (لا تنفيذ صيغ)", async () => {
    let n3 = false; try { await createAgingImport(adminA, { companyId: coA, fileName: "v.xls", fileType: "XLS", fileSize: 1, fileSha256: "7".repeat(64), asOfDate: AS_OF, grid: { headers: ["Customer Code"], rows: [] } }, "gate-610"); } catch (e) { n3 = e instanceof AgingError && e.code === "INVALID_INPUT"; }
    expect(n3, "XLS قديم → INVALID_INPUT");
  });

  /* ── M14 الأداء ── */
  await check("M14-1 أداء: 5000 صف عبر الخدمة (رفع+لقطة) خلال حد سخي + تناسق تقسيم", async () => {
    const headers = ["Customer Code", "Customer Name", "Outstanding Balance", "Due Date"];
    const rows: string[][] = [];
    for (let i = 0; i < 5000; i++) {
      const d = new Date(Date.UTC(2026, 8, 30) - (i % 400) * 86400000);
      rows.push([`P${String(i).padStart(5, "0")}`, `عميل أداء ${i}`, `${(100 + (i % 900)).toFixed(2)}`, d.toISOString().slice(0, 10)]);
    }
    const t0 = Date.now();
    const imp = await createAgingImport(adminA, { companyId: coA, fileName: "perf.csv", fileType: "CSV", fileSize: 1, fileSha256: "8".repeat(64), asOfDate: AS_OF, grid: { headers, rows } }, "gate-610");
    const snap = await createAgingSnapshot(adminA, { importId: String(imp.importId), acknowledgeApprovedDuplicate: true }, "gate-610");
    const elapsed = Date.now() - t0;
    expect(Number(imp.validRowCount) === 5000, `5000 صف (${imp.validRowCount})`);
    expect(elapsed < 90000, `المدة ${elapsed}ms < 90000ms`);
    const det = (await getAgingSnapshot(adminA, String(snap.snapshotId))) as any;
    const buckets = det.snapshot.bucketTotals as Array<{ amountMinor: string }>;
    const sum = buckets.reduce((a, b) => a + BigInt(b.amountMinor), BigInt(0));
    expect(sum === BigInt(det.snapshot.totals.totalMinor), "تقسيم كامل للـ5000 صف");
    console.log(`        (perf: 5000 rows import+snapshot = ${elapsed}ms)`);
  });

  await db.$disconnect();
  console.log(`\nالنتيجة: ${passCount} PASS / ${failCount} FAIL`);
  if (failures.length > 0) {
    console.log("الفحوص الفاشلة:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("PHASE 6.10 GATE: ALL PASS");
}

main().catch((e) => {
  console.error("فشل تشغيل البوابة:", e);
  process.exit(1);
});
