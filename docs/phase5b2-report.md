# Phase 5B.2 — Host-Prep Readiness Gate — تقرير البوابة

> **النطاق المنفذ:** معالجة متابعات 5B.1 العشرة (نص المستخدم) + تجهيز كل ما تحتاجه
> «الخطوة 5B.2 — تهيئة المضيف» من كود/قوالب/أدوات/اختبارات **داخل المستودع حصرًا**.
> **صفر تنفيذ على المضيف الحقيقي** — لا Firewall، لا Windows Services، لا Caddy، لا
> مجلدات إنتاج، لا أسرار، لا Restore، لا بناء إنتاج على المضيف (كلها خطوات يدوية موثقة أدناه).

---

## 1) تصنيف تغييرات شجرة العمل المتبقية من 5B.1 (البند 1 — قرار لكل بند)

| الملف | التصنيف | القرار |
|---|---|---|
| `.zscripts/dev.pid` | artifact تشغيلي (خادم dev حي) | **لا يُمس ولا يُرسَل** — بقي خارج commit |
| `db/custom.db` + `db/custom.db-shm` | artifacts تشغيلية (WAL حي) | **لا يُمس ولا يُرسَل** — بقي خارج commit |
| `src/app/api/backups/upload/route.ts` (محذوف) | **debris إعادة تعيين بيئة** — المرجع الوحيد `/api/backups/upload` حي في `backup-manager.tsx:348` (نفس فئة الحدث الموثق في f8c0ab6) | **استُعيد من HEAD حرفيًا** (`git checkout --`) — لم يُضم الحذف |
| `tsconfig.json` (+سطرا `.next-prod/types`) | **تغيير مصدري لازم** — يدعم `NEXT_DIST_DIR=.next-prod` (التصميم المعتمد 4B.1/5B.1 للبناء المعزول) عند فحص الأنواع | **ضمّ عمدًا في commit 5B.2** بهذا التبرير — ليس ضمًا تلقائيًا |

## 2) الملفات التي تغيرت (5B.2)

**كود/سكربتات:**
1. `src/lib/audit.ts` — `getClientIp`: اعتماد **آخر عنصر** من X-Forwarded-For (rightmost) بدل الأول — الدفاع العمقي ضد انتحال عناوين Audit Log + توثيق نظام الثقة (البوابة تستبدل XFF بـ`{remote_host}`؛ الأخير هو ما ألحقه آخر وسيط موثوق).
2. `scripts/prod-server.mjs` — **فرض ربط loopback**: HOSTNAME ساقط ⇒ `127.0.0.1` افتراضيًا؛ HOSTNAME غير loopback ⇒ FATAL إلا مع `IFRS_BIND_ALLOW_NON_LOOPBACK=1` (فتحة موثقة غير موصى بها)؛ PORT افتراضي 3000؛ إشارات إنهاء best-effort (SIGINT/SIGTERM/SIGBREAK)؛ استيراد المحلل المشترك.
3. `scripts/env-file.mjs` (**جديد**) — محلل IFRS_ENV_FILE الصارم المشترك (KEY=VALUE حرفي، CRLF، لا eval، IFRS_ENV_FILE الداخلي يُتجاهل) — مصدر وحيد للدلالات يمنع الانحراف.
4. `scripts/deploy-migrate.mjs` (**جديد**) — **بوابة الترحيل الإنتاجية الحتمية**: `migrate deploy` حصرًا (الأمر ثابت في الكود — لا استقبال أوامر)، env صارم عبر المحلل المشترك، رفض: قاعدة مفقودة (لا إنشاء صامت)، قاعدة داخل شجرة العمل، PRISMA_CLI_HOME صريح غير محلول (بلا fallback — مطابق لـ`prisma-cli.ts`)؛ `--dry-run` لعرض الخطة؛ `process.execPath` حصرًا (Node — لا bunx/npx/shell).
5. `scripts/assemble-release.mjs` — ينسخ `env-file.mjs` مع `prod-server.mjs` إلى جذر كل release.
6. `src/app/api/health/route.ts` — **محاولة إصلاح typo سجل (`[health]`) حُجبت بيئيًا**: بيئة Z.ai تستعيد هذا الملف حصرًا إلى محتوى HEAD خلال <3 ثوانٍ من أي كتابة (مؤكد باختبار مزدوج: كتابة ناجحة + قراءة فورية سليمة + ارتجاع خلال 3 ثوانٍ — بقية الملفات سليمة 100%). الإصلاح تجميلي (سجل خادم فقط — صفر تأثير وظيفي/أمني، والسلوك مُختبر سليم D1ب) — **مؤجل إلى 5B.3 على المضيف** (R-6). الجسم العام لم يتغير.
7. `.gitignore` — `/download/` (artifacts النقل اليدوي لا تدخل Git).

