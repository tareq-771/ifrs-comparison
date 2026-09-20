# Phase 5A — Runbook التراجع (artifact داخل Git).

## المبدأ الحاكم

**Code rollback ≠ Data rollback.**
- عودة نسخة الكود لا تمس القاعدة أبدًا — البيانات المكتوبة تحت النسخة الأحدث
  **تبقى** (مثبت في 5A: كتابات تحت Release B بقيت بعد العودة إلى A).
- تراجع **البيانات** = قرار منفصل حاكم عبر مسار الاستعادة الحاكم فقط
  (محرك + مفتاح `restoreDatabase` + تأكيدات + سجل استرجاع) — لا تُستعاد
  قاعدة قديمة لمجرد فشل نسخة تطبيق.

## Code rollback (دقائق)

```bash
PREV="$(cat /srv/ifrs-comparison/current.release.prev)"   # يُكتب عند كل نشر
ln -sfn "/srv/ifrs-comparison/releases/$PREV" /srv/ifrs-comparison/current
systemctl restart ifrs-comparison
curl -fsS http://127.0.0.1:3000/api/health                # healthy + version القديم
```

ثم فحوص الدخان نفسها (runbook-deploy خطوة 7).

## Data rollback (قرار استثنائي موثق)

1. توثيق القرار والسبب (عملية إدارية — ليس رد فعل نشر).
2. اختيار النسخة الهدف: `RESTORE_VERIFIED` حصرًا.
3. التنفيذ عبر محرك الاستعادة حصرًا (Restore workflow كامل: pre-restore
   backup ⇒ drain ⇒ swap ⇒ verify ⇒ epoch bump) — **أبدًا لا نسخ يدوي لملفات
   القاعدة**.
4. بعد الاستعادة: كل الجلسات القديمة ميتة (epoch+1) — إعلان إعادة الدخول.

## فشل الإقلاع (unhealthy / recovery_required)

- health = 503 `recovery_required` ⇒ النظام مقفول عمدًا (عملية سابقة مقطوعة).
  اتبع مسار الاسترداد الموثق (4B.1) — لا مسح حالة دون تحقق بشري موثق.
- health = 503 `unhealthy` ⇒ اقرأ `journalctl -u ifrs-comparison` — رمز السبب:
  `boot_config` (أسرار/مسارات) · `database` · `schema` · `epoch`.
- الخدمة متوقفة بعد StartLimit ⇒ لا تعيد التشغيل بشكل متكرر — عالج السبب من
  السجل (restart loop يمحو التشخيص = محظور؛ journald الدائم يحفظ الدليل).
