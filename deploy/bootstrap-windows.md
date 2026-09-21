# Phase 5B.1 — Runbook Bootstrap قاعدة الإنتاج وأول مدير (Windows) — artifact داخل Git.

> التنفيذ في 5B.3. القاعدة الإنتاجية **جديدة كليًا من migrations** —
> `db/custom.db` التطويرية ولا WAL/SHM ولا أي بيانات اختبار لا تدخل الإنتاج أبدًا
> (نص المستخدم §18).

## 1) إنشاء القاعدة (لا نسخ من Git)

```powershell
# DATABASE_URL من ifrs.env (file:D:/IFRS-Data/db/ifrs-prod.db) — المجلد موجود بالـACLs من 5B.2
$env:DATABASE_URL = 'file:D:/IFRS-Data/db/ifrs-prod.db'
& "C:\Apps\ifrs-comparison\tools\prisma-cli\node_modules\.bin\prisma.cmd" migrate deploy
# ⇒ يُنشئ ملف القاعدة + المخطط + _prisma_migrations (ترحيل SQLite = معاملة)
```

## 2) أول إقلاع (loopback حصرًا — قبل تمكين Caddy للـLAN)

- شغّل الخدمة (ifrs-app عبر WinSW). الإقلاع الأول: epoch bootstrap مشروع حصرًا
  لأن القاعدة بلا مستخدمين (قرار 5B.1 §4 — probeDbInitialized=false ⇒ إنشاء 1).
- تحقق: `Invoke-RestMethod http://127.0.0.1:3000/api/health` ⇒ healthy.
- تحقق بصمة المخطط: سجل الخادم يظهر `canonical schema ok: csha256:…` مطابقًا
  لـ`expectedSchemaFingerprint` في RELEASE_META.json.

## 3) أول مدير — سلسلة الحماية الكاملة (قرار 5B.1 §5 — لا حماية وحيدة)

الطبقات مجتمعة (كلها إلزامية معًا):
1. **بوابة صريحة مؤقتة**: `SETUP_BOOTSTRAP_ENABLED=1` في ifrs.env (غيابها في
   production ⇒ 403). أعد تشغيل الخدمة بعد إضافتها.
2. **صفر مستخدمين**: النهاية ميتة بعد أول مدير (فحص داخل معاملة + mutex + unique).
3. **سياسة كلمة مرور قوية**: ≥12 حرفًا + صغير/كبير/رقم + رفض قوائم الضعف —
   تُرفض بقيمة 400 عامة بلا تسريب.
4. **سلوك أحادي المرة**: محاولة ثانية (متزامنة أو لاحقة) ⇒ 409.
5. **إغلاق تلقائي**: حتى لو نُسي العلم مفعّلًا — صفر مستخدمين شرط حاكم.

الإجراء (من كونسول الخادم — RDP → متصفح → localhost عبر hosts مؤقت أو مباشرة
قبل توجيه Caddy):
```
POST http://127.0.0.1:3000/api/setup
{ "username": "<اسم إداري صريح>", "password": "<كلمة قوية 12+>", "displayName": "…" }
```
> بيانات الاختبار (admin/admin123 وغيرها) **غير موجودة** في أي مسار — لا
> fallback في الكود (حُذفت في 5B.1) ولا seed تلقائي (seed-admin.ts حُذف).

## 4) الإغلاق والأدلة

1. **أزل `SETUP_BOOTSTRAP_ENABLED` من ifrs.env فورًا** + أعد تشغيل الخدمة.
2. تحقق أن POST ثانٍ ⇒ 409 حتى مع العلم (لو أُسيء تفعيله لاحقًا).
3. أدلة: صف `USER_CREATED` في AuditLog (بلا أي كلمة مرور — Sanitizer + لا
   تمرير أصلًا) + طابع زمني + IP.
4. سجّل في runbook النشر: تاريخ bootstrap + من نفّذه + مرجع صف AuditLog.

## 5) بعدها فقط

- تمكين Caddy للتوجيه من LAN (5B.4) — نافذة التعرض الشبكي للـbootstrap = صفر.
- الاختبارات: دخول المدير الجديد · إنشاء مستخدمين بجداول صلاحياتهم الصريحة
  (restoreDatabase لا يُمنح ضمنيًا لأحد — حتى admin) · نسخة أمان أولى VALIDATED.
