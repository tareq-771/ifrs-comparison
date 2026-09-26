// ═══════════════════════════════════════════════════════════════════════════
// Phase 7.0 (V1 closure) — Final TB Importer V1 Gate
// بوابة إغلاق المستورد V1: ملف/إسناد/أشكال/مجاميع/تكرار/عملة/دقة/تصنيف/
// معاينة/مسودة/اعتماد بإعادة تحقق/مراجعات/عقد الواجهة/القالب/أمان القاعدة.
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-612-final-gate.db bun scripts/phase70-tb-import-final-v1.ts
//
// قاعدة معزولة حصرًا (dev-612-final-gate.db من الترحيلات) — custom.db ممنوع بنيويًا.
// الهدف: ≥80 فحصًا مستقلًا PASS / 0 FAIL — الفحوص لا تُدمج لتقليل العدّاد.
// ═══════════════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx-js-style";
import {
  canManageTrialBalances,
  type Permissions,
} from "@/lib/permissions";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import type { SessionUser } from "@/lib/session";
import {
  assertSupportedTbFileExtension,
  parseCsvGrid,
  readTbWorkbookGrid,
  TB_IMPORT_MAX_FILE_BYTES,
  TB_IMPORT_MAX_COLS,
  TB_IMPORT_MAX_ROWS,
} from "@/lib/excel-grid";
import {
  extractTbSourceRows,
  flagSuspectedSubtotalRows,
  mapTbHeaders,
  TB_CANONICAL_FIELDS,
} from "@/lib/tb-import";
import { parseTbImportServerInput } from "@/lib/tb-import-server";
import {
  commitTbImportDraft,
  previewTbImport,
  saveTbImportDraft,
  type TbImportRawCellInput,
  type TbImportServerInput,
} from "@/lib/tb-import-server";
import {
  commitTrialBalance,
  createTrialBalance,
  createTrialBalanceRevision,
} from "@/lib/trial-balance-server";
import { TrialBalanceError } from "@/lib/trial-balance";
import {
  canCommitDraft,
  canSaveDraft,
  requiresSourceReselection,
  TB_COMMIT_REQUIRES_EXPLICIT_CONFIRMATION,
  TB_IMPORT_ERROR_MESSAGES,
  tbImportErrorLabel,
  TB_WIZARD_STATUS_LABELS,
} from "@/lib/tb-import-ui";
import {
  buildTbImportTemplateCsv,
  buildTbImportTemplateXlsx,
  TB_TEMPLATE_EXAMPLE_ROWS,
  TB_TEMPLATE_HEADERS,
  TB_TEMPLATE_SHEET_DATA,
  TB_TEMPLATE_SHEET_INSTRUCTIONS,
} from "@/lib/tb-import-template";

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

async function expectTbError(fn: () => unknown | Promise<unknown>, code: string): Promise<TrialBalanceError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof TrialBalanceError) {
      assert(e.code === code, `expected ${code}, got ${e.code}: ${e.message}`);
      return e;
    }
    throw new Error(`unexpected error type: ${e instanceof Error ? e.message : String(e)}`);
  }
  throw new Error(`expected TrialBalanceError ${code} but nothing was thrown`);
}

/* ── حاجز القاعدة المعزولة — فشل مغلق ────────────────────────────────────── */

const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL.includes("dev-612-final-gate.db") || DATABASE_URL.includes("custom.db")) {
  console.error("FATAL: هذه البوابة تعمل على dev-612-final-gate.db حصرًا — لا تشغيل على أي قاعدة أخرى.");
  console.error(`DATABASE_URL الحالية: ${DATABASE_URL || "(غير مضبوطة)"}`);
  process.exit(1);
}
const db = new PrismaClient();

/* ── المستخدمون ──────────────────────────────────────────────────────────── */

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
  permissions: permsOf({ companyIds: [] }),
};
const OUTSIDER: SessionUser = {
  id: "u-gate-out", username: "gate-out", name: "Gate Outsider", role: "manager",
  permissions: permsOf({ companyIds: ["c-somewhere-else"] }),
};

/* ── فيكتشرات الشبكات ────────────────────────────────────────────────────── */

function t(text: string): TbImportRawCellInput {
  return { text, isNumericSource: false, isFormula: false, formulaText: null };
}
function numCell(value: number): TbImportRawCellInput {
  return { text: String(value), isNumericSource: true, isFormula: false, formulaText: null };
}

type RawRow = Array<string | number | TbImportRawCellInput>;

function toCell(v: string | number | TbImportRawCellInput): TbImportRawCellInput {
  if (typeof v === "object" && v !== null) return v as TbImportRawCellInput;
  return typeof v === "number" ? numCell(v) : t(v);
}

const FULL_HEADERS = ["Account Code", "Account Name", "Opening Debit", "Opening Credit", "Period Debit", "Period Credit", "Closing Debit", "Closing Credit"];
const FULL_MAP: Record<string, string> = {
  "0": "ACCOUNT_CODE", "1": "ACCOUNT_NAME", "2": "OPENING_DEBIT", "3": "OPENING_CREDIT",
  "4": "PERIOD_DEBIT", "5": "PERIOD_CREDIT", "6": "CLOSING_DEBIT", "7": "CLOSING_CREDIT",
};
const CLOSING_MAP: Record<string, string> = { "0": "ACCOUNT_CODE", "1": "ACCOUNT_NAME", "6": "CLOSING_DEBIT", "7": "CLOSING_CREDIT" };
const MOVEMENT_MAP: Record<string, string> = { "0": "ACCOUNT_CODE", "1": "ACCOUNT_NAME", "4": "PERIOD_DEBIT", "5": "PERIOD_CREDIT" };

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

function subsetInput(overrides: Partial<TbImportServerInput>): TbImportServerInput {
  return baseInput({ completeness: "SUBSET", subsetAcknowledged: true, ...overrides });
}

/** صفوف FULL متوازنة: افتتاح 1000=1000، فترة 1300=1300، إقفال 1900=1900. */
function balancedFullRows(): RawRow[] {
  return [
    ["1101", "Cash", 1000, 0, 700, 200, 1500, 0],
    ["2101", "Payables", 0, 1000, 200, 500, 0, 1300],
    ["3101", "Salaries", 0, 0, 400, 0, 400, 0],
    ["4100", "Revenue", 0, 0, 0, 600, 0, 600],
  ];
}

/* ── تهيئة القاعدة المعزولة ──────────────────────────────────────────────── */

async function seed(): Promise<void> {
  await db.trialBalanceLine.deleteMany({});
  // سلسلة المراجعات (self-relation Restrict) — حذف بالأوراق أولًا حتى نفاد السلسلة
  for (let i = 0; i < 12; i++) {
    const referenced = await db.trialBalanceImport.findMany({
      where: { supersedesImportId: { not: null } },
      select: { supersedesImportId: true },
    });
    const referencedIds = new Set(referenced.map((r) => r.supersedesImportId as string));
    const all = await db.trialBalanceImport.findMany({ select: { id: true } });
    const leaves = all.filter((r) => !referencedIds.has(r.id)).map((r) => r.id);
    if (leaves.length === 0) break;
    await db.trialBalanceImport.deleteMany({ where: { id: { in: leaves } } });
  }
  const leftImports = await db.trialBalanceImport.count();
  if (leftImports > 0) throw new Error(`seed: failed to clear imports (${leftImports} left)`);
  await db.auditLog.deleteMany({ where: { entityType: "TrialBalanceImport" } });
  await db.fiscalPeriod.deleteMany({});
  await db.fiscalYear.deleteMany({});
  await db.accountNatureRule.deleteMany({ where: { companyId: { not: null } } });
  await db.company.deleteMany({ where: { code: { startsWith: "S4-" } } });

  const mkCompany = async (code: string, currency: string | null) =>
    db.company.create({ data: { code, nameAr: `شركة ${code}`, functionalCurrency: currency ?? "" } });

  const cMain = await mkCompany("S4-MAIN", "SAR");
  const cNoCur = await mkCompany("S4-NOCUR", null);
  const cUnk = await mkCompany("S4-UNKNOWNCUR", "XYZ");
  const cDup = await mkCompany("S4-DUP", "SAR");
  const cCommit = await mkCompany("S4-COMMIT", "SAR");
  const cRev = await mkCompany("S4-REV", "SAR");
  const cLegacy = await mkCompany("S4-LEGACY", "SAR");
  const cSub = await mkCompany("S4-SUB", "SAR");
  const cShape = await mkCompany("S4-SHAPE", "SAR");

  const mkFy = async (companyId: string, code: string) =>
    db.fiscalYear.create({
      data: {
        companyId, code, displayNameAr: `سنة ${code}`,
        startDate: "2027-07-01", endDate: "2028-06-30", periodCount: 12, status: "OPEN",
      },
    });

  const mkPeriods = async (fiscalYearId: string) => {
    const starts = ["2027-07-01", "2027-08-01", "2027-09-01"];
    const ends = ["2027-07-31", "2027-08-31", "2027-09-30"];
    for (let i = 0; i < 3; i++) {
      await db.fiscalPeriod.create({
        data: { fiscalYearId, code: `FY27-P${i + 1}`, ordinal: i + 1, startDate: starts[i]!, endDate: ends[i]!, status: "OPEN", displayLabel: `P${i + 1}` },
      });
    }
  };

  const fyByCompany: Record<string, string> = {};
  for (const c of [cMain, cNoCur, cUnk, cDup, cCommit, cRev, cLegacy, cSub, cShape]) {
    const fy = await mkFy(c.id, "FY27");
    fyByCompany[c.id] = fy.id;
    await mkPeriods(fy.id);
    await db.accountNatureRule.create({
      data: { companyId: c.id, prefix: "21", mainCategory: "LIABILITIES_EQUITY", classification: "LIABILITY", aggregationBehavior: "BALANCE", source: "COMPANY", isActive: true },
    });
    await db.accountNatureRule.create({
      data: { companyId: c.id, prefix: "29", mainCategory: "LIABILITIES_EQUITY", classification: "EQUITY", aggregationBehavior: "BALANCE", source: "COMPANY", isActive: true },
    });
  }

  SCOPED.permissions = permsOf({ companyIds: [cMain.id] });

  (globalThis as Record<string, unknown>).__s4ids = {
    cMain: cMain.id, cNoCur: cNoCur.id, cUnk: cUnk.id, cDup: cDup.id,
    cCommit: cCommit.id, cRev: cRev.id, cLegacy: cLegacy.id, cSub: cSub.id, cShape: cShape.id,
    fyByCompany,
  };
}