**قوالب Windows:**
8. `deploy/ifrs.env.windows.example` — توثيق فرض loopback وفتحة الهروب (غير موصى بها).
9. `deploy/runbook-deploy-windows.md` — خطوة 6 استُبدلت: `node scripts\deploy-migrate.mjs --env-file ...` (dry-run ثم تنفيذ) بدل استخراج PowerShell الهش للسطر.

**اختبارات/توثيق:**
10. `scripts/phase5b2-host-prep.ts` (**جديد**) — مصفوفة البوابة (92 فحصًا).
11. `docs/phase5b2-report.md` (هذا التقرير) + `worklog.md`.

## 3) الاختبارات المنفذة ونتائجها — `92/92` (تشغيلان متتاليان، غير مدمرة حصرًا)

**A) وحدات وقوالب (34):** rightmost-XFF (7) · محلل env-file (6) · ثوابت prod-server/assemble/deploy-migrate (5) · Caddyfile.windows — استبدال XFF `{remote_host}` + tls internal + admin off + لا :80 (4) · WinSW app (5) · firewall — LanSubnet إلزامي + رفض placeholders + 443 فقط ولا 80 (4) · env example (5) · preflight قراءة فقط (2) · package.json (2) · validateProductionConfig داخل/خارج شجرة النشر + محرك صريح (3).

**B) prod-server مصفوفة الفشل المغلق (7):** env مفقود/تالف ⇒ FATAL برقم السطر · HOSTNAME غير loopback ⇒ FATAL · فتحة الهروب الصريحة ⇒ تمر بتحذير · افتراضي آمن 127.0.0.1 · NODE_ENV صارم.

**C) بوابة deploy-migrate (9):** بلا env ⇒ FATAL · بلا DATABASE_URL ⇒ FATAL · ملف مفقود ⇒ `DATABASE_FILE_NOT_FOUND` **+ لا إنشاء صامت (تحقق فعلي)** · داخل شجرة العمل ⇒ رفض · مسار سعيد على نسخة حقيقية (migrate deploy عبر node، exit 0) · dry-run لا يلمس (mtime ثابت) · PRISMA_CLI_HOME خاطئ ⇒ `PRISMA_CLI_UNRESOLVED`.

**D) standalone إنتاجي حقيقي `.next-prod` (36):** نقاء artifact + RELEASE_META (sha=42896ad…, migrations=1, fingerprint=csha256:bffa026102…) · إقلاع سليم + **ربط فعلي 127.0.0.1:31181 حصرًا** (فحص `ss` عمود Local) · جسم health `{status, app, serverTime}` حصرًا · أسرار fail-closed: مفقود/قصير/محرك غائب ⇒ exit 1 برموز صريحة وبلا أي قيمة سرية في المخرج · epoch مفقود على قاعدة مهيأة ⇒ unhealthy 503 مستقر + **بلا إنشاء صامت** + `EPOCH_STATE_LOST` + سطر Ready واحد (بلا حلقة) · epoch تالف ⇒ `EPOCH_STATE_CORRUPT` والمحتوى لا يُلمس · قاعدة جديدة ⇒ bootstrap مشروع 1 · **`--epoch-recover` بعد فقد فعلي**: يرفض فوق ملف سليم (سلوك مدمج)، يكتب unix-seconds (~1.79e9) بعد فقد حقيقي، `MANUAL_RECOVERY_COMPLETED` + `unix_time_seconds` في السجل الخارجي، **JWT القديمة ماتت فعليًا** (جلسة epoch=1 ⇒ user=null) والدخول الجديد يعمل · **صيانة مقطوعة (SWAPPING مزروعة) ⇒ recovery_required 503** + قراءة 503 locked + الحالة تبقى RECOVERY_REQUIRED على القرص **وتصمد عبر restart كامل** (لا عودة NORMAL) + عودة مشروعة فقط بعد `--verify-and-clear --confirm-manual-verification` · نسخة عبر API (201, VALIDATED): **ZIP = {database.db, manifest.json} حصرًا وبلا أي سر NEXTAUTH (فحص نصي فعلي)** وmanifest بلا مفاتيح أسرار.

## 4) ضمانات persistence — المختبر فعليًا (Linux sandbox / standalone حقيقي) مقابل design-only

