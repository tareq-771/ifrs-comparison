-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "functionalCurrency" TEXT NOT NULL DEFAULT '',
    "reportingCurrency" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "legacyGroupId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FiscalYear" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayNameAr" TEXT NOT NULL DEFAULT '',
    "displayNameEn" TEXT NOT NULL DEFAULT '',
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "periodCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "origin" TEXT NOT NULL DEFAULT 'USER_CREATED',
    "confirmedAt" DATETIME,
    "confirmedByName" TEXT NOT NULL DEFAULT '',
    "closedById" TEXT,
    "closedByName" TEXT NOT NULL DEFAULT '',
    "closedAt" DATETIME,
    "lockedById" TEXT,
    "lockedByName" TEXT NOT NULL DEFAULT '',
    "lockedAt" DATETIME,
    "reopenedById" TEXT,
    "reopenedByName" TEXT NOT NULL DEFAULT '',
    "reopenedAt" DATETIME,
    "reopenReason" TEXT NOT NULL DEFAULT '',
    "unlockReason" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FiscalYear_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FiscalPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fiscalYearId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "zeroActivityDeclared" BOOLEAN NOT NULL DEFAULT false,
    "displayLabel" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FiscalPeriod_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CompanyClosingPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "requiredComponents" TEXT NOT NULL DEFAULT '[]',
    "updatedById" TEXT,
    "updatedByName" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CompanyClosingPolicy_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "label1" TEXT NOT NULL DEFAULT '',
    "label2" TEXT NOT NULL DEFAULT '',
    "compareMode" TEXT NOT NULL DEFAULT 'period',
    "numMonths" INTEGER NOT NULL DEFAULT 12,
    "isSettings" TEXT NOT NULL DEFAULT '{}',
    "bsSettings" TEXT NOT NULL DEFAULT '{}',
    "isFile1Data" TEXT NOT NULL DEFAULT '[]',
    "isFile2Data" TEXT NOT NULL DEFAULT '[]',
    "isFile1Headers" TEXT NOT NULL DEFAULT '[]',
    "isFile2Headers" TEXT NOT NULL DEFAULT '[]',
    "isFile1Cols" TEXT NOT NULL DEFAULT '{}',
    "isFile2Cols" TEXT NOT NULL DEFAULT '{}',
    "bsFileData" TEXT NOT NULL DEFAULT '[]',
    "bsFileHeaders" TEXT NOT NULL DEFAULT '[]',
    "bsFileCols" TEXT NOT NULL DEFAULT '{}',
    "bsFile2Data" TEXT NOT NULL DEFAULT '[]',
    "bsFile2Headers" TEXT NOT NULL DEFAULT '[]',
    "bsFile2Cols" TEXT NOT NULL DEFAULT '{}',
    "companyId" TEXT,
    "fiscalPeriodId" TEXT,
    "backfillStatus" TEXT,
    "groupId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "periodEnd" TEXT,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "dueDate" TEXT,
    "preparedById" TEXT,
    "preparedByName" TEXT NOT NULL DEFAULT '',
    "preparedAt" DATETIME,
    "reviewedById" TEXT,
    "reviewedByName" TEXT NOT NULL DEFAULT '',
    "reviewStartedAt" DATETIME,
    "reviewedAt" DATETIME,
    "approvedById" TEXT,
    "approvedByName" TEXT NOT NULL DEFAULT '',
    "approvedAt" DATETIME,
    "returnedById" TEXT,
    "returnedByName" TEXT NOT NULL DEFAULT '',
    "returnedAt" DATETIME,
    "returnReason" TEXT NOT NULL DEFAULT '',
    "reopenedById" TEXT,
    "reopenedByName" TEXT NOT NULL DEFAULT '',
    "reopenedAt" DATETIME,
    "reopenReason" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Report_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Report_fiscalPeriodId_fkey" FOREIGN KEY ("fiscalPeriodId") REFERENCES "FiscalPeriod" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Report_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Report_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Report" ("approvedAt", "approvedById", "approvedByName", "bsFile2Cols", "bsFile2Data", "bsFile2Headers", "bsFileCols", "bsFileData", "bsFileHeaders", "bsSettings", "compareMode", "createdAt", "cycle", "dueDate", "groupId", "id", "isFile1Cols", "isFile1Data", "isFile1Headers", "isFile2Cols", "isFile2Data", "isFile2Headers", "isSettings", "label1", "label2", "name", "numMonths", "periodEnd", "preparedAt", "preparedById", "preparedByName", "reopenReason", "reopenedAt", "reopenedById", "reopenedByName", "returnReason", "returnedAt", "returnedById", "returnedByName", "reviewStartedAt", "reviewedAt", "reviewedById", "reviewedByName", "status", "updatedAt", "userId", "version") SELECT "approvedAt", "approvedById", "approvedByName", "bsFile2Cols", "bsFile2Data", "bsFile2Headers", "bsFileCols", "bsFileData", "bsFileHeaders", "bsSettings", "compareMode", "createdAt", "cycle", "dueDate", "groupId", "id", "isFile1Cols", "isFile1Data", "isFile1Headers", "isFile2Cols", "isFile2Data", "isFile2Headers", "isSettings", "label1", "label2", "name", "numMonths", "periodEnd", "preparedAt", "preparedById", "preparedByName", "reopenReason", "reopenedAt", "reopenedById", "reopenedByName", "returnReason", "returnedAt", "returnedById", "returnedByName", "reviewStartedAt", "reviewedAt", "reviewedById", "reviewedByName", "status", "updatedAt", "userId", "version" FROM "Report";
