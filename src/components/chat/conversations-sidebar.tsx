'use client'

import type { ModelOption } from '@/lib/ai-config'
import { getModel } from '@/lib/ai-config'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Zap, History, MessageSquarePlus, Trash2, MessagesSquare } from 'lucide-react'

export interface ConversationSummary {
  id: string
  title: string
  model: string
  updatedAt: string
  _count?: { messages: number }
}

function ModelDot({ model }: { model: string }) {
  const info: ModelOption = getModel(model)
  if (info.badge === 'upgraded') {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded-full bg-emerald-600/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 dark:text-emerald-400"
        title="مُنشأة بـ GLM-5.3-Flash"
      >
        <Zap className="h-2.5 w-2.5" aria-hidden="true" />
        5.3
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full bg-amber-600/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-700 dark:text-amber-400"
      title="مُنشأة بـ GLM-5.2 (قديم)"
    >
      <History className="h-2.5 w-2.5" aria-hidden="true" />
      5.2
    </span>
  )
}

function formatRelativeDate(iso: string): string {
  try {
    const date = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const minutes = Math.floor(diffMs / 60000)
    if (minutes < 1) return 'الآن'
    if (minutes < 60) return `قبل ${minutes} د`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `قبل ${hours} س`
    const days = Math.floor(hours / 24)
    if (days < 7) return `قبل ${days} أيام`
    return date.toLocaleDateString('ar', { day: 'numeric', month: 'short' })
  } catch {
    return ''
  }
}

export function ConversationsSidebar({
  conversations,
  activeId,
  onNew,
  onOpen,
  onDelete,
  currentModel,
}: {
  conversations: ConversationSummary[]
  activeId: string | null
  onNew: () => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  currentModel: string
}) {
  return (
    <div className="flex h-full max-h-full flex-col">
      <div className="border-b p-3">
        <Button
          onClick={onNew}
          className="w-full gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
          aria-label="بدء محادثة جديدة"
        >
          <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
          محادثة جديدة
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {conversations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <MessagesSquare className="h-8 w-8 text-muted-foreground/40" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">لا توجد محادثات بعد</p>
            <p className="text-[10px] text-muted-foreground/70">
              ابدأ أول محادثة مع {getModel(currentModel).name}
            </p>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-1 p-2">
              {conversations.map((conv) => {
                const isActive = conv.id === activeId
                return (
                  <div
                    key={conv.id}
                    role="button"
                    tabIndex={0}
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => onOpen(conv.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onOpen(conv.id)
                      }
                    }}
                    className={`group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-start transition-colors ${
                      isActive
                        ? 'bg-emerald-600/10 text-foreground ring-1 ring-emerald-600/30'
                        : 'hover:bg-accent'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold" title={conv.title}>
                        {conv.title}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {formatRelativeDate(conv.updatedAt)}
                      </p>
                    </div>
                    <ModelDot model={conv.model} />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`حذف محادثة: ${conv.title}`}
                      className="h-6 w-6 shrink-0 rounded-full opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(conv.id)
                      }}
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </Button>
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}
