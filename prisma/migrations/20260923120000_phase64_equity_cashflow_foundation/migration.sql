-- CreateTable
CREATE TABLE "EquityComponentMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "componentCode" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "updatedById" TEXT,
    "updatedByName" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EquityComponentMapping_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CashFlowStatementLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "activity" TEXT NOT NULL,
    "isAdjustment" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CashFlowMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT,
    "prefix" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "lineId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "note" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "updatedById" TEXT,
    "updatedByName" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CashFlowMapping_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CashFlowMapping_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "CashFlowStatementLine" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CashFlowAccountOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "activity" TEXT NOT NULL,
    "lineId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "updatedById" TEXT,
    "updatedByName" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CashFlowAccountOverride_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CashFlowAccountOverride_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "CashFlowStatementLine" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "EquityComponentMapping_companyId_isActive_idx" ON "EquityComponentMapping"("companyId", "isActive");

-- CreateIndex
CREATE INDEX "EquityComponentMapping_componentCode_idx" ON "EquityComponentMapping"("componentCode");

-- CreateIndex
CREATE UNIQUE INDEX "EquityComponentMapping_companyId_prefix_key" ON "EquityComponentMapping"("companyId", "prefix");

-- CreateIndex
CREATE UNIQUE INDEX "CashFlowStatementLine_code_key" ON "CashFlowStatementLine"("code");

-- CreateIndex
CREATE INDEX "CashFlowStatementLine_activity_displayOrder_idx" ON "CashFlowStatementLine"("activity", "displayOrder");

-- CreateIndex
CREATE INDEX "CashFlowMapping_companyId_isActive_idx" ON "CashFlowMapping"("companyId", "isActive");

-- CreateIndex
CREATE INDEX "CashFlowMapping_prefix_idx" ON "CashFlowMapping"("prefix");

-- CreateIndex
CREATE INDEX "CashFlowMapping_lineId_idx" ON "CashFlowMapping"("lineId");

-- CreateIndex
CREATE UNIQUE INDEX "CashFlowMapping_companyId_prefix_key" ON "CashFlowMapping"("companyId", "prefix");

-- CreateIndex
CREATE INDEX "CashFlowAccountOverride_companyId_isActive_idx" ON "CashFlowAccountOverride"("companyId", "isActive");

-- CreateIndex
CREATE INDEX "CashFlowAccountOverride_accountCode_idx" ON "CashFlowAccountOverride"("accountCode");

-- CreateIndex
CREATE INDEX "CashFlowAccountOverride_lineId_idx" ON "CashFlowAccountOverride"("lineId");

-- CreateIndex
CREATE UNIQUE INDEX "CashFlowAccountOverride_companyId_accountCode_key" ON "CashFlowAccountOverride"("companyId", "accountCode");


