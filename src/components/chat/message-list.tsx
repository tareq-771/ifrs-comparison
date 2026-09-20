'use client'

import { useEffect, useRef } from 'react'
import { MessageBubble, type ChatMessage } from './message-bubble'
import { getModel } from '@/lib/ai-config'
import { Button } from '@/components/ui/button'
import { Zap, RotateCcw, Brain, ShieldCheck, Gauge } from 'lucide-react'

const SUGGESTIONS = [
  { icon: Brain, title: 'اشرح لي فكرة', text: 'اشرح لي كيف تعمل نماذج الذكاء الاصطناعي اللغوية بأسلوب مبسط.' },
  { icon: Gauge, title: 'قارن الأداء', text: 'ما الفرق بين GLM-5.3-Flash و GLM-5.2 من حيث السرعة والدقة؟' },
  { icon: Zap, title: 'اكتب لي كودًا', text: 'اكتب دالة TypeScript لترتيب مصفوفة كائنات حسب تاريخ.' },
  { icon: ShieldCheck, title: 'لخّص نصًا', text: 'لخّص لي أهم مميزات استخدام النماذج السريعة في التطبيقات الواقعية.' },
]

function WelcomeScreen({ onSuggestionClick }: { onSuggestionClick: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-lg upgrade-glow">
        <Zap className="h-8 w-8" aria-hidden="true" />
      </div>
      <div className="space-y-2">
        <h2 className="text-xl font-bold sm:text-2xl">مرحبًا بك في مساعد GLM-5.3-Flash</h2>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">
          تمت ترقية المشروع بنجاح من GLM-5.2 إلى الإصدار الأحدث والأسرع.
          اكتب سؤالك أو اختر أحد الاقتراحات للبدء.
        </p>
      </div>
      <div className="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            onClick={() => onSuggestionClick(s.text)}
            className="group flex items-start gap-3 rounded-xl border bg-background p-3 text-start transition-all hover:border-emerald-600/40 hover:bg-emerald-600/5 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={s.title}
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-600/10 text-emerald-700 transition-colors group-hover:bg-emerald-600 group-hover:text-white dark:text-emerald-400">
              <s.icon className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold">{s.title}</p>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{s.text}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export function MessageList({
  messages,
  isStreaming,
  onRegenerate,
  onSuggestionClick,
}: {
  messages: ChatMessage[]
  isStreaming: boolean
  onRegenerate: () => void
  onSuggestionClick: (text: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const shouldAutoScroll = useRef(true)

  // تتبع ما إذا كان المستخدم في أسفل القائمة
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    shouldAutoScroll.current = distanceFromBottom < 120
  }

  useEffect(() => {
    if (shouldAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [messages])

  const lastMessage = messages[messages.length - 1]
  const showRegenerate =
    !isStreaming && lastMessage?.role === 'assistant' && lastMessage.content.length > 0

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="chat-scrollbar min-h-0 flex-1 overflow-y-auto"
      aria-live="polite"
      aria-label="سجل المحادثة"
    >
      {messages.length === 0 ? (
        <WelcomeScreen onSuggestionClick={onSuggestionClick} />
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-3 py-5 sm:px-4">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {showRegenerate && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={onRegenerate}
                className="gap-1.5 rounded-full text-xs"
                aria-label="إعادة توليد الرد"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                إعادة التوليد
              </Button>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
