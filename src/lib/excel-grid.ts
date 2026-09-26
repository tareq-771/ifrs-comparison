// ═══════════════════════════════════════════════════════════════════════════
// Phase 7.0 (Step 1) — TB Importer Grid Reader (client-safe)
// قارئ شبكة نصية خام لمستورد ميزان المراجعة — آمن للعميل.
//
// المدخلات المدعومة: .xlsx (عبر xlsx-js-style الموجودة) و .csv.
// المرفوض صراحةً: .xls — بالامتداد وبتوقيع OLE2 عمليًا (ملف قديم مُسمّى xlsx).
//
// مبادئ مقفلة:
//  • النص الظاهر/المنسّق أولويةً (cell.w) بديلًا عن القيمة الخام — حفظ أمانة العرض.
//  • خلايا الصيغ لا تُنفَّذ إطلاقًا من طرفنا — بيانات وصفية (f) فقط.
//  • كشف المصدر الرقمي (t==='n') — إفصاح فقط.
//  • لا Number/parseFloat/أي حساب عائم على المبالغ هنا (التحويل لاحقًا fail-closed).
//  • CSV: نفس دلالات مُحلِّل aging الآمن (اقتباس/اقتباس مزدوج/BOM/كشف فاصل)
//    مع الحفاظ على الصفوف الفارغة وبلا أي افتراض أن أول صف هو ترويسة محاسبية.
//  • حدود إدخال محافظة صريحة — تجاوزها ⇒ رفض (لا قطع صامت).
// ═══════════════════════════════════════════════════════════════════════════

import * as XLSX from "xlsx-js-style";

import { EMPTY_TB_GRID_CELL } from "./tb-import";
import type { TbGrid, TbGridCell } from "./tb-import";

/* ── حدود إدخال محافظة ───────────────────────────────────────────────────── */

export const TB_IMPORT_MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MiB
export const TB_IMPORT_MAX_ROWS = 20_000;
export const TB_IMPORT_MAX_COLS = 128;

/** امتدادات TB المدعومة حصرًا. */
export const TB_SUPPORTED_EXTENSIONS = [".xlsx", ".csv"] as const;

export class TbGridReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TbGridReaderError";
  }
}

/** الامتداد السفلي لآخر مقطع في الاسم (نص خام — لا تحليل محتوى هنا). */
export function tbFileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf(".");
  if (idx <= 0 || idx === fileName.length - 1) return "";
  return fileName.slice(idx).toLowerCase();
}

/** رفض صريح لأي امتداد غير مدعوم — .xls أولًا وأشدها. */
export function assertSupportedTbFileExtension(fileName: string): void {
  const ext = tbFileExtension(fileName);
  if (ext === ".xls") {
    throw new TbGridReaderError(
      "UNSUPPORTED_LEGACY_XLS: ملفات .xls القديمة مرفوضة — استخدم .xlsx أو .csv",
    );
  }
  if (!(TB_SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new TbGridReaderError(
      `UNSUPPORTED_TB_FILE_EXTENSION: «${ext || "(بلا امتداد)"}» — المدعوم .xlsx/.csv فقط`,
    );
  }
}

/** توقيع OLE2 (D0 CF 11 E0 A1 B1 1A E1) — حاويات .xls/doc القديمة. */
export function looksLikeOle2Signature(bytes: Uint8Array): boolean {
  const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length < OLE2.length) return false;
  return OLE2.every((b, i) => bytes[i] === b);
}

/* ── بناء خلايا ──────────────────────────────────────────────────────────── */

function makeCell(text: string, isNumericSource: boolean, formulaText: string | null): TbGridCell {
  if (text === "" && !isNumericSource && formulaText === null) return EMPTY_TB_GRID_CELL;
  return { text, isNumericSource, isFormula: formulaText !== null, formulaText };
}

function emptyRow(width: number): TbGridCell[] {
  return Array.from({ length: width }, () => EMPTY_TB_GRID_CELL);
}

/* ── CSV: تعميم دلالات محلل aging الآمن (بلا إسقاط صفوف فارغة وبلا افتراض ترويسة) ── */

