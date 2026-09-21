// Phase 5B.1 — تجميع إصدار الإنتاج من مخرجات next build (عبر-منصات، Node حصرًا).
//
// الغرض (نص المستخدم §9 + §18 + §19):
//   • استبدال `cp -r` POSIX بسلوك Node fs.cpSync — deterministic على Windows وLinux.
//   • نسخ static/public إلى standalone (نفس دلالات build القديم المعتمد 5A).
//   • نسخ prod-server.mjs (مُشغّل الإنتاج) إلى جذر الـrelease.
//   • تطهير إلزامي للـrelease artifact: db/ var/ .env* tool-results/ test —
//     بند 5A المثبت: file tracing قد ينسخ بيانات/تهيئة داخل الإصدار (خطر مسارات
//     خاطئة) — الحذف إلزامي، وأي بقايا ⇒ فشل البناء (لا إصدار ملوث أبدًا).
//   • كتابة RELEASE_META.json (§19): release id / git SHA / expected schema
//     fingerprint / مجموعة الترحيلات — أساس فحص توافق الـrollback قبل تنفيذه.
//
// Bun يبقى أداة بناء/إدارة حزم (bun install) — وقت التشغيل الإنتاجي Node حصرًا.
// هذا السكربت أداة بناء (build-time) — لا علاقة له بخدمة الإنتاج.

import { cpSync, existsSync, rmSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
// يحترم NEXT_DIST_DIR (بناء إنتاجي معزول جنبًا إلى جنب مع dev دون تعارض)
const DIST = process.env.NEXT_DIST_DIR || ".next";
const STANDALONE = path.join(ROOT, DIST, "standalone");
// static يعيش داخل مجلد الـdist نفسه (<dist>/static) — لا في .next الثابت

function fail(msg) {
  console.error(`[assemble-release] FATAL: ${msg}`);
  process.exit(1);
}

if (!existsSync(path.join(STANDALONE, "server.js"))) {
  fail(".next/standalone/server.js غير موجود — شغّل next build أولًا");
}

// 1) نسخ static + public (نفس دلالات البناء المعتمد 5A)
const staticSrc = path.join(ROOT, DIST, "static");
const staticDst = path.join(STANDALONE, ".next", "static");
if (!existsSync(staticSrc)) fail(`${path.relative(ROOT, staticSrc)} مفقود — بناء غير مكتمل؟`);
cpSync(staticSrc, staticDst, { recursive: true });

const publicSrc = path.join(ROOT, "public");
if (existsSync(publicSrc)) {
  cpSync(publicSrc, path.join(STANDALONE, "public"), { recursive: true });
}

// 2) مُشغّل الإنتاج (env-file loader + chdir إلى جذر الإصدار)
cpSync(path.join(ROOT, "scripts", "prod-server.mjs"), path.join(STANDALONE, "prod-server.mjs"));

// 3) تطهير إلزامي — لا بيانات/تهيئة داخل الإصدار (قرار 5A المثبت — 5B.1 يضيف التحقق)
const FORBIDDEN = ["db", "var", "tool-results", "test"];
for (const name of FORBIDDEN) {
  rmSync(path.join(STANDALONE, name), { recursive: true, force: true });
}
for (const name of readdirSync(STANDALONE)) {
  if (/^\.env/.test(name)) {
    rmSync(path.join(STANDALONE, name), { force: true });
  }
}
// تحقق نهائي حتمي: أي بقايا ⇒ فشل البناء (لا إصدار ملوث)
const leftovers = [];
for (const name of FORBIDDEN) {
  if (existsSync(path.join(STANDALONE, name))) leftovers.push(name);
}
for (const name of readdirSync(STANDALONE)) {
  if (/^\.env/.test(name)) leftovers.push(name);
}
if (leftovers.length > 0) fail(`بقايا ممنوعة داخل الـrelease: ${leftovers.join(", ")}`);

// 4) RELEASE_META.json — أساس فحص توافق الـrollback (نص المستخدم §19)
function gitShortSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
function gitFullSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
function expectedSchemaFingerprint() {
  // قراءة الثابت المثبت من مصدر الحقيقة (backup-config.ts) — regex موثق ومختبر
  // بمقارنته مع الاستيراد الفعلي في scripts/phase5b1-windows-compat.ts
  try {
    const src = readFileSync(path.join(ROOT, "src", "lib", "backup-config.ts"), "utf8");
    const m = src.match(/PINNED_CURRENT_CANONICAL_FINGERPRINT[^=]*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
function migrationsList() {
  const dir = path.join(ROOT, "prisma", "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory();
    })
    .sort();
}

const meta = {
  releaseId: process.env.RELEASE_ID || gitShortSha(),
  gitSha: gitFullSha(),
  builtAt: new Date().toISOString(),
  runtime: "node (standalone) — bun build-time only",
  expectedSchemaFingerprint: expectedSchemaFingerprint(),
  migrations: migrationsList(),
  rollbackCompatDeclaration: {
    policy: "rollback blocked if live fingerprint != expectedSchemaFingerprint of target release, or if live applied migrations include names absent from target release migrations list",
    dataRollback: "NEVER automatic — governed restore engine path only",
  },
};
writeFileSync(path.join(STANDALONE, "RELEASE_META.json"), JSON.stringify(meta, null, 2) + "\n");
writeFileSync(path.join(STANDALONE, "RELEASE_ID"), meta.releaseId + "\n");

const sizeBytes = (() => {
  let total = 0;
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  walk(STANDALONE);
  return total;
})();

console.log(
  `[assemble-release] OK — release=${meta.releaseId} sha=${meta.gitSha.slice(0, 12)} migrations=${meta.migrations.length} fingerprint=${meta.expectedSchemaFingerprint ? meta.expectedSchemaFingerprint.slice(0, 18) + "…" : "unpinned"} size=${(sizeBytes / 1024 / 1024).toFixed(1)}MB`
);
console.log(`[assemble-release] artifact: ${path.relative(ROOT, STANDALONE)} (مُطهّر: بلا db/var/.env/tool-results/test)`);
void fileURLToPath;
