"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import {
  Sparkles,
  Zap,
  History,
  Square,
  RotateCcw,
  Check,
  Copy,
  AlertTriangle,
  Loader2,
  BrainCircuit,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { type RatioGroup } from "@/lib/accounts";
import { DEFAULT_MODEL, PREVIOUS_MODEL_VERSION } from "@/lib/ai-config";

interface AiAnalysisPanelProps {
  ratioGroups: RatioGroup[];
  L1: string;
  L2: string;
  className?: string;
}

type Phase = "idle" | "streaming" | "done" | "error" | "stopped";

/**
 * لوحة التحليل الذكي المعزّز بنموذج GLM-5.3-Flash.
 * ترقية عن الإصدار السابق GLM-5.2: بث مباشر، ودقة أعلى في المصطلحات المالية.
 */
export function AiAnalysisPanel({ ratioGroups, L1, L2, className }: AiAnalysisPanelProps) {
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [content, setContent] = React.useState("");
  const [errorMsg, setErrorMsg] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const isStreaming = phase === "streaming";
  const hasRatios = ratioGroups.length > 0 && ratioGroups.some((g) => g.ratios.length > 0);

  /* تمرير تلقائي أثناء البث */
  React.useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, isStreaming]);

  const stop = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase((p) => (p === "streaming" ? "stopped" : p));
  }, []);

  const generate = React.useCallback(async () => {
    if (!hasRatios || isStreaming) return;
    abortRef.current?.abort();

    setPhase("streaming");
    setContent("");
    setErrorMsg("");

    const controller = new AbortController();
    abortRef.current = controller;
    let received = "";

    try {
      const res = await fetch("/api/ai/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ratioGroups, L1, L2, model: DEFAULT_MODEL, language: "ar" }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `فشل الطلب (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const cleaned = line.trim();
          if (!cleaned) continue;
          let event: { type?: string; content?: string; error?: string };
          try {
            event = JSON.parse(cleaned);
          } catch {
            continue;
          }
          if (event.type === "delta" && typeof event.content === "string") {
            received += event.content;
            setContent(received);
          } else if (event.type === "done") {
            setPhase("done");
          } else if (event.type === "error") {
            throw new Error(event.error || "خطأ في التحليل");
          }
        }
      }

      setPhase((p) => (p === "streaming" ? (received.trim() ? "done" : "error") : p));
      if (phase !== "done" && !received.trim()) {
        setErrorMsg("لم يصل أي محتوى من النموذج");
        setPhase("error");
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (aborted) {
        setPhase("stopped");
      } else {
        setErrorMsg(err instanceof Error ? err.message : "خطأ غير معروف");
        setPhase("error");
      }
    } finally {
      abortRef.current = null;
    }
  }, [hasRatios, isStreaming, ratioGroups, L1, L2, phase]);

  const copy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* تجاهل */
    }
  }, [content]);

  if (!hasRatios) return null;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-emerald-200/70 bg-gradient-to-l from-emerald-50/80 via-white to-white shadow-sm dark:border-emerald-900/50 dark:from-emerald-950/30 dark:via-slate-900 dark:to-slate-900",
        className
      )}
    >
      {/* الترويسة */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-emerald-100 px-4 py-3 dark:border-emerald-900/40">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-600 to-teal-700 text-white shadow-md shadow-emerald-600/25">
          <BrainCircuit className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-slate-800 dark:text-slate-100">
              التحليل الذكي المعزّز
            </span>
            <Badge className="gap-1 border-0 bg-emerald-600 text-[10px] font-bold text-white hover:bg-emerald-600">
              <Zap className="size-2.5" />
              GLM-5.3-Flash
            </Badge>
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/40 text-[9px] font-semibold text-amber-600 dark:text-amber-400"
              title="تمت الترقية من GLM-5.2"
            >
              <History className="size-2.5" />
              ترقية من {PREVIOUS_MODEL_VERSION}
            </Badge>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
            تحليل تنفيذي شامل للنسب المالية بالذكاء الاصطناعي — أسرع وأدق بعد الترقية
          </p>
        </div>

        {/* أزرار التحكم */}
        <div className="flex items-center gap-1.5">
          {phase === "done" && content && (
            <Button
              variant="ghost"
              size="sm"
              onClick={copy}
              className="h-8 gap-1.5 rounded-full px-2.5 text-[11px] text-slate-600 dark:text-slate-300"
              aria-label="نسخ التحليل"
            >
              {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
              {copied ? "تم النسخ" : "نسخ"}
            </Button>
          )}
          {isStreaming ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={stop}
              className="h-8 gap-1.5 rounded-full px-3 text-[11px]"
              aria-label="إيقاف التوليد"
            >
              <Square className="size-3" />
              إيقاف
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={generate}
              className="h-8 gap-1.5 rounded-full bg-emerald-600 px-3.5 text-[11px] font-bold text-white shadow-sm hover:bg-emerald-700"
              aria-label={phase === "idle" ? "توليد التحليل الذكي" : "إعادة توليد التحليل الذكي"}
            >
              {phase === "idle" ? (
                <>
                  <Sparkles className="size-3.5" />
                  توليد التحليل الذكي
                </>
              ) : (
                <>
                  <RotateCcw className="size-3" />
                  إعادة التوليد
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* منطقة المحتوى */}
      {(phase === "streaming" || phase === "done" || phase === "stopped" || phase === "error") && (
        <div className="px-4 py-3">
          {phase === "error" ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50/60 p-3 dark:border-rose-900/50 dark:bg-rose-950/20">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <div>
                <p className="text-xs font-bold text-rose-700 dark:text-rose-300">فشل توليد التحليل</p>
                <p className="mt-0.5 text-[11px] text-rose-600/90 dark:text-rose-400/80">{errorMsg}</p>
              </div>
            </div>
          ) : (
            <div
              ref={scrollRef}
              className="chat-scrollbar max-h-[420px] overflow-y-auto rounded-lg bg-white/70 p-3 dark:bg-slate-900/40"
              aria-live="polite"
              aria-label="نتيجة التحليل الذكي"
            >
              {content ? (
                <div
                  className={cn(
                    "text-[13px] leading-relaxed text-slate-700 dark:text-slate-200",
                    phase === "streaming" && "streaming-caret"
                  )}
                >
                  <AiMarkdown content={content} />
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400 dark:text-slate-500">
                  <Loader2 className="size-4 animate-spin" />
                  جارٍ تحليل النسب المالية بـ GLM-5.3-Flash…
                </div>
              )}
            </div>
          )}
          {phase === "stopped" && (
            <p className="mt-2 text-[10px] text-amber-600 dark:text-amber-400">
              ⏹ تم إيقاف التوليد — اضغط «إعادة التوليد» للمحاولة من جديد.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── عرض Markdown مبسّط متسق مع هوية النظام ── */
function AiMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
        h1: ({ children }) => (
          <h3 className="mt-3 mb-2 flex items-center gap-1.5 text-sm font-bold text-emerald-800 first:mt-0 dark:text-emerald-300">
            <Sparkles className="size-3.5 shrink-0" />
            {children}
          </h3>
        ),
        h2: ({ children }) => (
          <h3 className="mt-3 mb-2 flex items-center gap-1.5 text-sm font-bold text-emerald-800 first:mt-0 dark:text-emerald-300">
            <Sparkles className="size-3.5 shrink-0" />
            {children}
          </h3>
        ),
        h3: ({ children }) => (
          <h4 className="mt-2.5 mb-1.5 text-[13px] font-bold text-slate-700 first:mt-0 dark:text-slate-200">
            {children}
          </h4>
        ),
        p: ({ children }) => <p className="mb-2 break-words last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 ps-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 ps-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="break-words">{children}</li>,
        strong: ({ children }) => (
          <strong className="font-bold text-slate-900 dark:text-white">{children}</strong>
        ),
        table: ({ children }) => (
          <div className="mb-2 overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-slate-200 bg-slate-50 px-2 py-1 text-start font-bold dark:border-slate-700 dark:bg-slate-800">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-slate-200 px-2 py-1 align-top dark:border-slate-700">{children}</td>
        ),
        hr: () => <hr className="my-3 border-slate-200 dark:border-slate-700" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
