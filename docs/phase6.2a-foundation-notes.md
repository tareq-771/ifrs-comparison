# Phase 6.2A — توثيق الأساس: دليل الحسابات وقواعد التصنيف (التصميم النهائي المعتمد)

> هذه الوثائق مرجع التنفيذ لما بُني في 6.2A وما هو ممهل لـ 6.2B. القرارات هنا
> معتمدة من المستخدم ولا تُعاد مناقشتها دون قرار جديد.

## 1. الجذور النظامية الثابتة (LEVEL 1 — للقراءة فقط)

| الجذر | MainCategory        | Classification | السلوك  | ملاحظة |
|------|---------------------|----------------|---------|--------|
| 1    | ASSETS              | ASSET          | BALANCE | الفصل التفصيلي (نقدية/ذمم/مخزون…) عبر بادئات كل شركة |
| 2    | LIABILITIES_EQUITY  | **NULL** عمدًا | BALANCE | الجذر مركّب — الفصل LIABILITY/EQUITY عبر بادئات الشركة (21/23 أمثلة) |
| 3    | EXPENSES            | EXPENSE        | FLOW    | الدليل المجمد القديم اعتبر 3 مصروفات (per user request) — القرار باقٍ |
| 4    | REVENUE             | REVENUE        | FLOW    | |

- **لا جذور نظامية 5/6/7 في المحرك الجديد** — تبقى في `src/lib/accounts.ts`
  المجمدة للتوافق مع التقارير القديمة حصرًا (client-side فقط، لا تُلمس).
- الجذور seed نظامي داخل migration `20260922210011_phase62a_account_nature` —
  لا إنشاء/تعديل/حذف عبر أي API (`SYSTEM_IMMUTABLE`).
- `mainCategory` يأتي من الجذور النظامية **حصرًا** — بادئة شركة لا تولّده أبدًا
  (fail-closed: كود لا يبدأ بـ 1-4 ⇒ NEEDS_CLASSIFICATION حتى لو وُجدت له بادئة شركة).

## 2. البادئات التفصيلية لكل شركة (LEVEL 2)

- تُعدّ **مرة واحدة لكل Company** وتُعاد استخدامها تلقائيًا في كل الفترات والسنوات —
  لا يُطلب إدخالها عند كل رفع ميزان مراجعة.
- **لا seed عام لها إطلاقًا** (11/1101/21/2101… أمثلة توضيحية فقط، لكل شركة دليلها).
- الحل بأطول بادئة مطابقة (startsWith): `11010105 ⇒ 1101` مع هرمية حقيقية 1/11/1101.
- كل بادئة شركة تحمل: classification (إلزامي) + aggregationBehavior (إلزامي) +
  statementLine (اختياري) + note — البادئة نفسها لا تتغير بعد الإنشاء (حذف/إنشاء جديد).
- فهرس تفرد مركب `(companyId, prefix)` + فهرس جزئي للجذور النظامية.

## 3. أولوية الحل (resolveAccountMapping)

```
1) Account-specific Override (استثناء حساب كامل محدد — يفوز على كل شيء)
2) أطول بادئة تفصيلية للشركة
3) الجذر النظامي 1/2/3/4
4) NEEDS_DETAILED_CLASSIFICATION — الجذر مطابق والتصنيف غير محسوم (الجذر «2» فقط)
5) NEEDS_CLASSIFICATION — الجذر الرئيسي نفسه لم ينطبق (أكواد خارج 1-4)
```

### حالات الحل (mappingStatus) — دلالة الاكتمال

| الحالة | المعنى | القائمة النهائية؟ |
|--------|--------|-------------------|
| `FULLY_MAPPED` | التصنيف + السلوك + بند القائمة كلها محسومة | نعم |
| `ROOT_ONLY` | mainCategory/التصنيف/السلوك معلومة لكن **لا بند مالي** (جذر وحده أو بادئة بلا بند) | **لا** — يحتاج بندًا |
| `NEEDS_DETAILED_CLASSIFICATION` | الجذر «2» بلا بادئة شركة تفصيلية تحسم LIABILITY/EQUITY | لا |
| `NEEDS_CLASSIFICATION` | لا تطابق إطلاقًا | لا |

- **الجذر النظامي لا يصدر بندًا ماليًا أبدًا**: `110999` ⇒ نعلم ASSET/BALANCE
  ولا نخمّن Cash/Receivable/Inventory (ROOT_ONLY).
- كود بند غير موجود/غير نشط في المرجع ⇒ لا بند (لا FULLY_MAPPED بصمت).
- البند المالي يُقبل فقط من Override أو بادئة الشركة.

## 4. حاجز الاتساق (statement line ↔ classification)

- ASSET/LIABILITY ⇒ `STATEMENT_OF_FINANCIAL_POSITION` حصرًا.
- EQUITY ⇒ المركز المالي أو `OTHER_COMPREHENSIVE_INCOME` (إعادة تقييم).
- REVENUE/EXPENSE ⇒ `PROFIT_OR_LOSS` أو الدخل الشامل الآخر.
- OTHER ⇒ بلا قيد.
- يُطبَّق خادميًا عند الحفظ (`STATEMENT_LINE_MISMATCH`) ومُعاد في الواجهة للفلترة.

