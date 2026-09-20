# تصميم المرحلة 3 — دورة الاعتماد وفصل المهام (Workflow & Segregation of Duties)

> **حالة الوثيقة: مقترح بانتظار موافقة المستخدم — لم يُنفَّذ أي جزء منها بعد.**
> لا تعديل على Schema ولا على الكود قبل الموافقة. لا يمس هذا التصميم `accounts.ts` ولا خوارزمية المطابقة إطلاقًا.

---

## 0. الأساس الواقعي الحالي (ما بُني في المراحل 0–2)

- `Report` يحمل `version Int @default(1)` والتحديث عبر `PUT ... WHERE id=? AND version=?` ذري، والتعارض يُرجع `409 VERSION_CONFLICT` structured.
- `AuditLog` append-only بلا FK مع `username` snapshot، ويُكتب في نفس معاملة كل تعديل.
- صلاحيات النظام الحالية على User (JSON): `view, add, edit, delete, groups, export, settings, manageUsers, groupIds[]`.
- **الكتابة التعاونية الحالية (المرحلة 2)**: `PUT` مسموح للمالك **أو** عضو مجموعة مرتبطة (`groupIds`) — هذا هو ما سيُعدَّل في هذه المرحلة (القسم 7).
- `GET /api/users` للمدير حصرًا (يؤثر على تصميم واجهة الإسناد — القسم 3).

---

## 1. الحقول الجديدة في Report (الدورة الحالية فقط)

تُضاف 20 عمودًا، كلها `nullable` أو بقيَم افتراضية → `ALTER TABLE ADD COLUMN` آمن بلا أي فقد بيانات ومتوافق مع PostgreSQL مستقبلًا:

```prisma
// ── Workflow & Governance (المرحلة 3) — تمثل دورة الاعتماد الحالية فقط ──
status          String    @default("DRAFT")   // DRAFT | SUBMITTED | UNDER_REVIEW | RETURNED | APPROVED | REOPENED
periodEnd       DateTime?                     // نهاية الفترة المالية (اختياري)
cycle           Int       @default(1)         // رقم دورة الاعتماد الحالية (يزيد 1 مع كل REOPEN)

preparedById    String?                       // المعدّ (معرّف بلا FK — انظر ملاحظة أدناه)
preparedByName  String    @default("")        // snapshot للاسم (يبقى بعد حذف المستخدم)
preparedAt      DateTime?

reviewedById    String?
reviewedByName  String    @default("")
reviewedAt      DateTime?                     // تاريخ بدء المراجعة (تُثبت عند START_REVIEW)

approvedById    String?
approvedByName  String    @default("")
approvedAt      DateTime?

returnedById    String?
returnedAt      DateTime?
returnReason    String    @default("")

reopenedById    String?
reopenedAt      DateTime?
reopenReason    String    @default("")
```

**ملاحظات تصميمية (إضافتان خارج قائمتك مع التبرير):**

1. **`cycle Int @default(1)`**: رقم الدورة — أساس ربط سجل الدورات وعرض «الدورة رقم N» في الواجهة، ويحوّل «إعادة الفتح» من حدث غامض إلى دورة مرقّمة قابلة للتدقيق.
2. **`preparedByName / reviewedByName / approvedByName` (snapshots)**: نفس فلسفة `AuditLog.username` — إذا حُذف المستخدم تبقى الأسماء معروضة في رأس التقرير دون أي JOIN أو فقد. (بديلها الاعتماد على السجل التاريخي فقط، لكنها تجعل القراءة المباشرة أبسط وأمتن.)

**لماذا بلا FK علاقات مع User؟** نفس مبرر `AuditLog`: حذف مستخدم لا يجب أن يفسد أو يمسح أدوارًا رقابية على التقارير، ويبقي المخطط منقولًا مباشرة إلى PostgreSQL.

**دلالة كل حقل:**

