// Phase 6.10 — أعمار الديون والتحصيل: طبقة الخدمة (server-only).
// fail-closed: كل قراءة/كتابة تمر بفحص نطاق الشركة + صلاحية صريحة.
// المبالغ BigInt minor (نصوص في JSON)؛ missing != zero؛ لا plug ولا اختراع تواريخ.

import { db } from "@/lib/db";
import { companyVisible, COMPANY_ACCESS_ERRORS } from "@/lib/company-access";
import { writeAudit, getClientIp } from "@/lib/audit";
import {
  AGING_CANONICAL_FIELDS,
  AGING_IMPORT_LIMITS,
  DEFAULT_AGING_BUCKETS,
  DEFAULT_INSIGHT_RULES,
  UNDETERMINED_BUCKET,
  assignBucket,
  autoMapHeaders,
  daysBetween,
  formatBp,
  normalizeHeader,
  parseAgingDate,
  parseAgingMoney,
  pctBpOf,
  type AgingBucketDef,
  type AgingInsight,
  type AgingInsightRuleCode,
  type AgingMapping,
  type AgingRiskRow,
  type AgingTotals,
  type BucketTotal,
} from "@/lib/aging";
import { formatMinor } from "@/lib/money";
import type { Permissions } from "@/lib/permissions";

export class AgingError extends Error {
  code: string;
  detail?: Record<string, unknown>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.name = "AgingError";
    this.detail = detail;
  }
}

type PermUser = { role: string; permissions: Permissions };

function assertScope(user: PermUser, companyId: string): void {
  if (!companyVisible(user, companyId)) {
    throw new AgingError("NOT_FOUND", COMPANY_ACCESS_ERRORS.NOT_FOUND);
  }
}

function assertPerm(user: PermUser, check: (perms: Permissions, role: string) => boolean, message: string): void {
  if (!check(user.permissions, user.role)) throw new AgingError("FORBIDDEN", message);
}

// ── الإعدادات: شرائط + حسابات المدينين + قواعد الرؤى ────────────────────────

export async function ensureAgingDefaults(companyId: string): Promise<void> {
  const bucketCount = await db.agingBucketConfig.count({ where: { companyId } });
  if (bucketCount === 0) {
    await db.agingBucketConfig.createMany({
      data: DEFAULT_AGING_BUCKETS.map((b) => ({
        companyId,
        code: b.code,
        labelAr: b.labelAr,
        labelEn: b.labelEn,
        fromDays: b.fromDays,
        toDays: b.toDays,
        isNotDue: b.isNotDue,
        order: b.order,
      })),
    });
  }
  const ruleCount = await db.agingInsightRule.count({ where: { companyId } });
  if (ruleCount === 0) {
    await db.agingInsightRule.createMany({
      data: DEFAULT_INSIGHT_RULES.map((r) => ({
        companyId,
        code: r.code,
        enabled: true,
        thresholdBp: r.thresholdBp,
        thresholdDays: r.thresholdDays,
        thresholdCount: r.thresholdCount,
        severity: r.severity,
      })),
    });
  }
}

async function loadBuckets(companyId: string): Promise<AgingBucketDef[]> {
  await ensureAgingDefaults(companyId);
  const rows = await db.agingBucketConfig.findMany({ where: { companyId }, orderBy: { order: "asc" } });
  return rows.map((r) => ({
    code: r.code,
    labelAr: r.labelAr,
    labelEn: r.labelEn,
    fromDays: r.fromDays,
    toDays: r.toDays,
    isNotDue: r.isNotDue,
    order: r.order,
  }));
}

// ── التحقق من المدخل غير الموثوق (Import Security) ──────────────────────────

const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function cellAt(row: string[], idx: number): string | null {
  if (idx < 0 || idx >= row.length) return null;
  const v = row[idx];
  if (v == null) return null;
  const t = String(v).trim();
  return t === "" ? null : t.length > AGING_IMPORT_LIMITS.maxCellChars ? t.slice(0, AGING_IMPORT_LIMITS.maxCellChars) : t;
}

interface ParsedRowInput {
  rowIndex: number;
  customerCode: string | null;
  customerName: string | null;
  customerKey: string;
  outstandingBalanceMinor: bigint | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  invoiceAmountMinor: bigint | null;
  dueDate: string | null;
  ageDays: number | null;
  lastSaleDate: string | null;
  lastSaleAmountMinor: bigint | null;
  lastCollectionDate: string | null;
  lastCollectionAmountMinor: bigint | null;
  creditLimitMinor: bigint | null;
  guaranteeOrInsurance: string | null;
  salesperson: string | null;
  responsiblePerson: string | null;
  notes: string | null;
  flags: string[];
  warnings: string[];
}

const WARNING_TEXTS: Record<string, string> = {
  MISSING_BALANCE: "الرصيد المستحق غير متوفر — لا يُعامل صفرًا ويُستثنى من الإجماليات",
  INVALID_BALANCE: "قيمة رصيد غير قابلة للقراءة — عوملت كبيانات ناقصة لا صفر",
  NEGATIVE_BALANCE: "رصيد سالب (قيمة شاذة تُعرض كما هي ولا تُصفر)",
  INVALID_DATE: "تاريخ غير قابل للقراءة — عومل كبيانات ناقصة",
  AMBIGUOUS_DATE: "تاريخ غامض (يوم/شهر) — اعتُمد تفسير يوم-أول المعلن",
  FUTURE_DATE: "تاريخ لاحق لتاريخ الأساس — أُسقط من احتساب العمر",
  OVER_CREDIT_LIMIT: "الرصيد يتجاوز حد الائتمان",
  INVALID_NUMBER: "قيمة رقمية غير قابلة للقراءة — عوملت كبيانات ناقصة",
  CELL_TRUNCATED: "نص خلية تجاوز الحد واقتُطع",
  INVALID_AGE_DAYS: "عمر أيام صريح غير صالح (سالب/غير رقمي) — أُسقط",
};

function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (ch) => String("٠١٢٣٤٥٦٧٨٩".indexOf(ch)));
}

export interface AgingImportInput {
  companyId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  fileSha256: string;
  asOfDate: string;
  periodLabel?: string;
  grid: { headers: string[]; rows: string[][] };
  mappingOverride?: AgingMapping;
}

