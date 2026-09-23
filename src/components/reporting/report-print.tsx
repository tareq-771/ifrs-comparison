"use client";

// 6.8 — طبقة الطباعة الموحدة (Print Foundation) — reusable لكل التقارير الحالية والمستقبلية.
// المبدأ: طباعة المتصفح/CSS حصرًا في هذه المرحلة — بلا مكتبات PDF جديدة.
// الآلية: منفذ طباعة واحد (#print-root) يُملأ بنسخة HTML من منطقة التقرير عند beforeprint،
// ويُخفى كل ما عدا المنفذ عبر @media print — يعمل داخل الحوارات والتبويبات على حد سواء.
// الدقة: لا تلمس الأرقام إطلاقًا — النسخ نصي من DOM المُصيَّر (formatMinor يبقى نصًا BigInt).

import * as React from "react";
import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ReportHeaderMeta, ReportStatusKind } from "@/lib/report-header";
import { REPORT_STATUS_LABELS } from "@/lib/report-header";

/* ── سجل منطقة الطباعة النشطة (آخر PrintableReport مُصيَّر) ── */

let activePrintArea: HTMLElement | null = null;
let darkModeWasActive = false;
let titleWasOverridden = false;
let previousTitle = "";

export function setActivePrintArea(el: HTMLElement | null): void {
  activePrintArea = el;
}

function ensurePortal(): HTMLElement {
  let portal = document.getElementById("print-root");
  if (!portal) {
    portal = document.createElement("div");
    portal.id = "print-root";
    portal.setAttribute("dir", "rtl");
    portal.setAttribute("lang", "ar");
    document.body.appendChild(portal);
  }
  return portal;
}

function fillPrintPortal(): void {
  const area =
    activePrintArea ??
    (document.querySelector(".print-area") as HTMLElement | null);
  if (!area) return;
  const portal = ensurePortal();
  portal.innerHTML = area.innerHTML;
  document.documentElement.setAttribute("data-print-active", "1");
}

function clearPrintPortal(): void {
  const portal = document.getElementById("print-root");
  if (portal) portal.innerHTML = "";
  document.documentElement.removeAttribute("data-print-active");
}

/** إدارة عنصر @page للاتجاه — Chrome/Edge يدعمان size: A4 portrait/landscape. */
function applyOrientationStyle(orientation: "portrait" | "landscape"): void {
  let style = document.getElementById("print-page-orientation") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "print-page-orientation";
    document.head.appendChild(style);
  }
  const margin = orientation === "landscape" ? "12mm 10mm" : "14mm 12mm";
  style.textContent = `@page { size: A4 ${orientation}; margin: ${margin}; }`;
}

/** حفظ/استعادة عنوان المستند (يفيد كاسم ملف PDF وترويسة المتصفح). */
function overrideTitle(title: string): void {
  if (titleWasOverridden) return;
  previousTitle = document.title;
  document.title = title;
  titleWasOverridden = true;
}

function restoreTitle(): void {
  if (!titleWasOverridden) return;
  document.title = previousTitle;
  titleWasOverridden = false;
}

let globalListenersInstalled = false;

/** مستمعو الطباعة العموميون — يُثبَّتون مرة واحدة (يغطي حتى Ctrl+P الأصلي). */
function installGlobalPrintListeners(): void {
  if (globalListenersInstalled || typeof window === "undefined") return;
  globalListenersInstalled = true;
  window.addEventListener("beforeprint", () => {
    darkModeWasActive = document.documentElement.classList.contains("dark");
    if (darkModeWasActive) document.documentElement.classList.remove("dark");
    fillPrintPortal();
  });
  window.addEventListener("afterprint", () => {
    clearPrintPortal();
    restoreTitle();
    if (darkModeWasActive) document.documentElement.classList.add("dark");
    darkModeWasActive = false;
  });
}

export type PrintOrientation = "portrait" | "landscape";

interface PrintContextValue {
  orientation: PrintOrientation;
  documentTitle: string;
}

const PrintContext = React.createContext<PrintContextValue | null>(null);

/**
 * زر «طباعة / حفظ PDF» — يعمل ضمن PrintableReport (سياق) أو مستقلًا يطبع أول .print-area ظاهرة.
 * يحمل no-print فلا يُطبع نفسه أبدًا.
 */
