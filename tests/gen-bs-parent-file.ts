/**
 * BS test file WITH parent (header) accounts — exercises the searchable picker.
 */
import * as XLSX from "xlsx-js-style";

const OUT = "/tmp/test-files";

function writeSheet(filename: string, rows: Array<[string, string, number, number]>) {
  const aoa: (string | number)[][] = [
    ["رقم الحساب", "اسم الحساب", "مدين", "دائن"],
    ...rows.map(([num, name, debit, credit]) => [num, name, debit, credit]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 12 }, { wch: 30 }, { wch: 14 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "الميزانية");
  XLSX.writeFile(wb, `${OUT}/${filename}`);
  console.log("wrote", filename);
}

writeSheet("bs-parent-2025.xlsx", [
  ["11", "الأصول المتداولة", 0, 0],
  ["1101", "الصندوق والبنوك", 150000, 0],
  ["1102", "المخزون", 200000, 0],
  ["1103", "العملاء", 250000, 0],
  ["12", "الأصول غير المتداولة", 0, 0],
  ["1201", "أثاث ومعدات", 300000, 0],
  ["21", "الخصوم المتداولة", 0, 0],
  ["2101", "الموردون", 0, 180000],
  ["2102", "قروض قصيرة الأجل", 0, 120000],
  ["22", "الخصوم غير المتداولة", 0, 0],
  ["2201", "قروض طويلة الأجل", 0, 200000],
  ["3", "حقوق الملكية", 0, 0],
  ["3001", "رأس المال", 0, 250000],
  ["3002", "الأرباح المبقاة", 0, 150000],
]);
console.log("DONE");
