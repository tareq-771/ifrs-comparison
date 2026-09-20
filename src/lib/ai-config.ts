/**
 * سجل نماذج GLM في مشروع IFRS.
 *
 * تمت ترقية التحليل الذكي من GLM-5.2 إلى GLM-5.3-Flash.
 * هذا الملف مشترك بين الواجهة والخلفية — لا يستورد أي كود خادم هنا.
 */

export const DEFAULT_MODEL = "GLM-5.3-Flash";

/** الإصدار السابق الذي تمت الترقية منه (للعرض التوثيقي فقط) */
export const PREVIOUS_MODEL_VERSION = "GLM-5.2";

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  isCurrent: boolean;
  isLegacy: boolean;
  speedLabel: string;
  badge: "upgraded" | "legacy";
}

export const AVAILABLE_MODELS: ModelOption[] = [
  {
    id: "GLM-5.3-Flash",
    name: "GLM-5.3-Flash",
    description:
      "الإصدار الأحدث: تحليل مالي أسرع بدقة أعلى ودعم محسّن للعربية والمصطلحات المالية.",
    isCurrent: true,
    isLegacy: false,
    speedLabel: "⚡ فائق السرعة",
    badge: "upgraded",
  },
  {
    id: "GLM-5.2",
    name: "GLM-5.2",
    description: "الإصدار السابق (قديم) — تم الاستغناء عنه في التحليل الذكي.",
    isCurrent: false,
    isLegacy: true,
    speedLabel: "🐢 أبطأ",
    badge: "legacy",
  },
];

export function getModel(id: string): ModelOption {
  return AVAILABLE_MODELS.find((m) => m.id === id) ?? AVAILABLE_MODELS[0];
}

/** النماذج المسموح تمريرها إلى واجهة الخلفية */
export function isAllowedModel(id: unknown): id is string {
  return typeof id === "string" && AVAILABLE_MODELS.some((m) => m.id === id);
}
