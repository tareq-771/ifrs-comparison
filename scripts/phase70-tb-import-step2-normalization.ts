// ═══════════════════════════════════════════════════════════════════════════
// Phase 7.0 (Step 2) — TB Importer Core Normalization + Validation Gate
// بوابة الخطوة 2: التطبيع المحاسبي والتحقق — فحوص نقيّة معزولة حصرًا.
// تشغيل: bun scripts/phase70-tb-import-step2-normalization.ts
//
// بلا DB إطلاقًا — كل الفيكتشرات في الذاكرة.
// الحد الأدنى: 70 فحصًا مستقلًا PASS / 0 FAIL — الفحوص لا تُدمج لتقليل العدّاد.
// التغطية: المحلل النقدي BigInt، معادلة الصف، تكامل التصنيف المعتمد، الأشكال
// الثلاثة (FULL/CLOSING_ONLY/MOVEMENT_ONLY) + LEGACY المؤجَّل، التكرار، المجاميع،
// الترويسات المكررة/الفراغات، COMPLETE/SUBSET، العملة/FX، الأكواد، الهاش القياني.
// ═══════════════════════════════════════════════════════════════════════════

import {
  detectRepeatedHeaderRows,
  extractTbSourceRows,
  flagSuspectedSubtotalRows,
  mapTbHeaders,
} from "../src/lib/tb-import";
import { parseCsvGrid } from "../src/lib/excel-grid";
import type { TbGrid, TbGridCell, TbHeaderMappingResult, TbSourceRow } from "../src/lib/tb-import";
import {
  SYSTEM_ROOT_MAPPING_RULES,
  normalizeTbSource,
  parseMonetaryToMinor,
} from "../src/lib/tb-import-normalization";
import type { TbNormalizationRequest } from "../src/lib/tb-import-normalization";
import { computeTbSourcePayloadHash } from "../src/lib/tb-import-source-hash";
import { canonicalJsonStringify } from "../src/lib/tb-import-normalization";
import type { MappingRuleLike } from "../src/lib/account-nature";

