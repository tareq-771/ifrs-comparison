"use client";

// Phase 4B.1 — حوار الاستعادة الفعلية (تأكيد قوي متعدد الخطوات + تنفيذ + تقرير).
//
// القرارات الحاكمة (نص المستخدم):
//  • قبل التنفيذ: عرض backupId وcreatedAt ومستوى التحقق وإصدار المخطط وchecksum
//    مختصر وcounts وperiodRange — ومعها عدّ الحالة الحالية جنباً إلى جنب.
//  • التأكيد الأول: كتابة RESTORE حرفيًا.
//  • التأكيد الثاني (إن كانت النسخة أقدم من الحالة الحالية أو ستقلل عدد التقارير):
//    كتابة معرف النسخة كاملًا — والخادم يعيد اشتقاط الشرط بنفسه (لا ثقة بالعميل).
//  • بعد النجاح (COMPLETED/ROLLED_BACK): الجلسة الحالية ماتت (epoch+1) —
//    توجيه فوري إلى /login برسالة واضحة.

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeftRight, CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface PreviewPayload {
  engineEnabled: boolean;
  candidate: {
    backupId: string;
    createdAt: string;
    backupType: string;
    level: string;
    schemaVersion: string;
    checksumShort: string;
    canonicalFingerprintShort: string;
    dbBytes: number;
    counts: { users: number; groups: number; reports: number; workflowHistory: number; auditLog: number } | null;
    periodRange: { minPeriodEnd: string | null; maxPeriodEnd: string | null } | null;
    source: string;
  } | null;
  current: {
    counts: { users: number; groups: number; reports: number; workflowHistory: number; auditLog: number } | null;
    freshnessMarker: string | null;
  } | null;
  downgradeRequired: boolean;
  downgradeReasons: string[];
  requiredConfirmations: { primary: "RESTORE"; secondary: string | null };
  error: { code: string; message: string } | null;
}

interface OutcomePayload {
  ok: boolean;
  operationId: string;
  backupId: string;
  result: "COMPLETED" | "ROLLED_BACK" | "ABORTED" | "RECOVERY_REQUIRED";
  preRestoreBackupId: string | null;
  epochBumped: boolean;
  phases: Array<{ phase: string; state: string; ms: number; detail?: string }>;
  postVerify: Array<{ name: string; code: string; ok: boolean; detail?: string }> | null;
  rollbackVerify: Array<{ name: string; code: string; ok: boolean; detail?: string }> | null;
  abortReason: string | null;
  warnings: string[];
  durationMs: number;
}

const RESULT_STYLES: Record<OutcomePayload["result"], { label: string; cls: string; icon: React.ReactNode }> = {
  COMPLETED: { label: "اكتملت الاستعادة بنجاح", cls: "text-emerald-700 dark:text-emerald-400", icon: <CheckCircle2 className="size-5" /> },
  ROLLED_BACK: { label: "فشل التحقق — تم التراجع تلقائيًا إلى نسخة الأمان", cls: "text-amber-700 dark:text-amber-400", icon: <ArrowLeftRight className="size-5" /> },
  ABORTED: { label: "أُلغيت العملية قبل التبديل — قاعدة التشغيل لم تُلمس", cls: "text-slate-600 dark:text-slate-400", icon: <XCircle className="size-5" /> },
  RECOVERY_REQUIRED: { label: "RECOVERY_REQUIRED — الخدمة مقفلة حتى استرداد يدوي موثق", cls: "text-rose-700 dark:text-rose-400", icon: <AlertTriangle className="size-5" /> },
};