## 5. بنود القوائم المالية (FinancialStatementLine) — مرجع فقط

- 32 بندًا seed نظامي هرمي (5 مجموعات تحت المركز المالي + أوراق + P&L + OCI).
- `code` هوية وحيدة؛ `parentId` هرمية (Restrict)؛ `isSubtotal` لمجاميع مستقبلية.
- **بناء القوائم المالية نفسه ليس في 6.2A** — الإدارة الكاملة للبنود (إنشاء/تعديل)
  مرحلة لاحقة؛ اليوم مرجع قراءة فقط.

## 6. الاستثناءات (AccountMappingOverride)

- لكل شركة: `(companyId, accountCode)` وحيد — كود الحساب الكامل لا بادئة.
- أولويته حاكمة (مُختبرة): بادئة 31 ⇒ تكلفة مبيعات، لكن 310199 باستثناء
  «مصروفات إدارية» ⇒ الاستثناء يفوز.
- نفس عقود الحوكمة: optimistic locking + تدقيق before/after/reason.

## 7. نسخ الخريطة (Copy Chart Mapping)

- `POST /api/account-nature/copy` { fromCompanyId, toCompanyId, replaceExisting?, reason? }.
- معاملة واحدة: استبدال (صريح فقط) + نسخ البادئات والاستثناءات — **النسخة مستقلة
  تمامًا** بعد الإنشاء (تعديل المصدر لا يمس الهدف — مُختبر).
- رفض النسخ إلى نفس الشركة / من شركة بلا إعداد / على هدف قائم بلا استبدال.
- لا واجهة مستخدم للنسخ بعد (زر النسخ موجود في التبويب ويعمل) — التوثيق أعلاه كافٍ لـ 6.2B.

## 8. الطبقة الحسابية المركزية (unchanged من 6.2A الأولى)

- `src/lib/temporal-aggregation.ts`: `aggregateYTD` (FLOW=Σ من أول فترة،
  BALANCE=رصيد وقف) / `aggregateForPeriod` / `getAsOfBalance` / جسور
  تراكمي⇄حركات / `reconcileBalanceMovements` (closing = opening + Σ — لا اختراع افتتاح).
- `requireBehavior` يقبول ROOT_ONLY/FULLY_MAPPED ويُسقط NEEDS_* — الجسر من
  الحل إلى الحساب.

## 9. جاهزية 6.2B — رفع ميزان المراجعة (تصميم، لا تنفيذ)

شاشة الرفع المخططة: Company + From Date + To Date + **Trial Balance Data Type**
(`CUMULATIVE_YTD` | `PERIOD_MOVEMENT`) + ملف Excel. بعد الرفع يمر كل كود عبر
`resolveCodesForCompany` (نفس الحل الخادمي المركزي) ثم تُعرض مجموعات:
مصنّفة بالكامل / تحتاج تصنيفًا تفصيليًا (ROOT_ONLY + NEEDS_DETAILED) / غير مصنفة —
**ولا تُصدر قائمة مالية ناقصة بصمت**.

### فجوات موثقة لـ 6.2B (من 6.2A)
1. لا نموذج تخزين Actual بعد (القرار (أ): تخزين TB تراكمي — الجسور جاهزة).
2. ربط الطبقة النقية بالـ persisted actuals.
3. Opening balance بلا بنية تخزين (الدالة موجودة، التخزين لا).
4. صلاحية قراءة أوسع للحل عند استهلاكه تقاريريًا (اليوم خلف manageAccountNature).
5. إدارة بنود القوائم المالية (إنشاء/تعديل) + ربط isSubtotal.
6. لن يُتجاوز حراس CLOSED/LOCKED عند تعديل metadata مالية مستقبلًا.

## 10. متطلب مستقبلي موثق — عنوان الخادم (Server Address)

إعداد اتصال يسمح بـ: عنوان خادم افتراضي / عنوان مخصص (Hostname/DNS أو IP محجوز) /
Test Connection / حفظ محلي / استعادة الافتراضي — **دون كشف سلسلة اتصال قاعدة
البيانات للمستخدم إطلاقًا**. لا تعديل شبكة/deployment في 6.2A.

## 11. جاهزية التوحيد (Consolidation-ready — معماريًا فقط)

- التصميم لا يفترض أن الشركات تتشارك Account Codes: كل الخرائط داخل
  `(companyId, …)` — الشركة A: 4101 = Sales والشركة B: 70101 = Sales يمكن
  لاحقًا ربطهما بنفس Group Reporting Line (Revenue) عبر خرائط تقارير جماعية.
- الجداول المستقبلية المتوقعة (لا تُنشأ اليوم): ConsolidationGroup /
  GroupCompanyMembership / GroupReportingMapping / Intercompany Balances &
  Transactions / Consolidation Adjustments / Elimination Entries / Ownership % /
  NCI / Currency Translation.
- لا يوجد أي حقل or قدرة توحيد منفذة في 6.2A — جاهزية معمارية حصرًا.

## 12. Cash Flow (IAS 7)

- **ممنوع** استنتاج IAS 7 من البادئات — سيكون لدينا Cash Flow Mapping مستقل لاحقًا
  (خارطة خطة 6.4: docs/phase6.4-ias7-cashflow-roadmap.md). لا تنفيذ اليوم.
