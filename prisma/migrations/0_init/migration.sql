-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT 'user',
    "permissions" TEXT NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "Group_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Report" (
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
    CONSTRAINT "Report_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Report_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL DEFAULT '',
    "toStatus" TEXT NOT NULL DEFAULT '',
    "actorId" TEXT,
    "actorUsername" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "comment" TEXT NOT NULL DEFAULT '',
    "roleSnapshot" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "username" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "beforeData" TEXT NOT NULL DEFAULT '{}',
    "afterData" TEXT NOT NULL DEFAULT '{}',
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "ipAddress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "Report_status_idx" ON "Report"("status");

-- CreateIndex
CREATE INDEX "Report_preparedById_idx" ON "Report"("preparedById");

-- CreateIndex
CREATE INDEX "Report_reviewedById_idx" ON "Report"("reviewedById");

-- CreateIndex
CREATE INDEX "Report_approvedById_idx" ON "Report"("approvedById");

-- CreateIndex
CREATE INDEX "Report_periodEnd_idx" ON "Report"("periodEnd");

-- CreateIndex
CREATE INDEX "Report_dueDate_idx" ON "Report"("dueDate");

-- CreateIndex
CREATE INDEX "Report_updatedAt_idx" ON "Report"("updatedAt");

-- CreateIndex
CREATE INDEX "Report_cycle_idx" ON "Report"("cycle");

-- CreateIndex
CREATE INDEX "Report_groupId_status_idx" ON "Report"("groupId", "status");

-- CreateIndex
CREATE INDEX "WorkflowHistory_reportId_createdAt_idx" ON "WorkflowHistory"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowHistory_reportId_cycle_idx" ON "WorkflowHistory"("reportId", "cycle");

-- CreateIndex
CREATE INDEX "WorkflowHistory_action_idx" ON "WorkflowHistory"("action");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_idx" ON "AuditLog"("entityType");

-- CreateIndex
CREATE INDEX "AuditLog_entityId_idx" ON "AuditLog"("entityId");

