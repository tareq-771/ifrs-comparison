#!/usr/bin/env bash
# Phase 5A — قالب preflight نظامي (artifact داخل Git — يُثبَّت في 5B على الخادم).
#
# الموضع عند التثبيت: /srv/ifrs-comparison/bin/preflight.sh (root:root 0755)
# يُستدعى من systemd كـ ExecStartPre — فشل أي فحص ⇒ exit غير صفري ⇒ لا إقلاع.
#
# فحوص نظام التشغيل فقط (المنطقية داخل التطبيق في instrumentation.ts):
#   • الملفات التنفيذية للإصدار موجودة
#   • ملف الأسرار موجود ويقرأه ifrsapp ويحوي المفاتيح الإلزامية (بلا طباعة قيم)
#   • المجلدات الدائمة موجودة ومملوكة
#   • مساحة قرص كافية
# لا حذف ولا إصلاح تلقائي إطلاقًا — فحص ورسائل واضحة.

set -u
FAIL=0

log()  { echo "[preflight] $*"; }
fail() { echo "[preflight] FATAL: $*" >&2; FAIL=1; }

RELEASE_DIR="${RELEASE_DIR:-/srv/ifrs-comparison/current}"
ENV_FILE="${ENV_FILE:-/etc/ifrs-comparison/ifrs.env}"
VAR_DIR_EXPECTED="/var/lib/ifrs-comparison"
BACKUP_DIR_EXPECTED="/var/backups/ifrs-comparison"
MIN_FREE_MB="${MIN_FREE_MB:-1024}"

# 1) ملفات الإصدار
for f in "$RELEASE_DIR/server.js" "$RELEASE_DIR/.next" "$RELEASE_DIR/node_modules"; do
  [ -e "$f" ] || fail "release artifact missing: $f (relative check only)"
done
[ -x "/usr/bin/node" ] || fail "node binary missing at /usr/bin/node"

# 2) ملف الأسرار: موجود، مقروء، ويحوي المفاتيح الإلزامية — لا قيم تُطبع أبدًا
[ -r "$ENV_FILE" ] || fail "env file not readable: $ENV_FILE"
if [ "$FAIL" -eq 0 ]; then
  for key in NEXTAUTH_SECRET DATABASE_URL VAR_DIR BACKUP_DIR RESTORE_ENGINE_ENABLED NEXTAUTH_URL; do
    grep -qE "^${key}=" "$ENV_FILE" || fail "env key missing: $key"
  done
fi

# 3) المجلدات الدائمة (من البيئة إن عُرفت وإلا الافتراضي المعماري)
VAR_DIR="${VAR_DIR:-$VAR_DIR_EXPECTED}"
BACKUP_DIR="${BACKUP_DIR:-$BACKUP_DIR_EXPECTED}"
for d in "$VAR_DIR" "$BACKUP_DIR" "$VAR_DIR/maintenance" "$VAR_DIR/recovery"; do
  [ -d "$d" ] || fail "persistent dir missing: $d"
done
if [ "$FAIL" -eq 0 ]; then
  OWNER="$(stat -c '%U' "$VAR_DIR")"
  [ "$OWNER" = "ifrsapp" ] || fail "persistent dir owner mismatch: $VAR_DIR owned by $OWNER (expected ifrsapp)"
fi

# 4) مساحة القرص (على قرص البيانات الدائم)
if [ "$FAIL" -eq 0 ]; then
  FREE_MB="$(df -Pm "$VAR_DIR" | awk 'NR==2{print $4}')"
  [ "$FREE_MB" -ge "$MIN_FREE_MB" ] || fail "low disk: ${FREE_MB}MB free (< ${MIN_FREE_MB}MB)"
  log "disk free: ${FREE_MB}MB"
fi

# 5) سلامة سريعة للقاعدة إن توفر sqlite3 (اختياري — التحقق الكامل داخل التطبيق)
DB_FILE="$(grep -E '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null | head -1 | sed -E 's/^DATABASE_URL=file://; s/ *$//')"
if [ "$FAIL" -eq 0 ] && [ -n "$DB_FILE" ] && command -v sqlite3 >/dev/null 2>&1; then
  if [ -f "$DB_FILE" ]; then
    RESULT="$(sqlite3 "file:$DB_FILE?mode=ro" 'PRAGMA quick_check;' 2>/dev/null | head -1 || true)"
    [ "$RESULT" = "ok" ] || fail "db quick_check failed: $RESULT"
  else
    fail "database file not found (no silent creation)"
  fi
fi

if [ "$FAIL" -ne 0 ]; then
  echo "[preflight] refusing to start (fail-closed)" >&2
  exit 1
fi
log "OK"
exit 0
