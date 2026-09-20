// ترحيل دلالة reviewedAt → reviewStartedAt (المرحلة 3.5A — قرار المستخدم D-5)
//
// الخلفية: قبل 3.5 كان reviewedAt يُثبت عند START_REVIEW (تاريخ بدء المراجعة).
// بعد 3.5: reviewedAt = وقت COMPLETE_REVIEW (توقيع المراجع)، وreviewStartedAt = وقت START_REVIEW.
// لا تغيير دلالة صامتًا: ننقل القيم القديمة إلى reviewStartedAt ثم نفرغ reviewedAt،
// لأن القيمة القديمة كانت دائمًا «بدء مراجعة» وليست «إتمامًا» — وإبقاؤها في reviewedAt
// الجديد سيدل زورًا على توقيع مراجع لم يوقّع بعد.
//
// idempotent: يُنفَّذ مرة واحدة، وإعادة تشغيله لا تغيّر شيئًا (بعد التهجير reviewedAt فارغ).
// تسجيل الأثر: يطبع العدّادات قبل/بعد. لا يمس WorkflowHistory (الأرشيف append-only كما هو).
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const before = {
    reports: await db.report.count(),
    withReviewedAt: await db.report.count({ where: { reviewedAt: { not: null } } }),
    withReviewStartedAt: await db.report.count({ where: { reviewStartedAt: { not: null } } }),
  };
  console.log("before:", JSON.stringify(before));

  // 1) انقل كل قيمة reviewedAt قائمة (بدلالة البدء القديمة) إلى reviewStartedAt
  const moved = await db.$executeRawUnsafe(
    `UPDATE Report SET reviewStartedAt = reviewedAt WHERE reviewedAt IS NOT NULL AND reviewStartedAt IS NULL`
  );
  // 2) أفرغ reviewedAt — لا أحد قد أتم مراجعة بدلالة الإتمام الجديدة بعد
  const cleared = await db.$executeRawUnsafe(`UPDATE Report SET reviewedAt = NULL WHERE reviewedAt IS NOT NULL`);

  const after = {
    reports: await db.report.count(),
    withReviewedAt: await db.report.count({ where: { reviewedAt: { not: null } } }),
    withReviewStartedAt: await db.report.count({ where: { reviewStartedAt: { not: null } } }),
  };
  console.log("moved:", moved, "cleared:", cleared);
  console.log("after:", JSON.stringify(after));
  console.log("MIGRATION_OK");
}

main()
  .catch((e) => { console.error("MIGRATION_FAILED", e); process.exit(1); })
  .finally(() => db.$disconnect());
