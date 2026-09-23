// Phase 6.1 — سياسة إقفال الشركة: القائمة المبيّضة للمكوّنات + تقييم الجاهزية (خادم).
//
// الحدود الموثقة للمرحلة 6.1:
//   - المكوّنات المسموحة أوليًا: TRIAL_BALANCE | INCOME_STATEMENT | BALANCE_SHEET.
//   - لا اشتقاق قائمة التدفقات النقدية ولا جداول FinancialStatement في 6.1 —
//     لذلك يُبلغ التقييم كل مكوّن مطلوب كـ«غير متاح» برمز STATEMENT_LAYER_NOT_IMPLEMENTED.
//   - لا تُختلق أي بيانات اعتماد/إقفال مالية إطلاقًا — التقييم الكامل يعمل في 6.2.

import { db } from "@/lib/db";

export const CLOSING_COMPONENTS = {
  TRIAL_BALANCE: "TRIAL_BALANCE",
  INCOME_STATEMENT: "INCOME_STATEMENT",
  BALANCE_SHEET: "BALANCE_SHEET",
} as const;

export type ClosingComponent = (typeof CLOSING_COMPONENTS)[keyof typeof CLOSING_COMPONENTS];

export const CLOSING_COMPONENT_LABELS: Record<ClosingComponent, string> = {
  TRIAL_BALANCE: "ميزان المراجعة",
  INCOME_STATEMENT: "قائمة الدخل",
  BALANCE_SHEET: "قائمة المركز المالي",
};

export function isClosingComponent(v: unknown): v is ClosingComponent {
  return (
    v === CLOSING_COMPONENTS.TRIAL_BALANCE ||
    v === CLOSING_COMPONENTS.INCOME_STATEMENT ||
    v === CLOSING_COMPONENTS.BALANCE_SHEET
  );
}

export class ClosingPolicyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ClosingPolicyError";
    this.code = code;
  }
}

/** تطبيع قائمة المكوّنات المطلوبة: كواد مسجلة فقط، بلا تكرار، بترتيب مستقر. */
export function normalizeRequiredComponents(raw: unknown): ClosingComponent[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ClosingPolicyError("COMPONENTS_INVALID", "قائمة المكوّنات المطلوبة يجب أن تكون مصفوفة.");
  }
  const out: ClosingComponent[] = [];
  for (const v of raw) {
    if (!isClosingComponent(v)) {
      throw new ClosingPolicyError(
        "COMPONENT_UNKNOWN",
        `مكوّن غير مسجل: ${String(v)} — القائمة المبيّضة: ${Object.values(CLOSING_COMPONENTS).join(", ")}.`
      );
    }
    if (!out.includes(v)) out.push(v);
  }
  // ترتيب مستقر حتمي (ترتيب القائمة المبيّضة) — يضمن تمثيل تخزين متطابق للقيم المتكافئة
  const order: ClosingComponent[] = [
    CLOSING_COMPONENTS.TRIAL_BALANCE,
    CLOSING_COMPONENTS.INCOME_STATEMENT,
    CLOSING_COMPONENTS.BALANCE_SHEET,
  ];
  return order.filter((c) => out.includes(c));
}

export interface ComponentReadiness {
  component: ClosingComponent;
  required: boolean;
  available: false;
  status: "STATEMENT_LAYER_NOT_IMPLEMENTED";
  label: string;
}

export interface ClosingReadiness {
  companyId: string;
  requiredComponents: ClosingComponent[];
  /** في 6.1: false دائمًا — طبقة القوائم غير مبنية بعد (توثيق صادق لا تمويه). */
  readyToClose: false;
  blockers: string[];
  components: ComponentReadiness[];
}

/** قراءة السياسة الحالية (أو افتراضي فارغ إن لم تُضبط بعد). */
export async function getClosingPolicy(companyId: string): Promise<{ requiredComponents: ClosingComponent[] } | null> {
  const row = await db.companyClosingPolicy.findUnique({ where: { companyId } });
  if (!row) return null;
  let components: ClosingComponent[] = [];
  try {
    components = normalizeRequiredComponents(JSON.parse(row.requiredComponents));
  } catch {
    components = [];
  }
  return { requiredComponents: components };
}

/**
 * تقييم جاهزية الإقفال — 6.1: يُبلاغ المكوّنات المطلوبة كغير متاحة
 * (STATEMENT_LAYER_NOT_IMPLEMENTED) دون أي ادعاء اعتماد.
 */
export async function evaluateClosingReadiness(companyId: string): Promise<ClosingReadiness> {
  const policy = await getClosingPolicy(companyId);
  const requiredComponents = policy?.requiredComponents ?? [];
  const components: ComponentReadiness[] = requiredComponents.map((c) => ({
    component: c,
    required: true,
    available: false,
    status: "STATEMENT_LAYER_NOT_IMPLEMENTED",
    label: CLOSING_COMPONENT_LABELS[c],
  }));
  return {
    companyId,
    requiredComponents,
    readyToClose: false,
    blockers: requiredComponents.length > 0 ? ["STATEMENT_LAYER_NOT_IMPLEMENTED"] : [],
    components,
  };
}

/** كتابة/تحديث السياسة داخل معاملة (يُستدعى من مسار PUT مع التدقيق). */
export async function writeClosingPolicy(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  companyId: string,
  components: ClosingComponent[],
  actor: { id: string | null; name: string }
) {
  const data = {
    requiredComponents: JSON.stringify(components),
    updatedById: actor.id,
    updatedByName: actor.name,
  };
  return tx.companyClosingPolicy.upsert({
    where: { companyId },
    create: { companyId, ...data },
    update: data,
  });
}