export function RestoreDialog(props: {
  backupId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { backupId, onOpenChange } = props;
  const router = useRouter();
  const { toast } = useToast();

  const [preview, setPreview] = React.useState<PreviewPayload | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [confirm1, setConfirm1] = React.useState("");
  const [confirm2, setConfirm2] = React.useState("");
  const [executing, setExecuting] = React.useState(false);
  const [outcome, setOutcome] = React.useState<OutcomePayload | null>(null);

  const open = !!backupId;

  React.useEffect(() => {
    if (!backupId) {
      setPreview(null);
      setConfirm1("");
      setConfirm2("");
      setOutcome(null);
      return;
    }
    setPreviewLoading(true);
    setPreview(null);
    setConfirm1("");
    setConfirm2("");
    setOutcome(null);
    fetch(`/api/backups/${backupId}/restore-preview`, { cache: "no-store" })
      .then(async (res) => {
        const j = (await res.json().catch(() => null)) as PreviewPayload | null;
        if (!res.ok || !j) {
          throw new Error((j as unknown as { error?: string })?.error || "فشل بناء المعاينة");
        }
        setPreview(j);
      })
      .catch((e) => {
        toast({ title: "خطأ", description: e instanceof Error ? e.message : "خطأ", variant: "destructive" });
        onOpenChange(false);
      })
      .finally(() => setPreviewLoading(false));
  }, [backupId, onOpenChange, toast]);

  async function onExecute() {
    if (!backupId) return;
    setExecuting(true);
    try {
      const res = await fetch(`/api/backups/${backupId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmationText: confirm1.trim(),
          downgradeConfirmation: confirm2.trim() || null,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 409 && j.code === "SECOND_CONFIRMATION_REQUIRED") {
        toast({
          title: "تأكيد ثانٍ مطلوب",
          description: String(j.error ?? "النسخة أقدم من الحالة الحالية — اكتب معرف النسخة كاملًا"),
          variant: "destructive",
        });
        return;
      }
      if (res.status === 409 && j.code === "RESTORE_ENGINE_DISABLED") {
        toast({
          title: "المحرك معطّل",
          description: "استعادة الإنتاج تُفعّل في 4B.2 بموافقة صريحة — لا يمكن التنفيذ الآن",
          variant: "destructive",
        });
        return;
      }
      if (!res.ok && !j.result) {
        throw new Error(String(j.error ?? "فشل التنفيذ"));
      }
      setOutcome(j as unknown as OutcomePayload);
    } catch (e) {
      toast({ title: "خطأ", description: e instanceof Error ? e.message : "خطأ", variant: "destructive" });
    } finally {
      setExecuting(false);
    }
  }

  const done = outcome && (outcome.result === "COMPLETED" || outcome.result === "ROLLED_BACK");

  function closeAfterSuccess() {
    onOpenChange(false);
    // الجلسة ماتت (epoch+1) — توجيه صريح لصفحة الدخول برسالة السبب
    router.push("/login?reason=restored");
  }

  const canExecute =
    !!preview &&
    confirm1.trim() === "RESTORE" &&
    (!preview.downgradeRequired || confirm2.trim() === preview.requiredConfirmations.secondary);

  return (
    <Dialog open={open} onOpenChange={(o) => !executing && onOpenChange(o)}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-rose-600" />
            استعادة فعلية لقاعدة التشغيل
          </DialogTitle>
          <DialogDescription>
            عملية تدميرية محكومة: نسخة أمان إلزامية → تصريف الكتابات → تبديل ذري → تحقق بعدي →
            تراجع تلقائي عند أي فشل. كل خطوة تُوثق في سجل عمليات الاسترجاع الخارجي بمعرف عملية واحد.
          </DialogDescription>
        </DialogHeader>

        {previewLoading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
            <Loader2 className="size-4 animate-spin" /> جارٍ بناء المعاينة…
          </div>
        )}

        {!previewLoading && preview?.error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {preview.error.code}: {preview.error.message}
          </div>
        )}

        {!previewLoading && preview?.candidate && (
          <div className="space-y-4">
            {/* مقارنة جنباً إلى جنب */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-md border p-3">
                <p className="mb-2 font-semibold text-slate-700 dark:text-slate-300">النسخة المرشحة</p>
                <dl className="space-y-1 text-slate-600 dark:text-slate-400">
                  <div className="flex justify-between gap-2"><dt>المعرف</dt><dd className="font-mono" dir="ltr">{preview.candidate.backupId}</dd></div>
                  <div className="flex justify-between gap-2"><dt>أُنشئت</dt><dd>{fmtDate(preview.candidate.createdAt)}</dd></div>
                  <div className="flex justify-between gap-2"><dt>المستوى</dt><dd><Badge variant="outline" className="text-[10px]">{preview.candidate.level}</Badge></dd></div>
                  <div className="flex justify-between gap-2"><dt>المخطط</dt><dd className="font-mono text-[10px]" dir="ltr">{preview.candidate.schemaVersion}</dd></div>
                  <div className="flex justify-between gap-2"><dt>checksum</dt><dd className="font-mono text-[10px]" dir="ltr">{preview.candidate.checksumShort}…</dd></div>
                  <div className="flex justify-between gap-2"><dt>تقارير / مستخدمون</dt><dd>{preview.candidate.counts ? `${preview.candidate.counts.reports} / ${preview.candidate.counts.users}` : "—"}</dd></div>
                  <div className="flex justify-between gap-2"><dt>periodRange</dt><dd dir="ltr">{preview.candidate.periodRange?.minPeriodEnd ?? "؟"} → {preview.candidate.periodRange?.maxPeriodEnd ?? "؟"}</dd></div>
                </dl>
              </div>
              <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900 dark:bg-amber-950/20">
                <p className="mb-2 font-semibold text-amber-800 dark:text-amber-300">الحالة الحالية التي ستفقد</p>
                <dl className="space-y-1 text-amber-800/80 dark:text-amber-200/80">
                  <div className="flex justify-between gap-2"><dt>تقارير</dt><dd>{preview.current?.counts?.reports ?? "—"}</dd></div>
                  <div className="flex justify-between gap-2"><dt>مجموعات</dt><dd>{preview.current?.counts?.groups ?? "—"}</dd></div>
                  <div className="flex justify-between gap-2"><dt>مستخدمون</dt><dd>{preview.current?.counts?.users ?? "—"}</dd></div>
                  <div className="flex justify-between gap-2"><dt>سجل تدقيق</dt><dd>{preview.current?.counts?.auditLog ?? "—"}</dd></div>
                  <div className="flex justify-between gap-2"><dt>آخر نشاط</dt><dd>{preview.current?.freshnessMarker ? fmtDate(preview.current.freshnessMarker) : "—"}</dd></div>
                </dl>
              </div>
            </div>

            {preview.downgradeRequired && (
              <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
                <p className="mb-1 flex items-center gap-1 font-semibold"><AlertTriangle className="size-3.5" /> تأكيد ثانٍ إلزامي (server-side)</p>
                <ul className="list-disc space-y-0.5 pr-4">
                  {preview.downgradeReasons.map((r) => <li key={r}>{r}</li>)}
                </ul>
              </div>
            )}

            {!outcome && (
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                    اكتب <span className="font-mono font-bold" dir="ltr">RESTORE</span> للتأكيد الأول
                  </label>
                  <Input value={confirm1} onChange={(e) => setConfirm1(e.target.value)} dir="ltr" placeholder="RESTORE" className="font-mono" />
                </div>
                {preview.downgradeRequired && (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-400">
                      التأكيد الثاني: اكتب معرف النسخة كاملًا <span className="font-mono" dir="ltr">{preview.requiredConfirmations.secondary}</span>
                    </label>
                    <Input value={confirm2} onChange={(e) => setConfirm2(e.target.value)} dir="ltr" placeholder={preview.requiredConfirmations.secondary ?? ""} className="font-mono" />
                  </div>
                )}
              </div>
            )}

            {outcome && (
              <div className="space-y-3">
                <div className={cn("flex items-center gap-2 rounded-md border p-3 text-sm font-semibold", RESULT_STYLES[outcome.result].cls)}>
                  {RESULT_STYLES[outcome.result].icon}
                  {RESULT_STYLES[outcome.result].label}
                </div>
                <dl className="space-y-1 rounded-md border p-3 text-xs text-slate-600 dark:text-slate-400">
                  <div className="flex justify-between gap-2"><dt>operationId</dt><dd className="font-mono" dir="ltr">{outcome.operationId}</dd></div>
                  <div className="flex justify-between gap-2"><dt>نسخة الأمان (pre-restore)</dt><dd className="font-mono" dir="ltr">{outcome.preRestoreBackupId ?? "—"}</dd></div>
                  <div className="flex justify-between gap-2"><dt>epoch+1 (إبطال الجلسات)</dt><dd>{outcome.epochBumped ? "تم" : "لم يتم"}</dd></div>
                  <div className="flex justify-between gap-2"><dt>المدة الكلية</dt><dd dir="ltr">{(outcome.durationMs / 1000).toFixed(1)}s</dd></div>
                  {outcome.abortReason && <div className="flex justify-between gap-2"><dt>سبب الإلغاء</dt><dd className="text-left">{outcome.abortReason}</dd></div>}
                </dl>
                <details className="rounded-md border p-3 text-xs">
                  <summary className="cursor-pointer font-medium text-slate-600 dark:text-slate-400">مراحل العملية ({outcome.phases.length})</summary>
                  <ul className="mt-2 space-y-1 text-slate-500 dark:text-slate-500">
                    {outcome.phases.map((p, i) => (
                      <li key={i} className="flex justify-between gap-2" dir="ltr">
                        <span className="font-mono">{p.phase} · {p.state}</span>
                        <span>{(p.ms / 1000).toFixed(1)}s</span>
                      </li>
                    ))}
                  </ul>
                </details>
                {outcome.postVerify && (
                  <details className="rounded-md border p-3 text-xs">
                    <summary className="cursor-pointer font-medium text-slate-600 dark:text-slate-400">نتيجة التحقق البعدي</summary>
                    <ul className="mt-2 space-y-1">
                      {outcome.postVerify.map((c, i) => (
                        <li key={i} className={cn("flex items-center gap-1.5", c.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                          {c.ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />} {c.name}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {outcome && done ? (
            <Button onClick={closeAfterSuccess} className="gap-1.5">
              إنهاء الجلسة والدخول من جديد
            </Button>
          ) : outcome ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>إغلاق</Button>
          ) : (
            <>
              <Button variant="outline" disabled={executing} onClick={() => onOpenChange(false)}>إلغاء</Button>
              <Button
                variant="destructive"
                disabled={!canExecute || executing || !!preview?.error || preview?.engineEnabled === false}
                onClick={() => void onExecute()}
                className="gap-1.5"
              >
                {executing ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                {executing ? "جارٍ التنفيذ…" : "تنفيذ الاستعادة"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}
