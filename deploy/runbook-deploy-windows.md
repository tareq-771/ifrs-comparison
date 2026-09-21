# Phase 5B.1 — Runbook النشر الإنتاجي على Windows (artifact داخل Git — التنفيذ 5B.2/5B.3).

> حاكم: **deployment لا يستطيع حذف DB/Backup/VAR/secrets** — كلها خارج شجرة
> releases بنيويًا (تنظيف assemble-release إلزامي + preflight يرفض أي مسار
> بيانات داخل شجرة النشر). **Code rollback ≠ Data rollback** (runbook منفصل).

## فصل الـartifact (قرار 5B.1 §3 — موثق)

- **Layer A — runtime:** مخرج standalone (server.js + التبعيات المتتبعة + static/public)
  + `prod-server.mjs` (مُشغّل يحمّل IFRS_ENV_FILE ويفرض NODE_ENV=production وcwd=جذر الإصدار)
  + `RELEASE_META.json` + `RELEASE_ID`.
- **Layer B — deployment/operator tooling:** Prisma CLI **لا يُنسخ مع كل إصدار** —
  يُثبّت مرة واحدة على المضيف: `C:\Apps\ifrs-comparison\tools\prisma-cli`
  (`npm install prisma@<نفس إصدار @prisma/client في الإصدار>`) ويُشار إليه عبر
  `PRISMA_CLI_HOME` في ifrs.env. لا حاجة لنسخ `node_modules` كاملًا في أي إصدار.

## النشر (كل الخطوات على المضيف Windows كمستخدم إداري)

1. **Backup**: نسخة عبر المحرك (API) ⇒ المستوى `VALIDATED` على الأقل.
2. **Off-device**: مزامنة النسخة إلى الوسيط الخارجي (5C — عند اعتماده).
3. **Restore Drill**: على النسخة الأخيرة ⇒ `RESTORE_VERIFIED` — إثبات أن الحالي
   قابل للاستعادة **قبل** أي تغيير (إلزامي إذا التغيير يحوي migration).
4. **Build** (مع `TAG` = وسم/SHA الإصدار):
   ```powershell
   cd C:\Apps\src\ifrs-comparison
   git fetch origin
   git checkout "$TAG"                       # origin/master أو tag معتمد
   bun install --frozen-lockfile             # Bun = أداة بناء فقط (لا runtime)
   bun run build                             # next build + node scripts/assemble-release.mjs
   # assemble-release: ينسخ static/public/prod-server.mjs، يطبّه db/var/.env/tool-results/test،
   # ويتحقق حتميًا، ويكتب RELEASE_META.json (sha + fingerprint + migrations)
   ```
5. **تجهيز مجلد الإصدار الجديد**:
   ```powershell
   robocopy ".next\standalone" "C:\Apps\ifrs-comparison\releases\$TAG" /E /NFL /NDL /NJH /NJS
   # ACL: ifrs-svc = Read+Execute على شجرة releases (لا كتابة إطلاقًا)
   ```
6. **Prisma migrate deploy** (إن وُجدت ترحيلات جديدة):
   ```powershell
   $env:DATABASE_URL = (Get-Content 'D:\IFRS-Data\config\ifrs.env' | Where-Object { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=',''
   & "C:\Apps\ifrs-comparison\tools\prisma-cli\node_modules\.bin\prisma.cmd" migrate deploy
   # فشل ⇒ لا تبديل — الخدمة القديمة تستمر (ترحيل SQLite = معاملة)
   ```
7. **التبديل + إعادة التشغيل** (الخدمة موقفة لحظيًا — لا نشر فوق إصدار جارٍ):
   ```powershell
   Stop-Service ifrs-app
   if (Test-Path C:\Apps\ifrs-comparison\current) {
     # حرر الـjunction قبل إعادة توجيهه (rmdir لا يحذف الهدف أبدًا)
     (Get-Item C:\Apps\ifrs-comparison\current).Delete()
     cmd /c mklink /J "C:\Apps\ifrs-comparison\current.prev" "C:\Apps\ifrs-comparison\releases\$PREV" | Out-Null
   }
   cmd /c mklink /J "C:\Apps\ifrs-comparison\current" "C:\Apps\ifrs-comparison\releases\$TAG" | Out-Null
   Start-Service ifrs-app
   ```
   > ملاحظة 5B.1 §11: إنشاء Junction وصلاحياته **تُختبر فعليًا في 5B.2** قبل
   > الاعتماد على هذا المسار — القالب يفترضها، التنفيذ ينتظر المضيف.
8. **Health checks**:
   ```powershell
   Invoke-RestMethod http://127.0.0.1:3000/api/health          # {"status":"healthy"}
   Get-Service ifrs-app                                        # Running بلا restarts متكررة
   Get-Content D:\IFRS-Data\logs\winsw\ifrs-app\*.log -Tail 50 # preflight: OK mode=normal بلا FATAL
   ```
9. **Application regression** (دخان موثق): دخول فعلي · مجموعة · تقرير ودورة
   workflow · dashboard · قائمة النسخ · Drill صغير.
10. **LAN HTTPS test** من جهاز ثانٍ: `https://<production-hostname>` — ثقة الشهادة + دخول.
11. **Audit/recovery state verification**: maintenance NORMAL · epoch لم يتغير ·
    ذيل recovery-log · صفوف AuditLog للنشر.
12. **الإتمام**: سجّل release-id + `$PREV` (مؤشر rollback في current.prev).

## Rollback إذا فشل أي فحص ⇒ runbook-rollback-windows.md — لا محاولات إصلاح حية.

## معايير النجاح

- preflight سطر `OK mode=normal` بلا FATAL.
- health = healthy (200) بجسم {status, app, serverTime} حصرًا (بلا version).
- جلسة دخول جديدة تعمل وepoch لم يتغير.
- لا فشل كتابة في التدفق الأساسي · SSRS على 80 يعمل كما كان.
