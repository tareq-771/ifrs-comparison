# Phase 4B.3 — Final Recovery Security Gate — تقرير نهائي

**التاريخ**: 2026-09-20 · **النطاق**: فصل صلاحية الاستعادة عن الدور (Explicit High-Risk Permission) — مراجعة أمنية فقط، لا ميزات جديدة
**القرار الحاكم**: قرار المستخدم 4B.3 — `restoreDatabase` مفتاح صريح مستقل لا يُمنح ضمنيًا بدور admin، متسقًا مع D-5
**الحدود**: لا Restore A/B جديدة، لا DB swap، لا Workflow، لا accounts.ts، لا Deployment/Hardening — المحرك بقي **معطلًا** طوال المرحلة

---

## 1) نموذج الصلاحيات قبل/بعد

### قبل (حتى 4B.2)
```
canRestoreDatabase(perms, role) = role === "admin" || perms.restoreDatabase === true
ADMIN_PERMISSIONS.restoreDatabase = true   // قالب المدير يمنحها تلقائيًا
POST /api/users  (role=admin): perms = ADMIN_PERMISSIONS كاملة (استعادة مضمّنة)
PUT  /api/users  (role=admin): perms = ADMIN_PERMISSIONS كاملة (منح/محو صامت محتمل)
```
المشكلة المثبتة: أي مدير — بحكم الدور فقط — كان يستطيع استبدال قاعدة التشغيل.

### بعد (4B.3)
```
canRestoreDatabase(perms) = perms.restoreDatabase === true        // صريح حصرًا — لا يستقبل role أصلًا
ADMIN_PERMISSIONS.restoreDatabase = false                          // القالب لا يحملها إطلاقًا
POST /api/users (role=admin): restoreDatabase = body.permissions.restoreDatabase === true فقط
PUT  /api/users: قيمة boolean صريحة في الطلب تُعتمد حرفيًا؛ غيابها يحفظ القيمة المخزنة
```
**النتيجة**: يمكن وجود `role=admin` بكامل الصلاحيات الإدارية (manageUsers/settings/…) مع
`restoreDatabase=false` فلا يستطيع استبدال قاعدة البيانات. المنح/السحب متاحان لمدير أو
مستخدم على حدّ سواء عبر خانة مستقلة بأسلوب تحذيري في محرر المستخدمين.

- `manageBackups` لم تُمَسّ: المدير ضمنيًا بالدور، وغيره بمفتاح صريح (حسب «لا تغيّر بقية صلاحيات Admin دون داعٍ»).

## 2) حالة الحسابات القائمة (قبل أي تغيير — لقطة قراءة فقط)

سكربت `scripts/phase4b3-prestate-snapshot.ts` (لا كتابة):
- **مستخدم وحيد**: `admin` — role=admin، نشط، منشأ 2026-09-19.
- الصلاحيات المخزنة حرفيًا: `{view,add,edit,delete,groups,export,settings,manageUsers,groupIds:[]}`.
- **`restoreDatabase` غير مخزنة إطلاقًا** (`restoreKeyExplicitlyStored: false`) — أي أن قدرته على
  الاستعادة كانت ناتجة **حصرًا عن الدور**.
- **القرار المنفذ**: لم تُضَف الصلاحية بصمت. المدير الحالي الآن بلا قدرة استعادة حتى يُمنح
  المفتاح منحًا صريحًا (من محرر المستخدمين — خطوة واعية مسجلة تدقيقيًا).

**الحالة النهائية بعد كل الاختبارات**: نفس المستخدم الوحيد، `restoreDatabaseStored: false`
— الانتقال إلى least privilege منفذ دون أي منح تلقائي.

## 3) سبب `restoreEngineEnabled=false` (تشخيص حصرًا — لم يُغيَّر .env)

