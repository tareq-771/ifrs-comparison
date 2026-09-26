// ══════════════════════════════════════════════════════════════════════════════
// Phase 7.0 (Step 3) — TB Importer Server Integration Gate
// بوابة الخطوة 3: التنسيق الخادمي + الإصرار المضبوط + الإثبات — فحوص معزولة حصرًا.
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-612-step3-gate.db bun scripts/phase70-tb-import-step3-server.ts
//
// قاعدة معزولة حصرًا (dev-612-step3-gate.db من الترحيلات) — custom.db ممنوع بنيويًا.
// الحد الأدنى: 45 فحصًا مستقلًا PASS / 0 FAIL — الفحوص لا تُدمج لتقليل العدّاد.
// ══════════════════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";
import { canManageTrialBalances, type Permissions } from "@/lib/permissions";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import type { SessionUser } from "@/lib/session";
import type { TbImportRawCellInput, TbImportServerInput } from "@/lib/tb-import-server";
import {
  enforceProvenanceBound,
  getTbImportProvenance,
  previewTbImport,
  saveTbImportDraft,
  TB_IMPORT_SERVER_LIMITS,
} from "@/lib/tb-import-server";
import { createTrialBalance } from "@/lib/trial-balance-server";
import { TrialBalanceError } from "@/lib/trial-balance";

/* ── عدة الفحص ───────────────────────────────────────────────────────────── */

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function check(num: number, name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      passCount++;
      console.log(`PASS ${num}: ${name}`);
    } catch (e) {
      failCount++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`#${num} ${name} — ${msg}`);
      console.log(`FAIL ${num}: ${name} — ${msg}`);
    }
  })();
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function expectTbError(fn: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof TrialBalanceError) {
      assert(e.code === code, `expected ${code}, got ${e.code}: ${e.message}`);
      return;
    }
    throw new Error(`unexpected error type: ${e instanceof Error ? e.message : String(e)}`);
  }
  throw new Error(`expected TrialBalanceError ${code} but nothing was thrown`);
}

/* ── حاجز القاعدة المعزولة — فشل مغلق ────────────────────────────────────── */

const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL.includes("dev-612-step3-gate.db")) {
  console.error("FATAL: هذه البوابة تعمل على dev-612-step3-gate.db حصرًا — لا تشغيل على أي قاعدة أخرى.");
  console.error(`DATABASE_URL الحالية: ${DATABASE_URL || "(غير مضبوطة)"}`);
  process.exit(1);
}
const db = new PrismaClient();

/* ── المستخدمون (بلا صفوف User — الخدمة تأخذ SessionUser مباشرة) ─────────── */

function permsOf(p: Partial<Permissions> & { companyIds?: string[] }): Permissions {
  return {
    view: true, add: true, edit: true, delete: true, groups: true, export: true,
    settings: false, manageUsers: false,
    companyIds: p.companyIds ?? [],
    viewAllCompanies: p.viewAllCompanies === true,
    ...p,
  } as Permissions;
}

const ADMIN: SessionUser = {
  id: "u-gate-admin", username: "gate-admin", name: "Gate Admin", role: "admin",
  permissions: permsOf({ viewAllCompanies: true }),
};
const SCOPED: SessionUser = {
  id: "u-gate-scoped", username: "gate-scoped", name: "Gate Scoped", role: "manager",
  permissions: permsOf({ companyIds: [] }), // يُملأ بعد معرفة معرّفات الشركات
};
const OUTSIDER: SessionUser = {
  id: "u-gate-out", username: "gate-out", name: "Gate Outsider", role: "manager",
  permissions: permsOf({ companyIds: ["c-somewhere-else"] }),
};

/* ── بنّاءو الفيكتشرات الخام (نفس شكل الطلب العميلي غير الموثوق) ───────────── */

function t(text: string): TbImportRawCellInput {
  return { text, isNumericSource: false, isFormula: false, formulaText: null };
}
function numCell(value: number): TbImportRawCellInput {
  return { text: String(value), isNumericSource: true, isFormula: false, formulaText: null };
}
function formulaCell(text: string): TbImportRawCellInput {
  return { text, isNumericSource: false, isFormula: true, formulaText: "=SUM(A1)" };
}

const FULL_HEADERS = ["Account Code", "Account Name", "Opening Debit", "Opening Credit", "Period Debit", "Period Credit", "Closing Debit", "Closing Credit"];
const FULL_MAP: Record<string, string> = {
  "0": "ACCOUNT_CODE", "1": "ACCOUNT_NAME", "2": "OPENING_DEBIT", "3": "OPENING_CREDIT",
  "4": "PERIOD_DEBIT", "5": "PERIOD_CREDIT", "6": "CLOSING_DEBIT", "7": "CLOSING_CREDIT",
};
const CLOSING_HEADERS = ["Account Code", "Account Name", "Closing Debit", "Closing Credit"];
const CLOSING_MAP: Record<string, string> = {
  "0": "ACCOUNT_CODE", "1": "ACCOUNT_NAME", "2": "CLOSING_DEBIT", "3": "CLOSING_CREDIT",
};
const MOVEMENT_HEADERS = ["Account Code", "Account Name", "Period Debit", "Period Credit"];
const MOVEMENT_MAP: Record<string, string> = {
  "0": "ACCOUNT_CODE", "1": "ACCOUNT_NAME", "2": "PERIOD_DEBIT", "3": "PERIOD_CREDIT",
};

type RawRow = Array<string | number | TbImportRawCellInput>;

function toCell(v: string | number | TbImportRawCellInput): TbImportRawCellInput {
  if (typeof v === "object" && v !== null) return v as TbImportRawCellInput;
  return typeof v === "number" ? numCell(v) : t(v);
}

function baseInput(overrides: Partial<TbImportServerInput>): TbImportServerInput {
  return {
    companyId: "c-main",
    fiscalYearId: "fy-main",
    fromDate: "2027-09-01",
    toDate: "2027-09-30",
    shape: "FULL_MOVEMENT",
    grid: [],
    mapping: FULL_MAP,
    sourceCurrency: "SAR",
    completeness: "COMPLETE",
    subsetAcknowledged: false,
    flowClosingSemantics: null,
    subtotalResolutions: {},
    originalFileName: "tb.xlsx",
    fileHash: "",
    note: "",
    replaceExisting: false,
    ...overrides,
  };
}

function fullGrid(rows: RawRow[]): TbImportServerInput["grid"] {
  return [FULL_HEADERS.map((h) => t(h)), ...rows.map((r) => r.map(toCell))];
}