| الحقل | يُثبت عند | ملاحظة |
|---|---|---|
| `prepared*` | إنشاء التقرير تلقائيًا (المنشئ = المعد) + يمكن تغييره بالإسناد | `preparedAt` يُثبت عند الإنشاء/الإسناد |
| `reviewed*` | `START_REVIEW` | `reviewedAt` = تاريخ **بدء** المراجعة |
| `approved*` | `APPROVE` | ويُمسح من الحقول عند `REOPEN` (بعد أرشفته — القسم 8) |
| `returned*` | `RETURN` | `returnReason` إلزامي |
| `reopened*` | `REOPEN` | `reopenReason` إلزامي |

**قاعدة ذهبية:** حقول Workflow على Report = **الدورة الحالية فقط**. التاريخ الكامل = `WorkflowHistory` (القسم 2).

**Backfill للبيانات القائمة** (تقارير ما قبل المرحلة 3): `status=DRAFT, cycle=1, preparedById=userId, preparedByName=<اسم المالك>, preparedAt=createdAt` — أي المالك يصبح المعد تلقائيًا ولا يفقد حق تعديل تقاريره.

---

## 2. الجدول المستقل: نعم — `WorkflowHistory` (Append-Only)

**التوصية: جدول مستقل إلزامي.** الاكتفاء بحقول Report يعني overwrite يفقد الدورات السابقة عند إعادة الفتح — وهذا ما منعتَه صراحة. الجدول يقابل فلسفة `AuditLog` (append-only، بلا FK، snapshot للأسماء):

```prisma
model WorkflowHistory {
  id             String   @id @default(cuid())
  reportId       String
  cycle          Int                  // رقم الدورة التي وقع فيها الانتقال
  action         String               // SUBMITTED | RESUBMITTED | REVIEW_STARTED | RETURNED | APPROVED | REOPENED | RESUMED_EDIT | ASSIGNMENT_CHANGED
  fromStatus     String   @default("")// "" لتاريخ الإنشاء/الإسناد الأول
  toStatus       String   @default("")
  actorId        String?
  actorUsername  String   @default("")// snapshot
  reason         String   @default("")// إلزامي لـ RETURNED/REOPENED
  comment        String   @default("")// اختياري لأي انتقال
  roleSnapshot   String   @default("{}") // JSON صغير: {preparedBy, reviewedBy, approvedBy} أسماء+معرفات لحظة الحدث
  createdAt      DateTime @default(now())

  @@index([reportId, createdAt])
  @@index([reportId, cycle])
  @@index([action])
}
```

- **لا PUT/DELETE على أي API له — append-only فعليًا** مثل AuditLog.
- كل انتقال يُكتب **في نفس المعاملة** مع تحديث التقرير وكتابة AuditLog (ذرية ثلاثية).
- `roleSnapshot` صغير (معرفات وأسماء فقط، بلا أي كتل Excel/JSON).
- القراءة: `GET /api/reports/[id]/workflow-history` — للمشاركين في التقرير (معد/مراجع/معتمد) والمالك والمجموعة المرتبطة والمدير.

لماذا ليس جدول «ApprovalHistory» فقط؟ لأن المطلوب توثيق **كل** أحداث الدورة (إرسال، بدء مراجعة، إرجاع، إعادة إرسال، إعادة فتح، تغيير إسناد) لا الاعتماد وحده — لذا التسمية `WorkflowHistory` أصدق، و`roleSnapshot` في كل صف يجعل أي صف قادرًا على إعادة بناء صورة الأدوار لحظته.

---

## 3. تمثيل الإسنادات (Assignments)

**القرار المقترح: الإسناد = حقول Report نفسها للدورة الحالية + أرشفة كل تغيير في `WorkflowHistory`. لا جدول `ReportAssignment` منفصل الآن.**

التبرير:

1. قائمتك أنت عرّفت الإسناد كحقول على Report (`preparedById/reviewedById/approvedById`) — الالتزام بها يبقي النموذج بسيطًا.
2. استعلامات «تقاريري» بسيطة ومفهرسة: `WHERE reviewedById = me` (سنضيف فهارس `preparedById/reviewedById/approvedById`).
3. جدول إسناد منفصل يخلق مشكلة تزامن (جدول ↔ حقول) بلا فائدة إضافية في هذا الحجم، والتاريخ محفوظ أصلًا في `WorkflowHistory`.
4. مستقبلًا إن احتجنا (تعدد مراجعين، تفويض، فريق مراجعة) نضيف الجدول آنذاك دون كسر الحقول.

