# Phase 5 — Deployment & Server Hardening — Design Document

> **الحالة: وثيقة تصميم فقط — لم يُنفَّذ أي تغيير.** لا نقل للقاعدة، لا إنشاء خدمة،
> لا تعديل Caddy أو `.env` أو جدار حماية. التنفيذ يبدأ فقط بعد موافقة صريحة،
> ومقسّم إلى مراحل 5A / 5B / 5C (القسم 13).
>
> سياق ما قبل هذه المرحلة: Phase 4B كاملة مغلقة (4B.1 بوابة المحرك 71/71×2،
> 4B.2 استعادتان إنتاجيتان حقيقيتان 27/27، 4B.3 بوابة أمن الاستعادة 45/45 HTTP
> + جردان حاكميان) — آخر التزام: `ce682db`.

---

## 1. Current Environment Assessment — تقييم البيئة الحالية (فحص فعلي للقراءة فقط)

### 1.1 الحقائق المرصودة

| البند | القيمة المرصودة |
|---|---|
| نظام التشغيل | Debian 13 (trixie) userland داخل حاوية Kata؛ kernel `5.10.134-013.15.kangaroo.al8` |
| نظام الملفات للجذر | overlayfs (لا يوجد قرص ext4/xfs حقيقي ظاهر) — سعة 9.9G، متاح 7.8G |
| المستخدم المشغّل للتطبيق | `z` (uid 1001، غير root) — نفسه مالك الشجرة كلها (كود + بيانات + .env) |
| PID 1 | `tini -- /start.sh` ⇒ **لا systemd في هذه البيئة إطلاقًا** (`/run/systemd/system` غير موجود) |
| أدوات الجدار الناري | `ufw` / `iptables` / `nft` **غير مثبتة** |
| طريقة تشغيل Next.js الحالية | **`next dev -p 3000` (وضع تطوير!)** عبر `bun run dev`؛ العملية `next-server (v16.1.3)` |
| إصدارات الأدوات | bun 1.3.14 · node v24.21.0 · npm 11.19.0 |
| إخراج البناء | `output: "standalone"` مُعد في next.config.ts؛ `build` ينسخ static+public إلى standalone؛ `start` = `NODE_ENV=production bun .next/standalone/server.js` |
| Caddy في هذه البيئة | يُدار من المنصة (PID 2، root، `/app/Caddyfile`) على المنفذ :81؛ يوجد `Caddyfile` بالمشروع بنفس منطق `XTransformPort` (التحويل إلى localhost:{port} وإلا localhost:3000) وتمرير `X-Forwarded-For/Proto/Real-IP` — **لا يمكن تنفيذ/فحص caddy من الطرفية هنا** |
| المنافذ المستخدمة | :81 (بوابة Caddy) · :3000 (Next، مربوط على 0.0.0.0!) · 12600/19001 (loopback، منصة) · 19005/19006 (منصة) |
| الشبكة | IP الحاوية `21.0.14.3/32` عبر eth0 — **شبكة overlay للمنصة وليست LAN حقيقية**؛ البوابة 21.0.0.1 |
| مسار المشروع | `/home/z/my-project` (app name: `ifrs-comparison-tool` 1.0.0) |
| قاعدة البيانات | `/home/z/my-project/db/custom.db` (368 KB) + `custom.db-wal` + `custom.db-shm` — على overlayfs |
| VAR_DIR الفعلي | الافتراضي `<project>/var` — مُعاد إنشاؤه بعد مسح البيئة في 4B.3 (فيه الآن `auth/session-epoch` فقط + أدلة اختبار) |
| BACKUP_DIR الفعلي | الافتراضي `<project>/var/backups` (فارغ حاليًا)؛ وينبض ملف يدوي قديم `backups/pre-3.5A-….db` بجذر المشروع |
| .env | `/home/z/my-project/.env` — **50 بايت، يحوي DATABASE_URL فقط**؛ **الصلاحيات 0755 (قابلة للقراءة للجميع — خلل)**؛ فقد NEXTAUTH_SECRET وRESTORE_ENGINE_ENABLED (تشخيص 4B.3، لم يُصلَّح عمدًا) |
| الذاكرة/CPU | 3.9 GiB RAM (بلا swap) · 2 vCPU |
| مجلد upload | `/home/z/my-project/upload` = **tmpfs + ossfs** (مساحة متطايرة/شبكية — غير صالحة لأي حالة دائمة) |
| خدمة systemd قائمة | **لا يوجد** (مستحيل بنيويًا هنا) |

### 1.2 السلالات المعمارية الموجودة أصلًا لصالح Phase 5 (بدون أي تعديل)

`src/lib/backup-config.ts` يوفّر **خطّافات env جاهزة بمسارات مطلقة**:

- `VAR_DIR` ⇒ جذر الحالة التشغيلية (epoch، maintenance/state.json، recovery/، restore-staging/، auth/)
- `BACKUP_DIR` ⇒ مجلد النسخ الرسمي (افتراضي `var/backups`)
- `DATABASE_URL` ⇒ مسار القاعدة كاملًا
- `NEXT_DIST_DIR` ⇒ بناء معزول بجانب dev دون تعارض (استُخدم في 4B.1 للاختبار المعزول)

⇒ **الانتقال إلى مسارات دائمة = تعريف env في ملف أسرار نظامي، بلا تعديل سطر كود واحد في هذه النقاط.**

### 1.3 أهم الملاحظات الحرجة التي تعالجها هذه الوثيقة