function detectCsvDelimiter(text: string): string {
  const firstLineEnd = text.indexOf("\n");
  const sample = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const counts: Array<[string, number]> = [
    [",", (sample.match(/,/g) ?? []).length],
    [";", (sample.match(/;/g) ?? []).length],
    ["\t", (sample.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/**
 * تحليل CSV إلى شبكة نصية خام: اقتباس RFC4180 («""» هارب، فواصل داخل الاقتباس)،
 * BOM يُزال، CRLF/LF، الصفوف الفارغة تُحفظ (بنيوية المصدر أمانة).
 * لا يُفترض أن أول صف ترويسة — اختيار الترويسة قرار المستدعي.
 */
export function parseCsvGrid(text: string): TbGrid {
  if (text.length > TB_IMPORT_MAX_FILE_BYTES) {
    throw new TbGridReaderError("TB_CSV_TOO_LARGE: تجاوز حد الحجم المحافظ");
  }
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delim = detectCsvDelimiter(clean);
  const rawRows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const pushCell = () => { row.push(cell); cell = ""; };
  const pushRow = () => { pushCell(); rawRows.push(row); row = []; };
  while (i < clean.length) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delim) { pushCell(); i++; continue; }
    if (ch === "\r") { if (clean[i + 1] === "\n") i++; pushRow(); i++; continue; }
    if (ch === "\n") { pushRow(); i++; continue; }
    cell += ch; i++;
  }
  if (cell !== "" || row.length > 0) pushRow();

  const width = rawRows.reduce((m, r) => Math.max(m, r.length), 0);
  if (width > TB_IMPORT_MAX_COLS) {
    throw new TbGridReaderError("TB_CSV_TOO_MANY_COLUMNS: تجاوز حد الأعمدة المحافظ");
  }
  if (rawRows.length > TB_IMPORT_MAX_ROWS) {
    throw new TbGridReaderError("TB_CSV_TOO_MANY_ROWS: تجاوز حد الصفوف المحافظ");
  }
  return rawRows.map((r) => {
    const cells = emptyRow(width);
    for (let c = 0; c < r.length; c++) cells[c] = makeCell(r[c], false, null);
    return cells;
  });
}

/* ── XLSX: قراءة خلايا مباشرة (نص عرض + وصف صيغة + إفصاح رقمي) ───────────── */

export interface TbWorkbookGrid {
  sheetName: string;
  grid: TbGrid;
}

export interface TbWorkbookGridOptions {
  sheetName?: string;
  sheetIndex?: number;
}

function cellText(cell: XLSX.CellObject): string {
  // النص المنسّق/الظاهر أولوية — بديلًا عن القيمة الخام (حفظ أمانة العرض).
  if (typeof cell.w === "string" && cell.w !== "") return cell.w;
  if (cell.v !== undefined && cell.v !== null) {
    if (typeof cell.v === "number" || typeof cell.v === "boolean") {
      return String(cell.v); // تجسيد نصي حتمي — لا أي عملية حسابية.
    }
    return String(cell.v);
  }
  return "";
}

/**
 * قراءة شبكة من .xlsx. الرفض: امتداد غير مدعوم، حجم متجاوز، توقيع OLE2
 * (ملف .xls قديم مُسمّى .xlsx)، تجاوز حدود الصفوف/الأعمدة.
 */
export function readTbWorkbookGrid(
  bytes: Uint8Array | ArrayBuffer,
  fileName: string,
  options: TbWorkbookGridOptions = {},
): TbWorkbookGrid {
  assertSupportedTbFileExtension(fileName);
  if (tbFileExtension(fileName) !== ".xlsx") {
    throw new TbGridReaderError("WRONG_READER_FOR_CSV: استخدم parseCsvGrid لملفات .csv");
  }
  const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (data.byteLength === 0) throw new TbGridReaderError("EMPTY_TB_FILE: ملف فارغ");
  if (data.byteLength > TB_IMPORT_MAX_FILE_BYTES) {
    throw new TbGridReaderError("TB_XLSX_TOO_LARGE: تجاوز حد الحجم المحافظ");
  }
  if (looksLikeOle2Signature(data)) {
    throw new TbGridReaderError(
      "LEGACY_XLS_CONTENT_REJECTED: محتوى OLE2 قديم داخل ملف مُسمّى .xlsx — مرفوض",
    );
  }

  const wb = XLSX.read(data, { type: "array", cellFormula: true, cellText: true });
  const sheetName =
    options.sheetName ??
    (options.sheetIndex !== undefined
      ? wb.SheetNames[options.sheetIndex]
      : wb.SheetNames[0]);
  if (!sheetName || !wb.Sheets[sheetName]) {
    throw new TbGridReaderError(`TB_SHEET_NOT_FOUND: «${options.sheetName ?? ""}»`);
  }
  const ws = wb.Sheets[sheetName];
  const ref = ws["!ref"];
  if (!ref) return { sheetName, grid: [] };
  const range = XLSX.utils.decode_range(ref);
  const rowCount = range.e.r - range.s.r + 1;
  const colCount = range.e.c - range.s.c + 1;
  if (rowCount > TB_IMPORT_MAX_ROWS) {
    throw new TbGridReaderError("TB_XLSX_TOO_MANY_ROWS: تجاوز حد الصفوف المحافظ");
  }
  if (colCount > TB_IMPORT_MAX_COLS) {
    throw new TbGridReaderError("TB_XLSX_TOO_MANY_COLUMNS: تجاوز حد الأعمدة المحافظ");
  }

  const grid: TbGrid = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const rowCells = emptyRow(colCount);
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr] as XLSX.CellObject | undefined;
      if (!cell || (cell.v === undefined && cell.w === undefined && !cell.f)) continue;
      rowCells[c - range.s.c] = makeCell(
        cellText(cell),
        cell.t === "n",
        typeof cell.f === "string" ? cell.f : null,
      );
    }
    grid.push(rowCells);
  }
  return { sheetName, grid };
}