**من يُسند؟ ومن يُرسَّح عليه؟**

- **سلطة الإسناد**: المدير (role=admin) أو من يملك صلاحية نظامية جديدة **`assignWorkflow`** (افتراضيها false للمستخدم العادي — القسم 5).
- **المنشئ يصبح المعد تلقائيًا** عند إنشاء التقرير (self-assignment في نفس معاملة الإنشاء) — لا تقرير بلا معد.
- **متى يُسمح بتغيير الإسناد؟**
  - `preparedById`: في `DRAFT / RETURNED / REOPENED` فقط.
  - `reviewedById / approvedById`: في `DRAFT / RETURNED / REOPENED`، **مع استثناء تشغيلي واحد**: يجوز استبدال المراجع/المعتمد في `SUBMITTED / UNDER_REVIEW` (صمام أمان إذا أصبح المراجع معطل الحساب أو مغادرًا) — بشرط السماحية + SoD + تدقيق `ASSIGNMENT_CHANGED`. بلا هذا الصمام يتعطل التقرير للأبد.
- **أهلية التعيين**: أي مستخدم `active=true`. (واجهة الإسناد تحتاج قائمة مستخدمين مبسطة: سنفتح `GET /api/users?for=assignment` لحيازي `assignWorkflow` تُرجع `{id, username, displayName, active}` فقط — بلا أدوار ولا صلاحيات.)

---

## 4. مصفوفة انتقالات الحالة (State Transition Matrix)

الحالات الست بتسميات عربية:

| الكود | العربية | لون الشارة المقترح |
|---|---|---|
| DRAFT | مسودة | رمادي (secondary) |
| SUBMITTED | مُرسَل للمراجعة | كهرماني |
| UNDER_REVIEW | تحت المراجعة | بنفسجي فاتح |
| RETURNED | مُرجَع للتصحيح | برتقالي/أحمر فاتح |
| APPROVED | معتمد | أخضر |
| REOPENED | مُعاد فتحه | بنفسجي |

**المصفوفة (✗ = ممنوع — لا قفز مباشر إطلاقًا):**

| من \ إلى | DRAFT | SUBMITTED | UNDER_REVIEW | RETURNED | APPROVED | REOPENED |
|---|---|---|---|---|---|---|
| **DRAFT** | — | **SUBMIT** | ✗ | ✗ | ✗ | ✗ |
| **SUBMITTED** | ✗ | — | **START_REVIEW** | ✗ | ✗ | ✗ |
| **UNDER_REVIEW** | ✗ | ✗ | — | **RETURN** (سبب إلزامي) | **APPROVE** | ✗ |
| **RETURNED** | **RESUME_EDIT** | ✗ | ✗ | — | ✗ | ✗ |
| **APPROVED** | ✗ | ✗ | ✗ | ✗ | — | **REOPEN** (صلاحية خاصة + سبب إلزامي) |
| **REOPENED** | **RESUME_EDIT** | ✗ | ✗ | ✗ | ✗ | — |

**تفصيل الانتقالات:**

