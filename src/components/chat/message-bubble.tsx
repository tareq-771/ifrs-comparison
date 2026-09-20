'use client'

import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { getModel } from '@/lib/ai-config'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Zap, History, Brain, ChevronDown, Sparkles, User, Loader2 } from 'lucide-react'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  model?: string
  pending?: boolean
  error?: boolean
}

function ModelTag({ model }: { model?: string }) {
  if (!model) return null
  const info = getModel(model)
  if (info.badge === 'upgraded') {
    return (
      <Badge className="gap-1 bg-emerald-600/10 text-[9px] font-bold text-emerald-700 hover:bg-emerald-600/10 dark:text-emerald-400">
        <Zap className="h-2.5 w-2.5" aria-hidden="true" />
        GLM-5.3-Flash
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 border-amber-500/40 text-[9px] font-bold text-amber-600 dark:text-amber-400">
      <History className="h-2.5 w-2.5" aria-hidden="true" />
      GLM-5.2
    </Badge>
  )
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const isUser = message.role === 'user'
  const isStreamingEmpty = !isUser && message.pending && message.content.length === 0

  return (
    <div className={`message-in flex w-full gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* الصورة الرمزية */}
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full shadow-sm ${
          isUser
            ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'
            : 'bg-emerald-600 text-white'
        }`}
        aria-hidden="true"
      >
        {isUser ? (
          <User className="h-4 w-4" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
      </div>

      {/* المحتوى */}
      <div className={`flex min-w-0 max-w-[85%] flex-col gap-1.5 sm:max-w-[75%] ${isUser ? 'items-end' : 'items-start'}`}>
        {/* سطر البيانات الوصفية */}
        <div className="flex items-center gap-1.5 px-1">
          <span className="text-[10px] font-semibold text-muted-foreground">
            {isUser ? 'أنت' : 'المساعد'}
          </span>
          {!isUser && <ModelTag model={message.model} />}
        </div>

        {/* سلسلة التفكير (للمساعد فقط) */}
        {!isUser && message.thinking && message.thinking.trim().length > 0 && (
          <Collapsible open={thinkingOpen} onOpenChange={setThinkingOpen} className="w-full">
            <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-muted">
              <Brain className="h-3 w-3" aria-hidden="true" />
              سلسلة التفكير
              <ChevronDown
                className={`h-3 w-3 transition-transform ${thinkingOpen ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="chat-scrollbar mt-1.5 max-h-48 overflow-y-auto rounded-lg border border-dashed bg-muted/30 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                {message.thinking}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* الفقاعة */}
        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
            isUser
              ? 'rounded-ts-sm bg-primary text-primary-foreground'
              : message.error
                ? 'rounded-te-sm border border-destructive/30 bg-destructive/5 text-foreground'
                : 'rounded-te-sm border bg-background'
          }`}
        >
          {isStreamingEmpty ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              <span className="text-xs">يكتب الآن…</span>
            </span>
          ) : isUser ? (
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          ) : (
            <div className="prose-chat">
              <ReactMarkdown
                components={{
                  p: ({ children }) => <p className="mb-2 break-words last:mb-0">{children}</p>,
                  ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 ps-5 last:mb-0">{children}</ul>,
                  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 ps-5 last:mb-0">{children}</ol>,
                  li: ({ children }) => <li className="break-words">{children}</li>,
                  h1: ({ children }) => <h1 className="mb-2 text-base font-bold last:mb-0">{children}</h1>,
                  h2: ({ children }) => <h2 className="mb-2 text-sm font-bold last:mb-0">{children}</h2>,
                  h3: ({ children }) => <h3 className="mb-1 text-sm font-semibold last:mb-0">{children}</h3>,
                  strong: ({ children }) => <strong className="font-bold">{children}</strong>,
                  em: ({ children }) => <em>{children}</em>,
                  a: ({ children, href }) => (
                    <a href={href} target="_blank" rel="noreferrer" className="font-semibold text-emerald-700 underline underline-offset-2 dark:text-emerald-400">
                      {children}
                    </a>
                  ),
                  blockquote: ({ children }) => (
                    <blockquote className="mb-2 border-s-2 border-emerald-600/40 ps-3 italic text-muted-foreground last:mb-0">
                      {children}
                    </blockquote>
                  ),
                  code: ({ className, children, ...props }) => {
                    const isBlock = /language-/.test(className ?? '')
                    if (isBlock) {
                      return (
                        <code className={`${className ?? ''} block whitespace-pre break-words font-mono text-xs`} {...props}>
                          {children}
                        </code>
                      )
                    }
                    return (
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]" {...props}>
                        {children}
                      </code>
                    )
                  },
                  pre: ({ children }) => (
                    <pre className="chat-scrollbar mb-2 overflow-x-auto rounded-lg bg-zinc-900 p-3 text-zinc-100 last:mb-0" dir="ltr">
                      {children}
                    </pre>
                  ),
                  hr: () => <hr className="my-2 border-border" />,
                }}
              >
                {message.content + (message.pending && message.content ? '▍' : '')}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
