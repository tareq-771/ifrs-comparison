"use client";

// 6.9 — لوحة العرض والمقارنة للقوائم المالية (عرض فقط — كل الأرقام من الخدمة المركزية حصرًا).
// أوضاع العرض: كافة الحسابات / الرئيسية / الفرعية / مستوى محدد / تصنيف القوائم.
// أوضاع المقارنة: بلا / الفترة السابقة / مناظر السنة السابقة / الموازنة / التراكمي / متوسط التراكمي.
// الضوابط: لا حساب مقارنة داخل الواجهة إطلاقًا (محرك مركزي)؛ القيم minor كسلاسل BigInt
// عبر lib/money؛ الحالات الناقصة معلنة نصيًا لا أصفار؛ الطباعة عبر طبقة 6.8 الموحدة
// (أفقي A4 للمقارنات العريضة، رأسي للعرض البسيط)؛ تسميات الأوضاع من الثوابت المركزية.

import * as React from "react";
import { AlertTriangle, ChevronDown, Info, Loader2, SlidersHorizontal } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatMinor } from "@/lib/money";
import { PrintableReport, PrintButton } from "@/components/reporting/report-print";
import { buildReportHeaderMeta, type ReportStatusKind } from "@/lib/report-header";
import { exportReportCsv, safeExportFilename, type ExportColumn } from "@/lib/report-export";
import {
  COMPARISON_MODES,
  COMPARISON_MODE_LABELS,
  PRESENTATION_MODES,
  PRESENTATION_MODE_LABELS,
  STATEMENT_SCOPES,
  STATEMENT_SCOPE_LABELS,
  DIRECTION_LABELS,
  REVIEW_FLAG_LABELS,
  type ComparisonRowDTO,
} from "@/lib/comparison-engine";
import {
  REPORT_LANGUAGES,
  REPORT_LANGUAGE_LABELS,
  budgetVarianceBadge,
  comparisonStatusLabel,
  directionLabel,
  normalizeReportLanguage,
  type ReportLanguage,
} from "@/lib/display-labels";

/* ── عقد الاستجابة (نفس DTO الخادمية حرفيًا) ── */
interface ComparisonResponse {
  company: { code: string; nameAr: string; currency?: string | null; currencyLabel?: string | null };
  fiscalYear: { code: string; displayNameAr?: string };
  period: { ordinal?: number; displayLabel?: string };
  statementScope: string;
  basis: string;
  presentationMode: string;
  reportLanguage?: ReportLanguage;
  accountLevel: number | null;
  hierarchyMaxLevel: number | null;
  comparisonMode: string;
  comparisonTarget: { label: string; fromDate: string | null; toDate: string | null } | null;
  status: string;
  statusDetail: string | null;
  notes: string[];
  rows: ComparisonRowDTO[];
  totals: Array<{
    key: string; label: string; amount: string | null; status: string; sourceAccountCodes?: string[];
    comparisonAmount?: string | null; varianceAmount?: string | null; variancePercent?: string | null; direction?: string;
  }>;
  summary: { accounts: number; incomplete: number; unclassified: number; flagged: number };
}

function Money({ value, minorUnits }: { value: string | null | undefined; minorUnits: number }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-muted-foreground" title="القيمة غير متاحة — بيانات ناقصة أو مقارنة غير منطبقة">—</span>;
  }
  return <span className="tnum font-mono" dir="ltr">{formatMinor(value, minorUnits)}</span>;
}

function Percent({ value }: { value: string | null }) {
  if (value === null) return <span className="text-xs text-muted-foreground">—</span>;
  return <span className="tnum" dir="ltr">{value}%</span>;
}

function DirectionBadge({ row, isBudgetMode }: { row: ComparisonRowDTO; isBudgetMode: boolean }) {
  const label = DIRECTION_LABELS[row.direction as keyof typeof DIRECTION_LABELS] ?? row.direction;
  const tone =
    row.direction === "INCREASE" ? "text-emerald-700 dark:text-emerald-400"
    : row.direction === "DECREASE" ? "text-rose-700 dark:text-rose-400"
    : row.direction === "NO_CHANGE" ? "text-muted-foreground"
    : "text-amber-700 dark:text-amber-400";
  // جولة المراجعة C/H: شارة سياقية للموازنة فقط — فترة⇄فترة تبقى محايدة بلا حكم.
  const fav = isBudgetMode
    ? budgetVarianceBadge(
        {
          lineNature: row.lineNature,
          favorability: row.favorability,
          hasData: row.currentStatus === "OK" && row.comparisonStatus === "OK",
        },
        "ar"
      )
    : null;
  return (
    <span className={cn("text-xs font-semibold", tone)}>
      {label}
      {fav && <span className="ms-1 text-[10px] font-normal text-muted-foreground">({fav})</span>}
    </span>
  );
}