| # | الانتقال | الفاعل الوحيد | شروط إضافية | التدقيق (AuditLog) | صف WorkflowHistory |
|---|---|---|---|---|---|
| 1 | DRAFT → SUBMITTED | المعد المعيّن | يجب أن يكون `reviewedById` معيّنًا (وإلا 400 `REVIEWER_NOT_ASSIGNED`)؛ حفظ البيانات عبر PUT **قبل** الإرسال | `REPORT_SUBMITTED` (أول إرسال) أو `REPORT_RESUBMITTED` (إذا سبق إرجاع أو إعادة فتح: `returnedAt ≠ null` أو `reopenedAt ≠ null`) | `SUBMITTED` / `RESUBMITTED` |
| 2 | SUBMITTED → UNDER_REVIEW | المراجع المعيّن | — | `REVIEW_STARTED` | `REVIEW_STARTED` |
| 3 | UNDER_REVIEW → RETURNED | المراجع المعيّن | `returnReason` إلزامي (غير فارغ بعد trim) | `REPORT_RETURNED` | `RETURNED` |
| 4 | RETURNED → DRAFT | المعد المعيّن | «استئناف التعديل» بعد التصحيح | *(بلا كود AuditLog — انقر قرار D-2)* | `RESUMED_EDIT` |
| 5 | UNDER_REVIEW → APPROVED | المعتمد المعيّن | يقفل التقرير كليًا | `REPORT_APPROVED` | `APPROVED` |
| 6 | APPROVED → REOPENED | حائز `reopenReport` (المدير افتراضيًا) | `reopenReason` إلزامي؛ أرشفة الاعتماد السابق أولًا (القسم 8)؛ `cycle += 1` | `REPORT_REOPENED` | `REOPENED` |
| 7 | REOPENED → DRAFT | المعد المعيّن | بدء الدورة الجديدة | *(بلا كود — قرار D-2)* | `RESUMED_EDIT` |

ملاحظات:

- **الإرسال من RETURNED يمر عبر DRAFT** (كما رسمتَ: RETURNED → DRAFT ثم إعادة تقديم) — لا إرسال مباشر من RETURNED.
- **لا «زر اعتماد» يغيّر الحالة من أي موضع**: APPROVE يعمل حصرًا من UNDER_REVIEW وبيد المعتمد المعيّن حصرًا (المطلب سابعًا/ثامنًا).
- `reviewedById/reviewedAt` يثبتان عند **بدء** المراجعة — ودلالة «اكتمال المراجعة تمهيدًا للاعتماد» تتحقق ضمنيًا بوصول التقرير إلى APPROVE (لا حالة وسطى إضافية).
- كل انتقال يُنفَّذ ذريًا بشرط `{id, version, status: fromStatus}` — أي محاولة من نسخة قديمة أو حالة تغيّرت تُرجع **409** تمامًا كتعديل البيانات (المطلب الحادي عشر).

---

## 5. مصفوفة الصلاحيات (المستويان معًا)

### أ) صلاحيات النظام — مفتاحان جديدان على `User.permissions` (JSON)

| المفتاح | الافتراضي (مستخدم عادي) | المدير | الغرض |
|---|---|---|---|
| `assignWorkflow` | `false` | `true` (ضمنيًا بالدور) | تعيين/تغيير المعد والمراجع والمعتمد للتقارير |
| `reopenReport` | `false` | `true` (ضمنيًا بالدور) | إعادة فتح تقرير معتمد (REOPEN) |

- لا مفاتيح `review`/`approve` على مستوى النظام **عمدًا** — كونك مراجعًا أو معتمدًا صفة **لتقرير بعينه** (المطلب ثالثًا)، تُكتسب بالإسناد فقط.
- `edit` يبقى شرطًا نظاميًا للحفظ (PUT) كما في القسم 7 — أي الإسناد يحدد «على أي تقرير»، وصلاحية النظام تحدد «هل يملك الحق عمومًا»؛ **كلاهما لازم**.
- تنبيه معروف من المرحلة 2: جلسات NextAuth تختم الصلاحيات عند الدخول — من تُمنح `assignWorkflow/reopenReport` يحتاج إعادة دخول لتفعيلها (سيُوثَّق في CHANGELOG).

### ب) مصفوفة العمليات (النظام + الإسناد + الحالة + SoD)

