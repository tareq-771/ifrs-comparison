-- CreateTable
CREATE TABLE "ConsolidationGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GroupCompanyMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "effectiveFrom" TEXT NOT NULL,
    "effectiveTo" TEXT,
    "ownershipPercentage" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "GroupCompanyMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ConsolidationGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GroupCompanyMembership_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GroupReportingLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "statementType" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "GroupReportingLine_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ConsolidationGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GroupReportingMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "companyLineCode" TEXT NOT NULL,
    "groupLineId" TEXT NOT NULL,
    CONSTRAINT "GroupReportingMapping_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ConsolidationGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GroupReportingMapping_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GroupReportingMapping_groupLineId_fkey" FOREIGN KEY ("groupLineId") REFERENCES "GroupReportingLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConsolidationAdjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ADJUSTMENT',
    "eliminationType" TEXT,
    "fiscalYearId" TEXT,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "preparedBy" TEXT NOT NULL DEFAULT '',
    "postedBy" TEXT NOT NULL DEFAULT '',
    "postedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConsolidationAdjustment_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ConsolidationGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdjustmentLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adjustmentId" TEXT NOT NULL,
    "groupLineId" TEXT NOT NULL,
    "debitMinor" BIGINT NOT NULL,
    "creditMinor" BIGINT NOT NULL,
    CONSTRAINT "AdjustmentLine_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "ConsolidationAdjustment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AdjustmentLine_groupLineId_fkey" FOREIGN KEY ("groupLineId") REFERENCES "GroupReportingLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsolidationGroup_code_key" ON "ConsolidationGroup"("code");

-- CreateIndex
CREATE INDEX "ConsolidationGroup_status_idx" ON "ConsolidationGroup"("status");

-- CreateIndex
CREATE INDEX "GroupCompanyMembership_groupId_idx" ON "GroupCompanyMembership"("groupId");

-- CreateIndex
CREATE INDEX "GroupCompanyMembership_companyId_idx" ON "GroupCompanyMembership"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupCompanyMembership_groupId_companyId_effectiveFrom_key" ON "GroupCompanyMembership"("groupId", "companyId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "GroupReportingLine_groupId_statementType_idx" ON "GroupReportingLine"("groupId", "statementType");

-- CreateIndex
CREATE UNIQUE INDEX "GroupReportingLine_groupId_code_key" ON "GroupReportingLine"("groupId", "code");

-- CreateIndex
CREATE INDEX "GroupReportingMapping_companyId_companyLineCode_idx" ON "GroupReportingMapping"("companyId", "companyLineCode");

-- CreateIndex
CREATE INDEX "GroupReportingMapping_groupLineId_idx" ON "GroupReportingMapping"("groupLineId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupReportingMapping_groupId_companyId_companyLineCode_key" ON "GroupReportingMapping"("groupId", "companyId", "companyLineCode");

-- CreateIndex
CREATE INDEX "ConsolidationAdjustment_groupId_status_idx" ON "ConsolidationAdjustment"("groupId", "status");

-- CreateIndex
CREATE INDEX "ConsolidationAdjustment_groupId_startDate_endDate_idx" ON "ConsolidationAdjustment"("groupId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "AdjustmentLine_adjustmentId_idx" ON "AdjustmentLine"("adjustmentId");

-- CreateIndex
CREATE INDEX "AdjustmentLine_groupLineId_idx" ON "AdjustmentLine"("groupLineId");

