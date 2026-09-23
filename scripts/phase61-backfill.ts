// Phase 6.1 — أداة الربط الخلفي (Backfill) — أداة مشغّل خادمية idempotent.
//
// الاستخدام:
//   bun scripts/phase61-backfill.ts --db="file:/abs/path.db"            → DRY-RUN (افتراضي — لا كتابة)
//   bun scripts/phase61-backfill.ts --db="file:/abs/path.db" --apply    → تنفيذ فعلي
//   bun scripts/phase61-backfill.ts --db=... --report=/path/out.json    → كتابة تقرير JSON
//   خيارات: --no-provisional-years (لا إنشاء حاويات مؤقتة ⇒ التقارير المعنية PENDING)
//           --skip-permissions (تخطي ربط الصلاحيات)
//
// القرارات الموثقة (تعليمات 6.1 §§12-14):
//   1) كل مجموعة عمل قديمة (Group) تُقابل شركة واحدة حتميًا عبر Company.legacyGroupId
//      (فريد) — المرساة في قاعدة البيانات نفسها لا في ملفات VAR_DIR؛ إعادة التشغيل
//      مهما فُقدت الملفات تعيد نفس النتيجة بلا شركات مكررة أبدًا.
//   2) لا تخمين لبيانات الشركة/الفترة المفقودة — غير المؤكد يعزل بحالة
//      backfillStatus: NO_COMPANY (تقرير بلا مجموعة) / NO_PERIOD (periodEnd مفقود
//      أو خارج الحاويات) / PENDING (شركة معروفة والحاوية مؤجلة/بانتظار التأكيد).
//   3) الشك التاريخي للسنوات المالية (§14): لا يُدَّعى أن السنة الميلادية حقيقة
//      محاسبية — تُنشأ حاويات PROVISIONAL_IMPORTED (ميلادية من أدلة periodEnd)
//      تتطلب تأكيد المدير (PATCH confirm-provisional) — أو تُترك PENDING مع
//      --no-provisional-years.
//   4) الصلاحيات preserve-or-narrow: companyIds المقترحة ⊆ مشتقة من رؤية
//      المجموعات السابقة (مملوكة ∪ مرتبطة) — لا وصول جديد لا يمكن تتبعه؛
//      المدير يُترك كما هو (قاعدة الدور تحل إلى الكل موثقة)؛ viewAllCompanies
//      لا يُمنح لأحد من الأداة (صريح يدويًا فقط).
//   5) BEFORE/AFTER verification + أحداث تدقيق (PERMISSIONS_CHANGED/BACKFILL_APPLIED)
//      عند كل تغيير فعلي فقط (لا ضجيج تدقيق عند الإعادة).

