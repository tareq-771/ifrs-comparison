# Phase 5A Report — Production Runtime Readiness

> **الحالة: 5A مكتملة داخل المستودع فقط — توقف قبل 5B بانتظار الموافقة.**
> التصميم الحاكم: `docs/phase5-design.md` (المعتمد، التزام `83afe4e`) + قرارات
> المستخدم: **R3 = Node.js للإنتاج · R4 = HTTPS داخلي · R5 = hostname ثابت (يُحدد في 5B)**.
> الالتزام النهائي لـ 5A: **`2e382a4`**.

---

## 1. Fail-Closed — تحقق تهيئة الإنتاج (نص المستخدم منفَّذ حرفيًا)

`src/lib/production-config.ts` — يعمل حصرًا في `NODE_ENV=production` (سلوك dev لم يتغير):

| المتغير | القاعدة |
|---|---|
| `NEXTAUTH_SECRET` | إلزامي · ≥32 بايت · رفض placeholders وأنماط ضعيفة — **لا fallback عشوائي بنيويًا** (`auth.ts` يمرر السر صريحًا من بيئة العملية حصرًا) |
| `DATABASE_URL` | إلزامي · `file:` مطلق · **الملف يجب أن يكون موجودًا (لا إنشاء صامت)** · محظور داخل شجرة النشر |
| `VAR_DIR` | إلزامي · مطلق · موجود · محظور داخل شجرة النشر |
| `BACKUP_DIR` | إلزامي · مطلق · موجود · محظور داخل شجرة النشر |
| `RESTORE_ENGINE_ENABLED` | **يجب أن يكون صريحًا "0" أو "1"** — الغياب/القيمة الأخرى ⇒ رفض إقلاع |
| `NEXTAUTH_URL` | إلزامي إنتاجيًا (صحّة NextAuth خلف بروكسي) |

**نتائج الاختبار الحي (على artifact الإنتاج الحقيقي):**

| اختبار | النتيجة |
|---|---|
| T1: غياب NEXTAUTH_SECRET | `FATAL: production config invalid: NEXTAUTH_SECRET_MISSING` → **exit=1، لا listener** |
| T2: سر ضعيف (`weak123`) | `FATAL: … NEXTAUTH_SECRET_TOO_SHORT` → **exit=1، لا listener** |
| T3: سر صالح | إقلاع كامل + preflight OK |
| لا قيم أسرار | كل الرسائل رموز أسباب فقط — مطبَّق ومثبت في السجلات |

**إثبات منع مسارات البيانات داخل شجرة النشر:** اكتشاف فعلي خلال 5A — `next build`
(standalone tracing) **انسخ `.env` و`db/custom.db` داخل مخرج standalone**؛ نُظفت
من الإصدار، وقاعدة المنع (`*_INSIDE_RELEASE_TREE` + `DATABASE_URL_NOT_ABSOLUTE`)
تمنع تفعيلها وقت التشغيل — الخطر موثق في runbook النشر (حذف إلزامي بعد البناء).

## 2. /api/health — العقد

`GET /api/health` — بلا مصادقة، بلا leases (يستجيب أثناء full-block/RECOVERY_REQUIRED)،
بلا بيانات مالية/عدّادات/مسارات/operationId:

| الحالة | HTTP | الجسم |
|---|---|---|
| `healthy` | 200 | `{status, app, version, serverTime}` |
| `maintenance` | 200 | + `reason: "maintenance:<STATE>"` |
| `recovery_required` | 503 | + `reason: "recovery_required"` |
| `unhealthy` | 503 | + `reason ∈ {boot_config, database, schema, epoch, preflight_incomplete, epoch_unavailable}` |

المنطق: حالة الصيانة وepoch تُقرآن **حيًا** عند كل طلب؛ نتائج preflight الإقلاع من `boot-status`.

## 3. Startup Preflight + Startup Recovery