| الضمان | الحالة |
|---|---|
| epoch خارج القاعدة ولا يعود لقيمة قديمة بعد restart/restore | **مختبر فعليًا** (5A + D1د/D3-D6) |
| فقد/تلف epoch ⇒ fail-closed بلا reset صامت | **مختبر فعليًا** (D3/D4) |
| استرداد المشغّل ينتج generation جديدة عالية تُبطل الجلسات | **مختبر فعليًا** (D6: توكن قديم مات) — **آلية عملية (unix-seconds) لا ضمان رياضي مطلق** (انظر R-1) |
| RECOVERY_REQUIRED يصمد عبر restart ولا يتحول تلقائيًا NORMAL | **مختبر فعليًا** (D7هـ) |
| maintenance/recovery state على قرص دائم خارج شجرة النشر | **مختبر فعليًا** (بنية) — **مسار D:\IFRS-Data الفعلي = design-only حتى التنفيذ** |
| ربط loopback حصري | **مختبر فعليًا** على Linux (ss) — **تحقق الـbind على Windows = 5B.4** |
| أسرار من IFRS_ENV_FILE خارج Git/releases + fail-closed | **مختبر فعليًا** (B/D2) — توليد السر على المضيف = يدوي 5B.3 |
| staging التبديل على نفس filesystem للقاعدة | **بنيويًا مضمون** (`resolveSwapDir` = dirname القاعدة) — التحقق على NTFS = 5B.4 |

## 5) الإجابات المباشرة على المتابعات العشر

1. **شجرة العمل:** مبين أعلاه (§1) — لا شيء ضُم تلقائيًا.
2. **Epoch:** fail-closed مثبت (لا عودة قديمة، لا reset صامت، استرداد مشغّل فقط بعد فقد فعلي + تحقق قاعدة كامل) — **بلا ادعاء رياضي**: مسجلة R-1.
3. **NEXTAUTH_SECRET:** مصدر وحيد = IFRS_ENV_FILE (ACL مقترحة بالقالب)؛ مفقود/ضعيف ⇒ رفض إقلاع برمز صريح؛ لا توليد تلقائي عند restart (لا fallback إطلاقًا)؛ **لا يدخل ZIP النسخ — مختبر فعليًا** (D8ج/د)؛ لا يدخل Git ولا logs (D2: بلا قيمة سرية في المخرج).
4. **المسارات الدائمة:** production-config يرفض DB/VAR/BACKUP داخل شجرة النشر (A10)؛ env example يقود D:\IFRS-Data / D:\IFRS-Backups؛ staging نفس volume القاعدة بنيويًا؛ لا Downloads ولا release قابل للاستبدال.
5. **الخدمة:** build/start إنتاجي حصرًا (`next build`+assemble / `prod-server.mjs`)؛ **loopback مفروض في الكود** (لا اعتماد على env فقط)؛ Caddy نقطة LAN الوحيدة (443)؛ 3000 لا يُعرض — الربط loopback تحكم أساسي + `-BlockAppPort` دفاع اختياري؛ XFF: استبدال بالبوابة + rightmost بالتطبيق.
6. **Migrations:** بوابة حتمية `deploy-migrate.mjs` (migrate deploy حصرًا، لا db push — الأمر غير قابل للتمرير أصلًا)؛ code rollback ≠ data rollback (runbook-rollback §19: فحص fingerprint + أسماء migrations قبل أي rollback، ولا restore تلقائي أبدًا).
7. **Recovery:** الحالة وآثارها خارج القاعدة وعبر restarts (D7)؛ لا حلقة تمحو الأدلة (onfailure تصاعدي + سطر Ready واحد D3د)؛ سجل الاسترجاع خارج دورة حياة restore (append-only خارج DB).
8. **Backup/RPO:** النسخ اليدوي عبر محرك كامل الضوابط يعمل (D8) — **RPO≤24h غير محقق بعد**: يتطلب جدولة+تحقق+نسخ off-device (تصميم 5B.5) — لا ادعاء قبل ذلك.
9. **Restore Engine:** صريح إلزاميًا (غياب ⇒ رفض إقلاع D2-3)؛ غياب/تلف config لا يُفعّل شيئًا (default = معطل)؛ `restoreDatabase` صلاحية مستقلة (4B.3) تبقى شرطًا.
10. **Health:** `{status, app, serverTime}` حصرًا — بلا paths/counts/أسباب تفصيلية (مختبر D1ب)؛ يفرق healthy/maintenance/recovery_required/unhealthy فقط.

## 6) جاهزية service/Caddy/firewall/migration/rollback (5B.2 على المضيف)

- **قوالب جاهزة للتنفيذ اليدوي:** WinSW×2 (restart محدود، logs دائمة، ifrs-svc، stoptimeout) · Caddyfile.windows · firewall-ifrs.ps1 (يرفض قناعًا غير موثق) · host-preflight-windows.ps1 · ifrs.env.windows.example · runbooks deploy/rollback/bootstrap.
- **بوابة migrations جاهزة:** `deploy-migrate.mjs` (اختبارها على المضيف ضمن 5B.3).
- **ما لم يُثبت بعد (مؤجل للمضيف عمدًا — لا overclaim):** سلوك الإيقاف الرشيق عبر WinSW (CTRL_BREAK→Node) — 5B.4 (السلامة عند القتل بنيوية ومثبتة: WAL + ملفات حالة ذرية + D7)؛ Junctions وصلاحياتها؛ ACLs؛ Caddy XDG على Windows؛ اسم المضيف/DNS/وثوق العملاء؛ القناع الفعلي للشبكة.