import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/* ── وسيطات الأوامر ── */
const args = process.argv.slice(2);
function argValue(name: string): string | null {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const dbUrl = argValue("db");
if (!dbUrl || !/^file:\/|\bfile:[A-Za-z]:/.test(dbUrl)) {
  console.error("استخدام: --db=\"file:/abs/path.db\" إلزامي (مسار مطلق).");
  process.exit(1);
}
const APPLY = args.includes("--apply");
const WRITE_PROVISIONAL = !args.includes("--no-provisional-years");
const SKIP_PERMISSIONS = args.includes("--skip-permissions");
const reportOut = argValue("report");

const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

/* ── بنية التقرير ── */
interface UserPermissionRow {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  linkedGroupIds: string[];
  ownedGroupIds: string[];
  effectiveGroupNames: string[];
  proposedCompanyIds: string[];
  proposedCompanyCodes: string[];
  currentCompanyIds: string[];
  proposedViewAllCompanies: boolean;
  changed: boolean;
  reason: string;
  traceable: boolean;
}
interface BackfillReport {
  mode: "dry-run" | "apply";
  dbUrl: string;
  generatedAt: string;
  groupsFound: number;
  companiesProposed: number;
  companiesCreated: number;
  companiesReused: number;
  reportsExamined: number;
  reportsMapped: number;
  reportsNoCompany: number;
  reportsNoPeriod: number;
  reportsPending: number;
  reportsAlreadyMapped: number;
  fiscalYearsProposed: number;
  fiscalYearsCreated: number;
  fiscalPeriodsProposed: number;
  fiscalPeriodsCreated: number;
  permissionMappingsProposed: number;
  permissionMappingsApplied: number;
  warnings: string[];
  errors: string[];
  companyPlan: Array<{ groupId: string; groupName: string; code: string; nameAr: string; action: string; companyId?: string }>;
  permissionPlan: UserPermissionRow[];
  quarantine: {
    noCompany: Array<{ reportId: string; name: string; groupId: string | null }>;
    noPeriod: Array<{ reportId: string; name: string; periodEnd: string | null }>;
    pending: Array<{ reportId: string; name: string; periodEnd: string | null }>;
  };
  beforeAfter?: { before: Record<string, number>; after: Record<string, number> };
}

const report: BackfillReport = {
  mode: APPLY ? "apply" : "dry-run",
  dbUrl,
  generatedAt: new Date().toISOString(),
  groupsFound: 0,
  companiesProposed: 0,
  companiesCreated: 0,
  companiesReused: 0,
  reportsExamined: 0,
  reportsMapped: 0,
  reportsNoCompany: 0,
  reportsNoPeriod: 0,
  reportsPending: 0,
  reportsAlreadyMapped: 0,
  fiscalYearsProposed: 0,
  fiscalYearsCreated: 0,
  fiscalPeriodsProposed: 0,
  fiscalPeriodsCreated: 0,
  permissionMappingsProposed: 0,
  permissionMappingsApplied: 0,
  warnings: [],
  errors: [],
  companyPlan: [],
  permissionPlan: [],
  quarantine: { noCompany: [], noPeriod: [], pending: [] },
};

/** كود حتمي مستقر للشركة المشتقة من مجموعة — من معرّف المجموعة (ليس الاسم المعروض). */
function legacyCompanyCode(groupId: string): string {
  return `LEG-${groupId}`;
}

async function countSnapshot() {
  return {
    users: await db.user.count(),
    groups: await db.group.count(),
    reports: await db.report.count(),
    companies: await db.company.count(),
    fiscalYears: await db.fiscalYear.count(),
    fiscalPeriods: await db.fiscalPeriod.count(),
    mappedReports: await db.report.count({ where: { backfillStatus: "MAPPED" } }),
    noCompanyReports: await db.report.count({ where: { backfillStatus: "NO_COMPANY" } }),
    noPeriodReports: await db.report.count({ where: { backfillStatus: "NO_PERIOD" } }),
    pendingReports: await db.report.count({ where: { backfillStatus: "PENDING" } }),
  };
}

/* ── المرحلة 1: الشركات من المجموعات (حتمية عبر legacyGroupId) ── */
async function planCompanies() {
  const groups = await db.group.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  report.groupsFound = groups.length;
  for (const g of groups) {
    const existing = await db.company.findUnique({ where: { legacyGroupId: g.id } });
    const code = legacyCompanyCode(g.id);
    if (existing) {
      report.companiesReused += 1;
      report.companyPlan.push({ groupId: g.id, groupName: g.name, code, nameAr: g.name, action: "REUSE_EXISTING", companyId: existing.id });
    } else {
      // تعارض كود محتمل (LEG-<groupId> وحيد ببنائه — لكن دفاعيًا)
      const dupCode = await db.company.findUnique({ where: { code } });
      if (dupCode) {
        report.errors.push(`تعارض كود شركة «${code}» مع شركة قائمة ${dupCode.id} — لم تُلمس (راجع يدويًا).`);
        report.companyPlan.push({ groupId: g.id, groupName: g.name, code, nameAr: g.name, action: "CODE_CONFLICT" });
        continue;
      }
      report.companiesProposed += 1;
      report.companyPlan.push({ groupId: g.id, groupName: g.name, code, nameAr: g.name, action: APPLY ? "CREATED" : "WILL_CREATE" });
    }
  }
}

async function applyCompanies(): Promise<Map<string, string>> {
  const map = new Map<string, string>(); // groupId → companyId
  for (const entry of report.companyPlan) {
    if (entry.action === "REUSE_EXISTING" && entry.companyId) {
      map.set(entry.groupId, entry.companyId);
      continue;
    }
    if (entry.action !== "CREATED") continue;
    const created = await db.company.create({
      data: {
        code: entry.code,
        nameAr: entry.nameAr,
        nameEn: "",
        status: "ACTIVE",
        functionalCurrency: "", // غير محددة حتى أول استخدام مالي — لا تخمين
        reportingCurrency: "",
        notes: `مُنشأة آليًا من مجموعة عمل قديمة (${entry.groupName}) عبر أداة الربط 6.1 — راجع الكود/الاسم/العملة.`,
        legacyGroupId: entry.groupId,
      },
    });
    report.companiesCreated += 1;
    entry.companyId = created.id; // املأ الخطة (تُستخدم في السنوات/الإيصال)
    map.set(entry.groupId, created.id);
  }
  return map;
}

/* ── المرحلة 2: حاويات سنوات مؤقتة من أدلة periodEnd (§14 — بلا ادعاء محاسبي) ── */
interface ProposedFY {
  companyId: string;
  code: string;      // CY<year> حتمي
  startDate: string; // YYYY-01-01
  endDate: string;   // YYYY-12-31
  year: number;
}
function provisionalCalendarYear(companyId: string, year: number): ProposedFY {
  return { companyId, code: `CY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31`, year };
}

async function planFiscalYears(groupToCompany: Map<string, string>) {
  if (!WRITE_PROVISIONAL) {
    report.warnings.push("--no-provisional-years: لن تُنشأ حاويات سنوات مؤقتة — تقارير الشركات المعروفة بدون حاوية ستبقى PENDING (قرار §14 الخيار البديل).");
  }
  const reports = await db.report.findMany({
    where: { groupId: { not: null }, periodEnd: { not: null } },
    select: { id: true, groupId: true, periodEnd: true },
  });
  const years = new Set<string>();
  for (const r of reports) {
    const companyId = r.groupId ? groupToCompany.get(r.groupId) : undefined;
    if (!companyId || !r.periodEnd) continue;
    const y = Number(r.periodEnd.slice(0, 4));
    if (!Number.isInteger(y) || y < 1900 || y > 2200) {
      report.warnings.push(`تقرير ${r.id}: periodEnd غير قياسي (${r.periodEnd}) — تجاهل السنة.`);
      continue;
    }
    years.add(`${companyId}:${y}`);
  }
  for (const key of [...years].sort()) {
    const [companyId, yStr] = key.split(":");
    const prop = provisionalCalendarYear(companyId, Number(yStr));
    const existing = await db.fiscalYear.findUnique({
      where: { companyId_code: { companyId, code: prop.code } },
      select: { id: true },
    });
    if (existing) continue;
    // لا يُنشأ ميلادي مؤقت إذا وُجدت سنة مرئية تغطي النطاق نفسه للشركة
    const covering = await db.fiscalYear.findFirst({
      where: {
        companyId,
        startDate: { lte: prop.startDate },
        endDate: { gte: prop.endDate },
      },
      select: { id: true },
    });
    if (covering) continue;
    report.fiscalYearsProposed += 1;
    report.fiscalPeriodsProposed += 12; // سنة ميلادية كاملة = 12 فترة شهرية (حتمية)
  }
}

async function applyFiscalYears(): Promise<void> {
  if (!WRITE_PROVISIONAL) return;
  // الاشتقاق الحتمي من خطة الشركات المطبقة (مطابق للمعاينة — بلا تخمين)
  const keys = new Set<string>();
  for (const entry of report.companyPlan) {
    if (entry.action !== "CREATED" && entry.action !== "REUSE_EXISTING") continue;
    if (!entry.companyId) continue;
    const years = await db.report.findMany({
      where: { groupId: entry.groupId, periodEnd: { not: null } },
      select: { periodEnd: true },
    });
    for (const r of years) {
      if (!r.periodEnd) continue;
      const y = Number(r.periodEnd.slice(0, 4));
      if (!Number.isInteger(y) || y < 1900 || y > 2200) continue;
      keys.add(`${entry.companyId}:${y}`);
    }
  }
  for (const key of [...keys].sort()) {
    const [companyId, yStr] = key.split(":");
    const prop = provisionalCalendarYear(companyId, Number(yStr));
    const existing = await db.fiscalYear.findUnique({
      where: { companyId_code: { companyId, code: prop.code } },
      select: { id: true },
    });
    if (existing) continue;
    const covering = await db.fiscalYear.findFirst({
      where: { companyId, startDate: { lte: prop.startDate }, endDate: { gte: prop.endDate } },
      select: { id: true },
    });
    if (covering) continue;
    const created = await db.fiscalYear.create({
      data: {
        companyId,
        code: prop.code,
        displayNameAr: `سنة ${prop.year} — مؤقتة من استيراد (تتطلب تأكيد المدير)`,
        displayNameEn: `${prop.year} — provisional import (admin confirmation required)`,
        startDate: prop.startDate,
        endDate: prop.endDate,
        periodCount: 12,
        status: "OPEN",
        origin: "PROVISIONAL_IMPORTED",
        periods: {
          create: Array.from({ length: 12 }, (_, i) => {
            const m = i + 1;
            const mm = String(m).padStart(2, "0");
            const lastDay = new Date(Date.UTC(prop.year, m, 0)).getUTCDate();
            return {
              ordinal: m,
              code: `${prop.year}-${mm}`,
              startDate: `${prop.year}-${mm}-01`,
              endDate: `${prop.year}-${mm}-${String(lastDay).padStart(2, "0")}`,
              displayLabel: `${["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"][i]} ${prop.year} (مؤقتة)`,
            };
          }),
        },
      },
    });
    report.fiscalYearsCreated += 1;
    report.fiscalPeriodsCreated += 12;
    void created;
  }
}

/* ── المرحلة 3: ربط التقارير (بدون تخمين — عزل صريح) ── */
async function mapReports(groupToCompany: Map<string, string>): Promise<void> {
  const reports = await db.report.findMany({
    select: { id: true, name: true, groupId: true, periodEnd: true, companyId: true, backfillStatus: true },
  });
  report.reportsExamined = reports.length;
  for (const r of reports) {
    if (r.backfillStatus === "MAPPED" && r.companyId) {
      report.reportsAlreadyMapped += 1;
      continue;
    }
    const companyId = r.groupId ? groupToCompany.get(r.groupId) ?? null : null;
    if (!companyId) {
      // لا مجموعات ولا شركة معروفة — عزل NO_COMPANY (لا تخمين)
      report.reportsNoCompany += 1;
      report.quarantine.noCompany.push({ reportId: r.id, name: r.name, groupId: r.groupId });
      if (APPLY) {
        await db.report.update({
          where: { id: r.id },
          data: { backfillStatus: "NO_COMPANY", companyId: null, fiscalPeriodId: null },
        });
      }
      continue;
    }
    if (!r.periodEnd) {
      report.reportsNoPeriod += 1;
      report.quarantine.noPeriod.push({ reportId: r.id, name: r.name, periodEnd: r.periodEnd });
      if (APPLY) {
        await db.report.update({
          where: { id: r.id },
          data: { backfillStatus: "NO_PERIOD", companyId, fiscalPeriodId: null },
        });
      }
      continue;
    }
    // فترة تحتوي periodEnd (ضمن سنوات الشركة الموجودة فعليًا في القاعدة)
    const period = await db.fiscalPeriod.findFirst({
      where: {
        fiscalYear: { companyId },
        startDate: { lte: r.periodEnd },
        endDate: { gte: r.periodEnd },
      },
      select: { id: true, fiscalYear: { select: { code: true, origin: true } } },
      orderBy: { startDate: "asc" },
    });
    if (!period) {
      if (WRITE_PROVISIONAL) {
        // بعد تطبيق الحاويات المؤقتة كان يجب وجود فترة — إن غابت ⇒ NO_PERIOD صادق
        report.reportsNoPeriod += 1;
        report.quarantine.noPeriod.push({ reportId: r.id, name: r.name, periodEnd: r.periodEnd });
        if (APPLY) {
          await db.report.update({
            where: { id: r.id },
            data: { backfillStatus: "NO_PERIOD", companyId, fiscalPeriodId: null },
          });
        }
      } else {
        report.reportsPending += 1;
        report.quarantine.pending.push({ reportId: r.id, name: r.name, periodEnd: r.periodEnd });
        if (APPLY) {
          await db.report.update({
            where: { id: r.id },
            data: { backfillStatus: "PENDING", companyId, fiscalPeriodId: null },
          });
        }
      }
      continue;
    }
    report.reportsMapped += 1;
    if (APPLY) {
      await db.report.update({
        where: { id: r.id },
        data: { backfillStatus: "MAPPED", companyId, fiscalPeriodId: period.id },
      });
    }
  }
}

/* ── المرحلة 4: ربط الصلاحيات (preserve-or-narrow) ── */
async function planPermissions(groupToCompany: Map<string, string>): Promise<void> {
  if (SKIP_PERMISSIONS) {
    report.warnings.push("--skip-permissions: لم تُحسب خطة الصلاحيات.");
    return;
  }
  const users = await db.user.findMany({
    select: { id: true, username: true, displayName: true, role: true, permissions: true },
    orderBy: { username: "asc" },
  });
  const groupNames = new Map((await db.group.findMany({ select: { id: true, name: true } })).map((g) => [g.id, g.name]));
  for (const u of users) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(u.permissions || "{}");
    } catch {
      report.warnings.push(`مستخدم ${u.username}: permissions JSON غير صالح — عولج كفارغ.`);
    }
    const linked = Array.isArray(parsed.groupIds) ? (parsed.groupIds as string[]).filter((g) => typeof g === "string") : [];
    const owned = (await db.group.findMany({ where: { userId: u.id }, select: { id: true } })).map((g) => g.id);
    const effective = [...new Set([...linked, ...owned])];

    if (u.role === "admin") {
      report.permissionPlan.push({
        userId: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        linkedGroupIds: linked,
        ownedGroupIds: owned,
        effectiveGroupNames: effective.map((g) => groupNames.get(g) ?? g),
        proposedCompanyIds: [],
        proposedCompanyCodes: [],
        currentCompanyIds: Array.isArray(parsed.companyIds) ? (parsed.companyIds as string[]) : [],
        proposedViewAllCompanies: parsed.viewAllCompanies === true,
        changed: false,
        reason: "ADMIN — تُترك كما هي: قاعدة الدور تحل إلى كل الشركات موثقة (resolveCompanyScope)؛ لا تغيير مطلوب.",
        traceable: true,
      });
      continue;
    }

    const proposed = effective
      .map((g) => groupToCompany.get(g))
      .filter((c): c is string => !!c);
    const currentCompanyIds = Array.isArray(parsed.companyIds) ? (parsed.companyIds as string[]).filter((c) => typeof c === "string") : [];
    // UNION الموثّق: الحفاظ على المنح اليدوية القائمة (لا سحب صامت) + إضافة المشتق
    // القابل للتتبع من المجموعات فقط — لا توسيع غير قابل للتتبع أبدًا (preserve-or-narrow).
    const proposedUnique = [...new Set([...currentCompanyIds, ...proposed])];
    const same =
      proposedUnique.length === currentCompanyIds.length &&
      proposedUnique.every((c) => currentCompanyIds.includes(c));
    const unmapped = effective.filter((g) => !groupToCompany.has(g));
    if (unmapped.length > 0) {
      report.warnings.push(`مستخدم ${u.username}: مجموعات بلا شركة مقابلة — تُترك بلا وصول شركات منها: ${unmapped.map((g) => groupNames.get(g) ?? g).join(", ")}`);
    }
    report.permissionMappingsProposed += same ? 0 : 1;
    report.permissionPlan.push({
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      linkedGroupIds: linked,
      ownedGroupIds: owned,
      effectiveGroupNames: effective.map((g) => groupNames.get(g) ?? g),
      proposedCompanyIds: proposedUnique,
      proposedCompanyCodes: proposedUnique.map((c) => `company:${c}`),
      currentCompanyIds,
      proposedViewAllCompanies: parsed.viewAllCompanies === true, // لا سحب من الأداة — قرار إداري صريح
      changed: !same,
      reason: same
        ? "لا تغيير — companyIds الحالية مطابقة للاشتقاق الحتمي (منح يدوي قائم ∪ مشتق المجموعات)."
        : `اتحاد موثّق: منح يدوي قائم + المشتق حتمًا من رؤية المجموعات السابقة (مملوكة/مرتبطة) عبر legacyGroupId — لا سحب للمنح القائم ولا توسيع غير قابل للتتبع؛ viewAllCompanies لم يُمنح.`,
      traceable: true,
    });
  }
}

