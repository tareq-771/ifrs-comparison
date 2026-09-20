# Phase 4B.2 Report — Full Production Recovery Test (A/B عبر API الحقيقي)

**التاريخ:** 2026-09-20 · 13:18:25 → 13:20:33 UTC
**Commits:** 4B.1 = `bfbbb73` · 4B.2 = (هذا الالتزام)
**الشرط المسبق:** بوابة 4B.1 اجتازت بالكامل (تشغيلان مستقلان 71/71) — وثيقة `docs/phase4b1-report.md`.
**التفعيل:** `RESTORE_ENGINE_ENABLED=1` في `.env` (خارج Git) + إعادة تشغيل خادم dev — باب 4B.2 المفتوح بموافقة المستخدم.

---

## 0) القواعد الملزمة الملتزم بها

- **كل شيء عبر API/محرك الاستعادة الحقيقي على المنفذ 3000** — صفر استبدال يدوي لملفات DB (اللمس الوحيد للملفات: قراءة عدّاد epoch كدليل، و`PRAGMA integrity_check` للقراءة فقط).
- Dataset موسومة A ثم B، نسخ رسمية تصل RESTORE_VERIFIED، جلسة JWT محفوظة من B، استعادتان حقيقيتان، تنظيف شرعي، integrity نهائي.

## 1) الحالة الأساسية + Safety Backup

| البند | القيمة |
|---|---|
| الحالة | NORMAL · epoch متاح · المحرك مفعّل (4B.2) |
| integrity_check قبل البدء | **ok** |
| epoch الابتدائي | **2** |
| Safety Backup إضافية | `bk-20260920T131825Z-u39yib` — RESTORE_VERIFIED (Drill ناجح) |

## 2) Dataset A → Backup A

- المجموعة `cmu9udrfp0028pc6ke51najt4` + التقرير `cmu9udrgk002bpc6kom4tmc9w` («تقرير 4B2-DatasetA رقم 1») عبر POST /api/groups و/api/reports.
- **Backup A = `bk-20260920T131926Z-6zfx0v`** — أنشئ وتحقق تلقائيًا ثم Drill ⇒ **RESTORE_VERIFIED**.

## 3) التحول شرعيًا إلى Dataset B → Backup B

- حذف Dataset A بـ DELETE عبر API (شرعي)، ثم مجموعة + تقريران موسومان «4B2-DatasetB رقم 1/2».
- **Backup B = `bk-20260920T132026Z-xv4puf`** — **RESTORE_VERIFIED**.

## 4) جلسة JWT من حالة B

- جلسة مستقلة (كوكيز مستقلة) دخلت في حالة B وحُفظت — كانت صالحة قبل الاستعادة (whoami يرجع المستخدم).

## 5) Restore A — عبر المسار الحقيقي

| البند | القيمة |
|---|---|
| operationId | **`op-restore-20260920T132027Z-78ap6a`** |
| التوقيت | 2026-09-20T13:20:27.594Z |
| التأكيدات | `RESTORE` + التأكيد الثاني (مشتق من restore-preview: أقدم من النشاط الحالي + تقليل التقارير — تحقق خادمي) |
| Pre-Restore Backup | **`bk-20260920T132028Z-elz5sj`** (أُنشئت داخل العملية → Drill → RESTORE_VERIFIED قبل أي تبديل) |
| النتيجة | **COMPLETED** في 2.3s — كل الفحوص البعدية السبعة ناجحة |

## 6) إثبات أن الإنتاج أصبح A فعلًا

- قائمة التقارير بعد إعادة الدخول: **«تقرير 4B2-DatasetA رقم 1» حصرًا** (تقرير واحد) — بيانات B اختفت.
- Dashboard read 200 بعد التبديل — القراءات تعمل على القاعدة المستبدلة.

## 7) إبطال جلسة B القديمة (Session Epoch)

| epoch | القيمة |
|---|---|
| قبل Restore A | 2 |
| بعد Restore A | **3** (+1) |
| جلسة B القديمة | **ميتة** — whoami لا يرجع مستخدمًا (401) |
| الدخول الجديد | يعمل بعد epoch+1 |

## 8) بقاء External Recovery Log رغم رجوع DB تاريخيًا

- السجل الخارجي (`var/recovery/recovery-log.jsonl`، خارج القاعدة المستبدلة) يحمل **التسلسل الحرفي الكامل (11 حدثًا) بعملية واحدة**: `RESTORE_STARTED → MAINTENANCE_ENTERED → CANDIDATE_VERIFIED → PRE_RESTORE_STARTED → PRE_RESTORE_VERIFIED → DRAIN_COMPLETED → DB_DISCONNECTED → SWAP_STARTED → SWAP_COMPLETED → POST_VERIFY_STARTED → RESTORE_COMPLETED`.
- أحداث Safety Backup ونسختي A/B وDrill كلها باقية (قراءة عبر `/api/backups/recovery-log` — نفس ما تعرضه الواجهة).

## 9) العودة إلى NORMAL

- `/api/system/status` بعد Restore A: **NORMAL** (قراءتان مستقلتان) — خروج طبيعي من الصيانة بعد نجاح التحقق ورفع epoch.

## 10) Restore B — العودة إلى الحالة الأحدث عبر نفس الآلية