`src/instrumentation.ts` (كل الاستيرادات ديناميكية — نظيف لحزمة Edge):

1. **كل الأوضاع**: تهيئة epoch (مفقود ⇒ 1 ذريًا) + `startupRecoveryCheck()` (4B.1 كما هو).
2. **production**: config (فشل ⇒ exit 1) → ترويسة SQLite (`SQLite format 3\0`) →
   `PRAGMA integrity_check` → canonical schema مقابل الثابت `bffa026102bc…` →
   epoch → حالة الصيانة ⇒ `setBootStatus`.
3. **سياسة الإخفاق**: config ⇒ **exit**؛ قاعدة/مخطط/epoch ⇒ **إقلاع متدهور +
   health unhealthy** (لا حلقة إقلاع تمحو التشخيص).

**RECOVERY_REQUIRED — restricted recovery mode (مثبت حيًا):**
بُذرت حالة `SWAPPING` مقطوعة في VAR_DIR المحاكاة ثم إقلاع:
- `CRASH RECOVERY: … (SWAPPING) → RECOVERY_REQUIRED (operation=op-…-p5atest)` — حدث واحد
- `production preflight: DEGRADED mode=recovery_required …`
- health = **503 `recovery_required`** · الكتابة (إنشاء نسخة) = **503 RECOVERY_REQUIRED** · القراءة المصدقة = **503 (locked)**
- `/api/system/status` = 200 مع `recovery.reason=startup_after_interrupted_operation` (آمن)
- **لا restart loop**: `Ready` سطر واحد، عملية واحدة PID ثابت PPID=1 cwd=release،
  الhealth ثابت 503 عبر الزمن. التطبيع: مسح حالة بتحقق مشغّل → إقلاع → **healthy**.

## 4. تغييرات DB Runtime (`src/lib/db.ts`)

- `journal_mode=WAL` + `busy_timeout=5000` + `foreign_keys=ON` — **لكل عميل**
  (الأساسي + كل `reconnectDb`) — افتراضات الاستعادة الذرية غير المماسة.
- تسجيل `log:['query']` صار dev فقط؛ الإنتاج: `['error','warn']`.
- «لا إنشاء صامت في مسار خاطئ»: مغطى من `production-config.ts` (الملف يجب أن يكون موجودًا).
- **نتيجة على قاعدة التشغيل الحقيقية**: `integrity_check=ok` · `foreign_key_check=0` · `journal_mode=wal`.

## 5. Production Build + إثبات Node Standalone على 127.0.0.1:3000

- `NEXT_DIST_DIR=.next-prod bunx next build` ⇒ **EXIT=0** (مع `/api/health` في جدول المسارات).
- تجميع standalone self-contained (static+public) وتنظيف المخرجات المنسوخة.
- **تشغيل بـ Node.js (R3)**: `node server.js` ⇒ `ss` يظهر **`127.0.0.1:3000` حصرًا**
  (مقابل dev على `*:3000`) — `Ready in 88ms` + `production preflight: OK mode=normal
  db=ok integrity=ok schema=ok epoch=ok maintenance=NORMAL` + `canonical schema ok: bffa026102bc`.
- التدفق المصدق على artifact الإنتاج (بجلسة NextAuth حقيقية): login 200 →
  `/api/users` 200 → إنشاء مجموعة 201 → **نسخة `bk-…-3ob8py` VALIDATED (Manifest v3)** →
  validate 200 → drill 200 ⇒ **RESTORE_VERIFIED** → recovery-log 200 (أحداث عملية واحدة).

## 6. Persistent-Path Simulation (فصل بنيوي بالمحاكاة — كما اشترط المستخدم)

هيكل `.p5a/` (gitignored؛ **ليس دليل persistence حقيقي** — الحقيقي في 5B):