export async function createAgingImport(
  user: PermUser & { id: string; username: string; name?: string },
  input: AgingImportInput,
  ip: string | null
): Promise<Record<string, unknown>> {
  assertPerm(user, (p, r) => r === "admin" || p.uploadAging === true, "لا تملك صلاحية رفع أعمار الديون");
  assertScope(user, input.companyId);
  const company = await db.company.findUnique({ where: { id: input.companyId }, select: { functionalCurrency: true } });
  if (!company) throw new AgingError("NOT_FOUND", COMPANY_ACCESS_ERRORS.NOT_FOUND);
  const minorUnits = company.functionalCurrency ? await minorUnitsOf(company.functionalCurrency) : 2;

  // 1) حدود الأمان على المدخل غير الموثوق
  if (input.fileName && input.fileName.length > 200) throw new AgingError("INVALID_INPUT", "اسم الملف طويل جدًا");
  if (input.fileType !== "CSV" && input.fileType !== "XLSX") throw new AgingError("INVALID_INPUT", "نوع الملف غير مدعوم (المدعوم: CSV، XLSX)");
  if (!Number.isFinite(input.fileSize) || input.fileSize < 0 || input.fileSize > AGING_IMPORT_LIMITS.maxFileBytes) {
    throw new AgingError("TOO_LARGE", `حجم الملف يتجاوز الحد المسموح (${Math.floor(AGING_IMPORT_LIMITS.maxFileBytes / 1024 / 1024)}MB)`);
  }
  if (!/^[a-f0-9]{64}$/i.test(input.fileSha256)) throw new AgingError("INVALID_INPUT", "بصمة الملف SHA256 مطلوبة بصيغة سليمة");
  if (!ISO_DATE_RE.test(input.asOfDate)) throw new AgingError("INVALID_INPUT", "تاريخ الأساس يجب أن يكون بصيغة YYYY-MM-DD");
  if (typeof input.periodLabel === "string" && input.periodLabel.length > 120) throw new AgingError("INVALID_INPUT", "وسم الفترة طويل جدًا");
  const headers = input.grid?.headers;
  const rawRows = input.grid?.rows;
  if (!Array.isArray(headers) || headers.length === 0) throw new AgingError("INVALID_INPUT", "الملف بلا ترويسات أعمدة");
  if (headers.length > AGING_IMPORT_LIMITS.maxCols) throw new AgingError("INVALID_INPUT", `عدد الأعمدة يتجاوز الحد (${AGING_IMPORT_LIMITS.maxCols})`);
  if (!Array.isArray(rawRows)) throw new AgingError("INVALID_INPUT", "صفوف الملف غير مقروءة");
  if (rawRows.length > AGING_IMPORT_LIMITS.maxRows) throw new AgingError("TOO_MANY_ROWS", `عدد الصفوف يتجاوز الحد (${AGING_IMPORT_LIMITS.maxRows})`);
  const payloadJson = JSON.stringify(input.grid);
  if (payloadJson.length > AGING_IMPORT_LIMITS.maxPayloadBytes) {
    throw new AgingError("TOO_LARGE", "حجم محتوى الملف يتجاوز الحد المسموح");
  }

  // 2) التعيين: يدوي (يتطلب صلاحية خاصة) أو ترجيع تلقائي
  let mapping: AgingMapping;
  let mappingSource: "AUTO" | "USER" = "AUTO";
  if (input.mappingOverride && Object.keys(input.mappingOverride).length > 0) {
    assertPerm(user, (p, r) => r === "admin" || p.editAgingMapping === true, "لا تملك صلاحية تعديل تعيين الأعمدة");
    const headerSet = new Set(headers.map((h) => normalizeHeader(h)));
    mapping = {};
    for (const field of AGING_CANONICAL_FIELDS) {
      const target = input.mappingOverride[field];
      if (typeof target === "string" && target !== "") {
        if (!headerSet.has(normalizeHeader(target))) {
          throw new AgingError("INVALID_MAPPING", `العمود «${target}» غير موجود في الملف`);
        }
        mapping[field] = target;
      }
    }
    mappingSource = "USER";
  } else {
    mapping = autoMapHeaders(headers).mapping;
  }
  const colIdx: Partial<Record<(typeof AGING_CANONICAL_FIELDS)[number], number>> = {};
  const normalizedHeaders = headers.map((h) => normalizeHeader(h));
  for (const field of AGING_CANONICAL_FIELDS) {
    const target = mapping[field];
    if (target) colIdx[field] = normalizedHeaders.indexOf(normalizeHeader(target));
  }
  if (colIdx.CUSTOMER_CODE == null && colIdx.CUSTOMER_NAME == null) {
    throw new AgingError("MAPPING_INCOMPLETE", "يجب تعيين كود العميل أو اسم العميل على الأقل لهوية meaningsful");
  }
  if (colIdx.OUTSTANDING_BALANCE == null) {
    throw new AgingError("MAPPING_INCOMPLETE", "عمود الرصيد المستحق مطلوب للاستيراد ذي المعنى");
  }

  // 3) تحليل الصفوف صفًا صفًا (الخادم هو صاحب القرار — العميل ينقل نصوصًا خامًا)
  const parsed: ParsedRowInput[] = [];
  const errors: Array<{ rowIndex: number; message: string }> = [];
  let warningCount = 0;
  const parseMoney = (v: string | null, flags: string[], flag: string): bigint | null => {
    if (v == null) return null;
    const val = parseAgingMoney(v, minorUnits);
    if (val == null) { flags.push(flag); return null; }
    return val;
  };
  const parseDate = (v: string | null, flags: string[], warn: string[], asOf: string): string | null => {
    if (v == null) return null;
    const p = parseAgingDate(v);
    if (!p) { flags.push("INVALID_DATE"); warn.push(WARNING_TEXTS.INVALID_DATE); return null; }
    if (p.ambiguous) { flags.push("AMBIGUOUS_DATE"); warn.push(WARNING_TEXTS.AMBIGUOUS_DATE); }
    if (p.date > asOf) { flags.push("FUTURE_DATE"); warn.push(WARNING_TEXTS.FUTURE_DATE); }
    return p.date;
  };

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!Array.isArray(row)) { errors.push({ rowIndex: i + 1, message: "صف غير قابل للقراءة" }); continue; }
    const flags: string[] = [];
    const warnings: string[] = [];
    const code = cellAt(row, colIdx.CUSTOMER_CODE ?? -1);
    const name = cellAt(row, colIdx.CUSTOMER_NAME ?? -1);
    if (code == null && name == null) {
      errors.push({ rowIndex: i + 1, message: "بلا هوية عميل (كود واسم معًا فارغان)" });
      continue;
    }
    const balanceRaw = cellAt(row, colIdx.OUTSTANDING_BALANCE ?? -1);
    let balance = parseMoney(balanceRaw, flags, "INVALID_BALANCE");
    if (balanceRaw != null && balance == null) warnings.push(WARNING_TEXTS.INVALID_BALANCE);
    if (balance == null && balanceRaw == null) { flags.push("MISSING_BALANCE"); warnings.push(WARNING_TEXTS.MISSING_BALANCE); }
    if (balance != null && balance < BigInt(0)) { flags.push("NEGATIVE_BALANCE"); warnings.push(WARNING_TEXTS.NEGATIVE_BALANCE); }

    let ageDays: number | null = null;
    if (colIdx.AGE_DAYS != null) {
      const rawAge = cellAt(row, colIdx.AGE_DAYS);
      if (rawAge != null) {
        const n = Number(normalizeDigits(rawAge));
        if (Number.isFinite(n) && n >= 0 && Number.isInteger(n)) ageDays = n;
        else { flags.push("INVALID_AGE_DAYS"); warnings.push(WARNING_TEXTS.INVALID_AGE_DAYS); }
      }
    }
    const dueDate = parseDate(cellAt(row, colIdx.DUE_DATE ?? -1), flags, warnings, input.asOfDate);
    const invoiceDate = parseDate(cellAt(row, colIdx.INVOICE_DATE ?? -1), flags, warnings, input.asOfDate);
    const lastSaleDate = parseDate(cellAt(row, colIdx.LAST_SALE_DATE ?? -1), flags, warnings, input.asOfDate);
    const lastCollectionDate = parseDate(cellAt(row, colIdx.LAST_COLLECTION_DATE ?? -1), flags, warnings, input.asOfDate);
    const creditLimit = parseMoney(cellAt(row, colIdx.CREDIT_LIMIT ?? -1), flags, "INVALID_NUMBER");
    if (balance != null && creditLimit != null && creditLimit > BigInt(0) && balance > creditLimit) {
      flags.push("OVER_CREDIT_LIMIT"); warnings.push(WARNING_TEXTS.OVER_CREDIT_LIMIT);
    }
    // اقتطاع الخلايا الطويلة يُعلن
    for (let c = 0; c < Math.min(row.length, AGING_IMPORT_LIMITS.maxCols); c++) {
      const v = row[c];
      if (typeof v === "string" && v.length > AGING_IMPORT_LIMITS.maxCellChars) { flags.push("CELL_TRUNCATED"); warnings.push(WARNING_TEXTS.CELL_TRUNCATED); break; }
    }
    if (flags.length > 0) warningCount++;
    const customerKey = (code ?? name)!.trim().toLowerCase();
    parsed.push({
      rowIndex: i + 1,
      customerCode: code,
      customerName: name,
      customerKey,
      outstandingBalanceMinor: balance,
      invoiceNumber: cellAt(row, colIdx.INVOICE_NUMBER ?? -1),
      invoiceDate,
      invoiceAmountMinor: parseMoney(cellAt(row, colIdx.INVOICE_AMOUNT ?? -1), flags, "INVALID_NUMBER"),
      dueDate,
      ageDays,
      lastSaleDate,
      lastSaleAmountMinor: parseMoney(cellAt(row, colIdx.LAST_SALE_AMOUNT ?? -1), flags, "INVALID_NUMBER"),
      lastCollectionDate,
      lastCollectionAmountMinor: parseMoney(cellAt(row, colIdx.LAST_COLLECTION_AMOUNT ?? -1), flags, "INVALID_NUMBER"),
      creditLimitMinor: creditLimit,
      guaranteeOrInsurance: cellAt(row, colIdx.GUARANTEE_OR_INSURANCE ?? -1),
      salesperson: cellAt(row, colIdx.SALESPERSON ?? -1),
      responsiblePerson: cellAt(row, colIdx.RESPONSIBLE_PERSON ?? -1),
      notes: cellAt(row, colIdx.NOTES ?? -1),
      flags,
      warnings: Array.from(new Set(warnings)),
    });
  }

  // 4) الحفظ (دفعة واحدة)
  const created = await db.$transaction(async (tx) => {
    const imp = await tx.agingImport.create({
      data: {
        companyId: input.companyId,
        fileName: input.fileName,
        fileType: input.fileType,
        fileSize: input.fileSize,
        fileSha256: input.fileSha256.toLowerCase(),
        asOfDate: input.asOfDate,
        periodLabel: input.periodLabel ?? "",
        status: "READY",
        mappingSource,
        mappingJson: JSON.stringify(mapping),
        rowCount: rawRows.length,
        validRowCount: parsed.length,
        warningCount,
        errorsJson: JSON.stringify(errors.slice(0, AGING_IMPORT_LIMITS.maxErrorsStored)),
        createdById: user.id,
        createdByName: user.username,
      },
    });
    for (let start = 0; start < parsed.length; start += AGING_IMPORT_LIMITS.batchSize) {
      const batch = parsed.slice(start, start + AGING_IMPORT_LIMITS.batchSize).map((p) => ({
        importId: imp.id,
        rowIndex: p.rowIndex,
        customerCode: p.customerCode,
        customerName: p.customerName,
        customerKey: p.customerKey,
        outstandingBalanceMinor: p.outstandingBalanceMinor,
        invoiceNumber: p.invoiceNumber,
        invoiceDate: p.invoiceDate,
        invoiceAmountMinor: p.invoiceAmountMinor,
        dueDate: p.dueDate,
        ageDays: p.ageDays,
        lastSaleDate: p.lastSaleDate,
        lastSaleAmountMinor: p.lastSaleAmountMinor,
        lastCollectionDate: p.lastCollectionDate,
        lastCollectionAmountMinor: p.lastCollectionAmountMinor,
        creditLimitMinor: p.creditLimitMinor,
        guaranteeOrInsurance: p.guaranteeOrInsurance,
        salesperson: p.salesperson,
        responsiblePerson: p.responsiblePerson,
        notes: p.notes,
        flagsJson: JSON.stringify(p.flags),
        warningsJson: JSON.stringify(p.warnings),
      }));
      await tx.agingRow.createMany({ data: batch });
    }
    return imp;
  });

  await writeAudit(null, {
    user: { id: user.id, username: user.username, name: user.name },
    action: "AGING_UPLOADED",
    entityType: "Aging",
    entityId: created.id,
    description: `رفع ملف أعمار ديون (${created.fileName}) — ${parsed.length} صفًا صالحًا من ${rawRows.length}`,
    metadata: { companyId: input.companyId, fileType: input.fileType, fileSize: input.fileSize, mappingSource, asOfDate: input.asOfDate },
    ip,
  });

  return {
    importId: created.id,
    rowCount: rawRows.length,
    validRowCount: parsed.length,
    warningCount,
    rejectedCount: errors.length,
    errorsSample: errors.slice(0, 20),
    mapping,
    mappingSource,
    unmappedHeaders: autoMapHeaders(headers).unmapped.filter((h) => !Object.values(mapping).includes(h)),
  };
}

