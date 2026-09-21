// Phase 5B.1 — مُشغّل الإنتاج (release-root) — Node حصرًا، بلا shell ولا tee.
// Phase 5B.2 — فرض ربط loopback حصري + إشارات إنهاء best-effort + محلل env مشترك.
//
// الغرض (نص المستخدم §9 + §I + §5 من متابعات 5B.2):
//   • وقت التشغيل الإنتاجي = Node (قرار R3 المعتمد) — bun أداة بناء فقط.
//   • الأسرار تُحمّل من ملف env واحد خارج Git وخارج releases (D:\IFRS-Data\config\ifrs.env)
//     بمسار صريح من بيئة الخدمة (IFRS_ENV_FILE عبر WinSW) — لا أسرار في سطر
//     أوامر، لا في XML الخدمة، لا في شجرة الإصدار.
//   • تحليل صارم KEY=VALUE عبر scripts/env-file.mjs (المصدر الوحيد للدلالات —
//     محلل مشترك مع deploy-migrate.mjs) — أسطر # تعليقات، السطر غير الصالح ⇒
//     فشل مغلق قبل أي تشغيل.
//   • يُنسخ تلقائيًا إلى جذر كل release بواسطة scripts/assemble-release.mjs
//     (مع env-file.mjs) ويحوّل cwd إلى جذر الإصدار (شرط PROJECT_ROOT في التطبيق).
//
// ربط loopback (قرار 5B.2 §5 — تحكم أساسي):
//   • HOSTNAME غير مضبوط ⇒ 127.0.0.1 افتراضيًا (آمن تلقائيًا حتى لو نُسي من الenv).
//   • HOSTNAME مضبوط على غير loopback ⇒ FATAL إلا مع IFRS_BIND_ALLOW_NON_LOOPBACK=1
//     (فتحة هروب موثقة صراحة — لا تُستخدم في هذا الإنتاج؛ 3000 لا يُعرض على LAN أبدًا).
//   • PORT غير مضبوط ⇒ 3000.
//
// الاستخدام عبر الخدمة (WinSW):
//   executable = node.exe   arguments = prod-server.mjs
//   workingdirectory = <release-current>   env IFRS_ENV_FILE = <ifrs.env path>

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { applyEnvFile } from "./env-file.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(`[prod-server] FATAL: ${msg}`);
  process.exit(1);
}

// 1) تحميل ملف البيئة الصريح (مصدر الأسرار الوحيد خارج Git/releases)
const envFile = process.env.IFRS_ENV_FILE?.trim() ?? "";
if (envFile) {
  try {
    applyEnvFile(envFile, { log: (m) => console.log(`[prod-server] ${m}`) });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

// 2) NODE_ENV=production إلزاميًا (حارس أخير — instrumentation يعتمدها fail-closed)
if (process.env.NODE_ENV !== "production") {
  if (process.env.NODE_ENV) {
    fail(`NODE_ENV=${process.env.NODE_ENV} — المُشغّل الإنتاجي يقبل production حصرًا`);
  }
  process.env.NODE_ENV = "production";
}

// 3) ربط loopback حصري (5B.2 — لا استماع على LAN من هذا المُشغّل إطلاقًا)
const LOOPBACK_BINDS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const bind = process.env.HOSTNAME?.trim() ?? "";
if (!bind) {
  process.env.HOSTNAME = "127.0.0.1";
  console.log("[prod-server] HOSTNAME غير مضبوط ⇒ 127.0.0.1 (loopback افتراضي آمن)");
} else if (!LOOPBACK_BINDS.has(bind.toLowerCase())) {
  const escape = process.env.IFRS_BIND_ALLOW_NON_LOOPBACK?.trim() === "1";
  if (!escape) {
    fail(
      `HOSTNAME=${bind} غير loopback — مُشغّل الإنتاج يربط 127.0.0.1 حصرًا. ` +
        `لتغيير مقصود: IFRS_BIND_ALLOW_NON_LOOPBACK=1 (غير موصى به — المنفذ لا يُعرض على LAN أبدًا)`
    );
  }
  console.warn(
    `[prod-server] WARNING: ربط غير loopback مقصود (${bind}) عبر IFRS_BIND_ALLOW_NON_LOOPBACK=1 — تأكد أن جدار النافذة يحمي هذا المنفذ`
  );
}

// 4) PORT افتراضي 3000 (نفس منفذ runbook/health checks)
if (!process.env.PORT?.trim()) {
  process.env.PORT = "3000";
}

// 5) إشارات إنهاء best-effort (SIGINT/SIGTERM/SIGBREAK — كونسول/مستقبلًا).
//    WinSW يوقف بإنهاء العملية بلا إشارة — سلامة المقاطعة مضمونة بنيويًا
//    (SQLite WAL + ملفات حالة ذرية + آلة صيانة/استرداد + epoch خارج القاعدة) —
//    مثبت في 5A (RECOVERY_REQUIRED restricted mode) و5B.1 (fs-retry/atomic swap).
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  try {
    process.on(sig, () => {
      console.log(`[prod-server] ${sig} — إنهاء (best-effort؛ سلامة المقاطعة بنيوية)`);
      process.exit(0);
    });
  } catch {
    /* منصة بلا هذا الإشارة — تجاهل */
  }
}

// 6) cwd = جذر الإصدار (server.js والمسارات النسبية للمشروع)
process.chdir(HERE);

// 7) تشغيل خادم standalone داخل نفس العملية (require — CJS كمواصفات Next)
const require = createRequire(import.meta.url);
require(path.join(HERE, "server.js"));