async function applyPermissions(): Promise<void> {
  if (SKIP_PERMISSIONS) return;
  for (const row of report.permissionPlan) {
    if (row.role === "admin" || !row.changed) continue;
    const u = await db.user.findUnique({ where: { id: row.userId }, select: { permissions: true } });
    if (!u) continue;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(u.permissions || "{}");
    } catch {
      parsed = {};
    }
    // preserve-or-narrow: نضبط companyIds فقط + viewAllCompanies=false صريحًا (إن لم يكن صريحًا سابقًا true من مدير بشري)
    const before = {
      companyIds: Array.isArray(parsed.companyIds) ? parsed.companyIds : [],
      viewAllCompanies: parsed.viewAllCompanies === true,
    } as { companyIds: unknown[]; viewAllCompanies: boolean };
    // إن كان المستخدم قد مُنح viewAllCompanies=true يدويًا سابقًا — الأداة لا تسحبه
    // (السحب قرار إداري صريح) — تُسجَّل ملاحظة فقط.
    if (before.viewAllCompanies) {
      report.warnings.push(`مستخدم ${row.username}: viewAllCompanies=true قائم مسبقًا — لم يُمس (السحب قرار إداري صريح).`);
    }
    const after: Record<string, unknown> = { ...parsed, companyIds: row.proposedCompanyIds };
    if (!before.viewAllCompanies) after.viewAllCompanies = false;
    await db.user.update({ where: { id: row.userId }, data: { permissions: JSON.stringify(after) } });
    report.permissionMappingsApplied += 1;
    await db.auditLog.create({
      data: {
        userId: null,
        username: "system:backfill-6.1",
        action: "PERMISSIONS_CHANGED",
        entityType: "User",
        entityId: row.userId,
        description: `ربط خلفي 6.1 — اشتقاق companyIds من رؤية المجموعات السابقة للمستخدم ${row.username} (preserve-or-narrow)`,
        beforeData: JSON.stringify(before),
        afterData: JSON.stringify({ companyIds: row.proposedCompanyIds, viewAllCompanies: after.viewAllCompanies === true }),
        metadata: JSON.stringify({ tool: "phase61-backfill", mode: report.mode, traceable: row.effectiveGroupNames }),
      },
    });
  }
}