export function PrintButton({
  orientation = "portrait",
  documentTitle,
  label = "طباعة / حفظ PDF",
  size = "sm",
  className,
  disabled = false,
  title,
}: {
  orientation?: PrintOrientation;
  documentTitle?: string;
  label?: string;
  size?: "sm" | "default" | "xs";
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const ctx = React.useContext(PrintContext);
  const effectiveOrientation = ctx?.orientation ?? orientation;
  const effectiveTitle = ctx?.documentTitle ?? documentTitle ?? "تقرير — نظام التقارير المالية الموحدة";

  React.useEffect(() => {
    installGlobalPrintListeners();
  }, []);

  const onPrint = React.useCallback(() => {
    if (disabled) return;
    applyOrientationStyle(effectiveOrientation);
    overrideTitle(effectiveTitle);
    darkModeWasActive = document.documentElement.classList.contains("dark");
    if (darkModeWasActive) document.documentElement.classList.remove("dark");
    fillPrintPortal(); // أمان إضافي إن لم يُطلق المتصفح beforeprint
    try {
      window.print();
    } finally {
      // afterprint سيتكفل بالتنظيف في Chrome/Edge؛ هنا احتياط للمتصفحات الأخرى
      window.setTimeout(() => {
        clearPrintPortal();
        restoreTitle();
        if (darkModeWasActive) document.documentElement.classList.add("dark");
        darkModeWasActive = false;
      }, 800);
    }
  }, [disabled, effectiveOrientation, effectiveTitle]);

  const sizeClass =
    size === "xs" ? "h-7 px-2 text-[11px]" : size === "sm" ? "h-8 px-3 text-xs" : "";
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onPrint}
      title={title ?? `${label} (A4 ${effectiveOrientation === "landscape" ? "أفقي" : "رأسي"})`}
      aria-label={label}
      className={cn("no-print gap-1.5 print:hidden", sizeClass, className)}
    >
      <Printer className="size-3.5" aria-hidden="true" />
      {label}
    </Button>
  );
}

/** شارة حالة التقرير — نفس الألوان على الشاشة وفي الطباعة (print-color-adjust: exact). */
export function ReportStatusBadge({ status, label }: { status: ReportStatusKind; label?: string }) {
  const styles: Record<ReportStatusKind, string> = {
    DRAFT: "bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-950/60 dark:text-sky-300 dark:border-sky-900",
    APPROVED: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-900",
    PRELIMINARY: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900",
    INCOMPLETE_DATA: "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-900",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-bold",
        styles[status],
      )}
      data-report-status={status}
    >
      {label ?? REPORT_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * الترويسة الموحدة للتقارير — تُعرض على الشاشة وتُطبع كما هي.
 * كل الحقول من meta المبني عبر buildReportHeaderMeta — بلا hard-code.
 */
export function ReportHeader({ meta, compact = false }: { meta: ReportHeaderMeta; compact?: boolean }) {
  return (
    <header
      className="report-header rounded-xl border border-slate-300 bg-white p-4 text-slate-900 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100"
      data-report-header="1"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">{meta.systemName}</p>
          <h3 className={cn("mt-0.5 font-extrabold leading-tight", compact ? "text-base" : "text-lg")}>
            {meta.reportTitle}
          </h3>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
            <span className="font-semibold">{meta.companyName}</span>
            {meta.companyCode !== "—" && <span className="tnum"> ({meta.companyCode})</span>}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-[11px] text-slate-500 dark:text-slate-400">
          <ReportStatusBadge status={meta.status} label={meta.statusLabel} />
          <span>طُبع: <span className="tnum" dir="ltr">{meta.printedAtLabel}</span></span>
        </div>
      </div>
      <div className="mt-3 grid gap-1 border-t border-dashed border-slate-300 pt-2 text-[11px] text-slate-600 dark:border-slate-700 dark:text-slate-300 sm:grid-cols-2 lg:grid-cols-4">
        <p><span className="font-semibold">السنة المالية:</span> <span className="tnum" dir="ltr">{meta.fiscalYearCode}{meta.fiscalYearLabel ? ` (${meta.fiscalYearLabel})` : ""}</span></p>
        <p><span className="font-semibold">الفترة/المدى:</span> <span className="tnum" dir="ltr">{meta.periodLine}</span></p>
        {meta.currency !== "—" && meta.currency !== "" && (
          <p><span className="font-semibold">العملة:</span> {meta.currency}</p>
        )}
        {meta.dataTypeLabel && (
          <p><span className="font-semibold">نوع البيانات:</span> {meta.dataTypeLabel}</p>
        )}
      </div>
      {meta.statusNotice && (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] leading-5 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {meta.statusNotice}
        </p>
      )}
    </header>
  );
}

/**
 * غلاف منطقة التقرير القابلة للطباعة — يسجل منطقته كساحة الطباعة النشطة
 * ويوفر سياق الاتجاه/العنوان لأزرار الطباعة داخله.
 */
export function PrintableReport({
  meta,
  orientation = "portrait",
  toolbar,
  children,
  className,
}: {
  meta: ReportHeaderMeta;
  orientation?: PrintOrientation;
  /** أدوات فوق التقرير (أزرار) — لا تُطبع أبدًا. */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const areaRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    installGlobalPrintListeners();
    setActivePrintArea(areaRef.current);
    return () => {
      if (activePrintArea === areaRef.current) setActivePrintArea(null);
    };
  }, []);

  const ctxValue = React.useMemo<PrintContextValue>(
    () => ({ orientation, documentTitle: meta.documentTitle }),
    [orientation, meta.documentTitle],
  );

  return (
    <PrintContext.Provider value={ctxValue}>
      {toolbar && (
        <div className="no-print mb-3 flex flex-wrap items-center justify-end gap-2 print:hidden">
          {toolbar}
        </div>
      )}
      <div
        ref={areaRef}
        className={cn("print-area", className)}
        data-print-orientation={orientation}
        data-report-title={meta.reportTitle}
      >
        <ReportHeader meta={meta} />
        <div className="mt-4">{children}</div>
      </div>
    </PrintContext.Provider>
  );
}
