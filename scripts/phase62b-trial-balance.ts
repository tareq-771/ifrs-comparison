// Phase 6.2B — بوابة إثبات ميزان المراجعة المحفوظ (Trial Balance Foundation).
// تشغيل: DATABASE_URL=file:/home/z/my-project/db/dev-62b-gate.db bun scripts/phase62b-trial-balance.ts
//
// الاختبارات A-P (تعليمات 6.2B-16) على قاعدة معزولة من migrations حصرًا:
//   A متوازن يُحفظ ويُعتمد | B غير متوازن لا يُعتمد | C عزل الشركات
//   D سنة غير تقويمية | E مدى تواريخ غير صالح | F CUMULATIVE_YTD صريح
//   G PERIOD_MOVEMENT صريح | H منع التكرار/الاستبدال المحوكوم | I حالات الحل snapshot
//   J حساب مجهول يبقى غير مصنف | K دقة BigInt | L optimistic locking
//   M Audit Trail | N حراس CLOSED/LOCKED | O نفس الكود بشركتين | P تحذير hash التكرار
//
// لا لمس custom.db إطلاقًا — الأداة ترفض أي DATABASE_URL غير dev-62b*.

import { PrismaClient } from "@prisma/client";

import {
  decimalToMinor,
  normalizeTrialBalanceLines,
  minorToDecimalString,
  resolveFiscalContext,
  TrialBalanceError,
  type RawTrialBalanceLine,
} from "../src/lib/trial-balance";
import { canManageTrialBalances } from "../src/lib/permissions";
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

function expectError(code: string, fn: () => unknown): void {
  try { fn(); } catch (e) {
    expect(errorCode(e) === code, `المتوقع ${code} وجاء ${errorCode(e)}`);
    return;
  }
  throw new Error(`كان يجب أن يرمي ${code}`);
}

async function expectErrorAsync(code: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (e) {
    expect(errorCode(e) === code, `المتوقع ${code} وجاء ${errorCode(e)}`);
    return;
  }
  throw new Error(`كان يجب أن يرمي ${code}`);
}