-- ── Phase 6.4B — بذور بنود قائمة التدفقات النقدية (مرجع نظامي مرن قابل للتعديل) ──
-- الطريقة غير المباشرة: بادئ قياس الربح + تسويات غير نقدية + حركات رأس المال العامل
-- + ضرائب/فوائد "حسب الربط فقط" + صافي الأقسام الثلاثة + النقد أول/آخر الفترة.
INSERT INTO "CashFlowStatementLine" ("id", "code", "nameAr", "nameEn", "activity", "isAdjustment", "displayOrder", "isActive", "version", "createdAt", "updatedAt") VALUES
  ('cf-op-01', 'CF-OP-NET-PL',           'الربح أو الخسارة للفترة (بادئ قياس القائمة)', 'Profit or loss for the period (starting measure)', 'OPERATING', 0, 1,  1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-10', 'CF-OP-ADJ-DEPRECIATION', 'تسويات: الإهلاك',                              'Adjustments: Depreciation',                        'OPERATING', 1, 10, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-11', 'CF-OP-ADJ-AMORTIZATION', 'تسويات: الاستنفاد',                            'Adjustments: Amortisation',                        'OPERATING', 1, 11, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-12', 'CF-OP-ADJ-IMPAIRMENT',   'تسويات: انخفاض القيمة',                        'Adjustments: Impairment losses',                   'OPERATING', 1, 12, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-13', 'CF-OP-ADJ-PROVISIONS',   'تسويات: المخصصات',                             'Adjustments: Provisions',                          'OPERATING', 1, 13, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-14', 'CF-OP-ADJ-FX-UNREAL',    'تسويات: فروق عملات غير محققة',                 'Adjustments: Unrealised FX differences',           'OPERATING', 1, 14, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-15', 'CF-OP-ADJ-OTHER',        'تسويات غير نقدية أخرى',                        'Other non-cash adjustments',                       'OPERATING', 1, 15, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-20', 'CF-OP-WC-RECEIVABLES',   'تغيرات: الذمم المدينة التجارية وأخرى',        'Changes in trade and other receivables',           'OPERATING', 0, 20, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-21', 'CF-OP-WC-INVENTORY',     'تغيرات: المخزون',                              'Changes in inventories',                           'OPERATING', 0, 21, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-22', 'CF-OP-WC-PREPAYMENTS',   'تغيرات: المدفوعات المقدمة',                    'Changes in prepayments',                           'OPERATING', 0, 22, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-23', 'CF-OP-WC-PAYABLES',      'تغيرات: الذمم الدائنة التجارية وأخرى',        'Changes in trade and other payables',              'OPERATING', 0, 23, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-24', 'CF-OP-WC-ACCRUALS',      'تغيرات: الاستحقاقات والمصاريف المستحقة',      'Changes in accruals',                              'OPERATING', 0, 24, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-25', 'CF-OP-WC-OTHER',         'تغيرات: بنود تشغيلية أخرى',                    'Changes in other operating items',                 'OPERATING', 0, 25, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-30', 'CF-OP-TAXES-PAID',       'الضرائب المدفوعة (حسب الربط)',                 'Income taxes paid (as mapped)',                    'OPERATING', 0, 30, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-31', 'CF-OP-INTEREST-PAID',    'الفوائد المدفوعة (حسب الربط)',                 'Interest paid (as mapped)',                        'OPERATING', 0, 31, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-op-40', 'CF-NET-OPERATING',       'صافي النقد من الأنشطة التشغيلية',              'Net cash from operating activities',               'OPERATING', 0, 40, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-in-10', 'CF-INV-PPE',             'شراء ممتلكات وأصول ملموسة وغير ملموسة',       'Purchases of property and intangible assets',      'INVESTING', 0, 10, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-in-11', 'CF-INV-PPE-DISPOSAL',    'حصائل التصرف في الأصول',                       'Proceeds from disposal of assets',                 'INVESTING', 0, 11, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-in-12', 'CF-INV-INVESTMENTS',     'استحواذ/تصرف استثمارات',                       'Acquisition/disposal of investments',              'INVESTING', 0, 12, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-in-13', 'CF-INV-LOANS',           'قروض وسلف مصنفة استثمارية',                    'Loans and advances classified as investing',       'INVESTING', 0, 13, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-in-14', 'CF-INV-OTHER',           'بنود استثمارية أخرى',                          'Other investing items',                            'INVESTING', 0, 14, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-in-40', 'CF-NET-INVESTING',       'صافي النقد من الأنشطة الاستثمارية',            'Net cash from investing activities',               'INVESTING', 0, 40, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-fi-10', 'CF-FIN-LOANS-RECEIVED',  'قروض محصلة',                                   'Proceeds from loans',                              'FINANCING', 0, 10, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-fi-11', 'CF-FIN-LOANS-REPAID',    'سداد قروض',                                    'Repayment of loans',                               'FINANCING', 0, 11, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-fi-12', 'CF-FIN-LEASE-PRINCIPAL', 'دفعات أصل عقود الإيجار',                       'Lease principal payments',                         'FINANCING', 0, 12, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-fi-13', 'CF-FIN-EQUITY-ISSUE',    'إصدار/زيادة حقوق الملكية',                     'Equity issuance',                                  'FINANCING', 0, 13, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-fi-14', 'CF-FIN-SHARE-BUYBACK',   'إعادة شراء أسهم',                              'Share buy-back',                                   'FINANCING', 0, 14, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-fi-15', 'CF-FIN-DIVIDENDS',       'توزيعات مدفوعة',                               'Dividends paid',                                   'FINANCING', 0, 15, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-fi-16', 'CF-FIN-OTHER',           'بنود تمويلية أخرى',                            'Other financing items',                            'FINANCING', 0, 16, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-fi-40', 'CF-NET-FINANCING',       'صافي النقد من الأنشطة التمويلية',              'Net cash from financing activities',               'FINANCING', 0, 40, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-cash-01', 'CF-NET-CHANGE',        'صافي الزيادة/النقص في النقد وما يعادله',       'Net increase/decrease in cash and cash equivalents', 'CASH_AND_CASH_EQUIVALENTS', 0, 1, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-cash-02', 'CF-OPENING-CASH',      'النقد وما يعادله أول الفترة',                  'Cash and cash equivalents at beginning of period',   'CASH_AND_CASH_EQUIVALENTS', 0, 2, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cf-cash-03', 'CF-CLOSING-CASH',      'النقد وما يعادله آخر الفترة',                  'Cash and cash equivalents at end of period',         'CASH_AND_CASH_EQUIVALENTS', 0, 3, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
