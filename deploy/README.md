# Phase 5 — deploy/ — قوالب النشر الإنتاجية (artifacts داخل Git فقط)

> هذه القوالب **لا تُثبَّت من هذا المجلد** — تُثبَّت على الخادم الحقيقي في
> Phase 5B بعد تفتيشه وتوثيق subnet/hostname. المصدر الحاكم:
> `docs/phase5-design.md` (المعتمد 83afe4e) + قرارات R3/R4/R5.

| الملف | الوجهة عند التثبيت (5B) | الغرض |
|---|---|---|
| `ifrs-comparison.service` | `/etc/systemd/system/ifrs-comparison.service` | خدمة الإنتاج (Node standalone + hardening لا يكسر المبادلة الذرية) |
| `preflight.sh` | `/srv/ifrs-comparison/bin/preflight.sh` (root:root 0755) | ExecStartPre: فحص نظامي fail-closed قبل تشغيل التطبيق |
| `Caddyfile.prod` | `/etc/caddy/Caddyfile` | HTTPS داخلي (R4) + hostname ثابت (R5) + حدود الجسم/المهلات |
| `nftables.conf` | `/etc/nftables.conf` | جدار: 443 من LAN فقط، 3000 محجوب، SSH إداري |
| `ifrs.env.example` | `/etc/ifrs-comparison/ifrs.env` (0640 root:ifrsapp) | تهيئة الإنتاج — بلا أسرار حقيقية هنا أبدًا |
| `runbook-deploy.md` | مرجع المشغّل | خطوات النشر + معايير النجاح |
| `runbook-rollback.md` | مرجع المشغّل | Code rollback ≠ Data rollback + فشل الإقلاع |

## إثبات 5A المرتبط

البنية نفسها (releases + current symlink + data/backups/secrets منفصلة +
preflight داخل التطبيق عبر instrumentation.ts + `/api/health`) أُثبتت
بالمحاكاة على artifact Node standalone حقيقي — انظر `docs/phase5a-report.md`.