| العملية | صلاحية النظام | الإسناد (Workflow Assignment) | بوابة الحالة | ضوابط إضافية |
|---|---|---|---|---|
| إنشاء تقرير | `add` | المنشئ ⇒ معد تلقائيًا | — | — |
| حفظ/تعديل بيانات المطابقة (PUT) | `edit` | `preparedById` = المستخدم | `DRAFT / RETURNED / REOPENED` | version إلزامية (قفل المرحلة 2) |
| SUBMIT | — | المعد | `DRAFT` | المراجع معيّن مسبقًا |
| START_REVIEW | — | المراجع | `SUBMITTED` | — |
| RETURN | — | المراجع | `UNDER_REVIEW` | سبب إلزامي |
| APPROVE | — | المعتمد | `UNDER_REVIEW` | يقفل التقرير |
| REOPEN | `reopenReport` | — | `APPROVED` | سبب إلزامي + أرشفة |
| ASSIGN (تغيير إسناد) | `assignWorkflow` | — | `DRAFT/RETURNED/REOPENED` + (استبدال مراجع/معتمد في `SUBMITTED/UNDER_REVIEW`) | SoD + كل الأهداف `active` |
| قراءة التقرير | `view` (أو مشاركة المجموعة) | المشاركون (معد/مراجع/معتمد) **أو** المالك **أو** المجموعة المرتبطة | أي حالة | — |
| قراءة سجل الدورات | — | نفس قاعدة القراءة | — | — |
| حذف التقرير | `delete` + ملكية | — | **`DRAFT` فقط** | (قرار D-3) |
| ADMIN | يتجاوز: الإسناد، REOPEN، القراءة | **لا يتجاوز**: قفل التعديل (لا يعدّل بيانات APPROVED/SUBMITTED مباشرة — REOPEN بدلًا)، ولا SoD، ولا شرط الإسناد للانتقالات | — | المطلب خامسًا حرفيًا |

### ج) قواعد فصل المهام (Segregation of Duties)

**القاعدة الافتراضية بلا أي استثناء في هذه المرحلة:**

```
preparedById ≠ reviewedById
preparedById ≠ approvedById
reviewedById ≠ approvedById
```

التنفيذ **طبقتان** (دفاع متعمق):

1. **عند الإسناد** (PUT assignments): تُرفض أي مجموعة قيم يتناقض فيها اثنان → 400 `SEGREGATION_VIOLATION` مع ذكر الدورين المتناقضين.
2. **عند كل انتقال** (دفاع ضد بيانات قديمة/سباق): يعيد الخادم فحص SoD قبل تنفيذ SUBMIT/START_REVIEW/RETURN/APPROVE — لو كانت الأدوار الحالية متعارضة (نظريًا لا يحدث) تُرفض العملية وتُسجل.

- المنشئ يصبح معدًّا تلقائيًا ⇒ لا يمكن للمُسند تعيينه مراجعًا أو معتمدًا لنفس التقرير — المنع يحدث عند الإسناد لا عند الإرسال.
- المدير نفسه: يجوز أن يكون معدًّا أو مراجعًا أو معتمدًا **بشرط** ألا يجمع دورين في نفس التقرير (الاستثناء الإداري للشركات الصغيرة مؤجَّل بطلبك — لا يُنفَّذ الآن).
- لا SoD بين دورات مختلفة: من أعتمد الدورة 1 يجوز أن يراجع الدورة 2 بعد REOPEN (دورات مستقلة).

---

## 6. شكل API الجديد/المعدَّل

| Endpoint | الغرض |
|---|---|
| `POST /api/reports/[id]/workflow` | نقطة واحدة لكل الانتقالات: `{action, version, reason?, comment?}` — تُرجع التقرير الكامل الجديد، أو `400/403/409` structured |
| `PUT /api/reports/[id]/assignments` | `{preparedById?, reviewedById?, approvedById?, version}` — يتحقق: سماوية `assignWorkflow`، بوابات الحالة، الأهداف active، SoD ⇒ تحديث ذري بشرط النسخة + `version+1` + صف تاريخ + `ASSIGNMENT_CHANGED` |
| `GET /api/reports/[id]` (تعديل) | يستجيب مع كائن `workflow` محسوب خادميًا: الحالة، الدورة، المشاركون بأسمائهم وتواريخهم، الأسباب، و**`myActions`**: قائمة الأزرار المسموحة فعليًا للمستخدم الحالي (`canEdit, canSubmit, canStartReview, canReturn, canApprove, canReopen, canResume, canAssign`) — الواجهة تعرض ما يسمح به الخادم فقط (المطلب ثاني عشر) |
| `GET /api/reports/[id]/workflow-history` | صفوف الدورات (للمشاركين/المالك/المجموعة/المدير) |
| `GET /api/users?for=assignment` (جديد) | لحيازي `assignWorkflow`: `{id, username, displayName, active}` فقط |
| `PUT /api/reports/[id]` (تعديل) | تُضاف بوابة الحالة ذريًا: `WHERE id=? AND version=? AND status IN (DRAFT,RETURNED,REOPENED) AND preparedById=?` + رفض أي محاولة تغيير حقول workflow عبر PUT |