DROP TABLE "Report";
ALTER TABLE "new_Report" RENAME TO "Report";
CREATE INDEX "Report_status_idx" ON "Report"("status");
CREATE INDEX "Report_preparedById_idx" ON "Report"("preparedById");
CREATE INDEX "Report_reviewedById_idx" ON "Report"("reviewedById");
CREATE INDEX "Report_approvedById_idx" ON "Report"("approvedById");
CREATE INDEX "Report_periodEnd_idx" ON "Report"("periodEnd");
CREATE INDEX "Report_dueDate_idx" ON "Report"("dueDate");
CREATE INDEX "Report_updatedAt_idx" ON "Report"("updatedAt");
CREATE INDEX "Report_cycle_idx" ON "Report"("cycle");
CREATE INDEX "Report_groupId_status_idx" ON "Report"("groupId", "status");
CREATE INDEX "Report_companyId_idx" ON "Report"("companyId");
CREATE INDEX "Report_fiscalPeriodId_idx" ON "Report"("fiscalPeriodId");
CREATE INDEX "Report_backfillStatus_idx" ON "Report"("backfillStatus");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Company_code_key" ON "Company"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Company_legacyGroupId_key" ON "Company"("legacyGroupId");

-- CreateIndex
CREATE INDEX "Company_status_idx" ON "Company"("status");

-- CreateIndex
CREATE INDEX "Company_legacyGroupId_idx" ON "Company"("legacyGroupId");

-- CreateIndex
CREATE INDEX "FiscalYear_companyId_startDate_idx" ON "FiscalYear"("companyId", "startDate");

-- CreateIndex
CREATE INDEX "FiscalYear_status_idx" ON "FiscalYear"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalYear_companyId_code_key" ON "FiscalYear"("companyId", "code");

-- CreateIndex
CREATE INDEX "FiscalPeriod_fiscalYearId_idx" ON "FiscalPeriod"("fiscalYearId");

-- CreateIndex
CREATE INDEX "FiscalPeriod_startDate_endDate_idx" ON "FiscalPeriod"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "FiscalPeriod_status_idx" ON "FiscalPeriod"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalPeriod_fiscalYearId_ordinal_key" ON "FiscalPeriod"("fiscalYearId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyClosingPolicy_companyId_key" ON "CompanyClosingPolicy"("companyId");