| السؤال | الجواب |
|---|---|
| القيمة الحالية الفعلية | `/api/system/status` → `restoreEngineEnabled: false` |
| غير موجود أم 0؟ | **غير موجود** (`process.env.RESTORE_ENGINE_ENABLED === undefined`)؛ الدالة تشترط `"1"` حرفيًا |
| الملف أم البيئة؟ | ملف `.env` حجمه 50 بايت يحوي `DATABASE_URL` فقط، بتاريخ تعديل 14:10 — **نفس لحظة إقلاع الخادم الحالي**. إعادة تعيين بيئة الاستضافة بين الجلسات أعادت إنشاء `.env` من قالب وفقد المتغيرات |
| ماذا فُقد معه؟ | `NEXTAUTH_SECRET` (كان مثبتًا في 4A) و`RESTORE_ENGINE_ENABLED=1` (حالة نهاية 4B.2) |
| هل يقرأ الخادم ملفًا مختلفًا؟ | لا — نفس `.env`؛ لكن غياب السر اشترك سلوكًا شبيهًا: **JWEDecryptionFailed بين chunks** (session=200 مقابل APIs=401) — العلة نفسها الموثقة في 4A |
| أثر جانبي إضافي لإعادة التعيين | `var/` كاملًا أُفرغ: **كل نسخ 4A/4B.2 + سجل الاسترجاع الخارجي + أدلة الاختبار** ضاعت (غير متتبعة في Git). العدّاد أعيد تهيئته إلى 1 عند الإقلاع. ملف واحد متتبع سقط من شجرة العمل (`src/app/api/backups/upload/route.ts`) واستُعيد من Git كما هو |
| التصحيح التنفيذي | استعادة `upload/route.ts` من Git (بدون أي تعديل) + إعادة تشغيل الخادم مع `NEXTAUTH_SECRET` **كمتغير بيئة للعملية فقط** — `.env` بقي byte-for-byte كما هو (50 بايت) و`RESTORE_ENGINE_ENABLED` ظل غائبًا (المحرك معطل) |
| النسخ الحالية | 3 نسخ أُنشئت أثناء 4B.3 عبر API (`bk-…p7ecqt` مرجعية + `bk-…au0lf8` + `bk-…h993w2`) — إعادة بناء نقطة استعادة + أدلة المصفوفة. سجل الاسترجاع يُعاد بناؤه append-only من الحدث 1 (19 حدثًا حتى نهاية الاختبارات، كلها لعمليات 4B.3) |

> **بقايا مخاطر موثقة (خارج نطاق 4B.3 حسب تعليماتك)**: (1) `.env` بلا سر مثبت — إعادة تشغيل مستقبلية للخادم ستقتل الجلسات وتعيد علة chunks ما لم يُثبَّت السر من جديد (D-10). (2) `var/` خارج Git — أدلة السجل الخارجي والنسخ معرضة لضياع عند أي إعادة تعيين بيئة؛ يُقترح قرار تشغيلي لاحق (نسخ احتياطي خارجي/أرشفة أدلة) دون مساس بنطاق 4B.

## 4) مصفوفة endpoints (من جرد الساكن `phase4b3-restore-permission-scan.ts`)

### تتطلب `restoreDatabase` (صريح حصرًا — 403 لغير الحامل)
| Endpoint | الطريقة | الغرض |
|---|---|---|
| `/api/backups/[id]/restore` | POST | التنفيذ الفعلي (استبدال قاعدة التشغيل) |
| `/api/backups/[id]/restore-preview` | GET | بنود التأكيد + مقارنة counts + اشتقاق التأكيد الثاني |

### تتطلب `manageBackups` (المدير ضمنيًا بالدور)
| Endpoint | الطريقة | ملاحظة |
|---|---|---|
| `/api/backups` | GET / POST | القائمة / إنشاء نسخة |
| `/api/backups/[id]` | GET | تفاصيل Manifest |
| `/api/backups/[id]/download` | GET | تنزيل ZIP |
| `/api/backups/[id]/validate` | POST | خط التحقق |
| `/api/backups/[id]/drill` | POST | Drill معزول |
| `/api/backups/upload` | POST | رفع للتحقق (staging) |
| `/api/backups/recovery-log` | GET | **قراءة** سجل الاسترجاع (سياسة 4B.3: قراءة تشغيلية/رقابية لحامل manageBackups — التنفيذ يبقى restoreDatabase؛ السجل append-only بلا أي endpoint تعديل/حذف) |

### ترتيب التفويض داخل مسارات الاستعادة
`requireRestoreDatabase()` أول جملة في المعالج — **قبل** أي فحص للمحرك أو الحالة أو
التأكيدات. غير المخوّل يرى 403 بلا أي كشف عن `RESTORE_ENGINE_DISABLED` أو حالة الصيانة
(مثبت ديناميكيًا M33 أدناه وساكنًا بقاعدة R3 في الجرد).

## 5) مصفوفة الصلاحيات عبر HTTP (سكربت `phase4b3-permission-matrix.ts` — 45/45 ✅)

مستخدمو الاختبار أُنشئوا عبر API حقيقي، ودخول NextAuth حقيقي لكل حالة، ثم **حُذفوا** (عدد المستخدمين النهائي = 1). لا تنفيذ استعادة إطلاقًا: محرك معطل + probe تنفيذ بمعرف نسخة غير موجود (يرفضه المحرك بعد التفويض وقبل أي لمس).

