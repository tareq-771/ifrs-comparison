-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "budgetType" TEXT NOT NULL,
    "scenario" TEXT NOT NULL DEFAULT 'BASE',
    "name" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "revisionReason" TEXT NOT NULL DEFAULT '',
    "supersedesBudgetId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "updatedById" TEXT,
    "updatedByName" TEXT NOT NULL DEFAULT '',
    "submittedById" TEXT,
    "submittedByName" TEXT NOT NULL DEFAULT '',
    "submittedAt" DATETIME,
    "approvedById" TEXT,
    "approvedByName" TEXT NOT NULL DEFAULT '',
    "approvedAt" DATETIME,
    "lockedById" TEXT,
    "lockedByName" TEXT NOT NULL DEFAULT '',
    "lockedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startOrdinal" INTEGER NOT NULL DEFAULT 1,
    "endOrdinal" INTEGER NOT NULL DEFAULT 12,
    CONSTRAINT "Budget_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Budget_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Budget_supersedesBudgetId_fkey" FOREIGN KEY ("supersedesBudgetId") REFERENCES "Budget" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BudgetLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "budgetId" TEXT NOT NULL,
    "statementLineCode" TEXT NOT NULL,
    "fiscalPeriodId" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "BudgetLine_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Budget_companyId_fiscalYearId_status_idx" ON "Budget"("companyId", "fiscalYearId", "status");

-- CreateIndex
CREATE INDEX "Budget_status_idx" ON "Budget"("status");

-- CreateIndex
CREATE INDEX "Budget_supersedesBudgetId_idx" ON "Budget"("supersedesBudgetId");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_companyId_fiscalYearId_versionNumber_scenario_key" ON "Budget"("companyId", "fiscalYearId", "versionNumber", "scenario");

-- CreateIndex
CREATE INDEX "BudgetLine_budgetId_idx" ON "BudgetLine"("budgetId");

-- CreateIndex
CREATE INDEX "BudgetLine_statementLineCode_idx" ON "BudgetLine"("statementLineCode");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLine_budgetId_statementLineCode_fiscalPeriodId_key" ON "BudgetLine"("budgetId", "statementLineCode", "fiscalPeriodId");