function syntheticUser(over: Partial<{ role: string; companyIds: string[]; viewAllCompanies: boolean; username: string }> = {}): SessionUser {
  return {
    id: "gate-user",
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

/* ── الجزء النقي ── */

async function partPure() {
  console.log("\n── الجزء النقي (بلا DB) ──");

  const fy = { id: "fy1", code: "FY27", displayNameAr: "2027/2028", startDate: "2027-07-01", endDate: "2028-06-30", status: "OPEN" };
  const mkPeriods = (n: number, y: number, m0: number) =>
    Array.from({ length: n }, (_, i) => {
      const m = m0 + i;
      const mm = String(m).padStart(2, "0");
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { id: `p${i + 1}`, ordinal: i + 1, startDate: `${y}-${mm}-01`, endDate: `${y}-${mm}-${last}`, status: "OPEN", displayLabel: `فترة ${i + 1}` };
    });
  const julPeriods = [...mkPeriods(6, 2027, 7).map((p, i) => ({ ...p, ordinal: i + 1 })), ...mkPeriods(6, 2028, 1).map((p, i) => ({ ...p, ordinal: i + 7 }))]; // يوليو→ديسمبر ثم يناير→يونيو (ordinals 1..12)

  await check("D  سنة غير تقويمية: 2027-07-01→2027-09-30 ⇒ startOrdinal=1 endOrdinal=3", () => {
    const ctx = resolveFiscalContext(fy, julPeriods, "2027-07-01", "2027-09-30");
    expect(ctx.startPeriod.ordinal === 1 && ctx.endPeriod.ordinal === 3, `start=${ctx.startPeriod.ordinal} end=${ctx.endPeriod.ordinal}`);
    expect(ctx.coveredPeriods.length === 3, "ثلاث فترات مغطاة (يوليو/أغسطس/سبتمبر)");
  });

  await check("E  مدى غير صالح: From>To + خارج السنة + يعبر سنتين + بلا محاذاة فترات", () => {
    expectError("INVALID_DATE_RANGE", () => resolveFiscalContext(fy, julPeriods, "2027-09-30", "2027-07-01"));
    expectError("DATE_OUTSIDE_FISCAL_YEAR", () => resolveFiscalContext(fy, julPeriods, "2026-07-01", "2026-09-30"));
    expectError("DATE_OUTSIDE_FISCAL_YEAR", () => resolveFiscalContext(fy, julPeriods, "2027-12-01", "2028-07-31"));
    expectError("DATE_NOT_PERIOD_ALIGNED", () => resolveFiscalContext(fy, julPeriods, "2027-07-15", "2027-09-30"));
  });

  await check("K  دقة BigInt: 1234567890123456.78 ⇒ exact minor + رفض أدق من الخانتين", () => {
    expect(decimalToMinor("1234567890123456.78", 2) === BigInt("123456789012345678"), "تحويل exact من نص");
    expect(decimalToMinor(1234567.89, 2) === BigInt("123456789"), "تحويل من رقم عبر round-trip string");
    expect(decimalToMinor("١٢٣٤.٥", 2) === BigInt("123450"), "أرقام عربية + خانة واحدة تُكمل بأصفار");
    expect(minorToDecimalString(BigInt("-123456789012345678"), 2) === "-1234567890123456.78", "عرض عكسي exact");
    expectError("INVALID_LINE", () => decimalToMinor("100.555", 2));
    expectError("INVALID_LINE", () => decimalToMinor("abc", 2));
  });

  await check("A-prefix التحقق النقي: صف بلا كود/مكرر/فارغ 0-0 ⇒ رفض بترقيم الصفوف", () => {
    expectError("INVALID_LINE", () => normalizeTrialBalanceLines([line("1101", 100, 0), line("", 50, 0)], 2));
    expectError("DUPLICATE_ACCOUNT", () => normalizeTrialBalanceLines([line("1101", 100, 0), line("1101", 50, 0)], 2));
    expectError("INVALID_LINE", () => normalizeTrialBalanceLines([line("1101", 0, 0)], 2));
    expectError("EMPTY_FILE", () => normalizeTrialBalanceLines([], 2));
    const ok = normalizeTrialBalanceLines([line("1101", "1,000.50", 0), line("4101", 0, "1,000.50")], 2);
    expect(ok.balanced && ok.totalDebitMinor === BigInt(100050) && ok.differenceMinor === BigInt(0), "متوازن بالفواصل والعشرية");
  });
}

/* ── الجزء الخادمي على dev-62b-gate.db ── */

async function partDB() {
  console.log("\n── الجزء الخادمي: dev-62b-gate.db ──");
  const url = process.env.DATABASE_URL;
  expect(!!url && url.includes("dev-62b-gate"), "الأداة تعمل على dev-62b-gate.db حصرًا");
  const db = new PrismaClient({ datasources: { db: { url: url! } } });

  try {
    const admin = syntheticUser();
    const limited = syntheticUser({ role: "user", viewAllCompanies: false, companyIds: [], username: "gate-limited" });
    let coA = ""; let coB = ""; let fyA = ""; let fyB = "";
    let committedId = ""; let draftId = ""; let unbalancedId = "";

    await check("B0 تهيئة: شركتان + سنتان (تقويمية وغير تقويمية) + بادئات مستقلة", async () => {
      const a = await db.company.create({ data: { code: "TB-A", nameAr: "شركة أ" } });
      const b = await db.company.create({ data: { code: "TB-B", nameAr: "شركة ب" } });
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
      // بادئات مستقلة: A: 1101⇒كاش | B: 1101⇒ذمم (O)
      await db.accountNatureRule.create({ data: { companyId: coA, prefix: "1101", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineId: (await db.financialStatementLine.findUniqueOrThrow({ where: { code: "SFP-CASH" } })).id, source: "MANUAL" } });
      await db.accountNatureRule.create({ data: { companyId: coB, prefix: "1101", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineId: (await db.financialStatementLine.findUniqueOrThrow({ where: { code: "SFP-RECEIVABLES" } })).id, source: "MANUAL" } });
      await db.accountNatureRule.create({ data: { companyId: coA, prefix: "21", classification: "LIABILITY", aggregationBehavior: "BALANCE", source: "MANUAL" } });
      expect(!!fyA && !!fyB, "سنتان جاهزتان");
    });

    const balancedLinesA = [
      line("1101", 500, 0, "النقدية"),
      line("1102", 200, 0, "مدينون"),
      line("2101", 0, 300, "دائنون"),
      line("4101", 0, 400, "مبيعات"),
    ];

    await check("A+F+CUMULATIVE_YTD صريح: متوازن ⇒ DRAFT ثم COMMITTED (بعد revalidate)", async () => {
      const { createTrialBalance, commitTrialBalance, revalidateTrialBalance } = await import("../src/lib/trial-balance-server");
      const created = await createTrialBalance({
        user: admin, ip: "127.0.0.1",
        input: {
          companyId: coA, fiscalYearId: fyA, fromDate: "2026-01-01", toDate: "2026-03-31",
          dataType: "CUMULATIVE_YTD", originalFileName: "tb-q1.xlsx", fileHash: "hash-A1",
          reason: "إثبات الحفظ", lines: balancedLinesA,
        },
      });
      draftId = created.import.id;
      expect(created.import.status === "DRAFT" && created.import.startOrdinal === 1 && created.import.endOrdinal === 3, `حالة/مدى: ${created.import.status} ${created.import.startOrdinal}-${created.import.endOrdinal}`);
      expect(created.import.totalDebitMinor === "70000" && created.import.totalCreditMinor === "70000", "الإجماليات 700 (minor) متساوية");
      const snap = await db.trialBalanceLine.findMany({ where: { importId: draftId }, orderBy: { rowIndex: "asc" } });
      const cash = snap.find((l) => l.accountCode === "1101")!;
      expect(cash.mappingStatus === "FULLY_MAPPED" && cash.statementLineCode === "SFP-CASH" && cash.netMinor === BigInt(50000), "1101 snapshot كامل (A: كاش)");
      const d = snap.find((l) => l.accountCode === "2101")!;
      expect(d.mappingStatus === "ROOT_ONLY" && d.classification === "LIABILITY", "2101 ⇒ ROOT_ONLY (بادئة 21 بلا بند)");
      const committed = await commitTrialBalance({ user: admin, ip: null, id: draftId, input: { version: 1, reason: "إثبات الاعتماد" } });
      committedId = committed.id;
      expect(committed.status === "COMMITTED" && !!committed.committedAt, "معتمد بتاريخ اعتماد");
    });

    await check("B+G+PERIOD_MOVEMENT صريح: غير متوازن ⇒ UNBALANCED والاعتماد مرفوض", async () => {
      const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const created = await createTrialBalance({
        user: admin, ip: null,
        input: {
          companyId: coA, fiscalYearId: fyA, fromDate: "2026-04-01", toDate: "2026-04-30",
          dataType: "PERIOD_MOVEMENT", originalFileName: "tb-apr.xlsx", lines: [
            line("1101", 150, 0), line("4101", 0, 100), // فرق 50
          ],
        },
      });
      unbalancedId = created.import.id;
      expect(created.import.status === "UNBALANCED" && created.import.dataType === "PERIOD_MOVEMENT", "حالة UNBALANCED بنوع صريح");
      await expectErrorAsync("NOT_BALANCED", () => commitTrialBalance({ user: admin, ip: null, id: unbalancedId, input: { version: created.import.version } }));
    });

    await check("H منع التكرار: نفس المدى/النوع ⇒ 409؛ استبدال مسودة محوكوم؛ المعتمد لا يُستبدل", async () => {
      const { createTrialBalance } = await import("../src/lib/trial-balance-server");
      // مسودة على مدى حر ⇒ ثم نفس المدى بلا استبدال ⇒ DUPLICATE_IMPORT
      await createTrialBalance({ user: admin, ip: null, input: { companyId: coA, fiscalYearId: fyA, fromDate: "2026-09-01", toDate: "2026-09-30", dataType: "PERIOD_MOVEMENT", lines: [line("1101", 3, 0), line("4101", 0, 3)] } });
      await expectErrorAsync("DUPLICATE_IMPORT", () =>
        createTrialBalance({ user: admin, ip: null, input: { companyId: coA, fiscalYearId: fyA, fromDate: "2026-09-01", toDate: "2026-09-30", dataType: "PERIOD_MOVEMENT", lines: [line("1101", 3, 0), line("4101", 0, 3)] } })
      );
      // استبدال المسودة بعلم صريح ينجح
      await createTrialBalance({ user: admin, ip: null, input: { companyId: coA, fiscalYearId: fyA, fromDate: "2026-09-01", toDate: "2026-09-30", dataType: "PERIOD_MOVEMENT", lines: [line("1101", 4, 0), line("4101", 0, 4)], replaceExisting: true, reason: "استبدال مسودة حر" } });
      // المعتمد (مدى Q1 من اختبار A) لا يُستبدل حتى بعلم الاستبدال
      await expectErrorAsync("DUPLICATE_COMMITTED", () =>
        createTrialBalance({ user: admin, ip: null, input: { companyId: coA, fiscalYearId: fyA, fromDate: "2026-01-01", toDate: "2026-03-31", dataType: "CUMULATIVE_YTD", lines: balancedLinesA, replaceExisting: true } })
      );
      const savedAudits = await db.auditLog.findMany({ where: { action: "TRIAL_BALANCE_SAVED", entityType: "TrialBalanceImport" }, orderBy: { createdAt: "desc" }, take: 10 });
      expect(savedAudits.some((a) => JSON.parse(a.metadata || "{}").replaced === true), "الاستبدال موثق بالتدقيق");
    });

    await check("P تحذير hash المحتوى المكرر (غير مانع) عند نوع مختلف لنفس الشركة", async () => {
      const { createTrialBalance } = await import("../src/lib/trial-balance-server");
      const res = await createTrialBalance({
        user: admin, ip: null,
        input: { companyId: coA, fiscalYearId: fyA, fromDate: "2026-06-01", toDate: "2026-06-30", dataType: "PERIOD_MOVEMENT", lines: balancedLinesA },
      });
      expect(!!res.duplicatePayloadWarning && res.duplicatePayloadWarning.includes("نفس محتوى"), `تحذير التكرار: ${res.duplicatePayloadWarning?.slice(0, 40)}…`);
      draftId = res.import.id;
    });

    await check("C عزل الشركات: مستخدم بلا نطاق مرفوض + بيانات كل شركة مستقلة", async () => {
      const { createTrialBalance, listTrialBalances } = await import("../src/lib/trial-balance-server");
      await expectErrorAsync("NOT_FOUND", () =>
        createTrialBalance({ user: limited, ip: null, input: { companyId: coA, fiscalYearId: fyA, fromDate: "2026-07-01", toDate: "2026-07-31", dataType: "PERIOD_MOVEMENT", lines: [line("1101", 1, 0), line("4101", 0, 1)] } })
      );
      const all = await listTrialBalances(admin);
      expect(all.every((r) => r.companyId === coA), "قائمة admin محصورة بشركة النطاق");
      const limitedList = await listTrialBalances(limited);
      expect(limitedList.length === 0, "مستخدم بلا نطاق ⇒ قائمة فارغة (fail-closed)");
    });

    await check("O نفس الكود بشركتين يُحلّ differently في snapshot الاستيراد", async () => {
      const { createTrialBalance } = await import("../src/lib/trial-balance-server");
      const res = await createTrialBalance({
        user: admin, ip: null,
        input: { companyId: coB, fiscalYearId: fyB, fromDate: "2027-07-01", toDate: "2027-09-30", dataType: "CUMULATIVE_YTD", lines: [line("1101", 90, 0, "نقدية B"), line("4101", 0, 90, "مبيعات B")] },
      });
      const line1101 = await db.trialBalanceLine.findFirst({ where: { importId: res.import.id, accountCode: "1101" } });
      expect(line1101!.statementLineCode === "SFP-RECEIVABLES", `B: 1101 ⇒ ذمم (${line1101!.statementLineCode})`);
      const aLine = await db.trialBalanceLine.findFirst({ where: { importId: committedId, accountCode: "1101" } });
      expect(aLine!.statementLineCode === "SFP-CASH", "A: 1101 ⇒ كاش — نفس الكود بندين مختلفين");
    });

    await check("N حراس دورة الحياة: سنة CLOSED/فترة CLOSED ⇒ رفض الاعتماد", async () => {
      const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const res = await createTrialBalance({
        user: admin, ip: null,
        input: { companyId: coB, fiscalYearId: fyB, fromDate: "2027-10-01", toDate: "2027-10-31", dataType: "PERIOD_MOVEMENT", lines: [line("1101", 5, 0), line("4101", 0, 5)] },
      });
      await db.fiscalPeriod.updateMany({ where: { fiscalYearId: fyB, ordinal: 4 }, data: { status: "CLOSED" } });
      await expectErrorAsync("FISCAL_LIFECYCLE", () => commitTrialBalance({ user: admin, ip: null, id: res.import.id, input: { version: res.import.version } }));
      await db.fiscalPeriod.updateMany({ where: { fiscalYearId: fyB, ordinal: 4 }, data: { status: "OPEN" } });
      await db.fiscalYear.update({ where: { id: fyB }, data: { status: "LOCKED" } });
      await expectErrorAsync("FISCAL_LIFECYCLE", () => commitTrialBalance({ user: admin, ip: null, id: res.import.id, input: { version: res.import.version } }));
      await db.fiscalYear.update({ where: { id: fyB }, data: { status: "OPEN" } });
      // بعد فتح الحواجز: الاعتماد ينجح (يغطي سنة OPEN وفترات OPEN)
      const committed = await commitTrialBalance({ user: admin, ip: null, id: res.import.id, input: { version: res.import.version, reason: "بعد فتح الحواجز" } });
      expect(committed.status === "COMMITTED", "اعتماد ناجح بعد استيفاء دورة الحياة");
    });

    await check("J+I حساب مجهول يبقى غير مصنف في snapshot الاعتماد (لا تخمين)", async () => {
      const { createTrialBalance, commitTrialBalance } = await import("../src/lib/trial-balance-server");
      const res = await createTrialBalance({
        user: admin, ip: null,
        input: { companyId: coA, fiscalYearId: fyA, fromDate: "2026-08-01", toDate: "2026-08-31", dataType: "PERIOD_MOVEMENT", lines: [line("9999", 7, 0, "حساب غامض"), line("1101", 0, 7)] },
      });
      const c = await commitTrialBalance({ user: admin, ip: null, id: res.import.id, input: { version: res.import.version } });
      expect(c.status === "COMMITTED", "المعتمد ممكن مع حسابات غير مصنفة (لا يمنع الاعتماد — يمنع القوائم النهائية لاحقًا)");
      const l = await db.trialBalanceLine.findFirst({ where: { importId: res.import.id, accountCode: "9999" } });
      expect(l!.mappingStatus === "NEEDS_CLASSIFICATION" && !l!.statementLineCode && !l!.classification, "9999 ⇒ NEEDS_CLASSIFICATION بلا بند ولا تصنيف (مُجمّد)");
      // إعادة التحقق مرفوضة للمعتمد
      const { revalidateTrialBalance } = await import("../src/lib/trial-balance-server");
      await expectErrorAsync("NOT_FOUND", () => revalidateTrialBalance({ user: admin, ip: null, id: res.import.id, input: { version: c.version } }));
    });

    await check("L optimistic locking: اعتماد/حذف بنسخ قديمة ⇒ 409", async () => {
      const { commitTrialBalance, deleteTrialBalance } = await import("../src/lib/trial-balance-server");
      await expectErrorAsync("VERSION_CONFLICT", () => commitTrialBalance({ user: admin, ip: null, id: draftId, input: { version: 999 } }));
      await expectErrorAsync("VERSION_CONFLICT", () => deleteTrialBalance({ user: admin, ip: null, id: draftId, input: { version: 999 } }));
    });

    await check("M Audit Trail: SAVED/COMMITTED بـ metadata مركزة (بلا محتوى Excel)", async () => {
      const saved = await db.auditLog.findFirst({ where: { action: "TRIAL_BALANCE_SAVED", entityId: committedId } });
      expect(!!saved, "صف حفظ موجود");
      const meta = JSON.parse(saved!.metadata || "{}");
      expect(meta.companyCode === "TB-A" && meta.dataType === "CUMULATIVE_YTD" && meta.lineCount === 4 && meta.totalDebitMinor === "70000" && !!meta.fileHash, `metadata: ${Object.keys(meta).join(",")}`);
      expect(!JSON.stringify(meta).includes("النقدية"), "لا محتوى سطور داخل التدقيق");
      const com = await db.auditLog.findFirst({ where: { action: "TRIAL_BALANCE_COMMITTED", entityId: committedId } });
      expect(!!com && JSON.parse(com!.metadata || "{}").payloadHash?.length === 64, "صف اعتماد بالبصمة");
      expect(saved!.username === "gate-admin", "actor snapshot");
    });

    await check("A-tail حذف مسودة version-guarded + Cascade للسطور", async () => {
      const { deleteTrialBalance } = await import("../src/lib/trial-balance-server");
      const linesBefore = await db.trialBalanceLine.count({ where: { importId: draftId } });
      expect(linesBefore > 0, "للسورة سطور");
      await deleteTrialBalance({ user: admin, ip: null, id: draftId, input: { version: (await db.trialBalanceImport.findUniqueOrThrow({ where: { id: draftId } })).version, reason: "تنظيف" } });
      expect((await db.trialBalanceImport.findUnique({ where: { id: draftId } })) === null, "الاستيراد حُذف");
      expect((await db.trialBalanceLine.count({ where: { importId: draftId } })) === 0, "السطور حُذفت Cascade");
      const delAudit = await db.auditLog.findFirst({ where: { action: "TRIAL_BALANCE_DELETED", entityId: draftId } });
      expect(!!delAudit, "تدقيق الحذف موجود");
    });
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  console.log("═══ بوابة Phase 6.2B — ميزان المراجعة المحفوظ ═══");
  await partPure();
  await partDB();
  console.log("\n═══ الخلاصة ═══");
  console.log(`PASS: ${passCount}  FAIL: ${failCount}`);
  if (failures.length > 0) for (const f of failures) console.log(`  - ${f}`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("فشل تشغيل البوابة:", e);
  process.exit(1);
});
