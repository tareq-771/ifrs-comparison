"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { normalizeName } from "@/lib/accounts";
import { cn } from "@/lib/utils";

export interface AccountOption {
  /** Normalized key — the emitted value. */
  nk: string;
  /** Display name. */
  nm: string;
  /** Optional account number (enables search by number). */
  num?: string | null;
}

/**
 * Arabic-aware account search: matches the normalized account name
 * (ignoring hamza/taa-marbuta/diacritics) or the digits of the account number.
 */
export function filterAccounts(options: AccountOption[], query: string): AccountOption[] {
  const q = query.trim();
  if (!q) return options;
  const nq = normalizeName(q);
  const digits = q.replace(/\D/g, "");
  return options.filter((o) => {
    if (nq && normalizeName(o.nm).indexOf(nq) >= 0) return true;
    if (digits && o.num && o.num.indexOf(digits) >= 0) return true;
    return false;
  });
}

/**
 * Searchable single-select combobox for accounts (used for «حساب صافي الإيرادات»).
 * Replaces the plain Select so users can search a long chart of accounts
 * by name or number instead of scrolling.
 */
export function AccountSelect({
  value,
  onValueChange,
  options,
  disabled,
  placeholder = "— اختر الحساب —",
}: {
  value: string | null;
  onValueChange: (v: string) => void;
  options: AccountOption[];
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const selected = React.useMemo(
    () => options.find((o) => o.nk === value) ?? null,
    [options, value]
  );
  const filtered = React.useMemo(() => filterAccounts(options, query), [options, query]);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          title={selected?.nm ?? placeholder}
          className="h-9 w-full justify-between gap-2 px-3 font-normal"
        >
          <span className={cn("truncate text-sm", !selected && "text-muted-foreground")}>
            {selected ? selected.nm : placeholder}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] space-y-2 p-2"
      >
        <div className="relative">
          <Search
            className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث بالاسم أو الرقم…"
            className="h-8 pr-8 text-sm"
          />
        </div>
        <div className="scroll-thin max-h-64 overflow-y-auto overscroll-contain rounded-md border border-slate-200 dark:border-slate-700">
          {options.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">لا توجد حسابات — ارفع الملفات أولاً</p>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">لا توجد حسابات مطابقة لـ «{query.trim()}»</p>
          ) : (
            filtered.map((o) => (
              <button
                key={o.nk}
                type="button"
                onClick={() => {
                  onValueChange(o.nk);
                  setOpen(false);
                  setQuery("");
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-right text-sm transition-colors hover:bg-slate-100 dark:hover:bg-slate-800",
                  o.nk === value && "bg-emerald-50 dark:bg-emerald-950/30"
                )}
              >
                {o.num ? (
                  <span
                    dir="ltr"
                    className="tnum shrink-0 rounded bg-slate-100 px-1 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                  >
                    {o.num}
                  </span>
                ) : null}
                <span className="truncate">{o.nm}</span>
                {o.nk === value && (
                  <Check className="ms-auto size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                )}
              </button>
            ))
          )}
        </div>
        <p className="text-[10px] text-slate-400 dark:text-slate-500">
          {filtered.length} من {options.length} حساب
        </p>
      </PopoverContent>
    </Popover>
  );
}
