// Phase 4B.1 — الجرد الساكن لمسارات الكتابة وإثبات حمايتها (بند المستخدم:
// «أضف اختبارًا آليًا يحصر routes الكتابية ويثبت أنها محمية»).
//
// الطبقتان:
//   1. ساكنة: يجرّد كل route.ts تحت src/app/api ويستخرج معالجات
//      GET/POST/PUT/PATCH/DELETE، ثم يصنف كل معالج (كتابة/قراءة/معفى) ويتحقق
//      أن جسم المعالج يستدعي guardWrite/guardRead بالمسار الصحيح.
//      أي مسار كتابي جديد بلا حارس ⇒ فشل الاختبار (يمنع النسيان مستقبلًا).
//   2. سلوكية (تُشغَّل من داخل harness 4B.1 مقابل خادم معزول في نافذة DRAINING):
//      scripts/phase4b1-test-harness.ts يستورد من هذا الملف قائمة المسارات
//      الكتابية ويجربها HTTP فعليًا متوقعًا 503.
//
// الاستثناءات الموثقة (قائمة قصيرة مدققة — القسم 10.1 من وثيقة التصميم):
//   /api/auth/[...nextauth]  — المصادقة والجلسة (تستقبل POST للدخول)
//   /api/system/status       — عام للشريط (GET)
//   /api/backups/[id]/restore        — محرك الاستعادة نفسه (يدير الصيانة)
//   /api/backups/[id]/restore-preview — معاينة المشغّل (GET، تتطلب NORMAL)
// حالة خاصة موثقة: /api/ai/analyze POST — قراءة بالفعل (استدعاء LLM بلا كتابة) ⇒ guardRead.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface RouteHandler {
  route: string;         // مسار URL مثل /api/users/[id]
  filePath: string;      // مسار الملف النسبي
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  guard: "write" | "read" | "exempt";
  guardRouteOk: boolean; // هل استدعى الحارس بنفس المسار؟
  protected: boolean;
}

// الاستثناءات: route + method
const EXEMPT: Array<[string, string]> = [
  ["/api/auth/[...nextauth]", "*"],
  ["/api/system/status", "GET"],
  ["/api/backups/[id]/restore", "POST"],
  ["/api/backups/[id]/restore-preview", "GET"],
  // أدوات إدارة الصيانة — قراءات ملفات (Manifest/ZIP/JSONL) بلا أي وصول DB:
  // يجب أن تبقى متاحة للمشغّل أثناء الصيانة نفسها (وثيقة التصميم 10.1)
  ["/api/backups", "GET"],
  ["/api/backups/[id]", "GET"],
  ["/api/backups/[id]/download", "GET"],
  ["/api/backups/recovery-log", "GET"],
  // فحص حيوية بلا DB
  ["/api", "GET"],
  // Phase 5A — health endpoint محدود المعلومات: بلا حارس leases عمدًا —
  // يجب أن يستجيب أثناء full-block/RECOVERY_REQUIRED نفسه (عقده: 200/503 حسب
  // الحالة، بلا بيانات تطبيقية) — مثل /api/system/status
  ["/api/health", "GET"],
];

// معالجات بفعل كتابي لكنها قراءة بنيويًا (بلا أي كتابة DB) — guardRead
const READ_BY_VERB: Array<[string, string]> = [
  ["/api/ai/analyze", "POST"],
];

