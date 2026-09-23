# Phase 5B — Discovery Gate Report (BLOCKED — HOST REQUIRED)

- **التاريخ**: 2026 (جلسة 5B، فور اعتماد 5A)
- **Baseline المعتمد**: Phase 5A `2e382a4` + تقرير 5A `f8c0ab6` (لم يُمَسّ شيئ منهما)
- **نطاق هذا البوّاب**: Discovery فقط — قراءة فقط، **صفر تغييرات** على النظام أو المستودع (باستثناء هذا التقرير وسجل العمل)
- **الحُكم**: **BLOCKED — HOST REQUIRED** — البيئة الحالية ليست المضيف الدائم، ولا يجوز محاكاة 5B داخلها (بموجب شرط التوقف الصريح في تعليمات 5B)

---

## 1. أدلة الاكتشاف (Discovery Evidence)

جميع الأوامر أدناه تنفيذ فعلي على البيئة الحالية وقت التقرير، قراءة فقط.

### 1.1 PID 1 / systemd

```
$ ps -p 1 -o pid,comm,args
  PID COMMAND  COMMAND
    1 tini     /usr/bin/tini -- /start.sh

$ systemctl is-system-running
offline   (rc=1)

$ systemd-detect-virt
docker    (rc=0)
```

- **PID 1 = tini** — لا يوجد systemd manager شغّال.
- حزمة systemd 257.13-1~deb13u1 **مثبتة كملفات ثنائية فقط** (`install ok installed`)، لكن `systemctl is-system-running` يرجع `offline`: لا وحدة إدارة تعمل، إذن **لا وحدات systemd، لا ExecStartPre، لا Restart policy، لا StartLimitBurst، لا journald persistent** — أي أن التصميم المعتمد (§4 من phase5-design.md) **لا قابل للتنفيذ هنا**.

### 1.2 النوع الافتراضي (Virtualization) — Kata Containers

```
/proc/mounts (الجذر):
c-...-rootfs / overlay rw,relatime,
  lowerdir=/run/kata-containers/shared/containers/passthrough/c-.../rootfs_lower,
  upperdir=/run/builtin_wlayer/c-.../upper, ...

kataShared /.dockerenv virtiofs ro,relatime 0 0
```

