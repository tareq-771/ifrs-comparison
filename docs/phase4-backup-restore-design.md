# Phase 4 — النسخ الاحتياطي والاستعادة والاسترجاع التشغيلي
## Backup, Restore & Operational Recovery — وثيقة تصميم v2 (لا تنفيذ)

> **الحالة**: تصميم معدّل وفق القرارات المعتمدة من المستخدم (D-1..D-10 المعدلة + الإضافات الإلزامية: Restore Drill، مستويات التحقق الثلاثة، آلة حالات الاستعادة، مصفوفة الفشل/التراجع، RECOVERY_REQUIRED، Session Epoch). **لا تنفيذ بعد — بانتظار الموافقة النهائية على هذا الملخص.**
>
> **سجل التغيير عن v1** (المراجعة الأولى بعد الموافقة المبدئية):
> 1. **D-2 معدل**: فصل `BACKUP_DIR` القابل للتهيئة عن مجلد التطبيق — المعمارية لا تفترض أن النسخ داخل source tree أبدًا.
> 2. **D-3 معدل جوهريًا**: لا ترحيل تلقائي على قاعدة التشغيل أبدًا — ترحيل نسخة أقدم يُجرى على **نسخة مؤقتة** عبر Restore Drill، والناتج يصبح Candidate للتبديل. النسخ الأحدث من المخطط: **رفض**. المخطط غير المعروف: **رفض**.
> 3. **D-7 معدل جوهريًا**: فصل إدارة الأسرار عن إبطال الجلسات — **Session Epoch** في ملف خارج قاعدة البيانات بدل تدوير NEXTAUTH_SECRET عند كل استعادة. السر يُثبّت قويًا مرة واحدة (D-10) ولا يدخل أي نسخة/سجل.
> 4. **D-9 مشدد**: تسلسل صريح: enter maintenance → drain writes → disconnect Prisma → atomic swap → reconnect/restart → post-verify → session invalidation → exit maintenance، وإيقاف القراءة أيضًا في نافذة التبديل بدل المخاطرة بها.
> 5. **جديد**: Restore Drill (وظيفة أساسية في النظام)، مستويات التحقق CREATED/VALIDATED/RESTORE_VERIFIED، مصفوفة فشل/تراجع بحالة RECOVERY_REQUIRED، سجل الاسترجاع بحقول eventId/operationId إلزامية، أمن رفع ZIP (zip-slip/الحدود المضغوطة/عدد الملفات)، سيناريو Recovery Test الإلزامي.
>
> **الالتزامات الثابتة**: لا تعديل على accounts.ts/Workflow/Dashboard/محرك المطابقة. لا حذف تلقائي للنسخ. Git الحالي والنسخ القائمة محفوظة — أي commit قادم append-only فقط.

---

## القسم 1 — جرد المشروع الحقيقي: ما الذي يجب نسخه فعلًا (بالأدلة، من v1 ولم يتغير)

| # | المكوّن | الحقيقة المفحوصة | يدخل النسخة؟ |
|---|---|---|---|
| 1 | `db/custom.db` | ~1.4MB، WAL، 5 جداول (User/Group/Report/WorkflowHistory/AuditLog)، integrity ok | **نعم — قلب النسخة** |
| 2 | `-wal`/`-shm` | sidecars متغيرة | لا كملفات — تُدمج تلقائيًا عبر VACUUM INTO |
| 3 | مرفوعات المستخدمين | **صفر استدعاءات fs.write وصفر multipart في src كاملة** — محتوى الملفات JSON داخل أعمدة Report | مغطاة داخل DB |
| 4 | إعدادات غير سرية | `BUSINESS_TZ_OFFSET_MINUTES` | قيمها في Manifest |
| 5 | الأسرار | `.env` (DATABASE_URL فقط حاليًا — لا NEXTAUTH_SECRET مثبت) | **لا** — إجراء تشغيلي منفصل + بصمة غير سرية |
| 6-9 | public/Git/سجلات/node_modules | كود وبناء وسجلات متطايرة | لا |
| 10 | النسخ القائمة | `backups/pre-3.5A-2026-09-20T04-07-58.db` (يبقى مكانه **دون حذف أو نقل**) + درس فقدان `/home/z/backups/` | محفوظة كما هي |

**الخلاصة**: نسخة متسقة من `custom.db` + Manifest تغطي 100% من بيانات النظام. ملاحظة أمنية باقية: `/api/setup` ينشئ مديرًا افتراضيًا (admin/admin123) إذا كانت users=0 — يُنذر في sanity check (7.8) ويعالج في الإجراءات البعدية.

**ملاحظة نسخ قديمة**: ملفات ما قبل Phase 4 بلا Manifest — لا تُدرج في قائمة النسخ الجديدة (تظل على القرص كما هي دون أي مساس، وتظل متتبعة في git كما كانت).

---

## القسم 2 — النسخ المتسق: VACUUM INTO (ثابت من v1)

- **مرفوض**: نسخ filesystem مباشرة (خطر WAL الممزق).
- **معتمد**: `VACUUM INTO` — snapshot قراءة متسقة، متوفر في bun:sqlite ومجرَّب في المشروع (backup-35.ts)، بلا تصادم checkpoint مع Prisma، ونتيجته مضغوطة.
- خط الإنشاء: اسم خادمي فريد → VACUUM INTO → integrity_check على النسخة → SHA-256 → كتابة Manifest → فشل أي خطوة ⇒ حذف الجزئي + BACKUP_FAILED.
- النسخ تُنشأ دون إيقاف النظام (قراءة متسقة لا تحجب الكتابة).

---

## القسم 3 — المعمارية النهائية وفصل المسارات (D-2 معدل)

### 3.1 فصل صارم: مجلد التطبيق ≠ مجلد بيانات النسخ

```
┌─ Application directory (كود — يستبدل/يتغير بحرية) ─────────────┐
│  src/ prisma/ db/custom.db  public/  ...                       │
│  ❌ لا يحتوي أي نسخة احتياطية في المعمارية الجديدة             │
└─────────────────────────────────────────────────────────────────┘
┌─ Backup data directory — BACKUP_DIR (مستقل، قابل للتهيئة) ────┐
│  ifrs-full-<UTC>-<id>.zip        النسخ الرسمية                 │
│  ifrs-full-<UTC>-<id>.manifest.json  (ملف جانبي متزامن)        │
│  ifrs-pre-restore-<UTC>-<id>.(zip|manifest)                    │
└─────────────────────────────────────────────────────────────────┘
┌─ var/ — حالة تشغيلية خارجة عن Git (تُتجاهل للأمام فقط) ───────┐
│  var/restore-staging/     مرفوعات/مرحلات/نواتج Drill — تُمسح   │
│  var/recovery/recovery-log.jsonl  سجل الاسترجاع الخارجي        │
│  var/auth/session-epoch   عدد صحيح — Session Epoch (قسم 15)    │
│  var/maintenance.json     علم الصيانة ومستواها                 │
└─────────────────────────────────────────────────────────────────┘
```

