// Phase 6.3 — بوابة إثبات حوكمة مراجعات ميزان المراجعة (Revision Governance).
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-63-gate.db bun scripts/phase63-trial-balance-revision.ts
//
// الفحوصات (تعليمات 6.3-K) على قاعدة معزولة من migrations حصرًا:
//   1 المعتمد لا يُعدّل في مكانه (لا رفع بديل/اعتماد ثانٍ/حذف/إعادة تحقق)
//   2 سبب المراجعة إلزامي
//   3 revisionNumber يزيد ترتيبيًا (1→2→3)
//   4 النسخة المعتمدة السابقة تبقى سليمة كاملة
//   5 المراجعة المعتمدة الجديدة تصبح افتراضي التقارير (القيم + provenance)
//   6 النسخ التاريخية تبقى قابلة للتتبع (السلسلة + القائمة)
//   7 سنة LOCKED تمنع المراجعة العادية + سنة CLOSED: الإنشاء مسموح والاعتماد يبقى محكومًا بـ6.1
//   8 عزل الشركات (fail-closed)
//   9 أحداث التدقيق REVISION_CREATED/REVISION_COMMITTED ببيانات كاملة
//  10 optimistic locking عند الاعتماد والاستبدال
//
// لا لمس custom.db إطلاقًا — الأداة ترفض أي DATABASE_URL غير dev-63*.

import { PrismaClient } from "@prisma/client";