/** شارة الحالة بلغة المستخدم — الكود التقني ثانوي في title فقط (جولة المراجعة D/G). */
function StatusHint({ status }: { status: string }) {
  return (
    <span className="block text-[9px] text-muted-foreground" title={status}>
      {comparisonStatusLabel(status, "ar")}
    </span>
  );
}

/** صف واحد قابل للتوسيع — التفصيل من الحسابات التي تعيدها الخدمة (تتبع كامل). */
function CompareRowView({ row, minorUnits, showComparison, minorUnitLabel, isBudgetMode }: { row: ComparisonRowDTO; minorUnits: number; showComparison: boolean; minorUnitLabel: string; isBudgetMode: boolean }) {
  const [open, setOpen] = React.useState(false);
  const hasAccounts = (row.accounts?.length ?? 0) > 0;
  const bold = row.kind === "GROUP" || row.kind === "LINE" ? row.depth === 0 && row.kind === "GROUP" : true;
  return (
    <>
      <TableRow className={cn(row.kind === "UNATTACHED" && "bg-amber-50/40 dark:bg-amber-950/10")}>
        <TableCell style={{ paddingInlineStart: `${row.depth * 16 + 10}px` }}>
          <div className="flex flex-wrap items-center gap-1">
            {hasAccounts ? (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-label={open ? "إخفاء تفاصيل الحسابات" : "عرض تفاصيل الحسابات"}
                className="flex items-center gap-1 text-right hover:text-emerald-700 dark:hover:text-emerald-400"
              >
                <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
                <span className={cn(bold && "font-semibold")}>{row.label}</span>
              </button>
            ) : (
              <span className={cn(bold && "font-semibold")}>{row.label}</span>
            )}
            {row.flags.map((f) => (
              <Badge key={f} variant="outline" className="text-[9px] px-1 py-0 border-amber-400/70 text-amber-700 dark:text-amber-400">
                {REVIEW_FLAG_LABELS[f] ?? f}
              </Badge>
            ))}
          </div>
        </TableCell>
        <TableCell className={cn("text-left", row.currentStatus !== "OK" && "opacity-60")}>
          <Money value={row.currentAmount} minorUnits={minorUnits} />
        </TableCell>
        {showComparison && (
          <>
            <TableCell className={cn("text-left", row.comparisonStatus !== "OK" && "opacity-60")}>
              <Money value={row.comparisonAmount} minorUnits={minorUnits} />
              {row.comparisonStatus !== "OK" && <StatusHint status={row.comparisonStatus} />}
            </TableCell>
            <TableCell className="text-left"><Money value={row.varianceAmount} minorUnits={minorUnits} /></TableCell>
            <TableCell className="text-left"><Percent value={row.variancePercent} /></TableCell>
            <TableCell><DirectionBadge row={row} isBudgetMode={isBudgetMode} /></TableCell>
          </>
        )}
        <TableCell className="min-w-40 text-[11px] leading-5 text-muted-foreground">
          {row.interpretationText}
          {row.reviewGuidance && <span className="mt-0.5 block text-[10px] text-amber-700 dark:text-amber-400">{row.reviewGuidance}</span>}
          {hasAccounts && open && (
            <span className="mt-1 block text-[10px] text-muted-foreground">
              مصادر الصف: {row.sourceAccountCodes.join("، ") || "—"} ({minorUnitLabel})
            </span>
          )}
        </TableCell>
      </TableRow>
      {open && hasAccounts && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={showComparison ? 7 : 3} className="px-0 py-0">
            <div className="scroll-thin max-h-56 overflow-y-auto px-4 py-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right text-[10px]">كود الحساب</TableHead>
                    <TableHead className="text-right text-[10px]">اسم الحساب</TableHead>
                    <TableHead className="text-left text-[10px]">المبلغ (بإشارة العرض)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(row.accounts ?? []).map((a) => (
                    <TableRow key={a.accountCode}>
                      <TableCell className="font-mono text-[11px]">{a.accountCode}</TableCell>
                      <TableCell className="text-[11px]">{a.accountName || "—"}</TableCell>
                      <TableCell className="text-left text-[11px]"><Money value={a.valueMinor} minorUnits={minorUnits} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function StatementComparisonPanel({
  statementScope,
  companyId,
  fiscalYearId,
  ordinal,
  basis,
  minorUnits,
  companyCode,
  companyName,
  currencyLabel,
  fiscalYearCode,
  fiscalYearLabel,
}: {
  statementScope: (typeof STATEMENT_SCOPES)[keyof typeof STATEMENT_SCOPES];
  companyId: string | null;
  fiscalYearId: string | null;
  ordinal: string;
  basis: "YTD" | "PERIOD";
  minorUnits: number;
  companyCode?: string;
  companyName?: string;
  currencyLabel?: string;
  fiscalYearCode?: string;
  fiscalYearLabel?: string;
}) {
  const { toast } = useToast();
  const [presentationMode, setPresentationMode] = React.useState<string>(PRESENTATION_MODES.STATEMENT_MAPPING);
  const [comparisonMode, setComparisonMode] = React.useState<string>(COMPARISON_MODES.NONE);
  const [accountLevel, setAccountLevel] = React.useState<string>("1");
  // جولة المراجعة E: لغة التقرير مستقلة عن لغة واجهة النظام (افتراضي عربي)
  const [reportLanguage, setReportLanguage] = React.useState<ReportLanguage>(REPORT_LANGUAGES.AR);
  const [data, setData] = React.useState<ComparisonResponse | null>(null);
  const [loading, setLoading] = React.useState(false);

  const isDefault = presentationMode === PRESENTATION_MODES.STATEMENT_MAPPING && comparisonMode === COMPARISON_MODES.NONE;
  const showComparison = comparisonMode !== COMPARISON_MODES.NONE;
  const isBudgetMode = comparisonMode === COMPARISON_MODES.BUDGET;

  const load = React.useCallback(async () => {
    if (!companyId || !fiscalYearId || !ordinal) { setData(null); return; }
    // العرض الافتراضي (تصنيف القوائم + بلا مقارنة) هو القائمة القياسية المعروضة أعلاه — لا تكرار
    if (isDefault) { setData(null); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/reports/actual/statement-comparison", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId, fiscalYearId, ordinal: Number(ordinal), basis, statementScope,
          presentationMode, comparisonMode, reportLanguage,
          accountLevel: presentationMode === PRESENTATION_MODES.ACCOUNT_LEVEL ? Number(accountLevel) : undefined,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setData(null);
      toast({ title: "فشل جلب العرض والمقارنة", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [companyId, fiscalYearId, ordinal, basis, statementScope, presentationMode, comparisonMode, accountLevel, reportLanguage, isDefault, toast]);

  React.useEffect(() => { void load(); }, [load]);

  const exportCsv = React.useCallback(() => {
    if (!data) return;
    const cols: ExportColumn<ComparisonRowDTO>[] = [
      { key: "label", label: "البند", value: (r) => r.label },
      { key: "kind", label: "النوع", value: (r) => r.kind },
      { key: "current", label: "الفترة الحالية (minor)", numeric: true, value: (r) => r.currentAmount ?? (r.currentStatus !== "OK" ? comparisonStatusLabel(r.currentStatus, "ar") : "") },
      ...(showComparison
        ? [
            { key: "comparison", label: "فترة المقارنة (minor)", numeric: true, value: (r: ComparisonRowDTO) => r.comparisonAmount ?? (r.comparisonStatus !== "OK" ? comparisonStatusLabel(r.comparisonStatus, "ar") : "") },
            { key: "variance", label: "مبلغ التغير (minor)", numeric: true, value: (r: ComparisonRowDTO) => r.varianceAmount ?? "" },
            { key: "pct", label: "نسبة التغير %", value: (r: ComparisonRowDTO) => r.variancePercent ?? "" },
            { key: "dir", label: "الاتجاه", value: (r: ComparisonRowDTO) => directionLabel(r.direction, "ar") },
            { key: "fav", label: "التفسير السياقي", value: (r: ComparisonRowDTO) => isBudgetMode ? budgetVarianceBadge({ lineNature: r.lineNature, favorability: r.favorability, hasData: r.currentStatus === "OK" && r.comparisonStatus === "OK" }, "ar") : "" },
          ]
        : []),
      { key: "interp", label: "ملاحظة تحليلية", value: (r) => r.interpretationText ?? "" },
      { key: "flags", label: "علامات المراجعة", value: (r) => r.flags.map((f) => REVIEW_FLAG_LABELS[f] ?? f).join(" | ") },
      { key: "sources", label: "الحسابات المصدرية", value: (r) => r.sourceAccountCodes.join("، ") },
    ];
    exportReportCsv(
      cols,
      data.rows,
      safeExportFilename("comparison", data.company.code, data.fiscalYear.code, data.presentationMode, data.comparisonMode),
    );
  }, [data, showComparison, isBudgetMode]);

  const headerStatus: ReportStatusKind = data
    ? data.status === "INCOMPLETE_DATA" ? "INCOMPLETE_DATA" : "APPROVED"
    : "APPROVED";

  const meta = data
    ? buildReportHeaderMeta({
        companyCode: data.company.code ?? companyCode,
        companyName: data.company.nameAr ?? companyName,
        reportTitle: `${STATEMENT_SCOPE_LABELS[data.statementScope as keyof typeof STATEMENT_SCOPE_LABELS] ?? ""} — ${PRESENTATION_MODE_LABELS[data.presentationMode as keyof typeof PRESENTATION_MODE_LABELS] ?? ""}`,
        fiscalYearCode: data.fiscalYear.code ?? fiscalYearCode,
        fiscalYearLabel: data.fiscalYear.displayNameAr ?? fiscalYearLabel,
        periodLabel: `حتى نهاية فترة ${data.period.ordinal ?? ordinal}${data.period.displayLabel ? ` — ${data.period.displayLabel}` : ""}`,
        currency: data.company.currencyLabel ?? currencyLabel ?? null,
        dataType: data.basis,
        status: headerStatus,
        statusNotice: [
          data.statusDetail,
          data.comparisonTarget ? `مرجع المقارنة: ${data.comparisonTarget.label}` : null,
        ].filter(Boolean).join(" — ") || null,
      })
    : null;

  const orientation: "portrait" | "landscape" = showComparison ? "landscape" : "portrait";

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <SlidersHorizontal className="size-4 text-emerald-600 dark:text-emerald-400" />
          طريقة العرض والمقارنة — من المصدر المعتمد حصرًا
        </CardTitle>
        <CardDescription>
          محرك عرض ومقارنة موحد فوق بيانات أحدث مراجعة معتمدة — لا إعادة حساب داخل الواجهة. العرض الافتراضي هو القائمة القياسية أعلاه.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* لوحة التحكم — لا تُطبع (طبقة 6.8 تخفي كل ما عدا المنفذ) */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label>طريقة العرض</Label>
            <Select value={presentationMode} onValueChange={setPresentationMode}>
              <SelectTrigger aria-label="طريقة العرض"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-64">
                {(Object.values(PRESENTATION_MODES) as string[]).map((m) => (
                  <SelectItem key={m} value={m}>{PRESENTATION_MODE_LABELS[m as keyof typeof PRESENTATION_MODE_LABELS]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {presentationMode === PRESENTATION_MODES.ACCOUNT_LEVEL && (
            <div className="space-y-1.5">
              <Label>المستوى</Label>
              <Select value={accountLevel} onValueChange={setAccountLevel}>
                <SelectTrigger aria-label="مستوى الحساب"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {Array.from({ length: Math.max(1, data?.hierarchyMaxLevel ?? 6) }, (_, i) => i + 1).map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      المستوى {["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر"][n - 1] ?? n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>المقارنة</Label>
            <Select value={comparisonMode} onValueChange={setComparisonMode}>
              <SelectTrigger aria-label="وضع المقارنة"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-64">
                {(Object.values(COMPARISON_MODES) as string[]).map((m) => (
                  <SelectItem key={m} value={m}>{COMPARISON_MODE_LABELS[m as keyof typeof COMPARISON_MODE_LABELS]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* جولة المراجعة E: لغة التقرير — مستقلة عن لغة واجهة النظام */}
          <div className="space-y-1.5">
            <Label>لغة التقرير</Label>
            <Select value={reportLanguage} onValueChange={(v) => setReportLanguage(normalizeReportLanguage(v))}>
              <SelectTrigger aria-label="لغة التقرير"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.values(REPORT_LANGUAGES) as ReportLanguage[]).map((l) => (
                  <SelectItem key={l} value={l}>{REPORT_LANGUAGE_LABELS[l]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {loading && (
          <p className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> جارٍ البناء من المصدر المعتمد…
          </p>
        )}

        {!loading && data && (
          <PrintableReport
            orientation={orientation}
            toolbar={
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={exportCsv} className="no-print">
                  تصدير CSV
                </Button>
                <PrintButton orientation={orientation} />
              </div>
            }
            meta={meta!}
          >
            {/* الحالات الصادقة */}
            {data.status === "NO_APPROVED_BUDGET" && (
              <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                لا توجد موازنة معتمدة — {data.statusDetail}
              </p>
            )}
            {data.status === "NO_COMPARISON_DATA" && (
              <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                لا توجد بيانات مقارنة — {data.statusDetail}
              </p>
            )}
            {data.status === "INCOMPLETE_DATA" && (
              <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                بيانات غير مكتملة (INCOMPLETE_DATA) — الصفوف الناقصة معلنة ولا تُعوَّض بأصفار.
              </p>
            )}
            {data.comparisonTarget && (
              <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                مرجع المقارنة: {data.comparisonTarget.label}
                {data.comparisonTarget.fromDate && data.comparisonTarget.toDate && (
                  <> · <span className="tnum" dir="ltr">{data.comparisonTarget.fromDate} → {data.comparisonTarget.toDate}</span></>
                )}
              </p>
            )}
            {data.notes.map((n, i) => (
              <p key={i} className="flex items-start gap-1.5 rounded-md border border-dashed p-2 text-[11px] leading-5 text-muted-foreground">
                <Info className="mt-0.5 size-3 shrink-0" /> {n}
              </p>
            ))}

            {/* جدول المقارنة */}
            <Card>
              <CardContent className="pt-4">
                <div className="scroll-thin overflow-x-auto">
                  <Table className="min-w-[560px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">البند</TableHead>
                        <TableHead className="text-left">الفترة الحالية ({currencyLabel || data.company.currencyLabel || ""})</TableHead>
                        {showComparison && (
                          <>
                            <TableHead className="text-left">فترة المقارنة</TableHead>
                            <TableHead className="text-left">مبلغ التغير</TableHead>
                            <TableHead className="text-left">نسبة التغير</TableHead>
                            <TableHead className="text-right">الاتجاه</TableHead>
                          </>
                        )}
                        <TableHead className="text-right min-w-40">ملاحظة تحليلية</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.rows.map((r) => (
                        <CompareRowView key={r.key} row={r} minorUnits={minorUnits} showComparison={showComparison} minorUnitLabel="" isBudgetMode={isBudgetMode} />
                      ))}
                      {data.rows.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={showComparison ? 7 : 3} className="py-6 text-center text-sm text-muted-foreground">
                            لا صفوف في هذا العرض لهذه الفترة — {data.statusDetail ?? "لا بيانات مطابقة للنطاق."}
                          </TableCell>
                        </TableRow>
                      )}
                      {/* الإجماليات المقطعية */}
                      {data.totals.map((t) => (
                        <TableRow key={t.key} className="border-t-2 bg-emerald-50/50 font-bold dark:bg-emerald-950/20">
                          <TableCell>{t.label}{t.status !== "OK" && <span className="ms-1 text-[10px] font-normal text-amber-700 dark:text-amber-400">(بيانات ناقصة)</span>}</TableCell>
                          <TableCell className="text-left"><Money value={t.amount} minorUnits={minorUnits} /></TableCell>
                          {showComparison && (
                            <>
                              <TableCell className="text-left"><Money value={t.comparisonAmount ?? null} minorUnits={minorUnits} /></TableCell>
                              <TableCell className="text-left"><Money value={t.varianceAmount ?? null} minorUnits={minorUnits} /></TableCell>
                              <TableCell className="text-left"><Percent value={t.variancePercent ?? null} /></TableCell>
                              <TableCell className="text-xs">{t.direction ? DIRECTION_LABELS[t.direction as keyof typeof DIRECTION_LABELS] ?? t.direction : "—"}</TableCell>
                            </>
                          )}
                          <TableCell className="text-[10px] text-muted-foreground">
                            {(t.sourceAccountCodes?.length ?? 0) > 0 ? `يتبع من ${t.sourceAccountCodes!.length} حساب مصدري` : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <p className="text-[10px] text-muted-foreground">
              الملخص: {data.summary.accounts} حسابًا في النطاق · {data.summary.incomplete} بقيم ناقصة · {data.summary.unclassified} غير مصنف بالكامل · {data.summary.flagged} صفًا بعلامات مراجعة.
              المبالغ بوحدات صغرى (minor) وتُعرض منسقة — النسب المئوية محسوبة بدقة BigInt كاملة.
            </p>
          </PrintableReport>
        )}
      </CardContent>
    </Card>
  );
}
