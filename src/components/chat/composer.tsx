'use client'

import { useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Toggle } from '@/components/ui/toggle'
import type { ModelOption } from '@/lib/ai-config'
import { ArrowUp, Square, Brain } from 'lucide-react'

export function Composer({
  onSend,
  onStop,
  isStreaming,
  modelInfo,
  thinkingEnabled,
  onThinkingToggle,
}: {
  onSend: (text: string) => void
  onStop: () => void
  isStreaming: boolean
  modelInfo: ModelOption
  thinkingEnabled: boolean
  onThinkingToggle: (enabled: boolean) => void
}) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [])

  const submit = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed || isStreaming) return
    onSend(trimmed)
    setValue('')
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    })
  }, [value, isStreaming, onSend])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="border-t bg-card p-3 sm:p-4">
      <div className="mx-auto max-w-3xl">
        {/* أزرار الخيارات */}
        <div className="mb-2 flex items-center gap-2">
          <Toggle
            size="sm"
            pressed={thinkingEnabled}
            onPressedChange={onThinkingToggle}
            aria-label="تفعيل وضع التفكير المتسلسل"
            className="h-7 gap-1.5 rounded-full px-2.5 text-[11px] data-[state=on]:bg-emerald-600/10 data-[state=on]:text-emerald-700 dark:data-[state=on]:text-emerald-400"
          >
            <Brain className="h-3 w-3" aria-hidden="true" />
            وضع التفكير
          </Toggle>
          <span className="text-[10px] text-muted-foreground">
            {modelInfo.speedLabel} • {modelInfo.name}
          </span>
        </div>

        {/* حقل الإدخال */}
        <div className="flex items-end gap-2 rounded-2xl border bg-background p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring">
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              adjustHeight()
            }}
            onKeyDown={handleKeyDown}
            placeholder="اكتب رسالتك هنا… (Enter للإرسال، Shift+Enter لسطر جديد)"
            aria-label="نص الرسالة"
            className="max-h-40 min-h-[44px] flex-1 resize-none border-0 bg-transparent px-2 py-2.5 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            rows={1}
            disabled={isStreaming}
          />
          {isStreaming ? (
            <Button
              size="icon"
              onClick={onStop}
              aria-label="إيقاف التوليد"
              className="h-11 w-11 shrink-0 rounded-xl bg-destructive text-white hover:bg-destructive/90"
            >
              <Square className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={submit}
              disabled={!value.trim()}
              aria-label="إرسال الرسالة"
              className="h-11 w-11 shrink-0 rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              <ArrowUp className="h-5 w-5" aria-hidden="true" />
            </Button>
          )}
        </div>

        <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
          قد يرتكز المساعد أحيانًا على معلومات غير دقيقة — تحقق من المعلومات المهمة.
        </p>
      </div>
    </div>
  )
}
