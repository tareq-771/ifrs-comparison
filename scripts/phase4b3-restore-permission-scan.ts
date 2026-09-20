/**
 * Phase 4B.3 — Restore-Permission Inventory (فحص ساكن فاشل).
 *
 * الغرض: إثبات آلي دائم أن كل endpoint قادر على الوصول إلى Production
 * Restore/Swap محمي ببوابة requireRestoreDatabase الصريحة — وأن أي endpoint
 * مستقبلي من هذا النوع بلا البوابة يُفشل هذا الاختبار (EXIT ≠ 0).
 *
 * القواعد:
 *  R1 — ملف route.ts يُصنّف "قادرًا على الاستعادة" إذا:
 *        • مساره يحوي /restore  (restore / restore-preview)  أو
 *        • يستورد executeRestore أو buildRestorePreview من restore-server  أو
 *        • يستورد كاتب حالة صيانة (transitionMaintenanceState /
 *          enterRecoveryRequired / operatorClearMaintenanceState /
 *          clearMaintenanceStateFile).
 *  R2 — كل route قادر على الاستعادة يجب أن يستدعي requireRestoreDatabase( حرفيًا.
 *  R3 — ترتيب التفويض: أول ظهور لrequireRestoreDatabase في الملف يجب أن يسبق
 *        أول ظهور لأي من: executeRestore / buildRestorePreview /
 *        isRestoreEngineEnabled / readMaintenanceStateFile — أي أن حالة المحرك
 *        لا تُكشف لغير المخوّل قبل رفض authorization (قرار 4B.3).
 *  R4 — كل route تحت /api/backups يجب أن يستخدم requireManageBackups أو
 *        requireRestoreDatabase (لا مسار مجهول الحارس).
 *  R5 — فصل صارم: لا route يستخدم requireRestoreDatabase كحارس وحيد لمسارات
 *        إدارة النسخ العامة، ولا يستخدم requireManageBackups لحارس التنفيذ —
 *        يُتحقق عمليًا: مسارات الإدارة (list/create/details/download/validate/
 *        drill/upload/recovery-log) لا تحتوي requireRestoreDatabase إطلاقًا.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const API_DIR = join(ROOT, "src", "app", "api");

const RESTORE_CAPABLE_IMPORTS = [
  "executeRestore",
  "buildRestorePreview",
  "transitionMaintenanceState",
  "enterRecoveryRequired",
  "operatorClearMaintenanceState",
  "clearMaintenanceStateFile",
];

interface RouteFile {
  rel: string;          // مسار نسبي مثل api/backups/[id]/restore/route.ts
  src: string;
}

function walkRoutes(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkRoutes(p, acc);
    else if (name === "route.ts") acc.push(p);
  }
  return acc;
}

function main(): number {
  const files: RouteFile[] = walkRoutes(API_DIR).map((p) => ({
    rel: relative(join(ROOT, "src", "app"), p),
    src: readFileSync(p, "utf8"),
  }));

  console.log("=== 4B.3 Restore-Permission Inventory ===");
  console.log("Scanned route files:", files.length);

  const violations: string[] = [];
  const restoreCapable: string[] = [];
  const backupRoutes: string[] = [];

  for (const f of files) {
    const usesRestoreGuard = f.src.includes("requireRestoreDatabase(");
    const usesBackupGuard = f.src.includes("requireManageBackups(");
    const importsRestoreCapable = RESTORE_CAPABLE_IMPORTS.some((id) =>
      f.src.includes(id)
    );
    const pathIsRestore = /\/restore(\/|-)/.test(f.rel);
    const isRestoreCapable = importsRestoreCapable || pathIsRestore;
    const isBackupRoute = f.rel.startsWith("api/backups/");

    if (isBackupRoute) backupRoutes.push(f.rel);
    if (isRestoreCapable) restoreCapable.push(f.rel);

    // R2
    if (isRestoreCapable && !usesRestoreGuard) {
      violations.push(
        `R2 [${f.rel}] مسار قادر على الوصول إلى Production Restore/Swap بلا requireRestoreDatabase`
      );
    }

    // R3 — التفويض قبل أي كشف عن حالة المحرك/الصيانة
    if (isRestoreCapable && usesRestoreGuard) {
      const guardIdx = f.src.indexOf("requireRestoreDatabase(");
      for (const marker of [
        "executeRestore(",
        "buildRestorePreview(",
        "isRestoreEngineEnabled(",
        "readMaintenanceStateFile(",
      ]) {
        const idx = f.src.indexOf(marker);
        if (idx !== -1 && idx < guardIdx) {
          violations.push(
            `R3 [${f.rel}] ${marker} يظهر قبل requireRestoreDatabase — كشف حالة المحرك قبل التفويض`
          );
        }
      }
    }

    // R4
    if (isBackupRoute && !usesBackupGuard && !usesRestoreGuard) {
      violations.push(`R4 [${f.rel}] مسار نسخ احتياطي بلا أي حارس صلاحية معروف`);
    }

    // R5 — فصل الصلاحيتين: مسارات الإدارة لا تحمل بوابة الاستعادة والعكس
    const managementRoutes = [
      "api/backups/route.ts",
      "api/backups/[id]/route.ts",
      "api/backups/[id]/download/route.ts",
      "api/backups/[id]/validate/route.ts",
      "api/backups/[id]/drill/route.ts",
      "api/backups/upload/route.ts",
      "api/backups/recovery-log/route.ts",
    ];
    if (managementRoutes.includes(f.rel)) {
      if (!usesBackupGuard) {
        violations.push(`R5 [${f.rel}] مسار إدارة نسخ بلا requireManageBackups`);
      }
      if (usesRestoreGuard) {
        violations.push(
          `R5 [${f.rel}] مسار إدارة نسخ عام يحمل requireRestoreDatabase — خلط صلاحيات`
        );
      }
    }
  }

  // لوحة الجرد
  console.log("\n--- Production-Restore-capable routes (require restoreDatabase) ---");
  for (const r of restoreCapable.sort()) console.log("  •", r);
  console.log("\n--- Backup-management routes (require manageBackups) ---");
  for (const r of backupRoutes.sort()) console.log("  •", r);
  console.log("\n--- Other routes ---");
  for (const f of files
    .map((x) => x.rel)
    .filter((r) => !restoreCapable.includes(r) && !backupRoutes.includes(r))
    .sort()) {
    console.log("  •", f);
  }

  if (violations.length > 0) {
    console.log("\n❌ VIOLATIONS:", violations.length);
    for (const v of violations) console.log("  -", v);
    return 1;
  }
  console.log(
    "\n✅ Inventory PASS: كل مسارات الاستعادة محمية بrequireRestoreDatabase قبل أي كشف عن حالة المحرك، وكل مسارات النسخ محمية بrequireManageBackups، والفصل بين الصلاحيتين قائم."
  );
  return 0;
}

process.exit(main());
