// ═══════════════════════════════════════════════════════════════════════════
// Phase 7.0 (Step 1) — TB Importer Pure Foundations Gate
// بوابة الخطوة 1: أساسات مستورد ميزان المراجعة — فحوص نقيّة معزولة حصرًا.
// تشغيل: bun scripts/phase70-tb-import-step1-foundations.ts
//
// بلا DB إطلاقًا — كل الفيكتشرات في الذاكرة (xlsx يُبنى ويُقرأ ذهنيًا).
// الحد الأدنى: 25 فحصًا مستقلًا PASS / 0 FAIL — الفحوص لا تُدمج لتقليل العدّاد.
// النطاق: تطبيع/مطابقة الرؤوس، ثنائية المستوى، الأشكال (اقتراح لا قرار)،
// صفوف المصدر نصيًا (بلا أي تحويل نقدي)، الكاشفات الثلاثة، رفض .xls، CSV الآمن.
// ═══════════════════════════════════════════════════════════════════════════

import * as XLSX from "xlsx-js-style";

import {
  assessMappingCompleteness,
  detectDuplicateAccountCodes,
  detectRepeatedHeaderRows,
  extractTbSourceRows,
  flattenTwoLevelHeaderBlock,
  flagSuspectedSubtotalRows,
  mapTbHeaders,
  normalizeTbHeader,
  resolveTbShape,
  requiredFieldsForShape,
  suggestTbShape,
  TB_SHAPE_DESCRIPTORS,
} from "../src/lib/tb-import";
import type { TbHeaderMappingResult, TbSourceRow } from "../src/lib/tb-import";
import {
  looksLikeOle2Signature,
  parseCsvGrid,
  readTbWorkbookGrid,
  TbGridReaderError,
} from "../src/lib/excel-grid";

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

function fieldOf(mapping: TbHeaderMappingResult, col: number): string | undefined {
  return mapping.columns[col]?.canonicalField;
}

/* ── فيكتشر xlsx في الذاكرة (بناء ⇒ قراءة عبر قارئنا) ─────────────────────── */

function buildXlsxBytes(): Uint8Array {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    // الترويسة (نصوص)
    ["Account Code", "Account Name", "Period Debit", "Period Credit", "Closing Debit", "Closing Credit"],
    // الصف 2: كود نصي "101"
    ["101", "Alpha", 500, 0, 1500, 0],
    // الصف 3: كود نصي بأصفار بادئة "00101"
    ["00101", "Beta", 0, 250, 0, 1250],
    // الصف 4: كود رقمي 102 (مصدر رقمي — إفصاح)
    [102, "Gamma", 75, 0, 1075, 0],
  ]);
  // خلية صيغة في CLOSING_CREDIT (الصف 3): بيانات وصفية + قيمة مخبأة — لا تُنفَّذ من طرفنا
  ws["F3"] = { t: "n", f: "D3-E3", v: 975 };
  XLSX.utils.book_append_sheet(wb, ws, "TB");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new Uint8Array(out);
}

function readXlsxGrid(): ReturnType<typeof readTbWorkbookGrid> {
  return readTbWorkbookGrid(buildXlsxBytes(), "tb-fixture.xlsx");
}

function mapGridHeaders(headers: string[]): TbHeaderMappingResult {
  return mapTbHeaders(headers);
}

function extractCsvRows(csv: string, headerRowCount = 1): TbSourceRow[] {
  const grid = parseCsvGrid(csv);
  const headers = grid[0].map((c) => c.text);
  const mapping = mapTbHeaders(headers);
  return extractTbSourceRows(grid, { mapping, headerRowIndex: 0, headerRowCount });
}

/* ═══ الفحوص الثلاثون المستقلة ═══ */

// 1 — مطابقة عربية تامة
check(1, "Arabic exact mapping", () => {
  const m = mapTbHeaders(["رقم الحساب"]);
  assert(fieldOf(m, 0) === "ACCOUNT_CODE", `expected ACCOUNT_CODE, got ${fieldOf(m, 0)}`);
  assert(m.columns[0].tier === "EXACT", `tier=${m.columns[0].tier}`);
  assert(m.columns[0].status === "MAPPED", `status=${m.columns[0].status}`);
});