- **الدلالة المعمارية الإلزامية**: كل الكود يصل للنسخ عبر `resolveBackupDir()` التي تقرأ `BACKUP_DIR` من البيئة. **لا يوجد أي مسار كود يفترض أن النسخ داخل source tree** — النشر الإنتاجي قد يشير إلى `/srv/ifrs-backups` أو وسيط شبكة دون تعديل سطر واحد.
- **الافتراضي في بيئة التطوير الحالية**: `BACKUP_DIR=<projectRoot>/var/backups` — داخل مساحة العمل الدائمة (الدرس الموثق: `/home/z/` فُقد والمشروع بقي) — لكنه **افتراضي قابل لل Override لا اعتماد معماري**.
- `var/` و`backups/` يُضافان إلى `.gitignore` **للأمام فقط** (لا `git rm` ولا إعادة كتابة — الملف القديم المتتبع يظل كما هو دون مساس؛ إزالته من التتبع مستقبلًا قرار مستقل يُعرض عند الحاجة).
- كل المجلدات: أذونات `0700`، الملفات `0600`، جميعها **خارج `public/`** — التنزيل عبر API بفحص صلاحية حصرًا.

### 3.2 المعمارية الوظيفية النهائية

```
المتصفح (صلاحيات manageBackups/restoreDatabase فقط)
   │  تبويب «النسخ الاحتياطي والاستعادة» في /admin
   ▼
API Layer (server-side حصرًا — لا مسارات قرص من العميل)
   GET/POST /api/backups            القائمة (من Manifestات) / إنشاء
   GET /api/backups/[id]            تفاصيل Manifest
   GET /api/backups/[id]/download   تنزيل ZIP (stream)
   POST /api/backups/[id]/drill     Restore Drill (لا يمس التشغيل)
   POST /api/backups/restore/validate   رفع + تحقق + (Drill للمخطط الأقدم) → Candidate
   POST /api/backups/restore/execute    آلة حالات الاستعادة الكاملة
   GET /api/system/status           حالة الصيانة (عام — للشريط)
   GET /api/backups/recovery-log    قراءة فقط آخر N حدثًا
   ▼
Backup/Restore Service (lib/backup-server.ts + restore-server.ts)
   createBackup · validateBackup · runRestoreDrill · executeRestore
   maintenance guard · session epoch · recovery log writer
   ▼
BACKUP_DIR (ZIP+manifest)   var/staging   var/recovery   var/auth
                                    ▼
                     قاعدة التشغيل db/custom.db
              (لا تُستخدم أبدًا مكانًا لتجربة migration)
```

---

## القسم 4 — صيغة Manifest v2 (قرار المستخدم: الحقول الإلزامية العشرة + periodRange)

```json
{
  "formatVersion": 2,
  "backupId": "bk-20260920T060000Z-x7k2m9",
  "backupType": "manual | pre-restore | replaced",
  "appVersion": "1.0.0",
  "schemaVersion": "v4-phase3.5B",
  "schemaFingerprint": "sha256:...",
  "createdAt": "2026-09-20T06:00:00.000Z",
  "createdBy": { "id": "cuid...", "username": "admin" },

  "database": {
    "filename": "database.db",
    "sha256": "64-hex...",
    "bytes": 1400832,
    "pageSize": 4096,
    "integrityCheck": "ok",
    "journalModeAtBackup": "wal"
  },

  "counts": { "users": 1, "groups": 0, "reports": 0, "auditLog": 0, "workflowHistory": 0 },
  "periodRange": { "minPeriodEnd": null, "maxPeriodEnd": null },
  "dataRange": { "oldestCreatedAt": "...", "newestUpdatedAt": "..." },

  "environment": { "businessTzOffsetMinutes": 180, "configFingerprint": "sha256:غير-سرية" },

  "verification": { "level": "CREATED | VALIDATED | RESTORE_VERIFIED", "validatedAt": null, "drillAt": null }
}
```

قواعد:
- **`createdBy` وصفية فقط — لا تُستخدم أبدًا للتحقق الأمني** (قرار المستخدم حرفيًا). التحقق = checksum + fingerprint + سلامة بنية.
- **`databaseSha256` و`databaseBytes` للـ database.db داخل الـ ZIP** — الصلاحية تُشتق من المحتوى والـ Manifest، **لا من اسم ZIP أو اسم الملف المرفوع** (D-1).
- `periodRange` يُحسب استعلامًا تجميعيًا واحدًا رخيصًا على `periodEnd` (MIN/MAX) — متطلب «إن أمكن دون تكلفة كبيرة» متحقق.
- `schemaFingerprint`: hash جرد (جدول، عمود) من sqlite_master/PRAGMA table_info — **مع استثناء جدول `_prisma_migrations` الداخلي** من الجرد (كي لا تتغير البصمة بعد اعتماد migrations).
- الـ ZIP الرسمي يحوي إلزاميًا: `database.db` + `manifest.json` (D-1). على القرص يُخزن الـ ZIP + manifest.json جانبيًا (القائمة تقرأ الجانبي سريعًا؛ الـ ZIP هو أداة النقل/الأرشفة).

---

## القسم 5 — مستويات التحقق الثلاثة + Restore Drill (إضافة إلزامية من المستخدم)

### 5.1 المستويات (لا يظهر للمستخدم كلمة «متحقق» لمجرد integrity_check)

| المستوى | معناه | ما يمنحه |
|---|---|---|
| **CREATED** | تم إنشاء الملف وManifest | يظهر في القائمة فقط |
| **VALIDATED** | checksum SHA-256 مطابق + فتح SQLite سليم + integrity_check ok + مخطط معروف + الجداول المطلوبة | مرشح للاستعادة (بمخطط مطابق للحالي) |
| **RESTORE_VERIFIED** | نُفذ Restore Drill كامل على DB مؤقتة (شامل migrations إن لزم + Prisma read tests + counts/business sanity) بنجاح | مرشح للاستعادة بأي مخطط معروف أقدم + أعلى درجة ثقة |

- المستوى يُحفظ في `manifest.verification.level` مع الطوابع الزمنية. رفع المستوى عمل خادمي وحده.
- إنشاء نسخة جديدة يشغل التحقق الداخلي تلقائيًا فور الإنشاء (CREATED → VALIDATED خلال ثوانٍ إن سلمت).
- **VALIDATED لا يرفع إلى RESTORE_VERIFIED تلقائيًا** — الـ Drill إجراء مستقل صريح.

### 5.2 Restore Drill — وظيفة أساسية في النظام (ليست اختبارًا يدويًا خارجيًا)

```
Backup ZIP → فك في temp (بضوابط القسم 17) → التحقق من checksum
   → نسخ database.db إلى DB مؤقتة في staging
   → [مخطط أقدم؟] تطبيق migrations على المؤقتة فقط (تسلسل من سجل الإصدارات)
   → PRAGMA integrity_check
   → فتح Prisma Client على المؤقتة (datasourceUrl override)
   → Prisma read tests: user/group/report/workflowHistory/auditLog counts + قراءة عينات
   → counts/business sanity (مقارنة مع Manifest + users=0 تنبيه)
   → النتيجة: RESTORE_VERIFIED في الـ Manifest + تقرير Drill مفصل
```

- **لا يمس قاعدة التشغيل إطلاقًا** — كله في staging، والاتصال Prisma المؤقت يُغلق ويدمَّر في finally.
- يستدعى: (أ) يدويًا بزر في الواجهة لأي نسخة VALIDATED، (ب) **إلزاميًا** كجزء من تدفق استعادة نسخة بمخطط أقدم (D-3) — ناتج الـ Drill المؤقت **هو نفسه** الذي يصبح Candidate (لا نرحّل مرتين).
- تقرير Drill يُحفظ في `staging/drill-<opId>.json` ويُلخص في الواجهة (عدّ الجداول، مدة كل مرحلة، نتيجة كل فحص).