## 7) Residual Risks (مفتوحة — بما فيها الملاحظة الإلزامية)

- **R-1 (إلزامية — نص المستخدم):** **lost epoch cryptographic/session-generation invalidation** يبقى **بند hardening مفتوحًا قبل Production Acceptance النهائي (إغلاق Phase 5)**. آلية unix-seconds الحالية = *آلية عملية لإنتاج قيمة جديدة عالية تُبطل كل توكنات عائلة العدّاد القديم* — **وليست ضمانًا رياضيًا مطلقًا أنها أعلى من كل epoch سابقة** (لا يمكن إثبات محتوى ملف ضاع). لم يُغيّر الكود بسببها — مسجلة هنا وفق التوجيه.
- **R-2:** RPO≤24h غير محقق — النسخ اليدوي وحده لا يحققه (جدولة+تحقق+off-device في 5B.5 ثم إعلان مُختبر).
- **R-3:** كل بنود «المؤجل للمضيف» (§6) — تُغلق 5B.3/5B.4 بالتنفيذ اليدوي الموثق.
- **R-4:** أسرار الاختبار في المصفوفة قيم وهمية معلنة (`p5b2-...`) — لا سر حقيقي في المستودع؛ التوليد الفعلي على المضيف حصرًا (5B.3).
- **R-5:** `IFRS_BIND_ALLOW_NON_LOOPBACK=1` فتحة هروب موثقة — خطأ تشغيلي محتمل إن استُخدمت بلا جدار؛ التوصية: لا تُستخدم إطلاقًا في هذا الإنتاج.
- **R-6:** typo سجل في `src/app/api/health/route.ts` (سطر `"ealth]"`) — إصلاحه حُجب بسلوك بيئة Z.ai (استعادة هذا الملف حصرًا إلى HEAD خلال <3 ثوانٍ). تجميلي حصرًا — يُرفع مع أول commit من المضيف في 5B.3.

## 8) Git status وcommit

- **قبل commit:** تعديلات 5B.2 المدرجة §2 فقط + artifacts التشغيلية غير المرسلة (`.zscripts/dev.pid`, `db/custom.db*`) — **لم تُضم**.
- **Commit:** واحد — `Phase 5B.2: host-prep readiness — loopback bind enforcement + rightmost XFF anti-spoofing + deterministic migration gate (deploy-migrate) + env-file shared parser + 92/92 non-destructive gate suite + Windows templates updates + worktree classification (upload route restored as reset debris; tsconfig .next-prod types included deliberately)` — المعرف يُسجل في worklog بعد الإنشاء.
- **لا push من Z.ai** (لا مصادقة) — الدفع من Windows عبر النمط المعتمد (bundle تزايدي إن لزم).

## 9) ما يحتاج تنفيذًا يدويًا على Windows (الانتقال إلى 5B.3/5B.4)

1. دفع commit 5B.2 من Windows (نمط bundle إن لزم).
2. **5B.3 (تهيئة المضيف/البيانات):** إنشاء `ifrs-svc` + `C:\Apps\ifrs-comparison\{releases,tools,bin,config}` + `D:\IFRS-Data\{db,config,logs,auth,maintenance,recovery,restore-staging,caddy}` + `D:\IFRS-Backups`؛ توليد NEXTAUTH_SECRET مرة واحدة ([Convert]::ToBase64String(...48 bytes)) داخل ifrs.env بACL صارمة؛ clone من GitHub عند commit 5B.2؛ بناء + `deploy-migrate --dry-run` ثم تنفيذ على قاعدة الإنتاج الجديدة؛ bootstrap أول مدير (SETUP_BOOTSTRAP_ENABLED=1 ثم إزالة فورية)؛ تثبيت خدمات WinSW.
3. **5B.4 (LAN + متانة):** توثيق القناع من `ipconfig /all` ثم `firewall-ifrs.ps1 -LanSubnet <الموثق>`؛ Caddy `tls internal` + اختبار LAN من جهاز ثانٍ؛ إعادة تشغيل كاملة (service + Windows reboot) والتحقق: epoch لم يرجع، الحالة محفوظة، health healthy؛ فحص الربط الفعلي (`netstat -ano | findstr :3000` ⇒ 127.0.0.1)؛ إثبات الإيقاف الرشيق/القتل.
4. **5B.5:** جدولة النسخ + تحقق + off-device ثم إعلان RPO مُختبر.

---

**بوابة 5B.2: PASS — بانتظار مراجعة المستخدم.**
لم تُعلن Phase 5 Production Accepted، ولم يبدأ 5C.