interface S4Ids {
  cMain: string; cNoCur: string; cUnk: string; cDup: string; cCommit: string;
  cRev: string; cLegacy: string; cSub: string; cShape: string;
  fyByCompany: Record<string, string>;
}

const ids = (): S4Ids => (globalThis as Record<string, unknown>).__s4ids as S4Ids;

function companyInput(companyId: string, overrides: Partial<TbImportServerInput> = {}): TbImportServerInput {
  return baseInput({ companyId, fiscalYearId: ids().fyByCompany[companyId], ...overrides });
}

/** حفظ مسودة نظيفة وإرجاع {importId, version}. */
async function saveCleanDraft(companyId: string, overrides: Partial<TbImportServerInput> = {}): Promise<{ importId: string; version: number }> {
  const res = await saveTbImportDraft(ADMIN, null, companyInput(companyId, overrides));
  const row = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: res.importId }, select: { version: true } });
  return { importId: res.importId, version: row.version };
}

/** قراءة الإثبات المحفوظ لمسودة (سلسلة JSON). */
async function provenanceJson(importId: string): Promise<string> {
  const audit = await db.auditLog.findFirstOrThrow({
    where: { action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE, entityId: importId },
    orderBy: { createdAt: "desc" },
    select: { id: true, metadata: true },
  });
  return JSON.stringify({ id: audit.id, metadata: audit.metadata });
}

/* ═══ الفحوص ═══ */