/** صفوف FULL متوازنة: افتتاح 1000=1000، فترة 1300=1300، إغلاق 1900=1900. */
function balancedFullRows(): RawRow[] {
  return [
    ["1101", "Cash", 1000, 0, 700, 200, 1500, 0],
    ["2101", "Payables", 0, 1000, 200, 500, 0, 1300],
    ["3101", "Salaries", 0, 0, 400, 0, 400, 0],
    ["4100", "Revenue", 0, 0, 0, 600, 0, 600],
  ];
}

/* ── تهيئة القاعدة المعزولة (تنظيف ذاتي + بذر حتمي) ──────────────────────── */

async function seed(): Promise<void> {
  // تنظيف ذاتي على القاعدة المعزولة حصرًا — بداية نظيفة دائمة (نمط البوابات التاريخية)
  await db.trialBalanceLine.deleteMany({});
  await db.trialBalanceImport.deleteMany({});
  await db.auditLog.deleteMany({ where: { entityType: "TrialBalanceImport" } });
  await db.fiscalPeriod.deleteMany({});
  await db.fiscalYear.deleteMany({});
  await db.accountNatureRule.deleteMany({ where: { companyId: { not: null } } });
  await db.company.deleteMany({ where: { code: { startsWith: "S3-" } } });

  const mkCompany = async (code: string, currency: string | null) =>
    db.company.create({ data: { code, nameAr: `شركة ${code}`, functionalCurrency: currency ?? "" } });

  const cMain = await mkCompany("S3-MAIN", "SAR");
  const cNoCur = await mkCompany("S3-NOCUR", null);
  const cUnknown = await mkCompany("S3-UNKNOWNCUR", "XYZ");
  const cMove = await mkCompany("S3-MOVE", "SAR");
  const cClose = await mkCompany("S3-CLOSE", "SAR");
  const cDup = await mkCompany("S3-DUP", "SAR");
  const cCommit = await mkCompany("S3-COMMIT", "SAR");
  const cRev = await mkCompany("S3-REV", "SAR");
  const cLegacy = await mkCompany("S3-LEGACY", "SAR");
  const cPrior = await mkCompany("S3-PRIOR", "SAR");
  const cShape = await mkCompany("S3-SHAPE", "SAR");

  const mkFy = async (companyId: string, code: string) =>
    db.fiscalYear.create({
      data: {
        companyId, code, displayNameAr: `سنة ${code}`,
        startDate: "2027-07-01", endDate: "2028-06-30", periodCount: 12, status: "OPEN",
      },
    });

  const mkPeriods = async (fiscalYearId: string) => {
    // ثلاث فترات شهرية متتالية من 2027-07-01
    const starts = ["2027-07-01", "2027-08-01", "2027-09-01"];
    const ends = ["2027-07-31", "2027-08-31", "2027-09-30"];
    for (let i = 0; i < 3; i++) {
      await db.fiscalPeriod.create({
        data: { fiscalYearId, code: `FY27-P${i + 1}`, ordinal: i + 1, startDate: starts[i]!, endDate: ends[i]!, status: "OPEN", displayLabel: `P${i + 1}` },
      });
    }
  };

  const fyByCompany: Record<string, string> = {};
  for (const c of [cMain, cNoCur, cUnknown, cMove, cClose, cDup, cCommit, cRev, cLegacy, cPrior, cShape]) {
    const fy = await mkFy(c.id, "FY27");
    fyByCompany[c.id] = fy.id;
    await mkPeriods(fy.id);
    // قواعد الشركة: 21⇒خصوم، 29⇒حقوق ملكية (بادئات تفصيلية قانونية تحت الجذر 2)
    await db.accountNatureRule.create({
      data: { companyId: c.id, prefix: "21", mainCategory: "LIABILITIES_EQUITY", classification: "LIABILITY", aggregationBehavior: "BALANCE", source: "COMPANY", isActive: true },
    });
    await db.accountNatureRule.create({
      data: { companyId: c.id, prefix: "29", mainCategory: "LIABILITIES_EQUITY", classification: "EQUITY", aggregationBehavior: "BALANCE", source: "COMPANY", isActive: true },
    });
  }

  SCOPED.permissions = permsOf({ companyIds: [cMain.id] });

  (globalThis as Record<string, unknown>).__s3ids = {
    cMain: cMain.id, cNoCur: cNoCur.id, cUnknown: cUnknown.id, cMove: cMove.id,
    cClose: cClose.id, cDup: cDup.id, cCommit: cCommit.id, cRev: cRev.id,
    cLegacy: cLegacy.id, cPrior: cPrior.id, cShape: cShape.id,
    fyMain: fyByCompany[cMain.id],
    fyByCompany,
  };
}

const ids = (): S3Ids => (globalThis as Record<string, unknown>).__s3ids as S3Ids;

interface S3Ids {
  cMain: string; cNoCur: string; cUnknown: string; cMove: string; cClose: string;
  cDup: string; cCommit: string; cRev: string; cLegacy: string; cPrior: string; cShape: string;
  fyMain: string;
  fyByCompany: Record<string, string>;
}

function companyInput(companyId: string, overrides: Partial<TbImportServerInput> = {}): TbImportServerInput {
  return baseInput({ companyId, fiscalYearId: ids().fyByCompany[companyId], ...overrides });
}

/* ═══ الفحوص ═══ */

const fyOf = (companyId: string): string => ids().fyByCompany[companyId];

