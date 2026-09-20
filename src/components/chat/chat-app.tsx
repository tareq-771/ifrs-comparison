'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '@/hooks/use-toast'
import { DEFAULT_MODEL, getModel } from '@/lib/ai-config'
import { ConversationsSidebar, type ConversationSummary } from './conversations-sidebar'
import { ModelSelector } from './model-selector'
import { MessageList, type ChatMessage } from './message-list'
import { Composer } from './composer'
import { UpgradeBanner } from './upgrade-banner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Zap, List, Sun, Moon, Laptop } from 'lucide-react'
import { useTheme } from 'next-themes'

const MODEL_KEY = 'chat.selectedModel'
const THINKING_KEY = 'chat.thinkingEnabled'
const BANNER_KEY = 'chat.bannerDismissed'

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const cycle = () => {
    if (theme === 'light') setTheme('dark')
    else if (theme === 'dark') setTheme('system')
    else setTheme('light')
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label="تبديل المظهر"
      title="تبديل المظهر (فاتح / داكن / النظام)"
      className="rounded-full"
    >
      {mounted && theme === 'light' && <Sun className="h-4 w-4" />}
      {mounted && theme === 'dark' && <Moon className="h-4 w-4" />}
      {mounted && theme === 'system' && <Laptop className="h-4 w-4" />}
      {!mounted && <span className="h-4 w-4" />}
    </Button>
  )
}

