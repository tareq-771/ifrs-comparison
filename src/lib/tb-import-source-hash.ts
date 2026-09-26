// ═══════════════════════════════════════════════════════════════════════════
// Phase 7.0 (Step 2) — TB Importer Source Payload Hash (isolated helper)
// مساعد الهاش المعزول — SHA-256 فوق حمولة حقائق المصدر القيانية.
//
// العزل مقصود: النواة النقية (tb-import-normalization.ts) تبقى بلا أي استيراد
// خادمي/عُقدي — هذه الوحدة حصرًا هي من تلمس node:crypto وتُستهلك من الخادم.
//  • الحمولة من buildTbSourceFactsPayload (حقائق مصدر حصرًا — لا نتائج تحقق،
//    لا طوابع زمن، لا عشوائية).
//  • التسلسل القياني canonicalJsonStringify يرتب مفاتيح الكائنات معجميًا ⇒
//    الهاش مستقل عن ترتيب إدراج الخصائص حتميًا.
//  • بلا أي إصرار/تخزين هنا — قيمة نصية تُعاد للمستدعي حصرًا.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";

import {
  buildTbSourceFactsPayload,
  canonicalJsonStringify,
  type TbNormalizationRequest,
} from "./tb-import-normalization";

/** SHA-256 نصي (hex صغير) — حتمي عبر المنصات لنفس المدخل النصي. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** نص JSON القياني لحقائق مصدر TB — مفاتيح مرتبة، مصفوفات بترتيبها المصدري. */
export function canonicalTbSourceFactsJson(request: TbNormalizationRequest): string {
  return canonicalJsonStringify(buildTbSourceFactsPayload(request));
}

/** هاش حمولة حقائق المصدر — يتغير عند تغيّر أي حقيقة مصدر أو إسناد أو حسم. */
export function computeTbSourcePayloadHash(request: TbNormalizationRequest): string {
  return sha256Hex(canonicalTbSourceFactsJson(request));
}
