// 6.8 — طبقة التصدير القابلة للتوسع (Export Foundation) — بلا اعتماديات جديدة.
// التصميم: سجل صيغ (registry) — CSV متاح الآن (Excel يفتحه مباشرة مع BOM عربي)،
// وPDF/Excel-原生/Word نقاط توسع لاحقة دون إعادة كتابة صفحات التقارير.
// PDF اليوم = الطباعة من المتصفح عبر طبقة 6.8 (PrintButton) — بلا مكتبة إضافية.
// الدقة: القيم تمر كسلاسل نصية حرفيًا (minor BigInt) — لا Number ولا toFixed في هذه الطبقة.

export type ExportFormat = "csv" | "xlsx" | "pdf" | "docx";

export interface ExportColumn<Row> {
  key: string;
  label: string;
  /** خلية رقمية؟ تُترك كسلسلة كما هي حرفيًا (لا تحويل) — للدلالة فقط في الصيغ المستقبلية. */
  numeric?: boolean;
  value?: (row: Row) => string;
}

export interface ExportFormatDescriptor {
  format: ExportFormat;
  label: string;
  /** متاح الآن؟ */
  available: boolean;
  /** متى لا يتوفر: أين سيُنفذ لاحقًا (توثيق بدل زر ميت). */
  hint?: string;
}

/**
 * سجل الصيغ — نقطة التوسع الوحيدة لإضافة PDF/Excel/Word لاحقًا:
 * أضف handler في exportRows واجعل available=true — صفحات التقارير لا تتغير.
 */
export const EXPORT_FORMATS: Record<ExportFormat, ExportFormatDescriptor> = {
  csv: { format: "csv", label: "CSV (Excel)", available: true },
  pdf: {
    format: "pdf",
    label: "PDF",
    available: false,
    hint: "عبر زر «طباعة / حفظ PDF» (محرك طباعة المتصفح) — تصدير PDF أصلي مرحلة لاحقة.",
  },
  xlsx: { format: "xlsx", label: "Excel (xlsx)", available: false, hint: "مرحلة لاحقة — CSV يُفتح في Excel الآن." },
  docx: { format: "docx", label: "Word (docx)", available: false, hint: "مرحلة لاحقة." },
};

/** تهريب CSV وفق RFC 4180: اقتباس الحقول الحاوية فاصلة/اقتباس/سطر جديد. */
function csvEscape(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/** بناء محتوى CSV من أعمدة وصفوف — كل القيم نصية (BigInt minor يبقى دقيقًا). */
export function buildCsv<Row>(columns: ExportColumn<Row>[], rows: Row[]): string {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const lines = rows.map((row) =>
    columns
      .map((c) => {
        const raw = c.value ? c.value(row) : (row as Record<string, unknown>)[c.key];
        return csvEscape(raw === null || raw === undefined ? "" : String(raw));
      })
      .join(","),
  );
  // CRLF حسب RFC 4180 + BOM لتعرّف Excel على العربية
  return "\uFEFF" + [header, ...lines].join("\r\n") + "\r\n";
}

/** تنزيل Blob من نص — آمن في المتصفح حصرًا. */
export function downloadTextFile(filename: string, mimeType: string, content: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** تصدير CSV جاهز للاستخدام في أي تقرير. */
export function exportReportCsv<Row>(
  columns: ExportColumn<Row>[],
  rows: Row[],
  filenameBase: string,
): void {
  downloadTextFile(`${filenameBase}.csv`, "text/csv", buildCsv(columns, rows));
}

/** اسم ملف آمن: إزالة محارف مسارات/تحكم، وحد أقصى معقول. */
export function safeExportFilename(...parts: Array<string | null | undefined>): string {
  const joined = parts
    .filter((p) => (p ?? "").trim().length > 0)
    .join("-")
    .replace(/[\\/:*?"<>|\s]+/g, "-");
  return joined.slice(0, 120) || "report";
}