1. **التشغيل الحالي وضع تطوير** (`next dev`): إعادة ترجمة على كل طلب، رسائل خطأ تفصيلية، أداء غير مستقر — غير مقبول إنتاجيًا.
2. **`.env` هش وفضفاض**: أُعيد إنشاؤه مرة بـ 50 بايت فقط (فقد السر) وصلاحياته 0755 — الدرس المؤسس لوثيقة هذه المرحلة.
3. **var/ داخل شجرة المشروع**: دليلُ فقدها واقعي (حدث في 4B.3) — Session Epoch وRecovery Log وstate كلها ظنت نفسها.
4. **Next مربوط على 0.0.0.0**: في الإنتاج يجب الربط على loopback وإيقاف أي وصول مباشر.
5. **لا `busy_timeout` ولا ضبط PRAGMA صريح في `db.ts`** (WAL قائم من ملف القاعدة، لكن busy_timeout لكل اتصال وليس دائمًا) — بند تنفيذ في 5A.
6. **`db.ts` يسجّل كل استعلام (`log: ['query']`)** حتى في الإنتاج — ضجيج وأداء؛ يُضبط في 5A.
7. **لا يوجد فحص fail-closed لـ NEXTAUTH_SECRET عند الإقلاع**: NextAuth v4 يقبل غيابه ويشتق سرًّا مؤقتًا في dev بصمت — سلوك محظور حكميًا (القسم 7).
8. **هذه البيئة Sandbox وليست خادم LAN الحقيقي**: لا systemd ولا جدار ناري ولا Caddy مملوك لنا. لذا التنفيذ ينقسم فعلًا إلى عمل **داخل المستودع قابل للاختبار هنا** (5A) وعمل **على الخادم الحقيقي** (5B/5C).

---

## 2. Proposed Production Architecture — المعمارية الإنتاجية المقترحة

```
┌─────────────────────────────── خادم LAN (جهاز مادي/VM دائم) ───────────────────────────────┐
│                                                                                             │
│   متصفح المستخدمين (LAN subnet موثقة عند التنفيذ)                                          │
│        │  HTTPS :443 (شهادة Caddy الداخلية أو قرار فتح)                                     │
│        ▼                                                                                    │
│   ┌─────────────┐    proxy 127.0.0.1:3000 (loopback حصرًا)    حدود جسم/مهلات مخصصة          │
│   │    Caddy    │ ─────────────────────────────────────────────▶ ┌──────────────────────┐  │
│   │ (خدمة نظام) │◀──────── X-Forwarded-* من loopback فقط ────────│  Next.js standalone  │  │
│   └─────────────┘                                                │  (node server.js)    │  │
│        trusted_proxies = 127.0.0.1                               │  systemd: ifrs-      │  │
│        :3000 محجوب عن LAN (جدار + ربط loopback)                  │  comparison.service  │  │
│                                                                  └──────┬───────────────┘  │
│                                                                         │                  │
│   /etc/ifrs-comparison/ifrs.env ◀── EnvironmentFile (أسرار، 0640 root:ifrsapp)              │
│                                                                         │                  │
│   /srv/ifrs-comparison/current (symlink → releases/<tag>)   كود للقراءة فقط للخدمة         │
│   /var/lib/ifrs-comparison/     DB + WAL + epoch + maintenance + recovery + staging         │
│   /var/backups/ifrs-comparison/ النسخ الرسمية (+ sidecars)                                 │
│   /var/log/journal              دليل أحداث دائم (Storage=persistent)                        │
│                                                                                             │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                                   │ نسخة ليلية + مزامنة
                                   ▼
                     وسيط خارج الجهاز (NAS/SFTP/USB — قرار قسم 10)
```

مبادئ حاكمة:

- **فصل كامل**: الكود (قابل للاستبدال بالكامل) ≠ البيانات (لا يمسها deployment أبدًا) ≠ الأسرار (خارج Git خارج الشجرة).
- **العمق الدفاعي على :3000**: ربط العملية على 127.0.0.1 **و** جدار ناري يمنعها من LAN — طبقتان مستقلتان.
- **كل ما بُني في 4B يُحافظ عليه**: ملفات الحالة خارج القاعدة (VAR_DIR)، السجل الخارجي append-only، Write Guards، Session Epoch — الانتقال عبر env حصرًا.

---

## 3. Persistent Directory Layout — بنية المجلدات الدائمة

الاسم المقترح `<app> = ifrs-comparison` (من package name). **لا يُنفَّذ النقل الآن** — هذا القرار المعماري المستقر:

| المسار | الغرض | المالك/الصلاحيات | لماذا خارج شجرة المشروع |
|---|---|---|---|
| `/srv/ifrs-comparison/releases/<tag>/` | كود منشور (standalone self-contained) | `root:root` كتابة، `ifrsapp` قراءة فقط | إعادة النشر/الحذف لا تمس أي حالة |
| `/srv/ifrs-comparison/current` | symlink → `releases/<tag>` | root | تبديل ذري للكود = rollback فوري |
| `/var/lib/ifrs-comparison/db/` | `custom.db` + WAL + SHM | `ifrsapp:ifrsapp` 0750 dir / 0640 files | جذر البيانات الحاكم |
| `/var/lib/ifrs-comparison/` (VAR_DIR) | `maintenance/` `recovery/` (سجل الاسترجاع append-only) `epoch` `auth/` `restore-staging/` | `ifrsapp:ifrsapp` 0750 | deploy جديد أو حذف build لا يمسها |
| `/var/backups/ifrs-comparison/` (BACKUP_DIR) | النسخ ZIP + manifest + sidecar | `ifrsapp:ifrsapp` 0750 | خارج الكود خارج Git |
| `/var/log/ifrs-comparison/` | (اختياري) مخرجات ملفية إن طُلبت — الافتراضي journald فقط | `ifrsapp:ifrsapp` 0750 | — |
| `/etc/ifrs-comparison/ifrs.env` | EnvironmentFile: NEXTAUTH_SECRET + DATABASE_URL + VAR_DIR/BACKUP_DIR + NEXTAUTH_URL + PORT/HOSTNAME | **`root:ifrsapp` 0640** | أسرار خارج Git خارج الشجرة خارج النسخ العادية |