```
.p5a/releases/A · releases/B · current → symlink   (شجرة النشر القابلة للحذف)
.p5a/data/   (= /var/lib): db/ auth/epoch maintenance/ recovery/
.p5a/backups/(= /var/backups)   .p5a/secrets/ifrs.env (= /etc، 0600)
```

القاعدة: نسخة متسقة من قاعدة التشغيل عبر `VACUUM INTO` (الأصل لم يُلمس — لا نقل ولا استعادة A/B).

**النتيجة: حذف الإصدارين والبناء لا يمس أي حالة:**

```
DELETED: releases/B + .next-prod build tree
DATA_HASHES_IDENTICAL  (db + epoch + recovery-log: sha256 متطابقة قبل/بعد)
HEALTH_AFTER_DELETE=healthy · groups_after_delete: [المؤشران باقيان] · releases/: [A]
```

## 7. Secrets/Session Tests (دورات إعادة تشغيل حقيقية)

| اختبار | النتيجة |
|---|---|
| مفقود/ضعيف ⇒ فشل إقلاع | T1/T2 ✓ (أعلاه) |
| إعادة تشغيل بنفس السر | T3 ✓ — preflight OK، **epoch 1→1 (بقاء)**، **جلسة قبل الإيقاف ما زالت 200** — لا تدوير صامت |
| تغيير السر عمدًا | T4 ✓ — الجلسة القديمة: session بلا user + `/api/users` **401**؛ دخول جديد بالسر الجديد 200 |
| الجلسة عبر تبديل الإصدار | ✓ 200 تحت B وبعد العودة إلى A (السر والepoch خارجان من الشجرة) |

## 8. Release A → B → A (Code rollback ≠ DB rollback)

1. **A** (v1.0.0): مؤشر بيانات `P5A-MARKER-RELEASE-A` + نسخة RESTORE_VERIFIED.
2. **B** (v1.0.1-p5a — بناء حقيقي): health يظهر `version=1.0.1-p5a` — **البيانات والجلسة باقيان**؛ كُتب تحت B: `P5A-WRITTEN-UNDER-B` (201).
3. **Rollback → A**: health `version=1.0.0` — **كلا المؤشرين باقيان** ⇒ عودة الكود لم تمس البيانات إطلاقًا.
4. **حذف B + شجرة البناء**: hash متطابقة، health healthy — القسم 6.

## 9. Regression (على خادم التشغيل بعد الاستعادة)

- **lint**: EXIT=0 (صفر أخطاء/تحذيرات مؤثرة) · **tsc**: 0 أخطاء في كل ملفات 5A
  (88 خطأ سابقًا موثقًا في scripts/ وchat وexamples وskills — لا تغيير).
- **build**: EXIT=0 (production) — القسم 5.
- **دخول + CRUD + workflow كامل**: مجموعة 201 + تقرير DRAFT 201 → تعيين
  ثلاثي بفصل مهام (معدّ/مراجع/معتمد — مستخدما اختبار أنشئا ثم حُذفا) →
  SUBMIT/START_REVIEW/COMPLETE_REVIEW/APPROVE ⇒ **APPROVED** مع تاريخ كامل
  `CREATED→ASSIGNMENT_CHANGED→SUBMITTED→REVIEW_STARTED→REVIEW_COMPLETED→APPROVED`
  → التنظيف الشرعي: REOPEN→RESUME_EDIT→حذف التقرير + المجموعة + المستخدمين.
- **dashboard** `/api/dashboard/summary` 200 · **Backup→Validate→Drill** على
  قاعدة التشغيل: `bk-20260920T195619Z-7er3dq` ⇒ **RESTORE_VERIFIED** ·
  **health** 200 healthy.
- **الجردان**: write-guard **59 معالجًا كلها محمية/مصنفة** (33 كتابة/17 قراءة/9 معفاة —
  أضيف `/api/health` للمعفاة بعذر موثق: بلا leases عمدًا) · restore-permission
  **PASS** (كل مسارات الاستعادة بـ requireRestoreDatabase والفصل قائم).