// 2 — مطابقة إنجليزية تامة
check(2, "English exact mapping", () => {
  const m = mapTbHeaders(["Account Code"]);
  assert(fieldOf(m, 0) === "ACCOUNT_CODE", `expected ACCOUNT_CODE, got ${fieldOf(m, 0)}`);
  assert(m.columns[0].tier === "EXACT", `tier=${m.columns[0].tier}`);
});

// 3 — خليط ثنائي اللغة: الحقول الثمانية كلها تُسند
check(3, "Mixed bilingual mapping (all 8)", () => {
  const m = mapTbHeaders([
    "كود الحساب", "Account Name",
    "رصيد أول المدة مدين", "رصيد أول المدة دائن",
    "Period Debit", "Period Credit", "Closing Debit", "Closing Credit",
  ]);
  assert(Object.keys(m.byField).length === 8, `mapped=${Object.keys(m.byField).length}`);
  assert(m.ambiguousColumns.length === 0, "unexpected ambiguity");
  assert(m.unmappedColumns.length === 0, "unexpected unmapped");
});

// 4 — الالتباس يبقى صريحًا بلا حل صامت
check(4, "Ambiguity unresolved (explicit)", () => {
  const m = mapTbHeaders(["Opening Debit / Opening Credit"]);
  const c = m.columns[0];
  assert(c.status === "AMBIGUOUS", `status=${c.status}`);
  assert((c.ambiguityCandidates ?? []).length === 2, `candidates=${(c.ambiguityCandidates ?? []).length}`);
  assert(fieldOf(m, 0) === undefined, "ambiguous column must not map");
  assert(m.byField.OPENING_DEBIT === undefined && m.byField.OPENING_CREDIT === undefined, "ambiguous fields must stay unmapped");
});

// 5 — رفض هدف مكرر (عمودان لنفس الحقل)
check(5, "Duplicate target rejected", () => {
  const m = mapTbHeaders(["كود الحساب", "كود الحساب", "اسم الحساب"]);
  assert(m.duplicateTargetConflicts.length === 1, `conflicts=${m.duplicateTargetConflicts.length}`);
  assert(m.duplicateTargetConflicts[0].field === "ACCOUNT_CODE", "wrong conflict field");
  assert(
    JSON.stringify(m.duplicateTargetConflicts[0].sourceColumnIndices) === JSON.stringify([0, 1]),
    "conflict columns wrong",
  );
  assert(m.byField.ACCOUNT_CODE === undefined, "duplicate target must not resolve");
  assert(m.columns[0].duplicateTargetConflict === true && m.columns[1].duplicateTargetConflict === true, "conflict flags missing");
  assert(m.byField.ACCOUNT_NAME === 2, "unrelated mapping must survive");
});

// 6 — الحقول المطلوبة الناقصة صريحة
check(6, "Missing required explicit", () => {
  const m = mapTbHeaders(["كود الحساب", "اسم الحساب", "رصيد آخر المدة مدين"]);
  const a = assessMappingCompleteness(m, "CLOSING_ONLY");
  assert(a.missing.length === 1 && a.missing[0] === "CLOSING_CREDIT", `missing=${JSON.stringify(a.missing)}`);
  assert(a.satisfied === false, "must be unsatisfied");
  const full = assessMappingCompleteness(m, "FULL_MOVEMENT");
  assert(full.missing.length === requiredFieldsForShape("FULL_MOVEMENT").length - 3, "FULL missing count wrong");
});

// 7 — الأعمدة غير المسندة تبقى ظاهرة
check(7, "Unmapped columns retained", () => {
  const m = mapTbHeaders(["كود الحساب", "اسم الحساب", "ملاحظات"]);
  assert(m.unmappedColumns.length === 1, `unmapped=${m.unmappedColumns.length}`);
  assert(m.unmappedColumns[0].rawHeader === "ملاحظات", `raw=${m.unmappedColumns[0].rawHeader}`);
  assert(m.unmappedColumns[0].tier === "NONE", `tier=${m.unmappedColumns[0].tier}`);
});

