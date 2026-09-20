'use client'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sparkles, X, ArrowLeft } from 'lucide-react'
import { PROJECT_MODEL_VERSION, PREVIOUS_MODEL_VERSION } from '@/lib/ai-config'

export function UpgradeBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="border-b bg-emerald-50 dark:bg-emerald-950/40"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-3 py-2.5 sm:px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 leading-snug">
          <p className="flex flex-wrap items-center gap-1.5 text-xs font-semibold sm:text-sm">
            تمت ترقية هذا المشروع إلى {PROJECT_MODEL_VERSION}
            <Badge className="bg-emerald-600 text-[10px] text-white hover:bg-emerald-600">
              جديد
            </Badge>
          </p>
          <p className="mt-0.5 hidden text-xs text-muted-foreground sm:block">
            {PREVIOUS_MODEL_VERSION} سابقًا ← استجابة أسرع، دقة أعلى، ودعم أفضل للعربية.
          </p>
        </div>
        <ArrowLeft className="hidden h-4 w-4 shrink-0 text-emerald-600/60 dark:text-emerald-400/60 sm:block" aria-hidden="true" />
        <Button
          variant="ghost"
          size="icon"
          onClick={onDismiss}
          aria-label="إخفاء إشعار الترقية"
          className="h-8 w-8 shrink-0 rounded-full"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