/* ── عدة الفحص ───────────────────────────────────────────────────────────── */

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function check(num: number, name: string, fn: () => void): void {
  try {
    fn();
    passCount++;
    console.log(`PASS ${num}: ${name}`);
  } catch (e) {
    failCount++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`#${num} ${name} — ${msg}`);
    console.log(`FAIL ${num}: ${name} — ${msg}`);
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** وحدات كبرى ⇒ وحدات صغرى (minorUnits = 2 في الفيكتشرات). */
const M = (major: number): bigint => BigInt(major) * BigInt(100);

/* ── فيكتشرات في الذاكرة ─────────────────────────────────────────────────── */

function t(text: string): TbGridCell {
  return { text, isNumericSource: false, isFormula: false, formulaText: null };
}
function n(value: number): TbGridCell {
  return { text: String(value), isNumericSource: true, isFormula: false, formulaText: null };
}
function cellOf(v: string | number): TbGridCell {
  return typeof v === "number" ? n(v) : t(v);
}

interface Fixture {
  grid: TbGrid;
  mapping: TbHeaderMappingResult;
  rows: TbSourceRow[];
}

function fixtureFromAoa(headerRow: string[], dataRows: Array<Array<string | number>>): Fixture {
  const grid: TbGrid = [headerRow.map(t), ...dataRows.map((r) => r.map(cellOf))];
  const mapping = mapTbHeaders(headerRow);
  const rows = extractTbSourceRows(grid, { mapping, headerRowIndex: 0, headerRowCount: 1 });
  return { grid, mapping, rows };
}

const FULL_HEADERS = [
  "Account Code", "Account Name",
  "Opening Debit", "Opening Credit",
  "Period Debit", "Period Credit",
  "Closing Debit", "Closing Credit",
];

/** فيكتشر FULL متوازن حصرًا: افتتاح 1000/1000، فترة 1300/1300، إغلاق 1900/1900. */
const BASE_FULL = fixtureFromAoa(FULL_HEADERS, [
  ["1101", "Cash",     1000, 0,    700, 200, 1500, 0],
  ["2101", "Payables", 0,    1000, 200, 500, 0,    1300],
  ["3101", "Salaries", 0,    0,    400, 0,   400,  0],
  ["4100", "Revenue",  0,    0,    0,   600, 0,    600],
]);

const COMPANY_RULE_21: MappingRuleLike = {
  id: "rule-21",
  companyId: "c1",
  prefix: "21",
  mainCategory: "LIABILITIES_EQUITY",
  classification: "LIABILITY",
  aggregationBehavior: "BALANCE",
  statementLineCode: null,
  source: "COMPANY",
  isActive: true,
};

const RULES_WITH_COMPANY: readonly MappingRuleLike[] = [...SYSTEM_ROOT_MAPPING_RULES, COMPANY_RULE_21];

function cloneFixtureWithRowEdit(
  base: Fixture,
  rowIndex: number,
  edited: Array<string | number>,
): Fixture {
  const dataRows = base.rows.map((r) => {
    const out: string[] = [
      r.accountCodeRaw,
      r.accountNameRaw,
      r.monetary.OPENING_DEBIT.rawText,
      r.monetary.OPENING_CREDIT.rawText,
      r.monetary.PERIOD_DEBIT.rawText,
      r.monetary.PERIOD_CREDIT.rawText,
      r.monetary.CLOSING_DEBIT.rawText,
      r.monetary.CLOSING_CREDIT.rawText,
    ];
    return out.map((v) => (v === "" ? 0 : v.startsWith("(") || /[^0-9]/.test(v) ? v : Number(v)));
  });
  dataRows[rowIndex] = edited;
  return fixtureFromAoa(FULL_HEADERS, dataRows);
}

function baseRequest(overrides: Partial<TbNormalizationRequest> = {}): TbNormalizationRequest {
  return {
    shape: "FULL_MOVEMENT",
    shapeSource: "USER_CONFIRMED",
    rows: BASE_FULL.rows,
    mapping: BASE_FULL.mapping,
    repeatedHeaderRowNumbers: [],
    subtotalFlags: [],
    subtotalResolutions: {},
    periodStartOrdinal: 3,
    periodEndOrdinal: 3,
    sourceCurrency: "SAR",
    functionalCurrency: "SAR",
    minorUnits: 2,
    completeness: "COMPLETE",
    subsetAcknowledged: false,
    flowClosingSemantics: null,
    classificationRules: RULES_WITH_COMPANY,
    classificationCompanyId: "c1",
    ...overrides,
  };
}

function errorsOf(result: ReturnType<typeof normalizeTbSource>) {
  return result.errors;
}
function hasError(result: ReturnType<typeof normalizeTbSource>, code: string): boolean {
  return result.errors.some((e) => e.code === code);
}
function candidateByCode(
  result: ReturnType<typeof normalizeTbSource>,
  code: string,
) {
  return result.draftLineCandidates.find((c) => c.accountCode === code);
}

/* ═══ الفحوص السبعون المستقلة ═══ */

// ── المحلل النقدي (1–10) ──

check(1, "Integer monetary parse", () => {
  const r = parseMonetaryToMinor("1234", 2);
  assert(r.kind === "value" && r.minor === BigInt(123400), `got ${r.kind}/${String(r.kind === "value" ? r.minor : BigInt(-1))}`);
});

check(2, "Decimal monetary parse", () => {
  const a = parseMonetaryToMinor("1.2", 2);
  const b = parseMonetaryToMinor("1.20", 2);
  assert(a.kind === "value" && a.minor === BigInt(120), `1.2 → ${a.kind}/${String(a.kind === "value" ? a.minor : BigInt(-1))}`);
  assert(b.kind === "value" && b.minor === BigInt(120), `1.20 → ${b.kind}/${String(b.kind === "value" ? b.minor : BigInt(-1))}`);
});

check(3, "Comma separator parse", () => {
  const r = parseMonetaryToMinor("1,234.56", 2);
  assert(r.kind === "value" && r.minor === BigInt(123456), `got ${r.kind}/${String(r.kind === "value" ? r.minor : BigInt(-1))}`);
});

check(4, "Parentheses negative parse", () => {
  const r = parseMonetaryToMinor("(25.50)", 2);
  assert(r.kind === "value" && r.minor === BigInt(-2550), `got ${r.kind}/${String(r.kind === "value" ? r.minor : BigInt(-1))}`);
});

check(5, "Minus negative parse", () => {
  const r = parseMonetaryToMinor("-1234.56", 2);
  assert(r.kind === "value" && r.minor === BigInt(-123456), `got ${r.kind}/${String(r.kind === "value" ? r.minor : BigInt(-1))}`);
});

check(6, "Blank monetary cell", () => {
  const blank = parseMonetaryToMinor("   ", 2);
  assert(blank.kind === "blank", `parser got ${JSON.stringify(blank)}`);
  const res = normalizeTbSource(baseRequest({
    rows: fixtureFromAoa(FULL_HEADERS, [["1101", "Cash", "", "", 700, 200, 1500, 0]]).rows,
    mapping: fixtureFromAoa(FULL_HEADERS, [["1101", "Cash", "", "", 700, 200, 1500, 0]]).mapping,
    completeness: "SUBSET",
    subsetAcknowledged: true,
  }));
  const cash = res.acceptedRows.find((r) => r.accountCode === "1101");
  assert(cash !== undefined, "cash row missing");
  assert(cash.parsedMonetary.OPENING_DEBIT === BigInt(0) && cash.parsedMonetary.OPENING_CREDIT === BigInt(0),
    `blank must equal zero, got ${String(cash.parsedMonetary.OPENING_DEBIT)}`);
});

check(7, "Overprecision blocked", () => {
  const r = parseMonetaryToMinor("1.234", 2);
  assert(r.kind === "invalid" && r.code === "MONETARY_OVERPRECISION", `got ${JSON.stringify(r)}`);
  const res = normalizeTbSource(baseRequest({
    rows: fixtureFromAoa(FULL_HEADERS, [["1101", "Cash", "1.234", 0, 0, 0, 0, 0]]).rows,
    mapping: fixtureFromAoa(FULL_HEADERS, [["1101", "Cash", "1.234", 0, 0, 0, 0, 0]]).mapping,
    completeness: "SUBSET",
    subsetAcknowledged: true,
  }));
  assert(hasError(res, "MONETARY_OVERPRECISION"), "overprecision not blocked at row level");
});

check(8, "Malformed numeric blocked", () => {
  for (const bad of ["1,23", "12,3456", ",123", "123,", "1.2.3", "1.", ".5", "1 234", "$5"]) {
    const r = parseMonetaryToMinor(bad, 2);
    assert(r.kind === "invalid" && r.code === "MONETARY_INVALID", `«${bad}» → ${JSON.stringify(r)}`);
  }
});

check(9, "NaN-like blocked", () => {
  for (const bad of ["NaN", "-NaN", "nan"]) {
    const r = parseMonetaryToMinor(bad, 2);
    assert(r.kind === "invalid" && r.code === "MONETARY_INVALID", `«${bad}» → ${JSON.stringify(r)}`);
  }
});

check(10, "Infinity-like blocked", () => {
  for (const bad of ["Infinity", "-Infinity", "1e3", "0x10"]) {
    const r = parseMonetaryToMinor(bad, 2);
    assert(r.kind === "invalid" && r.code === "MONETARY_INVALID", `«${bad}» → ${JSON.stringify(r)}`);
  }
});

// ── معادلة الصف (11–14) ──

check(11, "FULL equation pass", () => {
  const res = normalizeTbSource(baseRequest());
  assert(res.status === "VALID", `status=${res.status} errors=${JSON.stringify(errorsOf(res).map((e) => e.code))}`);
  assert(res.rowEquationResults.length === 4, `equations=${res.rowEquationResults.length}`);
  assert(res.rowEquationResults.every((e) => e.passes), "all equations must pass");
});

check(12, "FULL equation failure detected", () => {
  const fx = cloneFixtureWithRowEdit(BASE_FULL, 0, ["1101", "Cash", 1000, 0, 700, 200, 1400, 0]);
  const res = normalizeTbSource(baseRequest({ rows: fx.rows, mapping: fx.mapping }));
  assert(hasError(res, "ROW_EQUATION_MISMATCH"), "equation failure not detected");
  assert(res.status === "BLOCKED", `status=${res.status}`);
});

check(13, "Equation difference exact", () => {
  const fx = cloneFixtureWithRowEdit(BASE_FULL, 0, ["1101", "Cash", 1000, 0, 700, 200, 1400, 0]);
  const res = normalizeTbSource(baseRequest({ rows: fx.rows, mapping: fx.mapping }));
  const cash = res.rowEquationResults.find((e) => e.accountCode === "1101");
  assert(cash !== undefined, "cash equation missing");
  assert(cash.openingNetMinor === M(1000), `opening=${cash.openingNetMinor}`);
  assert(cash.movementNetMinor === M(500), `movement=${cash.movementNetMinor}`);
  assert(cash.closingNetMinor === M(1400), `closing=${cash.closingNetMinor}`);
  assert(cash.differenceMinor === M(100), `difference=${cash.differenceMinor}`);
});

check(14, "Period debit+credit both non-zero accepted", () => {
  const res = normalizeTbSource(baseRequest()); // Cash period 700/200 — كلا الجانبين
  assert(res.status === "VALID", `status=${res.status}`);
  const cash = res.acceptedRows.find((r) => r.accountCode === "1101");
  assert(cash !== undefined, "cash row missing");
  assert(cash.bothSidesWarnings.length === 0, "period both-sides must not warn");
  assert(candidateByCode(res, "1101") !== undefined, "cash candidate missing");
});

// ── تكامل التصنيف المعتمد (15–21) ──

check(15, "Root1 classification integration", () => {
  const res = normalizeTbSource(baseRequest());
  const cash = res.classificationResults.find((c) => c.accountCode === "1101");
  assert(cash !== undefined, "cash classification missing");
  assert(cash.classification === "ASSET", `classification=${cash.classification}`);
  assert(cash.aggregationBehavior === "BALANCE", `behavior=${cash.aggregationBehavior}`);
  assert(cash.provenanceSource === "SYSTEM_ROOT", `source=${cash.provenanceSource}`);
});

check(16, "Root2 detailed classification integration", () => {
  const res = normalizeTbSource(baseRequest());
  const pay = res.classificationResults.find((c) => c.accountCode === "2101");
  assert(pay !== undefined, "payables classification missing");
  assert(pay.classification === "LIABILITY", `classification=${pay.classification}`);
  assert(pay.aggregationBehavior === "BALANCE", `behavior=${pay.aggregationBehavior}`);
  assert(pay.provenanceSource === "COMPANY_PREFIX", `source=${pay.provenanceSource}`);
});

check(17, "Unresolved root2 explicit", () => {
  const res = normalizeTbSource(baseRequest({ classificationRules: SYSTEM_ROOT_MAPPING_RULES }));
  const pay = res.classificationResults.find((c) => c.accountCode === "2101");
  assert(pay !== undefined, "payables classification missing");
  assert(pay.resolved === false, "must be unresolved");
  assert(pay.mappingStatus === "NEEDS_DETAILED_CLASSIFICATION", `status=${pay.mappingStatus}`);
  assert(hasError(res, "UNRESOLVED_ACCOUNT_CLASSIFICATION"), "unresolved must block");
});

check(18, "Root3 expense", () => {
  const res = normalizeTbSource(baseRequest());
  const sal = res.classificationResults.find((c) => c.accountCode === "3101");
  assert(sal !== undefined, "salaries classification missing");
  assert(sal.classification === "EXPENSE" && sal.aggregationBehavior === "FLOW",
    `got ${sal.classification}/${sal.aggregationBehavior}`);
});

check(19, "3101 expense (never equity)", () => {
  const res = normalizeTbSource(baseRequest());
  const sal = res.classificationResults.find((c) => c.accountCode === "3101");
  assert(sal !== undefined && sal.classification === "EXPENSE", `got ${String(sal?.classification)}`);
  assert(String(sal.classification) !== "EQUITY", "3101 must never be EQUITY");
});

check(20, "Root4 revenue", () => {
  const res = normalizeTbSource(baseRequest());
  const rev = res.classificationResults.find((c) => c.accountCode === "4100");
  assert(rev !== undefined && rev.classification === "REVENUE" && rev.aggregationBehavior === "FLOW",
    `got ${String(rev?.classification)}/${String(rev?.aggregationBehavior)}`);
});

check(21, "Contradictory classification not accepted", () => {
  const corrupt: MappingRuleLike = {
    id: "rule-31-corrupt", companyId: "c1", prefix: "31",
    mainCategory: "LIABILITIES_EQUITY", classification: "EQUITY",
    aggregationBehavior: "BALANCE", statementLineCode: null, source: "COMPANY", isActive: true,
  };
  const res = normalizeTbSource(baseRequest({
    classificationRules: [...RULES_WITH_COMPANY, corrupt],
  }));
  const sal = res.classificationResults.find((c) => c.accountCode === "3101");
  assert(sal !== undefined, "salaries classification missing");
  assert(sal.classification === "EXPENSE", `corrupt rule must be ignored, got ${sal.classification}`);
  assert(sal.provenanceSource === "SYSTEM_ROOT", `provenance=${sal.provenanceSource}`);
});

// ── FULL_MOVEMENT (22–26) ──

check(22, "FULL FLOW uses period pair", () => {
  const res = normalizeTbSource(baseRequest());
  const sal = candidateByCode(res, "3101");
  assert(sal !== undefined, "salaries candidate missing");
  assert(sal.debitMinor === M(400) && sal.creditMinor === BigInt(0),
    `got ${String(sal.debitMinor)}/${String(sal.creditMinor)} (period pair required)`);
  assert(sal.rowSemantics === "PERIOD_MOVEMENT", `semantics=${sal.rowSemantics}`);
});

check(23, "FULL BALANCE uses closing pair", () => {
  const res = normalizeTbSource(baseRequest());
  const cash = candidateByCode(res, "1101");
  assert(cash !== undefined, "cash candidate missing");
  assert(cash.debitMinor === M(1500) && cash.creditMinor === BigInt(0),
    `got ${String(cash.debitMinor)}/${String(cash.creditMinor)} (closing pair required)`);
  assert(cash.rowSemantics === "CLOSING_AS_OF", `semantics=${cash.rowSemantics}`);
});

check(24, "FULL dataType PERIOD_MOVEMENT", () => {
  const res = normalizeTbSource(baseRequest());
  assert(res.dataTypeCandidate === "PERIOD_MOVEMENT", `got ${res.dataTypeCandidate}`);
});

check(25, "FULL never uses FLOW closing as YTD", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [
    ["4100", "Revenue", 0, 399, 0, 600, 0, 999],
  ]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(res.dataTypeCandidate !== "CUMULATIVE_YTD", "closing must not become YTD");
  const rev = candidateByCode(res, "4100");
  assert(rev !== undefined, "revenue candidate missing");
  assert(rev.creditMinor === M(600), `reporting credit must be period 600, got ${rev.creditMinor}`);
  assert(rev.creditMinor !== M(999), "closing pair leaked into reporting amount");
  assert(rev.rowSemantics === "PERIOD_MOVEMENT", `semantics=${rev.rowSemantics}`);
});

