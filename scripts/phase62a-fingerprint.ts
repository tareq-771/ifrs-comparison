// Phase 6.2A — أداة حساب البصمة القاعدية الدلالية لقاعدة مرحّلة (خادميًا حصرًا).
// الاستخدام: DATABASE_URL=file:... bun scripts/phase62a-fingerprint.ts
// تطبع canonical + physical + الصيغة القصيرة — تُستخدم لتحديث
// PINNED_CURRENT_CANONICAL_FINGERPRINT في backup-config.ts بنفس التغيير.

import { PrismaClient } from "@prisma/client";
import { canonicalSchemaFingerprint, physicalSchemaFingerprint } from "../src/lib/schema-fingerprint";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL إلزامي — لن تعمل الأداة على أي قاعدة افتراضية.");
    process.exit(1);
  }
  if (!/dev-62[a-d]|dev-63[a-z]?|dev-64[a-z]?|dev-65[a-z]?|dev-66[a-z]?|phase62[a-d]|phase63[a-z]?|phase64[a-z]?|phase65[a-z]?|phase66[a-z]?/.test(url)) {
    console.error("رفض: البصمة تُحسب على قواعد 6.2x…6.6 المعزولة حصرًا (dev-62a*…dev-66*).");
    process.exit(1);
  }
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    const canonical = await canonicalSchemaFingerprint(client);
    const physical = await physicalSchemaFingerprint(client);
    console.log("canonical:", canonical);
    console.log("physical :", physical);
  } finally {
    await client.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
