# Phase 4B.1 Report — Recovery Engine, Maintenance Mode & Isolated Destructive Verification

**التاريخ:** 2026-09-20 · **Commit:** `bfbbb73` (Phase 4B.1) على سلسلة append-only
**النطاق:** حصرًا ما وافق عليه المستخدم في 4B.1 — لا Scheduled Backup، لا Cloud/NAS، لا HMAC/signing، لا Polling/Presence، لا أي تعديل على accounts.ts أو matching engine.

---

## 1. المعمارية العامة

كل الحالة التشغيلية للصيانة والاستعادة **خارج قاعدة البيانات المستبدلة** في `VAR_DIR` (افتراضي `var/`، قابل للتهيئة):

```
VAR_DIR/
├── maintenance/state.json        آلة حالة الصيانة (كتابة ذرية)
├── auth/session-epoch            عدّاد الجلسات (خارج DB — لا تدوير NEXTAUTH_SECRET)
├── recovery/
│   ├── recovery-log.jsonl        السجل الخارجي append-only (الدليل الحاكم)
│   └── operation.lock            قفل عمليات الاسترجاع (O_EXCL)
├── backups/                      BACKUP_DIR (نسخ 4A + pre-restore)
└── test/fault-injection.json     قناة حقن الأعطال (بوابة بيئية مزدوجة — لا HTTP)
```

مسار قاعدة التشغيل مشتق من `DATABASE_URL` (`db/custom.db`)، ومجلد التبديل `resolveSwapDir()` هو **مجلد القاعدة نفسه** — أي أن الـ staging والـ rename ذريان بنيويًا على نفس filesystem (يُرفض أي مسار عابر للأنظمة بـ `CROSS_FILESYSTEM`).

## 2. آلة حالة الصيانة (`src/lib/maintenance.ts`)

- الحالات الثمانية: `NORMAL → VALIDATING → PREPARING → DRAINING → SWAPPING → VERIFYING → (NORMAL | ROLLING_BACK → (NORMAL | RECOVERY_REQUIRED))` مع `operationId / startedAt / startedBy / message / history / flags` لكل انتقال.
- المستويات: `write-block` (VALIDATING/PREPARING/DRAINING — القراءة تعمل) · `full-block` (SWAPPING/VERIFYING/ROLLING_BACK — القراءة أيضًا 503) · `locked` (RECOVERY_REQUIRED — قفل كامل).
- **كتابة ذرية:** `tmp + fsync + rename` داخل نفس المجلد — crash لا ينتج ملف حالة جزئيًا أبدًا.
- **ملف تالف ⇒ RECOVERY_REQUIRED fail-closed** (لا يمكن إثبات السلامة ⇒ لا فتح خدمة).
- `RECOVERY_REQUIRED`: قراءة وكتابة 503، **لا reset تلقائي**، العرض للإدارة operationId وسبب آمن فقط، الخروج عبر أداة المشغّل الموثقة فقط.

## 3. Write Guard المركزي + إثبات التغطية

- `acquireWriteLease()/acquireReadLease()` + `guardWrite()/guardRead()` (`src/lib/api-guard.ts`) — الحارس **أول سطر في كل معالج قبل المصادقة** (503 فوري أثناء الصيانة بلا أي كشف آخر)، ويُسجل الطلب في عدّاد التصريف حتى `finally`.
- طبقات الحجب: أي حالة ≠ NORMAL ⇒ حجب؛ `epoch` غير قابل للقراءة ⇒ حجب كتابة (fail-safe فوق 401).
- **الإثبات الآلي** (`scripts/phase4b1-write-guard-scan.ts` — جرد ساكن يفشل عند أي route كتابي جديد بلا حارس):
  - **59 معالجًا** في 32 route.ts: **34 كتابة** كلها بـ `guardWrite` بالمسار الصحيح، **17 قراءة** بـ `guardRead`، **8 معفاة بقائمة موثقة قصيرة** (المصادقة، `/api/system/status` العام الآمن، محرك الاستعادة ومعاينته، قراءات أدوات النسخ للمشغّل أثناء الصيانة، `/api`).
  - **إثبات سلوكي:** أثناء DRAINING حقيقي في البيئة المعزولة، **جميع مسارات الكتابة العشرين (20/20) ردت 503 MAINTENANCE_MODE** (workflow/assignments/due-date/setup/users/groups/reports/backups-create/upload/validate/drill/chat/conversations…).