**أكواد الأخطاء الجديدة (structured):** `INVALID_TRANSITION` (409/400)، `NOT_ASSIGNED` (403)، `SEGREGATION_VIOLATION` (400)، `REASON_REQUIRED` (400)، `REVIEWER_NOT_ASSIGNED` (400)، `WORKFLOW_LOCKED` (403 لحفظ على تقرير مقفول)، `FORBIDDEN` (403 لغياب reopenReport/assignWorkflow) — إضافة إلى `VERSION_CONFLICT`/`VERSION_REQUIRED`/`VERSION_INVALID` القائمة.

**أكواد AuditLog السبعة الجديدة** (مع تسميات عربية، metadata مقتصدة بلا أي كتل Excel/JSON):

| الكود | التسمية العربية | metadata |
|---|---|---|
| `REPORT_SUBMITTED` | إرسال تقرير للمراجعة | `{cycle, reviewer: name}` |
| `REVIEW_STARTED` | بدء مراجعة تقرير | `{cycle}` |
| `REPORT_RETURNED` | إرجاع تقرير للتصحيح | `{cycle, reason}` |
| `REPORT_RESUBMITTED` | إعادة إرسال تقرير بعد التصحيح | `{cycle}` |
| `REPORT_APPROVED` | اعتماد تقرير | `{cycle}` |
| `REPORT_REOPENED` | إعادة فتح تقرير معتمد | `{cycle, reason, previousApprovedBy, previousApprovedAt}` |
| `ASSIGNMENT_CHANGED` | تغيير إسناد أدوار التقرير | `{cycle, changes: {role: {from, to}}}` (أسماء فقط) |

---

## 7. ماذا يحدث لصلاحية المجموعة (الكتابة التعاونية) المضافة في المرحلة 2؟

**تُستبدل بقاعدة الإسناد — تصبح المجموعة أداة رؤية وأهلية، لا أداة تعديل:**

| قبل (المرحلة 2) | بعد (المرحلة 3) |
|---|---|
| عضو `groupIds` المرتبط يستطيع **الكتابة** (PUT) على تقارير المجموعة | عضو المجموعة **يقرأ فقط** + يظهر كمرشح للإسناد |
| المالك يعدّل دائمًا | المالك يعدّل **فقط إذا كان هو المعد المعيّن والحالة قابلة للتعديل** (وبالـ backfill هو المعد، فلا يفقد شيء على الواقع) |
| `edit` نظامية تسمح بالحفظ ضمن الملكية/المجموعة | `edit` تبقى شرطًا نظاميًا لازمًا **للمعد المعيّن** فقط (نظام + إسناد معًا) |
| التعارض بين عضوين للمجموعة ممكن (أساس اختبار 409) | التعارض يبقى ممكنًا عمليًا: بين المعد ومُسند الأدوار (تغيير الإسناد يرفع version) — والقفل التفاؤلي وقواعد 409 لا تتغير |

- الوضع الجديد **أشد** رقابيًا: لا أحد يعدّل بيانات مالية إلا معد معيّن في دورة مفتوحة — وهذا نص مطلبك خامسًا.
- سيُوثَّق التغيير في CHANGELOG.md كبند سلوكي واضح («الكتابة التعاونية للمجموعات أُوقفت لصالح الإسناد»).
- حالة حدية محفوظة: تقرير بلا مجموعة وبلا رابط = المالك هو المعد (backfill) — لا تغيير إدراكي على المستخدم المنفرد.

---

## 8. إعادة فتح تقرير معتمد دون فقد التاريخ

