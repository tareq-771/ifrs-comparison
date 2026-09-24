-- Phase 6.10 — Receivables Aging & Collections (أعمار الديون والتحصيل)
-- Additive only: 7 new tables + their indexes. No changes to existing tables,
-- no data migrations, no destructive statements. Money = BIGINT minor units,
-- dates = TEXT date-only "YYYY-MM-DD" (TrialBalance convention).

-- CreateTable
CREATE TABLE "AgingBucketConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "labelAr" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "fromDays" INTEGER,
    "toDays" INTEGER,
    "isNotDue" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL,
    CONSTRAINT "AgingBucketConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgingInsightRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "thresholdBp" INTEGER,
    "thresholdDays" INTEGER,
    "thresholdCount" INTEGER,
    "severity" TEXT NOT NULL DEFAULT 'ATTENTION',
    CONSTRAINT "AgingInsightRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReceivablesAccountMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "ReceivablesAccountMapping_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgingImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "asOfDate" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'READY',
    "mappingSource" TEXT NOT NULL,
    "mappingJson" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "validRowCount" INTEGER NOT NULL,
    "warningCount" INTEGER NOT NULL,
    "errorsJson" TEXT NOT NULL DEFAULT '[]',
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgingImport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgingRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "importId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "customerCode" TEXT,
    "customerName" TEXT,
    "customerKey" TEXT NOT NULL,
    "outstandingBalanceMinor" BIGINT,
    "invoiceNumber" TEXT,
    "invoiceDate" TEXT,
    "invoiceAmountMinor" BIGINT,
    "dueDate" TEXT,
    "ageDays" INTEGER,
    "lastSaleDate" TEXT,
    "lastSaleAmountMinor" BIGINT,
    "lastCollectionDate" TEXT,
    "lastCollectionAmountMinor" BIGINT,
    "creditLimitMinor" BIGINT,
    "guaranteeOrInsurance" TEXT,
    "salesperson" TEXT,
    "responsiblePerson" TEXT,
    "notes" TEXT,
    "flagsJson" TEXT NOT NULL DEFAULT '[]',
    "warningsJson" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "AgingRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "AgingImport" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgingSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "asOfDate" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT '',
    "totalsJson" TEXT NOT NULL,
    "bucketTotalsJson" TEXT NOT NULL,
    "reconciliationStatus" TEXT NOT NULL,
    "reconciliationJson" TEXT NOT NULL DEFAULT '{}',
    "insightsJson" TEXT NOT NULL DEFAULT '[]',
    "riskJson" TEXT NOT NULL DEFAULT '[]',
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedByName" TEXT,
    "approvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgingSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AgingSnapshot_importId_fkey" FOREIGN KEY ("importId") REFERENCES "AgingImport" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgingSnapshotRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "customerKey" TEXT NOT NULL,
    "customerCode" TEXT,
    "customerName" TEXT,
    "balanceMinor" BIGINT NOT NULL,
    "bucketCode" TEXT NOT NULL,
    "ageDays" INTEGER,
    "basis" TEXT,
    CONSTRAINT "AgingSnapshotRow_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "AgingSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AgingBucketConfig_companyId_code_key" ON "AgingBucketConfig"("companyId", "code");

-- CreateIndex
CREATE INDEX "AgingBucketConfig_companyId_idx" ON "AgingBucketConfig"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AgingInsightRule_companyId_code_key" ON "AgingInsightRule"("companyId", "code");

-- CreateIndex
CREATE INDEX "AgingInsightRule_companyId_idx" ON "AgingInsightRule"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivablesAccountMapping_companyId_accountCode_key" ON "ReceivablesAccountMapping"("companyId", "accountCode");

-- CreateIndex
CREATE INDEX "ReceivablesAccountMapping_companyId_idx" ON "ReceivablesAccountMapping"("companyId");

-- CreateIndex
CREATE INDEX "AgingImport_companyId_createdAt_idx" ON "AgingImport"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "AgingRow_importId_idx" ON "AgingRow"("importId");

-- CreateIndex
CREATE INDEX "AgingRow_customerKey_idx" ON "AgingRow"("customerKey");

-- CreateIndex
CREATE INDEX "AgingSnapshot_companyId_asOfDate_idx" ON "AgingSnapshot"("companyId", "asOfDate");

-- CreateIndex
CREATE INDEX "AgingSnapshot_companyId_status_idx" ON "AgingSnapshot"("companyId", "status");

-- CreateIndex
CREATE INDEX "AgingSnapshotRow_snapshotId_idx" ON "AgingSnapshotRow"("snapshotId");

-- CreateIndex
CREATE INDEX "AgingSnapshotRow_snapshotId_bucketCode_idx" ON "AgingSnapshotRow"("snapshotId", "bucketCode");
