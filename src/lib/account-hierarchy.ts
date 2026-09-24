// Phase 6.9 — اشتقاق هرمية الحسابات من الأكواد الموجودة فعليًا (وحدة نقية — بلا side effects).
//
// قرار معماري موثق (تعليمات 6.9-2D):
//   المخطط الحالي (schema.prisma) لا يحتوي أي metadata هرمية للحسابات — الحسابات
//   تأتي حصرًا من سطور ميزان المراجعة المعتمد (TrialBalanceLine.accountCode).
//   لذلك تُشتق الهرمية من بادئات الأكواد الموجودة فعليًا في البيانات نفسها:
//     سلف(A) = كل كود c موجود حيث A.startsWith(c) و A ≠ c (بادئة فعلية مناسبة)
//     الأب(أ) = أطول بادئة موجودة
//     المستوى(أ) = عدد الأسلاف الموجودين + 1
//   هذا اشتقاق حتمي قابل للشرح والتتبع — وليس اختراعًا صامتًا:
//   تُعرض ملاحظة صريحة في الواجهة بأن الهرمية مشتقة من الأكواد الفعلية،
//   وأي كود غير قابل للوضع في الهرمية (فارغ/مسافات) ⇒ anomaly معلنة (فشل واضح)
//   ولا يُخترع له أب ولا مستوى.
//
// قيمة العقدة المجمعة (قاعدة موثقة): قيمة المجموعة = قيمة الكود نفسه إن وُجدت
//   + مجموع قيم كل أحفاده المناسبين الموجودين. ميزان المراجعة مصدر الحقيقة لكل سطر؛
//   إذا ظهر كود أب بقيمة مباشرة فهو حساب فعلي أيضًا فيُجمع مع أبنائه (لا يُهمَل).

export interface AccountHierarchy {
  /** المستوى لكل كود (1..N) — الأكواد الشاذة غير موجودة في الخريطة. */
  levelOf: Map<string, number>;
  /** الأب المباشر (أطول بادئة موجودة) — null للجذور. */
  parentOf: Map<string, string | null>;
  /** الأبناء المباشرون مرتبين ترتيبًا معجميًا. */
  childrenOf: Map<string, string[]>;
  /** الجذور (بلا أب) مرتبة. */
  roots: string[];
  /** الأوراق: أكواد بلا أبناء. */
  leaves: string[];
  /** الحسابات الرئيسية: أكواد لها أبناء على الأقل. */
  mains: string[];
  /** أقصى مستوى موجود فعليًا (لملف اختيار المستوى في الواجهة — بلا حد مُفترَض). */
  maxLevel: number;
  /** أكواد غير قابلة للوضع في الهرمية (فارغة/مسافات) — تُعلن ولا تُخترع لها هرمية. */
  anomalies: string[];
  /** كل الأكواد الصالحة مرتبة معجميًا. */
  codes: string[];
}

function properAncestors(code: string, codeSet: Set<string>): string[] {
  // كل بادئات الكود التي تمثل أكوادًا موجودة فعلًا (بادئة فعلية مناسبة، ليست الكود نفسه).
  const out: string[] = [];
  for (let end = 1; end < code.length; end += 1) {
    const candidate = code.slice(0, end);
    if (codeSet.has(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * اشتقاق الهرمية من مجموعة أكواد موجودة. حتمي 100% — نفس المدخل يعطي نفس الناتج.
 * الأكواد تُقارن كما هي (سلاسل) — لا تفسير رقمي ولا افتراض أطوال قطاعات.
 */
export function deriveAccountHierarchy(rawCodes: readonly string[]): AccountHierarchy {
  const anomalies: string[] = [];
  const valid: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawCodes) {
    const code = typeof raw === "string" ? raw.trim() : "";
    if (!code) {
      if (!anomalies.includes(typeof raw === "string" ? raw : String(raw))) anomalies.push(typeof raw === "string" ? raw : String(raw));
      continue;
    }
    if (!seen.has(code)) {
      seen.add(code);
      valid.push(code);
    }
  }
  valid.sort((a, b) => a.localeCompare(b));

  const codeSet = new Set(valid);
  const levelOf = new Map<string, number>();
  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string, string[]>();
  let maxLevel = 0;

  for (const code of valid) {
    const ancestors = properAncestors(code, codeSet);
    // المستوى = عدد الأسلاف الموجودين + 1 (الأسلاف متسلسلون حتمًا: كل سلف من الأسلاف
    // الأقصر سلف لبادئة الأطول ضمن مجموعة الأكواد نفسها).
    const level = ancestors.length + 1;
    levelOf.set(code, level);
    const parent = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;
    parentOf.set(code, parent);
    if (parent) {
      const list = childrenOf.get(parent);
      if (list) list.push(code);
      else childrenOf.set(parent, [code]);
    }
    if (level > maxLevel) maxLevel = level;
  }

  for (const [parent, list] of childrenOf) list.sort((a, b) => a.localeCompare(b));

  const roots = valid.filter((c) => parentOf.get(c) === null);
  const leaves = valid.filter((c) => (childrenOf.get(c) ?? []).length === 0);
  const mains = valid.filter((c) => (childrenOf.get(c) ?? []).length > 0);

  return { levelOf, parentOf, childrenOf, roots, leaves, mains, maxLevel, anomalies, codes: valid };
}

/**
 * كل الأح descendants المناسبين لكود (البادئات الفعلية الأطول منه ضمن المجموعة).
 * يُستخدم للتجميع التصاعدي (roll-up) والتتبع (traceability).
 */
export function descendantCodesOf(code: string, allCodes: readonly string[]): string[] {
  return allCodes.filter((c) => c.length > code.length && c.startsWith(code));
}

/** وصف عربي موحد لطريقة الاشتقاق — يُعرض في الواجهة والطباعة (شفافية لا اختراع). */
export const HIERARCHY_DERIVATION_NOTE =
  "الهرمية مشتقة حتميًا من بادئات أكواد الحسابات الموجودة فعليًا في ميزان المراجعة المعتمد (لا توجد بيانات هرمية مخزنة في المخطط). قيمة أي حساب رئيسي = قيمته المباشرة إن وُجدت + قيم أحفاده.";