خريطة env الناتجة (تُكتب في `ifrs.env` عند 5B):

```ini
DATABASE_URL=file:/var/lib/ifrs-comparison/db/custom.db
VAR_DIR=/var/lib/ifrs-comparison
BACKUP_DIR=/var/backups/ifrs-comparison
NEXTAUTH_URL=https://<host-LAN>          # يُحدد عند 5B (hostname أو IP)
NEXTAUTH_SECRET=<يُولَّد مرة واحدة — لا يُطبع أبدًا>
PORT=3000
HOSTNAME=127.0.0.1
NODE_ENV=production
# RESTORE_ENGINE_ENABLED — سياسة القسم 12
```

ملاحظات:

- `restore-staging/` تحت VAR_DIR ⇒ عمليات الرفع/الـDrill لا تكتب في شجرة الكود، وتظل محسوبة على القرص الدائم نفسه (مساحة!).
- `auth/` (لو أضيف لاحقًا أي state مصادقة) يبقى 0700.
- النسخة اليدوية القديمة `backups/pre-3.5A-….db` بجذر المشروع تُرحَّل يدويًا إلى `/var/backups/ifrs-comparison/legacy/` عند 5B (بلا صلاحية restore رسمية حتى يُبنى لها Manifest).

---

## 4. systemd Design — تصميم الخدمة

### 4.1 مستخدم الخدمة

- مستخدم نظام مخصص `ifrsapp` (no-shell، no-home أو home معطل): `useradd --system --no-create-home --shell /usr/sbin/nologin ifrsapp`
- مالك كل مسارات البيانات (القسم 3) — التطبيق **لا يحتاج صلاحيات على أي شيء آخر**.
- البناء (`bun install`/`next build`) ينفَّذ بمستخدم إداري/root ثم `chown` للقراءة فقط — البناء ليس عمل الخدمة.

### 4.2 بناء الإنتاج

`next build` ثم `next start`-بالمعنى العملي: **standalone** — `node .next/standalone/server.js` (المخرج self-contained: server.js + node_modules + static + public بعد خطوة النسخ الموجودة في `build`). قرار runtime: `node` (v24 LTS) هو المرجع لstandalone ويُعتمد افتراضيًا مع اختبار دخان في 5A؛ `bun` بديل موثق — قرار مفتوح (قسم 12) يتطلب إثباتًا واحدًا فقط في 5A.

ملاحظة sandbox: البناء داخل بيئة التطوير يتم بـ `NEXT_DIST_DIR=.next-prod` كي لا يمس `.next` الخاص بـ dev (الخطاف موجود أصلًا).

### 4.3 وحدة الخدمة المقترحة (مسودة — تُنشأ فقط في 5B)

`/etc/systemd/system/ifrs-comparison.service`:

```ini
[Unit]
Description=IFRS Comparison Tool (Next.js production)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ifrsapp
Group=ifrsapp
WorkingDirectory=/srv/ifrs-comparison/current
EnvironmentFile=/etc/ifrs-comparison/ifrs.env
ExecStartPre=/srv/ifrs-comparison/bin/preflight.sh
ExecStart=/usr/bin/node .next/standalone/server.js
Restart=on-failure
RestartSec=5s
# لا حلقة إقلاع محية للمشكلة: 5 محاولات ثم توقف الخدمة — الدليل في journald
StartLimitBurst=5
StartLimitIntervalSec=120
TimeoutStopSec=60          # مهلة كافية لإتمام كتابات/نسخ قيد الدوران ثم SIGKILL
KillSignal=SIGTERM
LimitNOFILE=65535

# ── Hardening بلا كسر SQLite/النسخ/الاستعادة ──
NoNewPrivileges=true
PrivateTmp=true                    # التطبيق لا يعتمد /tmp للحالة (staging في VAR_DIR)
ProtectSystem=strict               # كل filesystem للقراءة فقط افتراضيًا
ProtectHome=true
ReadWritePaths=/var/lib/ifrs-comparison /var/backups/ifrs-comparison /var/log/ifrs-comparison
# ^ المبادلة الذرية للقاعدة = rename داخل /var/lib/ifrs-comparison/db ⇒ مسموح.
#   Pre-Restore Backup يكتب في /var/backups ⇒ مسموح. لا شيء آخر يكتب.
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
CapabilityBoundingSet=             # صفر قدرات
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
# MemoryDenyWriteExecute: يُترك OFF عمدًا — V8 JIT يحتاج W+X وإلا انهار.
UMask=0027

[Install]
WantedBy=multi-user.target
```

### 4.4 preflight.sh (ExecStartPre — فحص ما قبل فتح التطبيق)

فحوصات **نظام التشغيل** (المنطقية داخل التطبيق في القسم 9):

1. `ifrs.env` موجود ويقرأه ifrsapp، ويحوي المفاتيح الإلزامية (بلا طباعة قيم) — بما فيها NEXTAUTH_SECRET وDATABASE_URL وVAR_DIR/BACKUP_DIR.
2. المسارات الدائمة موجودة ومملوكة لـ ifrsapp (db/، maintenance/، recovery/، backups/).
3. مساحة حرة ≥ عتبة (مثلاً 1 GB أو 10% — يُحدد عند 5B).
4. `PRAGMA quick_check` عبر sqlite3 CLI إن توفر (أو يُترك للتحقق داخل التطبيق) — إخفاق ⇒ exit غير صفري ⇒ systemd يُعيد المحاولة ضمن StartLimit ويوقف — **fail-closed**.
5. لا حذف ولا إصلاح تلقائي — فقط تحقق ورسائل واضحة.