// 8 — ثنائية المستوى: Opening Balance + Debit
check(8, "Two-level Opening Debit", () => {
  const f = flattenTwoLevelHeaderBlock(
    ["Account Code", "Account Name", "Opening Balance", "Opening Balance", "Period Movement", "Period Movement"],
    ["", "", "Debit", "Credit", "Debit", "Credit"],
  );
  assert(f.twoLevelDetected, "two-level not detected");
  assert(f.composedColumns.length === 4, `composed=${f.composedColumns.length}`);
  const m = mapTbHeaders(f.effectiveHeaders);
  assert(fieldOf(m, 2) === "OPENING_DEBIT", `col2=${fieldOf(m, 2)}`);
  assert(fieldOf(m, 3) === "OPENING_CREDIT", `col3=${fieldOf(m, 3)}`);
});

// 9 — ثنائية المستوى: Period Movement + Credit
check(9, "Two-level Period Credit", () => {
  const f = flattenTwoLevelHeaderBlock(
    ["Account Code", "Account Name", "Period Movement", "Period Movement"],
    ["", "", "Debit", "Credit"],
  );
  const m = mapTbHeaders(f.effectiveHeaders);
  assert(fieldOf(m, 2) === "PERIOD_DEBIT", `col2=${fieldOf(m, 2)}`);
  assert(fieldOf(m, 3) === "PERIOD_CREDIT", `col3=${fieldOf(m, 3)}`);
  assert(m.columns[3].tier === "EXACT", `tier=${m.columns[3].tier}`);
});

// 10 — اقتراح FULL_MOVEMENT
check(10, "FULL_MOVEMENT suggestion", () => {
  const m = mapTbHeaders([
    "كود الحساب", "اسم الحساب",
    "رصيد أول المدة مدين", "رصيد أول المدة دائن",
    "Period Debit", "Period Credit", "Closing Debit", "Closing Credit",
  ]);
  const s = suggestTbShape(m);
  assert(s.suggestion === "FULL_MOVEMENT", `got ${s.suggestion}`);
});

// 11 — اقتراح CLOSING_ONLY
check(11, "CLOSING_ONLY suggestion", () => {
  const m = mapTbHeaders(["Account Code", "Account Name", "Closing Debit", "Closing Credit"]);
  const s = suggestTbShape(m);
  assert(s.suggestion === "CLOSING_ONLY", `got ${s.suggestion}`);
  assert(TB_SHAPE_DESCRIPTORS.CLOSING_ONLY.providesPeriodMovementGroup === false, "CLOSING_ONLY must not claim FLOW movement");
});

// 12 — اقتراح MOVEMENT_ONLY
check(12, "MOVEMENT_ONLY suggestion", () => {
  const m = mapTbHeaders(["Account Code", "Account Name", "Period Debit", "Period Credit"]);
  const s = suggestTbShape(m);
  assert(s.suggestion === "MOVEMENT_ONLY", `got ${s.suggestion}`);
  assert(TB_SHAPE_DESCRIPTORS.MOVEMENT_ONLY.providesClosingGroup === false, "MOVEMENT_ONLY must not claim BALANCE closing");
});

// 13 — الشكل المؤكد من المستخدم لا يُغيَّر أبدًا
check(13, "Confirmed shape never changed", () => {
  const r = resolveTbShape("MOVEMENT_ONLY", "FULL_MOVEMENT");
  assert(r.shape === "MOVEMENT_ONLY", `shape=${r.shape}`);
  assert(r.source === "USER_CONFIRMED", `source=${r.source}`);
  assert(r.userConfirmationPreserved === true, "confirmation not preserved");
  const none = resolveTbShape(undefined, null);
  assert(none.shape === null && none.source === "NONE", "empty resolution wrong");
});

// 14 — كشف تكرار أكواد الحسابات
check(14, "Duplicate account-code detection", () => {
  const rows = extractCsvRows(
    "Account Code,Account Name\n101,Alpha\n101,Beta\n102,Gamma\n101,Delta\n",
  );
  const dups = detectDuplicateAccountCodes(rows);
  assert(dups.length === 1, `dups=${dups.length}`);
  assert(dups[0].accountCode === "101", `code=${dups[0].accountCode}`);
  assert(dups[0].count === 3, `count=${dups[0].count}`);
  assert(
    JSON.stringify(dups[0].sourceRowNumbers) === JSON.stringify([2, 3, 5]),
    `rows=${JSON.stringify(dups[0].sourceRowNumbers)}`,
  );
});