async function minorUnitsOf(currency: string): Promise<number> {
  return 2; // كل العملات المدعومة حاليًا (YER/SAR/USD) minor = 2 — نقطة توسعة مستقبلية
}

// ── قراءة الاستيرادات ───────────────────────────────────────────────────────

export async function listAgingImports(user: PermUser, companyId: string): Promise<Record<string, unknown>[]> {
  assertScope(user, companyId);
  const rows = await db.agingImport.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, fileName: true, fileType: true, fileSize: true, fileSha256: true, asOfDate: true,
      periodLabel: true, status: true, mappingSource: true, rowCount: true, validRowCount: true,
      warningCount: true, createdByName: true, createdAt: true,
      _count: { select: { snapshots: true } },
    },
  });
  return rows.map((r) => ({ ...r, snapshotCount: r._count.snapshots, _count: undefined }));
}

export async function getAgingImport(user: PermUser, companyId: string, importId: string, limit = 200): Promise<Record<string, unknown>> {
  assertScope(user, companyId);
  const imp = await db.agingImport.findUnique({
    where: { id: importId },
    include: { _count: { select: { snapshots: true } } },
  });
  if (!imp || imp.companyId !== companyId) throw new AgingError("NOT_FOUND", "الاستيراد غير موجود");
  const rows = await db.agingRow.findMany({
    where: { importId },
    orderBy: { rowIndex: "asc" },
    take: Math.min(Math.max(limit, 1), 1000),
    select: {
      id: true, rowIndex: true, customerCode: true, customerName: true, customerKey: true,
      outstandingBalanceMinor: true, invoiceNumber: true, invoiceDate: true, invoiceAmountMinor: true,
      dueDate: true, ageDays: true, lastSaleDate: true, lastSaleAmountMinor: true,
      lastCollectionDate: true, lastCollectionAmountMinor: true, creditLimitMinor: true,
      guaranteeOrInsurance: true, salesperson: true, responsiblePerson: true, notes: true,
      flagsJson: true, warningsJson: true,
    },
  });
  return {
    import: { ...imp, snapshotCount: imp._count.snapshots, _count: undefined, mappingJson: undefined, mapping: JSON.parse(imp.mappingJson) as AgingMapping },
    rows: rows.map((r) => ({
      ...r,
      outstandingBalanceMinor: r.outstandingBalanceMinor == null ? null : r.outstandingBalanceMinor.toString(),
      invoiceAmountMinor: r.invoiceAmountMinor == null ? null : r.invoiceAmountMinor.toString(),
      lastSaleAmountMinor: r.lastSaleAmountMinor == null ? null : r.lastSaleAmountMinor.toString(),
      lastCollectionAmountMinor: r.lastCollectionAmountMinor == null ? null : r.lastCollectionAmountMinor.toString(),
      creditLimitMinor: r.creditLimitMinor == null ? null : r.creditLimitMinor.toString(),
      flags: JSON.parse(r.flagsJson) as string[],
      warnings: JSON.parse(r.warningsJson) as string[],
      flagsJson: undefined,
      warningsJson: undefined,
    })),
  };
}

export async function deleteAgingImport(
  user: PermUser & { id: string; username: string; name?: string },
  importId: string,
  ip: string | null
): Promise<void> {
  assertPerm(user, (p, r) => r === "admin" || p.deleteDraftAging === true, "لا تملك صلاحية حذف استيراد الأعمار");
  const imp = await db.agingImport.findUnique({ where: { id: importId }, select: { id: true, companyId: true, fileName: true, _count: { select: { snapshots: true } } } });
  if (!imp) throw new AgingError("NOT_FOUND", "الاستيراد غير موجود");
  assertScope(user, imp.companyId);
  if (imp._count.snapshots > 0) {
    throw new AgingError("CONFLICT", "لا يمكن حذف استيراد مرتبط بلقطات أعمار (حتى المسودة) — احفظ السجل التاريخي", { snapshotCount: imp._count.snapshots });
  }
  await db.agingImport.delete({ where: { id: importId } });
  await writeAudit(null, {
    user: { id: user.id, username: user.username, name: user.name },
    action: "AGING_IMPORT_DELETED",
    entityType: "Aging",
    entityId: importId,
    description: `حذف استيراد أعمار (${imp.fileName})`,
    ip,
  });
}

// ── اللقطات: الحساب والتجميد ────────────────────────────────────────────────