### 4.5 journald

`Storage=persistent` (تجهيز `/var/log/journal`) — إخفاق الخدمة/الإقلاع يترك أثرًا دائمًا محميًا من دورة إعادة تشغيل (يشترطه «لا يمحو restart loop دليل المشكلة»).

---

## 5. Caddy / LAN / TLS Design

### 5.1 النموذج

Browser → **Caddy :443** → `reverse_proxy 127.0.0.1:3000` — Next **لا يُعرَّض مباشرة أبدًا** (ربط loopback + جدار). في هذه البيئة Sandbox تبقى بوابة المنصة :81 كما هي ولا تُمس؛ التصميم للخادم الحقيقي حيث Caddy خدمة مملوكة (تثبيت من مستودع caddy الرسمي، مستخدم `caddy`).

مسودة `Caddyfile` الإنتاجي (تُنشأ في 5B):

```caddyfile
{
    admin off
}

https://<host-LAN> {
    tls internal                       # CA داخلية من Caddy — قرار القسم 5.3
    encode gzip

    # الثقة بالمحيل: loopback فقط
    @loopback remote_ip 127.0.0.1

    # حدود الجسم: الرفع الافتراضي 200MB (BACKUP_MAX_UPLOAD_MB) + هامش
    request_body {
        max_size 256MB
    }

    reverse_proxy 127.0.0.1:3000 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        # بثNDJSON للدردشة — بلا تخزين مؤقت
        flush_interval -1
        transport http {
            dial_timeout 5s
            read_timeout 30m           # رفع/تنزيل نسخ كبيرة
            write_timeout 30m
        }
    }

    # مهلات على مستوى الموقع تسمح بعمليات Backup/Restore الطويلة
    timeouts {
        read_body   30m
        write       30m
        idle        10m
    }
}
```

- **forwarded headers / trusted proxy**: التطبيق يقرأ `X-Forwarded-For/X-Real-IP` أصلًا (audit.ts)؛ Caddy هو من يضعها، والتطبيق يقبلها من loopback فقط عمليًا لأن الوصول المباشر محجوب (ربط + جدار) ⇒ لا انتحال IP من LAN.
- **حدود الجسم**: 256MB ≥ 200MB الافتراضي للتطبيق (`BACKUP_MAX_UPLOAD_MB` قابل للرفع بنفس نسبة الهامش إن رُفع الحد).
- **مهلات**: 30 دقيقة تغطي رفع ZIP 200MB على أبطأ شبكة LAN واقعية + Drill + تنزيل؛ التوازن: قطع الاتصالات المعلقة بدل تثبيت الموارد ساعات.

### 5.2 عناوين LAN

تُوثَّق subnet الحقيقية والـ IP الثابت للخادم عند 5B (أمر التنفيذ: `ip addr`، `ip route`، مراجعة DHCP/الراوتر). في هذه البيئة المرصودة `21.0.14.3/32` overlay — **لا تُعتمد إطلاقًا**.

### 5.3 HTTPS داخل LAN — الخيار والمتطلبات

- **الموصى به: `tls internal` (CA داخلية من Caddy)** — شهادة صالحة للـ hostname أو حتى IP الصريح في عنوان الموقع (Caddy يضم IP كـ IP SAN).
- **لا يُفترض أن HTTPS موثوق تلقائيًا**: شهادة CA داخلية غير موثوقة حتى **تُثبَّت** شهادة الجذر على كل جهاز مستخدم:
  - تصدير الجذر: من `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`.
  - Windows: تثبيت في «المؤسسات الموثوقة» (إن أمكن عبر Group Policy) أو يدويًا لكل جهاز.
  - macOS/iOS: تثبيت ملف تعريف + **تفعيل ثقة كاملة** يدويًا (خطوة إلزامية شهيرة).
  - Android: إعداد مستخدم/نظام حسب الإصدار.
  - بديل أنظف مؤسسيًا: hostname ثابت + إدخال في `/etc/hosts` أو DNS داخلي، وشهادة للاسم.
- **بدائل مفتوحة** (قرار مفتوح، قسم 12): (أ) HTTP صريح داخل LAN معتمدًا على عزل الشبكة — أبسط لكن كلمات المرور تمر نصًا؛ (ب) HTTPS داخلي كما أعلاه. **توصية التصميم: HTTPS داخلي + دليل تثبيت ثقة مكتوب لكل نوع جهاز + قرار تأكيد قبل 5B.**

---

## 6. Firewall Design (nftables — جدار مستقبلي على الخادم الحقيقي فقط)

مبدأ: **تُوثَّق subnet الفعلية وخطة rollback أولًا**، ثم تُطبَّق بقاعدة «تطبيق مؤقت مؤمَّن»:

- `nft -f` مع جدول كامل قابل للإرجاع بملف معاكس جاهز.
- تنفيذ عبر جلسة SSH نشطة + مهلة تلقائية (`at now + 5 minutes` يفك القواعد ما لم يُؤكَّد النجاح) — **ضمان عدم فقدان الوصول**.

مسودة القواعد (تُنشأ في 5B فقط بعد توثيق subnet):

