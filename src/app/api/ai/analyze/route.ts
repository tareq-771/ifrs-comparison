import { NextRequest } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import { DEFAULT_MODEL, isAllowedModel } from "@/lib/ai-config";
import { guardRead } from "@/lib/api-guard";

export const runtime = "nodejs";
export const maxDuration = 120;

/* ────────────────────────────────────────────────────────────
 * POST /api/ai/analyze
 * التحليل المالي الذكي بنموذج GLM-5.3-Flash (بث NDJSON مباشر)
 *
 * Body: { ratioGroups, L1, L2, model?, language? }
 * Events: {type:"meta"} | {type:"delta",content} | {type:"done"} | {type:"error",error}
 * ──────────────────────────────────────────────────────────── */

interface RatioInput {
  name?: unknown;
  nameEn?: unknown;
  formula?: unknown;
  v1?: unknown;
  v2?: unknown;
  unit?: unknown;
  desirable?: unknown;
  benchmark?: unknown;
}

interface RatioGroupInput {
  title?: unknown;
  titleEn?: unknown;
  ratios?: unknown;
}

interface AnalyzeBody {
  ratioGroups?: unknown;
  L1?: unknown;
  L2?: unknown;
  model?: unknown;
  language?: unknown;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const str = (v: unknown, max = 120, fallback = ""): string =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback;

/** تنسيق قيمة نسبة حسب وحدتها */
function fmtRatio(v: number | null, unit: string): string {
  if (v == null) return "—";
  const n = typeof v === "number" && Number.isFinite(v) ? v : null;
  if (n == null) return "—";
  switch (unit) {
    case "percent":
      return `${n}%`;
    case "amount":
      return n.toLocaleString("en-US");
    case "days":
      return `${n} يوم`;
    default:
      return `${n}×`;
  }
}

/** بناء نص البيانات المالية من مجموعة النسب */
function buildRatiosText(groups: { title: string; titleEn: string; ratios: RatioInput[] }[], L1: string, L2: string): string {
  const lines: string[] = [];
  lines.push(`الفترة المرجعية (المقارنة): ${L1}`);
  lines.push(`الفترة الحالية: ${L2}`);
  lines.push("");
  for (const g of groups) {
    lines.push(`### ${g.title} (${g.titleEn})`);
    lines.push("المؤشر | المعادلة | " + L1 + " | " + L2 + " | الاتجاه المرغوب | المعيار المرجعي");
    lines.push("--- | --- | --- | --- | --- | ---");
    for (const r of g.ratios) {
      const name = str(r.name, 80);
      const nameEn = str(r.nameEn, 80);
      const formula = str(r.formula, 120);
      const unit = str(r.unit, 20, "ratio");
      const v1 = fmtRatio(num(r.v1), unit);
      const v2 = fmtRatio(num(r.v2), unit);
      const desirable = str(r.desirable, 10) === "low" ? "أقل أفضل" : "أعلى أفضل";
      const benchmark = str(r.benchmark, 30, "—");
      lines.push(`${name} / ${nameEn} | ${formula} | ${v1} | ${v2} | ${desirable} | ${benchmark}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  return guardRead("/api/ai/analyze", async () => {
    let body: AnalyzeBody;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "صيغة الطلب غير صالحة" }, { status: 400 });
    }

    /* ── التحقق من النموذج — الافتراضي بعد الترقية: GLM-5.3-Flash ── */
    const model = isAllowedModel(body.model) ? body.model : DEFAULT_MODEL;
    const language = str(body.language, 5, "ar") === "en" ? "en" : "ar";

    /* ── تنقية بيانات النسب ── */
    const rawGroups = Array.isArray(body.ratioGroups) ? body.ratioGroups : [];
    if (rawGroups.length === 0) {
      return Response.json(
        { error: "لا توجد نسب مالية للتحليل — ارفع ملف قائمة المركز المالي أولًا" },
        { status: 400 }
      );
    }

    const groups = (rawGroups as RatioGroupInput[])
      .slice(0, 10)
      .map((g) => ({
        title: str(g.title, 80, "مجموعة"),
        titleEn: str(g.titleEn, 80, "Group"),
        ratios: (Array.isArray(g.ratios) ? (g.ratios as RatioInput[]) : [])
          .slice(0, 20)
          .map((r) => ({
            name: str(r.name, 80),
            nameEn: str(r.nameEn, 80),
            formula: str(r.formula, 120),
            v1: num(r.v1),
            v2: num(r.v2),
            unit: str(r.unit, 20, "ratio"),
            desirable: str(r.desirable, 10, "high"),
            benchmark: str(r.benchmark, 30),
          })),
      }))
      .filter((g) => g.ratios.length > 0);

    if (groups.length === 0) {
      return Response.json({ error: "بيانات النسب غير صالحة" }, { status: 400 });
    }

    const L1 = str(body.L1, 60, "الفترة المرجعية");
    const L2 = str(body.L2, 60, "الفترة الحالية");

    const ratiosText = buildRatiosText(groups, L1, L2);

    const systemPrompt =
      language === "en"
        ? "You are a senior financial analyst (CFA) specialized in IFRS/IAS 1 ratio analysis. Analyze the provided financial ratios comparing a prior period with the current period. Respond in Markdown with sections: Executive Summary, Group-by-Group Analysis, Strengths, Risks & Observations, Actionable Recommendations. Be precise, reference actual numbers, and keep it professional and concise (under 700 words)."
        : "أنت محلل مالي أول (CFA) متخصص في تحليل النسب المالية وفق معايير IFRS/IAS 1. لديك جدول نسب مالية يقارن فترة مرجعية بفترة حالية. حلّل الأرقام الفعلية ولا تخترع بيانات. اكتب بالعربية الفصحى الواضحة بتنسيق Markdown مع العناوين التالية بالضبط: «الملخص التنفيذي» ثم «التحليل حسب المجموعات» (تُغطي كل مجموعة بجملة أو جملتين مع الإشارة للأرقام) ثم «نقاط القوة» ثم «المخاطر والملاحظات» ثم «التوصيات العملية» (3 إلى 5 توصيات مرقّمة وقابلة للتنفيذ). كن دقيقًا وموجزًا (أقل من 700 كلمة)، واستخدم أسماء النسب كما وردت، وأشر إلى التغير بين الفترتين عند وجوده.";

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const send = (event: Record<string, unknown>) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          } catch {
            closed = true;
          }
        };

        try {
          send({ type: "meta", model });

          const zai = await ZAI.create();
          const completion = await zai.chat.completions.create({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: `حلّل النسب المالية التالية وأنتج التقرير المطلوب:\n\n${ratiosText}`,
              },
            ],
            thinking: { type: "disabled" },
          });

          /* استجابة JSON كاملة (بدون stream من الخادم) */
          const content: string =
            completion?.choices?.[0]?.message?.content ?? "";

          if (!content.trim()) {
            send({ type: "error", error: "استجابة فارغة من النموذج" });
          } else {
            /* تقسيم الاستجابة إلى مقاطع لمحاكاة البث السلس */
            const chunks = content.match(/[\s\S]{1,24}/g) ?? [content];
            for (const chunk of chunks) {
              send({ type: "delta", content: chunk });
              await new Promise((r) => setTimeout(r, 12));
            }
            send({ type: "done", model });
          }

          if (!closed) {
            closed = true;
            controller.close();
          }
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "خطأ غير معروف في نموذج التحليل";
          if (!closed) {
            send({ type: "error", error: message });
            closed = true;
            try {
              controller.close();
            } catch {
              /* أُغلق مسبقًا */
            }
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-AI-Model": model,
      },
    });
  });
}
