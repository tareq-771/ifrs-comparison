# Phase 5B.1 — Runbook التراجع على Windows (artifact داخل Git — التنفيذ 5B.2+).

## المبدأ الحاكم (المثبت 5A — يبقى حاكمًا)

**Code rollback ≠ Data rollback.**
- عودة نسخة الكود لا تمس القاعدة أبدًا — البيانات المكتوبة تحت النسخة الأحدث
  **تبقى** (مثبت في 5A: كتابات تحت Release B بقيت بعد العودة إلى A).
- تراجع **البيانات** = قرار منفصل حاكم عبر مسار الاستعادة الحاكم فقط
  (محرك + مفتاح `restoreDatabase` + تأكيدات + سجل استرجاع) — لا تُستعاد
  قاعدة قديمة لمجرد فشل نسخة تطبيق.

## فحص التوافق الإلزامي قبل أي rollback (قرار 5B.1 §19 — لا fingerprint فقط)

لكل إصدار `RELEASE_META.json` يحدد: `releaseId` / `gitSha` /
`expectedSchemaFingerprint` / `migrations` (قائمة أسماء) / `rollbackCompatDeclaration`.

**BLOCK rollback** إذا تحقق أي مما يلي على إصدار الهدف (prev):
1. `expectedSchemaFingerprint` في meta الهدف ≠ البصمة الحية للقاعدة (احسبها
   عبر فحص الcanonical في restore-operator أو preflight الخادم).
2. القاعدة الحية طبقت ترحيلات **غير موجودة** في قائمة `migrations` بالهدف
   (مقارنة أسماء `_prisma_migrations` مع قائمة الهدف).

عدم التوافق ⇒ لا rollback ولا أي استعادة بيانات تلقائية — قرار معتمد:
fix-forward أو مسار استعادة البيانات الحاكم المنفصل.

الفحص العملي (PowerShell، على المضيف):
```powershell
$meta = Get-Content C:\Apps\ifrs-comparison\releases\$PREV\RELEASE_META.json | ConvertFrom-Json
$meta.expectedSchemaFingerprint      # قارن مع بصمة القاعدة الحية
$meta.migrations                     # قارن مع أسماء _prisma_migrations الحية
```

## Code rollback (دقائق — بعد نجاح الفحص)

```powershell
$PREV = (Get-Item C:\Apps\ifrs-comparison\current).Target   # أو من current.prev الموثق عند آخر نشر
Stop-Service ifrs-app
(Get-Item C:\Apps\ifrs-comparison\current).Delete()
cmd /c mklink /J "C:\Apps\ifrs-comparison\current" "C:\Apps\ifrs-comparison\releases\$PREV" | Out-Null
Start-Service ifrs-app
Invoke-RestMethod http://127.0.0.1:3000/api/health           # healthy + سجل يظهر fingerprint الهدف
```

ثم فحوص الدخان نفسها (runbook-deploy-windows خطوة 9).

## Data rollback (قرار استثنائي موثق — ليس رد فعل نشر أبدًا)

1. توثيق القرار والسبب (عملية إدارية).
2. اختيار النسخة الهدف: `RESTORE_VERIFIED` حصرًا.
3. التنفيذ عبر محرك الاستعادة حصرًا (Restore workflow كامل: pre-restore
   backup ⇒ drain ⇒ swap ⇒ verify ⇒ epoch bump) — **أبدًا لا نسخ يدوي لملفات
   القاعدة**.
4. بعد الاستعادة: كل الجلسات القديمة ميتة (epoch+1) — إعلان إعادة الدخول.

## فشل الإقلاع (unhealthy / recovery_required)

- health = 503 `recovery_required` ⇒ النظام مقفول عمدًا (عملية سابقة مقطوعة).
  اتبع مسار الاسترداد الموثق (4B.1: `bun scripts/restore-operator.ts --verify-and-clear`
  من مجلد الإصدار عبر Bun للبناء/التشغيل اللحظي، أو الأدوات المثبتة) — لا مسح
  حالة دون تحقق بشري موثق.
- health = 503 `unhealthy` (بلا سبب عام — قرار 5B.1 §6) ⇒ اقرأ سجل WinSW
  `D:\IFRS-Data\logs\winsw\ifrs-app\*.log` — رموز الأسباب عند الإقلاع:
  `boot_config` (أسرار/مسارات) · `database` · `schema` · `epoch`.
- **epoch مفقود/تالف على قاعدة مهيأة** ⇒ فشل مغلق (5B.1 §4) — لا إنشاء صمت:
  `bun scripts/restore-operator.ts --epoch-recover --confirm-epoch-loss`
  (القيمة الجديدة = unix-seconds تلقائيًا — لا إدخال يدوي).
- الخدمة متوقفة بعد استنفاد onfailure ⇒ لا إعادة تشغيل متكرر — عالج السبب
  من السجل (restart loop يمحو التشخيص = محظور).