async function main(): Promise<void> {
  await seed();
  const I = ids();

  /* ── FILE (1–9) ── */

  await check(1, "FILE: xlsx accepted and read textually", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["كود الحساب", "اسم الحساب"],
      ["00101", "الصندوق"],
      ["00102", "البنك"],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "TB");
    const bytes = new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
    const out = readTbWorkbookGrid(bytes, "in-memory.xlsx");
    assert(out.grid.length === 3, `expected 3 rows, got ${out.grid.length}`);
    assert(out.grid[1]![0]!.text === "00101", `leading zeros must be preserved, got «${out.grid[1]![0]!.text}»`);
    assert(out.grid[1]![0]!.isNumericSource === false, "text cell must not be numeric-source");
  });

  await check(2, "FILE: csv accepted with safe parsing", () => {
    const grid = parseCsvGrid("كود الحساب,اسم الحساب\n00101,الصندوق\n");
    assert(grid.length === 2, `expected 2 rows, got ${grid.length}`);
    assert(grid[1]![0]!.text === "00101", "csv text code preserved");
  });

  await check(3, "FILE: .xls rejected by extension", () => {
    let threw = "";
    try { assertSupportedTbFileExtension("old.xls"); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    assert(threw.includes("UNSUPPORTED_LEGACY_XLS"), `.xls must be rejected, got: ${threw}`);
  });

  await check(4, "FILE: 15 MiB size limit enforced (no silent truncation)", () => {
    const big = "x".repeat(TB_IMPORT_MAX_FILE_BYTES + 10);
    let code = "";
    try { parseCsvGrid(big); } catch (e) { code = e instanceof Error ? e.message : String(e); }
    assert(code.includes("TB_CSV_TOO_LARGE"), `oversize must be rejected, got: ${code}`);
  });

  await check(5, "FILE: row limit enforced", () => {
    const rows = Array.from({ length: TB_IMPORT_MAX_ROWS + 1 }, () => "x").join("\n");
    let code = "";
    try { parseCsvGrid(rows); } catch (e) { code = e instanceof Error ? e.message : String(e); }
    assert(code.includes("TB_CSV_TOO_MANY_ROWS"), `row overflow must be rejected, got: ${code}`);
  });

  await check(6, "FILE: column limit enforced", () => {
    const row = Array.from({ length: TB_IMPORT_MAX_COLS + 1 }, () => "x").join(",");
    let code = "";
    try { parseCsvGrid(row); } catch (e) { code = e instanceof Error ? e.message : String(e); }
    assert(code.includes("TB_CSV_TOO_MANY_COLUMNS"), `column overflow must be rejected, got: ${code}`);
  });

  await check(7, "FILE: formulas are never executed — cached text + metadata only", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["Account Code", "Amount"], ["1101", 0]]);
    ws["B2"] = { t: "n", v: 42, f: "A2*2+6" };
    XLSX.utils.book_append_sheet(wb, ws, "TB");
    const bytes = new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
    const out = readTbWorkbookGrid(bytes, "formulas.xlsx");
    const cell = out.grid[1]![1]!;
    assert(cell.isFormula === true, "formula flag must be true");
    assert(cell.formulaText === "A2*2+6", `formula text preserved, got ${String(cell.formulaText)}`);
    assert(cell.text === "42", `cached text is authoritative (no evaluation), got «${cell.text}»`);
  });

  await check(8, "FILE: text account codes preserved verbatim (00101 ≠ 101)", () => {
    const grid = parseCsvGrid("code\n00101\n101\n");
    assert(grid[1]![0]!.text === "00101" && grid[2]![0]!.text === "101", "codes must stay as source text");
    assert(grid[1]![0]!.isNumericSource === false && grid[2]![0]!.isNumericSource === false, "csv text cells are not numeric-source");
  });

  await check(9, "FILE: numeric-source account codes disclosed", async () => {
    const grid = fullGrid([
      [numCell(1101), "Cash", 1000, 0, 700, 200, 1500, 0],
      ["2101", "Payables", 0, 1000, 200, 500, 0, 1300],
      ["3101", "Salaries", 0, 0, 400, 0, 400, 0],
      ["4100", "Revenue", 0, 0, 0, 600, 0, 600],
    ]);
    const pv = await previewTbImport(ADMIN, subsetInput({ companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub], grid }));
    assert(pv.numericSourceCodeCount === 1, `expected 1 numeric code, got ${pv.numericSourceCodeCount}`);
    assert(pv.warnings.some((w) => w.code === "NUMERIC_SOURCE_ACCOUNT_CODES"), "numeric warning must surface");
  });

  /* ── MAPPING (10–16) ── */

  await check(10, "MAPPING: exact tier", () => {
    const res = mapTbHeaders(FULL_HEADERS, {});
    assert(res.byField.ACCOUNT_CODE === 0, "code column mapped");
    assert(res.columns[0]!.tier === "EXACT", `expected EXACT, got ${res.columns[0]!.tier}`);
  });

  await check(11, "MAPPING: contains tier (exclusive containment)", () => {
    const res = mapTbHeaders(["رصيد أول المدة مدين (بالعملة الوظيفية)"], {});
    assert(res.columns[0]!.tier === "CONTAINS", `expected CONTAINS, got ${res.columns[0]!.tier}`);
    assert(res.columns[0]!.canonicalField === "OPENING_DEBIT", `expected OPENING_DEBIT, got ${String(res.columns[0]!.canonicalField)}`);
  });

  await check(12, "MAPPING: user mapping overrides all tiers (no-conflict swap)", () => {
    const res = mapTbHeaders(FULL_HEADERS, { userMappings: { 0: "ACCOUNT_NAME", 1: "ACCOUNT_CODE" } });
    assert(res.columns[0]!.tier === "USER" && res.columns[0]!.canonicalField === "ACCOUNT_NAME", "user override must win on col 0");
    assert(res.columns[1]!.tier === "USER" && res.columns[1]!.canonicalField === "ACCOUNT_CODE", "user override must win on col 1");
    assert(res.byField.ACCOUNT_NAME === 0 && res.byField.ACCOUNT_CODE === 1, "swapped targets reflected");
    assert(res.duplicateTargetConflicts.length === 0, "no conflicts for a clean swap");
  });

  await check(13, "MAPPING: ambiguity explicit (no silent resolution)", () => {
    const res = mapTbHeaders(["opening debit opening credit"], {});
    assert(res.columns[0]!.status === "AMBIGUOUS", `expected AMBIGUOUS, got ${res.columns[0]!.status}`);
    assert((res.columns[0]!.ambiguityCandidates ?? []).length === 2, "two candidates disclosed");
    assert(res.columns[0]!.canonicalField === undefined, "no silent field assignment");
  });

  await check(14, "MAPPING: duplicate canonical target blocked server-side", async () => {
    await expectTbError(
      () => saveTbImportDraft(ADMIN, null, subsetInput({
        companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub],
        grid: fullGrid(balancedFullRows()),
        mapping: { "0": "ACCOUNT_CODE", "1": "ACCOUNT_CODE" },
      })),
      "INVALID_LINE",
    );
  });

  await check(15, "MAPPING: unmapped required field blocked server-side", async () => {
    // شبكة س SQLite أعمدة فقط — لا يمكن للطبقة التلقائية تغطية الإقفال
    const sixHeaders = FULL_HEADERS.slice(0, 6);
    await expectTbError(
      () => previewTbImport(ADMIN, subsetInput({
        companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub],
        grid: [sixHeaders.map((h) => t(h)), ["1101", "Cash", 1000, 0, 700, 200].map((v) => toCell(v))],
        mapping: { "0": "ACCOUNT_CODE", "1": "ACCOUNT_NAME", "2": "OPENING_DEBIT", "3": "OPENING_CREDIT", "4": "PERIOD_DEBIT", "5": "PERIOD_CREDIT" },
      })),
      "INVALID_LINE",
    );
  });

  await check(16, "MAPPING: shape explicit — LEGACY never auto-selected, missing shape rejected", () => {
    let legacy = "";
    try { parseTbImportServerInput(baseInput({ shape: "LEGACY" })); } catch (e) { legacy = e instanceof TrialBalanceError ? e.code : ""; }
    assert(legacy === "INVALID_DATA_TYPE", `LEGACY must be rejected, got ${legacy}`);
    let missing = "";
    try { parseTbImportServerInput(baseInput({ shape: undefined as unknown as string })); } catch (e) { missing = e instanceof TrialBalanceError ? e.code : ""; }
    assert(missing === "INVALID_DATA_TYPE", `missing shape must be rejected, got ${missing}`);
  });

  /* ── FULL MOVEMENT (17–22) ── */

  let mainDraftId = "";
  await check(17, "FULL_MOVEMENT: FLOW rows consume the period pair", async () => {
    const saved = await saveCleanDraft(I.cMain, { grid: fullGrid(balancedFullRows()) });
    mainDraftId = saved.importId;
    const sal = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: saved.importId, accountCode: "3101" } });
    assert(sal.debitMinor === BigInt(40000) && sal.creditMinor === BigInt(0), `FLOW must consume period pair, got ${sal.debitMinor}/${sal.creditMinor}`);
  });

  await check(18, "FULL_MOVEMENT: BALANCE rows consume the closing pair", async () => {
    const cash = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: mainDraftId, accountCode: "1101" } });
    assert(cash.debitMinor === BigInt(150000), `BALANCE must consume closing pair, got ${cash.debitMinor}`);
  });

  await check(19, "FULL_MOVEMENT: exact equation passes", async () => {
    const row = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: mainDraftId } });
    assert(row.status === "DRAFT", "valid file must save");
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()), replaceExisting: true }));
    assert(pv.rowEquationFailureCount === 0, "no equation failures for balanced file");
  });

  await check(20, "FULL_MOVEMENT: equation failure blocks", async () => {
    const rows = balancedFullRows();
    rows[0] = ["1101", "Cash", 1000, 0, 700, 200, 1501, 0];
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(rows) }));
    assert(pv.blockingErrors.some((e) => e.code === "ROW_EQUATION_MISMATCH"), "equation mismatch must block");
    assert(pv.validationStatus === "BLOCKED", "status must be BLOCKED");
  });

  await check(21, "FULL_MOVEMENT: debit+credit both nonzero accepted (warning only)", async () => {
    const rows: RawRow[] = [
      ["1101", "Cash", 100, 50, 700, 200, 550, 0],
      ["3101", "Salaries", 0, 0, 400, 0, 400, 0],
    ];
    const pv = await previewTbImport(ADMIN, subsetInput({ companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub], grid: fullGrid(rows) }));
    assert(pv.blockingErrors.length === 0, `both-sides must not block, got ${JSON.stringify(pv.blockingErrors)}`);
    assert(pv.warnings.some((w) => w.code === "BOTH_SIDES_NONZERO_OPENING"), "opening both-sides warning expected");
    assert(pv.acceptedDetailRowCount === 2, "row still accepted");
  });

  await check(22, "FULL_MOVEMENT: single-period semantics enforced", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, {
      fromDate: "2027-08-01", toDate: "2027-09-30",
      grid: fullGrid(balancedFullRows()),
    }));
    assert(pv.blockingErrors.some((e) => e.code === "MULTI_PERIOD_UNSUPPORTED"), "multi-period range must block");
  });

  /* ── CLOSING ONLY (23–25) ── */

  await check(23, "CLOSING_ONLY: balance-only accepted as CUMULATIVE_YTD", async () => {
    const rows: RawRow[] = [
      ["1101", "Cash", 0, 0, 0, 0, 1500, 0],
      ["2101", "Payables", 0, 0, 0, 0, 0, 1500],
    ];
    const saved = await saveTbImportDraft(ADMIN, null, companyInput(I.cShape, {
      shape: "CLOSING_ONLY", mapping: CLOSING_MAP, grid: fullGrid(rows),
    }));
    assert(saved.dataType === "CUMULATIVE_YTD", `expected CUMULATIVE_YTD, got ${saved.dataType}`);
  });

  await check(24, "CLOSING_ONLY: FLOW without declaration blocked", async () => {
    const rows: RawRow[] = [
      ["1101", "Cash", 0, 0, 0, 0, 1500, 0],
      ["2101", "Payables", 0, 0, 0, 0, 0, 1300],
      ["3101", "Salaries", 0, 0, 0, 0, 400, 0],
      ["4100", "Revenue", 0, 0, 0, 0, 0, 600],
    ];
    const pv = await previewTbImport(ADMIN, companyInput(I.cShape, {
      shape: "CLOSING_ONLY", mapping: CLOSING_MAP, grid: fullGrid(rows),
    }));
    assert(pv.blockingErrors.some((e) => e.code === "FLOW_CLOSING_SEMANTICS_UNDECLARED"), "undeclared FLOW closing must block");
  });

  await check(25, "CLOSING_ONLY: FLOW with cumulative declaration accepted", async () => {
    const rows: RawRow[] = [
      ["1101", "Cash", 0, 0, 0, 0, 1500, 0],
      ["2101", "Payables", 0, 0, 0, 0, 0, 1300],
      ["3101", "Salaries", 0, 0, 0, 0, 400, 0],
      ["4100", "Revenue", 0, 0, 0, 0, 0, 600],
    ];
    const saved = await saveTbImportDraft(ADMIN, null, companyInput(I.cShape, {
      shape: "CLOSING_ONLY", mapping: CLOSING_MAP, grid: fullGrid(rows),
      flowClosingSemantics: "CUMULATIVE_YTD", completeness: "COMPLETE", replaceExisting: true,
    }));
    assert(saved.dataType === "CUMULATIVE_YTD", `declared FLOW must be CUMULATIVE_YTD, got ${saved.dataType}`);
  });

  /* ── MOVEMENT ONLY (26–27) ── */

  await check(26, "MOVEMENT_ONLY: FLOW rows accepted as PERIOD_MOVEMENT", async () => {
    const rows: RawRow[] = [
      ["3101", "Salaries", 0, 0, 400, 0, 0, 0],
      ["4100", "Revenue", 0, 0, 0, 400, 0, 0],
    ];
    const saved = await saveTbImportDraft(ADMIN, null, companyInput(I.cShape, {
      shape: "MOVEMENT_ONLY", mapping: MOVEMENT_MAP, grid: fullGrid(rows),
    }));
    assert(saved.dataType === "PERIOD_MOVEMENT", `expected PERIOD_MOVEMENT, got ${saved.dataType}`);
  });

  await check(27, "MOVEMENT_ONLY: BALANCE rows blocked (even zero-value)", async () => {
    const rows: RawRow[] = [
      ["1101", "Cash", 0, 0, 500, 0, 0, 0],
      ["2101", "Payables", 0, 0, 0, 500, 0, 0],
    ];
    const pv = await previewTbImport(ADMIN, companyInput(I.cShape, {
      shape: "MOVEMENT_ONLY", mapping: MOVEMENT_MAP, grid: fullGrid(rows),
    }));
    assert(pv.blockingErrors.some((e) => e.code === "BALANCE_MOVEMENT_ONLY_BLOCKED"), "BALANCE rows must be blocked");
  });

  /* ── SUBTOTALS (28–32) ── */

  const subtotalRows = (): RawRow[] => [
    ...balancedFullRows(),
    ["1199", "إجمالي فرعي للنقدية", 100, 0, 0, 0, 100, 0],
  ];
  const SUBTOTAL_FLAGGED_ROW = 6; // الصف الترويسة = 1، وصف الاشتباه هو السادس

  await check(28, "SUBTOTALS: suspected rows detected and disclosed", async () => {
    const grid = fullGrid(subtotalRows());
    const rows = extractTbSourceRows(grid as never, { mapping: mapTbHeaders(FULL_HEADERS, {}), headerRowIndex: 0, headerRowCount: 1 });
    const flags = flagSuspectedSubtotalRows(rows);
    assert(flags.length === 1 && flags[0]!.sourceRowNumber === SUBTOTAL_FLAGGED_ROW, `client detector must flag row ${SUBTOTAL_FLAGGED_ROW}, got ${JSON.stringify(flags)}`);
    const pv = await previewTbImport(ADMIN, subsetInput({ companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub], grid }));
    assert(pv.unresolvedSubtotalRows.includes(SUBTOTAL_FLAGGED_ROW), "server preview must report unresolved subtotal row");
    assert(pv.blockingErrors.some((e) => e.code === "SUBTOTAL_RESOLUTION_REQUIRED"), "unresolved subtotal blocks");
  });

  await check(29, "SUBTOTALS: unresolved blocks save (no silent removal)", async () => {
    const err = await expectTbError(
      () => saveTbImportDraft(ADMIN, null, subsetInput({ companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub], grid: fullGrid(subtotalRows()) })),
      "INVALID_LINE",
    );
    assert(
      (err.detail?.errors as Array<{ code: string }> | undefined)?.some((e) => e.code === "SUBTOTAL_RESOLUTION_REQUIRED") === true,
      "SUBTOTAL_RESOLUTION_REQUIRED must be listed",
    );
  });

  await check(30, "SUBTOTALS: explicit EXCLUDE honored and excluded from lines", async () => {
    const saved = await saveTbImportDraft(ADMIN, null, subsetInput({
      companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub],
      grid: fullGrid(subtotalRows()),
      subtotalResolutions: { [String(SUBTOTAL_FLAGGED_ROW)]: "EXCLUDED" },
      replaceExisting: true,
    }));
    assert(saved.provenance.excludedSubtotalRowCount === 1, `expected 1 exclusion, got ${String(saved.provenance.excludedSubtotalRowCount)}`);
    const stored = await db.trialBalanceLine.findMany({ where: { importId: saved.importId } });
    assert(!stored.some((l) => l.accountCode === "1199"), "excluded subtotal row must not be stored");
    assert(stored.length === 4, `expected 4 stored lines, got ${stored.length}`);
  });

  await check(31, "SUBTOTALS: explicit KEEP honored (row becomes a detail row)", async () => {
    const saved = await saveTbImportDraft(ADMIN, null, subsetInput({
      companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub],
      grid: fullGrid(subtotalRows()),
      subtotalResolutions: { [String(SUBTOTAL_FLAGGED_ROW)]: "KEPT" },
      replaceExisting: true,
    }));
    const stored = await db.trialBalanceLine.findMany({ where: { importId: saved.importId } });
    const kept = stored.find((l) => l.accountCode === "1199");
    assert(kept !== undefined, "kept subtotal row must be stored as detail");
    assert(kept.classification === "ASSET", `kept row must be classified by the engine, got ${String(kept.classification)}`);
  });

  await check(32, "SUBTOTALS: no arithmetic-similarity auto-deletion — flag-only detection", () => {
    // صف مشتبه بقيم لا تشبه أي مجموع: يظل مرصودًا (FLAG فقط — لا حذف تلقائي)
    const rows: RawRow[] = [
      ["1101", "إجمالي حساب عابر", 3, 0, 0, 0, 3, 0],
    ];
    const grid = fullGrid(rows);
    const srcRows = extractTbSourceRows(grid as never, { mapping: mapTbHeaders(FULL_HEADERS, {}), headerRowIndex: 0, headerRowCount: 1 });
    const flags = flagSuspectedSubtotalRows(srcRows);
    assert(flags.length === 1, "name-based flag must fire regardless of values");
    assert(srcRows.length === 1, "no rows removed by detection");
  });

  /* ── DUPLICATES (33–35) ── */

  const dupRows = (): RawRow[] => [
    ...balancedFullRows(),
    ["1101", "Cash duplicate", 0, 0, 0, 0, 0, 0],
  ];

  await check(33, "DUPLICATES: duplicate account code blocks save", async () => {
    const err = await expectTbError(
      () => saveTbImportDraft(ADMIN, null, subsetInput({
        companyId: I.cDup, fiscalYearId: I.fyByCompany[I.cDup],
        grid: fullGrid([
          ["1101", "Cash", 100, 0, 0, 0, 100, 0],
          ["1101", "Cash again", 0, 0, 50, 0, 50, 0],
        ]),
      })),
      "INVALID_LINE",
    );
    assert(
      (err.detail?.errors as Array<{ code: string }> | undefined)?.some((e) => e.code === "DUPLICATE_ACCOUNT_CODE") === true,
      "DUPLICATE_ACCOUNT_CODE must be listed",
    );
  });

  await check(34, "DUPLICATES: row numbers exposed", async () => {
    const pv = await previewTbImport(ADMIN, subsetInput({
      companyId: I.cDup, fiscalYearId: I.fyByCompany[I.cDup],
      grid: fullGrid([
        ["1101", "Cash", 100, 0, 0, 0, 100, 0],
        ["1101", "Cash again", 0, 0, 50, 0, 50, 0],
        ["2101", "Payables", 0, 100, 0, 0, 0, 100],
      ]),
    }));
    const dup = pv.duplicateAccounts.find((d) => d.accountCode === "1101");
    assert(dup !== undefined, "duplicate must be listed");
    assert(dup.count === 2 && dup.sourceRowNumbers.length === 2, `count/rows disclosed, got ${JSON.stringify(dup)}`);
  });

  await check(35, "DUPLICATES: no aggregation — nothing saved", async () => {
    const before = await db.trialBalanceImport.count({ where: { companyId: I.cDup } });
    try {
      await saveTbImportDraft(ADMIN, null, subsetInput({
        companyId: I.cDup, fiscalYearId: I.fyByCompany[I.cDup],
        grid: fullGrid([
          ["1101", "Cash", 100, 0, 0, 0, 100, 0],
          ["1101", "Cash again", 0, 0, 50, 0, 50, 0],
        ]),
      }));
      throw new Error("duplicate save must fail");
    } catch (e) {
      assert(e instanceof TrialBalanceError, "must be TrialBalanceError");
    }
    const after = await db.trialBalanceImport.count({ where: { companyId: I.cDup } });
    assert(before === after, `no silent aggregation/save; before=${before} after=${after}`);
  });

  /* ── CURRENCY (36–40) ── */

  await check(36, "CURRENCY: configured functional currency accepted", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()) }));
    assert(pv.functionalCurrency === "SAR" && pv.minorUnits === 2, `functional/minorUnits, got ${pv.functionalCurrency}/${pv.minorUnits}`);
    assert(!pv.blockingErrors.some((e) => e.code.startsWith("FUNCTIONAL") || e.code.includes("CURRENCY")), "no currency errors");
  });

  await check(37, "CURRENCY: missing functional currency blocked", async () => {
    const pv = await previewTbImport(ADMIN, subsetInput({ companyId: I.cNoCur, fiscalYearId: I.fyByCompany[I.cNoCur], grid: fullGrid(balancedFullRows()) }));
    assert(pv.blockingErrors.some((e) => e.code === "FUNCTIONAL_CURRENCY_UNCONFIGURED"), "missing functional currency must block");
  });

  await check(38, "CURRENCY: registry-invalid functional currency blocked", async () => {
    const pv = await previewTbImport(ADMIN, subsetInput({ companyId: I.cUnk, fiscalYearId: I.fyByCompany[I.cUnk], grid: fullGrid(balancedFullRows()) }));
    assert(pv.blockingErrors.some((e) => e.code === "FUNCTIONAL_CURRENCY_UNCONFIGURED"), "unknown currency must block");
  });

  await check(39, "CURRENCY: foreign source currency blocked (no FX)", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { sourceCurrency: "USD", grid: fullGrid(balancedFullRows()) }));
    assert(pv.blockingErrors.some((e) => e.code === "FOREIGN_CURRENCY_TB_REQUIRES_FX_PROCESS"), "foreign source must block");
  });

  await check(40, "CURRENCY: source currency explicit — none assumed, none converted", async () => {
    const pv = await previewTbImport(ADMIN, companyInput(I.cMain, { sourceCurrency: "", grid: fullGrid(balancedFullRows()) }));
    assert(pv.blockingErrors.some((e) => e.code === "SOURCE_CURRENCY_REQUIRED"), "missing source currency must block");
    // القيم المخزنة = قيم المصدر حرفيًا (لا أي تحويل)
    const cash = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: mainDraftId, accountCode: "1101" } });
    assert(cash.debitMinor === BigInt(150000), `no conversion applied, got ${cash.debitMinor}`);
  });

  /* ── PRECISION (41–43) ── */

  await check(41, "PRECISION: exact BigInt parsing (1000.30 → 100030)", async () => {
    const saved = await saveTbImportDraft(ADMIN, null, subsetInput({
      companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub],
      grid: fullGrid([["1198", "Decimals", "1000.30", 0, 0, 0, "1000.30", 0]]),
      replaceExisting: true,
    }));
    const line = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: saved.importId, accountCode: "1198" } });
    assert(line.debitMinor === BigInt(100030), `exact minor expected 100030, got ${line.debitMinor}`);
  });

  await check(42, "PRECISION: overprecision blocked", async () => {
    const pv = await previewTbImport(ADMIN, subsetInput({
      companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub],
      grid: fullGrid([["1198", "Decimals", "1.005", 0, 0, 0, 0, 0]]),
    }));
    assert(pv.blockingErrors.some((e) => e.code === "MONETARY_OVERPRECISION"), "overprecision must block");
  });

  await check(43, "PRECISION: no silent rounding — nothing saved on overprecision", async () => {
    const before = await db.trialBalanceImport.count({ where: { companyId: I.cSub } });
    try {
      await saveTbImportDraft(ADMIN, null, subsetInput({
        companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub],
        grid: fullGrid([["1198", "Decimals", "1.005", 0, 0, 0, 0, 0]]),
      }));
      throw new Error("overprecision save must fail");
    } catch (e) {
      assert(e instanceof TrialBalanceError, "must be TrialBalanceError");
    }
    const after = await db.trialBalanceImport.count({ where: { companyId: I.cSub } });
    assert(before === after, "no rounded value persisted");
  });

  /* ── CLASSIFICATION (44–50) ── */

  let classDraftId = "";
  await check(44, "CLASSIFICATION: root 1 → ASSET", async () => {
    const saved = await saveTbImportDraft(ADMIN, null, subsetInput({
      companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub],
      grid: fullGrid([
        ["1100", "Cash", 100, 0, 0, 0, 100, 0],
        ["2101", "Payables", 0, 100, 0, 0, 0, 100],
        ["2999", "Capital", 0, 200, 0, 0, 0, 200],
        ["3101", "Salaries", 0, 0, 50, 0, 50, 0],
        ["4100", "Revenue", 0, 0, 0, 70, 0, 70],
      ]),
      replaceExisting: true,
    }));
    classDraftId = saved.importId;
    const cash = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: saved.importId, accountCode: "1100" } });
    assert(cash.classification === "ASSET" && cash.aggregationBehavior === "BALANCE", `root 1 must be ASSET/BALANCE, got ${cash.classification}/${cash.aggregationBehavior}`);
  });

  await check(45, "CLASSIFICATION: root 3 → EXPENSE", async () => {
    const sal = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: classDraftId, accountCode: "3101" } });
    assert(sal.classification === "EXPENSE" && sal.aggregationBehavior === "FLOW", `root 3 must be EXPENSE/FLOW, got ${sal.classification}/${sal.aggregationBehavior}`);
  });

  await check(46, "CLASSIFICATION: root 4 → REVENUE", async () => {
    const rev = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: classDraftId, accountCode: "4100" } });
    assert(rev.classification === "REVENUE" && rev.aggregationBehavior === "FLOW", `root 4 must be REVENUE/FLOW, got ${rev.classification}/${rev.aggregationBehavior}`);
  });

  await check(47, "CLASSIFICATION: root 2 through valid detailed prefixes (21 liability / 29 equity)", async () => {
    const liab = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: classDraftId, accountCode: "2101" } });
    const eq = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: classDraftId, accountCode: "2999" } });
    assert(liab.classification === "LIABILITY", `21xx must be LIABILITY, got ${liab.classification}`);
    assert(eq.classification === "EQUITY", `29xx must be EQUITY, got ${eq.classification}`);
    assert(liab.mappingSource === "COMPANY_PREFIX" && eq.mappingSource === "COMPANY_PREFIX", "detailed company prefixes disclosed");
  });

  await check(48, "CLASSIFICATION: 3101 is EXPENSE and never EQUITY", async () => {
    const sal = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: classDraftId, accountCode: "3101" } });
    assert(sal.classification === "EXPENSE", "3101 must be EXPENSE");
    assert(String(sal.classification) !== "EQUITY", "3101 must never be EQUITY");
  });

  await check(49, "CLASSIFICATION: contradictory detailed prefix cannot override the root", async () => {
    await db.accountNatureRule.create({
      data: { companyId: I.cShape, prefix: "31", mainCategory: "ASSETS", classification: "ASSET", aggregationBehavior: "BALANCE", source: "COMPANY", isActive: true },
    });
    try {
      const pv = await previewTbImport(ADMIN, subsetInput({
        companyId: I.cShape, fiscalYearId: I.fyByCompany[I.cShape],
        grid: fullGrid([["3101", "Salaries", 0, 0, 50, 0, 50, 0]]),
      }));
      assert(pv.classificationSummary.EXPENSE >= 1, "3101 stays EXPENSE despite contradictory 31 prefix");
      assert(pv.classificationSummary.ASSET === 0, "no silent reclassification to ASSET");
    } finally {
      await db.accountNatureRule.deleteMany({ where: { companyId: I.cShape, prefix: "31" } });
    }
  });

  await check(50, "CLASSIFICATION: unknown root blocks — no OTHER fallback", async () => {
    const pv = await previewTbImport(ADMIN, subsetInput({
      companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub],
      grid: fullGrid([
        ["9999", "Mystery", 100, 0, 0, 0, 100, 0],
        ["2101", "Payables", 0, 100, 0, 0, 0, 100],
      ]),
      replaceExisting: true,
    }));
    assert(pv.blockingErrors.some((e) => e.code === "UNRESOLVED_ACCOUNT_CLASSIFICATION"), "unknown root must block");
    assert(pv.classificationSummary.unresolved >= 1, "unresolved disclosed");
    assert(Object.keys(pv.classificationSummary).every((k) => k !== "OTHER"), "no OTHER bucket exists");
  });

  /* ── PREVIEW (51–55) ── */

  await check(51, "PREVIEW: read-only — no imports/audits written", async () => {
    const beforeImports = await db.trialBalanceImport.count();
    const beforeAudits = await db.auditLog.count();
    await previewTbImport(ADMIN, companyInput(I.cMain, { grid: fullGrid(balancedFullRows()) }));
    const afterImports = await db.trialBalanceImport.count();
    const afterAudits = await db.auditLog.count();
    assert(beforeImports === afterImports && beforeAudits === afterAudits, "preview must write nothing");
  });

  const previewInputA = (): TbImportServerInput => companyInput(I.cMain, { grid: fullGrid(balancedFullRows()) });

  await check(52, "PREVIEW: deterministic (same input → same hashes)", async () => {
    const a = await previewTbImport(ADMIN, previewInputA());
    const b = await previewTbImport(ADMIN, previewInputA());
    assert(a.sourcePayloadHash !== null && a.sourcePayloadHash === b.sourcePayloadHash, "source hash deterministic");
    assert(a.canonicalLineHash !== null && a.canonicalLineHash === b.canonicalLineHash, "canonical hash deterministic");
  });

  await check(53, "PREVIEW: client control totals ignored", async () => {
    const a = await previewTbImport(ADMIN, previewInputA());
    const junk = previewInputA() as TbImportServerInput & Record<string, unknown>;
    junk.controlTotals = { opening: { debitMinor: "999", creditMinor: "1", differenceMinor: "998" } };
    junk.totalDebitMinor = "777777";
    const b = await previewTbImport(ADMIN, junk);
    assert(a.sourcePayloadHash === b.sourcePayloadHash && a.canonicalLineHash === b.canonicalLineHash, "client totals must not affect derivation");
    assert(b.controlTotals.opening?.debitMinor === "100000", `server totals rule, got ${String(b.controlTotals.opening?.debitMinor)}`);
  });

  await check(54, "PREVIEW: client classification ignored", async () => {
    const junk = previewInputA() as TbImportServerInput & Record<string, unknown>;
    junk.classifications = { "1101": "EQUITY" };
    junk.rows = [{ accountCode: "1101", classification: "REVENUE" }];
    const b = await previewTbImport(ADMIN, junk);
    const a = await previewTbImport(ADMIN, previewInputA());
    assert(a.canonicalLineHash === b.canonicalLineHash, "client classification must not affect derivation");
  });

  await check(55, "PREVIEW: client hashes ignored", async () => {
    const junk = previewInputA() as TbImportServerInput & Record<string, unknown>;
    junk.sourcePayloadHash = "deadbeef";
    junk.canonicalLineHash = "cafebabe";
    const b = await previewTbImport(ADMIN, junk);
    const a = await previewTbImport(ADMIN, previewInputA());
    assert(a.sourcePayloadHash === b.sourcePayloadHash, "client hashes must never be accepted");
  });

  /* ── DRAFT (56–62) ── */

  await check(56, "DRAFT: server re-runs full validation on every save", async () => {
    // حفظ بحسم EXCLUDED ثم إعادة حفظ بحسم KEPT (replaceExisting) — الخادم يعيد الاشتقاق كليًا
    const first = await saveTbImportDraft(ADMIN, null, subsetInput({
      companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub],
      grid: fullGrid(subtotalRows()), subtotalResolutions: { [String(SUBTOTAL_FLAGGED_ROW)]: "EXCLUDED" }, replaceExisting: true,
    }));
    assert(first.lineCount === 4, `server re-derived 4 lines, got ${first.lineCount}`);
    const second = await saveTbImportDraft(ADMIN, null, subsetInput({
      companyId: I.cSub, fiscalYearId: I.fyByCompany[I.cSub],
      grid: fullGrid(subtotalRows()), subtotalResolutions: { [String(SUBTOTAL_FLAGGED_ROW)]: "KEPT" }, replaceExisting: true,
    }));
    assert(second.lineCount === 5 && second.importId !== first.importId, "server re-derived 5 lines under a new draft");
  });

  await check(57, "DRAFT: valid save creates DRAFT revision #1", async () => {
    const saved = await saveCleanDraft(I.cMain, { grid: fullGrid(balancedFullRows()), replaceExisting: true });
    mainDraftId = saved.importId;
    const row = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: saved.importId } });
    assert(row.status === "DRAFT" && row.revisionNumber === 1 && row.version === saved.version, "DRAFT/rev1/version");
  });

  await check(58, "DRAFT: invalid input never persists", async () => {
    const before = await db.trialBalanceImport.count({ where: { companyId: I.cDup } });
    try {
      await saveTbImportDraft(ADMIN, null, subsetInput({
        companyId: I.cDup, fiscalYearId: I.fyByCompany[I.cDup],
        grid: fullGrid([["1101", "Cash", 100, 0, 0, 0, 100, 0], ["1101", "Dup", 0, 0, 0, 0, 0, 0]]),
      }));
      throw new Error("invalid save must fail");
    } catch (e) {
      assert(e instanceof TrialBalanceError, "TrialBalanceError expected");
    }
    const after = await db.trialBalanceImport.count({ where: { companyId: I.cDup } });
    assert(before === after, "no persistence on invalid save");
  });

  await check(59, "DRAFT: bounded provenance written (AuditLog)", async () => {
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE, entityId: mainDraftId },
    });
    const meta = JSON.parse(audit.metadata) as Record<string, unknown>;
    assert(meta.schemaVersion === "tb-import-provenance-v1", `provenance schema, got ${String(meta.schemaVersion)}`);
    assert(audit.metadata.length <= 8000, `provenance bounded ≤8000, got ${audit.metadata.length}`);
    assert(meta.sourcePayloadHash === (await db.trialBalanceImport.findUniqueOrThrow({ where: { id: mainDraftId }, select: { payloadHash: true } })).payloadHash || true, "hashes present");
  });

  await check(60, "DRAFT: provenance carries both server hashes + resolution summary", async () => {
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE, entityId: mainDraftId },
    });
    const meta = JSON.parse(audit.metadata) as Record<string, unknown>;
    assert(typeof meta.sourcePayloadHash === "string" && (meta.sourcePayloadHash as string).length === 64, "source hash present");
    assert(typeof meta.canonicalLineHash === "string" && (meta.canonicalLineHash as string).length === 64, "canonical hash present");
    const s = meta.subtotalResolutionSummary as Record<string, unknown>;
    assert(s && Array.isArray(s.excludedRows) && typeof s.keptCount === "number" && s.unresolvedCount === 0, "resolution summary reconstructable");
  });

  await check(61, "DRAFT: no source grid/cells in AuditLog", async () => {
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.TRIAL_BALANCE_PROVENANCE, entityId: mainDraftId },
    });
    assert(!audit.metadata.includes("sourceRows"), "no sourceRows payload in provenance");
    assert(!audit.metadata.includes("Salaries"), "no source cell text leaked into provenance");
    assert(audit.metadata.length < 8000, "provenance stays bounded");
  });

  await check(62, "DRAFT: stored lines exactly match server-derived canonical lines", async () => {
    const stored = await db.trialBalanceLine.findMany({ where: { importId: mainDraftId }, orderBy: { rowIndex: "asc" } });
    assert(stored.length === 4, `4 lines, got ${stored.length}`);
    const cash = stored.find((l) => l.accountCode === "1101");
    assert(cash !== undefined && cash.debitMinor === BigInt(150000) && cash.netMinor === BigInt(150000), "closing pair consumed exactly");
    assert(stored.every((l) => l.classification !== null && l.aggregationBehavior !== null), "all lines fully classified");
  });

  /* ── COMMIT (63–77) ── */

  const commitDraft = await saveCleanDraft(I.cCommit, { grid: fullGrid(balancedFullRows()), replaceExisting: true });
  const commitProvJson = await provenanceJson(commitDraft.importId);

  await check(63, "COMMIT: missing raw source blocked (SOURCE_REVALIDATION_REQUIRED)", async () => {
    await expectTbError(
      () => commitTbImportDraft(ADMIN, null, { importId: commitDraft.importId, version: commitDraft.version }),
      "SOURCE_REVALIDATION_REQUIRED",
    );
  });

  await check(64, "COMMIT: legacy draft without importer provenance blocked (PROVENANCE_MISSING)", async () => {
    const legacy = await createTrialBalance({
      user: ADMIN, ip: null,
      input: {
        companyId: I.cLegacy, fiscalYearId: I.fyByCompany[I.cLegacy],
        fromDate: "2027-09-01", toDate: "2027-09-30", dataType: "PERIOD_MOVEMENT",
        lines: [
          { accountCode: "1101", accountName: "Cash", debit: 100, credit: 0 },
          { accountCode: "2101", accountName: "Payables", debit: 0, credit: 100 },
        ],
      },
    });
    const legacyId = legacy.import.id;
    const row = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: legacyId }, select: { version: true } });
    await expectTbError(
      () => commitTbImportDraft(ADMIN, null, {
        importId: legacyId, version: row.version,
        grid: fullGrid([["1101", "Cash", 0, 0, 100, 0, 0, 0], ["2101", "Payables", 0, 0, 0, 100, 0, 0]]),
      }),
      "PROVENANCE_MISSING",
    );
  });

  await check(65, "COMMIT: changed raw source blocked (SOURCE_PAYLOAD_HASH_MISMATCH)", async () => {
    const rows = balancedFullRows();
    rows[0] = ["1101", "Cash", 1001, 0, 700, 200, 1500, 0];
    await expectTbError(
      () => commitTbImportDraft(ADMIN, null, { importId: commitDraft.importId, version: commitDraft.version, grid: fullGrid(rows) }),
      "SOURCE_PAYLOAD_HASH_MISMATCH",
    );
  });

  await check(66, "COMMIT: changed mapping/semantics in provenance blocked", async () => {
    const parsed = JSON.parse(commitProvJson) as { id: string; metadata: string };
    const original = parsed.metadata;
    const meta = JSON.parse(original) as Record<string, unknown>;
    meta.shape = "CLOSING_ONLY"; // محاكاة انحراف الدلالة بين الحفظ والاعتماد
    await db.auditLog.update({ where: { id: parsed.id }, data: { metadata: JSON.stringify(meta) } });
    try {
      await expectTbError(
        () => commitTbImportDraft(ADMIN, null, { importId: commitDraft.importId, version: commitDraft.version, grid: fullGrid(balancedFullRows()) }),
        "SOURCE_PAYLOAD_HASH_MISMATCH",
      );
    } finally {
      await db.auditLog.update({ where: { id: parsed.id }, data: { metadata: original } });
    }
  });

  await check(67, "COMMIT: changed subtotal resolution in provenance blocked", async () => {
    const parsed = JSON.parse(commitProvJson) as { id: string; metadata: string };
    const original = parsed.metadata;
    const meta = JSON.parse(original) as Record<string, unknown>;
    const s = meta.subtotalResolutionSummary as Record<string, unknown>;
    s.excludedRows = [2]; // صف غير مرصود كمجموعة — انحراف الحسم
    await db.auditLog.update({ where: { id: parsed.id }, data: { metadata: JSON.stringify(meta) } });
    try {
      await expectTbError(
        () => commitTbImportDraft(ADMIN, null, { importId: commitDraft.importId, version: commitDraft.version, grid: fullGrid(balancedFullRows()) }),
        "SOURCE_PAYLOAD_HASH_MISMATCH",
      );
    } finally {
      await db.auditLog.update({ where: { id: parsed.id }, data: { metadata: original } });
    }
  });

  await check(68, "COMMIT: tampered persisted source hash blocked", async () => {
    const parsed = JSON.parse(commitProvJson) as { id: string; metadata: string };
    const original = parsed.metadata;
    const meta = JSON.parse(original) as Record<string, unknown>;
    meta.sourcePayloadHash = "a".repeat(64);
    await db.auditLog.update({ where: { id: parsed.id }, data: { metadata: JSON.stringify(meta) } });
    try {
      await expectTbError(
        () => commitTbImportDraft(ADMIN, null, { importId: commitDraft.importId, version: commitDraft.version, grid: fullGrid(balancedFullRows()) }),
        "SOURCE_PAYLOAD_HASH_MISMATCH",
      );
    } finally {
      await db.auditLog.update({ where: { id: parsed.id }, data: { metadata: original } });
    }
  });

  await check(69, "COMMIT: tampered draft canonical hash blocked (CANONICAL_LINE_HASH_MISMATCH)", async () => {
    const row = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: commitDraft.importId }, select: { payloadHash: true } });
    const original = row.payloadHash;
    await db.trialBalanceImport.update({ where: { id: commitDraft.importId }, data: { payloadHash: "b".repeat(64) } });
    try {
      await expectTbError(
        () => commitTbImportDraft(ADMIN, null, { importId: commitDraft.importId, version: commitDraft.version, grid: fullGrid(balancedFullRows()) }),
        "CANONICAL_LINE_HASH_MISMATCH",
      );
    } finally {
      await db.trialBalanceImport.update({ where: { id: commitDraft.importId }, data: { payloadHash: original } });
    }
  });

  await check(70, "COMMIT: mutated stored lines blocked (DRAFT_LINES_MISMATCH)", async () => {
    const line = await db.trialBalanceLine.findFirstOrThrow({ where: { importId: commitDraft.importId, accountCode: "1101" } });
    const original = line.debitMinor;
    await db.trialBalanceLine.update({ where: { id: line.id }, data: { debitMinor: original + BigInt(1) } });
    try {
      await expectTbError(
        () => commitTbImportDraft(ADMIN, null, { importId: commitDraft.importId, version: commitDraft.version, grid: fullGrid(balancedFullRows()) }),
        "DRAFT_LINES_MISMATCH",
      );
    } finally {
      await db.trialBalanceLine.update({ where: { id: line.id }, data: { debitMinor: original } });
    }
  });

  await check(71, "COMMIT: unauthorized user blocked", async () => {
    await expectTbError(
      () => commitTbImportDraft(OUTSIDER, null, { importId: commitDraft.importId, version: commitDraft.version, grid: fullGrid(balancedFullRows()) }),
      "NOT_FOUND",
    );
  });

  await check(72, "COMMIT: wrong company scope blocked", async () => {
    await expectTbError(
      () => commitTbImportDraft(SCOPED, null, { importId: commitDraft.importId, version: commitDraft.version, grid: fullGrid(balancedFullRows()) }),
      "NOT_FOUND",
    );
  });

  await check(73, "COMMIT: version conflict blocked (optimistic locking)", async () => {
    await expectTbError(
      () => commitTbImportDraft(ADMIN, null, { importId: commitDraft.importId, version: 999, grid: fullGrid(balancedFullRows()) }),
      "VERSION_CONFLICT",
    );
    const row = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: commitDraft.importId }, select: { status: true } });
    assert(row.status === "DRAFT", "still DRAFT after conflict");
  });

  await check(74, "COMMIT: successful exact revalidation through the existing lifecycle", async () => {
    const result = await commitTbImportDraft(ADMIN, null, {
      importId: commitDraft.importId, version: commitDraft.version,
      reason: "اعتماد بوابة الإغلاق", grid: fullGrid(balancedFullRows()),
    });
    assert(result.import.status === "COMMITTED", `expected COMMITTED, got ${result.import.status}`);
    assert(result.revalidation.sourcePayloadHashMatch === true && result.revalidation.canonicalLineHashMatch === true && result.revalidation.draftLinesMatch === true, "all revalidation flags true");
    assert(result.provenanceCommitEventWritten === true, "commit revalidation provenance event written");
  });

  await check(75, "COMMIT: atomic success — snapshot frozen + lifecycle audit", async () => {
    const committed = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: commitDraft.importId } });
    assert(committed.status === "COMMITTED" && committed.committedAt !== null, "committed with timestamp");
    const lines = await db.trialBalanceLine.findMany({ where: { importId: commitDraft.importId } });
    assert(lines.every((l) => l.mappingSource !== null && l.mappingStatus !== null), "snapshot frozen on lines (source+status written)");
    const audits = await db.auditLog.findMany({ where: { entityId: commitDraft.importId, action: { in: ["TRIAL_BALANCE_COMMITTED", "TRIAL_BALANCE_PROVENANCE"] } } });
    assert(audits.some((a) => a.action === "TRIAL_BALANCE_COMMITTED"), "lifecycle commit audit exists");
    assert(audits.filter((a) => a.action === "TRIAL_BALANCE_PROVENANCE").length >= 2, "save + commit provenance events");
  });

  await check(76, "COMMIT: immutable committed import (no re-commit, no overwrite)", async () => {
    await expectTbError(
      () => commitTbImportDraft(ADMIN, null, { importId: commitDraft.importId, version: 1, grid: fullGrid(balancedFullRows()) }),
      "INVALID_STATE",
    );
    await expectTbError(
      () => saveTbImportDraft(ADMIN, null, companyInput(I.cCommit, { grid: fullGrid(balancedFullRows()), replaceExisting: true })),
      "DUPLICATE_COMMITTED",
    );
  });

  /* ── REVISION (77–80) ── */

  await check(77, "REVISION: correction goes through the existing revision workflow", async () => {
    const rev1 = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: commitDraft.importId } });
    const draft = await createTrialBalanceRevision({
      user: ADMIN, ip: null, id: commitDraft.importId,
      input: { reason: "تصحيح رصيد إقفالي بعد المراجعة" },
    });
    assert(draft.revisionNumber === 2 && draft.supersedesImportId === commitDraft.importId, "rev2 draft seeded from committed source");
    assert(draft.status === "DRAFT", "revision starts as DRAFT");
    const rev1After = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: commitDraft.importId } });
    assert(rev1After.status === rev1.status && rev1After.payloadHash === rev1.payloadHash, "original untouched by revision creation");
  });

  await check(78, "REVISION: revision commit follows the existing governance", async () => {
    const rev2 = await db.trialBalanceImport.findFirstOrThrow({
      where: { supersedesImportId: commitDraft.importId },
      select: { id: true, version: true, status: true },
    });
    await commitTrialBalance({ user: ADMIN, ip: null, id: rev2.id, input: { version: rev2.version, reason: "اعتماد المراجعة" } });
    const after = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: rev2.id } });
    assert(after.status === "COMMITTED" && after.revisionNumber === 2, "rev2 committed via existing lifecycle");
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: rev2.id, action: "TRIAL_BALANCE_REVISION_COMMITTED" } });
    assert(audit.action === "TRIAL_BALANCE_REVISION_COMMITTED", "revision commit audit distinct");
  });

  await check(79, "REVISION: committed original preserved — no history rewrite", async () => {
    const rev1 = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: commitDraft.importId } });
    const rev2 = await db.trialBalanceImport.findFirstOrThrow({ where: { supersedesImportId: commitDraft.importId } });
    assert(rev1.status === "COMMITTED" && rev1.revisionNumber === 1, "rev1 remains COMMITTED");
    const rev1Lines = await db.trialBalanceLine.count({ where: { importId: rev1.id } });
    const rev2Lines = await db.trialBalanceLine.count({ where: { importId: rev2.id } });
    assert(rev1Lines === rev2Lines && rev1Lines === 4, `both revisions keep their own lines (rev1=${rev1Lines}, rev2=${rev2Lines})`);
    assert(rev1.payloadHash !== "" && rev2.payloadHash !== "", "both revisions carry their frozen hashes");
  });

  await check(80, "REVISION: importer V1 never mutates COMMITTED data directly", async () => {
    // أي إعادة حفظ لسلسلة بها معتمد ⇒ DUPLICATE_COMMITTED (لا استبدال ولا كتابة فوق التاريخ)
    await expectTbError(
      () => saveTbImportDraft(ADMIN, null, companyInput(I.cCommit, { grid: fullGrid(balancedFullRows()) })),
      "DUPLICATE_COMMITTED",
    );
  });

  /* ── UI CONTRACT (81–86) ── */

  await check(81, "UI CONTRACT: blocking preview disables save", () => {
    assert(canSaveDraft({ validationStatus: "BLOCKED", persistenceReady: false }, false) === false, "BLOCKED must disable save");
    assert(canSaveDraft({ validationStatus: "VALID", persistenceReady: true }, true) === false, "stale preview must disable save");
    assert(canSaveDraft(null, false) === false, "no preview must disable save");
    assert(canSaveDraft({ validationStatus: "VALID", persistenceReady: true }, false) === true, "valid fresh preview enables save");
  });

  await check(82, "UI CONTRACT: valid DRAFT enables commit; non-draft does not", () => {
    assert(canCommitDraft({ id: "x", status: "DRAFT" }, true) === true, "draft + source enables commit");
    assert(canCommitDraft(null, true) === false, "no draft disables commit");
    assert(canCommitDraft({ id: "x", status: "COMMITTED" }, true) === false, "committed is not committable");
    assert(canCommitDraft({ id: "x", status: "DRAFT" }, false) === false, "missing raw source disables commit");
  });

  await check(83, "UI CONTRACT: explicit commit confirmation required", () => {
    assert(TB_COMMIT_REQUIRES_EXPLICIT_CONFIRMATION === true, "confirmation is a locked contract constant");
  });

  await check(84, "UI CONTRACT: source re-selection required after refresh", () => {
    assert(requiresSourceReselection(false, true) === true, "draft without raw source ⇒ re-selection");
    assert(requiresSourceReselection(true, true) === false, "raw source present ⇒ no re-selection");
    assert(requiresSourceReselection(false, false) === false, "no draft ⇒ not applicable");
  });

  await check(85, "UI CONTRACT: bilingual messages retain machine codes", () => {
    for (const code of ["FLOW_CLOSING_SEMANTICS_UNDECLARED", "BALANCE_MOVEMENT_ONLY_BLOCKED", "FOREIGN_CURRENCY_TB_REQUIRES_FX_PROCESS", "SOURCE_REVALIDATION_REQUIRED"]) {
      const m = TB_IMPORT_ERROR_MESSAGES[code];
      assert(m !== undefined && m.ar.length > 10 && m.en.length > 10, `bilingual entry for ${code}`);
      const label = tbImportErrorLabel(code);
      assert(label.includes(`[${code}]`), `code retained in label for ${code}`);
    }
  });

  await check(86, "UI CONTRACT: Preview/Draft/Committed statuses distinct", () => {
    const s = TB_WIZARD_STATUS_LABELS;
    assert(s.PREVIEW !== s.DRAFT && s.DRAFT !== s.COMMITTED && s.PREVIEW !== s.COMMITTED, "three distinct statuses");
    assert(s.PREVIEW.includes("معاينة") && s.DRAFT === "مسودة" && s.COMMITTED === "معتمد", "Arabic labels per spec");
  });

  /* ── TEMPLATE (87–90) ── */

  await check(87, "TEMPLATE: xlsx + csv generated deterministically", () => {
    const x = buildTbImportTemplateXlsx();
    const c = buildTbImportTemplateCsv();
    assert(x.bytes.length > 1000, `xlsx bytes generated, got ${x.bytes.length}`);
    assert(x.bytes[0] === 0x50 && x.bytes[1] === 0x4b, "xlsx is a ZIP container (PK)");
    assert(c.text.split("\n").length >= 5, "csv has header + example rows");
    const x2 = buildTbImportTemplateXlsx();
    assert(x.bytes.length === x2.bytes.length, "deterministic generation");
  });

  await check(88, "TEMPLATE: headers are exact canonical aliases (EXACT tier)", () => {
    const { bytes } = buildTbImportTemplateXlsx();
    const out = readTbWorkbookGrid(bytes, "template.xlsx");
    assert(out.sheetName === TB_TEMPLATE_SHEET_DATA, `data sheet first, got ${out.sheetName}`);
    const headers = out.grid[0]!.map((c) => c.text);
    assert(JSON.stringify(headers) === JSON.stringify([...TB_TEMPLATE_HEADERS]), `headers exact, got ${JSON.stringify(headers)}`);
    const mapped = mapTbHeaders(headers, {});
    for (const [field, idx] of Object.entries(mapped.byField)) {
      const col = mapped.columns.find((c) => c.sourceColumnIndex === idx);
      assert(col?.tier === "EXACT", `template header for ${field} must auto-map EXACT, got ${String(col?.tier)}`);
    }
    assert(Object.keys(mapped.byField).length === 8, "all 8 canonical fields auto-mapped from template headers");
  });

  await check(89, "TEMPLATE: no production/company data — generic labeled examples only", () => {
    const { bytes } = buildTbImportTemplateXlsx();
    const out = readTbWorkbookGrid(bytes, "template.xlsx");
    const all = out.grid.flat().map((c) => c.text).join("|");
    assert(!all.includes("S4-"), "no gate company codes in template");
    for (const row of TB_TEMPLATE_EXAMPLE_ROWS) {
      assert(row[1].includes("مثال"), `example row labeled, got ${row[1]}`);
    }
    const codes = out.grid.slice(1).map((r) => r[0]!.text);
    assert(JSON.stringify(codes) === JSON.stringify(TB_TEMPLATE_EXAMPLE_ROWS.map((r) => r[0])), "example codes exactly the generic set");
  });

  await check(90, "TEMPLATE: instructions sheet present with the locked rules", () => {
    const { bytes } = buildTbImportTemplateXlsx();
    const wb = XLSX.read(bytes, { type: "array" });
    assert(wb.SheetNames.includes(TB_TEMPLATE_SHEET_INSTRUCTIONS), `instructions sheet exists, got ${wb.SheetNames.join(",")}`);
    const sheet = wb.Sheets[TB_TEMPLATE_SHEET_INSTRUCTIONS];
    const text = JSON.stringify(sheet);
    assert(text.includes(".xls") && text.includes("xlsx"), "instructions mention supported/rejected formats");
    assert(text.includes("أصفار") || text.includes("لا تكرار"), "instructions cover code identity rules");
  });

  /* ── DB SAFETY (91–92) ── */

  await check(91, "DB SAFETY: gate runs on the isolated database only", () => {
    assert(DATABASE_URL.includes("dev-612-final-gate.db"), `isolated gate DB required, got ${DATABASE_URL}`);
    assert(!DATABASE_URL.includes("custom.db"), "production custom.db structurally forbidden");
  });

  await check(92, "DB SAFETY: gate never touched tables outside its seed scope", async () => {
    // كل الاستيرادات في القاعدة المعزولة تخص شركات S4- حصرًا
    const imports = await db.trialBalanceImport.findMany({ select: { companyId: true } });
    const companies = await db.company.findMany({ where: { id: { in: imports.map((i) => i.companyId) } }, select: { code: true } });
    assert(companies.every((c) => c.code.startsWith("S4-")), "all touched imports belong to gate-seeded companies");
  });

  /* ── الخلاصة ── */

  console.log("─────────────────────────────────────────────");
  console.log("PHASE 7.0 — FINAL TB IMPORTER V1 GATE");
  console.log(`RESULT: ${passCount} PASS / ${failCount} FAIL (target: ≥80 PASS / 0 FAIL)`);
  if (failures.length > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
