// فحص حالة قاعدة البيانات قبل المرحلة 3.5A + نسخة احتياطية VACUUM INTO
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const [users, reports, groups, audit, wh] = await Promise.all([
    db.user.count(),
    db.report.count(),
    db.group.count(),
    db.auditLog.count(),
    db.workflowHistory.count(),
  ]);
  console.log(JSON.stringify({ users, reports, groups, audit, workflowHistory: wh }));

  // توزيع حالات التقارير (إن وجدت) — لمعرفة هل يوجد تقارير فيها reviewedAt بدلالة البدء (مهم للترحيل)
  const byStatus = await db.report.groupBy({ by: ["status"], _count: { _all: true } });
  console.log("byStatus:", JSON.stringify(byStatus));
  const withReviewedAt = await db.report.count({ where: { reviewedAt: { not: null } } });
  console.log("reportsWithReviewedAt(start-semantics):", withReviewedAt);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