import { TrialBalanceError, type RawTrialBalanceLine } from "../src/lib/trial-balance";
import type { SessionUser } from "../src/lib/session";

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      passCount += 1;
      console.log(`  PASS  ${name}`);
    } catch (e) {
      failCount += 1;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${name} :: ${msg}`);
      console.log(`  FAIL  ${name} :: ${msg}`);
    }
  })();
}

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function errorCode(e: unknown): string {
  return e instanceof TrialBalanceError ? e.code : `UNKNOWN(${e instanceof Error ? e.message : String(e)})`;
}

async function expectErrorAsync(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(errorCode(e) === code, `المتوقع ${code} وجاء ${errorCode(e)}`);
    return;
  }
  throw new Error(`كان يجب أن يرمي ${code}`);
}

function syntheticUser(over: Partial<{ role: string; companyIds: string[]; viewAllCompanies: boolean; username: string }> = {}): SessionUser {
  return {
    id: "gate-user-63",
    username: over.username ?? "gate-admin",
    name: "Gate Admin",
    role: over.role ?? "admin",
    permissions: {
      view: true, add: true, edit: true, delete: true, groups: false, export: true, settings: false,
      manageUsers: false, companyIds: over.companyIds ?? [], viewAllCompanies: over.viewAllCompanies ?? true,
      manageAccountNature: true, manageTrialBalances: true,
    },
  };
}

const line = (code: string, debit: number | string, credit: number | string, name = ""): RawTrialBalanceLine =>
  ({ accountCode: code, accountName: name, debit, credit });

async function main() {
  console.log("═══ بوابة Phase 6.3 — حوكمة مراجعات ميزان المراجعة ══");
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-63"), "الأداة تعمل على dev-63-gate.db حصرًا");
  const db = new PrismaClient({ datasources: { db: { url: url! } } });

  try {
    const admin = syntheticUser();
    const limited = syntheticUser({ role: "user", viewAllCompanies: false, companyIds: [], username: "gate-limited" });
    let coA = ""; let coB = ""; let fyA = ""; let fyB = "";
    let rev1Id = ""; let rev2Id = ""; let rev3Id = "";

    await check("G0 تهيئة: شركتان + سنتان (تقويمية للاختبار وغير تقويمية للإقفال) + بادئات", async () => {
      const a = await db.company.create({ data: { code: "RG-A", nameAr: "شركة المراجعات أ" } });
      const b = await db.company.create({ data: { code: "RG-B", nameAr: "شركة المراجعات ب" } });
      coA = a.id; coB = b.id;
      const fyCal = await db.fiscalYear.create({ data: { companyId: coA, code: "FY2026", startDate: "2026-01-01", endDate: "2026-12-31", periodCount: 12 } });
      const months = ["01","02","03","04","05","06","07","08","09","10","11","12"];
      for (let i = 0; i < 12; i++) {
        const last = new Date(Date.UTC(2026, i + 1, 0)).getUTCDate();
        await db.fiscalPeriod.create({ data: { fiscalYearId: fyCal.id, ordinal: i + 1, code: `2026-${months[i]}`, startDate: `2026-${months[i]}-01`, endDate: `2026-${months[i]}-${last}`, displayLabel: `شهر ${i + 1}` } });
      }
      fyA = fyCal.id;
      const fyJul = await db.fiscalYear.create({ data: { companyId: coB, code: "FY27/28", startDate: "2027-07-01", endDate: "2028-06-30", periodCount: 12 } });
      for (let i = 0; i < 12; i++) {
        const m = i < 6 ? 7 + i : 1 + (i - 6);
        const y = i < 6 ? 2027 : 2028;
        const mm = String(m).padStart(2, "0");
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        await db.fiscalPeriod.create({ data: { fiscalYearId: fyJul.id, ordinal: i + 1, code: `${y}-${mm}`, startDate: `${y}-${mm}-01`, endDate: `${y}-${mm}-${last}`, displayLabel: `فترة ${i + 1}` } });
      }
      fyB = fyJul.id;
      const cashLine = await db.financialStatementLine.findUniqueOrThrow({ where: { code: "SFP-CASH" } });
      const salesLine = await db.financialStatementLine.findUniqueOrThrow({ where: { code: "PNL-REVENUE" } });
      await db.accountNatureRule.create({ data: { companyId: coA, prefix: "1101", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineId: cashLine.id, source: "MANUAL" } });
      await db.accountNatureRule.create({ data: { companyId: coA, prefix: "4101", classification: "REVENUE", aggregationBehavior: "FLOW", statementLineId: salesLine.id, source: "MANUAL" } });
      await db.accountNatureRule.create({ data: { companyId: coB, prefix: "1101", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineId: cashLine.id, source: "MANUAL" } });
      await db.accountNatureRule.create({ data: { companyId: coB, prefix: "4101", classification: "REVENUE", aggregationBehavior: "FLOW", statementLineId: salesLine.id, source: "MANUAL" } });
      expect(!!fyA && !!fyB, "سنتان جاهزتان");
    });

    const rev1Lines = [line("1101", 500, 0, "النقدية"), line("4101", 0, 500, "مبيعات")];

    await check("G1 أساس السلسلة: استيراد + اعتماد ⇒ revisionNumber=1 (المراجعة الأولى)", async () => {
      const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const created = await createTrialBalance({
        user: admin, ip: "127.0.0.1",
        input: { companyId: coA, fiscalYearId: fyA, fromDate: "2026-01-01", toDate: "2026-03-31", dataType: "CUMULATIVE_YTD", reason: "إثبات أساس السلسلة", lines: rev1Lines },
      });
      expect(created.import.revisionNumber === 1 && created.import.supersedesImportId === null, "الاستيراد الأول = مراجعة 1 بلا سابقة");
      const committed = await commitTrialBalance({ user: admin, ip: null, id: created.import.id, input: { version: 1, reason: "اعتماد أول" } });
      rev1Id = committed.id;
      expect(committed.status === "COMMITTED" && committed.revisionNumber === 1, "معتمد #1");
    });

    await check("K1 المعتمد لا يُعدّل في مكانه: رفع بديل مرفوض + اعتماد ثانٍ + حذف + إعادة تحقق", async () => {
      const { createTrialBalance, commitTrialBalance, deleteTrialBalance, revalidateTrialBalance } = await import("../src/lib/trial-balance-server");
      await expectErrorAsync("DUPLICATE_COMMITTED", () =>
        createTrialBalance({ user: admin, ip: null, input: { companyId: coA, fiscalYearId: fyA, fromDate: "2026-01-01", toDate: "2026-03-31", dataType: "CUMULATIVE_YTD", lines: rev1Lines } }));
      await expectErrorAsync("NOT_FOUND", () => commitTrialBalance({ user: admin, ip: null, id: rev1Id, input: { version: 1 } }));
      await expectErrorAsync("NOT_FOUND", () => deleteTrialBalance({ user: admin, ip: null, id: rev1Id, input: { version: 1 } }));
      await expectErrorAsync("NOT_FOUND", () => revalidateTrialBalance({ user: admin, ip: null, id: rev1Id, input: { version: 1 } }));
    });

    await check("K2 سبب المراجعة إلزامي + لا مراجعة من مسودة", async () => {
      const { createTrialBalanceRevision, createTrialBalance } = await import("../src/lib/trial-balance-server");
      await expectErrorAsync("REASON_REQUIRED", () => createTrialBalanceRevision({ user: admin, ip: null, id: rev1Id, input: { reason: "   " } }));
      // المراجعة من مسودة (غير معتمدة) مرفوضة — المراجعة من المعتمد حصرًا
      const strayDraft = await createTrialBalance({ user: admin, ip: null, input: { companyId: coA, fiscalYearId: fyA, fromDate: "2026-07-01", toDate: "2026-07-31", dataType: "PERIOD_MOVEMENT", reason: "مسودة عرضية للاختبار", lines: [line("1101", 10, 0), line("4101", 0, 10)] } });
      await expectErrorAsync("INVALID_STATE", () => createTrialBalanceRevision({ user: admin, ip: null, id: strayDraft.import.id, input: { reason: "محاولة مراجعة من مسودة" } }));
      await db.trialBalanceImport.delete({ where: { id: strayDraft.import.id } });
    });

    await check("K3 مسار المراجعة الكامل: إنشاء #2 ⇒ استبدال سطور مصححة ⇒ اعتماد", async () => {
      const { createTrialBalanceRevision, createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const draft = (await createTrialBalanceRevision({ user: admin, ip: "127.0.0.1", id: rev1Id, input: { reason: "تصحيح مبلغ المبيعات بعد كشف خطأ إدخال" } })) as { id: string; revisionNumber: number; supersedesImportId: string | null; status: string };
      expect(draft.revisionNumber === 2 && draft.supersedesImportId === rev1Id && draft.status === "DRAFT", "مسودة #2 تشير للمعتمد #1");
      // السطور مبذورة من المعتمد (نقطة بداية)
      const seeded = await db.trialBalanceLine.findMany({ where: { importId: draft.id } });
      expect(seeded.length === 2, "بذر سطور المصدر (سطران)");
      // استبدال السطور بمحتوى مصحح (نفس المدى/النوع إجباريًا)
      const replaced = await createTrialBalance({
        user: admin, ip: null,
        input: {
          revisionTargetId: draft.id, version: 1,
          fromDate: "2026-01-01", toDate: "2026-03-31", dataType: "CUMULATIVE_YTD",
          originalFileName: "tb-q1-corrected.xlsx", reason: "رفع الملف المصحح",
          lines: [line("1101", 700, 0, "النقدية"), line("4101", 0, 700, "مبيعات")],
        },
      });
      expect((replaced as { import: { status: string; lineCount: number } }).import.status === "DRAFT", "المسودة بعد الاستبدال DRAFT");
      // حمايات الاستبدال: مدى مختلف + نوع مختلف مرفوضان
      await expectErrorAsync("INVALID_DATE_RANGE", () =>
        createTrialBalance({ user: admin, ip: null, input: { revisionTargetId: draft.id, version: 2, fromDate: "2026-01-01", toDate: "2026-06-30", dataType: "CUMULATIVE_YTD", lines: rev1Lines } }));
      await expectErrorAsync("INVALID_DATA_TYPE", () =>
        createTrialBalance({ user: admin, ip: null, input: { revisionTargetId: draft.id, version: 2, fromDate: "2026-01-01", toDate: "2026-03-31", dataType: "PERIOD_MOVEMENT", lines: rev1Lines } }));
      const committed2 = await commitTrialBalance({ user: admin, ip: null, id: draft.id, input: { version: 2, reason: "اعتماد المراجعة المصححة" } });
      rev2Id = committed2.id;
      expect(committed2.status === "COMMITTED" && committed2.revisionNumber === 2, "معتمد #2");
      const rev2Total = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: rev2Id }, select: { totalCreditMinor: true, totalDebitMinor: true } });
      expect(rev2Total.totalCreditMinor === BigInt(70000) && rev2Total.totalDebitMinor === BigInt(70000), "قيم المراجعة المصححة (700 متوازنة)");
    });

    await check("K4 النسخة السابقة سليمة: #1 كاملة (حالة/إجماليات/سطور/بصمة) بعد اعتماد #2", async () => {
      const prev = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: rev1Id }, select: { status: true, totalCreditMinor: true, lineCount: true, payloadHash: true, revisionNumber: true, committedAt: true } });
      expect(prev.status === "COMMITTED" && prev.revisionNumber === 1 && prev.totalCreditMinor === BigInt(50000) && prev.lineCount === 2, "#1 لم تُلمس");
      const prevLines = await db.trialBalanceLine.findMany({ where: { importId: rev1Id } });
      expect(prevLines.length === 2 && prevLines.every((l) => l.netMinor !== BigInt(0)), "سطور #1 كما هي");
      const rev2 = await db.trialBalanceImport.findUniqueOrThrow({ where: { id: rev2Id }, select: { payloadHash: true, supersedesImportId: true } });
      expect(rev2.payloadHash !== prev.payloadHash, "بصمة المحتوى تغيرت فعلاً (تصحيح حقيقي)");
    });

    await check("K5+K6 الافتراضي للتقارير = أحدث معتمد + التاريخ قابل للتتبع (provenance + قيم)", async () => {
      const { loadCommittedAccountPoints, loadReportingProvenance } = await import("../src/lib/reporting-server");
      const points = await loadCommittedAccountPoints(coA, fyA);
      const sales = points.get("4101")!;
      expect(sales.points.length === 1 && sales.points[0]!.netMinor === BigInt(-70000), "قيمة التقارير من المراجعة #2 حصرًا (-700 دائن، لا 500 ولا الاثنان)");
      const prov = await loadReportingProvenance(coA, fyA);
      expect(prov.basis === "LATEST_COMMITTED_REVISION" && prov.imports.length === 1, "provenance بمدخل واحد (الأحدث)");
      const entry = prov.imports[0]!;
      expect(entry.importId === rev2Id && entry.revisionNumber === 2 && !!entry.committedAt && entry.supersedesImportId === rev1Id, `المصدر = #2 (id/رقم/زمن اعتماد/مرجع السابقة)`);
      // التتبع التاريخي: #1 ما زالت معتمدة وقابلة للقراءة عبر القائمة
      const { listTrialBalances } = await import("../src/lib/trial-balance-server");
      const list = await listTrialBalances(admin, coA);
      const ids = list.map((x) => x.id);
      expect(ids.includes(rev1Id) && ids.includes(rev2Id), "النسختان ظاهرتان في القائمة (التاريخ محفوظ)");
      // سلسلة سليمة: إنشاء #3 من #2 (وليس من #1 الماريخة)
      const { createTrialBalanceRevision } = await import("../src/lib/trial-balance-server");
      await expectErrorAsync("REVISION_SOURCE_NOT_LATEST", () => createTrialBalanceRevision({ user: admin, ip: null, id: rev1Id, input: { reason: "محاولة تفريخ من تاريخ" } }));
      const draft3 = (await createTrialBalanceRevision({ user: admin, ip: null, id: rev2Id, input: { reason: "مراجعة ثانية لتصحيح ترحيل" } })) as { id: string; revisionNumber: number };
      expect(draft3.revisionNumber === 3, "الترقيم الترتيبي 1→2→3 بلا فجوات");
      const { commitTrialBalance } = await import("../src/lib/trial-balance-server");
      await commitTrialBalance({ user: admin, ip: null, id: draft3.id, input: { version: 1, reason: "اعتماد #3" } });
      rev3Id = draft3.id;
      const prov3 = await loadReportingProvenance(coA, fyA);
      expect(prov3.imports[0]!.importId === rev3Id && prov3.imports[0]!.revisionNumber === 3, "بعد #3: الافتراضي انتقل للمراجعة #3");
    });

    await check("K7-a سنة LOCKED تمنع المراجعة العادية فورًا", async () => {
      const { createTrialBalanceRevision } = await import("../src/lib/trial-balance-server");
      await db.fiscalYear.update({ where: { id: fyA }, data: { status: "LOCKED" } });
      await expectErrorAsync("FISCAL_LIFECYCLE", () => createTrialBalanceRevision({ user: admin, ip: null, id: rev3Id, input: { reason: "محاولة مراجعة سنة مقفلة" } }));
      await db.fiscalYear.update({ where: { id: fyA }, data: { status: "OPEN" } });
    });

    await check("K7-b سنة CLOSED: إنشاء المراجعة مسموح والاعتماد يبقى محكومًا بضوابط 6.1", async () => {
      const { createTrialBalance, commitTrialBalance, createTrialBalanceRevision } = await import("../src/lib/trial-balance-server");
      const created = await createTrialBalance({
        user: admin, ip: null,
        input: { companyId: coB, fiscalYearId: fyB, fromDate: "2027-07-01", toDate: "2027-09-30", dataType: "CUMULATIVE_YTD", reason: "أساس سنة غير تقويمية", lines: [line("1101", 90, 0, "نقدية ب"), line("4101", 0, 90, "مبيعات ب")] },
      });
      await commitTrialBalance({ user: admin, ip: null, id: created.import.id, input: { version: 1, reason: "اعتماد ب" } });
      await db.fiscalYear.update({ where: { id: fyB }, data: { status: "CLOSED" } });
      const draft = (await createTrialBalanceRevision({ user: admin, ip: null, id: created.import.id, input: { reason: "مراجعة على سنة مغلقة — الاعتماد سيرفضه حارس 6.1" } })) as { id: string; revisionNumber: number };
      expect(draft.revisionNumber === 2, "الإنشاء على CLOSED مسموح (سياسة الإقفال القائمة هي الحاكمة لاحقًا)");
      await expectErrorAsync("FISCAL_LIFECYCLE", () => commitTrialBalance({ user: admin, ip: null, id: draft.id, input: { version: 1, reason: "محاولة اعتماد على سنة مغلقة" } }));
      await db.fiscalYear.update({ where: { id: fyB }, data: { status: "OPEN" } });
      await db.trialBalanceImport.delete({ where: { id: draft.id } }); // تنظيف المسودة (مسموح للمسودات فقط)
    });

    await check("K8 عزل الشركات: مستخدم بلا نطاق لا يرى ولا يُراجع شركة أخرى (fail-closed)", async () => {
      const { createTrialBalanceRevision } = await import("../src/lib/trial-balance-server");
      await expectErrorAsync("NOT_FOUND", () => createTrialBalanceRevision({ user: limited, ip: null, id: rev3Id, input: { reason: "محاولة عابرة للشركات" } }));
      const { replaceRevisionDraftLines } = await import("../src/lib/trial-balance-server");
      await expectErrorAsync("NOT_FOUND", () => replaceRevisionDraftLines({ user: limited, ip: null, id: rev3Id, input: { version: 1 } }));
    });

    await check("K9 أحداث التدقيق: REVISION_CREATED + REVISION_COMMITTED ببيانات كاملة (شركة/سنة/مدى/رقم قديم/جديد/سبب/مستخدم)", async () => {
      const created = await db.auditLog.findFirst({
        where: { action: "TRIAL_BALANCE_REVISION_CREATED", entityId: rev2Id },
        orderBy: { createdAt: "desc" },
      });
      expect(!!created, "حدث إنشاء المراجعة مسجل");
      const cMeta = JSON.parse(created!.metadata || "{}") as Record<string, unknown>;
      expect(cMeta.companyId === coA && cMeta.fiscalYearCode === "FY2026" && cMeta.oldRevisionNumber === 1 && cMeta.newRevisionNumber === 2 && !!cMeta.reason && created!.username === "gate-admin", `metadata الإنشاء كاملة`);
      expect(created!.beforeData && JSON.parse(created!.beforeData).importId === rev1Id && JSON.parse(created!.afterData).importId === rev2Id, "before/after يحفظان طرفي السلسلة");
      const committed = await db.auditLog.findFirst({
        where: { action: "TRIAL_BALANCE_REVISION_COMMITTED", entityId: rev2Id },
        orderBy: { createdAt: "desc" },
      });
      expect(!!committed, "حدث اعتماد المراجعة مسجل");
      const mMeta = JSON.parse(committed!.metadata || "{}") as Record<string, unknown>;
      expect(mMeta.sourceImportId === rev1Id && mMeta.oldRevisionNumber === 1 && mMeta.newRevisionNumber === 2 && committed!.username === "gate-admin", "metadata الاعتماد كاملة (المصدر/القديم/الجديد/المستخدم)");
      const committed3 = await db.auditLog.findFirst({ where: { action: "TRIAL_BALANCE_REVISION_COMMITTED", entityId: rev3Id }, orderBy: { createdAt: "desc" } });
      expect(!!committed3, "حدث اعتماد #3 مسجل أيضًا");
    });

    await check("K10 optimistic locking: اعتماد بنسخة قديمة + استبدال بنسخة قديمة ⇒ VERSION_CONFLICT", async () => {
      const { createTrialBalanceRevision, commitTrialBalance, createTrialBalance } = await import("../src/lib/trial-balance-server");
      const draft = (await createTrialBalanceRevision({ user: admin, ip: null, id: rev3Id, input: { reason: "مراجعة #4 لاختبار التعارض" } })) as { id: string; revisionNumber: number };
      expect(draft.revisionNumber === 4, "مسودة #4");
      await expectErrorAsync("VERSION_CONFLICT", () => commitTrialBalance({ user: admin, ip: null, id: draft.id, input: { version: 99, reason: "نسخة قديمة" } }));
      await expectErrorAsync("VERSION_CONFLICT", () =>
        createTrialBalance({ user: admin, ip: null, input: { revisionTargetId: draft.id, version: 99, fromDate: "2026-01-01", toDate: "2026-03-31", dataType: "CUMULATIVE_YTD", lines: rev1Lines } }));
      await db.trialBalanceImport.delete({ where: { id: draft.id } }); // تنظيف مسودة الاختبار
      // لا مسودات متروكة — السلسلة تنتهي بـ#3 المعتمدة
      const drafts = await db.trialBalanceImport.count({ where: { companyId: coA, status: { not: "COMMITTED" } } });
      expect(drafts === 0, "لا مسودات متبقية لشركة أ");
    });

    await check("G-tail عزل نطاق المدى: مراجعة المدى Q1 لا تمس مدى Q2 المستقل", async () => {
      const { createTrialBalance, commitTrialBalance, createTrialBalanceRevision } = await import("../src/lib/trial-balance-server");
      const { loadReportingProvenance } = await import("../src/lib/reporting-server");
      const q2 = await createTrialBalance({
        user: admin, ip: null,
        input: { companyId: coA, fiscalYearId: fyA, fromDate: "2026-04-01", toDate: "2026-06-30", dataType: "CUMULATIVE_YTD", reason: "مدى مستقل Q2", lines: [line("1101", 800, 0, "نقدية"), line("4101", 0, 800, "مبيعات")] },
      });
      await commitTrialBalance({ user: admin, ip: null, id: q2.import.id, input: { version: 1 } });
      const prov = await loadReportingProvenance(coA, fyA);
      expect(prov.imports.length === 2, "مدخلان مستقلان (Q1 بمراجعته #3 + Q2 #1)");
      const q1 = prov.imports.find((x) => x.fromDate === "2026-01-01")!;
      const q2e = prov.imports.find((x) => x.fromDate === "2026-04-01")!;
      expect(q1.importId === rev3Id && q1.revisionNumber === 3 && q2e.importId === q2.import.id && q2e.revisionNumber === 1, "كل مدى يُثبت مصدره المستقل");
      void createTrialBalanceRevision;
    });
  } finally {
    await db.$disconnect();
  }

  console.log(`\n═══ النتيجة: PASS ${passCount} / FAIL ${failCount} ═══`);
  if (failCount > 0) {
    console.log("الفحوصات الفاشلة:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