interface BucketedRow {
  customerKey: string;
  customerCode: string | null;
  customerName: string | null;
  balanceMinor: bigint;
  bucketCode: string;
  ageDays: number | null;
  basis: "EXPLICIT" | "DUE_DATE" | "INVOICE_DATE" | "NONE";
  dueDate: string | null;
  lastSaleDate: string | null;
  lastCollectionDate: string | null;
  creditLimitMinor: bigint | null;
  overCreditLimit: boolean;
}

function computeBucketsForRows(rows: Array<Record<string, unknown>>, buckets: AgingBucketDef[], asOfDate: string): BucketedRow[] {
  const out: BucketedRow[] = [];
  for (const r of rows) {
    const balance = r.outstandingBalanceMinor as bigint | null;
    if (balance == null) continue; // missing != zero — يُستثنى من التحليل النقدي ويُعلن
    let basis: BucketedRow["basis"] = "NONE";
    let daysValue: number | null = null;
    if (typeof r.ageDays === "number") {
      basis = "EXPLICIT";
      daysValue = r.ageDays;
    } else if (typeof r.dueDate === "string") {
      const d = daysBetween(r.dueDate, asOfDate);
      if (d != null) { basis = "DUE_DATE"; daysValue = d; }
    }
    if (basis === "NONE" && typeof r.invoiceDate === "string") {
      const d = daysBetween(r.invoiceDate, asOfDate);
      if (d != null && d >= 0) { basis = "INVOICE_DATE"; daysValue = d; }
    }
    const bucketCode = assignBucket(buckets, basis, daysValue);
    const creditLimit = (r.creditLimitMinor as bigint | null) ?? null;
    out.push({
      customerKey: r.customerKey as string,
      customerCode: (r.customerCode as string | null) ?? null,
      customerName: (r.customerName as string | null) ?? null,
      balanceMinor: balance,
      bucketCode,
      ageDays: daysValue != null && daysValue >= 0 ? daysValue : daysValue, // قد يكون سالبًا (غير مستحق)
      basis,
      dueDate: (r.dueDate as string | null) ?? null,
      lastSaleDate: (r.lastSaleDate as string | null) ?? null,
      lastCollectionDate: (r.lastCollectionDate as string | null) ?? null,
      creditLimitMinor: creditLimit,
      overCreditLimit: creditLimit != null && creditLimit > BigInt(0) && balance > creditLimit,
    });
  }
  return out;
}

async function reconcileToTrialBalance(companyId: string, asOfDate: string, agingTotal: bigint | null) {
  const mappings = await db.receivablesAccountMapping.findMany({ where: { companyId }, orderBy: { accountCode: "asc" } });
  if (mappings.length === 0) {
    return { status: "NO_RECEIVABLE_MAPPING", detail: { accounts: [], note: "اربط حسابات المدينين بالإعدادات لتشغيل المطابقة" } };
  }
  if (agingTotal == null) {
    return { status: "INCOMPLETE_DATA", detail: { accounts: mappings.map((m) => ({ accountCode: m.accountCode, label: m.label })), note: "لا صفوف أرصدة صالحة للمطابقة" } };
  }
  const fy = await db.fiscalYear.findFirst({
    where: { companyId, startDate: { lte: asOfDate }, endDate: { gte: asOfDate } },
    orderBy: { startDate: "asc" },
  });
  if (!fy) {
    return { status: "NO_TB_DATA", detail: { accounts: [], note: "تاريخ الأساس خارج أي سنة مالية معرّفة" } };
  }
  const committed = await db.trialBalanceImport.findMany({
    where: { companyId, fiscalYearId: fy.id, status: "COMMITTED" },
    orderBy: [{ toDate: "desc" }, { revisionNumber: "desc" }],
  });
  if (committed.length === 0) {
    return { status: "NO_TB_DATA", detail: { accounts: [], fiscalYearCode: fy.code, note: "لا يوجد ميزان مراجعة معتمد في سنة الأساس" } };
  }
  const basis = committed.find((c) => c.dataType === "CUMULATIVE_YTD");
  if (!basis) {
    return { status: "INCOMPLETE_DATA", detail: { fiscalYearCode: fy.code, note: "البيانات المعتمدة لا تتضمن تراكمي YTD (أساس أرصدة)" } };
  }
  const lines = await db.trialBalanceLine.findMany({
    where: { importId: basis.id, accountCode: { in: mappings.map((m) => m.accountCode) } },
    select: { accountCode: true, accountName: true, netMinor: true },
  });
  const perAccount = new Map<string, { accountName: string; netMinor: bigint }>();
  for (const l of lines) {
    const prev = perAccount.get(l.accountCode) ?? { accountName: l.accountName, netMinor: BigInt(0) };
    perAccount.set(l.accountCode, { accountName: l.accountName, netMinor: prev.netMinor + l.netMinor });
  }
  const accounts = mappings.map((m) => ({
    accountCode: m.accountCode,
    label: m.label,
    accountName: perAccount.get(m.accountCode)?.accountName ?? "",
    netMinor: (perAccount.get(m.accountCode)?.netMinor ?? BigInt(0)).toString(),
  }));
  const tbTotal = accounts.reduce((acc, a) => acc + BigInt(a.netMinor), BigInt(0));
  const difference = agingTotal - tbTotal;
  return {
    status: difference === BigInt(0) ? "RECONCILED" : "DIFFERENCE",
    detail: {
      basisImportId: basis.id,
      fiscalYearCode: fy.code,
      fromDate: basis.fromDate,
      toDate: basis.toDate,
      dataType: basis.dataType,
      accounts,
      tbTotalMinor: tbTotal.toString(),
      agingTotalMinor: agingTotal.toString(),
      differenceMinor: difference.toString(),
    },
  };
}

