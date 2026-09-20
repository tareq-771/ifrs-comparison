// التحقق من الفهارس بـ EXPLAIN QUERY PLAN على بيانات اختبار معقولة (قرار المستخدم:
// «افحص Query Plans الفعلية بعد وجود بيانات اختبار معقولة، ولا تضف فهارس مكررة أو غير مستخدمة»)
// — يزرع بيانات اصطناعية مباشرة، يشغّل ANALYZE، يفحص خطط الاستعلامات الفعلية للوحة،
// ثم ينظف بالكامل ويحدّث الإحصاءات.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);

const STATUSES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "PENDING_APPROVAL", "RETURNED", "APPROVED", "REOPENED"];

async function eqp(label: string, sql: string, params: unknown[] = []) {
  const rows = await db.$queryRawUnsafe<Array<{ detail: string }>>(
    `EXPLAIN QUERY PLAN ${sql}`,
    ...params
  );
  console.log(`\n◆ ${label}`);
  for (const r of rows) console.log("   ", r.detail);
  return rows.map((r) => r.detail).join(" | ");
}

async function main() {
  console.log("== EQP: فحص الفهارس على بيانات معقولة ==");
  const N = 2500;

  // مجموعتان اصطناعيتان لاختبار (groupId,status)
  const gA = await db.group.create({ data: { name: "EQP-A", userId: (await db.user.findFirstOrThrow({ where: { username: "admin" } })).id } });
  const gB = await db.group.create({ data: { name: "EQP-B", userId: (await db.user.findFirstOrThrow({ where: { username: "admin" } })).id } });
  const adminId = (await db.user.findFirstOrThrow({ where: { username: "admin" } })).id;

  const rows: Parameters<typeof db.report.createMany>[0]["data"] = [];
  for (let i = 0; i < N; i++) {
    const status = STATUSES[i % STATUSES.length];
    const hasPeriod = i % 5 !== 0; // 20% بلا فترة
    const hasDue = i % 4 !== 0;    // 25% بلا استحقاق
    rows.push({
      name: `EQP-${i}`,
      status,
      cycle: i % 50 === 0 ? 2 : 1,
      periodEnd: hasPeriod ? (i % 2 === 0 ? "2025-09-30" : "2025-08-31") : null,
      dueDate: hasDue ? (i % 3 === 0 ? today : i % 3 === 1 ? "2026-01-15" : "2020-01-01") : null,
      groupId: i % 3 === 0 ? gA.id : i % 3 === 1 ? gB.id : null,
      preparedById: adminId,
      preparedByName: "admin",
      reviewedById: i % 2 === 0 ? adminId : null,
      approvedById: null,
      isSettings: "{}", bsSettings: "{}",
      isFile1Data: "[]", isFile2Data: "[]", isFile1Headers: "[]", isFile2Headers: "[]",
      isFile1Cols: "{}", isFile2Cols: "{}",
      bsFileData: "[]", bsFileHeaders: "[]", bsFileCols: "{}",
      bsFile2Data: "[]", bsFile2Headers: "[]", bsFile2Cols: "{}",
    });
  }
  await db.report.createMany({ data: rows });
  await db.$executeRawUnsafe("ANALYZE");
  console.log(`SEED: ${N} صفًا اصطناعيًا + ANALYZE`);

  // 1) القائمة الافتراضية: ترتيب updatedAt مع صفحة
  await eqp(
    "القائمة الافتراضية: ORDER BY updatedAt DESC LIMIT 20",
    `SELECT id FROM Report ORDER BY updatedAt DESC LIMIT 20 OFFSET 0`
  );

  // 2) فلتر المتأخر: dueDate < today AND status != APPROVED
  await eqp(
    "المتأخر: dueDate<today ∧ status≠APPROVED",
    `SELECT id FROM Report WHERE dueDate IS NOT NULL AND dueDate < ? AND status != 'APPROVED'`,
    [today]
  );

  // 3) مرحلة RETURNED: OR مركب
  await eqp(
    "مرحلة RETURNED (OR مع DRAFT+returnedAt)",
    `SELECT id FROM Report WHERE (status='RETURNED' OR (status='DRAFT' AND returnedAt IS NOT NULL))`
  );

  // 4) المجموعة + الحالة (نمط شائع)
  await eqp(
    "groupId=X ∧ status='DRAFT'",
    `SELECT id FROM Report WHERE groupId = ? AND status = 'DRAFT'`,
    [gA.id]
  );

  // 5) فلتر الفترة
  await eqp(
    "periodEnd IN ('2025-09-30','2025-08-31')",
    `SELECT id FROM Report WHERE periodEnd IN ('2025-09-30','2025-08-31')`
  );

  // 6) الدورة > 1
  await eqp(
    "cycle > 1",
    `SELECT id FROM Report WHERE cycle > 1`
  );

  // 7) facets: DISTINCT periodEnd ضمن شرط
  await eqp(
    "facets: DISTINCT periodEnd",
    `SELECT DISTINCT periodEnd FROM Report WHERE periodEnd IS NOT NULL`
  );

  // 8) count بالرؤية (غير المدير): OR متعدد
  await eqp(
    "رؤية غير المدير: OR(owner/group/participants)",
    `SELECT id FROM Report WHERE (userId = ? OR groupId IN (?) OR preparedById = ? OR reviewedById = ? OR approvedById = ?)`,
    [adminId, gA.id, adminId, adminId, adminId]
  );

  console.log("\n== CLEANUP ==");
  await db.report.deleteMany({ where: { name: { startsWith: "EQP-" } } });
  await db.group.deleteMany({ where: { name: { startsWith: "EQP-" } } });
  await db.$executeRawUnsafe("ANALYZE"); // تحديث الإحصاءات بعد الحذف
  const left = await db.report.count();
  console.log(`cleanup done — reports left: ${left}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => {
    await db.$disconnect();
    const { Database } = await import("bun:sqlite");
    const check = new Database("/home/z/my-project/db/custom.db", { readonly: true });
    console.log("integrity:", JSON.stringify(check.query("PRAGMA integrity_check").get()));
    check.close();
  });
