-- Phase 6.2B — Persisted Trial Balance Import Foundation
-- إضافة حصرية (additive-only): جدولان جديدان + فهارسهما. لا DROP ولا RENAME
-- ولا تعديل أي جدول قائم — لا فقدان بيانات ممكن.
--
-- TrialBalanceImport: ميزان مراجعة محفوظ لكل (شركة، سنة مالية، مدى فترات، نوع
-- بيانات صريح) — التفرد يمنع التكرار غير المقصود؛ الاستبدال مسموح للمسودات فقط
-- بصلاحية + تدقيق؛ المعتمد (COMMITTED) لا يُستبدل أبدًا في هذه المرحلة.
-- TrialBalanceLine: السطور بمبالغ BigInt بوحدات secondary + snapshot خريطة
-- يُجمّد عند الاعتماد (لا تغيير صامت للتقارير التاريخية).

-- CreateTable
CREATE TABLE "TrialBalanceImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "toDate" TEXT NOT NULL,
    "startOrdinal" INTEGER NOT NULL,
    "endOrdinal" INTEGER NOT NULL,
    "dataType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "originalFileName" TEXT NOT NULL DEFAULT '',
    "fileHash" TEXT NOT NULL DEFAULT '',
    "payloadHash" TEXT NOT NULL DEFAULT '',
    "totalDebitMinor" BIGINT NOT NULL,
    "totalCreditMinor" BIGINT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "updatedById" TEXT,
    "updatedByName" TEXT NOT NULL DEFAULT '',
    "committedAt" DATETIME,
    "committedById" TEXT,
    "committedByName" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrialBalanceImport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrialBalanceImport_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
-- التفرد الحاكم ضد التكرار غير المقصود (شركة + سنة مالية + مدى + نوع بيانات صريح)
CREATE UNIQUE INDEX "TrialBalanceImport_companyId_fiscalYearId_fromDate_toDate_dataType_key" ON "TrialBalanceImport"("companyId", "fiscalYearId", "fromDate", "toDate", "dataType");

-- CreateIndex
CREATE INDEX "TrialBalanceImport_companyId_status_idx" ON "TrialBalanceImport"("companyId", "status");

-- CreateIndex
CREATE INDEX "TrialBalanceImport_fiscalYearId_idx" ON "TrialBalanceImport"("fiscalYearId");

-- CreateIndex
CREATE INDEX "TrialBalanceImport_payloadHash_idx" ON "TrialBalanceImport"("payloadHash");

-- CreateTable
CREATE TABLE "TrialBalanceLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "importId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "accountCode" TEXT NOT NULL,
    "accountName" TEXT NOT NULL DEFAULT '',
    "debitMinor" BIGINT NOT NULL,
    "creditMinor" BIGINT NOT NULL,
    "netMinor" BIGINT NOT NULL,
    "mappedPrefix" TEXT,
    "mappingSource" TEXT,
    "mappingStatus" TEXT,
    "mainCategory" TEXT,
    "classification" TEXT,
    "aggregationBehavior" TEXT,
    "statementLineCode" TEXT,
    CONSTRAINT "TrialBalanceLine_importId_fkey" FOREIGN KEY ("importId") REFERENCES "TrialBalanceImport" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TrialBalanceLine_importId_idx" ON "TrialBalanceLine"("importId");

-- CreateIndex
CREATE INDEX "TrialBalanceLine_accountCode_idx" ON "TrialBalanceLine"("accountCode");