check(26, "Multi-period FULL blocked", () => {
  const res = normalizeTbSource(baseRequest({ periodStartOrdinal: 1, periodEndOrdinal: 3 }));
  assert(hasError(res, "MULTI_PERIOD_FULL_MOVEMENT_BLOCKED"), "multi-period must block");
  assert(res.status === "BLOCKED", `status=${res.status}`);
});

// ── CLOSING_ONLY (27–29) ──

const CLOSING_HEADERS = ["Account Code", "Account Name", "Closing Debit", "Closing Credit"];

check(27, "Closing-only BALANCE as-of candidate", () => {
  const fx = fixtureFromAoa(CLOSING_HEADERS, [
    ["1101", "Cash", 1500, 0],
    ["2101", "Payables", 0, 1300],
  ]);
  const res = normalizeTbSource(baseRequest({
    shape: "CLOSING_ONLY", rows: fx.rows, mapping: fx.mapping,
    completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(res.status === "VALID", `status=${res.status} errors=${JSON.stringify(errorsOf(res).map((e) => e.code))}`);
  assert(res.dataTypeCandidate === "BALANCE_AS_OF", `got ${res.dataTypeCandidate}`);
  const cash = candidateByCode(res, "1101");
  assert(cash !== undefined && cash.debitMinor === M(1500) && cash.creditMinor === BigInt(0),
    `got ${String(cash?.debitMinor)}/${String(cash?.creditMinor)}`);
  assert(cash !== undefined && cash.rowSemantics === "CLOSING_AS_OF", `semantics=${String(cash?.rowSemantics)}`);
});

check(28, "Closing-only FLOW undeclared blocked", () => {
  const fx = fixtureFromAoa(CLOSING_HEADERS, [
    ["1101", "Cash", 1500, 0],
    ["4100", "Revenue", 0, 600],
  ]);
  const res = normalizeTbSource(baseRequest({
    shape: "CLOSING_ONLY", rows: fx.rows, mapping: fx.mapping,
    completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(hasError(res, "FLOW_CLOSING_SEMANTICS_UNDECLARED"), "undeclared semantics must block");
  assert(res.status === "BLOCKED", `status=${res.status}`);
  assert(res.dataTypeCandidate === null, `candidate must be null, got ${res.dataTypeCandidate}`);
  assert(candidateByCode(res, "4100") === undefined, "FLOW row must have no candidate");
});

check(29, "Closing-only FLOW explicit cumulative accepted", () => {
  const fx = fixtureFromAoa(CLOSING_HEADERS, [
    ["1101", "Cash", 1500, 0],
    ["4100", "Revenue", 0, 600],
  ]);
  const res = normalizeTbSource(baseRequest({
    shape: "CLOSING_ONLY", rows: fx.rows, mapping: fx.mapping,
    completeness: "SUBSET", subsetAcknowledged: true,
    flowClosingSemantics: "CUMULATIVE_YTD",
  }));
  assert(res.status === "VALID", `status=${res.status} errors=${JSON.stringify(errorsOf(res).map((e) => e.code))}`);
  assert(res.dataTypeCandidate === "CUMULATIVE_YTD", `got ${res.dataTypeCandidate}`);
  const rev = candidateByCode(res, "4100");
  assert(rev !== undefined && rev.rowSemantics === "CUMULATIVE_YTD",
    `got ${String(rev?.creditMinor)}/${String(rev?.rowSemantics)}`);
  const cash = candidateByCode(res, "1101");
  assert(cash !== undefined && cash.rowSemantics === "CLOSING_AS_OF", "BALANCE rows stay as-of");
});

// ── MOVEMENT_ONLY (30–32) ──

const MOVEMENT_HEADERS = ["Account Code", "Account Name", "Period Debit", "Period Credit"];

check(30, "Movement-only FLOW accepted", () => {
  const fx = fixtureFromAoa(MOVEMENT_HEADERS, [
    ["3101", "Salaries", 400, 0],
    ["4100", "Revenue", 0, 400],
  ]);
  const res = normalizeTbSource(baseRequest({
    shape: "MOVEMENT_ONLY", rows: fx.rows, mapping: fx.mapping, completeness: "COMPLETE",
  }));
  assert(res.status === "VALID", `status=${res.status} errors=${JSON.stringify(errorsOf(res).map((e) => e.code))}`);
  assert(res.dataTypeCandidate === "PERIOD_MOVEMENT", `got ${res.dataTypeCandidate}`);
  const sal = candidateByCode(res, "3101");
  assert(sal !== undefined && sal.debitMinor === M(400) && sal.rowSemantics === "PERIOD_MOVEMENT",
    `got ${String(sal?.debitMinor)}/${String(sal?.rowSemantics)}`);
});

check(31, "Movement-only BALANCE blocked", () => {
  const fx = fixtureFromAoa(MOVEMENT_HEADERS, [
    ["3101", "Salaries", 400, 0],
    ["1101", "Cash", 700, 200],
  ]);
  const res = normalizeTbSource(baseRequest({
    shape: "MOVEMENT_ONLY", rows: fx.rows, mapping: fx.mapping,
    completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(hasError(res, "BALANCE_MOVEMENT_ONLY_BLOCKED"), "BALANCE must block");
  assert(res.status === "BLOCKED", `status=${res.status}`);
  assert(candidateByCode(res, "1101") === undefined, "blocked BALANCE row must have no candidate");
});

check(32, "Zero BALANCE movement-only still blocked", () => {
  const fx = fixtureFromAoa(MOVEMENT_HEADERS, [["1101", "Cash", 0, 0]]);
  const res = normalizeTbSource(baseRequest({
    shape: "MOVEMENT_ONLY", rows: fx.rows, mapping: fx.mapping,
    completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(hasError(res, "BALANCE_MOVEMENT_ONLY_BLOCKED"), "zero BALANCE must still block");
  assert(res.draftLineCandidates.length === 0, "no candidates allowed");
});

// ── التكرار والمجاميع والبنيوي (33–39) ──

check(33, "Duplicate account blocked", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [
    ["1101", "Cash", 1000, 0, 700, 200, 1500, 0],
    ["1101", "Cash copy", 0, 0, 50, 0, 50, 0],
  ]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(hasError(res, "DUPLICATE_ACCOUNT_CODE"), "duplicate must block");
  assert(res.duplicateResults.blocked === true, "duplicateResults.blocked wrong");
  assert(res.status === "BLOCKED" && res.persistenceReady === false, `status=${res.status}`);
  const dup = res.duplicateResults.duplicates[0];
  assert(dup !== undefined && dup.accountCode === "1101" && dup.count === 2,
    `got ${JSON.stringify(dup)}`);
});

check(34, "Duplicate not aggregated", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [
    ["1101", "Cash", 1000, 0, 700, 200, 1500, 0],
    ["1101", "Cash copy", 0, 0, 50, 0, 50, 0],
  ]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  const cashRows = res.acceptedRows.filter((r) => r.accountCode === "1101");
  assert(cashRows.length === 2, `rows must stay distinct, got ${cashRows.length}`);
  const debits = cashRows.map((r) => r.parsedMonetary.PERIOD_DEBIT).sort();
  assert(JSON.stringify(debits.map(String)) === JSON.stringify([M(50), M(700)].map(String)),
    `debits=${debits.map(String).join(",")}`);
  assert(res.duplicateResults.duplicates[0]?.sourceRowNumbers?.length === 2, "duplicate rows wrong");
});

check(35, "Subtotal unresolved blocked", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [
    ["1101", "Cash", 1000, 0, 700, 200, 1500, 0],
    ["X1", "إجمالي الأصول", 1000, 0, 0, 0, 1000, 0],
  ]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping,
    subtotalFlags: flagSuspectedSubtotalRows(fx.rows),
    completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(hasError(res, "SUBTOTAL_RESOLUTION_REQUIRED"), "unresolved subtotal must block");
  assert(res.status === "BLOCKED", `status=${res.status}`);
  const flagged = res.acceptedRows.find((r) => r.sourceRowNumber === 3);
  assert(flagged !== undefined, "flagged row must stay visible (no silent drop)");
});

check(36, "Subtotal excluded omitted", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [
    ["1101", "Cash", 1000, 0, 700, 200, 1500, 0],
    ["X1", "إجمالي الأصول", 1000, 0, 0, 0, 1000, 0],
  ]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping,
    subtotalFlags: flagSuspectedSubtotalRows(fx.rows),
    subtotalResolutions: { 3: "EXCLUDED" },
    completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(res.status === "VALID", `status=${res.status} errors=${JSON.stringify(errorsOf(res).map((e) => e.code))}`);
  assert(res.acceptedRows.every((r) => r.sourceRowNumber !== 3), "excluded row leaked into accepted");
  assert(candidateByCode(res, "X1") === undefined, "excluded row leaked into candidates");
  assert(res.subtotalExclusions.length === 1 && res.subtotalExclusions[0].accountCode === "X1",
    `exclusions=${JSON.stringify(res.subtotalExclusions)}`);
});

check(37, "Subtotal kept validated as detail", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [
    ["1101", "Cash", 1000, 0, 700, 200, 1500, 0],
    ["1999", "إجمالي الأصول", 0, 0, 0, 0, 0, 0],
  ]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping,
    subtotalFlags: flagSuspectedSubtotalRows(fx.rows),
    subtotalResolutions: { 3: "KEPT" },
    completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(res.status === "VALID", `status=${res.status} errors=${JSON.stringify(errorsOf(res).map((e) => e.code))}`);
  const kept = res.acceptedRows.find((r) => r.sourceRowNumber === 3);
  assert(kept !== undefined && kept.equation !== null, "KEPT row must be fully validated");
  const cand = candidateByCode(res, "1999");
  assert(cand !== undefined, "KEPT subtotal must be a normal detail candidate");
  assert(res.subtotalExclusions.length === 0, "KEPT must not appear as exclusion");
});

check(38, "Repeated header structural exclusion", () => {
  const csv = [
    "Account Code,Account Name,Opening Debit,Opening Credit,Period Debit,Period Credit,Closing Debit,Closing Credit",
    "1101,Cash,1000,0,700,200,1500,0",
    "Account Code,Account Name,Opening Debit,Opening Credit,Period Debit,Period Credit,Closing Debit,Closing Credit",
    "4100,Revenue,0,0,0,600,0,600",
  ].join("\n");
  const grid = parseCsvGrid(csv);
  const rep = detectRepeatedHeaderRows(grid, 0, 1);
  assert(JSON.stringify(rep.repeatedRowNumbers) === JSON.stringify([3]), `detected=${JSON.stringify(rep)}`);
  const mapping = mapTbHeaders(grid[0].map((c) => c.text));
  const rows = extractTbSourceRows(grid, { mapping, headerRowIndex: 0, headerRowCount: 1 });
  const res = normalizeTbSource(baseRequest({
    rows, mapping, repeatedHeaderRowNumbers: rep.repeatedRowNumbers,
    completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(JSON.stringify(res.structuralExclusions.repeatedHeaderRows) === JSON.stringify([3]),
    `exclusions=${JSON.stringify(res.structuralExclusions)}`);
  assert(res.acceptedRows.every((r) => r.sourceRowNumber !== 3), "repeated header leaked into accepted");
});

check(39, "Blank row structural exclusion", () => {
  const csv = [
    "Account Code,Account Name,Opening Debit,Opening Credit,Period Debit,Period Credit,Closing Debit,Closing Credit",
    "1101,Cash,1000,0,700,200,1500,0",
    "",
    "4100,Revenue,0,0,0,600,0,600",
  ].join("\n");
  const grid = parseCsvGrid(csv);
  const mapping = mapTbHeaders(grid[0].map((c) => c.text));
  const rows = extractTbSourceRows(grid, { mapping, headerRowIndex: 0, headerRowCount: 1 });
  const blank = rows.find((r) => r.isBlank);
  assert(blank !== undefined && blank.sourceRowNumber === 3, "blank row not detected");
  const res = normalizeTbSource(baseRequest({
    rows, mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(JSON.stringify(res.structuralExclusions.blankRows) === JSON.stringify([3]),
    `exclusions=${JSON.stringify(res.structuralExclusions)}`);
  assert(res.acceptedRows.every((r) => r.sourceRowNumber !== 3), "blank row leaked into accepted");
});

// ── COMPLETE/SUBSET (40–45) ──

check(40, "COMPLETE opening imbalance blocked", () => {
  const fx = cloneFixtureWithRowEdit(BASE_FULL, 1, ["2101", "Payables", 0, 1100, 200, 500, 0, 1300]);
  const res = normalizeTbSource(baseRequest({ rows: fx.rows, mapping: fx.mapping }));
  const mismatch = errorsOf(res).find((e) => e.code === "COMPLETE_CONTROL_TOTAL_MISMATCH");
  assert(mismatch !== undefined, "opening imbalance must block");
  assert(mismatch.details?.group === "opening", `group=${String(mismatch.details?.group)}`);
});

check(41, "COMPLETE period imbalance blocked", () => {
  const fx = cloneFixtureWithRowEdit(BASE_FULL, 2, ["3101", "Salaries", 0, 0, 500, 0, 400, 0]);
  const res = normalizeTbSource(baseRequest({ rows: fx.rows, mapping: fx.mapping }));
  const mismatch = errorsOf(res).find((e) => e.code === "COMPLETE_CONTROL_TOTAL_MISMATCH");
  assert(mismatch !== undefined, "period imbalance must block");
  assert(mismatch.details?.group === "period", `group=${String(mismatch.details?.group)}`);
});

check(42, "COMPLETE closing imbalance blocked", () => {
  const fx = cloneFixtureWithRowEdit(BASE_FULL, 3, ["4100", "Revenue", 0, 0, 0, 600, 0, 700]);
  const res = normalizeTbSource(baseRequest({ rows: fx.rows, mapping: fx.mapping }));
  const mismatch = errorsOf(res).find((e) => e.code === "COMPLETE_CONTROL_TOTAL_MISMATCH");
  assert(mismatch !== undefined, "closing imbalance must block");
  assert(mismatch.details?.group === "closing", `group=${String(mismatch.details?.group)}`);
});

check(43, "SUBSET imbalance disclosed", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [["1101", "Cash", 1000, 0, 0, 1000, 0, 0]]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(res.status === "VALID" && res.persistenceReady, `status=${res.status}`);
  assert(res.controlTotals !== null, "totals missing");
  assert(res.controlTotals.opening !== undefined && res.controlTotals.period !== undefined && res.controlTotals.closing !== undefined,
    "control groups missing");
  assert(res.controlTotals.opening.differenceMinor === M(1000),
    `difference=${String(res.controlTotals.opening.differenceMinor)}`);
  assert(res.controlTotals.period.differenceMinor === M(-1000), "period difference wrong");
  assert(res.controlTotals.closing.differenceMinor === BigInt(0), "closing difference wrong");
  assert(!hasError(res, "COMPLETE_CONTROL_TOTAL_MISMATCH"), "SUBSET must not emit COMPLETE mismatch");
});

check(44, "SUBSET without acknowledgment blocked", () => {
  const res = normalizeTbSource(baseRequest({ completeness: "SUBSET", subsetAcknowledged: false }));
  assert(hasError(res, "SUBSET_ACKNOWLEDGMENT_REQUIRED"), "missing acknowledgment must block");
  assert(res.status === "BLOCKED" && res.persistenceReady === false, `status=${res.status}`);
});

check(45, "SUBSET acknowledged accepted", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [["1101", "Cash", 1000, 0, 0, 1000, 0, 0]]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(res.status === "VALID" && res.persistenceReady === true, `status=${res.status}`);
});

// ── العملة/FX (46–48) ──

check(46, "Source currency mismatch blocked", () => {
  const res = normalizeTbSource(baseRequest({ sourceCurrency: "USD" }));
  assert(hasError(res, "FOREIGN_CURRENCY_TB_REQUIRES_FX_PROCESS"), "FX requirement must block");
  assert(res.status === "BLOCKED", `status=${res.status}`);
});

check(47, "No FX conversion path", () => {
  const res = normalizeTbSource(baseRequest({ sourceCurrency: "USD" }));
  const keys = Object.keys(res);
  assert(!keys.some((k) => /rate|convert/i.test(k)), `forbidden key in result: ${keys.join(",")}`);
  assert(res.controlTotals === null, "no control totals should exist for blocked currency");
  assert(res.draftLineCandidates.length === 0 && res.acceptedRows.length === 0,
    "no conversion may happen for blocked currency");
});

check(48, "Functional currency missing blocked", () => {
  const res = normalizeTbSource(baseRequest({ functionalCurrency: null }));
  assert(hasError(res, "FUNCTIONAL_CURRENCY_UNCONFIGURED"), "missing functional currency must block");
  assert(res.status === "BLOCKED", `status=${res.status}`);
});

// ── أمان أكواد الحسابات (49–50) ──

check(49, "Text leading-zero account code preserved", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [["00101", "Cash", 1000, 0, 700, 200, 1500, 0]]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  const row = res.acceptedRows.find((r) => r.accountCode === "00101");
  assert(row !== undefined, "row missing");
  assert(row.accountCode === "00101", `code=${row.accountCode}`);
  assert(row.accountCodeIsNumericSource === false, "text code must not be flagged numeric");
});

check(50, "Numeric-source warning preserved", () => {
  const grid: TbGrid = [
    FULL_HEADERS.map(t),
    [n(102), t("Gamma"), t("1000"), t("0"), t("700"), t("200"), t("1500"), t("0")],
  ];
  const mapping = mapTbHeaders(FULL_HEADERS);
  const rows = extractTbSourceRows(grid, { mapping, headerRowIndex: 0, headerRowCount: 1 });
  const res = normalizeTbSource(baseRequest({
    rows, mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  const row = res.acceptedRows.find((r) => r.accountCode === "102");
  assert(row !== undefined && row.accountCodeIsNumericSource === true, "numeric flag lost");
  const cand = candidateByCode(res, "102");
  assert(cand !== undefined && cand.accountCodeIsNumericSource === true, "flag lost in candidate");
  assert(cand.accountCode === "102" && !cand.accountCode.startsWith("0"), "zeros invented");
});

// ── الهاش القياني (51–54، 70) ──

check(51, "Deterministic source hash", () => {
  const a = computeTbSourcePayloadHash(baseRequest());
  const b = computeTbSourcePayloadHash(baseRequest());
  assert(a === b, `hash1=${a} hash2=${b}`);
  assert(/^[0-9a-f]{64}$/.test(a), `not a sha-256 hex: ${a}`);
});

check(52, "Property-order-independent source hash", () => {
  assert(canonicalJsonStringify({ b: 1, a: 2 }) === canonicalJsonStringify({ a: 2, b: 1 }),
    "canonical serializer is insertion-order dependent");
  const reqA: TbNormalizationRequest = {
    shape: "FULL_MOVEMENT", shapeSource: "USER_CONFIRMED", rows: BASE_FULL.rows,
    mapping: BASE_FULL.mapping, periodStartOrdinal: 3, periodEndOrdinal: 3,
    sourceCurrency: "SAR", functionalCurrency: "SAR", minorUnits: 2,
    completeness: "COMPLETE", subsetAcknowledged: false, flowClosingSemantics: null,
    classificationRules: RULES_WITH_COMPANY, classificationCompanyId: "c1",
    repeatedHeaderRowNumbers: [], subtotalFlags: [], subtotalResolutions: {},
  };
  const reqB: TbNormalizationRequest = {
    subtotalResolutions: {}, subtotalFlags: [], repeatedHeaderRowNumbers: [],
    classificationCompanyId: "c1", classificationRules: RULES_WITH_COMPANY,
    flowClosingSemantics: null, subsetAcknowledged: false, completeness: "COMPLETE",
    minorUnits: 2, functionalCurrency: "SAR", sourceCurrency: "SAR",
    periodEndOrdinal: 3, periodStartOrdinal: 3, mapping: BASE_FULL.mapping,
    rows: BASE_FULL.rows, shapeSource: "USER_CONFIRMED", shape: "FULL_MOVEMENT",
  };
  assert(computeTbSourcePayloadHash(reqA) === computeTbSourcePayloadHash(reqB),
    "hash must be independent of request property insertion order");
});

check(53, "Source hash changes when monetary source changes", () => {
  const fx = cloneFixtureWithRowEdit(BASE_FULL, 0, ["1101", "Cash", 1000, 0, 701, 200, 1500, 0]);
  const h1 = computeTbSourcePayloadHash(baseRequest());
  const h2 = computeTbSourcePayloadHash(baseRequest({ rows: fx.rows, mapping: fx.mapping }));
  assert(h1 !== h2, "monetary change must change the hash");
});

check(54, "Source hash changes when mapping changes", () => {
  const reorderedHeaders = [
    "Account Name", "Account Code",
    "Opening Debit", "Opening Credit",
    "Period Debit", "Period Credit",
    "Closing Debit", "Closing Credit",
  ];
  const grid: TbGrid = [
    reorderedHeaders.map(t),
    ["Cash", "1101", "1000", "0", "700", "200", "1500", "0"].map(t),
    ["Payables", "2101", "0", "1000", "200", "500", "0", "1300"].map(t),
    ["Salaries", "3101", "0", "0", "400", "0", "400", "0"].map(t),
    ["Revenue", "4100", "0", "0", "0", "600", "0", "600"].map(t),
  ];
  const mapping = mapTbHeaders(reorderedHeaders);
  const rows = extractTbSourceRows(grid, { mapping, headerRowIndex: 0, headerRowCount: 1 });
  const h1 = computeTbSourcePayloadHash(baseRequest());
  const h2 = computeTbSourcePayloadHash(baseRequest({ rows, mapping }));
  assert(h1 !== h2, "mapping change must change the hash");
});

// ── لا OTHER ولا plug (55–56) ──

check(55, "No OTHER fallback", () => {
  const res = normalizeTbSource(baseRequest({ classificationRules: SYSTEM_ROOT_MAPPING_RULES }));
  assert(res.classificationResults.every((c) => c.classification !== "OTHER"),
    "OTHER must never be synthesized");
  const pay = res.classificationResults.find((c) => c.accountCode === "2101");
  assert(pay !== undefined && pay.classification === null, "unresolved must stay explicit null");
  assert(hasError(res, "UNRESOLVED_ACCOUNT_CLASSIFICATION"), "unresolved must block");
});

check(56, "No balancing plug behavior", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [["1101", "Cash", 1000, 0, 0, 1000, 0, 0]]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(res.status === "VALID", `status=${res.status}`);
  assert(res.draftLineCandidates.length === res.acceptedRows.length,
    `candidates=${res.draftLineCandidates.length} accepted=${res.acceptedRows.length}`);
  const sourceCodes = new Set(fx.rows.map((r) => r.accountCodeRaw.trim()));
  assert(res.draftLineCandidates.every((c) => sourceCodes.has(c.accountCode)),
    "synthetic (plug) row detected");
  assert(res.controlTotals !== null && res.controlTotals.opening !== undefined &&
    res.controlTotals.opening.differenceMinor === M(1000),
    "disclosed difference must not be plugged to zero");
});

// ── فحوص إضافية مستقلة (57–70) ──

check(57, "Invalid currency precision blocked", () => {
  const neg = normalizeTbSource(baseRequest({ minorUnits: -1 }));
  const frac = normalizeTbSource(baseRequest({ minorUnits: 2.5 }));
  assert(hasError(neg, "INVALID_CURRENCY_PRECISION"), "negative precision must fail");
  assert(hasError(frac, "INVALID_CURRENCY_PRECISION"), "fractional precision must fail");
  assert(neg.status === "BLOCKED" && neg.acceptedRows.length === 0, "blocked precision must stop processing");
});

check(58, "Closing-only COMPLETE closing control mismatch blocked", () => {
  const fx = fixtureFromAoa(CLOSING_HEADERS, [
    ["1101", "Cash", 1500, 0],
    ["2101", "Payables", 0, 1300],
  ]);
  const res = normalizeTbSource(baseRequest({
    shape: "CLOSING_ONLY", rows: fx.rows, mapping: fx.mapping, completeness: "COMPLETE",
  }));
  const mismatch = errorsOf(res).find((e) => e.code === "COMPLETE_CONTROL_TOTAL_MISMATCH");
  assert(mismatch !== undefined, "closing imbalance must block");
  assert(mismatch.details?.group === "closing", `group=${String(mismatch.details?.group)}`);
});

check(59, "Movement-only COMPLETE period control mismatch blocked", () => {
  const fx = fixtureFromAoa(MOVEMENT_HEADERS, [["3101", "Salaries", 400, 0]]);
  const res = normalizeTbSource(baseRequest({
    shape: "MOVEMENT_ONLY", rows: fx.rows, mapping: fx.mapping, completeness: "COMPLETE",
  }));
  const mismatch = errorsOf(res).find((e) => e.code === "COMPLETE_CONTROL_TOTAL_MISMATCH");
  assert(mismatch !== undefined, "period imbalance must block");
  assert(mismatch.details?.group === "period", `group=${String(mismatch.details?.group)}`);
});

check(60, "Excluded subtotal absent from control totals", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [
    ["1101", "Cash", 1000, 0, 700, 200, 1500, 0],
    ["X1", "إجمالي الأصول", 1000, 0, 0, 0, 1000, 0],
  ]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping,
    subtotalFlags: flagSuspectedSubtotalRows(fx.rows),
    subtotalResolutions: { 3: "EXCLUDED" },
  }));
  assert(res.controlTotals !== null && res.controlTotals.opening !== undefined, "totals missing");
  assert(res.controlTotals.opening.debitMinor === M(1000),
    `excluded subtotal leaked: ${String(res.controlTotals.opening.debitMinor)}`);
  assert(res.controlTotals.opening.creditMinor === BigInt(0), "credit side wrong");
});

check(61, "Excluded subtotal absent from duplicate detection", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [
    ["1101", "Cash", 1000, 0, 700, 200, 1500, 0],
    ["1101", "إجمالي النقدية", 1000, 0, 0, 0, 1000, 0],
  ]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping,
    subtotalFlags: flagSuspectedSubtotalRows(fx.rows),
    subtotalResolutions: { 3: "EXCLUDED" },
  }));
  assert(res.duplicateResults.duplicates.length === 0,
    `excluded subtotal must not be scanned: ${JSON.stringify(res.duplicateResults)}`);
  assert(!hasError(res, "DUPLICATE_ACCOUNT_CODE"), "excluded subtotal must not block as duplicate");
});

check(62, "Repeated header absent from control totals", () => {
  const csv = [
    "Account Code,Account Name,Opening Debit,Opening Credit,Period Debit,Period Credit,Closing Debit,Closing Credit",
    "1101,Cash,1000,0,700,200,1500,0",
    "Account Code,Account Name,Opening Debit,Opening Credit,Period Debit,Period Credit,Closing Debit,Closing Credit",
    "2101,Payables,0,1000,200,500,0,1300",
  ].join("\n");
  const grid = parseCsvGrid(csv);
  const rep = detectRepeatedHeaderRows(grid, 0, 1);
  const mapping = mapTbHeaders(grid[0].map((c) => c.text));
  const rows = extractTbSourceRows(grid, { mapping, headerRowIndex: 0, headerRowCount: 1 });
  const res = normalizeTbSource(baseRequest({
    rows, mapping, repeatedHeaderRowNumbers: rep.repeatedRowNumbers,
    completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(!hasError(res, "MONETARY_INVALID"), "repeated header must not be parsed as amounts");
  assert(res.controlTotals !== null && res.controlTotals.period !== undefined, "totals missing");
  // صفّا التفصيل فقط: نقد 700 + دفع 200 = 900 مدينًا، و200 + 500 = 700 دائنًا — بلا أي إسهام من صف الترويسة.
  assert(res.controlTotals.period.debitMinor === M(900) && res.controlTotals.period.creditMinor === M(700),
    `totals=${String(res.controlTotals.period.debitMinor)}/${String(res.controlTotals.period.creditMinor)} (must be exactly the two detail rows, no header contribution)`);
});

check(63, "Blank row absent from control totals", () => {
  const csv = [
    "Account Code,Account Name,Opening Debit,Opening Credit,Period Debit,Period Credit,Closing Debit,Closing Credit",
    "1101,Cash,1000,0,700,200,1500,0",
    "",
    "4100,Revenue,0,0,0,600,0,600",
  ].join("\n");
  const grid = parseCsvGrid(csv);
  const mapping = mapTbHeaders(grid[0].map((c) => c.text));
  const rows = extractTbSourceRows(grid, { mapping, headerRowIndex: 0, headerRowCount: 1 });
  const res = normalizeTbSource(baseRequest({
    rows, mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  assert(res.controlTotals !== null && res.controlTotals.period !== undefined, "totals missing");
  assert(res.controlTotals.period.debitMinor === M(700) && res.controlTotals.period.creditMinor === M(800),
    `blank row leaked: ${String(res.controlTotals.period.debitMinor)}/${String(res.controlTotals.period.creditMinor)}`);
});

check(64, "Unresolved classification blocks persistence-ready candidate", () => {
  const res = normalizeTbSource(baseRequest({ classificationRules: SYSTEM_ROOT_MAPPING_RULES }));
  assert(res.status === "BLOCKED" && res.persistenceReady === false, `status=${res.status}`);
  assert(candidateByCode(res, "2101") === undefined, "unresolved row must have no candidate");
  assert(hasError(res, "UNRESOLVED_ACCOUNT_CLASSIFICATION"), "error code missing");
});

check(65, "Normalized netMinor equals debitMinor-creditMinor", () => {
  const res = normalizeTbSource(baseRequest());
  assert(res.draftLineCandidates.length > 0, "no candidates");
  for (const c of res.draftLineCandidates) {
    assert(c.netMinor === c.debitMinor - c.creditMinor,
      `row ${c.sourceRowNumber}: net=${c.netMinor} debit=${c.debitMinor} credit=${c.creditMinor}`);
  }
});

check(66, "Account code never converted through Number", () => {
  const res = normalizeTbSource(baseRequest());
  for (const c of res.draftLineCandidates) {
    assert(typeof c.accountCode === "string", `code type=${typeof c.accountCode}`);
  }
  const fx = fixtureFromAoa(FULL_HEADERS, [["00101", "Cash", 1000, 0, 700, 200, 1500, 0]]);
  const res2 = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  const row = res2.acceptedRows.find((r) => r.accountCode === "00101");
  assert(row !== undefined && row.accountCode === "00101", `code=${String(row?.accountCode)}`);
});

check(67, "FULL opening values not stored as reporting pair", () => {
  const res = normalizeTbSource(baseRequest());
  const cash = candidateByCode(res, "1101");
  assert(cash !== undefined, "cash candidate missing");
  assert(cash.debitMinor === M(1500), `debit must be closing 1500, got ${cash.debitMinor}`);
  assert(cash.debitMinor !== M(1000), "opening pair leaked into reporting amount");
});

check(68, "FLOW closing pair ignored for FULL reporting amount", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [["4100", "Revenue", 0, 399, 0, 600, 0, 999]]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  const rev = candidateByCode(res, "4100");
  assert(rev !== undefined, "revenue candidate missing");
  assert(rev.creditMinor === M(600) && rev.creditMinor !== M(999),
    `credit=${String(rev.creditMinor)} (must be period 600, never closing 999)`);
});

check(69, "BALANCE period pair ignored for FULL reporting amount", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [["1101", "Cash", 1000, 0, 800, 300, 1500, 0]]);
  const res = normalizeTbSource(baseRequest({
    rows: fx.rows, mapping: fx.mapping, completeness: "SUBSET", subsetAcknowledged: true,
  }));
  const cash = candidateByCode(res, "1101");
  assert(cash !== undefined, "cash candidate missing");
  assert(cash.debitMinor === M(1500) && cash.creditMinor === BigInt(0),
    `got ${String(cash.debitMinor)}/${String(cash.creditMinor)} (must be closing pair 1500 major)`);
  assert(!(cash.debitMinor === M(800) && cash.creditMinor === M(300)), "period pair leaked");
});

check(70, "Hash changes when subtotal resolution changes", () => {
  const fx = fixtureFromAoa(FULL_HEADERS, [
    ["1101", "Cash", 1000, 0, 700, 200, 1500, 0],
    ["X1", "إجمالي الأصول", 1000, 0, 0, 0, 1000, 0],
  ]);
  const flags = flagSuspectedSubtotalRows(fx.rows);
  const excluded = computeTbSourcePayloadHash(baseRequest({
    rows: fx.rows, mapping: fx.mapping, subtotalFlags: flags,
    subtotalResolutions: { 3: "EXCLUDED" },
  }));
  const kept = computeTbSourcePayloadHash(baseRequest({
    rows: fx.rows, mapping: fx.mapping, subtotalFlags: flags,
    subtotalResolutions: { 3: "KEPT" },
  }));
  assert(excluded !== kept, "resolution change must change the hash");
});

/* ── الخلاصة ─────────────────────────────────────────────────────────────── */

console.log("─────────────────────────────────────────────");
console.log(`PHASE 70 — TB IMPORTER STEP 2 (CORE NORMALIZATION + VALIDATION) GATE`);
console.log(`RESULT: ${passCount} PASS / ${failCount} FAIL (minimum required: 70 PASS / 0 FAIL)`);
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
if (passCount < 70) {
  console.log("GATE INCOMPLETE: fewer than 70 independent checks passed");
  process.exit(1);
}
process.exit(0);