async function writeBackfillAuditEvent(): Promise<void> {
  if (!APPLY) return;
  await db.auditLog.create({
    data: {
      userId: null,
      username: "system:backfill-6.1",
      action: "BACKFILL_APPLIED",
      entityType: "Backfill",
      entityId: `backfill-${Date.now()}`,
      description: `تطبيق ربط خلفي 6.1 — شركات: +${report.companiesCreated}، سنوات مؤقتة: +${report.fiscalYearsCreated}، تقارير مربوطة: ${report.reportsMapped}، NO_COMPANY: ${report.reportsNoCompany}، NO_PERIOD: ${report.reportsNoPeriod}، PENDING: ${report.reportsPending}، صلاحيات: +${report.permissionMappingsApplied}`,
      metadata: JSON.stringify({
        tool: "phase61-backfill",
        provisionalYears: WRITE_PROVISIONAL,
        groupsFound: report.groupsFound,
        reportsExamined: report.reportsExamined,
      }),
    },
  });
}

async function main() {
  console.log(`═══ Phase 6.1 Backfill — ${APPLY ? "APPLY (كتابة فعليًا)" : "DRY-RUN (لا كتابة)"} ═══`);
  console.log(`قاعدة البيانات: ${dbUrl}`);
  const before = await countSnapshot();
  await planCompanies();
  const groupToCompany = new Map<string, string>();
  for (const e of report.companyPlan) {
    if (e.companyId) groupToCompany.set(e.groupId, e.companyId);
  }

  if (APPLY) {
    const map = await applyCompanies();
    for (const [k, v] of map) groupToCompany.set(k, v);
    await planFiscalYears(new Map()); // معاينة مؤشرات فقط (لا كتابة)
    // خطة الصلاحيات مع الخريطة الفعلية (بعد إنشاء الشركات) ثم التطبيق بالترتيب
    await planPermissions(groupToCompany);
    await applyFiscalYears();
    await mapReports(groupToCompany);
    await applyPermissions();
    await writeBackfillAuditEvent();
  } else {
    // DRY-RUN: محاكاة كاملة (بلا أي كتابة) — الشركات المقترحة تُعامل كمعلومة
    // (مرساة حتمية من legacyGroupId) كي يطابق التصنيف نتيجة apply المطابقة.
    const sim = new Map<string, string>(); // groupId → companyId (فعلي أو مرساة حتمية)
    for (const e of report.companyPlan) {
      if (e.action === "REUSE_EXISTING" && e.companyId) sim.set(e.groupId, e.companyId);
      else if (e.action === "WILL_CREATE") sim.set(e.groupId, `proposed:${e.code}`);
    }
    const reports = await db.report.findMany({
      select: { id: true, name: true, groupId: true, periodEnd: true, companyId: true, backfillStatus: true },
    });
    report.reportsExamined = reports.length;
    for (const r of reports) {
      if (r.backfillStatus === "MAPPED" && r.companyId) {
        report.reportsAlreadyMapped += 1;
        continue;
      }
      const simCompany = r.groupId ? sim.get(r.groupId) ?? null : null;
      if (!simCompany) {
        // لا مجموعات ولا شركة معروفة — عزل NO_COMPANY (لا تخمين)
        report.reportsNoCompany += 1;
        report.quarantine.noCompany.push({ reportId: r.id, name: r.name, groupId: r.groupId });
        continue;
      }
      if (!r.periodEnd) {
        report.reportsNoPeriod += 1;
        report.quarantine.noPeriod.push({ reportId: r.id, name: r.name, periodEnd: r.periodEnd });
        continue;
      }
      // فترة موجودة فعلًا تحتوي periodEnd؟ (الشركات الموجودة فقط)
      const isRealCompany = !simCompany.startsWith("proposed:");
      const period = isRealCompany
        ? await db.fiscalPeriod.findFirst({
            where: { fiscalYear: { companyId: simCompany }, startDate: { lte: r.periodEnd }, endDate: { gte: r.periodEnd } },
            select: { id: true },
          })
        : null;
      if (period) {
        report.reportsMapped += 1;
      } else if (WRITE_PROVISIONAL) {
        // apply سينشئ حاوية مؤقتة ميلادية من أدلة periodEnd ثم يربط ⇒ سيُربط
        report.reportsMapped += 1;
      } else {
        // --no-provisional-years: الشركة معروفة والحاوية مؤجلة ⇒ PENDING (قرار §14)
        report.reportsPending += 1;
        report.quarantine.pending.push({ reportId: r.id, name: r.name, periodEnd: r.periodEnd });
      }
    }
    // خطة الصلاحيات في المعاينة: خريطة المرساة الحتمية (existing ∪ proposed)
    const simPerm = new Map<string, string>();
    for (const e of report.companyPlan) {
      if (e.companyId) simPerm.set(e.groupId, e.companyId);
      else if (e.action === "WILL_CREATE") simPerm.set(e.groupId, `proposed:${e.code}`);
    }
    await planPermissions(simPerm);
  }

  const after = await countSnapshot();
  report.beforeAfter = { before, after };

  /* ── طباعة التقرير ── */
  console.log("\n─── الشركات ───");
  for (const e of report.companyPlan) {
    console.log(`  [${e.action}] ${e.code} — ${e.nameAr} (group ${e.groupId})`);
  }
  console.log(`\nالمجموعات: ${report.groupsFound} | شركات مقترحة: ${report.companiesProposed} | أُنشئت: ${report.companiesCreated} | مُعاد استخدامها: ${report.companiesReused}`);
  console.log(`تقارير مفحوصة: ${report.reportsExamined} | ستُربط/أُربطت: ${report.reportsMapped} | NO_COMPANY: ${report.reportsNoCompany} | NO_PERIOD: ${report.reportsNoPeriod} | PENDING: ${report.reportsPending} | مربوطة سابقًا: ${report.reportsAlreadyMapped}`);
  console.log(`سنوات مقترحة: ${report.fiscalYearsProposed} | أُنشئت: ${report.fiscalYearsCreated} | فترات مقترحة: ${report.fiscalPeriodsProposed} | أُنشئت: ${report.fiscalPeriodsCreated}`);
  console.log(`ربط صلاحيات مقترح: ${report.permissionMappingsProposed} | مطبق: ${report.permissionMappingsApplied}`);
  if (report.warnings.length) {
    console.log("\n─── تحذيرات ───");
    for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  }
  if (report.errors.length) {
    console.log("\n─── أخطاء ───");
    for (const e of report.errors) console.log(`  ✗ ${e}`);
  }
  console.log("\n─── عيّنات العزل ───");
  console.log(`  NO_COMPANY: ${report.quarantine.noCompany.slice(0, 5).map((q) => `${q.name}(${q.reportId})`).join(" | ") || "—"}`);
  console.log(`  NO_PERIOD:  ${report.quarantine.noPeriod.slice(0, 5).map((q) => `${q.name}(${q.periodEnd ?? "—"})`).join(" | ") || "—"}`);
  console.log(`  PENDING:    ${report.quarantine.pending.slice(0, 5).map((q) => `${q.name}(${q.periodEnd ?? "—"})`).join(" | ") || "—"}`);
  console.log("\n─── BEFORE/AFTER ───");
  console.log("  BEFORE:", JSON.stringify(report.beforeAfter!.before));
  console.log("  AFTER :", JSON.stringify(report.beforeAfter!.after));
  console.log(`\n═══ النتيجة: ${APPLY ? "تم التطبيق" : "DRY-RUN — لم تُكتب أي بيانات"} ═══`);

  if (reportOut) {
    mkdirSync(path.dirname(reportOut), { recursive: true });
    writeFileSync(reportOut, JSON.stringify(report, null, 2), "utf8");
    console.log(`تقرير JSON: ${reportOut}`);
  }
  if (report.errors.length > 0) process.exitCode = 2;
}

main()
  .catch((e) => {
    console.error("BACKFILL_FAILED", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