function buildInsights(
  totals: AgingTotals,
  bucketTotals: BucketTotal[],
  rules: Array<{ code: string; enabled: boolean; thresholdBp: number | null; thresholdDays: number | null; thresholdCount: number | null; severity: string }>,
  trend: { previousTotalMinor: string | null; previousAsOfDate: string | null } | null,
  minorUnits: number
): AgingInsight[] {
  const out: AgingInsight[] = [];
  const rule = (code: AgingInsightRuleCode) => rules.find((r) => r.code === code && r.enabled);
  const money = (v: string | null) => formatMinor(v, minorUnits);

  const r1 = rule("OVERDUE_RATIO_HIGH");
  if (r1 && totals.overduePctBp != null && r1.thresholdBp != null && totals.overduePctBp >= r1.thresholdBp) {
    out.push({
      code: "OVERDUE_RATIO_HIGH",
      severity: r1.severity as AgingInsight["severity"],
      kind: "ANALYSIS",
      titleAr: "نسبة المتأخر مرتفعة",
      titleEn: "High overdue ratio",
      detailAr: `المتأخر ${money(totals.overdueMinor)} من إجمالي ${money(totals.totalMinor)} — بنسبة ${formatBp(totals.overduePctBp)} (العتبة ${formatBp(r1.thresholdBp)}).`,
      detailEn: `Overdue ${money(totals.overdueMinor)} of ${money(totals.totalMinor)} total — ${formatBp(totals.overduePctBp)} (threshold ${formatBp(r1.thresholdBp)}).`,
      amountMinor: totals.overdueMinor ?? undefined,
      pctBp: totals.overduePctBp,
      suggestedActionAr: "راجع خطة التحصيل للشرائط المتأخرة مع فريق المبيعات.",
      suggestedActionEn: "Review the collections plan for overdue buckets with the sales team.",
    });
  }
  const r2 = rule("TOP5_CONCENTRATION");
  if (r2 && totals.top5ConcentrationBp != null && r2.thresholdBp != null && totals.top5ConcentrationBp >= r2.thresholdBp) {
    out.push({
      code: "TOP5_CONCENTRATION",
      severity: r2.severity as AgingInsight["severity"],
      kind: "ANALYSIS",
      titleAr: "تركّز مرتفع لدى أكبر المدينين",
      titleEn: "High debtor concentration",
      detailAr: `أكبر 5 عملاء يمثلون ${formatBp(totals.top5ConcentrationBp)} من إجمالي المستحقات (العتبة ${formatBp(r2.thresholdBp)}).`,
      detailEn: `Top 5 customers represent ${formatBp(totals.top5ConcentrationBp)} of total receivables (threshold ${formatBp(r2.thresholdBp)}).`,
      pctBp: totals.top5ConcentrationBp,
      suggestedActionAr: "راقب تعرضك لأكبر العملاء ووثّق حدود الائتمان.",
      suggestedActionEn: "Monitor exposure to largest customers and document credit limits.",
    });
  }
  const r3 = rule("CREDIT_LIMIT_BREACHES");
  if (r3 && r3.thresholdCount != null && totals.creditBreachCount >= r3.thresholdCount) {
    out.push({
      code: "CREDIT_LIMIT_BREACHES",
      severity: r3.severity as AgingInsight["severity"],
      kind: "FACT",
      titleAr: "عملاء تجاوزوا حد الائتمان",
      titleEn: "Credit-limit breaches",
      detailAr: `${totals.creditBreachCount} عميلًا تجاوز رصيده حد الائتمان المسجل.`,
      detailEn: `${totals.creditBreachCount} customer(s) exceed their recorded credit limit.`,
      affectedCount: totals.creditBreachCount,
      suggestedActionAr: "راجع حدود الائتمان وشروط البيع لهؤلاء العملاء.",
      suggestedActionEn: "Review credit limits and sale terms for these customers.",
    });
  }
  const r4 = rule("STALE_COLLECTIONS");
  if (r4 && r4.thresholdDays != null && totals.staleCollectionCount >= 1) {
    out.push({
      code: "STALE_COLLECTIONS",
      severity: r4.severity as AgingInsight["severity"],
      kind: "ANALYSIS",
      titleAr: "ركود في التحصيل",
      titleEn: "Stale collections",
      detailAr: `${totals.staleCollectionCount} عميلًا برصيد قائم بلا تحصيل خلال ${r4.thresholdDays} يومًا أو أكثر.`,
      detailEn: `${totals.staleCollectionCount} customer(s) with open balance and no collection within ${r4.thresholdDays} days.`,
      affectedCount: totals.staleCollectionCount,
      suggestedActionAr: "أعِد جدولة متابعة التحصيل للعملاء الراكدين.",
      suggestedActionEn: "Re-schedule collection follow-up for inactive customers.",
    });
  }
  const r5 = rule("NEGATIVE_BALANCES");
  if (r5 && r5.thresholdCount != null && totals.negativeBalanceCount >= r5.thresholdCount) {
    out.push({
      code: "NEGATIVE_BALANCES",
      severity: r5.severity as AgingInsight["severity"],
      kind: "FACT",
      titleAr: "أرصدة سالبة (قيم شاذة)",
      titleEn: "Negative balances (unusual values)",
      detailAr: `${totals.negativeBalanceCount} صفًا برصيد سالب — تُعرض كما هي ولا تُصفر.`,
      detailEn: `${totals.negativeBalanceCount} row(s) with negative balance — displayed as-is, never zeroed.`,
      affectedCount: totals.negativeBalanceCount,
      suggestedActionAr: "تحقق من أسباب الأرصدة الدائنة (دفعات زائدة/مرتجعات).",
      suggestedActionEn: "Investigate credit balances (overpayments/returns).",
    });
  }
  const r6 = rule("MISSING_DATA");
  const missingTotal = totals.missingBalanceCount + totals.undeterminedCount;
  if (r6 && r6.thresholdCount != null && missingTotal >= r6.thresholdCount) {
    out.push({
      code: "MISSING_DATA",
      severity: r6.severity as AgingInsight["severity"],
      kind: "FACT",
      titleAr: "بيانات ناقصة معلنة",
      titleEn: "Disclosed missing data",
      detailAr: `${totals.missingBalanceCount} صفًا بلا رصيد، و${totals.undeterminedCount} صفًا بلا أساس عمر — لا تُعامل صفرًا.`,
      detailEn: `${totals.missingBalanceCount} row(s) missing balance and ${totals.undeterminedCount} without aging basis — never treated as zero.`,
      affectedCount: missingTotal,
      suggestedActionAr: "أكمل مصدر البيانات لرفع تغطية التحليل.",
      suggestedActionEn: "Complete the data source to improve analysis coverage.",
    });
  }
  const r7 = rule("VERY_OLD_RECEIVABLES");
  const veryOld = bucketTotals.find((b) => b.code === "D365_PLUS");
  if (r7 && r7.thresholdCount != null && veryOld && BigInt(veryOld.amountMinor) !== BigInt(0)) {
    out.push({
      code: "VERY_OLD_RECEIVABLES",
      severity: r7.severity as AgingInsight["severity"],
      kind: "FACT",
      titleAr: "مستحقات أقدم من سنة",
      titleEn: "Receivables older than one year",
      detailAr: `شريط أكثر من 365 يومًا يحمل ${money(veryOld.amountMinor)} عبر ${veryOld.count} عميلًا.`,
      detailEn: `The >365 bucket holds ${money(veryOld.amountMinor)} across ${veryOld.count} customer(s).`,
      amountMinor: veryOld.amountMinor,
      affectedCount: veryOld.count,
      suggestedActionAr: "قِيّم قابلية التحصيل وفق سياسة الإدارة (حساب الخسائر الائتمانية مرحلة منفصلة).",
      suggestedActionEn: "Assess collectability per management policy (ECL is a separate phase).",
    });
  }
  const r8 = rule("AGING_TREND");
  if (r8 && trend?.previousTotalMinor && r8.thresholdBp != null && totals.totalMinor != null) {
    const prev = BigInt(trend.previousTotalMinor);
    const curr = BigInt(totals.totalMinor);
    if (prev !== BigInt(0)) {
      const deltaBp = pctBpOf(curr >= prev ? curr - prev : -(prev - curr), prev);
      if (deltaBp != null && Math.abs(deltaBp) >= r8.thresholdBp) {
        const up = curr >= prev;
        out.push({
          code: "AGING_TREND",
          severity: r8.severity as AgingInsight["severity"],
          kind: "ANALYSIS",
          titleAr: up ? "نمو محوري في المستحقات" : "انخفاض محوري في المستحقات",
          titleEn: up ? "Material growth in receivables" : "Material decline in receivables",
          detailAr: `الإجمالي تغيّر بنسبة ${formatBp(deltaBp)} مقارنة بلقطة ${trend.previousAsOfDate ?? ""} (${money(trend.previousTotalMinor)} ← ${money(totals.totalMinor)}).`,
          detailEn: `Total changed by ${formatBp(deltaBp)} vs snapshot ${trend.previousAsOfDate ?? ""} (${money(trend.previousTotalMinor)} → ${money(totals.totalMinor)}).`,
          pctBp: deltaBp,
          suggestedActionAr: "افهم أسباب التغير (نمو نشاط/تباطؤ تحصيل) قبل القرارات.",
          suggestedActionEn: "Understand the drivers (growth vs slower collection) before decisions.",
        });
      }
    }
  }
  return out;
}