| الحالة | إنشاء/قائمة/تفاصيل | Validate | Drill | Download | Recovery Log | Restore preview | Restore execute |
|---|---|---|---|---|---|---|---|
| غير مصدق | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| مستخدم عادي | 403 | 403 | 403 | 403 | 403 | 403 | **403** |
| manageBackups فقط | **200/201** | **200** | **200** | **200** | **200** | 403 | **403** |
| restoreDatabase فقط | 403 | 403 | 403 | 403 | 403 | **200** | **409** `RESTORE_ENGINE_DISABLED` |
| Admin بلا restoreDatabase | **200** (إدارته بالدور) | 200 | **200** | 200 | **200** | **403** | **403 بالضبط (وليس 409)** |
| manageBackups + restoreDatabase | 200/201 | 200 | 200 | 200 | 200 | **200** | **409** `RESTORE_ENGINE_DISABLED` (تفويض ناجح) |
| المدير الأصلي (لا مفتاح مخزن) | 200 | 200 | 200 | 200 | 200 | **403** | **403** |

البنود الحاسمة:
- **M32/M33**: المدير بلا المفتاح ⇒ preview 403 وexecute 403 — وليس `409 RESTORE_ENGINE_DISABLED` — أي أن حالة المحرك **لا تُكشف** لغير المخوّل قبل رفض التفويض (شرطك الصريح في الترتيب).
- **M26/M27**: حامل `restoreDatabase` وحده يصل **الحد الأدنى** من الworkflow (معاينة 200 + تجاوز التفويض)، ولا يمنحه أي إدارة نسخ عامة ولا قائمة مستخدمين (كلها 403) — «الحد الأدنى اللازم داخل endpoint الحساس» حققته المعاينة نفسها فلم يلزم توسيع أي صلاحية.
- **M39/M40**: المدير الأصلي بلا مفتاح مخزن ⇒ 403 — إثبات أن قدرته السابقة كانت من الدور فقط و**لم تُمنح بصمت**.
- M9: عمل المستخدم العادي غير متأثر (reports 200).

## 6) أدلة الواجهة (Agent Browser — 4 لقطات في `var/test/4b3/`)

| المستخدم | ما ظهر | اللقطة |
|---|---|---|
| manageBackups فقط | يبقى في `/admin` ويرى تبويب «النسخ الاحتياطي» حصرًا: إنشاء/رفع/تفاصيل/تحقق/Drill/تنزيل + السجل التشغيلي — **لا زر «استعادة» في أي صف** (كلمتا «استعادة» الوحيدتان نص حالة المحرك ووصف السجل) | `ui-evidence-mb-only-no-restore.png` |
| manageBackups + restoreDatabase | نفس الشاشة **+ زر «استعادة»** ظاهر (disabled لأن المحرك معطل — الرؤية للمخوّل، والتنفيذ معطل بيئيًا) | `ui-evidence-both-restore-visible.png` |
| Admin بلا restoreDatabase | ثلاثة تبويبات (المستخدمون/التدقيق/النسخ) — تبويب النسخ **بلا زر استعادة** | `ui-evidence-adminnr-no-restore.png` |
| محرر المستخدمين | خانة «استعادة قاعدة البيانات (خطورة عالية)» بأسلوب أحمر تحذيري، **مستقلة عن الدور وقابلة للنقر للمدير أيضًا**، القيمة الابتدائية من المخزن (false للمدير الجديد)، وشارة صف المدير صارت «إدارة كاملة (عدا الاستعادة)» وشارة وردية لحامل المفتاح | `ui-evidence-editor-restore-checkbox.png` |

تغييرات واجهة مصاحبة (ضرورية لشرط الـUI):
- `src/proxy.ts` (حاجز الحافة): `/admin` تفتح لـ admin أو manageUsers أو manageBackups (كانت تشترط دور admin فلا يصل حامل النسخ للصفحة أصلًا). ما يُعرض داخلها يحدده تبويب-بتبويب: المستخدمون لـ manageUsers، التدقيق لدور admin (الـAPI خلف requireAdmin)، النسخ لـ canManageBackups.
- صفحة admin: نفس الفصل في البوابات الداخلية + `defaultValue` للتبويب يتكيف.
- `backup-manager.tsx`: زر الاستعادة **يُخفى** (لا يُعطَّل) لغير حامل المفتاح، ويُحلل `permissions` من الـJWT عبر `parsePermissions` (كانت سلسلة خام).

## 7) الجردان الآليان

