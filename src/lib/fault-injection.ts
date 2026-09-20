// Phase 4B.1 — حقن الأعطال للاختبار (Fault Injection) — غير متاح في الإنتاج.
//
// قرار المستخدم حرفيًا: «يجب أن يكون هناك Fault Injection مخصص للاختبار،
// غير متاح في production API».
//
// البوابة المزدوجة (كلتاهما إلزامية):
//   1. متغير بيئة RECOVERY_FAULT_INJECTION=1 — لا يُضبط أبدًا في بيئة التشغيل.
//   2. NODE_ENV ≠ production.
// عند غياب أي منهما: كل دوال هذا الملف no-op حرفيًا — لا قارئ ملف، لا تأثير.
//
// القناة: ملف تحكم <VAR_DIR>/test/fault-injection.json يقرأه المحرك عند كل نقطة
// فحص (وليس HTTP API — لا يمكن استغلاله عبر الشبكة إطلاقًا). الصيغة:
// {
//   "points": { "POINT_NAME": "fail" | "crash" | "stall" },
//   "drainTimeoutMs": 8000,
//   "stallTimeoutMs": 30000
// }
// "fail"  ⇒ الدالة التي تحتوي النقطة ترمي خطأ منظمًا (مسار الفشل الحقيقي).
// "crash" ⇒ العملية تُقتل SIGKILL فورًا (محاكاة موت process في المنتصف).
// "stall" ⇒ العملية تنتظر حتى يُزال النقطة من ملف التحكم (نافذة فحص سلوكية).

import { existsSync, readFileSync } from "node:fs";
import { resolveFaultInjectionControlPath } from "@/lib/backup-config";

export type FaultMode = "fail" | "crash" | "stall";

export interface FaultControlFile {
  points?: Record<string, FaultMode>;
  /** مهلة drain مختصرة للاختبارات (بدل 30 ثانية الافتراضية). */
  drainTimeoutMs?: number;
  /** أقصى انتظار لنقطة stall قبل الاستسلام (حماية من تعليق الاختبار). */
  stallTimeoutMs?: number;
  /** مهلة إجمالية مختصرة للاختبارات. */
  totalTimeoutMs?: number;
  /** كتابات وهمية تُحقن في عدّاد التصريف أثناء DRAINING (اختبار مهلة التصريف). */
  phantomWrites?: number;
}

const ENV_ENABLED = process.env.RECOVERY_FAULT_INJECTION === "1" && process.env.NODE_ENV !== "production";

export function faultInjectionEnabled(): boolean {
  return ENV_ENABLED;
}

function readControl(): FaultControlFile | null {
  if (!ENV_ENABLED) return null;
  try {
    const p = resolveFaultInjectionControlPath();
    if (!existsSync(p)) return null;
    const obj = JSON.parse(readFileSync(p, "utf8")) as FaultControlFile;
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/** هل نقطة الفشل مفعّلة بنمط معين؟ */
function modeAt(point: string): FaultMode | null {
  const control = readControl();
  return control?.points?.[point] ?? null;
}

/** هل ينبغي أن تفشل النقطة فشلًا منظمًا؟ */
export function shouldFail(point: string): boolean {
  return modeAt(point) === "fail";
}

/** انتظار stall — يُعاد فورًا إن لم تكن النقطة stall أو كانت القناة معطلة. */
export async function maybeStall(point: string): Promise<void> {
  if (modeAt(point) !== "stall") return;
  const control = readControl();
  const timeoutMs = control?.stallTimeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (modeAt(point) !== "stall") return; // أُزيلت من ملف التحكم — أكمل
    await new Promise((r) => setTimeout(r, 150));
  }
  // استسلام أمان: أزل الانتظار (الاختبار سيكتشف التعليق بنفسه)
}

/**
 * محاكاة crash — SIGKILL فوري للعملية الحالية إذا كانت النقطة بنمط crash.
 * لا تعود أبدًا عند التفعيل (العملية تموت في مكانها — بالضبط المطلوب).
 */
export function maybeCrash(point: string): void {
  if (modeAt(point) !== "crash") return;
  try {
    console.error(`[fault-injection] SIGKILL عند النقطة ${point} (اختبار معزول حصرًا)`);
  } catch {
    /* ignore */
  }
  process.kill(process.pid, "SIGKILL");
}

/** إعدادات الاختبار القابلة للضبط من ملف التحكم (مهلات مختصرة). */
export function testDrainTimeoutMs(fallback: number): number {
  const control = readControl();
  return control?.drainTimeoutMs ?? fallback;
}

export function testTotalTimeoutMs(fallback: number): number {
  const control = readControl();
  return control?.totalTimeoutMs ?? fallback;
}

/** عدد كتابات وهمية يحقنها المحرك في عدّاد التصريف أثناء DRAINING (اختبار المهلة). */
export function testPhantomWriteCount(): number {
  const control = readControl();
  const n = control?.phantomWrites ?? 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