// 15 — التكرار يُبلَّغ فقط: لا تجميع ولا overwrite ولا keep-first/last
check(15, "Duplicates not aggregated", () => {
  const rows = extractCsvRows("Account Code,Account Name,Period Debit\n101,A,10\n101,B,20\n");
  const dups = detectDuplicateAccountCodes(rows);
  assert(dups.length === 1, "duplicate not detected");
  const keys = Object.keys(dups[0]).sort();
  assert(
    JSON.stringify(keys) === JSON.stringify(["accountCode", "count", "sourceRowNumbers"]),
    `report keys=${JSON.stringify(keys)}`,
  );
  assert(rows.length === 2, `rows must remain distinct, got ${rows.length}`);
  assert(rows[0].monetary.PERIOD_DEBIT.rawText === "10" && rows[1].monetary.PERIOD_DEBIT.rawText === "20", "amounts must not merge");
});

// 16 — اشتباه المجاميع: FLAG فقط بلا أي استبعاد
check(16, "Subtotal flagged only (never excluded)", () => {
  const rows = extractCsvRows(
    "Account Code,Account Name,Closing Debit\n101,Alpha,10\nX1,إجمالي الأصول,999\n102,Gamma,20\n",
  );
  const flags = flagSuspectedSubtotalRows(rows);
  assert(flags.length === 1, `flags=${flags.length}`);
  assert(flags[0].matchedIn === "NAME", `in=${flags[0].matchedIn}`);
  assert(flags[0].matchedKeyword === "اجمالي", `kw=${flags[0].matchedKeyword}`);
  assert(flags[0].sourceRowNumber === 3, `row=${flags[0].sourceRowNumber}`);
  assert(rows.length === 3 && rows.some((r) => r.sourceRowNumber === flags[0].sourceRowNumber), "flagged row must remain present");
});

// 17 — كشف الترويسة المكررة
check(17, "Repeated header detected", () => {
  const grid = parseCsvGrid("Account Code,Account Name\n101,Alpha\nAccount Code,Account Name\n102,Beta\n");
  const rep = detectRepeatedHeaderRows(grid, 0, 1);
  assert(JSON.stringify(rep.repeatedRowNumbers) === JSON.stringify([3]), `got ${JSON.stringify(rep.repeatedRowNumbers)}`);
});

// 18 — النص «00101» يُحفظ حرفيًا (CSV نصي)
check(18, "Text 00101 preserved", () => {
  const rows = extractCsvRows("Account Code,Account Name\n00101,Alpha\n");
  assert(rows[0].accountCodeRaw === "00101", `code=${rows[0].accountCodeRaw}`);
  assert(rows[0].accountCodeIsNumericSource === false, "text code must not be flagged numeric");
});

// 19 — المصدر الرقمي يُعلَّم (xlsx رقمي 102)
check(19, "Numeric source code flagged", () => {
  const { grid } = readXlsxGrid();
  const headers = grid[0].map((c) => c.text);
  const mapping = mapTbHeaders(headers);
  const rows = extractTbSourceRows(grid, { mapping, headerRowIndex: 0, headerRowCount: 1 });
  const numericRow = rows.find((r) => r.sourceRowNumber === 4);
  assert(numericRow !== undefined, "row 4 missing");
  assert(numericRow.accountCodeRaw === "102", `code=${numericRow.accountCodeRaw}`);
  assert(numericRow.accountCodeIsNumericSource === true, "numeric source flag missing");
});

// 20 — لا اختراع أصفار بادئة
check(20, "No invented leading zeros", () => {
  const rows = extractCsvRows("Account Code,Account Name\n101,Alpha\n");
  assert(rows[0].accountCodeRaw === "101", `code=${rows[0].accountCodeRaw}`);
  assert(!rows[0].accountCodeRaw.startsWith("0"), "leading zero invented");
  const { grid } = readXlsxGrid();
  const headers = grid[0].map((c) => c.text);
  const mapping = mapTbHeaders(headers);
  const xrows = extractTbSourceRows(grid, { mapping, headerRowIndex: 0, headerRowCount: 1 });
  const textZeros = xrows.find((r) => r.accountCodeRaw === "00101");
  assert(textZeros !== undefined && textZeros.accountCodeIsNumericSource === false, "source zeros must be text, preserved");
});

