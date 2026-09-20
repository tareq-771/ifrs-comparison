'use client'

import { AVAILABLE_MODELS, getModel, type ModelOption } from '@/lib/ai-config'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { Check, ChevronDown, Zap, History } from 'lucide-react'

function ModelBadge({ option }: { option: ModelOption }) {
  if (option.badge === 'upgraded') {
    return (
      <Badge className="gap-1 bg-emerald-600 text-[10px] text-white hover:bg-emerald-600">
        <Zap className="h-2.5 w-2.5" aria-hidden="true" />
        مُفعّل
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1 border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400">
      <History className="h-2.5 w-2.5" aria-hidden="true" />
      قديم
    </Badge>
  )
}

export function ModelSelector({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const current = getModel(value)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`النموذج الحالي: ${current.name}`}
          className="h-9 gap-1.5 rounded-full px-3"
        >
          {current.badge === 'upgraded' ? (
            <Zap className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          ) : (
            <History className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          )}
          <span className="hidden text-xs font-semibold sm:inline">{current.name}</span>
          <span className="text-xs font-semibold sm:hidden">النموذج</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-50" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          اختيار نموذج المحادثة
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {AVAILABLE_MODELS.map((option) => (
          <DropdownMenuItem
            key={option.id}
            onClick={() => onChange(option.id)}
            className={`flex cursor-pointer flex-col items-start gap-1 py-2.5 ${
              option.id === value ? 'bg-accent' : ''
            }`}
            aria-label={`اختيار ${option.name}`}
          >
            <div className="flex w-full items-center gap-2">
              <span className="text-sm font-bold">{option.name}</span>
              <ModelBadge option={option} />
              {option.id === value && (
                <Check className="ms-auto h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{option.description}</p>
            <span className="text-[10px] font-medium text-muted-foreground/80">{option.speedLabel}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-center text-[10px] text-muted-foreground">
          الترقية الأخيرة: GLM-5.2 ← GLM-5.3-Flash
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