function buildRiskRows(bucketed: BucketedRow[], totals: AgingTotals, staleDays: number): AgingRiskRow[] {
  const byCustomer = new Map<string, BucketedRow[]>();
  for (const r of bucketed) {
    const list = byCustomer.get(r.customerKey) ?? [];
    list.push(r);
    byCustomer.set(r.customerKey, list);
  }
  const rows: AgingRiskRow[] = [];
  for (const [key, list] of byCustomer) {
    const balance = list.reduce((a, r) => a + r.balanceMinor, BigInt(0));
    // أسوأ عمر = أكبر قيمة أيام بأساس معلوم؛ شريط العميل = شريط ذلك السجل
    let worst: BucketedRow = list[0];
    for (const r of list) {
      const wDays = worst.ageDays == null ? -1 : worst.ageDays;
      const rDays = r.ageDays == null ? -1 : r.ageDays;
      if (rDays > wDays) worst = r;
    }
    const lastSale = list.map((r) => r.lastSaleDate).filter((d): d is string => d != null).sort().at(-1) ?? null;
    const lastCollection = list.map((r) => r.lastCollectionDate).filter((d): d is string => d != null).sort().at(-1) ?? null;
    const creditLimit = list.map((r) => r.creditLimitMinor).find((c) => c != null) ?? null;
    const overLimit = creditLimit != null && creditLimit > BigInt(0) && balance > creditLimit;

    const reasonsAr: string[] = [];
    const reasonsEn: string[] = [];
    let score = 0;
    const bucketWeights: Record<string, number> = { NOT_DUE: 0, D1_30: 10, D31_60: 20, D61_90: 30, D91_180: 40, D181_365: 50, D365_PLUS: 60, UNDETERMINED: 5 };
    const w = bucketWeights[worst.bucketCode] ?? 5;
    score += w;
    if (w >= 40) { reasonsAr.push(`شريط تعثر مرتفع (${worst.bucketCode})`); reasonsEn.push(`High aging bucket (${worst.bucketCode})`); }
    else if (w >= 10) { reasonsAr.push(`تأخر ضمن ${worst.bucketCode}`); reasonsEn.push(`Aged within ${worst.bucketCode}`); }
    const total = totals.totalMinor != null ? BigInt(totals.totalMinor) : BigInt(0);
    const shareBp = pctBpOf(balance, total);
    if (shareBp != null && shareBp >= 1000) { score += 15; reasonsAr.push(`يمثل ${formatBp(shareBp)} من الإجمالي`); reasonsEn.push(`${formatBp(shareBp)} of total`); }
    else if (shareBp != null && shareBp >= 500) { score += 10; reasonsAr.push(`${formatBp(shareBp)} من الإجمالي`); reasonsEn.push(`${formatBp(shareBp)} of total`); }
    else if (shareBp != null && shareBp >= 200) { score += 6; reasonsAr.push(`${formatBp(shareBp)} من الإجمالي`); reasonsEn.push(`${formatBp(shareBp)} of total`); }
    if (lastCollection) {
      const since = daysBetween(lastCollection, totals.asOfDate);
      if (since != null && since >= staleDays) { score += since >= 365 ? 8 : 5; reasonsAr.push(`بلا تحصيل منذ ${since} يومًا`); reasonsEn.push(`No collection for ${since} days`); }
    } else if (balance > BigInt(0)) { score += 8; reasonsAr.push("لا يوجد أي تحصيل مسجل"); reasonsEn.push("No collection recorded"); }
    if (lastSale) {
      const since = daysBetween(lastSale, totals.asOfDate);
      if (since != null && since >= 365) { score += 2; reasonsAr.push(`بلا بيع منذ ${since} يومًا`); reasonsEn.push(`No sale for ${since} days`); }
    }
    if (overLimit) { score += 10; reasonsAr.push("تجاوز حد الائتمان"); reasonsEn.push("Over credit limit"); }
    score = Math.min(score, 100);
    const level: AgingRiskRow["level"] = score >= 60 ? "HIGH" : score >= 30 ? "MEDIUM" : "LOW";
    rows.push({
      customerKey: key,
      customerCode: list[0].customerCode,
      customerName: list[0].customerName,
      balanceMinor: balance.toString(),
      maxAgeDays: worst.ageDays,
      bucketCode: worst.bucketCode,
      lastSaleDate: lastSale,
      lastCollectionDate: lastCollection,
      creditLimitMinor: creditLimit ? creditLimit.toString() : null,
      overCreditLimit: overLimit,
      score,
      level,
      reasonsAr,
      reasonsEn,
      suggestedActionAr: level === "HIGH" ? "مراجعة تحصيل عاجلة وخطة تحصيل موثقة" : level === "MEDIUM" ? "جدولة متابعة تحصيل قريبة" : "متابعة دورية اعتيادية",
      suggestedActionEn: level === "HIGH" ? "Urgent collection review with a documented plan" : level === "MEDIUM" ? "Schedule near-term collection follow-up" : "Routine periodic follow-up",
    });
  }
  rows.sort((a, b) => (BigInt(b.balanceMinor) > BigInt(a.balanceMinor) ? 1 : BigInt(b.balanceMinor) < BigInt(a.balanceMinor) ? -1 : a.customerKey.localeCompare(b.customerKey)));
  return rows;
}

function buildBucketTotals(bucketed: BucketedRow[], buckets: AgingBucketDef[], total: bigint | null): BucketTotal[] {
  const out: BucketTotal[] = [];
  let undeterminedAmount = BigInt(0);
  let undeterminedCount = 0;
  for (const b of [...buckets].sort((x, y) => x.order - y.order)) {
    const rows = bucketed.filter((r) => r.bucketCode === b.code);
    const amount = rows.reduce((a, r) => a + r.balanceMinor, BigInt(0));
    out.push({
      code: b.code,
      labelAr: b.labelAr,
      labelEn: b.labelEn,
      amountMinor: amount.toString(),
      count: rows.length,
      pctBp: total != null && total !== BigInt(0) ? pctBpOf(amount, total) ?? 0 : 0,
    });
  }
  for (const r of bucketed) {
    if (!buckets.some((b) => b.code === r.bucketCode)) { undeterminedAmount += r.balanceMinor; undeterminedCount++; }
  }
  out.push({
    code: UNDETERMINED_BUCKET.code,
    labelAr: UNDETERMINED_BUCKET.labelAr,
    labelEn: UNDETERMINED_BUCKET.labelEn,
    amountMinor: undeterminedAmount.toString(),
    count: undeterminedCount,
    pctBp: total != null && total !== BigInt(0) ? pctBpOf(undeterminedAmount, total) ?? 0 : 0,
    isUndetermined: true,
  });
  return out;
}