// 21 — بيانات الصيغة تُحفظ وصفية (بلا تنفيذ من طرفنا)
check(21, "Formula metadata preserved (not executed)", () => {
  const { grid } = readXlsxGrid();
  const cell = grid[2][5]; // F3 = الصف 3، العمود F
  assert(cell.isFormula === true, "formula flag missing");
  assert(cell.formulaText === "D3-E3", `formula=${String(cell.formulaText)}`);
  assert(cell.text === "975", `cached display=${cell.text}`);
  assert(cell.isNumericSource === true, "cached numeric disclosure missing");
});

// 22 — CSV: اقتباس وفاصلة داخل اقتباس
check(22, "CSV quoted field with comma", () => {
  const grid = parseCsvGrid('Account Code,Account Name,Period Debit\n101,"Alpha, Co","1,234.56"\n');
  assert(grid[1][1].text === "Alpha, Co", `name=${grid[1][1].text}`);
  assert(grid[1][2].text === "1,234.56", `amount=${grid[1][2].text}`);
});

// 23 — CSV: BOM
check(23, "CSV BOM handled", () => {
  const rows = extractCsvRows("\uFEFFAccount Code,Account Name\n00101,Alpha\n");
  assert(rows[0].accountCodeRaw === "00101", `code=${rows[0].accountCodeRaw}`);
  const grid = parseCsvGrid("\uFEFFAccount Code,Account Name\n");
  const m = mapTbHeaders(grid[0].map((c) => c.text));
  assert(fieldOf(m, 0) === "ACCOUNT_CODE", "BOM broke exact mapping");
});

// 24 — رفض .xls بالامتداد وبتوقيع OLE2 داخل .xlsx
check(24, ".xls rejected (extension + OLE2)", () => {
  let extThrew = "";
  try {
    readTbWorkbookGrid(new Uint8Array([1, 2, 3]), "tb.xls");
  } catch (e) {
    extThrew = e instanceof TbGridReaderError ? e.message : String(e);
  }
  assert(extThrew.includes("UNSUPPORTED_LEGACY_XLS"), `ext=${extThrew}`);
  const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  let sigThrew = "";
  try {
    readTbWorkbookGrid(ole2, "tb.xlsx");
  } catch (e) {
    sigThrew = e instanceof TbGridReaderError ? e.message : String(e);
  }
  assert(sigThrew.includes("LEGACY_XLS_CONTENT_REJECTED"), `sig=${sigThrew}`);
  assert(looksLikeOle2Signature(ole2) === true, "OLE2 detector failed");
});

// 25 — نص المبالغ يُحفظ حرفيًا بلا أي تحويل عائم
check(25, "Monetary source text preserved (no float)", () => {
  const rows = extractCsvRows(
    'Account Code,Account Name,Period Debit,Period Credit\n101,Alpha,"(1,234.56)","0.10"\n102,Beta,"1,234.56","(0.5)"\n',
  );
  assert(typeof rows[0].monetary.PERIOD_DEBIT.rawText === "string", "rawText must be string");
  assert(rows[0].monetary.PERIOD_DEBIT.rawText === "(1,234.56)", `got ${rows[0].monetary.PERIOD_DEBIT.rawText}`);
  assert(rows[0].monetary.PERIOD_CREDIT.rawText === "0.10", `got ${rows[0].monetary.PERIOD_CREDIT.rawText}`);
  assert(rows[1].monetary.PERIOD_DEBIT.rawText === "1,234.56", `got ${rows[1].monetary.PERIOD_DEBIT.rawText}`);
  assert(rows[1].monetary.PERIOD_CREDIT.rawText === "(0.5)", `got ${rows[1].monetary.PERIOD_CREDIT.rawText}`);
});

// 26 — ثنائية المستوى بالعربية: رصيد أول المدة + مدين
check(26, "Two-level Arabic composition", () => {
  const f = flattenTwoLevelHeaderBlock(
    ["رقم الحساب", "اسم الحساب", "رصيد أول المدة", "رصيد أول المدة"],
    ["", "", "مدين", "دائن"],
  );
  assert(f.twoLevelDetected, "arabic two-level not detected");
  const m = mapTbHeaders(f.effectiveHeaders);
  assert(fieldOf(m, 2) === "OPENING_DEBIT", `col2=${fieldOf(m, 2)}`);
  assert(fieldOf(m, 3) === "OPENING_CREDIT", `col3=${fieldOf(m, 3)}`);
  assert(m.columns[2].tier === "EXACT", `tier=${m.columns[2].tier}`);
});