---

## القسم 6 — السجل التشغيلي الخارجي v2 (Operational Recovery Log)

### 6.1 الحقول الإلزامية لكل سجل (قرار المستخدم)

```json
{
  "eventId": "evt-01HZX...",
  "timestamp": "2026-09-20T06:05:11.234Z",
  "operationId": "op-restore-20260920T060455Z-k3m9x",
  "event": "RESTORE_STAGE",
  "actor": { "id": "cuid...", "username": "admin" },
  "backupId": "bk-...",
  "result": "success | failure | aborted | info",
  "details": { "stage": "PRE_BACKUP", "preRestoreBackupId": "...", "sizeBytes": 1400832 }
}
```

- **`operationId`** يولد عند بدء كل عملية (نسخ أو استعادة) ويحضر في **كل** أحداثها حتى النهاية — يجعل عملية Restore واحدة قابلة للتتبع من البداية للنهاية (متطلب المستخدم حرفيًا).
- أحداث الاستعادة تُصدر حدث `RESTORE_STAGE` لكل مرحلة من آلة الحالات (VALIDATE/PRE_BACKUP/MAINTENANCE/SWAP/VERIFY/EPOCH/EXIT) + حدث الحسم النهائي (RESTORE_COMPLETED/FAILED/ROLLED_BACK/RECOVERY_REQUIRED).
- **ممنوع في السجل**: أسرار، password hashes، محتوى تقارير، مسارات قرص داخلية. الـ details حقول منظمة مختصرة فقط (نفس Sanitizer).
- **Append-only على مستوى التطبيق**: كتابة بالأسطر (append + flush) — **لا يوجد أي endpoint update/delete له إطلاقًا**؛ القراءة endpoint واحد للعرض (آخر 50 حدثًا) بصلاحية manageBackups.
- الملف خارج قاعدة البيانات المستبدلة ⇒ أدلة الاستعادة تبقى موجودة بعد استبدال DB (الهدف الذي أقرّه المستخدم).
- الأكواد داخل AuditLog (للعرض داخل التطبيق) تبقى كما في v1: BACKUP_CREATED/BACKUP_FAILED/RESTORE_STARTED/RESTORE_COMPLETED/RESTORE_FAILED/RESTORE_ROLLED_BACK.

---

## القسم 7 — الصلاحيات (D-5 معتمد)

| المفتاح | يمنح | افتراضي user | admin |
|---|---|---|---|
| `manageBackups` | عرض/إنشاء/تنزيل/Drill/قراءة سجل الاسترجاع | false | ضمنيًا بالدور (نمط assignWorkflow) |
| `restoreDatabase` | رفع للتحقق + تنفيذ الاستعادة | false | ضمنيًا بالدور |

- **صريحًا**: امتلاك `settings` **لا** يمنح أيًّا من المفتاحين ولا أي شيء هنا (قرار المستخدم). فصل `restoreDatabase` عن `manageBackups` يبقى كما اعتُمد.
- كل العمليات server-side حصرًا + تدقيق. لا مسارات قرص من العميل أبدًا.

---

## القسم 8 — خط التحقق قبل الاستعادة v2 (Validation Pipeline)

يُنفذ على نسخ في `var/restore-staging/` حصرًا — قاعدة التشغيل لا تُلمس إطلاقًا في هذا الخط.

| # | الفحص | التفاصيل | كود الفشل |
|---|---|---|---|
| 1 | سلامة الـ ZIP | فتح بضوابط القسم 17 (عدد الملفات/الأسماء/الأحجام/zip-slip) | `BAD_PACKAGE` |
| 2 | Magic header | أول 16 بايت من database.db = `SQLite format 3\0` | `NOT_SQLITE` |
| 3 | الحجم | ضمن الحدود المضبوطة | `FILE_TOO_LARGE/EMPTY` |
| 4 | checksum | SHA-256 (database.db) == manifest.database.sha256 — **رفض قاطع عند عدم المطابقة** | `CHECKSUM_MISMATCH` |
| 5 | integrity | PRAGMA integrity_check = ok على النسخة المرحلية | `CORRUPT_DB` |
| 6 | الجداول المطلوبة | الخمسة موجودة | `MISSING_TABLES` |
| 7 | توافق المخطط | مقارنة schemaFingerprint مع سجل الإصدارات المعروفة — **القرار D-3 أدناه** | `SCHEMA_*` |
| 8 | Sanity أعمال | users=0 ⇒ تحذير صريح (تفعيل شاشة الإعداد الأولي admin افتراضي بعد الاستعادة) | `SANITY_WARNING` |

### 8.1 سياسة المخططات (D-3 المعدل — اعتماد نهائي)

```
fingerprint النسخة مقابل سجل الإصدارات المعروفة (KNOWN_SCHEMA_VERSIONS في الكود):
  ├─ == الحالي           → VALIDATED كافية للترشح (Drill اختياري عند الطلب)
  ├─ أقدم معروف          → إلزامي: Restore Drill (ترحيل على المؤقتة فقط + فحوص)
  │                          → نجاح ⇒ النسخة المؤقتة المرحّلة تصبح Candidate
  │                          → فشل ⇒ لا استعادة (رسالة سبب واضحة)
  ├─ أحدث من الحالي       → REJECT (SCHEMA_NEWER) — لا downgrade أبدًا
  └─ غير معروف            → REJECT (SCHEMA_UNKNOWN)
```

- **قاعدة حادة**: قاعدة التشغيل الحالية **لا تُستخدم مكانًا لتجربة migration إطلاقًا** — كل الترحيل يقع على النسخة المؤقتة قبل الترشيح.
- سجل الإصدارات المعروفة يُدار في الكود (بصمة + اسم + تسلسل migrations من ذلك الإصدار إلى الحالي) ويُحدَّث مع كل تغيير مخطط معتمد.

---

## القسم 9 — آلة حالات الاستعادة (Restore State Machine)

```
                            ┌──────────────────────────────────────────────┐
                            │  (خارج execute: مسار التجهيز — التشغيل سليم) │
                            └──────────────────────────────────────────────┘
 IDLE
  │ validate(رفع/اختيار)
  ▼
 VALIDATING ──فشل──▶ REJECTED (مسح staging + حدث REJECTED) ──▶ IDLE
  │ نجاح (+ Drill إلزامي إن مخطط أقدم: DRILLING ──فشل──▶ REJECTED)
  ▼
 CANDIDATE ──(عرض Preview + تأكيد قوي)──▶ AWAITING_CONFIRM
  │ execute(confirm صحيح)
  ▼
 PRE_RESTORE_BACKUP ──فشل الإنشاء أو التحقق──▶ ABORTED (رفع الصيانة + مسح) ──▶ IDLE
  │ نجاح + تحقق النسخة
  ▼
 MAINTENANCE_ENTERED (write-block: الكتابات 503، القراءات تعمل)
  │ drain: انتظار عداد in-flight = 0 (مهلة 30s وإلا ABORTED)
  ▼
 DISCONNECTED ──(رفع مستوى الصيانة إلى full-block: القراءة أيضًا 503)
  │
  ▼
 SWAPPING (rename ذري: قديمة→staging/replaced-*، مرشّحة→db/custom.db، مسح -wal/-shm القديمة)
  │
  ▼
 RECONNECTED (Prisma client جديد + PRAGMA journal_mode=WAL)
  │
  ▼
 POST_VERIFY (integrity + Prisma reads + مطابقة counts مع Manifest)
  │
  ├─ نجاح ──▶ SESSION_INVALIDATION (epoch += 1) ──▶ EXIT_MAINTENANCE ──▶ COMPLETED ✅
  │
  └─ فشل ──▶ ROLLING_BACK (البقاء في الصيانة full-block)
                 │ استعادة pre-restore (نفس آلية التبديل) + إعادة التحقق منها
                 ├─ نجاح ──▶ SESSION_INVALIDATION (epoch += 1) ──▶ EXIT_MAINTENANCE ──▶ ROLLED_BACK ✅
                 └─ فشل ──▶ RECOVERY_REQUIRED 🔒 (البقاء في الصيانة — لا متابعة تشغيل على قاعدة غير موثوقة)
```