- الجذر **overlayfs** مبنٍ من `kata-containers` shared rootfs — طبقة الكتابة **قصيرة العمر**.
- `/etc/hostname` و `/etc/hosts` و `/etc/resolv.conf` — جميعها **tmpfs** (تُحقن لكل إقلاع).
- الدليل السلوكي الموثّق سابقًا: نُسخ هذا الصندوق **أعادت تهيئة `.env` ومحتويات var/** أثناء جلسات 4B.3 و5A (موثّق في تقاريرهما).

### 1.3 العمر (Uptime) — نسخة طازجة

```
$ uptime
 21:01:03 up 7 min,  0 users,  load average: 0.17, 0.07, 0.02
```

- عمر النسخة عند الفحص **7 دقائق** — أُنشئت للتوّ، وهذا نمط بيئة ephemeral قابلة لإعادة الإنشاء، وليس مضيفًا دائمًا.

### 1.4 hostname / الشبكة / LAN

```
$ hostname; hostname -f
c-6ab047c8-14810412-d5409f758532   (FQDN = نفس القيمة)

$ ip -4 -brief addr show
lo    UNKNOWN  127.0.0.1/8
eth0  UP       21.0.7.200/32

$ ip route show
default via 21.0.0.1 dev eth0 onlink
```

- hostname = **معرّف نسخة سحابي**، وليس اسم مضيف LAN.
- العنوان `21.0.7.200/32` مع gateway `onlink` — شبكة point-to-point سحابية داخلية، **ليست LAN subnet قابلة للتحديد بثقة**، ولا يوجد broadcast/mDNS، ولا أجهزة LAN يمكنها الوصول لهذه البيئة.
- `/etc/resolv.conf` (tmpfs): `nameserver 100.100.2.136 / 100.100.2.138` — محلّلات سحابية داخلية.
- ⇒ **إثبات "hostname يُحلّ من أجهزة LAN" و"جهاز LAN واحد يثق بشهادة Caddy" غير قابل للتنفيذ هنا بنيويًا** — لا يوجد LAN أصلًا.

### 1.5 الأدوات

| الأداة | الحالة |
|---|---|
| Node.js | ✅ `v24.21.0` (`/usr/bin/node`) — المطلب الوحيد المتوفر |
| Caddy | ❌ غير مثبت (`dpkg-query: no packages found matching caddy`) وتنفيذ ثنائيات caddy محجوب بسياسة الصندوق |
| nft / iptables / ufw / firewall-cmd | ❌ جميعها NOT FOUND — لا سيطرة على جدار ناري |

### 1.6 نظام الملفات والموارد

```
rootfs: overlay — 9.9G إجمالي، 7.8G متاح
RAM: 3.9GiB | vCPU: 2
تراكيب إضافية: ossfs (upload/skills)، PolarFS (/tmp/my-project، /home/user_skills) — كلها mount سحابية
```

### 1.7 المستخدم والصلاحيات

```
$ whoami; id
z / uid=1001(z) gid=1001(z) groups=1001(z)

$ sudo -n true
sudo: a password is required   (rc=1)

$ stat -c '%A %U:%G %n' /srv /var/lib /etc
drwxr-xr-x root:root /srv
drwxr-xr-x root:root /var/lib
drwxr-xr-x root:root /etc
```

- المستخدم `z` **بدون صلاحيات root/sudo**: لا يمكن إنشاء `/srv/ifrs-comparison`، `/var/lib/ifrs-comparison`، `/var/backups/ifrs-comparison`، `/etc/ifrs-comparison/ifrs.env`، لا إنشاء مستخدم `ifrsapp`، لا تثبيت حزم، لا تحميل قواعد nftables، لا إعادة تشغيل حقيقي للخادم.

---

## 2. شروط التوقف المُفعّلة

| # | شرط التوقف (من تعليمات 5B) | الحالة | الدليل |
|---|---|---|---|
| 1 | المضيف ليس persistent حقيقيًا | **مُفعّل** | Kata + overlay rootfs + `/etc` tmpfs + عمر نسخة 7 دقائق + إعادة تهيئة موثّقة سابقًا |
| 2 | لا يوجد systemd رغم اعتماد التصميم عليه | **مُفعّل** | PID1=tini، `systemctl is-system-running` = offline |
| 3 | لا يمكن تحديد LAN subnet بثقة | **مُفعّل** | 21.0.7.200/32 سحابية onlink، لا LAN، لا mDNS |
| 4 | إثبات LAN device / TLS trust | **مستحيل بنيويًا** | لا توجد أجهزة LAN |
| 5 | اختبار reboot حقيقي | **مستحيل** | لا سيطرة على دورة حياة المضيف؛ إعادة تشغيل حاوية ≠ إعادة تشغيل خادم |
| 6 | الصلاحيات المطلوبة للتثبيت | **غير متوفرة** | مستخدم بلا sudo؛ /srv و/var/lib و/etc ملك root |

أي **3 شروط توقف صريحة مُفعّلة + عائق صلاحيات قاطع** — لم يتحقق شرط واحد من شروط "الخادم الحقيقي الدائم".

---

## 3. ما لم يُنفّذ عمدًا (وفق تعليمات 5B)

- **لا محاكاة 5B داخل هذه البيئة** — لا إنشاء layout في /srv أو /var/lib أو /etc، لا مستخدم ifrsapp، لا وحدات systemd، لا Caddy، لا nftables، لا secrets.
- **لا migration للبيانات**، ولا Safety Backup جديد، ولا لمس Production DB أو `.env`.
- **لا reboot**، ولا firewall، ولا أي تغيير نظامي.
- **لا بدء 5C** (Scheduled Backup / NAS/SFTP/USB / RPO/RTO / Cloud) — ممنوعة حتى إغلاق 5B.

القوالب الجاهزة للتنفيذ على المضيف الحقيقي موجودة بالفعل في `deploy/` (من 5A، artifacts في Git فقط):
`ifrs-comparison.service` · `Caddyfile.prod` · `ifrs.env.example` · `preflight.sh` · `nftables.conf` · `runbook-deploy.md` · `runbook-rollback.md` — وتصميم 5B الكامل في `docs/phase5-design.md` (§2–§14).

---

## 4. مواصفات المضيف المطلوب (Host Requirements)

لإلغاء الحجب وتنفيذ 5B فعليًا، يجب أن يوفر المضيف المقصود **كل** ما يلي:

1. **Persistence حقيقي**: جهاز فيزيائي أو VM مخصصة بمساحة تخزين دائمة (ext4fs مثلًا) على `/` — وليس حاوية ephemeral؛ يجب أن يبقى القرص بعد إعادة التشغيل دون استعادة snapshot.
2. **systemd شغّال كـ PID 1**: `systemctl is-system-running` ⇒ `running` (Debian 12/13 أو ما يعادلها).
3. **صلاحيات تثبيت root/sudo** للمشغّل المُنفّذ.
4. **شبكة LAN معروفة**: IPv4 ثابت أو DHCP محجوز + subnet موثّق + اسم مضيف قابل للحل من أجهزة LAN (DNS محلي أو mDNS) لا يتعارض مع أسماء قائمة.
5. **جهاز LAN اختباري واحد على الأقل** (لإثبات TLS trust والوصول).
6. **موارد**: ≥2 vCPU، ≥4GB RAM، ≥20GB قرص حر.
7. **برمجيات**: Node.js ≥20 LTS (أو يُثبَّت)، وCaddy (أو إذن تثبيته)، وnftables (أو يُثبَّت).
8. **وصول إداري SSH** من نطاق معروف (للحفاظ عليه أثناء تطبيق firewall).
9. **سيطرة على دورة حياة الجهاز**: إمكانية تنفيذ reboot حقيقي مرة واحدة لإثبات persistence (البوّاب رقم 10 من تعليمات 5B).

## 5. خطة الاستئناف عند توفر المضيف

1. تنفيذ **Discovery Gate كامل** على المضيف الجديد (نفس قائمة البنود أعلاه) واعتماد النتائج.
2. Safety Gate: backup → VALIDATED → RESTORE_VERIFIED + integrity/canonical/NORMAL.
3. إنشاء layout بالأدوات المميزة (root) + `ifrsapp` user + Ownership بأقل صلاحية.
4. Controlled migration (drain → إغلاق الخدمة القديمة → نقل DB+WAL/SHM+persistent state → تحقق SHA/integrity/canonical/counts).
5. Secrets في `/etc/ifrs-comparison/ifrs.env` (0640 root:ifrsapp، خارج Git، لا تُطبع).
6. نشر release versioned + `current` symlink + Node على `127.0.0.1:3000` فقط + systemd unit من القالب.
7. Caddy `tls internal` + hostname نهائي + تثبيت root CA على جهاز LAN اختباري.
8. nftables مع جلسة إدارة محفوظة + rollback مؤقت.
9. **reboot حقيقي** → إثبات بقاء DB/secret/epoch/maintenance/recovery log/backups/release.
10. LAN acceptance + port-3000 isolation + regression كامل + code rollback A→B→A.
11. تقرير 5B ثم **التوقف قبل 5C**.

---

## 6. الحالة عند إصدار التقرير

- المستودع: baseline 5A سليم (`2e382a4` + `f8c0ab6`)، بلا أي تغييرات كود من هذه الجلسة.
- شجرة العمل تحتفظ ببقايا 4B.3 المعروفة (mode-only diffs و db runtime) — غير مرتبطة بـ5B ولم تُمسّ.
- لا يوجد أي أثر تثبيت من 5B على هذا الصندوق (والقرار: لن يكون هناك أثر هنا أصلًا).
- **القرار النهائي: BLOCKED — HOST REQUIRED — 5B متوقفة، 5C لم تبدأ.**