## 4. التصريف (Drain)

- سجل كتابات جارية في العملية (`Map` بمعرفات leases) + `drainActiveWrites(timeoutMs=30s)` — لا كتابة جديدة تُقبل أثناء DRAINING، والانتظار حتى الصفر **بلا قتل أي كتابة جارية أبدًا**.
- تجاوز المهلة ⇒ **إلغاء قبل التبديل** (ABORT) — مثبت بالاختبار 5/16 (كتابة وهمية محقونة + مهلة 9s ⇒ ABORTED والقاعدة لم تُلمس).
- تصريف القراءات بأفضل جهد (3s) قبل `disconnect`.

## 5. Session Epoch (`src/lib/session-epoch.ts` + `auth.ts`)

- عدّاد في `VAR_DIR/auth/session-epoch` — **لا علاقة إطلاقًا بـ NEXTAUTH_SECRET** (لا يقرؤه ولا يدوّره).
- JWT يحمل `epoch` لحظة الدخول؛ كل استدعاء يقارن بالحالي — مخالفة ⇒ حذف كل ادعاءات التوكن ⇒ 401 حقيقي (لا «مستخدم شبح»).
- **Restore ناجح ⇒ +1، Rollback ناجح ⇒ +1**، وفشل الرفع المستمر ⇒ RECOVERY_REQUIRED (fail-closed).
- fail-safe مثبت: تالف/overflow/مفقود ⇒ null ⇒ الجلسات الحية تموت + رفض دخول جديد + حجب كتابة؛ لا تهيئة تلقائية منتصف التشغيل (التهيئة عند الإقلاع فقط إذا غاب الملف).

## 6. التبديل الذري + WAL/SHM (`src/lib/restore-server.ts`)

التسلسل الحرفي كما وافق عليه المستخدم:
1. صيانة حجب كامل (SWAPPING — القراءة والكتابة 503).
2. `PRAGMA wal_checkpoint(TRUNCATE)` عبر اتصال قصير (دمج كل بيانات WAL في الملف الرئيسي) ثم إزالة `-wal`/`-shm` المتبقية.
3. فك `database.db` من ZIP المرشحة إلى **staging داخل مجلد القاعدة نفسه** (نفس filesystem) + SHA-256 على الذاكرة وعلى القرص مقابل Manifest.
4. `rename` ذري (قديم → `.replaced`، مرشحة → مسار القاعدة) — فشل الثاني ⇒ عكس الأول فورًا.
5. `reconnectDb()` (عميل Prisma جديد — `db` صار `export let` بـ ESM live bindings لعدم بقاء handle على inode القديمة) + `PRAGMA journal_mode=WAL`.

## 7. Pre-Restore Backup إلزامية بلا bypass

- قبل أي تبديل: `createBackup(backupType="pre-restore")` → VALIDATED → Drill → **RESTORE_VERIFIED**، وإلا إلغاء — لا bypass حتى للمدير (مثبت بالاختبار 5: فشل محقون ⇒ ABORTED، productionUntouched=true).

## 8. القبول والتحقق البعدي

- المرشحة: **RESTORE_VERIFIED فقط + canonical متوافق مع الثابت المثبت** (`csha256:bffa0261…` من 4A.1) — إعادة تحقق فعلي من الحزمة داخل العملية (checksum + integrity + schema)، وأي مخطط غريب يُرفض 422 قبل أي لمس (اختبار 4).
- التحقق البعدي **مباشرة على القاعدة بلا HTTP** (7 فحوص): ترويسة SQLite من القرص · integrity_check · canonical fingerprint == المثبت · `prisma migrate status` (عملية فرعية) · قراءة Prisma للجداول الخمسة + counts == Manifest · periodRange · مستخدم صالح ≥ 1.

## 9. التراجع وRECOVERY_REQUIRED