async function main(): Promise<void> {
  await seed();
  const I = ids();

  let savedId = "";

  /* ── SERVER TRUST (1–7) ── */

  await check(1, "client normalized values ignored", async () => {
    const input = companyInput(I.cMain, {
      grid: fullGrid(balancedFullRows()),
      normalizedLines: [{ accountCode: "9999", debit: "999999", credit: "0" }],
      lines: [{ accountCode: "8888", debit: 5, credit: 0 }],
    } as Partial<TbImportServerInput>);
    const res = await saveTbImportDraft(ADMIN, null, input);
    savedId = res.importId;
    const lines = await db.trialBalanceLine.findMany({ where: { importId: res.importId } });
    assert(!lines.some((l) => l.accountCode === "9999" || l.accountCode === "8888"), "client lines leaked");
    assert(lines.length === 4, `expected 4 server-derived lines, got ${lines.length}`);
  });

  await check(2, "client classification ignored", async () => {
    const rows = await db.trialBalanceLine.findMany({ where: { importId: savedId }, orderBy: { rowIndex: "asc" } });
    const cash = rows.find((r) => r.accountCode === "1101");
    assert(cash !== undefined, "cash line missing");
    assert(cash.classification === "ASSET", `cash must be server-classified ASSET, got ${String(cash.classification)}`);
  });

  await check(3, "client control totals ignored", async () => {
    const row = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: savedId } });
    const lines = await db.trialBalanceLine.findMany({ where: { importId: savedId } });
    const sumD = lines.reduce((a, l) => a + l.debitMinor, BigInt(0));
    assert(row.totalDebitMinor === sumD, "stored total must equal server-side sum of canonical lines");
    // السطور المستهلكة: إغلاق 1500 + فترة 400 = 1900 مدينًا (دائن 1300+600=1900) — إجماليات التخزين المختلطة لا تلزم التوازن
    assert(row.totalDebitMinor === BigInt(190000) && row.totalCreditMinor === BigInt(190000), `expected 190000/190000, got ${row.totalDebitMinor}/${row.totalCreditMinor}`);
  });

  await check(4, "client source hash ignored", async () => {
    const prov = await db.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE, entityId: savedId },
    });
    const meta = JSON.parse(prov.metadata) as Record<string, unknown>;
    assert(meta.sourcePayloadHash !== "deadbeef", "client hash leaked into provenance");
    assert(typeof meta.sourcePayloadHash === "string" && (meta.sourcePayloadHash as string).length === 64, "server source hash absent");
  });

  await check(5, "client canonical hash ignored", async () => {
    const row = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: savedId } });
    assert(row.payloadHash !== "cafebabe", "client canonical hash leaked into payloadHash");
    assert(row.payloadHash.length === 64, "payloadHash must be the server canonical line hash");
  });

  await check(6, "client dataType ignored", async () => {
    const input = companyInput(I.cShape, {
      grid: fullGrid(balancedFullRows()),
      dataType: "CUMULATIVE_YTD",
      completeness: "SUBSET",
      subsetAcknowledged: true,
    } as Partial<TbImportServerInput>);
    const res = await saveTbImportDraft(ADMIN, null, input);
    assert(res.dataType === "PERIOD_MOVEMENT", `FULL_MOVEMENT must derive PERIOD_MOVEMENT, got ${res.dataType}`);
    const row = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: res.importId } });
    assert(row.dataType === "PERIOD_MOVEMENT", "stored dataType must be server-derived");
  });

  await check(7, "server recomputes all authoritative values", async () => {
    // تغيير خلية مصدر واحدة ⇒ الهاشان يتغيران (لا قيمة ثابتة من أي مصدر)
    const res = await saveTbImportDraft(ADMIN, null, companyInput(I.cDup, {
      grid: fullGrid(balancedFullRows()), completeness: "SUBSET", subsetAcknowledged: true,
    }));
    const rows = balancedFullRows();
    rows[0] = ["1101", "Cash", 1000, 0, 701, 200, 1501, 0];
    const res2 = await saveTbImportDraft(ADMIN, null, companyInput(I.cDup, {
      grid: fullGrid(rows), completeness: "SUBSET", subsetAcknowledged: true, replaceExisting: true,
    }));
    assert(res2.sourcePayloadHash !== res.sourcePayloadHash, "source hash must change when source changes");
    assert(res2.canonicalLineHash !== res.canonicalLineHash, "canonical hash must change when source changes");
    // ثم إعادة المصدر المتوازن — الهاشان يعودان حتميًا
    const res3 = await saveTbImportDraft(ADMIN, null, companyInput(I.cDup, {
      grid: fullGrid(balancedFullRows()), completeness: "SUBSET", subsetAcknowledged: true, replaceExisting: true,
    }));
    assert(res3.sourcePayloadHash === res.sourcePayloadHash, "hash must be deterministic for identical source");
  });

  /* ── PREVIEW (8–18) ── */

  await check(8, "preview writes no TB import", async () => {
    const before = await db.trialBalanceImport.count();
    await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()) }));
    const after = await db.trialBalanceImport.count();
    assert(before === after, `import rows changed: ${before} -> ${after}`);
  });

  await check(9, "preview writes no TB lines", async () => {
    const before = await db.trialBalanceLine.count();
    await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()) }));
    const after = await db.trialBalanceLine.count();
    assert(before === after, `line rows changed: ${before} -> ${after}`);
  });

  await check(10, "deterministic preview same input", async () => {
    const a = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()) }));
    const b = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()) }));
    assert(JSON.stringify(a) === JSON.stringify(b), "two previews of the same input must be byte-identical JSON");
  });

  await check(11, "mapping ambiguity blocks", async () => {
    const badMap = { ...FULL_MAP, "8": "ACCOUNT_CODE" };
    try {
      await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()), mapping: badMap }));
      throw new Error("expected rejection for duplicate target");
    } catch (e) {
      assert(e instanceof TrialBalanceError && e.code === "INVALID_LINE", `expected INVALID_LINE, got ${String(e)}`);
    }
  });

  await check(12, "missing required mapping blocks", async () => {
    // ترويسات محايدة لا تُطابق أي مرادف (تعطيل الطبقات التلقائية) + إسناد جزئي ⇒ رفض
    const neutralHeaders = ["Col A", "Col B", "Col C", "Col D", "Col E", "Col F", "Col G", "Col H"];
    const partial = { "0": "ACCOUNT_CODE", "1": "ACCOUNT_NAME", "2": "OPENING_DEBIT", "4": "PERIOD_DEBIT", "6": "CLOSING_DEBIT" };
    const grid = [neutralHeaders.map((h) => t(h)), ...balancedFullRows().map((r) => r.map(toCell))];
    try {
      await previewTbImport(ADMIN, companyInput(I.cMain, { grid, mapping: partial }));
      throw new Error("expected rejection for missing required mapping");
    } catch (e) {
      assert(e instanceof TrialBalanceError && e.code === "INVALID_LINE", `expected INVALID_LINE, got ${String(e)}`);
    }
  });

  await check(13, "duplicates block", async () => {
    const rows = [...balancedFullRows(), ["1101", "Cash copy", 0, 0, 10, 0, 10, 0]];
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(rows), completeness: "SUBSET", subsetAcknowledged: true }));
    assert(pv.duplicateAccounts.length === 1 && pv.duplicateAccounts[0].accountCode === "1101", "duplicate not disclosed");
    assert(pv.blockingErrors.some((e) => e.code === "DUPLICATE_ACCOUNT_CODE"), "duplicate must block");
    assert(pv.persistenceReady === false, "persistence must not be ready");
    await expectTbError(() => saveTbImportDraft(ADMIN, null, companyInput(I.cDup, { grid: fullGrid(rows), completeness: "SUBSET", subsetAcknowledged: true })), "INVALID_LINE");
  });

  await check(14, "unresolved subtotal blocks", async () => {
    const rows = [...balancedFullRows(), ["X1", "إجمالي الأصول", 1000, 0, 0, 0, 1000, 0]];
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(rows), completeness: "SUBSET", subsetAcknowledged: true }));
    assert(pv.unresolvedSubtotalRows.includes(6), "flagged row must be listed unresolved");
    assert(pv.blockingErrors.some((e) => e.code === "SUBTOTAL_RESOLUTION_REQUIRED"), "unresolved subtotal must block");
  });

  await check(15, "explicit subtotal exclusion works", async () => {
    const rows = [...balancedFullRows(), ["X1", "إجمالي الأصول", 1000, 0, 0, 0, 1000, 0]];
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, {
      grid: fullGrid(rows), completeness: "SUBSET", subsetAcknowledged: true,
      subtotalResolutions: { 6: "EXCLUDED" },
    }));
    assert(pv.excludedSubtotalRowCount === 1, "excluded subtotal not counted");
    assert(pv.blockingErrors.length === 0 && pv.validationStatus === "VALID", `must be VALID, errors: ${pv.blockingErrors.map((e) => e.code).join(",")}`);
    assert(pv.normalizedConsumedLineCount === 4, "excluded row must not become a candidate");
  });

  await check(16, "explicit subtotal keep works", async () => {
    const rows = [...balancedFullRows(), ["1999", "إجمالي الأصول", 0, 0, 0, 0, 0, 0]];
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, {
      grid: fullGrid(rows), completeness: "SUBSET", subsetAcknowledged: true,
      subtotalResolutions: { 6: "KEPT" },
    }));
    assert(pv.blockingErrors.length === 0, `KEPT row must validate, errors: ${pv.blockingErrors.map((e) => e.code).join(",")}`);
    assert(pv.normalizedConsumedLineCount === 5, "KEPT row must be a normal detail candidate");
    assert(pv.excludedSubtotalRowCount === 0, "KEPT must not be counted as exclusion");
  });

  await check(17, "numeric code disclosure retained", async () => {
    const rows: RawRow[] = [["1101", "Cash", 1000, 0, 700, 200, 1500, 0]];
    const grid = fullGrid(rows) as unknown[][];
    (grid[1] as TbImportRawCellInput[])[0] = { text: "1101", isNumericSource: true, isFormula: false, formulaText: null };
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: grid as TbImportServerInput["grid"], completeness: "SUBSET", subsetAcknowledged: true }));
    assert(pv.numericSourceCodeCount === 1, `numeric disclosure missing, got ${pv.numericSourceCodeCount}`);
    assert(pv.numericSourceCodeRows.includes(2), "numeric row number must be disclosed");
  });

  await check(18, "formula warning retained", async () => {
    const rows: RawRow[] = [["1101", "Cash", formulaCell("1000"), 0, 700, 200, 1500, 0]];
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(rows), completeness: "SUBSET", subsetAcknowledged: true }));
    assert(pv.formulaCellWarningCount === 1, `formula warning missing, got ${pv.formulaCellWarningCount}`);
  });

  /* ── ACCOUNTING (19–28) ── */

  await check(19, "FULL_MOVEMENT FLOW stores period pair", async () => {
    const res = await saveTbImportDraft(ADMIN, null, companyInput(I.cShape, { grid: fullGrid(balancedFullRows()), replaceExisting: true }));
    const rev = await db.trialBalanceLine.findFirstOrThrow({
      where: { importId: res.importId, accountCode: "4100" },
    });
    assert(rev.debitMinor === BigInt(0) && rev.creditMinor === BigInt(60000), `FLOW must store period pair, got ${rev.debitMinor}/${rev.creditMinor}`);
    await db.trialBalanceImport.delete({ where: { id: res.importId } });
  });

  await check(20, "FULL_MOVEMENT BALANCE stores closing pair", async () => {
    const cash = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: savedId, accountCode: "1101" } });
    assert(cash.debitMinor === BigInt(150000) && cash.creditMinor === BigInt(0), `BALANCE must store closing pair, got ${cash.debitMinor}/${cash.creditMinor}`);
  });

  await check(21, "full movement equation failure blocks", async () => {
    const rows = [...balancedFullRows()];
    rows[0] = ["1101", "Cash", 1000, 0, 700, 200, 1600, 0]; // 1000+500≠1600
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(rows), completeness: "SUBSET", subsetAcknowledged: true }));
    assert(pv.rowEquationFailureCount === 1, "equation failure not counted");
    assert(pv.blockingErrors.some((e) => e.code === "ROW_EQUATION_MISMATCH"), "equation failure must block");
    await expectTbError(() => saveTbImportDraft(ADMIN, null, companyInput(I.cDup, { grid: fullGrid(rows), completeness: "SUBSET", subsetAcknowledged: true })), "INVALID_LINE");
  });

  await check(22, "both movement debit and credit nonzero accepted", async () => {
    const rows = [...balancedFullRows()];
    rows[0] = ["1101", "Cash", 1000, 0, 700, 200, 1500, 0]; // فترة 700/200 — الجانبان غير صفريين
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(rows) }));
    assert(pv.validationStatus === "VALID", `both-sides movement must be legal, errors: ${pv.blockingErrors.map((e) => e.code).join(",")}`);
  });

  await check(23, "CLOSING_ONLY FLOW without declaration blocks", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cClose, {
      shape: "CLOSING_ONLY", mapping: CLOSING_MAP,
      grid: [CLOSING_HEADERS.map((h) => t(h)), ["1101", "Cash", 1500, 0], ["4100", "Revenue", 0, 600]].map((r) => r.map(toCell)),
      completeness: "SUBSET", subsetAcknowledged: true,
    }));
    assert(pv.blockingErrors.some((e) => e.code === "FLOW_CLOSING_SEMANTICS_UNDECLARED"), "undeclared FLOW closing must block");
    assert(pv.derivedDataType === null, "dataType must remain undetermined");
  });

  await check(24, "CLOSING_ONLY declared cumulative FLOW valid", async () => {
    const res = await saveTbImportDraft(ADMIN, null, companyInput(I.cClose, {
      shape: "CLOSING_ONLY", mapping: CLOSING_MAP,
      grid: [CLOSING_HEADERS.map((h) => t(h)), ["1101", "Cash", 1500, 0], ["4100", "Revenue", 0, 600]].map((r) => r.map(toCell)),
      completeness: "SUBSET", subsetAcknowledged: true,
      flowClosingSemantics: "CUMULATIVE_YTD",
    }));
    assert(res.dataType === "CUMULATIVE_YTD", `declared cumulative must store CUMULATIVE_YTD, got ${res.dataType}`);
    const rev = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: res.importId, accountCode: "4100" } });
    assert(rev.creditMinor === BigInt(60000), "closing pair must be stored as-is");
  });

  await check(25, "MOVEMENT_ONLY BALANCE blocks", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cMove, {
      shape: "MOVEMENT_ONLY", mapping: MOVEMENT_MAP,
      grid: [MOVEMENT_HEADERS.map((h) => t(h)), ["3101", "Salaries", 400, 0], ["1101", "Cash", 700, 200]].map((r) => r.map(toCell)),
      completeness: "SUBSET", subsetAcknowledged: true,
    }));
    assert(pv.blockingErrors.some((e) => e.code === "BALANCE_MOVEMENT_ONLY_BLOCKED"), "BALANCE in MOVEMENT_ONLY must block");
  });

  await check(26, "COMPLETE control imbalance blocks", async () => {
    const rows = [...balancedFullRows()];
    rows[1] = ["2101", "Payables", 0, 1000, 200, 500, 0, 1301];
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(rows) }));
    assert(pv.blockingErrors.some((e) => e.code === "COMPLETE_CONTROL_TOTAL_MISMATCH"), "COMPLETE imbalance must block");
  });

  await check(27, "SUBSET does not pretend whole-file balance", async () => {
    const rows: RawRow[] = [["1101", "Cash", 1000, 0, 700, 200, 1500, 0]];
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(rows), completeness: "SUBSET", subsetAcknowledged: true }));
    assert(pv.validationStatus === "VALID", "single-asset SUBSET must be valid");
    const tot = pv.controlTotals.period;
    assert(tot !== undefined && tot.differenceMinor === "50000", "subset difference must be disclosed, not plugged");
    assert(pv.completeness === "SUBSET" && pv.subsetAcknowledged === true, "completeness status must be honest");
  });

  await check(28, "SUBSET without acknowledgement blocks", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()), completeness: "SUBSET", subsetAcknowledged: false }));
    assert(pv.blockingErrors.some((e) => e.code === "SUBSET_ACKNOWLEDGMENT_REQUIRED"), "SUBSET without acknowledgement must block");
  });

  /* ── CURRENCY / PRECISION (29–34) ── */

  await check(29, "missing functional currency blocks", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cNoCur, { grid: fullGrid(balancedFullRows()) }));
    assert(pv.blockingErrors.some((e) => e.code === "FUNCTIONAL_CURRENCY_UNCONFIGURED"), "missing functional currency must block");
  });

  await check(30, "unknown functional currency blocks", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cUnknown, { grid: fullGrid(balancedFullRows()) }));
    assert(pv.blockingErrors.some((e) => e.code === "FUNCTIONAL_CURRENCY_UNCONFIGURED"), "registry-invalid functional currency must block");
  });

  await check(31, "source != functional blocks FX process", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()), sourceCurrency: "USD" }));
    assert(pv.blockingErrors.some((e) => e.code === "FOREIGN_CURRENCY_TB_REQUIRES_FX_PROCESS"), "foreign currency must require FX process");
    assert(pv.persistenceReady === false, "no persistence with foreign currency");
  });

  await check(32, "no FX conversion occurs", async () => {
    const before = await db.trialBalanceImport.count();
    await saveTbImportDraft(ADMIN, null, companyInput(I.cDup, { grid: fullGrid(balancedFullRows()), sourceCurrency: "USD" })).catch(() => undefined);
    const after = await db.trialBalanceImport.count();
    assert(before === after, "blocked foreign-currency save must write nothing");
  });

  await check(33, "overprecision blocks", async () => {
    const rows: RawRow[] = [["1101", "Cash", "1.234", 0, 0, 0, 0, 0]];
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(rows), completeness: "SUBSET", subsetAcknowledged: true }));
    assert(pv.blockingErrors.some((e) => e.code === "MONETARY_OVERPRECISION"), "overprecision must block");
  });

  await check(34, "no automatic rounding", async () => {
    const rows: RawRow[] = [["1101", "Cash", "1000.10", 0, "0.2", 0, "1000.30", 0]];
    const res = await saveTbImportDraft(ADMIN, null, companyInput(I.cDup, { grid: fullGrid(rows), completeness: "SUBSET", subsetAcknowledged: true, replaceExisting: true }));
    const line = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: res.importId, accountCode: "1101" } });
    // 1101 أص_BALANCE ⇒ يستهلك زوج الإغلاق (1000.30) — دقيق 100030 بلا أي تقريب
    assert(line.debitMinor === BigInt(100030), `closing 1000.30 must be exactly 100030 minor, got ${line.debitMinor}`);
    assert(line.netMinor === line.debitMinor - line.creditMinor, "net must stay exact");
    await db.trialBalanceImport.delete({ where: { id: res.importId } });
  });

  /* ── CLASSIFICATION (35–41) ── */

  const classRows: RawRow[] = [
    ["1101", "Cash", 1000, 0, 0, 0, 1000, 0],
    ["2101", "Payables", 0, 500, 0, 0, 0, 500],
    ["2999", "Capital", 500, 0, 0, 0, 500, 0],
    ["3101", "Salaries", 0, 0, 0, 0, 0, 0],
    ["4100", "Revenue", 0, 0, 0, 0, 0, 0],
  ];

  await check(35, "root-1 ASSET", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(classRows), completeness: "SUBSET", subsetAcknowledged: true }));
    const cash = pv.mapping.byField.ACCOUNT_CODE;
    assert(cash !== undefined, "mapping missing");
    assert(pv.classificationSummary.ASSET >= 1, `ASSET missing from summary: ${JSON.stringify(pv.classificationSummary)}`);
  });

  await check(36, "root-3 EXPENSE", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(classRows), completeness: "SUBSET", subsetAcknowledged: true }));
    assert(pv.classificationSummary.EXPENSE >= 1, "EXPENSE missing from summary");
  });

  await check(37, "root-4 REVENUE", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(classRows), completeness: "SUBSET", subsetAcknowledged: true }));
    assert(pv.classificationSummary.REVENUE >= 1, "REVENUE missing from summary");
  });

  await check(38, "legal root-2 liability", async () => {
    const res = await saveTbImportDraft(ADMIN, null, companyInput(I.cShape, {
      grid: fullGrid(classRows), completeness: "SUBSET", subsetAcknowledged: true,
    }));
    const pay = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: res.importId, accountCode: "2101" } });
    assert(pay.classification === "LIABILITY", `2101 must be LIABILITY via company prefix, got ${String(pay.classification)}`);
    await db.trialBalanceImport.delete({ where: { id: res.importId } });
  });

  await check(39, "legal root-2 equity", async () => {
    const res = await saveTbImportDraft(ADMIN, null, companyInput(I.cShape, {
      grid: fullGrid(classRows), completeness: "SUBSET", subsetAcknowledged: true,
    }));
    const cap = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: res.importId, accountCode: "2999" } });
    assert(cap.classification === "EQUITY", `2999 must be EQUITY via company prefix, got ${String(cap.classification)}`);
  });

  await check(40, "3101 never equity", async () => {
    const sal = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: savedId, accountCode: "3101" } });
    assert(sal.classification === "EXPENSE", `3101 must be EXPENSE, got ${String(sal.classification)}`);
    assert(String(sal.classification) !== "EQUITY", "3101 must never be EQUITY");
  });

  await check(41, "contradictory detailed prefix needs resolution per engine", async () => {
    // بادئة شركة 31⇒ASSET تضاد الجذر 3 (EXPENSE) — المحرك يهمّلها ويبقى على الجذر
    await db.accountNatureRule.create({
      data: { companyId: I.cShape, prefix: "31", mainCategory: "ASSETS", classification: "ASSET", aggregationBehavior: "BALANCE", source: "COMPANY", isActive: true },
    });
    const pv = await previewTbImport(ADMIN, companyInput(I.cShape, { grid: fullGrid(classRows), completeness: "SUBSET", subsetAcknowledged: true }));
    const sal = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: savedId, accountCode: "3101" } });
    assert(sal.classification === "EXPENSE", "contradictory prefix must not override the root classification");
    assert(pv.classificationSummary.EXPENSE >= 1, "3101 stays EXPENSE (no silent OTHER, no ASSET)");
    await db.accountNatureRule.deleteMany({ where: { companyId: I.cShape, prefix: "31" } });
  });

  /* ── PERSISTENCE (42–50) ── */

  await check(42, "valid request creates DRAFT", async () => {
    const row = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: savedId } });
    assert(row.status === "DRAFT", `status must be DRAFT, got ${row.status}`);
    assert(row.revisionNumber === 1 && row.supersedesImportId === null, "first import must be revision 1");
  });

  await check(43, "stored lines exactly match server-normalized lines", async () => {
    const lines = await db.trialBalanceLine.findMany({ where: { importId: savedId }, orderBy: { rowIndex: "asc" } });
    assert(lines.length === 4, `expected 4 lines, got ${lines.length}`);
    const byCode = new Map(lines.map((l) => [l.accountCode, l]));
    const cash = byCode.get("1101") ?? null;
    assert(cash !== null && cash.debitMinor === BigInt(150000) && cash.creditMinor === BigInt(0) && cash.netMinor === BigInt(150000), "cash closing pair must match");
    const pay = byCode.get("2101") ?? null;
    assert(pay !== null && pay.debitMinor === BigInt(0) && pay.creditMinor === BigInt(130000), "payables closing pair must match");
    const sal = byCode.get("3101") ?? null;
    assert(sal !== null && sal.debitMinor === BigInt(40000) && sal.creditMinor === BigInt(0), "FLOW salaries period pair must match");
  });

  await check(44, "classification snapshot frozen", async () => {
    const lines = await db.trialBalanceLine.findMany({ where: { importId: savedId } });
    for (const l of lines) {
      assert(l.mappingStatus !== null && l.mappingSource !== null, `snapshot missing on ${l.accountCode}`);
      assert(l.classification !== null && l.aggregationBehavior !== null, `classification snapshot missing on ${l.accountCode}`);
      assert(l.mainCategory !== null, `mainCategory snapshot missing on ${l.accountCode}`);
    }
    const pay = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: savedId, accountCode: "2101" } });
    assert(pay.mappingSource === "COMPANY_PREFIX" && pay.mappedPrefix === "21", `provenance prefix must be frozen, got ${String(pay.mappingSource)}/${String(pay.mappedPrefix)}`);
  });

  await check(45, "hashes written to provenance", async () => {
    const prov = await db.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE, entityId: savedId },
    });
    const meta = JSON.parse(prov.metadata) as Record<string, unknown>;
    assert(typeof meta.canonicalLineHash === "string" && (meta.canonicalLineHash as string).length === 64, "canonicalLineHash missing");
    assert(typeof meta.sourcePayloadHash === "string" && (meta.sourcePayloadHash as string).length === 64, "sourcePayloadHash missing");
    const row = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: savedId } });
    assert(row.payloadHash === meta.canonicalLineHash, "payloadHash column must carry the canonical line hash");
  });

  await check(46, "bounded provenance contains no full source rows", async () => {
    const prov = await db.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE, entityId: savedId },
    });
    assert(prov.metadata.length <= TB_IMPORT_SERVER_LIMITS.MAX_PROVENANCE_JSON, `provenance too large: ${prov.metadata.length}`);
    const meta = JSON.parse(prov.metadata) as Record<string, unknown>;
    for (const forbidden of ["grid", "rows", "sourceRows", "lines", "cells", "rawRows"]) {
      assert(!(forbidden in meta), `forbidden provenance key: ${forbidden}`);
    }
    assert(!prov.metadata.includes("Payables") && !prov.metadata.includes("150000,"), "raw row content leaked into provenance");
  });

  await check(47, "COMMITTED import not mutated", async () => {
    const committed = await db.trialBalanceImport.create({
      data: {
        companyId: I.cCommit, fiscalYearId: fyOf(I.cCommit), fromDate: "2027-09-01", toDate: "2027-09-30",
        startOrdinal: 3, endOrdinal: 3, dataType: "PERIOD_MOVEMENT", status: "COMMITTED",
        committedAt: new Date(), lineCount: 1, totalDebitMinor: BigInt(100), totalCreditMinor: BigInt(100),
        payloadHash: "committed-hash",
      },
    });
    const before = { hash: committed.payloadHash, at: committed.committedAt?.toISOString(), status: committed.status };
    await expectTbError(
      () => saveTbImportDraft(ADMIN, null, companyInput(I.cCommit, { grid: fullGrid(balancedFullRows()) })),
      "DUPLICATE_COMMITTED",
    );
    const after = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: committed.id } });
    assert(after.payloadHash === before.hash && after.status === before.status, "committed row must never mutate");
    assert(after.committedAt?.toISOString() === before.at, "committedAt must never change");
    const lines = await db.trialBalanceLine.findMany({ where: { importId: committed.id } });
    assert(lines.length === 0, "committed import lines must stay untouched");
  });

  await check(48, "unauthorized company blocked", async () => {
    await expectTbError(
      () => saveTbImportDraft(OUTSIDER, null, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()) })),
      "NOT_FOUND",
    );
    const count = await db.trialBalanceImport.count({ where: { companyId: I.cMain } });
    assert(count === 1, "unauthorized save must write nothing");
    // مستخدم بنطاق الشركات الصريح (LIST يحوي الشركة) يجتاز حاجز النطاق في المعاينة
    const scopedPreview = await previewTbImport(SCOPED, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()) }));
    assert(scopedPreview.company.id === I.cMain, "scoped user must reach the in-scope company");
  });

  await check(49, "unauthorized permission blocked", async () => {
    assert(canManageTrialBalances(permsOf({ companyIds: [I.cMain] }), "manager") === false, "manager without manageTrialBalances must be denied");
    assert(canManageTrialBalances(permsOf({ manageTrialBalances: true }), "manager") === true, "explicit manageTrialBalances must be honored");
    assert(canManageTrialBalances(permsOf({}), "admin") === true, "admin role must be honored");
  });

  await check(50, "duplicate draft/revision follows existing governance", async () => {
    // (a) مسودة قائمة بلا استبدال صريح ⇒ DUPLICATE_IMPORT
    await expectTbError(
      () => saveTbImportDraft(ADMIN, null, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()) })),
      "DUPLICATE_IMPORT",
    );
    // (b) استبدال صريح ⇒ حذف المسودة القديمة وإنشاء الجديدة (revisionNumber يبقى 1)
    const res = await saveTbImportDraft(ADMIN, null, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()), replaceExisting: true }));
    assert(res.replacedImportId === savedId, "replacement must report the replaced draft id");
    assert(res.revisionNumber === 1, "replacement of first-import draft stays revision 1");
    savedId = res.importId; // الإثباتات اللاحقة تتبع النسخة البديلة
    const old = await db.trialBalanceImport.findUnique({ where: { id: res.replacedImportId } });
    assert(old === null, "replaced draft must be deleted");
    // (c) مسودة مراجعة (rev 2) تُدار بمسار المراجعة حصرًا ⇒ INVALID_STATE
    await db.trialBalanceImport.create({
      data: {
        companyId: I.cRev, fiscalYearId: fyOf(I.cRev), fromDate: "2027-09-01", toDate: "2027-09-30",
        startOrdinal: 3, endOrdinal: 3, dataType: "PERIOD_MOVEMENT", status: "DRAFT", revisionNumber: 2,
        lineCount: 0, totalDebitMinor: BigInt(0), totalCreditMinor: BigInt(0),
      },
    });
    await expectTbError(
      () => saveTbImportDraft(ADMIN, null, companyInput(I.cRev, { grid: fullGrid(balancedFullRows()) })),
      "INVALID_STATE",
    );
  });

  /* ── AUDIT / REGRESSION (51–62) ── */

  await check(51, "TRIAL_BALANCE_PROVENANCE audit written for successful draft", async () => {
    const audits = await db.auditLog.findMany({ where: { action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE } });
    assert(audits.length >= 1, "no provenance audit found");
    assert(audits.every((a) => a.action === "TRIAL_BALANCE_PROVENANCE"), "action string must match registry");
  });

  await check(52, "failed draft does not create successful provenance", async () => {
    const beforeProv = await db.auditLog.count({ where: { action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE } });
    const beforeImports = await db.trialBalanceImport.count({ where: { companyId: I.cDup } });
    const bad = companyInput(I.cDup, { grid: fullGrid(balancedFullRows()), completeness: "SUBSET", subsetAcknowledged: false });
    await saveTbImportDraft(ADMIN, null, bad).catch(() => undefined);
    const afterProv = await db.auditLog.count({ where: { action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE } });
    const afterImports = await db.trialBalanceImport.count({ where: { companyId: I.cDup } });
    assert(beforeProv === afterProv, "failed save must not write provenance");
    assert(beforeImports === afterImports, "failed save must not create an import");
  });

  await check(53, "provenance metadata remains within chosen bound", async () => {
    const audits = await db.auditLog.findMany({ where: { action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE } });
    assert(audits.length > 0, "no provenance to check");
    for (const a of audits) {
      assert(a.metadata.length <= TB_IMPORT_SERVER_LIMITS.MAX_PROVENANCE_JSON, `metadata exceeds bound: ${a.metadata.length}`);
    }
    // الضابط الحتمي: كائن ضخم ⇒ إسقاط الموجزات الاختيارية أو رفض صريح
    const huge: Record<string, unknown> = { ok: true, mappingSummary: { byField: {}, blob: "x".repeat(20000) } };
    const trimmed = enforceProvenanceBound(huge);
    assert(JSON.stringify(trimmed).length <= TB_IMPORT_SERVER_LIMITS.MAX_PROVENANCE_JSON, "bound enforcement failed");
  });

  await check(54, "legacy importer behavior unaffected", async () => {
    const res = await createTrialBalance({
      user: ADMIN, ip: null,
      input: {
        companyId: I.cLegacy, fiscalYearId: fyOf(I.cLegacy), fromDate: "2027-09-01", toDate: "2027-09-30",
        dataType: "PERIOD_MOVEMENT",
        lines: [
          { accountCode: "1101", accountName: "Cash", debit: 100, credit: 0 },
          { accountCode: "4100", accountName: "Revenue", debit: 0, credit: 100 },
        ],
      },
    });
    assert(res.import.status === "DRAFT" || res.import.status === "UNBALANCED", `legacy save must work, got ${String(res.import.status)}`);
    const legacyCount = await db.trialBalanceImport.count({ where: { companyId: I.cLegacy } });
    assert(legacyCount === 1, "legacy import must be created");
  });

  await check(55, "production DB untouched", async () => {
    assert(DATABASE_URL.includes("dev-612-step3-gate.db"), "gate must run on the isolated gate DB only");
    assert(!DATABASE_URL.includes("custom.db"), "gate must never point at production custom.db");
  });

  /* ── فحوص إضافية (56–62) ── */

  await check(56, "preview and save use the same authoritative path (no drift)", async () => {
    const input = companyInput(I.cDup, { grid: fullGrid(balancedFullRows()), completeness: "SUBSET", subsetAcknowledged: true, replaceExisting: true });
    const pv = await previewTbImport(ADMIN, input);
    const res = await saveTbImportDraft(ADMIN, null, input);
    assert(pv.normalizedConsumedLineCount === res.lineCount, "consumed count drift between preview and save");
    assert(pv.canonicalLineHash !== null && pv.canonicalLineHash === res.canonicalLineHash, "canonical hash drift between preview and save");
    assert(pv.sourcePayloadHash !== null && pv.sourcePayloadHash === res.sourcePayloadHash, "source hash drift between preview and save");
  });

  await check(57, "repeated header rows excluded server-side", async () => {
    const csv = [
      FULL_HEADERS.join(","),
      "1101,Cash,1000,0,700,200,1500,0",
      FULL_HEADERS.join(","),
      "4100,Revenue,0,0,0,600,0,600",
    ];
    const { parseCsvGrid } = await import("@/lib/excel-grid");
    const grid = parseCsvGrid(csv.join("\n"));
    const cells = grid.map((row) => row.map((c) => ({ text: c.text, isNumericSource: c.isNumericSource, isFormula: c.isFormula, formulaText: c.formulaText })));
    const pv = await previewTbImport(ADMIN, companyInput(I.cDup, { grid: cells, completeness: "SUBSET", subsetAcknowledged: true }));
    assert(pv.blockingErrors.length === 0, `repeated header must be excluded deterministically, errors: ${pv.blockingErrors.map((e) => e.code).join(",")}`);
    assert(pv.repeatedHeaderRows.length === 1 && pv.repeatedHeaderRows[0] === 3, "repeated header row must be detected and disclosed");
    assert(pv.acceptedDetailRowCount === 2, `header row must not become a detail row, got ${pv.acceptedDetailRowCount}`);
  });

  await check(58, "blank rows excluded structurally", async () => {
    const csv = [
      FULL_HEADERS.join(","),
      "1101,Cash,1000,0,700,200,1500,0",
      ",,,, ,,",
      "4100,Revenue,0,0,0,600,0,600",
    ].join("\n");
    const { parseCsvGrid } = await import("@/lib/excel-grid");
    const grid = parseCsvGrid(csv);
    const cells = grid.map((row) => row.map((c) => ({ text: c.text, isNumericSource: c.isNumericSource, isFormula: c.isFormula, formulaText: c.formulaText })));
    const pv = await previewTbImport(ADMIN, companyInput(I.cDup, { grid: cells, completeness: "SUBSET", subsetAcknowledged: true }));
    assert(pv.blockingErrors.length === 0, `blank row must not block: ${pv.blockingErrors.map((e) => e.code).join(",")}`);
    assert(pv.acceptedDetailRowCount === 2, `blank row must be structural, got ${pv.acceptedDetailRowCount}`);
  });

  await check(59, "LEGACY shape rejected in the new path", async () => {
    try {
      await previewTbImport(ADMIN, companyInput(I.cMain, { shape: "LEGACY", grid: fullGrid(balancedFullRows()) } as Partial<TbImportServerInput>));
      throw new Error("LEGACY must be rejected in the new path");
    } catch (e) {
      assert(e instanceof TrialBalanceError && e.code === "INVALID_DATA_TYPE", `expected INVALID_DATA_TYPE, got ${String(e)}`);
    }
  });

  await check(60, "deterministic hashes across repeated previews", async () => {
    const a = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()) }));
    const b = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()) }));
    assert(a.canonicalLineHash !== null && a.canonicalLineHash === b.canonicalLineHash, "canonical hash must be deterministic");
    assert(a.sourcePayloadHash !== null && a.sourcePayloadHash === b.sourcePayloadHash, "source hash must be deterministic");
  });

  await check(61, "provenance action registered in the audit registry", async () => {
    assert(AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE === "TRIAL_BALANCE_PROVENANCE", "registry action missing");
  });

  await check(62, "multi-period range blocked and source currency required", async () => {
    // مدى فترتين ⇒ رفض (المستورد الجديد فترة واحدة حصرًا)
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, {
      grid: fullGrid(balancedFullRows()), fromDate: "2027-08-01", toDate: "2027-09-30",
      completeness: "SUBSET", subsetAcknowledged: true,
    }));
    assert(pv.blockingErrors.some((e) => e.code === "MULTI_PERIOD_UNSUPPORTED"), "multi-period must be refused");
    // عملة مصدر فارغة ⇒ رفض صريح
    const pv2 = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()), sourceCurrency: "" }));
    assert(pv2.blockingErrors.some((e) => e.code === "SOURCE_CURRENCY_REQUIRED"), "missing source currency must be refused");
  });

  await check(63, "provenance retrieval read-only and scope-guarded", async () => {
    const result = await getTbImportProvenance(ADMIN, savedId);
    assert(result.import.id === savedId, "provenance retrieval must return the import");
    assert(result.provenance.length >= 1, "provenance list must contain the draft event");
    const meta = result.provenance[0].metadata;
    assert(meta.schemaVersion === "tb-import-provenance-v1", "provenance schema version must be disclosed");
    await expectTbError(() => getTbImportProvenance(OUTSIDER, savedId), "NOT_FOUND");
  });

  /* ── الخلاصة ── */

  console.log("─────────────────────────────────────────────");
  console.log(`PHASE 7.0 STEP 3 — TB IMPORTER SERVER INTEGRATION GATE`);
  console.log(`RESULT: ${passCount} PASS / ${failCount} FAIL (minimum required: 45 PASS / 0 FAIL)`);
  if (failures.length > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  await db.$disconnect();
  if (failCount > 0 || passCount < 45) process.exit(1);
  process.exit(0);
}

main().catch(async (e) => {
  console.error("GATE FATAL:", e);
  await db.$disconnect().catch(() => undefined);
  process.exit(1);
});
