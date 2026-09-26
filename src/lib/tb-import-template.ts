// ═══════════════════════════════════════════════════════════════════════════
// Phase 7.0 (V1 closure) — TB Importer Template/Example Generator
// مولّد قالب الاستيراد الاحترافي — بيانات عامة توضيحية حصرًا (لا بيانات إنتاج).
//
// القواعد المقفلة:
//  • الترويسات = مرادفات قيانية حرفية (طبقة EXACT في محرك الإسناد المجمد) —
//    «كود الحساب، اسم الحساب، رصيد أول المدة مدين/دائن، حركة الفترة مدين/دائن،
//    رصيد آخر المدة مدين/دائن».
//  • صفوف مثال توضيحية متوازنة فقط (افتتاح 1000=1000، فترة 800=800، إقفال 1800=1800)
//    بلا أي بيانات شركة/إنتاج — وتُعلَّم في التعليمات كصفوف تُحذف.
//  • ورقة «تعليمات» عربية تشرح العقد المقفل للمستورد V1.
//  • توليد حتمي نقي — بلا I/O ولا DB؛ المسار يغلفه بتنزيل فقط.
// ═══════════════════════════════════════════════════════════════════════════

import * as XLSX from "xlsx-js-style";

export const TB_TEMPLATE_SHEET_DATA = "ميزان المراجعة";
export const TB_TEMPLATE_SHEET_INSTRUCTIONS = "تعليمات";
export const TB_TEMPLATE_XLSX_FILE_NAME = "tb-import-template-v1.xlsx";
export const TB_TEMPLATE_CSV_FILE_NAME = "tb-import-template-v1.csv";

/** الترويسات القيانية الحرفية — تُطابق طبقة EXACT حصرًا في محرك الإسناد. */
export const TB_TEMPLATE_HEADERS: readonly string[] = [
  "كود الحساب",
  "اسم الحساب",
  "رصيد أول المدة مدين",
  "رصيد أول المدة دائن",
  "حركة الفترة مدين",
  "حركة الفترة دائن",
  "رصيد آخر المدة مدين",
  "رصيد آخر المدة دائن",
];

/** صفوف مثال عامة متوازنة (بلا أي بيانات إنتاج) — حتمية لتسهيل الفحص. */
export const TB_TEMPLATE_EXAMPLE_ROWS: ReadonlyArray<readonly [string, string, string, string, string, string, string, string]> = [
  ["1100", "نقدية (مثال — احذف)", "1000", "0", "500", "0", "1500", "0"],
  ["2100", "موردون (مثال — احذف)", "0", "1000", "0", "300", "0", "1300"],
  ["3101", "مصروف رواتب (مثال — احذف)", "0", "0", "300", "0", "300", "0"],
  ["4100", "إيرادات (مثال — احذف)", "0", "0", "0", "500", "0", "500"],
];

/** سطور ورقة التعليمات — العقد المقفل للمستورد V1 (عربي أولًا). */
export const TB_TEMPLATE_INSTRUCTIONS: readonly string[] = [
  "قالب استيراد ميزان المراجعة — نظام التقارير المالية الموحدة (الإصدار V1)",
  "• صف واحد لكل حساب تفصيلي — بلا صفوف إجماليات مخلوطة بالتفاصيل إلا بقصد صريح (ستُراجع وتُحسم يدويًا).",
  "• أكواد الحسابات معرفات نصية: لا تكرار، والأصفار الرائدة تُحفظ كما وردت (00101 تبقى 00101).",
  "• المبالغ بعملة المصدر؛ في هذا الإصدار يجب أن تطابق عملة الشركة الوظيفية — لا تحويل عملات.",
  "• معادلة كل صف: رصيد أول المدة + حركة الفترة = رصيد آخر المدة (للأصول والخصوم وفق الطبيعة المدينة/الدائنة).",
  "• لا حاجة لأي صيغ — القيم النصية الظاهرة هي الحاكمة، والصيغ لا تُنفَّذ إطلاقًا.",
  "• الملفات المدعومة: .xlsx و .csv حصرًا — ملفات .xls القديمة مرفوضة.",
  "• صفوف المثال أعلاه توضيحية فقط (موسومة بـ «مثال») — احذفها قبل الاستخدام الفعلي.",
  "• لا تُرفق أي بيانات شركة حقيقية بهذا القالب.",
];

/** بناء مصنف القالب (.xlsx) — ورقتان: ميزان المراجعة + تعليمات. حتمي نقي. */
export function buildTbImportTemplateXlsx(): { bytes: Uint8Array; fileName: string } {
  const dataSheet = XLSX.utils.aoa_to_sheet([
    [...TB_TEMPLATE_HEADERS],
    ...TB_TEMPLATE_EXAMPLE_ROWS.map((r) => [...r]),
  ]);
  dataSheet["!cols"] = TB_TEMPLATE_HEADERS.map(() => ({ wch: 18 }));
  const instructionsSheet = XLSX.utils.aoa_to_sheet(
    TB_TEMPLATE_INSTRUCTIONS.map((line) => [line]),
  );
  instructionsSheet["!cols"] = [{ wch: 110 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, dataSheet, TB_TEMPLATE_SHEET_DATA);
  XLSX.utils.book_append_sheet(wb, instructionsSheet, TB_TEMPLATE_SHEET_INSTRUCTIONS);
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return { bytes: new Uint8Array(out), fileName: TB_TEMPLATE_XLSX_FILE_NAME };
}

/** بناء مثال CSV (ورقة بيانات حصرًا — التعليمات في xlsx) — حتمي نقي. */
export function buildTbImportTemplateCsv(): { text: string; fileName: string } {
  const lines = [
    TB_TEMPLATE_HEADERS.join(","),
    ...TB_TEMPLATE_EXAMPLE_ROWS.map((r) => r.join(",")),
  ];
  return { text: lines.join("\n") + "\n", fileName: TB_TEMPLATE_CSV_FILE_NAME };
}
