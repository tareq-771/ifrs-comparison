-- Phase 6.2A — دليل الحسابات وقواعد التصنيف (Foundation النهائي — مراجعة القرار المعتمد)
-- إضافة حصرية (additive-only): 3 جداول جديدة + فهارسها + seed نظامي مراجَع.
-- لا DROP ولا RENAME ولا تعديل أي جدول قائم من 6.1 — لا فقدان بيانات ممكن.
--
-- مستويا التصنيف المعتمدان:
--   LEVEL 1: جذور نظامية ثابتة 1/2/3/4 حصرًا (companyId=NULL، source=SYSTEM):
--     1 = ASSETS / BALANCE ، 2 = LIABILITIES_EQUITY / BALANCE (classification=NULL —
--     الجذر مركّب والفصل LIABILITY/EQUITY عبر بادئات الشركة التفصيلية 21/23…)،
--     3 = EXPENSES / FLOW ، 4 = REVENUE / FLOW.
--     لا جذور نظامية 5/6/7 في المحرك الجديد — تبقى في accounts.ts المجمد للتوافق
--     مع التقارير القديمة حصرًا ولا تُستخدم كقواعد مالية عالمية.
--   LEVEL 2: بادئات تفصيلية لكل شركة (MANUAL) — لا seed عام لها إطلاقًا.
--
-- بنود القوائم المالية (FinancialStatementLine): مرجع نظامي هرمي مبدئي قابل
-- للربط — بناء القوائم نفسه ليس في هذه المرحلة إطلاقًا.

-- CreateTable
CREATE TABLE "FinancialStatementLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT,
    "statementType" TEXT NOT NULL,
    "parentId" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isSubtotal" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FinancialStatementLine_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "FinancialStatementLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialStatementLine_code_key" ON "FinancialStatementLine"("code");

-- CreateIndex
CREATE INDEX "FinancialStatementLine_statementType_displayOrder_idx" ON "FinancialStatementLine"("statementType", "displayOrder");

-- CreateIndex
CREATE INDEX "FinancialStatementLine_parentId_idx" ON "FinancialStatementLine"("parentId");

-- CreateTable
CREATE TABLE "AccountNatureRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT,
    "prefix" TEXT NOT NULL,
    "mainCategory" TEXT,
    "classification" TEXT,
    "aggregationBehavior" TEXT NOT NULL,
    "statementLineId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'SYSTEM',
    "note" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "updatedById" TEXT,
    "updatedByName" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccountNatureRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountNatureRule_statementLineId_fkey" FOREIGN KEY ("statementLineId") REFERENCES "FinancialStatementLine" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
-- فهرس التفرد المركب (companyId, prefix) — يغطي بادئات الشركات (companyId غير null).
CREATE UNIQUE INDEX "AccountNatureRule_companyId_prefix_key" ON "AccountNatureRule"("companyId", "prefix");

-- CreateIndex (partial unique)
-- تكملة التفرد للجذور النظامية: SQLite يعتبر NULLs مميزة داخل الفهارس المركبة،
-- وهذا الفهرس الجزئي يمنع تكرار نفس prefix بين الجذور النظامية (companyId IS NULL).
CREATE UNIQUE INDEX "AccountNatureRule_system_prefix_key" ON "AccountNatureRule"("prefix") WHERE "companyId" IS NULL;

-- CreateIndex
CREATE INDEX "AccountNatureRule_companyId_isActive_idx" ON "AccountNatureRule"("companyId", "isActive");

-- CreateIndex
CREATE INDEX "AccountNatureRule_prefix_idx" ON "AccountNatureRule"("prefix");

-- CreateIndex
CREATE INDEX "AccountNatureRule_statementLineId_idx" ON "AccountNatureRule"("statementLineId");

-- CreateTable
CREATE TABLE "AccountMappingOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "accountCode" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "aggregationBehavior" TEXT NOT NULL,
    "statementLineId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "updatedById" TEXT,
    "updatedByName" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccountMappingOverride_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AccountMappingOverride_statementLineId_fkey" FOREIGN KEY ("statementLineId") REFERENCES "FinancialStatementLine" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountMappingOverride_companyId_accountCode_key" ON "AccountMappingOverride"("companyId", "accountCode");

-- CreateIndex
CREATE INDEX "AccountMappingOverride_companyId_isActive_idx" ON "AccountMappingOverride"("companyId", "isActive");

-- CreateIndex
CREATE INDEX "AccountMappingOverride_accountCode_idx" ON "AccountMappingOverride"("accountCode");

-- CreateIndex
CREATE INDEX "AccountMappingOverride_statementLineId_idx" ON "AccountMappingOverride"("statementLineId");

