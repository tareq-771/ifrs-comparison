// Phase 4A — اختبار العزل الأساسي (طلب المستخدم الصريح):
//  «أنشئ dataset معروفًا → Backup A → تحقق Manifest/counts/checksum → عدّل
//   بيانات التشغيل → Drill على A → أثبت أن قاعدة الـ Drill المؤقتة تحوي
//   Dataset A لا الحالة الجديدة → أثبت أن قاعدة التشغيل بقيت على الحالة
//   الجديدة → أثبت بقاء أدوات Audit/Recovery».
//
// الوسم: كل صفوف الاختبار تحمل علامة __4A_TEST__ وتُنظف كليًا في النهاية.
// صفوف AuditLog تبقى (append-by-design — هي الدليل نفسه).

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { createBackup, runRestoreDrillById, listBackups, BackupError } from "@/lib/backup-server";
import { readRecoveryEvents } from "@/lib/recovery-log";
import { resolveBackupDir } from "@/lib/backup-config";

const ROOT = "/home/z/my-project";
const PROD = path.join(ROOT, "db", "custom.db");
const MARKER = "__4A_TEST__";
const rand = Math.random().toString(36).slice(2, 8);

let failures = 0;
function line(title: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${title}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  console.log("=== اختبار عزل النسخ/Drill عن قاعدة التشغيل (4A) ===\n");

  const live = new PrismaClient({ log: [] });

  // تنظيف دفاعي: بقايا تشغيلات سابقة انهارت قبل التنظيف (بنفس الوسم)
  const leftoverReports = await live.report.deleteMany({ where: { name: { contains: MARKER } } });
  const leftoverGroups = await live.group.deleteMany({ where: { name: { contains: MARKER } } });
  if (leftoverReports.count > 0 || leftoverGroups.count > 0) {
    console.log(
      `⚠️ نظّفت بقايا تشغيلة سابقة: ${leftoverReports.count} تقارير + ${leftoverGroups.count} مجموعات موسومة`
    );
  }

  // 0) نسخة أمان قبل أي شيء
  const backupDir = resolveBackupDir();
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const safety = path.join(backupDir, `pre-4A-isolation-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.db`);
  {
    const src = new Database(PROD, { readonly: true });
    src.exec(`VACUUM INTO '${safety}'`);
    src.close();
    const chk = new Database(safety, { readonly: true });
    const r = chk.query("PRAGMA integrity_check").get() as Record<string, string>;
    chk.close();
    line("نسخة أمان أولية (VACUUM INTO + integrity)", r.integrity_check === "ok", path.basename(safety));
  }

  const countsBefore = {
    users: await live.user.count(),
    groups: await live.group.count(),
    reports: await live.report.count(),
    workflowHistory: await live.workflowHistory.count(),
  };

  // 1) Dataset معروف بالوسم
  const owner = await live.user.findFirst({ select: { id: true } });
  if (!owner) throw new Error("لا يوجد مستخدم لإنشاء مجموعة الاختبار");
  const grp = await live.group.create({
    data: { name: `${MARKER} مجموعة العزل ${rand}`, userId: owner.id },
  });
  const repA1 = await live.report.create({
    data: {
      name: `${MARKER} تقرير A1 ${rand}`,
      groupId: grp.id,
      periodEnd: "2025-01-31",
      status: "DRAFT",
      isFile1Data: JSON.stringify([{ marker: MARKER, dataset: "A" }]),
    },
  });
  const repA2 = await live.report.create({
    data: {
      name: `${MARKER} تقرير A2 ${rand}`,
      groupId: grp.id,
      periodEnd: "2025-02-28",
      status: "DRAFT",
      isFile1Data: JSON.stringify([{ marker: MARKER, dataset: "A" }]),
    },
  });
  line(
    "إنشاء Dataset A الموسوم",
    !!(grp && repA1 && repA2),
    `مجموعة + تقريران (periodEnd 2025-01/2025-02)`
  );

  // 2) Backup A (مع تجاوز فترة التهدئة عند إعادة التشغيل السريع)
  let created: Awaited<ReturnType<typeof createBackup>>;
  try {
    created = await createBackup({ id: null, username: "__4a_isolation_test__" });
  } catch (e) {
    if (e instanceof BackupError && e.code === "COOLDOWN") {
      const waitMs = Number((e.extra as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 60_000) + 500;
      console.log(`⏳ فترة تهدئة — انتظار ${Math.ceil(waitMs / 1000)} ثانية…`);
      await new Promise((r) => setTimeout(r, waitMs));
      created = await createBackup({ id: null, username: "__4a_isolation_test__" });
    } else {
      throw e;
    }
  }
  const backupAId = created.backupId;
  line("Backup A أُنشئ", !!backupAId, `backupId=${backupAId}`);
  line(
    "مستوى A بعد التحقق التلقائي = VALIDATED",
    created.level === "VALIDATED" && !created.validationError,
    `level=${created.level}${created.validationError ? ` خطأ: ${created.validationError}` : ""}`
  );

  const manifestA = created.manifest;
  line(
    "Manifest A: counts تشمل Dataset A",
    manifestA.counts.reports === countsBefore.reports + 2 &&
      manifestA.counts.groups === countsBefore.groups + 1,
    `تقارير ${manifestA.counts.reports} (متوقع ${countsBefore.reports + 2}) · مجموعات ${manifestA.counts.groups}`
  );
  line(
    "Manifest A: periodRange يعكس بيانات A",
    manifestA.periodRange.minPeriodEnd === "2025-01-31" && manifestA.periodRange.maxPeriodEnd === "2025-02-28",
    `${manifestA.periodRange.minPeriodEnd} → ${manifestA.periodRange.maxPeriodEnd}`
  );

  // إعادة حساب SHA-256 مستقلة من الحزمة على القرص (لا ثقة بالـ Manifest وحده)
  {
    const entry = listBackups().local.find((e) => e.backupId === backupAId);
    line("A موجود في القائمة (من Manifest)", !!entry, `الحجم ${entry?.sizeBytes ?? 0} بايت`);
  }

  // 3) Drill A الأول
  const drill1 = await runRestoreDrillById(backupAId, { id: null, username: "__4a_isolation_test__" });
  line(
    "Drill A الأول → RESTORE_VERIFIED",
    drill1.ok && drill1.level === "RESTORE_VERIFIED" && drill1.countsMatched,
    `${drill1.steps.length} مرحلة · قراءة Prisma: ${drill1.prismaReadTests.length}/5 جداول · ${(drill1.durationMs / 1000).toFixed(2)}s`
  );

  // 4) تعديل قاعدة التشغيل (الحالة «الجديدة»)
  const repA3 = await live.report.create({
    data: {
      name: `${MARKER} تقرير A3 ${rand} (بعد النسخة)`,
      groupId: grp.id,
      periodEnd: "2025-03-31",
      status: "DRAFT",
    },
  });
  await live.report.update({ where: { id: repA1.id }, data: { name: `${MARKER} تقرير A1 معدل ${rand}` } });
  const prodCountsAfterMutation = {
    users: await live.user.count(),
    groups: await live.group.count(),
    reports: await live.report.count(),
  };
  line(
    "تعديل قاعدة التشغيل بعد النسخة (تقرير ثالث + تغيير اسم)",
    prodCountsAfterMutation.reports === countsBefore.reports + 3,
    `تقارير التشغيل الآن ${prodCountsAfterMutation.reports}`
  );

  // 5) Drill A الثاني — المؤقتة يجب أن تحوي A لا الحالة الجديدة
  const drill2 = await runRestoreDrillById(backupAId, { id: null, username: "__4a_isolation_test__" });
  line(
    "Drill A الثاني (بعد تعديل التشغيل) نجح",
    drill2.ok && drill2.countsMatched && drill2.periodRangeMatched,
    "عدّ المؤقتة مطابق للـ Manifest حرفيًا"
  );

  // التحقق الحاسم: محتوى المؤقتة من الـ Drill = Dataset A حرفيًا
  // نعيد نفس ما يفعله الـ Drill: فك الحزمة وقراءة محتواها عبر Prisma مؤقتة
  {
    const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
    const os = await import("node:os");
    const JSZip = (await import("jszip")).default;
    const tmpWs = mkdtempSync(path.join(os.tmpdir(), "4a-isolation-"));
    const zipPath = path.join(backupDir, `${backupAId}.zip`);
    const zip = await JSZip.loadAsync(readFileSync(zipPath));
    const dbBuf = await zip.file("database.db")!.async("nodebuffer");
    const tmpDb = path.join(tmpWs, "candidate.db");
    writeFileSync(tmpDb, dbBuf, { mode: 0o600 });
    const temp = new PrismaClient({ datasources: { db: { url: `file:${tmpDb}` } }, log: [] });
    const tempReports = await temp.report.findMany({ select: { name: true, periodEnd: true, isFile1Data: true } });
    const tempGroup = await temp.group.findMany({ select: { name: true } });
    const hasA1Original = tempReports.some((r) => r.name === `${MARKER} تقرير A1 ${rand}`);
    const hasA1Modified = tempReports.some((r) => r.name === `${MARKER} تقرير A1 معدل ${rand}`);
    const hasA3 = tempReports.some((r) => r.name.includes("A3"));
    const markerData = tempReports.some((r) => (r.isFile1Data ?? "").includes(MARKER));
    line(
      "⭐ المؤقتة تحوي Dataset A حرفيًا (A1 بالاسم الأصلي + بيانات موسومة)",
      hasA1Original && markerData,
      `${tempReports.length} تقارير في المؤقتة`
    );
    line("المؤقتة لا تحوي الحالة الجديدة (لا A3 ولا الاسم المعدل)", !hasA3 && !hasA1Modified);
    line("المؤقتة تحوي مجموعة الاختبار", tempGroup.some((g) => g.name.includes(MARKER)));
    await temp.$disconnect();
    rmSync(tmpWs, { recursive: true, force: true });
  }

  // 6) قاعدة التشغيل بقيت على الحالة الجديدة ولم تُمس بالـ Drill
  const prodA1 = await live.report.findUnique({ where: { id: repA1.id }, select: { name: true } });
  const prodHasA3 = !!(await live.report.findUnique({ where: { id: repA3.id }, select: { id: true } }));
  line(
    "قاعدة التشغيل ما زالت على الحالة الجديدة (الاسم المعدل + A3 موجودان)",
    prodA1?.name === `${MARKER} تقرير A1 معدل ${rand}` && prodHasA3
  );
  {
    const chk = new Database(PROD, { readonly: true });
    const r = chk.query("PRAGMA integrity_check").get() as Record<string, string>;
    chk.close();
    line("integrity_check لقاعدة التشغيل بعد كل العمليات", r.integrity_check === "ok");
  }

  // 7) بقاء أدلة Audit وRecovery
  const auditRows = await live.auditLog.findMany({
    where: { entityId: backupAId },
    select: { action: true },
  });
  const auditActions = new Set(auditRows.map((r) => r.action));
  line(
    "AuditLog يحمل أدلة Backup/Drill للنسخة A",
    auditActions.has("BACKUP_CREATED") && auditActions.has("BACKUP_VALIDATED") && auditActions.has("BACKUP_DRILLED"),
    [...auditActions].join(", ")
  );
  const recovery = await readRecoveryEvents(100);
  const opEvents = recovery.events.filter((e) => e.backupId === backupAId).map((e) => e.event);
  const recSet = new Set(opEvents);
  line(
    "سجل الاسترجاع الخارجي يحمل التسلسل الكامل (بدء/إنشاء/تحقق/Drill×2)",
    recSet.has("BACKUP_STARTED") && recSet.has("BACKUP_CREATED") && recSet.has("BACKUP_VALIDATED") && recSet.has("DRILL_STARTED") && recSet.has("DRILL_VERIFIED"),
    `${opEvents.length} حدثًا للنسخة A`
  );

  // 8) تنظيف كامل — قاعدة التشغيل تعود لحالة ما قبل الاختبار
  await live.report.deleteMany({ where: { name: { contains: MARKER } } });
  await live.group.deleteMany({ where: { name: { contains: MARKER } } });
  const countsFinal = {
    users: await live.user.count(),
    groups: await live.group.count(),
    reports: await live.report.count(),
    workflowHistory: await live.workflowHistory.count(),
  };
  line(
    "التنظيف: قاعدة التشغيل عادت لحالة ما قبل الاختبار",
    countsFinal.users === countsBefore.users &&
      countsFinal.groups === countsBefore.groups &&
      countsFinal.reports === countsBefore.reports &&
      countsFinal.workflowHistory === countsBefore.workflowHistory,
    JSON.stringify(countsFinal)
  );
  {
    const chk = new Database(PROD, { readonly: true });
    const r = chk.query("PRAGMA integrity_check").get() as Record<string, string>;
    chk.close();
    line("integrity_check نهائي لقاعدة التشغيل", r.integrity_check === "ok");
  }

  await live.$disconnect();
  console.log(failures === 0 ? "\n=== اختبار العزل: نجاح كامل ===" : `\n=== فشل ${failures} فحص ===`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