قواعد آلة الحالات:
- **الحالات النهائية الثلاث**: COMPLETED، ROLLED_BACK (كلتاهما تخرج من الصيانة)، RECOVERY_REQUIRED (تبقى مقفلة).
- **لا خروج من الصيانة إلا إذا نجحت الاستعادة أو نجح الـ Rollback** (قرار المستخدم حرفيًا).
- فشل ما قبل SWAPPING ⇒ ABORTED نظيف: قاعدة التشغيل لم تُلمس إطلاقًا + رفع الصيانة + مسح المرحلي.
- epoch لا يُرفع إلا إذا اكتمل SWAPPING فعلًا (نجاح أو تراجع بعده — القاعدة: قاعدة استُبدلت ⇒ جلسات تُبطل).
- كل انتقال يُصدر حدث RESTORE_STAGE بـ operationId واحد للعملية كاملة.
- مهلة إجمالية 120 ثانية للمراحل من PRE_RESTORE_BACKUP حتى EXIT — تجاوزها ⇒ مسار الفشل المنظم (ولا يترك النظام في الصيانة إلا بمسار ROLLING_BACK/RECOVERY_REQUIRED الموثق).

---

## القسم 10 — Maintenance Mode v2 (D-9 المشدد)

### 10.1 مستويان

| المستوى | الكتابة | القراءة | متى |
|---|---|---|---|
| `write-block` | 503 MAINTENANCE_MODE | تعمل | من دخول الصيانة حتى انتهاء drain (القراءة مقبولة أثناء مراحل التحقق/العرض — قرار المستخدم) |
| `full-block` | 503 | **503 أيضًا** | من لحظة disconnect قبل التبديل حتى اكتمال التحقق البعدي وإبطال الجلسات — **نافذة التبديل لا نعتمد فيها على استمرار قراءات Prisma قديمة غير منضبطة (قرار المستخدم: نوقف القراءة بدل المخاطرة)** |

- الاستثناءات الوحيدة من الحجب: `/api/system/status` (عام — للشريط)، مسارات backup/restore نفسها (أدوات إدارة الصيانة لا تحجب نفسها — قائمة استثناء قصيرة مدققة)، `/login` والتحقق من الجلسة.
- `GET /api/system/status` يعيد `{maintenance: {level, reason, startedAt, operationId?}}` — الشريط يستطلع كل 15 ثانية وعند أي 503.

### 10.2 الآلية

1. **علم ملفي** `var/maintenance.json` {level, reason, startedAt, by, operationId} — يقرأه حارس مركزي `assertWritable()/assertReadable()` يُستدعى في **كل** endpoints الكتابة (جرد التنفيذ: 13 مسارًا كتابيًا حاليًا) وفي القراءة عند full-block.
2. **Drain**: عداد in-flight writes في عملية الخادم (يزداد داخل assertWritable، ينقص بعد إتمام المعاملة) — المرحلة تنتظر 0 بحد 30 ثانية.
3. **Disconnect**: `await db.$disconnect()` ثم التحقق من غياب مقابض (عملية واحدة معروفة تكتب) ثم مسح `-wal/-shm` المتبقية إن وُجدت.
4. **Swap ذري**: rename فقط (نقل القديمة إلى staging ثم نقل المرشحة — إما تكتمل أو يُعاد الترتيب).
5. **Reconnect**: تغيير `db.ts` إلى `export let db` + `reconnectDb()` (ESM live bindings تصل للمستوردين) — **البديل المضمون عند أي إخفاق**: إعادة تشغيل العملية (المرحلة مسماة reconnect/restart لهذا السبب). فور الإعادة: `PRAGMA journal_mode=WAL` على القاعدة الجديدة (VACUUM INTO يخرج بوضع rollback).
6. **حد نطاق موثق**: الحماية داخل عملية الخادم الواحدة (حالتنا). لا عملية خارجية تكتب اليوم (الجرد) — يوثق كحد صريح.

---

## القسم 11 — Pre-Restore Backup (إلزامي — قرار معتمد مع تشديد التحقق)

- يُنشأ **آليًا** داخل execute (مرحلة PRE_RESTORE_BACKUP) بنمط `ifrs-pre-restore-<UTC>-<id>` (ZIP+Manifest، backupType=pre-restore) **قبل أي تعديل**.
- فور إنشائه: **يُتحقق منه** (checksum + integrity) — فشل الإنشاء أو التحقق ⇒ **إلغاء الاستعادة بالكامل** قبل الدخول في الصيانة الثقيلة (قرار المستخدم: «إذا فشل إنشاء أو Validation نسخة pre-restore: ألغِ Restore بالكامل»).
- **لا bypass**: لا واجهة ولا API ولا flag يتجاوزه.
- يبقى في BACKUP_DIR كنقطة رجوع يدوية (backupType=pre-restore)، ولا تدخل في أي حذف تلقائي.

---

## القسم 12 — الفشل والتراجع: مصفوفة شاملة (Failure / Rollback Matrix)

| يفشل في | حالة قاعدة التشغيل | الإجراء | النهاية |
|---|---|---|---|
| Validate/Drill (staging) | لم تُلمس | مسح المرحلي + حدث | IDLE — إبلاغ بالسبب |
| PRE_RESTORE_BACKUP | لم تُلمس (write-block) | **إلغاء كامل** + رفع الصيانة + مسح | ABORTED → IDLE |
| Drain (مهلة 30s) | لم تُلمس (write-block) | إلغاء + رفع الصيانة | ABORTED → IDLE |
| Disconnect/Swap (خطأ I/O قبل اكتمال rename) | قد تكون أسماء ملفات جزئية | إعادة الترتيب (إرجاع الأسماء) + التحقق | ABORTED → IDLE (أو متابعة إن اكتمل التبديل فعليًا) |
| POST_VERIFY | الجديدة مكانها (full-block) | **البقاء في الصيانة** + استعادة pre-restore تلقائيًا + إعادة التحقق | ROLLED_BACK → خروج من الصيانة |
| Rollback نفسه | غير موثوقة (full-block) | **لا متابعة تشغيل إطلاقًا** | **RECOVERY_REQUIRED** — الصيانة تبقى قائمة 🔒 |
| SESSION_INVALIDATION (epoch write) | سليمة مستبدلة | إعادة محاولة + تنبيه أمني حاد (جلسات قديمة قد تبقى) + توثيق | COMPLETED بتحذير |
| EXIT (رفع العلم) | سليمة | إعادة محاولة (ملف علم) | COMPLETED |

### 12.1 حالة RECOVERY_REQUIRED (المصممة صراحة)