```nft
table inet ifrs_filter {
  chain input {
    type filter hook input priority 0; policy drop;
    iif "lo" accept
    ct state established,related accept
    # Caddy من LAN فقط (subnet حقيقية توثق عند التنفيذ)
    ip saddr <LAN_SUBNET> tcp dport 443 accept
    ip saddr <LAN_SUBNET> tcp dport 80 accept     # تحويل إلى HTTPS فقط
    # SSH إداري — من مضيف/شبكة إدارة محددة
    ip saddr <ADMIN_SUBNET> tcp dport 22 accept
    counter log prefix "ifrs-drop: " drop          # أثر قابل للتشخيص
  }
}
```

- **3000 عن LAN محجوب ضمنيًا** (policy drop + لا قاعدة له) — والربط على loopback يجعل الحجب نظريًا أصلًا (طبقتان).
- لا NAT ولا forward — خادم واحد.
- في Sandbox: لا تنفيذ إطلاقًا (لا أدوات موجودة أصلاً).

---

## 7. Secrets Strategy — NEXTAUTH_SECRET

### 7.1 التثبيت الدائم (خارج Git، عبر restart/reboot/deployment)

- يُولَّد **مرة واحدة**: `openssl rand -base64 32` — يُكتب في `/etc/ifrs-comparison/ifrs.env` (root:ifrsapp 0640).
- لا يمر عبر Git لا في الماضي ولا المستقبل؛ لا في `.env` بشجرة المشروع؛ لا في أي نسخة ظاهرة.
- systemd `EnvironmentFile` يضمن قراءته عبر كل إقلاع — deployment جديد (releases جديدة) لا يمسه.
- **لا يتغير تلقائيًا**: لا آلية توليد عند الغياب — الغياب = رفض إقلاع (بند 7.3).

### 7.2 النسخ الاحتياطي/الاسترجاع للسر نفسه

فقدان السر لا يفسد البيانات — يبطل كل الجلسات (يعاد الدخول مرة واحدة)؛ لكن **يُحظر بنيويًا أن يظل الفقدان صامتًا**:

1. نسخة مشفرة off-device: ملف ifrs.env مشفّر بـ `age`/`gpg` بمفتاح إداري، يُخزن مع النسخ الوسيطة (قسم 10).
2. مظروف ورقي مختوم بالقيمة في أرشيف المؤسسة (خيار موصى به لبيئة صغيرة) — استرجاع يدوي مضمون حتى لو فشل كل شيء إلكترونيًا.
3. إجراء الاسترجاع موثق في runbook: استعادة ملف env ⇒ إعادة تشغيل الخدمة ⇒ إعلان «الجميع يعيد الدخول».

### 7.3 Fail-Closed عند الإقلاع (بند تنفيذ 5A في الكود)

- فحص عند إقلاع الخادم (نقطة `instrumentation.ts` — تعمل مرة عند التمهيد في Next 16):
  - NEXTAUTH_SECRET مفقود ⇒ **خروج فوري برسالة FATAL صريحة** (لا طباعة القيمة) + exit code مميز.
  - طوله < 32 بايت أو قيمة placeholder معروفة ⇒ نفس المعاملة.
  - DATABASE_URL يشير لملف غير موجود/غير قابل للكتابة ⇒ نفس المعاملة.
- النتيجة: العملية تموت ⇒ systemd يعيد ضمن StartLimit ثم يوقف الخدمة ⇒ لا يشتغل النظام **بسر عشوائي بصمت أبدًا**، وCaddy يرد 502 واضح بدل «نظام يبدو يعمل وجلسات تتقلب».
- ملاحظة: الجلسات تُبطل أيضًا بقناة معتمدة أصلًا (Session Epoch) عند الاستعادة — السر لا يُستخدم للدوران (فصل D-10 الموثق).

---

## 8. Backup Durability — النسخ المحلية + Off-device

### 8.1 الوضع المحلي (موجود ويُحافظ عليه)

محرك 4A/4B: `VACUUM INTO` (لقطة متسقة) + integrity + fingerprint + Manifest v3 + SHA-256 + RESTORE_VERIFIED + Drill حقيقي — يبقى كما هو، وBACKUP_DIR يصير `/var/backups/ifrs-comparison/`.

### 8.2 أتمتة النسخ الليلية (تنفيذ 5C)

- systemd timer (مثلاً 01:00 بتوقيت المؤسسة) ينفذ **سكربت محلي** باسم ifrsapp يستدعي دوال `backup-server.ts` مباشرة (بدون HTTP ⇒ لا حاجة لحساب API مصادقة) — نفس الكود المُثبت، بلا منطق موازٍ.
- فشل النسخة ⇒ دخول journald + يظهر في لوحة النسخ (النسخة الغائبة ملحوظة بطبيعة القائمة) + عتبة تنبيه بسيطة في فحص الصحة التشغيلي.

### 8.3 Off-device — خيارات المرحلة (تُحدد النهائية قبل 5C، بلا تنفيذ Cloud الآن)

| الخيار | الملاءمة | تكلفة/ملاحظات |
|---|---|---|
| **SFTP pull من خادم/VM ثانٍ** | موصى به إن توفر مضيف ثانٍ | rsync عبر systemd timer؛ أمان جيد؛ لا اعتماد على منفذ مكشوف |
| **NAS/SMB mount** | إن وُجد NAS مؤسسي | mount دائم أو rsync إلى mount؛ لا يُكتب إلا بعد نجاح النسخة المحلية |
| **قرص خارجي USB** | أبسط بلا بنية شبكة | cron/`udev` أو يدوي مجدول؛ مخاطرة «منسي غير موصول» ⇒ تُدار بتنبيه عمر النسخة |

كل خيار ينقل: BACKUP_DIR كاملًا + **نسخة من سجل الاسترجاع** (قسم 11) + **نسخة مشفرة من ifrs.env** (قسم 7).

### 8.4 RPO ≤ 24h / RTO ≤ 30m — ما يتطلبه ذلك فعلًا