function isExempt(route: string, method: string): boolean {
  return EXEMPT.some(([r, m]) => (m === "*" || m === method) && r === route);
}
function isReadByVerb(route: string, method: string): boolean {
  return READ_BY_VERB.some(([r, m]) => r === route && m === method);
}

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listRouteFiles(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

function findBody(src: string, from: number): { open: number; close: number } | null {
  // scanner سليم: يتجاوز التوقيع حتى أول '{' على عمق أقواس صفر، مع تجاوز
  // التعليقات والسلاسل (بما فيها template literals) ثم يطابق الأقواس.
  let depth = 0;
  let i = from;
  let open = -1;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1] ?? "";
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i = src.indexOf("*/", i + 2); if (i < 0) return null; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) break;
        i++;
      }
      i++; continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "{" && depth === 0) { open = i; break; }
    i++;
  }
  if (open < 0) return null;
  depth = 0;
  let k = open;
  while (k < src.length) {
    const c = src[k];
    const n = src[k + 1] ?? "";
    if (c === '"' || c === "'" || c === "`") {
      const q = c; k++;
      while (k < src.length) {
        if (src[k] === "\\") { k += 2; continue; }
        if (src[k] === q) break;
        k++;
      }
      k++; continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return { open, close: k }; }
    k++;
  }
  return null;
}

function extractHandlers(src: string): Array<{ method: string; body: string }> {
  const out: Array<{ method: string; body: string }> = [];
  const re = /export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const method = m[1];
    const range = findBody(src, m.index + m[0].length - 1);
    if (!range) continue;
    out.push({ method, body: src.slice(range.open, range.close + 1) });
  }
  return out;
}

export function scanRoutes(root: string): { handlers: RouteHandler[]; allProtected: boolean } {
  const apiDir = path.join(root, "src", "app", "api");
  const files = listRouteFiles(apiDir);
  const handlers: RouteHandler[] = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    const route = rel
      .replace(/^src\/app\/api/, "/api")
      .replace(/\/route\.ts$/, "");
    const src = readFileSync(file, "utf8");
    for (const { method, body } of extractHandlers(src)) {
      const exempt = isExempt(route, method);
      const readByVerb = isReadByVerb(route, method);
      const expectedGuard: "write" | "read" | "exempt" = exempt ? "exempt" : readByVerb ? "read" : method === "GET" ? "read" : "write";
      // معالج 405 stub: يرفض بنيويًا ولا يصل لأي DB — محمي بحد ذاته
      const isStub = /status:\s*405/.test(body) && body.length < 220;
      const guardRouteOk =
        expectedGuard === "exempt"
          ? true
          : isStub
            ? true
            : new RegExp(`guard(Write|Read)\\(\\s*["'\`]${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`).test(body) &&
              body.includes(expectedGuard === "write" ? "guardWrite" : "guardRead");
      handlers.push({
        route,
        filePath: rel,
        method: method as RouteHandler["method"],
        guard: expectedGuard,
        guardRouteOk,
        protected: expectedGuard === "exempt" ? true : guardRouteOk,
      });
    }
  }
  const allProtected = handlers.every((h) => h.protected);
  return { handlers, allProtected };
}

if (process.argv[1] && process.argv[1].endsWith("phase4b1-write-guard-scan.ts")) {
  const root = process.cwd();
  const { handlers, allProtected } = scanRoutes(root);
  console.log("=== الجرد الساكن لمسارات API والحماية ===\n");
  for (const h of handlers) {
    const mark = h.protected ? "✅" : "❌";
    const kind = h.guard === "exempt" ? "معفى" : h.guard === "write" ? "كتابة" : "قراءة";
    console.log(`${mark} ${h.method.padEnd(6)} ${h.route.padEnd(38)} ${kind}${h.guardRouteOk ? "" : "  ← الحارس غائب/بمسار خاطئ"}`);
  }
  const writes = handlers.filter((h) => h.guard === "write");
  const reads = handlers.filter((h) => h.guard === "read");
  const exempt = handlers.filter((h) => h.guard === "exempt");
  console.log(`\nالإجمالي: ${handlers.length} معالجًا — كتابة: ${writes.length} · قراءة: ${reads.length} · معفاة: ${exempt.length}`);
  console.log(allProtected ? "\n✅ كل المعالجات محمية/مصنفة كما يجب" : "\n❌ معالجات غير محمية — أضف الحارس!");
  process.exit(allProtected ? 0 : 1);
}