- النظام يبقى في full-block، يصدر حدثًا حاسمًا في سجل الاسترجاع + dev.log، ويعرض `/api/system/status`: `RECOVERY_REQUIRED` برسالة «خدمة معلقة — تدخل تشغيلي يدوي مطلوب».
- **إجراء التشغيل اليدوي الموثق في الواجهة** (خطوات نصية تعرض للمدير): تحديد أحدث نسخة pre-restore سليمة في BACKUP_DIR → إيقاف العملية → استبدال يدوي موثق → إعادة تشغيل → تشغيل فحوص. هذا مسار الطوارئ الأخير — وجوده الموثق جزء من التصميم، وإسقاط النظام إلى حالة معلنة أفضل من التشغيل على قاعدة غير موثوقة بصمت.

---

## القسم 13 — التحقق البعدي (Post-Restore Verification) — ثابت من v1 مع الدمج في آلة الحالات

1. `PRAGMA integrity_check` على المستبدلة.
2. **قراءة Prisma فعلية** للجداول الخمسة (counts + قراءة عينات) — نجاح الاستدعاءات يثبت التوافق فعليًا.
3. مطابقة counts مع Manifest للنسخة المستعادة (أي فرق يعرض في التقرير).
4. فحص fingerprint المخطط = مطابق لما أعلنه التحقق (مع الحالي أو بعد ترحيل الـ Drill).
5. النتيجة تقرير مفصل: مدة كل مرحلة، النسخة المستبدلة، pre-restore، نتيجة كل فحص.

---

## القسم 14 — التأكيد القوي قبل التنفيذ (ثابت من v1)

- عرض: تاريخ النسخة (محلي + ISO)، الحجم، checksum مختصر (12)، عدّ النسخة (المستخدمون/التقارير/المجموعات/دورات/تدقيق)، periodRange، **وجنباً إلى جنب عدّ الحالة الحالية التي ستفقد**.
- حقل إلزامي: كتابة `RESTORE` (أو backupId الكامل).
- تأكيد إضافي بكلمة مرور المشغل في الحوار نفسه (جلسة حديثة).
- الزر معطل حتى: تقرير تحقق سليم + مستوى ترشيح مكتمل (VALIDATED أو RESTORE_VERIFIED حسب المخطط) + تأكيدات مكتملة.

---

## القسم 15 — إبطال الجلسات بعد الاستعادة: Session Epoch (D-7 المعدل — تصميم جديد)

### 15.1 الفصل المطلوب (قرار المستخدم)

> **Secret management ≠ Session invalidation.**
> - `NEXTAUTH_SECRET`: سر ثابت قوي يُثبّت مرة (D-10) — **ليس أداة ندورها عند كل Restore**.
> - الإبطال: **Session Epoch** — عدّاد خادمي في ملف **خارج قاعدة البيانات المستعادة**.

### 15.2 التصميم

```
var/auth/session-epoch          ملف نصي: عدد صحيح (يبدأ 1) — خارج DB المستبدلة
        │ readSessionEpoch()    قراءة خادمية رخيصة (مع cache بطول mtime)
        ▼
src/lib/auth.ts — jwt callback:
  عند تسجيل الدخول (user حاضر):   token.epoch = readSessionEpoch()
  في كل استدعاء آخر:              token.epoch !== readSessionEpoch()
        │ نعم ⇒ «توكن ميت»: حذف role/permissions/username/id + epochInvalid=true
        ▼
session callback: token.epochInvalid (أو epoch مخالف) ⇒ session بلا user
        ▼
requireAuth/requireAdmin (Node runtime): بلا user ⇒ 401 → العميل يعيد الدخول
proxy.ts (Edge): لا يقرأ fs — حدود موثقة أدناه
```

- **لماذا ملف لا DB؟** لأن الاستبدال هو الحدث ذاته — أي عدّاد داخل القاعدة المستبدلة يرجع للماضي بالتعريف (نفس منطق سجل الاسترجاع الخارجي).
- **متى يُرفع؟** مرحلة SESSION_INVALIDATION داخل execute، **فقط إذا اكتمل SWAPPING** (نجاح أو تراجع بعده) — قاعدة لم تُستبدل لا تستوجب إبطالًا.
- **تجربة ما بعده**: كل الجلسات السابقة (بما فيها جلسات ما قبل نقطة النسخة) تنتهي فورًا — الجميع إلى `/login` برسالة «انتهت الجلسة لأسباب أمنية بعد صيانة النظام»، ويُعاد توقيع صلاحياتهم من القاعدة المستعادة نفسها (وهو المطلوب).
- **حدوثة Edge الموثقة بصراحة**: `proxy.ts` يعمل Edge ولا يقرأ filesystem — توكن قديم قد يجتاز بوابة الصفحات (غلاف الصفحة فقط)، لكن **كل** مصدر بيانات/صلاحية يمر عبر Node runtime (API routes + getServerSession) فيرفضه فورًا ⇒ مزود الجلسة في الواجهة يرى مستخدمًا فارغًا ويعيد التوجيه للدخول. لا وصول فعلي لأي بيانات بتجاوز الفحص.
- **بديل مرفوض وموثق**: عدّاد داخل DB (ينكسر بالاستبدال) — فحص DB لكل طلب (تكلفة + لا يغطي الحالة البنيوية).

### 15.3 NEXTAUTH_SECRET (D-10 منفصل تمامًا)

- يُثبّت قويًا (توليد عشوائي ≥ 64 hex) في `.env` **كمتطلب قبل 4B** — بلا تثبيته لا يوجد سير حاكم أصلًا (اليوم: مشتق داخلي في dev).
- **لا يدخل**: Backup ZIP، Manifest، API responses، AuditLog، Recovery Log (قرار المستخدم حرفيًا). لا يُعرض في أي واجهة — فقط وجوده يُتحقق منه.
- لا يُدوَّر عند الاستعادة — الإبطال وظيفة الـ epoch حصرًا.

---

## القسم 16 — التنزيل والرفع (D-1 + أمن ZIP المعزز)

### 16.1 التنزيل

- `GET /api/backups/[id]/download` — ZIP (database.db + manifest.json) بـ stream، `Content-Disposition: attachment` باسم خادمي.
- الحزمة المنزلة هي أداة النقل/الأرشفة؛ **الصلاحية لا تُشتق من اسمها أبدًا**.

### 16.2 الرفع (POST /api/backups/restore/validate) — ضوابط ZIP