- **RPO ≤ 24h**: نسخة ليلية مؤتمتة (8.2) + مزامنة off-device خلال الساعات نفسها + مراقبة عمر آخر نسخة (تنبيه عند > 26h). أسوأ خسارة = ~24h كتابات.
- **RTO ≤ 30m** — توزيع زمني مستهدف بdrill مقاس في 5C:
  1. اكتشاف العطل (health/تنبيه) — ≤ 5 د.
  2. جلب آخر نسخة RESTORE_VERIFIED من الوسيط الخارجي — ≤ 10 د (يعتمد على الوسيط — يُقاس drill).
  3. Validate + Restore عبر المحرك — **دقائق** (الاستعادة الفعلية أثبتت ~2-3 ثوانٍ؛ التحقق الثلاثي دقائق).
  4. إعادة تشغيل + فحوص + دخان تطبيقي — ≤ 10 د.
- **شرط صادق**: RTO ≤ 30m على خادم واحد يفترض توافر وسيط خارجي جاهز + مشغّل مدرّب بrunbook + drill دوري. بلا ذلك، الهدف ناعم — يُعلن كخطر (قسم 12) لا كحقيقة.

---

## 9. Startup / Recovery Strategy — ربط 4B بإقلاع الخدمة

التسلسل عند إقلاع الخدمة:

```
systemd ──▶ ExecStartPre preflight.sh (نظام: أسرار/مسارات/مساحة/integrity سريع)
        ──▶ node server.js (التطبيق)
                 ├─ فحص fail-closed للأسرار (7.3) — إخفاق ⇒ exit ⇒ StartLimit ⇒ توقف الخدمة
                 ├─ قراءة Session Epoch (VAR_DIR دائم) — غير قابل للقراءة ⇒ fail-safe موثق (لا جلسات)
                 ├─ قراءة maintenance/state.json — التمييز:
                 │     NORMAL / DRAINING… / RECOVERY_REQUIRED
                 ├─ Crash Recovery (منطق 4B.1 القائم): عملية استعادة انقطعت منتصفًا
                 │     ⇒ إكمال/تراجع وفق الحالة الملتقطة أو الصعود بوضع محدود
                 └─ فتح التطبيق:
                       NORMAL  ⇒ /api/health = 200 ok
                       حالة خطرة/RECOVERY_REQUIRED ⇒ التطبيق **لا يموت**:
                            /api/health = 503 recovery_required
                            كتابات محجوبة (Write Guards قائمة) وواجهة تعرض الوضع
```

- **سلوك systemd عند RECOVERY_REQUIRED**: لا restart loop — التطبيق يظل حيًا في الوضع المحدود (Restart=on-failure لا ينطلق لأنه لا يوجد إخفاق عملية). **الدليل لا يمحوه شيء**: journald persistent + سجل الاسترجاع append-only في `/var/lib/.../recovery/`.
- مسار التطبيع يدوي موثق (runbook استرجاع 4B.1) — لا reset تلقائي أبدًا.
- عند إقلاع ما بعد استعادة متقطعة في حالة خطرة: **لا يُفتح NORMAL** — إما إكمال/تراجع آلي مُثبت في 4B.1 أو الوضع المحدود — يغطي شرط «لا يفتح التطبيق NORMAL إن كانت الاستعادة انقطعت في حالة خطرة».
- تحقق قاعدة عند الإقلاع: quick_check/integrity_check داخل منطق الإقلاع (5A يربطها في نفس المسار؛ preflight نظامي خلفي ثانٍ).

---

## 10. Deployment & Rollback Runbook (تصميم — يُدقَّق نصيًا في 5A ويُطبق في 5B/5C)

### 10.1 خطوات نشر نسخة جديدة (كلها على الخادم)

1. **Backup**: نسخة عبر المحرك ⇒ تحقق RESTORE_VERIFIED (API).
2. **Off-device**: مزامنة فورية للنسخة إلى الوسيط الخارجي.
3. **Drill**: استعادة تدريبية للنسخة الأخيرة (RESTORE_VERIFIED) — إثبات أن الحالي قابل للاستعادة **قبل** التغيير.
4. **Deploy preparation**: صيانة/تنبيه مستخدمي إن لزم (الوضع NORMAL كافٍ للبناء — التبديل لحظي).
5. **Build**: `git fetch && git checkout <tag>` في شجرة بناء ⇒ `bun install --frozen-lockfile` ⇒ `bun run build` ⇒ الناتج إلى `/srv/ifrs-comparison/releases/<tag>/`.
6. **Switch**: `ln -sfn` تبديل `current` ⇒ `systemctl restart ifrs-comparison`.
7. **Health checks**: `curl 127.0.0.1:3000/api/health` = ok · دخول فعلي · `/api/system/status` = NORMAL (للمصرّح).
8. **Application regression**: دخان موثق (دخول، إنشاء مجموعة، تقرير، قائمة نسخ، drill صغير).
9. **Rollback إذا فشل**: عودة `current` للإصدار السابق (symlink) ⇒ restart ⇒ نفس الفحوص — **دقائق**.

### 10.2 الضمانات البنيوية

- deployment **لا يستطيع** حذف DB/Backup/VAR/secrets: كلها خارج `releases/` بنيويًا، والخدمة نفسها للقراءة فقط على الشجرة (ReadWritePaths مقصورة)، و`releases/<tag>` القديم يبقى كاملًا.
- **Code rollback ≠ Data rollback**: عودة نسخة كود لا تمس القاعدة أبدًا؛ تراجع بيانات = قرار منفصل عبر مسار الاستعادة الحاكم فقط (محرك + مفتاح + تأكيدات + سجل) — لا تُستعاد قاعدة قديمة لمجرد فشل كود.
- كل خطوة لها معيار نجاح صريح وفشلها = توقف الإجراء لا «إكمال بأمل».