التسلسل الذري لـ REOPEN (معاملة واحدة):

1. **أرشفة أولًا**: صف `WorkflowHistory {action: REOPENED, cycle: N, reason, roleSnapshot: {preparedBy, reviewedBy, approvedBy + الأوقات}}` — الاعتماد السابق كاملًا داخل الصف.
2. صف `AuditLog {REPORT_REOPENED}` بـ metadata مقتصدة (`previousApprovedBy/At` + السبب).
3. **ثم** مسح حقول الدورة المنتهية على Report: `approvedById/Name/At = null` (وأرشفة `returned*` السابقة في صفوفها)، وتثبيت `reopenedById/At/Reason`، و`status = REOPENED`، و`cycle = N+1`.
4. `preparedById` **يبقى** (استمرارية المعد) ما لم يغيّره حائز `assignWorkflow` (صف `ASSIGNMENT_CHANGED`).
5. المعد «استئناف التعديل» (REOPENED → DRAFT) → تعديل عبر PUT (شرطه الذري يشمل الحالة) → إرسال جديد (`REPORT_RESUBMITTED`) → دورة كاملة جديدة حتى اعتماد جديد.

**النتيجة**: لا overwrite فاقد — كل دورة سابقة قابلة لإعادة البناء بالكامل (من/إلى/الفاعل/الوقت/السبب/الأدوار) من `WorkflowHistory`، والواجهة تعرض «سجل الدورات» بشجرة زمنية لكل `cycle`.

---

## 9. الواجهة (المطلب ثاني عشر) — مخطط

- **بطاقة رقابية أعلى التقرير المفتوح**: شارة الحالة بالعربية + الدورة (رقم N) + الفترة المالية (`periodEnd`) + المعد/المراجع/المعتمد بأسمائهم + تواريخ الإعداد/بدء المراجعة/الاعتماد + سبب الإرجاع أو إعادة الفتح إن وجد (بصندوق تنبيه).
- **أزرار الإجراءات** تُبنى من `workflow.myActions` الخادمية حصرًا: «إرسال للمراجعة» (تأكيد يعرض اسم المراجع)، «بدء المراجعة»، «إرجاع للتصحيح» (حوار سبب إلزامي)، «اعتماد» (تأكيد صريح)، «إعادة فتح» (حوار سبب إلزامي — يظهر لحائز reopenReport فقط)، «استئناف التعديل»، «تغيير الإسناد» (حوار ثلاث قوائم + تحقق SoD فوري).
- **حوار «سجل الدورات»**: خط زمني لكل الدورات (من→إلى، الفاعل، الوقت، السبب/التعليق).
- **قائمة التقارير**: شارة حالة لكل صف + «دوري» (شارة إن كنت أنت المعد/المراجع/المعتمد) — وفلترة اختيارية بالحالة.
- **تدفق الحفظ الحالي**: زر «تحديث التقرير المفتوح» يظهر فقط عند `canEdit`؛ حفظ على تقرير مقفول ⇒ رسالة `WORKFLOW_LOCKED` عربية واضحة بالحالة الحالية؛ حوار تعارض 409 من المرحلة 2 يبقى كما هو (يعمل للانتقالات أيضًا).
- إشعارات toast لكل انتقال ناجح/فاشل؛ تسميات الحالات من وحدة نقية مشتركة (`src/lib/workflow.ts` — بلا استيرادات خادمية، تُستخدم في العميل والخادم كمصدر واحد للحقيقة).

---

## 10. خطة التنفيذ (بعد موافقتك فقط)

1. نسخة احتياطية قبل أي تغيير (VACUUM INTO — عادة المرحلة 0) + إضافة حقول Workflow و`WorkflowHistory` إلى Schema + `db push` (أعمدة كلها nullable/default + CREATE TABLE — صفر فقد) + backfill المعد للمالك + إعادة تشغيل dev server.
2. `src/lib/workflow.ts` (نقي): الحالات والتسميات، مصفوفة الانتقالات، فحص SoD، حساب myActions، أكواد الأخطاء.
3. `audit-actions.ts`: الأكواد السبعة + تسمياتها.
4. API: workflow POST + assignments PUT + workflow-history GET + تعديل GET/PUT للتقارير + users?for=assignment.
5. الواجهة: بطاقة الحالة + الأزرار + الحوارات + سجل الدورات + شارات القائمة.
6. اختبار API فعلي شامل (سيناريو A/B/C أدناه) ثم تحقق متصفح E2E ثم تنظيف بيانات الاختبار.
7. CHANGELOG.md + worklog + commit.