| الضابط | القيمة/الآلية |
|---|---|
| الحجم المضغوط | ≤ `BACKUP_MAX_UPLOAD_MB` (افتراضي 200) — فحص قبل القراءة الكاملة (413) |
| الحجم غير المضغوط | ≤ `BACKUP_MAX_UNCOMPRESSED_MB` (افتراضي 500) — من أطوال المداخل قبل الفك |
| نسبة الانضغاط | uncompressed/compressed ≤ 200× (صدّ ZIP bomb) |
| عدد المداخل | ≤ 4 إجمالًا؛ **المقبول حصرًا**: `database.db` + `manifest.json` (الإصدار الأول — قرار المستخدم) |
| أسماء المداخل | رفض أي `/`, `\`, `..`, مسار مطلق، مجلدات، **symlinks**، أرشيفات متداخلة، أي اسم آخر |
| الاسم الأصلي | لا ثقة به إطلاقًا — يُستخرج `database.db` ويُعاد تسميته فورًا `staged-<id>.db`؛ الاسم الأصلي حقل عرض مطهر فقط |
| manifest.json | ≤ 1MB، JSON صالح بحقول formatVersion 2 الإلزامية |
| المهلة | الغربلة بعد 24 ساعة (تنظيف عابر — لا يمس النسخ الرسمية) |

(jszip موجود أصلًا في dependencies — الفك يدوي المدخل-بمدخل بضوابط أعلاه، لا فك أعمى.)

---

## القسم 17 — الأمن وتحليل التهديدات (محدّث)

| # | التهديد | التخفيف |
|---|---|---|
| 1 | تسريب بيانات مالية + password hashes | صلاحيتان + تدقيق + خارج public + 0600/0700 + لا مسارات مباشرة |
| 2 | Path traversal (API id أو ZIP entries / zip-slip / symlinks) | معرفات بنمط مغلق + resolve confinement + ضوابط القسم 16.2 حرفًا حرفًا |
| 3 | ملف ضار/عشوائي | خط التحقق الثماني + فتح readonly + checksum قاطع + حدود + لا تنفيذ أي كود |
| 4 | استعادة قديمة تقتل بيانات حديثة | Preview + تأكيد قوي + pre-restore إلزامي مدقق + Rollback + RECOVERY_REQUIRED |
| 5 | جلسات قديمة فوق بيانات أقدم | **Session Epoch** (القسم 15) — إبطال فوري شامل خارج DB |
| 6 | سرقة ملف النسخة من القرص | 0600 + خارج public — **ومسجل صراحة: 0600 ≠ تشفير**؛ الملف يحوي بيانات مالية وهاشات؛ التشفير at rest مؤجل مع اشتراط دعمه في أي off-device مستقبلًا (D-6) |
| 7 | استنزاف قرص | rate limit 60s + حدود رفع + عرض السياسة (لا حذف تلقائي في 4) |
| 8 | كشف مسارات داخلية | رسائل structured، أسماء منطقية، Sanitizer |
| 9 | عبث سجل الاسترجاع | append-only تطبيقياً — لا update/delete endpoint إطلاقًا |
| 10 | migration تجريبي على التشغيل | **مستحيل بنيويًا**: الترحيل على المؤقتة فقط (D-3) — التشغيل لا يرى إلا Candidate مدققًا |
| 11 | ZIP bomb / أرشيف خبيث | حدود مضغوط/غير مضغوط + نسبة + عدد مداخل + أسماء صارمة |

---

## القسم 18 — خطة Prisma Migrations Baseline (D-4 معتمد — الإجراء الآمن الكامل)

**القاعدة الحاكمة**: لا `prisma migrate dev` عشوائي فوق قاعدة التشغيل — **ولا تنفيذ على DB الأصلية قبل نجاح كل شيء على نسخة**.

```
الخطوة 0   نسخة VACUUM INTO فورية + integrity (نمطنا) — قبل أي خطوة
الخطوة 1   توليد SQL المرجعي (بلا لمس أي قاعدة):
           prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
           → prisma/migrations/0_init/migration.sql + migration_lock.toml (مجلد يدوي)
الخطوة 2   بناء قاعدة فارغة كاملة من الـ migrations:
           DATABASE_URL=file:staging/built-from-migrations.db prisma migrate deploy
الخطوة 3   المقارنة الثنائية: الناتج مقابل db/custom.db الحالية:
           - prisma migrate diff --from-url file:built --to-url file:custom.db --script ⇒ يجب أن يكون فارغًا
           - مطابقة schemaFingerprint (استثناء _prisma_migrations)
           ⛔ أي فرق drift ⇒ توقف + عرض الفرق على المستخدم قبل أي شيء
الخطوة 4   اختبار التطبيق على النسخة المبنية: تشغيل حزمة سكربتات التحقق الحالية (دخول/قوائم/لوحة/دورة workflow مصغرة) بـ DATABASE_URL موجه للنسخة
الخطوة 5   — وفقط بعد نجاح 0-4 — تعليم قاعدة التشغيل دون إعادة إنشائها:
           DATABASE_URL=file:db/custom.db prisma migrate resolve --applied 0_init
           (يكتب في _prisma_migrations فقط — جدول داخلي إضافي، لا تعديل بنيوي للجداول)
الخطوة 6   التحقق النهائي: prisma migrate status = clean + التطبيق يعمل + fingerprint ثابت
من هنا     كل تغيير مخطط = migration جديد (dev ينشئه على shadow)، و schemaVersion في Manifest
           يقرأ آخر migration مطبق، و db:push --accept-data-loss يُقيَّد (قرار منفصل وقتها)