export async function createAgingSnapshot(
  user: PermUser & { id: string; username: string; name?: string },
  input: { importId: string; periodLabel?: string; acknowledgeApprovedDuplicate?: boolean },
  ip: string | null
): Promise<Record<string, unknown>> {
  assertPerm(user, (p, r) => r === "admin" || p.uploadAging === true, "لا تملك صلاحية إنشاء لقطات الأعمار");
  const imp = await db.agingImport.findUnique({ where: { id: input.importId }, include: { company: { select: { functionalCurrency: true } } } });
  if (!imp) throw new AgingError("NOT_FOUND", "الاستيراد غير موجود");
  assertScope(user, imp.companyId);
  const existingApproved = await db.agingSnapshot.findFirst({
    where: { companyId: imp.companyId, asOfDate: imp.asOfDate, status: "APPROVED" },
    select: { id: true, periodLabel: true },
  });
  if (existingApproved && !input.acknowledgeApprovedDuplicate) {
    throw new AgingError("EXISTING_APPROVED_SNAPSHOT", "توجد لقطة معتمدة لنفس تاريخ الأساس — لا استبدال صامت؛ أقرّ صراحةً لإنشاء لقطة جديدة", { approvedSnapshotId: existingApproved.id });
  }
  const buckets = await loadBuckets(imp.companyId);
  const rules = await db.agingInsightRule.findMany({ where: { companyId: imp.companyId }, orderBy: { code: "asc" } });
  const staleDays = rules.find((r) => r.code === "STALE_COLLECTIONS")?.thresholdDays ?? 180;
  const rows = await db.agingRow.findMany({
    where: { importId: imp.id },
    select: {
      customerKey: true, customerCode: true, customerName: true, outstandingBalanceMinor: true,
      dueDate: true, invoiceDate: true, ageDays: true, lastSaleDate: true, lastCollectionDate: true,
      creditLimitMinor: true,
    },
  });
  const bucketed = computeBucketsForRows(rows as unknown as Array<Record<string, unknown>>, buckets, imp.asOfDate);
  const total = bucketed.length > 0 ? bucketed.reduce((a, r) => a + r.balanceMinor, BigInt(0)) : null;
  const overdue = bucketed
    .filter((r) => r.basis === "DUE_DATE" && r.ageDays != null && r.ageDays >= 1)
    .reduce((a, r) => a + r.balanceMinor, BigInt(0));
  const missingBalanceCount = rows.length - bucketed.length;
  const undeterminedRows = bucketed.filter((r) => r.bucketCode === UNDETERMINED_BUCKET.code);
  const agedRows = bucketed.filter((r) => r.ageDays != null);
  const weightedAge = agedRows.length > 0 && total != null && total !== BigInt(0)
    ? Number(agedRows.reduce((a, r) => a + BigInt(r.ageDays!) * r.balanceMinor, BigInt(0)) / total)
    : null;
  const perCustomer = new Map<string, bigint>();
  for (const r of bucketed) perCustomer.set(r.customerKey, (perCustomer.get(r.customerKey) ?? BigInt(0)) + r.balanceMinor);
  const sortedCustomers = [...perCustomer.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0].localeCompare(b[0])));
  const top5 = sortedCustomers.slice(0, 5).reduce((a, [, v]) => a + v, BigInt(0));
  const negativeCount = bucketed.filter((r) => r.balanceMinor < BigInt(0)).length;
  const missingDue = rows.filter((r) => r.dueDate == null).length;

  const totals: AgingTotals = {
    totalMinor: total != null ? total.toString() : null,
    overdueMinor: total != null ? overdue.toString() : null,
    overduePctBp: total != null && total !== BigInt(0) ? pctBpOf(overdue, total) : null,
    validRowCount: bucketed.length,
    customerCount: perCustomer.size,
    missingBalanceCount,
    missingDueDateCount: missingDue,
    undeterminedCount: undeterminedRows.length,
    undeterminedMinor: undeterminedRows.reduce((a, r) => a + r.balanceMinor, BigInt(0)).toString(),
    creditBreachCount: bucketed.filter((r) => r.overCreditLimit).length,
    negativeBalanceCount: negativeCount,
    weightedAvgAgeDays: weightedAge,
    staleCollectionCount: 0, // يُحسب أدناه على مستوى العملاء
    largestDebtorKey: sortedCustomers[0]?.[0] ?? null,
    largestDebtorMinor: sortedCustomers[0]?.[1].toString() ?? null,
    top5ConcentrationBp: total != null && total !== BigInt(0) ? pctBpOf(top5, total) : null,
    asOfDate: imp.asOfDate,
  };

  const bucketTotals = buildBucketTotals(bucketed, buckets, total);
  const riskRows = buildRiskRows(bucketed, totals, staleDays);
  totals.staleCollectionCount = riskRows.filter((r) => r.reasonsAr.some((x) => x.includes("بلا تحصيل"))).length;

  const previousApproved = await db.agingSnapshot.findFirst({
    where: { companyId: imp.companyId, status: "APPROVED", asOfDate: { lt: imp.asOfDate } },
    orderBy: { asOfDate: "desc" },
    select: { asOfDate: true, totalsJson: true },
  });
  const prevTotals = previousApproved ? (JSON.parse(previousApproved.totalsJson) as AgingTotals) : null;
  const trend = previousApproved ? { previousTotalMinor: prevTotals?.totalMinor ?? null, previousAsOfDate: previousApproved.asOfDate } : null;

  const reconciliation = await reconcileToTrialBalance(imp.companyId, imp.asOfDate, total);
  const insights = buildInsights(totals, bucketTotals, rules, trend, await minorUnitsOf(imp.company.functionalCurrency));

  const snapshot = await db.$transaction(async (tx) => {
    const snap = await tx.agingSnapshot.create({
      data: {
        companyId: imp.companyId,
        importId: imp.id,
        asOfDate: imp.asOfDate,
        periodLabel: input.periodLabel ?? imp.periodLabel,
        status: "DRAFT",
        currency: imp.company.functionalCurrency,
        totalsJson: JSON.stringify(totals),
        bucketTotalsJson: JSON.stringify(bucketTotals),
        reconciliationStatus: reconciliation.status,
        reconciliationJson: JSON.stringify(reconciliation.detail),
        insightsJson: JSON.stringify(insights),
        riskJson: JSON.stringify({
          rows: riskRows.slice(0, 50),
          customerCount: riskRows.length,
          highCount: riskRows.filter((r) => r.level === "HIGH").length,
          mediumCount: riskRows.filter((r) => r.level === "MEDIUM").length,
          lowCount: riskRows.filter((r) => r.level === "LOW").length,
        }),
        createdById: user.id,
        createdByName: user.username,
      },
    });
    for (let start = 0; start < bucketed.length; start += AGING_IMPORT_LIMITS.batchSize) {
      const batch = bucketed.slice(start, start + AGING_IMPORT_LIMITS.batchSize).map((r) => ({
        snapshotId: snap.id,
        customerKey: r.customerKey,
        customerCode: r.customerCode,
        customerName: r.customerName,
        balanceMinor: r.balanceMinor,
        bucketCode: r.bucketCode,
        ageDays: r.ageDays,
        basis: r.basis,
      }));
      await tx.agingSnapshotRow.createMany({ data: batch });
    }
    return snap;
  });

  await writeAudit(null, {
    user: { id: user.id, username: user.username, name: user.name },
    action: "AGING_SNAPSHOT_CREATED",
    entityType: "Aging",
    entityId: snapshot.id,
    description: `إنشاء لقطة أعمار (مسودة) بتاريخ ${snapshot.asOfDate} — ${bucketed.length} صفًا`,
    metadata: { companyId: imp.companyId, importId: imp.id },
    ip,
  });
  return { snapshotId: snapshot.id, status: snapshot.status, totals, reconciliationStatus: reconciliation.status };
}

export async function listAgingSnapshots(user: PermUser, companyId: string): Promise<Record<string, unknown>> {
  assertScope(user, companyId);
  const snaps = await db.agingSnapshot.findMany({
    where: { companyId },
    orderBy: [{ asOfDate: "desc" }, { createdAt: "desc" }],
    select: {
      id: true, importId: true, asOfDate: true, periodLabel: true, status: true, currency: true,
      totalsJson: true, reconciliationStatus: true, createdByName: true, approvedByName: true,
      approvedAt: true, createdAt: true,
    },
  });
  return {
    snapshots: snaps.map((s) => ({
      id: s.id,
      importId: s.importId,
      asOfDate: s.asOfDate,
      periodLabel: s.periodLabel,
      status: s.status,
      currency: s.currency,
      reconciliationStatus: s.reconciliationStatus,
      totals: JSON.parse(s.totalsJson) as AgingTotals,
      createdByName: s.createdByName,
      approvedByName: s.approvedByName,
      approvedAt: s.approvedAt,
      createdAt: s.createdAt,
    })),
    trend: snaps
      .filter((s) => s.status === "APPROVED")
      .map((s) => {
        const t = JSON.parse(s.totalsJson) as AgingTotals;
        return { snapshotId: s.id, asOfDate: s.asOfDate, totalMinor: t.totalMinor, overdueMinor: t.overdueMinor };
      })
      .sort((a, b) => a.asOfDate.localeCompare(b.asOfDate)),
  };
}

export async function getAgingSnapshot(user: PermUser, snapshotId: string): Promise<Record<string, unknown>> {
  const snap = await db.agingSnapshot.findUnique({ where: { id: snapshotId } });
  if (!snap) throw new AgingError("NOT_FOUND", "اللقطة غير موجودة");
  assertScope(user, snap.companyId);
  const canInsights = user.role === "admin" || user.permissions.viewInsights === true;
  const topRows = await db.agingSnapshotRow.findMany({
    where: { snapshotId },
    orderBy: { balanceMinor: "desc" },
    take: 20,
    select: { customerKey: true, customerCode: true, customerName: true, balanceMinor: true, bucketCode: true, ageDays: true, basis: true },
  });
  return {
    snapshot: {
      id: snap.id,
      importId: snap.importId,
      companyId: snap.companyId,
      asOfDate: snap.asOfDate,
      periodLabel: snap.periodLabel,
      status: snap.status,
      currency: snap.currency,
      reconciliationStatus: snap.reconciliationStatus,
      totals: JSON.parse(snap.totalsJson) as AgingTotals,
      bucketTotals: JSON.parse(snap.bucketTotalsJson) as BucketTotal[],
      reconciliation: JSON.parse(snap.reconciliationJson) as Record<string, unknown>,
      risk: JSON.parse(snap.riskJson) as Record<string, unknown>,
      insights: canInsights ? (JSON.parse(snap.insightsJson) as AgingInsight[]) : null,
      insightsRestricted: !canInsights,
      createdByName: snap.createdByName,
      approvedByName: snap.approvedByName,
      approvedAt: snap.approvedAt,
      createdAt: snap.createdAt,
    },
    topRows: topRows.map((r) => ({ ...r, balanceMinor: r.balanceMinor.toString() })),
  };
}

