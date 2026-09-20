# Phase 5A — Runbook النشر الإنتاجي (artifact داخل Git — التنفيذ في 5B/5C).

> حاكم: **deployment لا يستطيع حذف DB/Backup/VAR/secrets** — كلها خارج شجرة
> releases بنيويًا، والخدمة للقراءة فقط على الشجرة (`ReadWritePaths` محصورة).
> **Code rollback ≠ Data rollback** (runbook منفصل).

## النشر (كل الخطوات على الخادم كمستخدم إداري)

1. **Backup**: نسخة عبر المحرك (API) ⇒ المستوى `VALIDATED` على الأقل.
2. **Off-device**: مزامنة النسخة إلى الوسيط الخارجي (5C).
3. **Restore Drill**: تدريب استعادة على النسخة الأخيرة ⇒ `RESTORE_VERIFIED`
   — إثبات أن الحالي قابل للاستعادة **قبل** أي تغيير.
4. **Build** (مع `TAG` = وسم الإصدار):
   ```bash
   cd /srv/ifrs-comparison/src
   git fetch --tags && git checkout "$TAG"
   bun install --frozen-lockfile
   bun run build                      # next build + نسخ static/public إلى standalone
   rsync -a --delete .next/standalone/ "/srv/ifrs-comparison/releases/$TAG/"
   rm -rf "/srv/ifrs-comparison/releases/$TAG/db" \
          "/srv/ifrm-comparison/releases/$TAG/var" 2>/dev/null
   rm -f  "/srv/ifrs-comparison/releases/$TAG/.env"
   echo "$TAG" > "/srv/ifrs-comparison/releases/$TAG/RELEASE_ID"
   ```
   > بند 5A المثبت: حذف `db/ var/ .env` من المخرج المستقل إلزامي —
   > file tracing قد ينسخ بيانات/تهيئة داخل الإصدار (خطر مسارات خاطئة).
5. **Switch + restart**:
   ```bash
   ln -sfn "/srv/ifrs-comparison/releases/$TAG" /srv/ifrs-comparison/current
   systemctl restart ifrs-comparison
   ```
6. **Health checks**:
   ```bash
   curl -fsS http://127.0.0.1:3000/api/health        # {"status":"healthy"}
   systemctl status ifrs-comparison                  # active، بلا restarts
   journalctl -u ifrs-comparison -n 50               # preflight: OK mode=normal
   ```
7. **Application regression** (دخان موثق): دخول فعلي · إنشاء مجموعة · تقرير
   ودورة workflow · dashboard · قائمة النسخ · Drill صغير.
8. **Rollback إذا فشل أي فحص** ⇒ runbook-rollback.md — لا محاولات إصلاح حية.

## معايير النجاح

- preflight سطر `OK` بلا FATAL.
- health = healthy (200).
- جلسة دخول جديدة تعمل والepoch لم يتغير.
- لا فشل كتابة في التدفق الأساسي.