```

ماذا يمنح: `_prisma_migrations` داخل أي نسخة تجيب عن إصدارها؛ استعادة أقدم = `migrate deploy` **على المؤقتة في الـ Drill حصرًا**؛ إنشاء قاعدة من الصفر = `migrate deploy` على ملف فارغ.

المخاطر المعلنة (إضافة v1): الخطوة 5 تكتب جدولًا داخليًا في قاعدة التشغيل (إضافي غير مدمّر — يوثق)؛ migrate dev يحتاج shadow db (يُضبط shadowDatabaseUrl على ملف مؤقت)؛ drift تاريخي من سكربتات 3.5A يكشفه الخطوة 3 قبل أي اعتماد.

---

## القسم 19 — DR خارج الجهاز: Interface مستقبلية فقط (لا سحابة الآن)

```ts
// تصميم مستقبلي — لا تنفذ في Phase 4 (قرار المستخدم: interface/provider فقط)
interface BackupDestination {
  id: string;                       // "nas-1" | "external-disk" | ...
  put(b: { zipPath: string; manifest: Manifest }): Promise<{ ok: boolean; verifiedSha256?: string }>;
  verify(backupId: string): Promise<boolean>;   // قراءة SHA-256 على الوجهة
  // اشتراط تصميمي (D-6): أي تنفيذ لاحق يجب أن يدعم تشفيرًا مناسبًا at rest/in transit
}
```

- الهدف المعلن: نسخة محلية **RESTORE_VERIFIED** تنسخ إلى NAS/قرص خارجي/تخزين شبكي آمن، وفقدان الجهاز لا يفقد النسخ معه — **دون أي كود اتصال الآن**.
- حاضرًا: إجراء يدوي موثق للمشغل (نسخ BACKUP_DIR + recovery-log إلى وسيط خارجي دوريًا والتحقق بالـ SHA-256 المعروض في الواجهة) — والدرس الواقعي داخل المشروع (فقدان `/home/z/backups/`) موثق في القسم 1.
- قاعدة: أي نسخة خارجية **تُتحقق على الوجهة** وإلا فهي لا تُعد نسخة.

---

## القسم 20 — RPO/RTO (توصيات معتمدة مع التصريح الإلزامي)

| المؤشر | القيمة المعتمدة | التصريح الصريح (قرار المستخدم) |
|---|---|---|
| RPO ≤ **24 ساعة** | توصية أولية قابلة للتعديل | **النسخ اليدوي وحده لا يضمن RPO 24h** — تحقيقها يتطلب لاحقًا Scheduled Backup ناجحًا ومراقبًا (خارج نطاق 4) |
| RTO ≤ **30 دقيقة** | توصية أولية قابلة للتعديل | التدريب الدوري على Recovery Test هو ما يجعلها واقعية |

---

## القسم 21 — واجهة الإدارة (تبويب في /admin — بلا route جديد)

1. **القائمة**: من Manifestات BACKUP_DIR (ليس filenames) — التاريخ/النوع/الحجم/checksum مختصر/عدد التقارير/**شارة مستوى التحقق** («تم الإنشاء» / «تم التحقق» / «مُثبت بالتجربة») + شارة **INVALID** (تالف/بلا Manifest — ليس candidate).
2. **إنشاء نسخة الآن** + **تشغيل Restore Drill** (لكل VALIDATED) + **تنزيل ZIP** + **تفاصيل Manifest**.
3. **معالج الاستعادة**: رفع/اختيار → تقرير تحقق (+تقرير Drill إن ترحيل) → Preview (قبل/بعد) → تأكيد قوي → شاشة تقدم المراحل (من آلة الحالات) → شاشة نتيجة نهائية (نجاح/تراجع/RECOVERY_REQUIRED بخطوات الطوارئ اليدوية).
4. **شريط الصيانة** للجميع (write-block: «التعديلات معلقة مؤقتًا» / full-block: «الخدمة في صيانة كاملة — استعادة قيد التنفيذ»).
5. **سجل الاسترجاع التشغيلي** (آخر 50 حدثًا بعنوان «خارج قاعدة البيانات — يبقى بعد الاستعادة» + عرض operationId مجمعًا).
6. **بطاقة السياسة** (عرض فقط — «الفعالية بعد اعتمادك») + عرض SHA-256 لكل نسخة للتحقق الخارجي اليدوي.

---

## القسم 22 — خطة الاختبارات v2

### 22.1 النسخ والحزمة (4A)
- نسخة أثناء كتابة متزامنة مستمرة ⇒ integrity ok وcounts متسقة.
- Manifest كامل الحقول العشرة الإلزامية + periodRange؛ SHA-256 يعيد حسابه مطابقًا.
- فشل متعمد ⇒ BACKUP_FAILED + لا ملف جزئي.
- مصفوفة صلاحيات كاملة + rate limit + تنزيل ZIP سليم (محتواه الثنائي مطابق).

### 22.2 التحقق والأمن (4B)
- ملف عشوائي .db ⇒ NOT_SQLITE؛ SQLite غريب ⇒ SCHEMA_UNKNOWN؛ مقطوع ⇒ CORRUPT_DB؛ checksum منحرف ⇒ رفض قاطع.
- ZIP: مدخل زائد ⇒ رفض؛ `../` في اسم ⇒ رفض؛ symlink ⇒ رفض؛ 60 مدخلًا ⇒ رفض؛ نسبة انضغاط مفتوكة ⇒ رفض؛ حجم مزدوج ⇒ 413.
- نسخة pre-3.5A المحفوظة فعليًا ⇒ fingerprint أقدم معروف ⇒ Drill إلزامي على المؤقتة فقط + إثبات أن قاعدة التشغيل لم تتغير (عدّ الصفوف قبل/بعد).
- نسخة «أحدث» (بصمة غير معروفة) ⇒ SCHEMA_NEWER/UNKNOWN رفض.

### 22.3 الاستعادة والصيانة والجلسات (4B)
- فشل إنشاء pre-restore (محاكاة) ⇒ إلغاء كامل قبل الصيانة الثقيلة.
- سيناريو ذهبي كامل: بيانات → نسخة → تعديلات بعد النسخة → استعادة ⇒ عودة حرفية للمحتوى (صفوف مختارة) + pre-restore موجود ومدقق دائمًا.
- فشل POST_VERIFY (محاكاة) ⇒ **البقاء في الصيانة** → ROLLING_BACK → تحقق التراجع → ROLLED_BACK → خروج.
- فشل مزدوج (إفساد pre-restore في sandbox) ⇒ **RECOVERY_REQUIRED** + الصيانة باقية + تنفيذ إجراء الطوارئ اليدوي الموثق يرجع الخدمة.
- الصيانة: كاتب نشط لحظة الاستعادة ⇒ 503 write-block ثم full-block للقراءة في نافذة التبديل + الشريط يعمل + صفر كتابة ضائعة جزئيًا.
- **الجلسات**: توكن صالح قبل الاستعادة ⇒ بعد SWAPPING+epoch: كل مصادر البيانات ترفضه → إعادة دخول إجبارية → الدخول الجديد يعمل بصلاحيات القاعدة المستعادة.
- سجل الاسترجاع: كل الأحداث بعناوين operationId كاملة **تبقى سليمة بعد استبدال DB**؛ لا update/delete endpoint له (محاولة أسلوب غير موجود ⇒ 405/404).
- درب read-only: جلسة كاملة بلا استعادة ⇒ صفر تغيير في القاعدة.

### 22.4 Migrations (عند اعتماد القسم 18)
- الخطوات 1-4 على نسخ حصرًا: build من الصفر ⇒ fingerprint مطابق؛ diff فارغ؛ حزمة سكربتات التحقق تنجح على المبنية؛ ثم الخطوة 5 على الأصلية وتقرير before/after.

### 22.5 ⭐ Recovery Test — اختبار قابلية الاستعادة الحقيقية (إلزامي، نص المستخدم حرفيًا)
```
1. إنشاء بيانات اختبار (مستخدمون/مجموعات/تقارير بدورة اعتماد كاملة)
2. Backup A (VALIDATED)
3. تعديل البيانات (تقارير جديدة/تغيير حالات/مستخدم إضافي)
4. Backup B (VALIDATED)
5. Restore A (بالتأكيد القوي + pre-restore + صيانة + epoch)
6. التحقق أن البيانات عادت حرفيًا إلى A (صفوف مختارة + counts)
7. التحقق من اختفاء جلسات ما قبل الاستعادة (توكن قديم مرفوض من كل مصادر البيانات)
8. التحقق أن Recovery Log ما زال يحتوي عملية Restore كاملة (operationId واحد من البداية للنهاية)
9. ثم Restore/rollback إلى B (أو pre-restore) وإثبات العودة إليه
```
> «هذا هو الاختبار الذي سيبرهن أن النظام قابل للاستعادة فعليًا» — تعليمات المستخدم. سيُنفذ ضمن 4B ويُرفق تقريره المستقل.

### 22.6 الخاتمة القياسية
تنظيف كامل إلى الحالة النظيفة المعروفة (نمط المراحل) + integrity ok + **الإبقاء على كل النسخ القائمة والقديمة دون مساس**.

---

## القسم 23 — نقاط القرار: المحسومة بعد المراجعة (v2)

| # | القرار | الحالة |
|---|---|---|
| D-1 | ZIP (database.db + manifest.json) + SHA-256 داخل Manifest + لا اعتماد للأسماء | ✅ معتمد — منفذ في القسمين 4/16 |
| D-2 | فصل BACKUP_DIR قابل للتهيئة عن مجلد التطبيق؛ خارج public وخارج source tree عند سماح البيئة؛ .gitignore للأمام فقط | ✅ معدل ومنفذ في القسم 3 |
| D-3 | لا ترحيل على التشغيل إطلاقًا — Drill على مؤقتة ثم Candidate؛ الأحدث: رفض؛ غير المعروف: رفض | ✅ معدل جوهريًا — القسم 8.1/5.2 |
| D-4 | Migrations معتمدة بخطة baseline الآمنة (6 خطوات — الخطوة 5 على الأصلية فقط بعد نجاح النسخ) | ✅ معتمد — القسم 18 |
| D-5 | مفتاحان manageBackups + restoreDatabase؛ settings لا تمنح شيء | ✅ معتمد — القسم 7 |
| D-6 | لا تشفير تطبيقي الآن + تسجيل صراحة «0600 ≠ تشفير» + اشتراط التشفير في أي off-device لاحق | ✅ معتمد — القسمان 17/19 |
| D-7 | Session Epoch خارج DB بدل تدوير السر؛ فصل إدارة الأسرار عن الإبطال | ✅ معدل جوهريًا — القسم 15 |
| D-10 | تثبيت NEXTAUTH_SECRET القوي إلزاميًا قبل التشغيل الفعلي؛ لا يدخل ZIP/Manifest/API/سجلات | ✅ معتمد — القسم 15.3 |
| D-9 | تسلسل الصيانة الصارم الثماني + إيقاف القراءة في نافذة التبديل | ✅ معدل — القسم 10 |
| الإضافات | Restore Drill أساسي، مستويات التحقق الثلاثة، مصفوفة الفشل + RECOVERY_REQUIRED، سجل بـ operationId، أمن ZIP، Recovery Test الإلزامي، RPO/RTO بالتصريح، off-device interface فقط | ✅ — الأقسام 5/9/12/6/16/22.5/20/19 |

---

## القسم 24 — قائمة الملفات: ما سيُضاف وما يُعدل عند التنفيذ (للموافقة النهائية)

### 4A — أساس النسخ (لا يمس أي سلوك قائم)

| الملف | العملية | المحتوى |
|---|---|---|
| `src/lib/permissions.ts` | تعديل | مفتاحا manageBackups/restoreDatabase + defaults + helperا |
| `src/lib/backup-config.ts` | **جديد** | resolveBackupDir وغيره من المسارات/الحدود/السياسة (BACKUP_DIR…) |
| `src/lib/backup-manifest.ts` | **جديد** | أنواع Manifest v2 + schemaFingerprint + counts/periodRange |
| `src/lib/backup-server.ts` | **جديد** | createBackup (VACUUM INTO+integrity+sha256+ZIP+manifest) + listBackups (من manifests + INVALID) + packaging jszip |
| `src/lib/recovery-log.ts` | **جديد** | append-only JSONL + eventId/operationId + قارئ للعرض |
| `src/lib/audit-actions.ts` | تعديل | الأكواد الستة الجديدة |
| `src/app/api/backups/route.ts` | **جديد** | GET القائمة / POST الإنشاء |
| `src/app/api/backups/[id]/route.ts` | **جديد** | GET تفاصيل Manifest |
| `src/app/api/backups/[id]/download/route.ts` | **جديد** | GET تنزيل ZIP stream |
| `src/app/api/backups/recovery-log/route.ts` | **جديد** | GET قراءة فقط |
| `src/components/admin/backup-manager.tsx` | **جديد** | تبويب النسخ (قائمة/إنشاء/تنزيل/تفاصيل/سجل) |
| `src/app/admin/page.tsx` | تعديل | تبويب ثالث |
| `.gitignore` | تعديل | سطرا var/ وbackups/ (للأمام فقط — الملف القديم المتتبع يظل كما هو) |
| `package.json` | تعديل | سكربتات تشغيلية اختيارية (backup:create) |

اختبارات 4A = 22.1 كاملة + تقرير مستقل.

### 4B — الاستعادة والاسترجاع (بعد نجاح 4A وتقريره)

| الملف | العملية | المحتوى |
|---|---|---|
| `.env` | تعديل | تثبيت NEXTAUTH_SECRET قوي (D-10 — لا يُعرض إطلاقًا) + متغيرات BACKUP_DIR/الحدود |
| `src/lib/maintenance.ts` | **جديد** | العلم بمستويين + assertWritable/assertReadable + عداد in-flight |
| `src/lib/session-epoch.ts` | **جديد** | readSessionEpoch/bumpSessionEpoch (var/auth/session-epoch) |
| `src/lib/auth.ts` | تعديل | jwt/session callbacks: توقيع epoch وفحصه (القسم 15) |
| `src/lib/session.ts` | تعديل | دفاع عمق: فحص epoch في requireAuth/requireAdmin |
| `src/lib/db.ts` | تعديل | `export let db` + reconnectDb() (ESM live bindings) |
| `src/lib/restore-server.ts` | **جديد** | خط التحقق الثماني + Drill engine (Prisma client مؤقت) + آلة حالات execute كاملة |
| `src/app/api/backups/restore/validate/route.ts` | **جديد** | رفع ZIP بضوابط 16.2 + تحقق + Drill للمخطط الأقدم → Candidate |
| `src/app/api/backups/restore/execute/route.ts` | **جديد** | آلة الحالات (قسم 9) — restoreDatabase حصرًا |
| `src/app/api/backups/[id]/drill/route.ts` | **جديد** | Restore Drill عند الطلب |
| `src/app/api/system/status/route.ts` | **جديد** | حالة الصيانة (عام) |
| 13 مسارًا كتابيًا قائمًا | تعديل | استدعاء assertWritable() واحد في مقدمة كل handler كتابة |
| `src/components/admin/backup-manager.tsx` + `page.tsx` | تعديل | معالج الاستعادة + شارة المستويات + Drill + شريط الصيانة |
| `prisma/migrations/0_init/*` | **جديد** | baseline (بعد نجاح خطوات القسم 18 على النسخ — الخطوة 5 الأخيرة) |
| `src/lib/audit-actions.ts` | تعديل | إن لزم: أكواد إضافية طفيفة |

اختبارات 4B = 22.2–22.5 (بما فيها ⭐ Recovery Test) + E2E متصفح + تقرير مستقل.

**لا يُعدّل إطلاقًا**: `src/lib/accounts.ts`، محرك المطابقة، Workflow، Dashboard، أي سلوك قائم — الإضافات إضافية صرفة، والتعديلات القليلة المذكورة (permissions/db.ts/auth.ts/13 handler) نقاط اتصال محصورة معروضة أعلاه للموافقة.

---

## القسم 25 — خلاصة الالتزامات النهائية

1. **لا تنفيذ قبل الموافقة النهائية على هذه النسخة** — والتنفيذ على مرحلتين 4A/4B ببوابة اختبارات وتقرير مستقل لكل منهما.
2. قاعدة التشغيل لا تُستخدم أبدًا مكان تجربة migration؛ الاستبدال فقط بـ Candidate مدقق.
3. لا خروج من الصيانة إلا بنجاح الاستعادة أو التراجع — وإلا RECOVERY_REQUIRED معلنة.
4. لا حذف تلقائي لأي نسخة؛ Git محفوظ append-only؛ النسخ القائمة والقديمة دون مساس.
5. NEXTAUTH_SECRET لا يدخل أي نسخة أو سجل؛ إبطال الجلسات وظيفة Session Epoch الخارجية حصرًا.
6. «0600 ≠ تشفير» — موثقة صراحة، والتشفير اشتراط في أي off-device مستقبلي.
7. النسخ اليدوي لا يضمن RPO 24h — موثقة صراحة؛ الحل لاحقًا Scheduled Backup مراقب.

> **انتهت v2. بانتظار الموافقة النهائية على: المعمارية، آلة الحالات، إبطال الجلسات، إجراء الـ baseline، مستويات التحقق، مصفوفة الفشل، وقوائم ملفات 4A/4B — قبل كتابة أي كود.**