-- ── Seed نظامي 1: بنود القوائم المالية المرجعية (مرجع أساس قابل للربط) ──────
-- مجموعة بداية قياسية صغيرة (مجموعات + أوراق) تُظهر الهرمية وتكفي لربط
-- البادئات التفصيلية. ليست قوائم مُصدرة — الإدارة الكاملة للبنود لاحقًا.
INSERT INTO "FinancialStatementLine" ("id", "code", "nameAr", "nameEn", "statementType", "parentId", "displayOrder", "isSubtotal", "isActive", "version", "createdAt", "updatedAt") VALUES
  -- قائمة المركز المالي: مجموعات
  ('fsl-sfp-nca',      'SFP-ASSET-NCA',   'الأصول غير المتداولة',              'Non-current Assets',                    'STATEMENT_OF_FINANCIAL_POSITION', NULL,            1, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-ca',       'SFP-ASSET-CA',    'الأصول المتداولة',                  'Current Assets',                        'STATEMENT_OF_FINANCIAL_POSITION', NULL,            2, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-ncl',      'SFP-LIA-NCL',     'الالتزامات غير المتداولة',          'Non-current Liabilities',               'STATEMENT_OF_FINANCIAL_POSITION', NULL,            3, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-cl',       'SFP-LIA-CL',      'الالتزامات المتداولة',              'Current Liabilities',                   'STATEMENT_OF_FINANCIAL_POSITION', NULL,            4, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-eq',       'SFP-EQUITY',      'حقوق الملكية',                      'Equity',                                'STATEMENT_OF_FINANCIAL_POSITION', NULL,            5, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- قائمة المركز المالي: أوراق غير متداولة
  ('fsl-sfp-ppe',      'SFP-PPE',         'الممتلكات والآلات والمعدات',        'Property, Plant and Equipment',         'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-nca',   1, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-intang',   'SFP-INTANGIBLE',  'الأصول غير الملموسة',               'Intangible Assets',                     'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-nca',   2, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-lt-inv',   'SFP-LT-INVEST',   'استثمارات طويلة الأجل',             'Long-term Investments',                 'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-nca',   3, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- قائمة المركز المالي: أوراق متداولة
  ('fsl-sfp-cash',     'SFP-CASH',        'النقدية وما في حكمها',              'Cash and Cash Equivalents',             'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-ca',    1, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-receiv',   'SFP-RECEIVABLES', 'الذمم المدينة والمستحقات',          'Trade and Other Receivables',           'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-ca',    2, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-invent',   'SFP-INVENTORY',   'المخزون',                           'Inventories',                           'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-ca',    3, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-st-inv',   'SFP-ST-INVEST',   'استثمارات قصيرة الأجل',             'Short-term Investments',                'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-ca',    4, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-prepaid',  'SFP-PREPAID',     'مصروفات مدفوعة مقدماً',             'Prepaid Expenses',                      'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-ca',    5, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- قائمة المركز المالي: التزامات غير متداولة
  ('fsl-sfp-lt-loans', 'SFP-LT-LOANS',    'قروض طويلة الأجل',                  'Long-term Borrowings',                  'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-ncl',   1, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-eos',      'SFP-EOS-BENEFIT', 'مخصصات نهاية الخدمة',               'End-of-Service Benefits Obligation',    'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-ncl',   2, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- قائمة المركز المالي: التزامات متداولة
  ('fsl-sfp-payab',    'SFP-PAYABLES',    'الدائنون والمستحقات',               'Trade and Other Payables',              'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-cl',    1, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-st-loans', 'SFP-ST-LOANS',    'قروض قصيرة الأجل',                  'Short-term Borrowings',                 'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-cl',    2, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-accrued',  'SFP-ACCRUED',     'مصروفات مستحقة',                    'Accrued Expenses',                      'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-cl',    3, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-tax-pay',  'SFP-TAX-PAYABLE', 'ضرائب مستحقة',                      'Taxes Payable',                         'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-cl',    4, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- قائمة المركز المالي: حقوق الملكية
  ('fsl-sfp-capital',  'SFP-CAPITAL',     'رأس المال',                         'Share Capital',                         'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-eq',    1, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-reserves', 'SFP-RESERVES',    'الاحتياطيات',                       'Reserves',                              'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-eq',    2, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-sfp-retained', 'SFP-RETAINED',    'الأرباح المحتجزة',                  'Retained Earnings',                     'STATEMENT_OF_FINANCIAL_POSITION', 'fsl-sfp-eq',    3, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- قائمة الربح أو الخسارة (أوراق مسطحة)
  ('fsl-pnl-revenue',  'PNL-REVENUE',         'إيرادات النشاط الرئيسي',        'Revenue from Ordinary Activities',      'PROFIT_OR_LOSS', NULL, 1, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-pnl-otherinc', 'PNL-OTHER-INCOME',    'إيرادات أخرى',                  'Other Income',                          'PROFIT_OR_LOSS', NULL, 2, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-pnl-cos',      'PNL-COST-OF-SALES',   'تكلفة المبيعات',                'Cost of Sales',                         'PROFIT_OR_LOSS', NULL, 3, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-pnl-admin',    'PNL-ADMIN-EXPENSES',  'مصروفات إدارية وعمومية',        'General and Administrative Expenses',   'PROFIT_OR_LOSS', NULL, 4, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-pnl-selling',  'PNL-SELLING-EXPENSES','مصروفات البيع والتوزيع',        'Selling and Distribution Expenses',     'PROFIT_OR_LOSS', NULL, 5, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-pnl-finance',  'PNL-FINANCE-COSTS',   'تكاليف التمويل',                'Finance Costs',                         'PROFIT_OR_LOSS', NULL, 6, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-pnl-otherexp', 'PNL-OTHER-EXPENSES',  'مصروفات أخرى',                  'Other Expenses',                        'PROFIT_OR_LOSS', NULL, 7, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-pnl-tax',      'PNL-INCOME-TAX',      'مصروف ضريبة الدخل',             'Income Tax Expense',                    'PROFIT_OR_LOSS', NULL, 8, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  -- الدخل الشامل الآخر
  ('fsl-oci-reval',    'OCI-REVALUATION',     'فائض إعادة التقييم',            'Revaluation Surplus',                   'OTHER_COMPREHENSIVE_INCOME', NULL, 1, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('fsl-oci-fx',       'OCI-FX-DIFFERENCES',  'فروق التحويل للعملات الأجنبية', 'Exchange Differences on Translation',   'OTHER_COMPREHENSIVE_INCOME', NULL, 2, false, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- ── Seed نظامي 2: الجذور الرئيسية الثابتة 1/2/3/4 (قرار المستخدم النهائي) ────
-- mainCategory منفصل عن classification: الجذر 2 مركّب (LIABILITIES_EQUITY) —
-- classification=NULL عمدًا، والفصل LIABILITY/EQUITY عبر بادئات الشركة (21/23…).
-- الفصل داخل الجذر 1 محسوم (ASSET) لكن بند القائمة يبقى للبادئات التفصيلية —
-- الجذر وحده لا يصدر بندًا ماليًا (110999 ⇒ ROOT_ONLY لا تخمين Cash/Receivable).
-- الحسابات خارج 1-4: لا قاعدة ⇒ NEEDS_CLASSIFICATION (فشل واضح لا رقم مضلل).
INSERT INTO "AccountNatureRule" ("id", "companyId", "prefix", "mainCategory", "classification", "aggregationBehavior", "statementLineId", "source", "note", "isActive", "version", "createdByName", "updatedByName", "createdAt", "updatedAt") VALUES
  ('anr-sys-01', NULL, '1', 'ASSETS',             'ASSET',   'BALANCE', NULL, 'SYSTEM', 'جذر نظامي ثابت: 1 = الأصول (ASSETS) — BALANCE. الفصل التفصيلي (نقدية/ذمم/مخزون…) عبر بادئات كل شركة', true, 1, 'system-seed', 'system-seed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('anr-sys-02', NULL, '2', 'LIABILITIES_EQUITY', NULL,      'BALANCE', NULL, 'SYSTEM', 'جذر نظامي ثابت: 2 = الخصوم وحقوق الملكية (LIABILITIES AND EQUITY) — BALANCE. الفصل LIABILITY/EQUITY عبر بادئات كل شركة (21/23 أمثلة لا قواعد عامة)', true, 1, 'system-seed', 'system-seed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('anr-sys-03', NULL, '3', 'EXPENSES',           'EXPENSE', 'FLOW',    NULL, 'SYSTEM', 'جذر نظامي ثابت: 3 = المصروفات (EXPENSES) — FLOW. (الدليل المجمد القديم اعتبر 3 مصروفات — per user request — وهذا القرار يبقى كما هو)', true, 1, 'system-seed', 'system-seed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('anr-sys-04', NULL, '4', 'REVENUE',            'REVENUE', 'FLOW',    NULL, 'SYSTEM', 'جذر نظامي ثابت: 4 = الإيرادات (REVENUE) — FLOW. البادئات القديمة 5/6/7 ليست قواعد نظامية في المحرك الجديد', true, 1, 'system-seed', 'system-seed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
