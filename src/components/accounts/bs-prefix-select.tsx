"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScanSearch, Search, X } from "lucide-react";
import type { AccountRow } from "@/lib/accounts";
import { normalizeName } from "@/lib/accounts";
import { cn } from "@/lib/utils";

interface BsPrefixSelectProps {
  id: string;
  label: string;
  /**
   * Comma-separated string of selected prefixes (e.g. "11,13").
   * Backward compatible with old single-value strings ("11").
   */
  value: string;
  onChange: (v: string) => void;
  /** Accounts from the BS file (used to populate the searchable picker). */
  accounts: AccountRow[];
  placeholder?: string;
}

/**
 * Split a CSV-style string into a clean list of prefixes.
 * Handles commas, spaces, Arabic comma (،), semicolons.
 */
function splitPrefixes(csv: string): string[] {
  if (!csv) return [];
  return csv
    .split(/[\s,،;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinPrefixes(list: string[]): string {
  return list.join(",");
}

/**
 * Multi-value prefix selector with chips + searchable dropdown.
 *
 * - User can type a prefix and press Enter / comma / Tab to commit it as a chip
 * - A searchable dropdown (button on the end side) lists all parent accounts —
 *   search by account name (Arabic-aware) or by number, click to add a chip.
 *   The dropdown stays open for adding several prefixes in one go.
 * - Each chip is removable via its × button
 * - Multiple parent accounts supported (e.g. "11" + "13" → both matched)
 * - The emitted value is a comma-separated string for backward compatibility
 *   with the existing BalanceSheetSettings schema.
 */
export function BsPrefixSelect({ id, label, value, onChange, accounts, placeholder = "—" }: BsPrefixSelectProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  // Build the account list — only parent (main) accounts that have children.
  const suggestions = React.useMemo(() => {
    if (!accounts.length) return [];
    const nums = accounts.map((a) => a.num).filter(Boolean) as string[];
    const result: { num: string; nm: string }[] = [];
    for (const a of accounts) {
      if (!a.num) continue;
      const isParent = nums.some(
        (n) => n !== a.num && n.length > a.num.length && n.startsWith(a.num)
      );
      if (isParent) result.push({ num: a.num!, nm: a.nm });
    }
    return result.sort((a, b) => a.num.localeCompare(b.num));
  }, [accounts]);

  // Quick lookup: number → name (for chip tooltips & matched-name hints)
  const nameByNum = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const s of suggestions) m.set(s.num, s.nm);
    return m;
  }, [suggestions]);

  const selected = splitPrefixes(value);
  // De-duplicate while preserving order
  const uniqSelected = React.useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of selected) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }, [selected]);

  // Hide the current chips' values from the picker list to avoid duplicates
  const visibleSuggestions = React.useMemo(
    () => suggestions.filter((s) => !uniqSelected.includes(s.num)),
    [suggestions, uniqSelected]
  );

  // Search filter — Arabic-aware name match + digit match on the account number
  const filteredSuggestions = React.useMemo(() => {
    const q = query.trim();
    if (!q) return visibleSuggestions;
    const nq = normalizeName(q);
    const digits = q.replace(/\D/g, "");
    return visibleSuggestions.filter((s) => {
      if (nq && normalizeName(s.nm).indexOf(nq) >= 0) return true;
      if (digits && s.num.indexOf(digits) >= 0) return true;
      return false;
    });
  }, [visibleSuggestions, query]);

  function commitDraft() {
    const parts = splitPrefixes(draft);
    if (parts.length === 0) return;
    const merged = new Set<string>(uniqSelected);
    for (const p of parts) merged.add(p);
    onChange(joinPrefixes(Array.from(merged)));
    setDraft("");
  }

  function addPrefix(p: string) {
    const merged = new Set<string>(uniqSelected);
    merged.add(p);
    onChange(joinPrefixes(Array.from(merged)));
  }

  function removeChip(p: string) {
    onChange(joinPrefixes(uniqSelected.filter((x) => x !== p)));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "," || e.key === "،" || e.key === "Tab") {
      if (draft.trim()) {
        if (e.key === "Tab") e.preventDefault();
        e.preventDefault();
        commitDraft();
      }
    } else if (e.key === "Backspace" && draft === "" && uniqSelected.length > 0) {
      e.preventDefault();
      removeChip(uniqSelected[uniqSelected.length - 1]);
    }
  }

  // Auto-commit when user types a separator (e.g. pasting "11,13")
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    const parts = splitPrefixes(v);
    if (parts.length > 1 || /[\s,،;]$/.test(v)) {
      const merged = new Set<string>(uniqSelected);
      for (const p of parts) merged.add(p);
      onChange(joinPrefixes(Array.from(merged)));
      setDraft("");
      return;
    }
    setDraft(v);
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
        {label}
      </Label>

      {/* Chips + input + search picker */}
      <div className="flex items-stretch">
        <div
          className={cn(
            "flex min-h-[34px] min-w-0 flex-1 flex-wrap items-center gap-1 rounded-md rounded-e-none border border-slate-300 bg-white px-1.5 py-1",
            "text-[11px] shadow-sm focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20",
            "dark:border-slate-700 dark:bg-slate-900"
          )}
          onClick={() => inputRef.current?.focus()}
        >
          {uniqSelected.map((p) => {
            const nm = nameByNum.get(p);
            return (
              <span
                key={p}
                title={nm || "بادئة غير معروفة"}
                className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
              >
                <span dir="ltr" className="tnum">{p}</span>
                {nm && <span className="max-w-[7rem] truncate opacity-70" title={nm}>· {nm}</span>}
                <button
                  type="button"
                  aria-label={`إزالة ${p}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeChip(p);
                  }}
                  className="rounded-sm p-0.5 hover:bg-emerald-200 dark:hover:bg-emerald-800/60"
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}

          <Input
            ref={inputRef}
            id={id}
            value={draft}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={() => draft.trim() && commitDraft()}
            className="tnum h-7 min-w-[3rem] flex-1 border-0 bg-transparent p-0 text-[11px] shadow-none focus-visible:ring-0"
            dir="ltr"
            placeholder={uniqSelected.length === 0 ? placeholder : "+"}
            autoComplete="off"
          />
        </div>

        {/* Searchable account picker */}
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) setQuery("");
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="بحث عن حساب"
              title="بحث عن حساب بالاسم أو الرقم"
              disabled={suggestions.length === 0}
              className={cn(
                "flex w-[30px] shrink-0 items-center justify-center rounded-md rounded-s-none border border-s-0 border-slate-300 bg-white text-slate-400 transition-colors",
                "hover:bg-emerald-50 hover:text-emerald-600 disabled:cursor-not-allowed disabled:opacity-40",
                "dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-400",
                open && "border-emerald-500 text-emerald-600 dark:text-emerald-400"
              )}
            >
              <ScanSearch className="size-3.5" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 space-y-2 p-2">
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
            <div className="scroll-thin max-h-56 overflow-y-auto overscroll-contain rounded-md border border-slate-200 dark:border-slate-700">
              {suggestions.length === 0 ? (
                <p className="py-5 text-center text-xs text-slate-400">لا توجد حسابات — ارفع ملف المركز المالي أولاً</p>
              ) : visibleSuggestions.length === 0 ? (
                <p className="py-5 text-center text-xs text-slate-400">تمت إضافة جميع الحسابات الرئيسية</p>
              ) : filteredSuggestions.length === 0 ? (
                <p className="py-5 text-center text-xs text-slate-400">لا توجد حسابات مطابقة لـ «{query.trim()}»</p>
              ) : (
                filteredSuggestions.map((a) => (
                  <button
                    key={a.num}
                    type="button"
                    onClick={() => addPrefix(a.num)}
                    title={a.nm}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-right text-sm transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <span
                      dir="ltr"
                      className="tnum shrink-0 rounded bg-slate-100 px-1 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                    >
                      {a.num}
                    </span>
                    <span className="truncate">{a.nm}</span>
                  </button>
                ))
              )}
            </div>
            <p className="text-[10px] text-slate-400 dark:text-slate-500">
              اضغط على الحساب لإضافته كبادئة · {filteredSuggestions.length} من {suggestions.length} حساب رئيسي
            </p>
          </PopoverContent>
        </Popover>
      </div>

      {/* Helper line: hint when empty, count when multiple selected */}
      <p className="truncate text-[10px] text-slate-400 dark:text-slate-500">
        {uniqSelected.length === 0
          ? "تلقائي بالاسم"
          : uniqSelected.length === 1
            ? (nameByNum.get(uniqSelected[0]) ?? "بادئة مخصصة")
            : `${uniqSelected.length} بادئات محددة`}
      </p>
    </div>
  );
}