1. **write-guard inventory** (`phase4b1-write-guard-scan.ts`): 59 معالجًا (34 كتابة/17 قراءة/8 معفاة موثقة) — **PASS**.
2. **restore-permission inventory** (`phase4b3-restore-permission-scan.ts` — جديد): 32 route.ts —
   - R1/R2: كل مسار قادر على الوصول للاستعادة/التبديل (استيراد `executeRestore`/`buildRestorePreview` أو كاتبي حالة الصيانة أو اسم مسار `/restore`) **يجب** أن يستدعي `requireRestoreDatabase(`.
   - R3: أول ظهور للبوابة يجب أن يسبق أي `executeRestore/buildRestorePreview/isRestoreEngineEnabled/readMaintenanceStateFile` — قاعدة «لا كشف حالة المحرك قبل التفويض» مشفرة ساكنًا.
   - R4/R5: كل مسارات `/api/backups` محمية، ومسارات الإدارة العامة **لا** تحمل بوابة الاستعادة (فصل الصلاحيتين).
   - **PASS (EXIT=0)** — أي endpoint مستقبلي من هذا النوع بلا البوابة أو بترتيب خاطئ **يفشل الاختبار**.

## 8) Regression حفظ الصلاحية (`phase4b3-permission-regression.ts` — 17/17 ✅)

دورة الحياة عبر HTTP حقيقي على مستخدم مدير مؤقت:
1. إنشاء admin بـfalse ⇒ المخزنة false + preview/restore ⇒ 403/403.
2. تعديل الاسم فقط (بلا permissions) ⇒ تبقى false — القالب لم يمنحها.
3. تعديل بصلاحيات كاملة **دون** مفتاح الاستعادة ⇒ تبقى false — غياب المفتاح لا يمنح.
4. منح صريح true ⇒ المخزنة true؛ الجلسة القديمة تبقى 403 (الصلاحيات تُقرأ عند الدخول — تصميم 4B.1)؛ **جلسة جديدة**: preview 200 + restore 409 (تفويض ناجح، المحرك معطل، لا swap).
5. تعديل لاحق بصلاحيات كاملة تحوي true ⇒ تبقى true.
6. تعديل **بلا permissions إطلاقًا** ⇒ تبقى true — **لا محو صامت من قالب المدير** (الـbug الذي كانت تهدفه التجربة، مكتشف ومدافع عنه).
7. سحب صريح false ⇒ جلسة جديدة ⇒ 403/403 فورًا (على نسخة حقيقية أيضًا).
8. **Audit Trail**: حدثا المنح والسحب موثقان `PERMISSIONS_CHANGED` مع `before/after.permissions` + `metadata.restoreDatabaseChanged {from,to}` مركّز؛ حدث تغيير سلسلة JSON دون تغيّر القيمة ظهر بلا marker (سلوك سليم).

## 9) حالة قاعدة البيانات النهائية (`phase4b3-final-state.ts`)

- `PRAGMA integrity_check` → **ok** · `foreign_key_check` → 0 مخالفات
- العدادات: users=1 · groups=0 · reports=0 · workflowHistory=20 · auditLog=322 (نمو append-only كأدلة الاختبارات — بالتصميم)
- المستخدم الوحيد: admin — `restoreDatabaseStored: false`, المفتاح غير مخزن (least privilege منفذ)
- التشغيل: NORMAL · epoch متاح (=1 بعد إعادة تهيئة بيئة الاستضافة — كل الجلسات القديمة كانت قد ماتت مع موت العملية السابقة) · **المحرك معطل**
- `.env`: 50 بايت، لم يُلمس

## 10) لقطات الأوامر الحاكمة

```
bun run scripts/phase4b3-prestate-snapshot.ts        # لقطة ما قبل التغيير (قراءة فقط)
bun run scripts/phase4b3-restore-permission-scan.ts  # جرد صلاحية الاستعادة — PASS
bun run scripts/phase4b1-write-guard-scan.ts         # جرد حماية الكتابة — PASS
bun run scripts/phase4b3-permission-matrix.ts        # المصفوفة عبر HTTP — 45/45 ✅
bun run scripts/phase4b3-permission-regression.ts    # دورة حياة الصلاحية — 17/17 ✅
bun run scripts/phase4b3-final-state.ts              # integrity ok + الحالة النهائية
bun run lint                                         # نظيف
bunx tsc --noEmit                                    # صفر أخطاء في ملفات 4B.3 (بقية الأخطاء سابقة موثقة في scripts/ وملفات لم تُمس)
```

## 11) الالتزام

Commit: **`92dfccf`** — "Phase 4B.3: final recovery security gate …" (على رأس `b48fadd` — append-only)

## 12) التوقف

**توقفت هنا**: لا Deployment، لا Server Hardening — بانتظار موافقتك. القرارات المفتوحة
الخارجية عن النطاق: تثبيت `NEXTAUTH_SECRET` في `.env` (D-10)، وسياسة حفظ أدلة `var/`
خارج بيئة الاستضافة (ضاعت مرة بالفعل).