| البند | القيمة |
|---|---|
| operationId | **`op-restore-20260920T132030Z-h0yo6s`** |
| التوقيت | 2026-09-20T13:20:30.479Z |
| Pre-Restore Backup | **`bk-20260920T132030Z-m8p4sv`** → RESTORE_VERIFIED |
| النتيجة | **COMPLETED** في 2.1s |
| الإنتاج بعدها | **«تقرير 4B2-DatasetB رقم 2» + «رقم 1» حرفيًا** (تقريران موسومان B) |
| epoch | 3 → **4** (+1 بعد Restore B) |
| الحالة | NORMAL |
| السجل | 11 حدثًا كاملة بعملية B (بما فيها PRE_RESTORE الجديد) |

## 11) التنظيف الشرعي

- حذف تقريري B ومجموعته عبر DELETE /api/reports/{id} و/api/groups/{id} (مسارات التطبيق العادية) ⇒ **صفر تقارير** — الحالة كما كانت قبل الاختبار تمامًا.

## 12) الحالة النهائية للDB

- **integrity_check = ok** (Prisma مباشر على `db/custom.db`).
- NORMAL · epoch = 4 · المحرك مفعّل · صفر تقارير/مجموعات اختبار متبقية.

## 13) أدلة إضافية من محاولات التشغيل الأولى (قبل التشغيل الناجح)

1. **13:10:09** (`op-restore-…-jnzvt5`): محاولة استعادة بلا التأكيد الثاني ⇒ الخادم رفضها فورًا (`RESTORE_REJECTED: SECOND_CONFIRMATION_REQUIRED` — سببا التراجع: تقليل تقارير + أقدم من النشاط) ⇒ `RESTORE_ABORTED · productionUntouched=true` — **إثبات حي أن التأكيد الخادمي لا يُتجاوز**.
2. **13:16:38** (`op-restore-…-1w94ng`): استعادة A أولى اكتملت فعليًا (تسلسل كامل + epoch 1→2) قبل أن يتعطل سكربت الاختبار عند طباعة نتيجته (خطأ تسمية في السكربت نفسه، لا في المحرك) — نُظفت آثارها شرعيًا عبر API ثم أعيد التشغيل النظيف الموثق أعلاه. هذا التشغيل المتقطع أثبت لاحقًا أن القاعدة المستعادة تقبل الكتابة/الحذف عبر API (حذف Dataset A بنجاح).

## 14) التحقق البصري E2E (Agent Browser على 3000)

- تسجيل دخول المدير → `/admin`: ثلاثة تبويبات (المستخدمون / **سجل التدقيق** / **النسخ الاحتياطي**).
- **تمييز السجلين واضح في الواجهة**: تبويب التدقيق بعنوان «سجل التدقيق التطبيقي (Application Audit Trail)» مع ملاحظة رقابية صريحة: «عند استعادة قاعدة التشغيل إلى نسخة أقدم يرجع هذا السجل تاريخيًا مع القاعدة — أحداث الاستعادة الحاكمية في سجل عمليات الاسترجاع (Recovery Operations Log) الخارجي».
- تبويب النسخ الاحتياطي: السجل الخارجي يعرض operationIds الحقيقية لعمليتي 4B.2 (24 حدث استعادة)، والنسختان pre-restore ظاهرتان بشارة Manifest v3 والبصمة القاعدية `c:bffa026102bc` وأزرار استعادة.
- حوار الاستعادة: مقارنة «المرشحة ↔ الحالة التي ستفقد» + تأكيد `RESTORE` + تنبيه التأكيد الثاني — **فُتح للمعاينة وأُلغي دون تنفيذ**.
- صفر أخطاء console/page · الجوال 390×844 سليم · التذييل ملتصق بأسفل الصفحة طبيعيًا (footer.bottom = pageHeight).

## 15) الأدلة المحفوظة

- `var/test/4b2/evidence-20260920T131825.json` — 27/27 فحصًا بكل operationIds وtimestamps وقيم epoch.
- `var/test/4b1/run-20260920T125457/evidence.json` — مصفوفة 4B.1 التدميرية 71/71.
- `var/recovery/recovery-log.jsonl` — 109 أحداث تشمل كل عمليات 4A/4B.1/4B.2 append-only.
- لقطات شاشة: `var/test/evidence-screens/`.

## 16) معيار النجاح — تحقق حرفي

> Candidate verified → Pre-Restore RESTORE_VERIFIED → Drain → Disconnect → Atomic Swap → Post-Verification → Session Epoch Increment → NORMAL

✅ لكل من Restore A وRestore B (تسلسل أحداث موثق بعملية واحدة لكل منهما).
> إذا حدث فشل بعد swap: Rollback → Post-Verify rollback → Epoch Increment → NORMAL

✅ مُثبت في 4B.1 (اختباران 8/9 على المعزول) — لم يلزم في 4B.2 (لا فشل بعدي على الإنتاج).
> إذا فشل Rollback: RECOVERY_REQUIRED

✅ مُثبت في 4B.1 (اختبار 10) مع مسار استرداد المشغّل الموثق.

---

**التوقف الكامل هنا — لا Deployment ولا Server Hardening حتى مراجعة المستخدم.**
