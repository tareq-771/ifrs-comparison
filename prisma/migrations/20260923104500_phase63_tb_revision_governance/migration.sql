-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TrialBalanceImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "toDate" TEXT NOT NULL,
    "startOrdinal" INTEGER NOT NULL,
    "endOrdinal" INTEGER NOT NULL,
    "dataType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "revisionNumber" INTEGER NOT NULL DEFAULT 1,
    "supersedesImportId" TEXT,
    "revisionReason" TEXT NOT NULL DEFAULT '',
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
    CONSTRAINT "TrialBalanceImport_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrialBalanceImport_supersedesImportId_fkey" FOREIGN KEY ("supersedesImportId") REFERENCES "TrialBalanceImport" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_TrialBalanceImport" ("committedAt", "committedById", "committedByName", "companyId", "createdAt", "createdById", "createdByName", "dataType", "endOrdinal", "fileHash", "fiscalYearId", "fromDate", "id", "lineCount", "note", "originalFileName", "payloadHash", "startOrdinal", "status", "toDate", "totalCreditMinor", "totalDebitMinor", "updatedAt", "updatedById", "updatedByName", "version") SELECT "committedAt", "committedById", "committedByName", "companyId", "createdAt", "createdById", "createdByName", "dataType", "endOrdinal", "fileHash", "fiscalYearId", "fromDate", "id", "lineCount", "note", "originalFileName", "payloadHash", "startOrdinal", "status", "toDate", "totalCreditMinor", "totalDebitMinor", "updatedAt", "updatedById", "updatedByName", "version" FROM "TrialBalanceImport";
DROP TABLE "TrialBalanceImport";
ALTER TABLE "new_TrialBalanceImport" RENAME TO "TrialBalanceImport";
CREATE INDEX "TrialBalanceImport_companyId_idx" ON "TrialBalanceImport"("companyId");
CREATE INDEX "TrialBalanceImport_fiscalYearId_idx" ON "TrialBalanceImport"("fiscalYearId");
CREATE INDEX "TrialBalanceImport_companyId_status_revisionNumber_idx" ON "TrialBalanceImport"("companyId", "status", "revisionNumber");
CREATE INDEX "TrialBalanceImport_supersedesImportId_idx" ON "TrialBalanceImport"("supersedesImportId");
CREATE UNIQUE INDEX "TrialBalanceImport_companyId_fiscalYearId_fromDate_toDate_dataType_revisionNumber_key" ON "TrialBalanceImport"("companyId", "fiscalYearId", "fromDate", "toDate", "dataType", "revisionNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

