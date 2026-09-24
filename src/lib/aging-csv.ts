// Phase 6.10 — محلل CSV نقي (RFC4180): BOM، اقتباس، اقتباس مزدوج هارب، CRLF،
// وكشف فاصل (فاصلة/فاصلة منقوطة/جدولة). يُستخدم على العميل لقراءة ملفات CSV؛
// والخادم يعيد التحقق من الشبكة الخام كمدخل غير موثوق. لا تنفيذ أي صيغ أبدًا.

export interface CsvGrid {
  headers: string[];
  rows: string[][];
}

function detectDelimiter(text: string): string {
  const firstLineEnd = text.indexOf("\n");
  const sample = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const counts: Array<[string, number]> = [
    [",", (sample.match(/,/g) || []).length],
    [";", (sample.match(/;/g) || []).length],
    ["\t", (sample.match(/\t/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/** تحليل نص CSV إلى شبكة خام (نصوص حصرًا). لا تقييم صيغ ولا تحويل أنواع هنا. */
export function parseCsv(text: string): CsvGrid {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delim = detectDelimiter(clean);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const pushCell = () => { row.push(cell); cell = ""; };
  const pushRow = () => { pushCell(); rows.push(row); row = []; };
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
  // إسقاط الصفوف الفارغة تمامًا (كل الخلايا فارغة)
  const meaningful = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (meaningful.length === 0) return { headers: [], rows: [] };
  const [headerRow, ...dataRows] = meaningful;
  return { headers: headerRow.map((h) => h.trim()), rows: dataRows };
}
