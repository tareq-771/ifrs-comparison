// تنظيف بيانات اختبار 3.5 — يعيد القاعدة إلى الحالة النظيفة
// users=1 (المدير), reports=0, groups=0, audit=0, workflowHistory=0
// + integrity_check. لا يمس بنية المخطط ولا النسخ الاحتياطية.
import { PrismaClient } from "@prisma/client";
import { Database } from "bun:sqlite";

const db = new PrismaClient();

async function main() {
  const before = {
    users: await db.user.count(),
    reports: await db.report.count(),
    groups: await db.group.count(),
    audit: await db.auditLog.count(),
    wh: await db.workflowHistory.count(),
  };
  console.log("before:", JSON.stringify(before));

  // حذف بحذر: workflowHistory لا FK — يُحذف كله (بيانات اختبار فقط)
  await db.workflowHistory.deleteMany({});
  await db.auditLog.deleteMany({});
  await db.report.deleteMany({});
  await db.group.deleteMany({});
  // المستخدمون: احتفظ بالمدير الأصلي فقط (أقدم مستخدم role=admin)
  const admin = await db.user.findFirst({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
  await db.user.deleteMany({ where: { id: { not: admin?.id ?? "" } } });

  const after = {
    users: await db.user.count(),
    reports: await db.report.count(),
    groups: await db.group.count(),
    audit: await db.auditLog.count(),
    wh: await db.workflowHistory.count(),
  };
  console.log("after:", JSON.stringify(after));
  const okState = after.users === 1 && after.reports === 0 && after.groups === 0 && after.audit === 0 && after.wh === 0;
  console.log("CLEANUP:", okState ? "OK (pristine)" : "NOT PRISTINE");
}

main()
  .then(() => {
    // integrity_check على الملف الفعلي (بعد disconnect)
  })
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => {
    await db.$disconnect();
    const check = new Database("/home/z/my-project/db/custom.db", { readonly: true });
    const res = check.query("PRAGMA integrity_check").get();
    check.close();
    console.log("integrity:", JSON.stringify(res));
  });
