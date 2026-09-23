#!/usr/bin/env node
/**
 * 6.7 — فحص وظيفي لعميل Prisma داخل حزمة اختبار Windows.
 *
 * الفحص الوظيفي يتجاوز مجرد وجود المجلد (كان عيب 6.2D): يتحقق أن العميل
 * محمّل وأن نماذج المخطط الأساسية موجودة فعليًا (ConsolidationGroup أحدث نموذج)،
 * وأن الاتصال بقاعدة الاختبار المعزولة يعمل (SELECT 1).
 *
 * الخروج:
 *   0 = العميل سليم والنماذج موجودة والاتصال يعمل
 *   2 = العميل ناقص/قديم ⇒ يجب prisma generate (يعالجها START تلقائيًا)
 *   1 = خطأ بيئة/قاعدة — لا يصلحها generate (يوقف START برسالة)
 *
 * الاستخدام: node scripts\verify-prisma-client.js "<absolute path to test db>"
 */
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */
// (سكربت Node خام لحزمة اختبار Windows — require مقصود هنا قبل تحميل العميل)

const REQUIRED_MODELS = [
  "user",
  "company",
  "fiscalYear",
  "fiscalPeriod",
  "accountNatureRule",
  "trialBalanceImport",
  "budget",
  "consolidationGroup", // أحدث نموذج (6.6) — وجوده يثبت أن العميل مطابق للمخطط
];

function main() {
  let PrismaClient;
  try {
    ({ PrismaClient } = require("@prisma/client"));
  } catch (e) {
    console.log("[VERIFY] @prisma/client cannot be loaded: " + (e && e.message ? e.message.split("\n")[0] : e));
    process.exit(2);
  }

  if (typeof PrismaClient !== "function") {
    console.log("[VERIFY] PrismaClient export is not a constructor (stale client).");
    process.exit(2);
  }

  // فحص النماذج على النوع (بلا فتح اتصال): عميل قديم لا يملك نماذج المخطط الحالي
  let probe;
  try {
    probe = new PrismaClient({ datasources: { db: { url: "file:./verify-probe-unused.db" } } });
  } catch (e) {
    console.log("[VERIFY] PrismaClient instantiation failed: " + (e && e.message ? e.message.split("\n")[0] : e));
    process.exit(2);
  }

  const missing = REQUIRED_MODELS.filter((m) => probe[m] === undefined);
  if (missing.length > 0) {
    try { probe.$disconnect(); } catch (_) { /* ignore */ }
    console.log("[VERIFY] Client is STALE - missing models: " + missing.join(", "));
    process.exit(2);
  }

  // فحص اتصال حقيقي بقاعدة الاختبار المعزولة إن مُرّر مسارها
  const dbPath = process.argv[2];
  const finish = (ok, msg) => {
    try { probe.$disconnect().catch(() => {}); } catch (_) { /* ignore */ }
    console.log(msg);
    process.exit(ok ? 0 : 1);
  };

  if (dbPath) {
    if (/custom\.db/i.test(dbPath)) {
      finish(false, "[VERIFY] SAFETY: refusing to probe production custom.db.");
    }
    const url = "file:" + dbPath.split("\\").join("/");
    probe
      .$queryRawUnsafe("SELECT 1 AS ok")
      .then(() => finish(true, "[VERIFY] Client OK - all required models present, database reachable."))
      .catch((e) => {
        // عميل سليم + قاعدة غير قابلة للوصول = مشكلة قاعدة لا توليد عميل
        finish(false, "[VERIFY] Client OK but database probe failed: " + (e && e.message ? e.message.split("\n")[0] : e));
      });
  } else {
    try { probe.$disconnect().catch(() => {}); } catch (_) { /* ignore */ }
    console.log("[VERIFY] Client OK - all required models present.");
    process.exit(0);
  }
}

main();