**سيناريو الاختبار الإلزامي (مقترح):** ثلاثة مستخدمين حقيقيين P (معد) وR (مراجع) وA (معتمد) + مدير:
دورة كاملة DRAFT→SUBMITTED→UNDER_REVIEW→APPROVED ✓ | SoD: تعيين P مراجعًا يُرفض ✓ | R يحاول الاعتماد → مرفوض (ليس المعتمد) ✓ | إرجاع بسبب + إعادة إرسال (`REPORT_RESUBMITTED`) ✓ | A يعتمد → قفل: PUT من P ⇒ `WORKFLOW_LOCKED`، ومن المدير أيضًا ✓ | REOPEN بدون سبب ⇒ 400، مع سبب ⇒ REOPENED ودورة 2 والاعتماد السابق في السجل ✓ | انتقال بنسخة قديمة ⇒ 409 ✓ | اعتمادان متزامنان (طلبان بنفس version) ⇒ [200, 409] ✓ | حفظ أثناء SUBMITTED ذريًا مرفوض ✓ | تقرير قديم: المالك ما يزال المعد ويستطيع الحفظ ✓ | السجل الرقابي يظهر الأكواد السبعة بلا أي كتل ضخمة ✓

---

## 11. نقاط القرار (أرجو حسمها مع الموافقة — لكل منها توصية جاهزة)

| # | السؤال | توصيتي |
|---|---|---|
| D-1 | جدول مستقل للدورات؟ | **نعم — `WorkflowHistory`** كما في القسم 2 (البديل overwrite مرفوض لمنعك صريحًا) |
| D-2 | تسجيل RESUME_EDIT (العودة من RETURNED/REOPENED إلى DRAFT) في AuditLog؟ | **لا** — يوثَّق في WorkflowHistory فقط (انتقال منخفض الخطورة)، ويبقى AuditLog على أكوادك السبعة حرفيًا. إن أردت كودًا ثامنًا أضيف `REPORT_EDITING_RESUMED` |
| D-3 | الحذف في `DRAFT` فقط (مالك + delete)؟ | **نعم** — منع حذف تقرير قيد مراجعة/معتمد حفاظًا على الأثر الرقابي (الحذف الناعم يجيء في مرحلة Backup/Restore لاحقًا) |
| D-4 | استبدال مراجع/معتمد أثناء SUBMITTED/UNDER_REVIEW لحيازي assignWorkflow؟ | **نعم** — صمام أمان لغياب المراجع، مُدقَّق بـ ASSIGNMENT_CHANGED ومقيَّد بـ SoD |
| D-5 | الحقول الإضافية `cycle` + snapshots الأسماء الثلاثة؟ | **نعم** — لإعادة البناء الكامل للدورات ومقاومة حذف المستخدمين |
| D-6 | رفع version عند تغيير الإسناد؟ | **نعم** — اتساق القفل التفاؤلي: كل تغيير على الصف يرفع النسخة، و409 يحمي من الإسناد المتزامن أيضًا |

---

## 12. ما لا يفعله هذا التصميم (حدود المرحلة)

- لا Backup/Restore ولا Polling/Presence (المرحلتان 4 و5).
- لا تعديل على `accounts.ts` ولا خوارزمية المطابقة إطلاقًا.
- لا استثناء إداري لفصل المهام للشركات الصغيرة (مؤجَّل بطلبك).
- لا إشعارات/بريد ولا مهام مراجعة خارج بنية الحالة.
- لا تعدد مراجعين/معتمدين ولا تفويض — الإسناد 1:1 لكل دور في الدورة.