---

## 11. Recovery Log Durability

- الموضع الدائم: `/var/lib/ifrs-comparison/recovery/` (VAR_DIR) — **لا تغيير في الخاصية append-only** ولا في صيغة JSONL (eventId/timestamp/operationId/…).
- الدرس من 4B.3 (فقدان var/): «خارجي» يعني خارج كل ما يمكن لبيئة النشر إنشاؤه/حذفه — /var/lib + ownership مستقل يحققان ذلك على الخادم الحقيقي، والإقرار الصريح: في Sandbox الحالي لا ضمان مطلق (بيئة قابلة لإعادة الضبط) — يُتوثق كقيد بيئة لا كحل مؤجل.
- Off-device مستقبلًا (5C): نسخ النسخة (copy) للسجل مع كل مزامنة ليلية — **نسخ لا نقل ولا تدوير**؛ بدل التدوير: مراقبة حجم + أرشفة خارجية قراءة فقط.
- تصلبه لاحقًا (اختياري بعد 5C): `chattr +a` على ملف السجل الفعلي (يتطلب إدارة دقيقة عند أي حاجة شرعية نادرة) — يُقرر عند 5C.

---

## 12. Restore Engine Default — السياسة النهائية المقترحة (قرار تصميمي فقط، لا تغيير قيمة الآن)

| المعيار | always-enabled (=1 دائمًا) | normally-disabled (تفعيل تشغيلي عند الحاجة) |
|---|---|---|
| أمن الهجوم | مسار استعادة حي دائمًا | سطح أصغر نظريًا |
| حقيقة أمنية | البوابة **صارت صريحة 4B.3**: مفتاح restoreDatabase حصرًا + تأكيد ثانٍ + Recovery Lock + Write Guards + حالة صيانة + سجل حاكم — أثبتت كلها بالتدمير الحقيقي (71/71×2 و27/27) | نفس الضوابط لكن + خطوة تشغيلية |
| تشغيل الطوارئ | RTO مباشر (ثوانٍ-دقائق) | **يتطلب تعديل env + restart أثناء كارثة** — الدرس المؤسس: ملفات env في هذه البيئة فقدت قيمها بصمت (4B.3)؛ خطوة يدوية عصبية زمن كارثة = خطر إضافي |
| مخاطرة الفقد البنيوي للإعداد | لا شيء — القيمة في ifrs.env الدائم | قد يُكتشف الإعداد فاقدًا وقت الحاجة بالضبط |

**التوصية التصميمية: `RESTORE_ENGINE_ENABLED=1` دائمًا في الإنتاج** داخل `/etc/ifrs-comparison/ifrs.env` — لأن الأمن انتقل (4B.3) من «العلم مطفأ» إلى «الباب مقفل بمفتاح صريح»، ولأن إطفاء مسار الطوارئ الوحيد المُثبت يعارض RTO ≤ 30m ويكرر فشل 4B.3 البيئي. المقابل الرقابي: كل عملية تمر حتمًا عبر الحاكميات المثبتة، وحالة المحرك ظاهرة للمصرّح فقط في `/api/system/status`.
**لا تُغير القيمة الآن** — يُنفذ ضمن 5B مع ifrs.env.

---

## 13. تقسيم التنفيذ — 5A / 5B / 5C

### 5A — داخل المستودع (قابل للاختبار كاملًا في Sandbox؛ لا مس مستخدم/بيانات)

1. fail-closed للأسرار عند الإقلاع (instrumentation) + فحص DATABASE_URL.
2. `/api/health` المحدود المعلومات (ok / maintenance / recovery_required) — بلا أي بيانات مالية.
3. `db.ts` إنتاجي: إزالة تسجيل كل استعلام في production + `busy_timeout`/ضبط PRAGMA موثق.
4. ربط تحقق integrity في مسار الإقلاع + إعادة تأكيد سلوك RECOVERY_REQUIRED/limited boot بالاختبار المعزول.
5. **مصنوعات النشر كملفات مستودع** (لا تُنشأ على أي نظام): `deploy/ifrs-comparison.service`، `deploy/Caddyfile.prod`، `deploy/preflight.sh`، `deploy/nftables.conf`، `deploy/backup-nightly.sh`، `deploy/ifrs.env.example` (بلا قيم)، `deploy/runbook.md`.
6. إثبات production standalone في Sandbox: `NEXT_DIST_DIR=.next-prod next build` + تشغيل على منفذ معزول + فحوص.
7. lint + مصفوفة انحدار 4B الأخفيفة للتأكد من عدم كسر أي شيء.

### 5B — على الخادم الحقيقي (يتطلب توافر الجهاز وقرارات قسم 12)

1. تفتيش الخادم (نسخة 1.1 من هذا الجرد عليه) + تثبيت Node/Caddy.
2. إنشاء المستخدم والمجلدات (القسم 3) وifrs.env (توليد السر مرة واحدة + نسخة مشفرة off-device + مظروف).
3. تثبيت الخدمة + preflight + journald persistent.
4. نقل القاعدة + النسخ + سجل الاسترجاع (نسخ توقيف مؤقت قصير صيانة — إجراء موثق) + legacy backup.
5. Caddy + TLS/قرار الثقة + جدار nftables بقاعدة التطبيق المؤقت المؤمَّن.
6. تشغيل + مصفوفة اختبار 5C القسم الأولى (reboot/persistence/loopback/جدار).

### 5C — المتانة والتدريبات

