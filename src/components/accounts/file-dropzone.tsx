"use client";

import { useRef, useState } from "react";
import { Upload, FileSpreadsheet, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type FileStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; count: number; filename: string }
  | { kind: "error"; message: string };

interface FileDropzoneProps {
  status: FileStatus;
  onFile: (file: File) => void;
  accent: "emerald" | "amber";
}

const accentMap = {
  emerald: {
    border: "border-emerald-300 hover:border-emerald-400 dark:border-emerald-800 dark:hover:border-emerald-700",
    bg: "bg-emerald-50/60 dark:bg-emerald-950/20",
    icon: "text-emerald-600 dark:text-emerald-400",
    ring: "focus-visible:ring-emerald-400/40",
  },
  amber: {
    border: "border-amber-300 hover:border-amber-400 dark:border-amber-800 dark:hover:border-amber-700",
    bg: "bg-amber-50/60 dark:bg-amber-950/20",
    icon: "text-amber-600 dark:text-amber-400",
    ring: "focus-visible:ring-amber-400/40",
  },
};

export function FileDropzone({ status, onFile, accent }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const a = accentMap[accent];

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      className={cn(
        "group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-5 text-center transition-colors",
        a.border,
        a.bg,
        dragOver && "border-solid ring-2",
        a.ring,
        "focus:outline-none focus-visible:ring-2"
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />

      {status.kind === "loading" ? (
        <>
          <Loader2 className={cn("size-6 animate-spin", a.icon)} />
          <span className="text-sm text-slate-600 dark:text-slate-300">
            جارٍ قراءة الملف…
          </span>
        </>
      ) : status.kind === "ok" ? (
        <>
          <div className="flex size-10 items-center justify-center rounded-lg bg-white shadow-sm dark:bg-slate-800">
            <FileSpreadsheet className={cn("size-6", a.icon)} />
          </div>
          <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <CheckCircle2 className="size-4 text-emerald-500" />
            <span className="max-w-[12rem] truncate" title={status.filename}>
              {status.filename}
            </span>
          </div>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {status.count} حساب
          </span>
        </>
      ) : status.kind === "error" ? (
        <>
          <XCircle className="size-6 text-rose-500" />
          <span className="text-sm font-medium text-rose-600 dark:text-rose-400">
            {status.message}
          </span>
        </>
      ) : (
        <>
          <Upload className={cn("size-6 transition-transform group-hover:scale-110", a.icon)} />
          <span className="text-sm font-medium text-slate-600 dark:text-slate-300">
            اختر ملف Excel أو اسحبه هنا
          </span>
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            xlsx / xls
          </span>
        </>
      )}
    </div>
  );
}