- فشل أي فحص بعد التبديل ⇒ **بقاء في الصيانة** + تراجع تلقائي إلى pre-restore (المسحوبة Drill لها) بنفس آلية التبديل + **نفس الفحوص على المرجعة** + epoch+1 ⇒ ROLLED_BACK ⇒ NORMAL (اختبارات 8/9).
- فشل التراجع ⇒ **RECOVERY_REQUIRED**: قفل كامل 503/503، لا reset تلقائي، استرداد عبر `scripts/restore-operator.ts --verify-and-clear` (فحص كامل ثم epoch+1 ثم مسح — فشل أي فحص ⇒ لا مسح؛ ملف تالف يتطلب `--confirm-manual-verification`).

## 10. Crash Recovery عند الإقلاع (عملية حقيقية)

- `src/instrumentation.ts`: عند الإقلاع — bootstrap epoch (إن غاب) + `startupRecoveryCheck`: أي حالة غير NORMAL باقية ⇒ **RECOVERY_REQUIRED صريح** + حدث في السجل الخارجي. **restart لا يعني نجاحًا أبدًا**.
- الإثبات بقتل حقيقي: `SIGKILL` محقون للعملية (نقاط `SWAP_STARTED_CRASH`/`SWAP_COMPLETED_CRASH`) ⇒ موت الخادم فعليًا ⇒ إعادة تشغيل عملية `next dev` جديدة ⇒ الإقلاع في RECOVERY_REQUIRED بـ `originalState=SWAPPING` (اختباران 11/12 — ليس exception داخل نفس العملية).

## 11. القفل والتأكيدات والسجل

- قفل خارجي O_EXCL بـ operationId/pid — عملية ثانية ⇒ **409 RECOVERY_OPERATION_IN_PROGRESS** (اختبار 15: استعادتان متزامنتان عبر stall).
- تأكيد خادمي: `confirmationText === "RESTORE"` حرفيًا + تأكيد ثانٍ (معرف النسخة كاملًا) عند «أقدم من آخر نشاط ∨ تقليل التقارير» — **الخادم يعيد الاشتقاط بنفسه** (مثبت على الإنتاج في 4B.2: محاولة بلا تأكيد ثانٍ ⇒ REJECTED + ABORTED + productionUntouched=true).
- السجل الخارجي: تسلسل حرفي بـ operationId واحد — `RESTORE_STARTED → CANDIDATE_VERIFIED → PRE_RESTORE_STARTED/VERIFIED → MAINTENANCE_ENTERED → DRAIN_COMPLETED → DB_DISCONNECTED → SWAP_STARTED → SWAP_COMPLETED → POST_VERIFY_STARTED → RESTORE_COMPLETED | ROLLBACK_STARTED→ROLLBACK_COMPLETED | RECOVERY_REQUIRED` — append-only بلا أي endpoint تعديل/حذف، بلا أسرار ولا بيانات مالية. سياسة المحاسبة الموثقة: AuditLog يُكتب قبل التبديل وصفًا واحدًا بعد النجاح، والسجل الخارجي هو **الدليل الحاكم** لأن AuditLog يرجع تاريخيًا مع القاعدة.

## 12. Fault Injection — للاختبار حصرًا

- قناة ملف فقط (`VAR_DIR/test/fault-injection.json`) — **لا HTTP API إطلاقًا**، وبوابة مزدوجة: `RECOVERY_FAULT_INJECTION=1` ∧ `NODE_ENV≠production` — خارجها كل الدوال no-op حرفيًا.
- الأنماط: `fail` (فشل منظم) · `crash` (SIGKIL فوري) · `stall` (نافذة فحص سلوكي) + مهلات مختصرة + كتابات وهمية للتصريف.
- على الإنتاج: المتغيران غير مضبوطين + `RESTORE_ENGINE_ENABLED` كان مغلقًا خلال 4B.1 (انحدار الإنتاج أثبت 409 RESTORE_ENGINE_DISABLED).

## 13. مصفوفة الاختبارات التدميرية (18 سيناريو + إضافات) — على clone معزول بالكامل

بيئة معزولة كليًا: قاعدة من migrations في `var/test/4b1/run-*/db/test.db`، VAR_DIR خاص، خادم `next dev -p 3101` بـ `RESTORE_ENGINE_ENABLED=1` + `RECOVERY_FAULT_INJECTION=1` — **قاعدة التشغيل لم تُلمس إطلاقًا**.