1. النسخ الليلي المؤتمت + مزامنة off-device + تنبيه عمر النسخة.
2. تنفيذ مصفوفة الاختبار كاملة (القسم 14) وتوثيق زمن RTO المقاس.
3. Drill كامل: deployment وهمي + rollback كود + سيناريو فقدان قاعدة كامل باستعادة من الوسيط الخارجي.
4. تقرير Phase 5 النهائي + بوابة قبول.

---

## 14. Phase 5 Test Matrix — مصفوفة الإثبات المستقبلية

| # | الاختبار | النتيجة المتوقعة | المرحلة |
|---|---|---|---|
| 1 | Reboot كامل للخادم | الخدمة تعود وحدها بعد الإقلاع، صحة ok | 5B/5C |
| 2 | Persistence للقاعدة | بيانات ما قبل reboot موجودة حرفيًا | 5B/5C |
| 3 | Persistence للـ Session Epoch | نفس العدّاد عبر reboot؛ الجلسات القديمة باقية صالحة | 5B/5C |
| 4 | Persistence للـ Recovery Log | أحداث ما قبل reboot كاملة append-only | 5B/5C |
| 5 | Persistence لـ NEXTAUTH_SECRET | نفس السر (بلا طباعة) — الجلسات تعمل عبر reboot | 5B/5C |
| 6 | Login بعد reboot | نجاح دخول فعلي من متصفح LAN | 5B/5C |
| 7 | الوصول من جهاز LAN آخر | https يعمل ويثق بالشهادة (بعد تثبيت الجذر) | 5B/5C |
| 8 | حجب 3000 عن LAN | اتصال من LAN إلى :3000 يفشل (timeout/refuse) | 5B/5C |
| 9 | Caddy proxy | التدفق عبر :443 فقط؛ رؤوس التحويل صحيحة؛ IP الحقيقي في Audit | 5B/5C |
| 10 | HTTPS/trust | جهاز بلا جذر مثبت ⇒ تحذير شهادة؛ بعد التثبيت ⇒ موثوق | 5B/5C |
| 11 | Backup + Drill بعد deployment | نسخة جديدة RESTORE_VERIFIED عقب نشر نسخة كود | 5C |
| 12 | Restart أثناء Maintenance | إعادة تشغيل الخدمة في وضع صيانة لا تفتح NORMAL عشوائيًا؛ الحالة محفوظة | 5C |
| 13 | Startup في RECOVERY_REQUIRED | health = 503 recovery_required + كتابات محجوبة + لا حلقة إعادة تشغيل + الأدلة باقية | 5C |
| 14 | Code rollback بدون DB rollback | عودة releases سابقة؛ القاعدة وdata سليمة لم تُمس | 5C |
| 15 | سيناريو كارثة كامل | قاعدة تُحذف/تفسد ⇒ استعادة من off-device ≤ 30m مقاسة | 5C |
| 16 | fail-closed secrets | حذف السر (في بيئة اختبار معزولة) ⇒ الخدمة ترفض الإقلاع برسالة صريحة بلا سر جديد | 5A/5C |

---

## 15. المخاطر والقرارات المفتوحة

| # | البند | النوع | العلاج/القرار المطلوب |
|---|---|---|---|
| R1 | **الخادم الحقيقي غير محدد بعد** (مواصفات/وصول) | حاكم | تأكيد توافر الجهاز قبل 5B؛ مواصفة مقترحة: ≥2 vCPU، ≥4GB RAM، ≥40GB ext4/xfs حقيقي |
| R2 | **subnet LAN الفعلية غير موثقة** | حاكم | توثيق عند 5B قبل أي قاعدة جدار (شرط صريح في التصميم) |
| R3 | node أم bun لتشغيل standalone | فني | الافتراضي node (مرجع standalone)؛ إثبات دخان واحد في 5A يحسم أي بديل |
| R4 | HTTPS داخلي أم HTTP داخل LAN | حاكم/مؤسسي | توصية HTTPS داخلي + دليل ثقة لكل نظام؛ يتطلب قرارًا وتثبيت جذر على الأجهزة |
| R5 | العنوان: hostname أم IP صريح | فني | يحدد عند 5B (DNS/hosts مقابل IP SAN) — يربط بR4 |
| R6 | RTO ≤ 30m على خادم واحد يفترض وسيطًا جاهزًا ومشغّلًا مدرّبًا | تشغيلي | drill إلزامي في 5C؛ وإلا يُعلن الهدف ناعمًا |
| R7 | حدود هذه البيئة Sandbox (لا systemd/جدار/Caddy مملوك؛ قابل لإعادة الضبط) | بيئي | 5A كله قابل هنا؛ 5B/5C تتطلب الجهاز الحقيقي — يُعلن صراحة |
| R8 | بقايا غير ملتزمة من جلسة 4B.3 في الشجرة (تقارير/سكربتات معدلة) | نظافة Git | تنقية والتزام مستقل قبل/مع بداية 5A (بلا مزج مع commits 5A) |
| R9 | حجم staging + نسخ على قرص واحد | تشغيلي | عتبة مساحة في preflight + مراقبة؛ off-device هو شبكة الأمان |
| R10 | Prisma/SQLite على overlayfs بالحاوية | بيئي | إنتاجًا: ext4/xfs حقيقي فقط (شرط تصميمي، لا overlay/NFS/tmpfs) |

---

## 16. ما لم يُنفَّذ (التزام صريح)

لا تعديل ملفات نظام، لا نقل DB، لا جدار ناري، لا systemd service، لا تغيير Caddy،
لا تغيير `.env`، لا تغيير RESTORE_ENGINE_ENABLED — **هذه الوثيقة فقط + انتظار الموافقة.**