export function ChatApp() {
  const { toast } = useToast()

  // ===== الحالة =====
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [model, setModel] = useState<string>(DEFAULT_MODEL)
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean>(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState(true)

  const abortRef = useRef<AbortController | null>(null)

  // ===== التحميل الأولي =====
  useEffect(() => {
    const savedModel = localStorage.getItem(MODEL_KEY)
    if (savedModel && getModel(savedModel)) setModel(savedModel)
    const savedThinking = localStorage.getItem(THINKING_KEY)
    if (savedThinking !== null) setThinkingEnabled(savedThinking === '1')
    if (localStorage.getItem(BANNER_KEY) === '1') setBannerDismissed(true)
    else setBannerDismissed(false)
  }, [])

  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setConversations(data.conversations ?? [])
    } catch {
      // تجاهل أخطاء الشبكة الصامتة هنا
    }
  }, [])

  useEffect(() => {
    refreshConversations()
  }, [refreshConversations])

  const handleModelChange = (id: string) => {
    setModel(id)
    localStorage.setItem(MODEL_KEY, id)
    toast({
      title: 'تم تغيير النموذج',
      description: `سيتم استخدام ${getModel(id).name} في الرسائل القادمة.`,
    })
  }

  const handleThinkingToggle = (enabled: boolean) => {
    setThinkingEnabled(enabled)
    localStorage.setItem(THINKING_KEY, enabled ? '1' : '0')
  }

  const dismissBanner = () => {
    setBannerDismissed(true)
    localStorage.setItem(BANNER_KEY, '1')
  }

  // ===== فتح محادثة =====
  const openConversation = useCallback(async (id: string) => {
    abortRef.current?.abort()
    setIsStreaming(false)
    try {
      const res = await fetch(`/api/conversations/${id}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('فشل تحميل المحادثة')
      const data = await res.json()
      setActiveId(id)
      setMessages(
        (data.messages ?? []).map((m: ChatMessage) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          thinking: m.thinking ?? undefined,
          model: m.model ?? undefined,
        }))
      )
      if (data.conversation?.model) setModel(data.conversation.model)
      setSidebarOpen(false)
    } catch (err) {
      toast({
        title: 'خطأ',
        description: err instanceof Error ? err.message : 'تعذر فتح المحادثة',
        variant: 'destructive',
      })
    }
  }, [toast])

  // ===== محادثة جديدة =====
  const newConversation = useCallback(() => {
    abortRef.current?.abort()
    setIsStreaming(false)
    setActiveId(null)
    setMessages([])
    setSidebarOpen(false)
  }, [])

  // ===== حذف محادثة =====
  const deleteConversation = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('فشل الحذف')
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (activeId === id) {
        setActiveId(null)
        setMessages([])
      }
      toast({ title: 'تم حذف المحادثة' })
    } catch (err) {
      toast({
        title: 'خطأ',
        description: err instanceof Error ? err.message : 'تعذر حذف المحادثة',
        variant: 'destructive',
      })
    }
  }, [activeId, toast])

  // ===== إرسال رسالة مع بث مباشر =====
  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming) return

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: trimmed }
    const assistantId = `a-${Date.now()}`
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      model,
      pending: true,
    }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setIsStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller

    const updateAssistant = (updater: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? updater(m) : m)))
    }

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: activeId,
          message: trimmed,
          model,
          thinking: thinkingEnabled,
        }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => null)
        throw new Error(errData?.error ?? `فشل الطلب (${res.status})`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const cleaned = line.trim()
          if (!cleaned) continue
          let event: Record<string, unknown>
          try {
            event = JSON.parse(cleaned)
          } catch {
            continue
          }

          if (event.type === 'meta') {
            setActiveId(event.conversationId as string)
            if (event.title) {
              setConversations((prev) => {
                const exists = prev.some((c) => c.id === event.conversationId)
                if (exists) return prev
                return [
                  {
                    id: event.conversationId as string,
                    title: event.title as string,
                    model: (event.model as string) ?? model,
                    updatedAt: new Date().toISOString(),
                    _count: { messages: 2 },
                  },
                  ...prev,
                ]
              })
            }
          } else if (event.type === 'thinking') {
            updateAssistant((m) => ({ ...m, thinking: (m.thinking ?? '') + (event.content as string) }))
          } else if (event.type === 'delta') {
            updateAssistant((m) => ({ ...m, content: m.content + (event.content as string), pending: false }))
          } else if (event.type === 'done') {
            updateAssistant((m) => ({
              ...m,
              id: (event.messageId as string) ?? m.id,
              model: (event.model as string) ?? m.model,
              pending: false,
            }))
          } else if (event.type === 'error') {
            throw new Error(event.error as string)
          }
        }
      }

      updateAssistant((m) => ({ ...m, pending: false }))
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError'
      updateAssistant((m) => ({
        ...m,
        pending: false,
        error: !aborted,
        content:
          m.content ||
          (aborted ? '⏹ تم إيقاف التوليد.' : `⚠️ حدث خطأ: ${err instanceof Error ? err.message : 'غير معروف'}`),
      }))
      if (!aborted) {
        toast({
          title: 'فشل الإرسال',
          description: err instanceof Error ? err.message : 'خطأ غير معروف',
          variant: 'destructive',
        })
      }
    } finally {
      setIsStreaming(false)
      abortRef.current = null
      refreshConversations()
    }
  }, [activeId, isStreaming, model, thinkingEnabled, refreshConversations, toast])

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const regenerate = useCallback(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUser && !isStreaming) {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === lastUser.id)
        return idx >= 0 ? prev.slice(0, idx) : prev
      })
      setTimeout(() => sendMessage(lastUser.content), 50)
    }
  }, [messages, isStreaming, sendMessage])

  const sidebar = (
    <ConversationsSidebar
      conversations={conversations}
      activeId={activeId}
      onNew={newConversation}
      onOpen={openConversation}
      onDelete={deleteConversation}
      currentModel={model}
    />
  )

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* ===== الشريط العلوي ===== */}
      <header className="z-40 shrink-0 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-2 px-3 sm:px-4">
          {/* قائمة المحادثات - موبايل */}
          <div className="md:hidden">
            <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="قائمة المحادثات" className="rounded-full">
                  <List className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-80 p-0">
                <SheetHeader className="sr-only">
                  <SheetTitle>المحادثات</SheetTitle>
                </SheetHeader>
                {sidebar}
              </SheetContent>
            </Sheet>
          </div>

          {/* الشعار والعنوان */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm upgrade-glow">
              <Zap className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="leading-tight">
              <h1 className="text-sm font-bold sm:text-base">مساعد GLM</h1>
              <p className="text-[11px] text-muted-foreground sm:text-xs">
                تم الترقية إلى <span className="font-semibold text-emerald-600 dark:text-emerald-400">GLM-5.3-Flash</span>
              </p>
            </div>
          </div>

          <div className="flex-1" />

          {/* محدد النموذج + المظهر */}
          <ModelSelector value={model} onChange={handleModelChange} disabled={isStreaming} />
          <ThemeToggle />
        </div>
      </header>

      {/* ===== لافتة الترقية ===== */}
      {!bannerDismissed && <UpgradeBanner onDismiss={dismissBanner} />}

      {/* ===== الجسم ===== */}
      <div className="mx-auto flex w-full max-w-7xl min-h-0 flex-1 gap-4 px-3 py-4 sm:px-4">
        {/* الشريط الجانبي - سطح المكتب */}
        <aside className="hidden w-72 shrink-0 md:block">
          <div className="h-full overflow-hidden rounded-xl border bg-card">
            {sidebar}
          </div>
        </aside>

        {/* منطقة المحادثة */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border bg-card">
          <MessageList
            messages={messages}
            isStreaming={isStreaming}
            onRegenerate={regenerate}
            onSuggestionClick={sendMessage}
          />
          <Composer
            onSend={sendMessage}
            onStop={stopStreaming}
            isStreaming={isStreaming}
            modelInfo={getModel(model)}
            thinkingEnabled={thinkingEnabled}
            onThinkingToggle={handleThinkingToggle}
          />
        </main>
      </div>

      {/* ===== التذييل (ثابت أسفل الصفحة) ===== */}
      <footer className="mt-auto shrink-0 border-t bg-background">
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-1 px-4 py-3 text-center text-xs text-muted-foreground sm:flex-row sm:text-start">
          <p>
            يعمل بواسطة{' '}
            <span className="inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
              <Zap className="h-3 w-3" aria-hidden="true" />
              GLM-5.3-Flash
            </span>
          </p>
          <p>
            تمت الترقية من <span className="line-through opacity-70">GLM-5.2</span> — أسرع استجابة ودقة أعلى
          </p>
        </div>
      </footer>
    </div>
  )
}