تشغيلان مستقلان كاملان: `run-20260920T122448` (71/71) و**`run-20260920T125457` (71/71 — أدلة هذا الالتزام)**.

| # | السيناريو | النتيجة | الدليل |
|---|-----------|---------|--------|
| 1 | restore ناجح A→B عبر API الفعلي | ✅ | COMPLETED + الإنتاج أصبح A + تسلسل 11 حدثًا بعملية واحدة |
| 2 | فشل pre-restore backup | ✅ | ABORTED قبل أي تبديل + NORMAL |
| 3 | candidate غير RESTORE_VERIFIED | ✅ | 409 CANDIDATE_NOT_RESTORE_VERIFIED + NORMAL |
| 4 | canonical mismatch (تلاعب بالمخطط) | ✅ | 422 SCHEMA_UNKNOWN قبل أي لمس للإنتاج |
| 5 | drain timeout | ✅ | ABORT قبل التبديل (كتابة وهمية + مهلة 9s) |
| 6 | فشل disconnect | ✅ | ABORTED نظيف + NORMAL |
| 7 | فشل swap قبل rename | ✅ | ABORTED + صفر بقايا staging |
| 8 | فشل post-verify بعد swap | ✅ | ROLLING_BACK (POST_VERIFY_INTEGRITY محقون) |
| 9 | rollback ناجح | ✅ | القاعدة عادت حرفيًا + epoch+1 + NORMAL + أحداث ROLLBACK |
| 10 | rollback فاشل | ✅ | RECOVERY_REQUIRED (503/503) + استرداد المشغّل الموثق |
| 11 | crash بعد SWAP_STARTED | ✅ | SIGKIL حقيقي → إقلاع عملية جديدة → RECOVERY_REQUIRED (originalState=SWAPPING) |
| 12 | crash بعد SWAP_COMPLETED | ✅ | RECOVERY_REQUIRED + المشغّل يثبت أن الإنتاج = المرشحة المستبدلة فعلًا |
| 13 | ملف maintenance state تالف | ✅ | fail-closed + المسح يتطلب تأكيدًا بشريًا صريحًا |
| 14 | epoch تالف/overflow/مفقود | ✅ | جلسة حية تموت 401 + رفض دخول + استرداد بقيمة جديدة كبيرة |
| 15 | استعادتان متزامنتان | ✅ | الثانية 409 RECOVERY_OPERATION_IN_PROGRESS |
| 16 | كتابة أثناء DRAINING | ✅ | 20/20 مسارًا ⇒ 503 MAINTENANCE_MODE |
| 17 | قراءة/كتابة أثناء SWAPPING | ✅ | 503 FULL_BLOCK (قراءة وكتابة) |
| 18 | جلسة JWT قديمة بعد restore | ✅ | ميتة (epoch) + الدخول الجديد يعمل |
| + | العودة للحالة الأحدث عبر المحرك | ✅ | COMPLETED + تقريران موسومان + integrity ok |

## 14. انحدار الإنتاج (عبر HTTP فعلي على 3000) — 13/13

الحراس شفافون في NORMAL (كتابة طبيعية 201) · epoch في JWT · دورة 4A كاملة تعمل (نسخة+Drill) · POST restore ⇒ 409 RESTORE_ENGINE_DISABLED خلال 4B.1 · نظافة شرعية · integrity ok.

## 15. إعلان البوابة

**بوابة 4B.1 اجتازت بالكامل**: 71/71 معزول × تشغيلين · 59/59 حماية مسارات · 20/20 حجب سلوكي أثناء DRAINING · 13/13 انحدار إنتاج · lint نظيف.
النجاح معرّف بالتسلسل الحرفي: `Candidate verified → Pre-Restore RESTORE_VERIFIED → Drain → Disconnect → Atomic Swap → Post-Verification → Session Epoch Increment → NORMAL` — وفشل ما بعد swap: `Rollback → Post-Verify → Epoch Increment → NORMAL` — وفشل التراجع: `RECOVERY_REQUIRED`.

**التوقف عند هذا الحد** — بدء 4B.2 (تفعيل المحرك على التشغيل + اختبار الاستعادة الكامل) تم بعد تسجيل هذه البوابة والتزامها (commit `bfbbb73`).