export async function approveAgingSnapshot(
  user: PermUser & { id: string; username: string; name?: string },
  snapshotId: string,
  ip: string | null
): Promise<void> {
  assertPerm(user, (p, r) => r === "admin" || p.approveAgingSnapshot === true, "لا تملك صلاحية اعتماد لقطات الأعمار");
  const snap = await db.agingSnapshot.findUnique({ where: { id: snapshotId }, select: { id: true, companyId: true, status: true, importId: true, asOfDate: true, import: { select: { createdById: true } } } });
  if (!snap) throw new AgingError("NOT_FOUND", "اللقطة غير موجودة");
  assertScope(user, snap.companyId);
  if (snap.status === "APPROVED") throw new AgingError("CONFLICT", "اللقطة معتمدة مسبقًا");
  // SoD (C.11): المعتمد يختلف عن منشئ الاستيراد المصدر — فصل صريح بين الرفع والاعتماد
  if (snap.import.createdById === user.id) {
    throw new AgingError("SOD_VIOLATION", "فصل المهام: منشئ الاستيراد لا يعتمد لقطته — اعتمدها مستخدم آخر");
  }
  await db.agingSnapshot.update({
    where: { id: snapshotId },
    data: { status: "APPROVED", approvedById: user.id, approvedByName: user.username, approvedAt: new Date() },
  });
  await writeAudit(null, {
    user: { id: user.id, username: user.username, name: user.name },
    action: "AGING_SNAPSHOT_APPROVED",
    entityType: "Aging",
    entityId: snapshotId,
    description: `اعتماد لقطة أعمار بتاريخ ${snap.asOfDate}`,
    ip,
  });
}

// ── الإعدادات ───────────────────────────────────────────────────────────────

export async function getAgingConfig(user: PermUser, companyId: string): Promise<Record<string, unknown>> {
  assertScope(user, companyId);
  await ensureAgingDefaults(companyId);
  const [buckets, accounts, rules] = await Promise.all([
    db.agingBucketConfig.findMany({ where: { companyId }, orderBy: { order: "asc" } }),
    db.receivablesAccountMapping.findMany({ where: { companyId }, orderBy: { accountCode: "asc" } }),
    db.agingInsightRule.findMany({ where: { companyId }, orderBy: { code: "asc" } }),
  ]);
  return { buckets, receivableAccounts: accounts, insightRules: rules };
}

const KNOWN_RULE_CODES: Set<string> = new Set(DEFAULT_INSIGHT_RULES.map((r) => r.code));
const KNOWN_SEVERITIES = new Set(["INFO", "ATTENTION", "IMPORTANT", "CRITICAL"]);

export async function updateAgingConfig(
  user: PermUser & { id: string; username: string; name?: string },
  input: { companyId: string; buckets?: AgingBucketDef[]; receivableAccounts?: Array<{ accountCode: string; label?: string }>; insightRules?: Array<{ code: string; enabled: boolean; thresholdBp?: number | null; thresholdDays?: number | null; thresholdCount?: number | null; severity?: string }> },
  ip: string | null
): Promise<void> {
  assertPerm(user, (p, r) => r === "admin" || p.configureAging === true, "لا تملك صلاحية إعداد الأعمار");
  assertScope(user, input.companyId);
  await db.$transaction(async (tx) => {
    if (input.buckets) {
      if (input.buckets.length === 0) throw new AgingError("INVALID_INPUT", "شريط واحد على الأقل مطلوب");
      const codes = new Set<string>();
      let notDueCount = 0;
      for (const b of input.buckets) {
        if (!b.code || codes.has(b.code)) throw new AgingError("INVALID_INPUT", `كود شريط مكرر أو فارغ: ${b.code}`);
        codes.add(b.code);
        if (b.isNotDue) notDueCount++;
      }
      if (notDueCount > 1) throw new AgingError("INVALID_INPUT", "شريط «غير مستحق» واحد كحد أقصى");
      // منع التداخل الرقمي: رتّب حسب الحد الأدنى وتأكد أن الحدود منفصلة
      const numeric = input.buckets.filter((b) => !b.isNotDue).sort((x, y) => (x.fromDays ?? -(1 << 30)) - (y.fromDays ?? -(1 << 30)));
      for (let i = 1; i < numeric.length; i++) {
        const prev = numeric[i - 1];
        const cur = numeric[i];
        const prevTo = prev.toDays;
        const curFrom = cur.fromDays;
        if (prevTo != null && curFrom != null && curFrom <= prevTo) {
          throw new AgingError("INVALID_INPUT", `شرائط متداخلة: ${prev.code} و${cur.code}`);
        }
        if (prevTo == null && i < numeric.length - 1) {
          throw new AgingError("INVALID_INPUT", `الشريط المفتوح ${prev.code} يجب أن يكون الأخير`);
        }
      }
      await tx.agingBucketConfig.deleteMany({ where: { companyId: input.companyId } });
      await tx.agingBucketConfig.createMany({
        data: input.buckets.map((b, i) => ({
          companyId: input.companyId,
          code: b.code,
          labelAr: b.labelAr,
          labelEn: b.labelEn,
          fromDays: b.fromDays,
          toDays: b.toDays,
          isNotDue: b.isNotDue,
          order: typeof b.order === "number" ? b.order : i + 1,
        })),
      });
    }
    if (input.receivableAccounts) {
      const seen = new Set<string>();
      for (const a of input.receivableAccounts) {
        if (!a.accountCode || seen.has(a.accountCode)) throw new AgingError("INVALID_INPUT", `كود حساب مكرر أو فارغ: ${a.accountCode}`);
        seen.add(a.accountCode);
      }
      await tx.receivablesAccountMapping.deleteMany({ where: { companyId: input.companyId } });
      if (input.receivableAccounts.length > 0) {
        await tx.receivablesAccountMapping.createMany({
          data: input.receivableAccounts.map((a) => ({ companyId: input.companyId, accountCode: a.accountCode, label: a.label ?? "" })),
        });
      }
    }
    if (input.insightRules) {
      assertPerm(user, (p, r) => r === "admin" || p.configureInsightRules === true, "لا تملك صلاحية إعداد قواعد الرؤى");
      for (const r of input.insightRules) {
        if (!KNOWN_RULE_CODES.has(r.code)) throw new AgingError("INVALID_INPUT", `كود قاعدة غير معروف: ${r.code}`);
        if (r.severity && !KNOWN_SEVERITIES.has(r.severity)) throw new AgingError("INVALID_INPUT", `درجة شدة غير معروفة: ${r.severity}`);
      }
      await tx.agingInsightRule.deleteMany({ where: { companyId: input.companyId } });
      await tx.agingInsightRule.createMany({
        data: input.insightRules.map((r) => ({
          companyId: input.companyId,
          code: r.code,
          enabled: r.enabled,
          thresholdBp: r.thresholdBp ?? null,
          thresholdDays: r.thresholdDays ?? null,
          thresholdCount: r.thresholdCount ?? null,
          severity: r.severity ?? "ATTENTION",
        })),
      });
    }
  });
  await writeAudit(null, {
    user: { id: user.id, username: user.username, name: user.name },
    action: "AGING_CONFIG_CHANGED",
    entityType: "Aging",
    entityId: input.companyId,
    description: "تغيير إعدادات أعمار الديون (شرائط/حسابات/قواعد رؤى)",
    metadata: { sections: [input.buckets ? "buckets" : null, input.receivableAccounts ? "accounts" : null, input.insightRules ? "insightRules" : null].filter(Boolean) },
    ip,
  });
}