// 27 — لا تسرب وراثة لليسار في الترويسات الأحادية
check(27, "No leftward inheritance in single-level", () => {
  const f = flattenTwoLevelHeaderBlock(["Account Name", ""], ["", ""]);
  assert(f.twoLevelDetected === false, "single-level misdetected as two-level");
  assert(f.composedColumns.length === 0, "no composition allowed");
  assert(f.effectiveHeaders[0] === "Account Name", `h0=${f.effectiveHeaders[0]}`);
  assert(f.effectiveHeaders[1] === "", "empty column must not inherit left neighbor");
  const m = mapTbHeaders(f.effectiveHeaders);
  assert(fieldOf(m, 0) === "ACCOUNT_NAME", "name col must map");
  assert(m.unmappedColumns.some((c) => c.sourceColumnIndex === 1), "empty col must stay unmapped");
});

// 28 — الشكل الملتبس: بلا اقتراح تلقائي (لا تخمين)
check(28, "Ambiguous shape → no suggestion", () => {
  const m = mapTbHeaders([
    "Account Code", "Account Name",
    "Opening Debit", "Opening Credit", "Closing Debit", "Closing Credit",
  ]);
  const s = suggestTbShape(m);
  assert(s.suggestion === null, `expected null, got ${s.suggestion}`);
  assert(s.reason === "AMBIGUOUS_FIELD_GROUPS_NO_GUESS", `reason=${s.reason}`);
});

// 29 — LEGACY لا يُقترح تلقائيًا أبدًا
check(29, "LEGACY never auto-suggested", () => {
  assert(TB_SHAPE_DESCRIPTORS.LEGACY.autoSuggestionAllowed === false, "LEGACY must not allow auto-suggestion");
  assert(TB_SHAPE_DESCRIPTORS.LEGACY.notes.length > 0, "LEGACY semantics must be documented");
  const shapes = ["FULL_MOVEMENT", "CLOSING_ONLY", "MOVEMENT_ONLY"] as const;
  for (const shape of shapes) {
    assert(TB_SHAPE_DESCRIPTORS[shape].closingIsYtdForFlowRows === false, `${shape}: closing=YTD assumption must be false`);
  }
  const fullFixture = [
    "Account Code", "Account Name", "Opening Debit", "Opening Credit",
    "Period Debit", "Period Credit", "Closing Debit", "Closing Credit",
  ];
  const full = suggestTbShape(mapTbHeaders(fullFixture));
  assert(full.suggestion !== "LEGACY", "LEGACY must never be suggested");
  assert(full.suggestion === "FULL_MOVEMENT", "FULL fixture broken");
});

// 30 — CSV: الصفوف الفارغة تُحفظ (بلا افتراض ترويسة)
check(30, "CSV blank rows preserved", () => {
  const grid = parseCsvGrid("Account Code,Account Name\n101,Alpha\n\n\n102,Beta\n");
  assert(grid.length === 5, `rows=${grid.length}`);
  assert(grid[2].every((c) => c.text === "") && grid[3].every((c) => c.text === ""), "blank rows not preserved");
  const headers = grid[0].map((c) => c.text);
  const mapping = mapTbHeaders(headers);
  const rows = extractTbSourceRows(grid, { mapping, headerRowIndex: 0, headerRowCount: 1 });
  assert(rows.length === 4, `extracted=${rows.length}`);
  assert(rows[1].isBlank === true && rows[2].isBlank === true, "isBlank flags wrong");
  assert(rows[3].isBlank === false && rows[3].accountCodeRaw === "102", "last row wrong");
});

/* ── الخلاصة ─────────────────────────────────────────────────────────────── */

console.log("─────────────────────────────────────────────");
console.log(`PHASE 70 — TB IMPORTER STEP 1 (PURE FOUNDATIONS) GATE`);
console.log(`RESULT: ${passCount} PASS / ${failCount} FAIL (minimum required: 25 PASS / 0 FAIL)`);
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
if (passCount < 25) {
  console.log("GATE INCOMPLETE: fewer than 25 independent checks passed");
  process.exit(1);
}
process.exit(0);
