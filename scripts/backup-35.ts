// نسخة احتياطية قبل تغييرات المخطط (VACUUM INTO — النمط المعتمد، بلا checkpoint يتصادم مع Prisma)
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";

const BACKUP_DIR = "/home/z/my-project/backups";
if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const target = `${BACKUP_DIR}/pre-3.5A-${stamp}.db`;

const src = new Database("/home/z/my-project/db/custom.db", { readonly: true });
src.exec(`VACUUM INTO '${target}'`);
src.close();

// تحقق سلامة النسخة
const check = new Database(target, { readonly: true });
const res = check.query("PRAGMA integrity_check").get();
check.close();
console.log("backup:", target);
console.log("integrity:", JSON.stringify(res));