- **سلامة قاعدة التشغيل النهائية**: `integrity_check=ok` · `fk=0` · users=1 · groups=0 · reports=0 (كما كانت قبل 5A).
- **متصفح E2E (Agent Browser)**: تسجيل دخول فعلي → /admin (تبويبات) → تبويب
  النسخ يعرض نسخة 5A بـ Manifest v3 — صفر أخطاء console — لقطات في `.p5a/evidence/`.

## 10. الملفات والقوالب المضافة (داخل Git حصرًا — لا تثبيت على النظام)

| الملف | النوع |
|---|---|
| `src/lib/production-config.ts` | جديد — تحقق fail-closed |
| `src/lib/boot-status.ts` | جديد — حالة الإقلاع لـ health |
| `src/instrumentation.ts` | موسّع — preflight الإنتاج |
| `src/app/api/health/route.ts` | جديد |
| `src/lib/db.ts` · `src/lib/auth.ts` | تحديث (pragmas/تسجيل/سر صريح) |
| `scripts/phase4b1-write-guard-scan.ts` | إعفاء `/api/health` بعذر موثق |
| `deploy/ifrs-comparison.service` | قالب systemd (Node + hardening + ReadWritePaths) |
| `deploy/Caddyfile.prod` | قالب Caddy (tls internal + hostname placeholder + 256MB/30m) |
| `deploy/ifrs.env.example` | قالب env بلا أسرار |
| `deploy/preflight.sh` | قالب ExecStartPre نظامي |
| `deploy/nftables.conf` | قالب الجدار (من التصميم المعتمد §6) |
| `deploy/runbook-deploy.md` · `deploy/runbook-rollback.md` · `deploy/README.md` | runbooks |
| `docs/phase5a-report.md` | هذا التقرير |
| `.gitignore` · `eslint.config.mjs` | `.p5a/` `.next-prod/` خارج Git/lint |

## 11. الانحرافات (موثقة)

1. **خادم dev أُعيد تشغيله بـ NEXTAUTH_SECRET كمتغير بيئة للعملية فقط** (لم يُمس `.env`)
   — نفس ممارسة 4B.3؛ بدونها تتضارب أسرار workers في dev فتفشل APIs الجلسة (401).
2. `/api/health` أضيف لقائمة استثناءات جرد write-guard (قراءة مقصودة بلا leases —
   مثل `/api/system/status`) — تعديل سكربت الجرد موثق داخل الملف.
3. `package.json build` لم يُغيَّر — البناء المعزول تم عبر `NEXT_DIST_DIR` (الخطاف
   الموجود)؛ خطوات النشر المعزولة موثقة في runbook-deploy.
4. `deploy/nftables.conf` أُدرج ضمن القوالب (من التصميم المعتمد §6) رغم عدم ذكره
   صراحة في قائمة قوالب 5A.
5. التحذيريات السابقة لحزمة Edge في dev.log عولجت بإعادة صياغة instrumentation
   باستيرادات ديناميكية (نمط 4B.1 الأصلي) — أُعيد البناء وأعيد إثبات artifact.
6. محاكاة 5A استخدمت **نسخة VACUUM INTO** من قاعدة التشغيل (الأصل لم يُلمس) —
   «لا Production Restore A/B» منفَّذ: صفر عمليات استعادة في كل 5A.

## 12. الالتزام

- **Commit hash لـ 5A**: انظر أعلى التقرير/الالتزام الفعلي — يشمل الكود + القوالب + التقرير.
- ما بعد 4B.3 → 5A: لا تغيير على `.env` القائمة ولا `var/` التشغيل ولا أي مسار نظام
  (لا /etc، لا systemd حقيقي، لا Caddy حقيقي، لا firewall، لا DNS/hosts).

**توقف كامل: قبل 5B (التثبيت على الخادم الحقيقي) — بانتظار موافقة المستخدم.**
