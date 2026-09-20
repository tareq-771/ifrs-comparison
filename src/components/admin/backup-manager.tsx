"use client";

// Phase 4A — تبويب النسخ الاحتياطي في لوحة الإدارة.
// القائمة من Manifestات (لا أسماء ملفات) — مستويات التحقق الثلاثة + INVALID،
// إنشاء/تحقق/Drill/تنزيل/رفع للتحقق + سجل الاسترجاع التشغيلي + بطاقة السياسة.

import * as React from "react";
import { motion } from "framer-motion";
import {
  DatabaseBackup,
  Download,
  FileJson,
  HardDriveDownload,
  Info,
  Loader2,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/* ──────────────────────────────────────────────────────────────────────── */
/*  Types (مرآة الـ API)                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

type Level = "CREATED" | "VALIDATED" | "RESTORE_VERIFIED" | "INVALID";

interface ListEntry {
  backupId: string;
  fileName: string;
  source: "local" | "upload";
  backupType: string;
  createdAt: string;
  appVersion: string;
  schemaVersion: string;
  schemaFingerprintShort: string;
  manifestFormat: 2 | 3 | 0;
  canonicalFingerprintShort: string;
  level: Level;
  invalidReason: string | null;
  sizeBytes: number;
  dbBytes: number;
  counts: { users: number; groups: number; reports: number; workflowHistory: number; auditLog: number } | null;
  periodRange: { minPeriodEnd: string | null; maxPeriodEnd: string | null } | null;
  integrityCheck: string | null;
}

interface ListResponse {
  local: ListEntry[];
  uploads: ListEntry[];
  config: { maxUploadMB: number; maxUncompressedMB: number; cooldownSeconds: number; allowedZipEntries: string[] };
  policy: Record<string, string>;
}

interface CheckResult {
  name: string;
  code: string;
  ok: boolean;
  detail?: string;
  ms?: number;
}

interface RunReport {
  ok?: boolean;
  backupId?: string;
  level?: string;
  checks?: CheckResult[];
  steps?: CheckResult[];
  prismaReadTests?: CheckResult[];
  warnings?: string[];
  durationMs?: number;
  countsMatched?: boolean;
  periodRangeMatched?: boolean;
  uploadId?: string;
  manifest?: ManifestView;
}

interface ManifestView {
  backupId: string;
  backupType: string;
  createdAt: string;
  createdBy: { id: string | null; username: string };
  appVersion: string;
  schemaVersion: string;
  formatVersion: number;
  schemaFingerprint: string;
  canonicalSchemaFingerprint?: string;
  database: { filename: string; sha256: string; bytes: number; pageSize: number; integrityCheck: string; journalModeAtBackup: string };
  counts: { users: number; groups: number; reports: number; workflowHistory: number; auditLog: number };
  periodRange: { minPeriodEnd: string | null; maxPeriodEnd: string | null };
  dataRange: { oldestCreatedAt: string | null; newestUpdatedAt: string | null };
  environment: { businessTzOffsetMinutes: number; configFingerprint: string };
  verification: { level: string; validatedAt: string | null; drillAt: string | null; drillOperationId?: string | null; drillRuns?: number };
  uploadInfo?: { originalNameSanitized: string; uploadedAt: string; uploadedByUsername: string };
  authenticity: { note: string; manifestHmac: null };
}

interface RecoveryEventRow {
  eventId: string;
  timestamp: string;
  operationId: string;
  event: string;
  actor: { id: string | null; username: string };
  backupId: string | null;
  result: string;
  details: Record<string, unknown>;
}

const RECOVERY_EVENT_LABELS: Record<string, string> = {
  BACKUP_STARTED: "بدء إنشاء نسخة",
  BACKUP_CREATED: "تم إنشاء نسخة",
  BACKUP_VALIDATED: "نجح التحقق",
  BACKUP_FAILED: "فشل نسخ/تحقق",
  DRILL_STARTED: "بدء Restore Drill",
  DRILL_VERIFIED: "نجح Drill — RESTORE_VERIFIED",
  DRILL_FAILED: "فشل Drill",
  UPLOAD_RECEIVED: "استلام ملف مرفوع",
  UPLOAD_REJECTED: "رفض ملف مرفوع",
};

const LEVEL_LABELS: Record<Level, string> = {
  CREATED: "تم الإنشاء",
  VALIDATED: "تم التحقق",
  RESTORE_VERIFIED: "مُثبت بالتجربة (Drill)",
  INVALID: "تالفة / غير صالحة",
};

function levelBadgeClass(level: Level): string {
  switch (level) {
    case "RESTORE_VERIFIED":
      return "bg-teal-100 text-teal-800 border-teal-300 dark:bg-teal-950/50 dark:text-teal-300 dark:border-teal-800";
    case "VALIDATED":
      return "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800";
    case "INVALID":
      return "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800";
    default:
      return "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700";
  }
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} بايت`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} كيلوبايت`;
  return `${(n / (1024 * 1024)).toFixed(2)} ميغابايت`;
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  المكون                                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

export function BackupManagerTab() {
  const { toast } = useToast();

  const [data, setData] = React.useState<ListResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const [details, setDetails] = React.useState<ManifestView | null>(null);
  const [detailsLoading, setDetailsLoading] = React.useState(false);
  const [report, setReport] = React.useState<{ title: string; ok: boolean; report: RunReport } | null>(null);

  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);

  const [recovery, setRecovery] = React.useState<RecoveryEventRow[]>([]);
  const [recoveryLoading, setRecoveryLoading] = React.useState(true);

  const fetchAll = React.useCallback(async () => {
    setLoading(true);
    setRecoveryLoading(true);
    try {
      const res = await fetch("/api/backups", { cache: "no-store" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "فشل جلب قائمة النسخ");
      }
      setData((await res.json()) as ListResponse);
    } catch (e) {
      toast({ title: "خطأ", description: e instanceof Error ? e.message : "خطأ", variant: "destructive" });
    } finally {
      setLoading(false);
    }
    try {
      const res = await fetch("/api/backups/recovery-log?limit=50", { cache: "no-store" });
      if (res.ok) {
        const j = await res.json();
        setRecovery(j.events as RecoveryEventRow[]);
      }
    } catch {
      /* السجل قد لا يوجد بعد */
    } finally {
      setRecoveryLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  async function onCreate() {
    setCreating(true);
    try {
      const res = await fetch("/api/backups", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (res.status === 429) {
        const retrySec = Math.ceil((j.retryAfterMs ?? 0) / 1000);
        toast({
          title: "فترة تهدئة",
          description: `أعد المحاولة بعد ${retrySec || j.cooldownSeconds || 60} ثانية`,
          variant: "destructive",
        });
        return;
      }
      if (!res.ok) throw new Error(j.error || "فشل إنشاء النسخة");
      toast({
        title: "تم إنشاء النسخة",
        description: `المعرف ${j.backupId} — المستوى ${j.level}${j.validationError ? " (فشل التحقق التلقائي)" : ""}`,
      });
      if (j.validationReport) {
        setReport({ title: "تقرير التحقق التلقائي", ok: true, report: j.validationReport });
      }
    } catch (e) {
      toast({ title: "خطأ", description: e instanceof Error ? e.message : "خطأ", variant: "destructive" });
    } finally {
      setCreating(false);
      void fetchAll();
    }
  }

  async function onValidate(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/backups/${id}/validate`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "فشل التحقق");
      setReport({ title: `تقرير التحقق — ${id}`, ok: true, report: j });
      toast({ title: "نجح التحقق", description: `المستوى: ${j.level}` });
    } catch (e) {
      toast({ title: "فشل التحقق", description: e instanceof Error ? e.message : "خطأ", variant: "destructive" });
    } finally {
      setBusyId(null);
      void fetchAll();
    }
  }

  async function onDrill(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/backups/${id}/drill`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "فشل الـ Drill");
      setReport({ title: `تقرير Restore Drill — ${id}`, ok: true, report: j });
      toast({ title: "نجح الـ Drill", description: "النسخة RESTORE_VERIFIED — قاعدة مؤقتة معزولة، لم تُمس قاعدة التشغيل" });
    } catch (e) {
      toast({ title: "فشل الـ Drill", description: e instanceof Error ? e.message : "خطأ", variant: "destructive" });
    } finally {
      setBusyId(null);
      void fetchAll();
    }
  }

  async function onUploadFile(file: File) {
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const dataBase64 = btoa(binary);
      const res = await fetch("/api/backups/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, dataBase64 }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "فُرض الملف");
      setReport({ title: `نتيجة رفع «${file.name}»`, ok: true, report: j });
      toast({ title: "قُبل الملف المرفوع", description: `المستوى: ${j.level} — في المرحل (staging) حصرًا` });
      setUploadOpen(false);
    } catch (e) {
      toast({
        title: "رُفض الملف",
        description: e instanceof Error ? e.message : "خطأ",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      void fetchAll();
    }
  }

  async function onDetails(id: string) {
    setDetailsLoading(true);
    setDetails(null);
    try {
      const res = await fetch(`/api/backups/${id}`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "فشل جلب التفاصيل");
      setDetails(j.manifest as ManifestView);
    } catch (e) {
      toast({ title: "خطأ", description: e instanceof Error ? e.message : "خطأ", variant: "destructive" });
    } finally {
      setDetailsLoading(false);
    }
  }

  const allEntries = React.useMemo(() => {
    if (!data) return [];
    return [...data.local, ...data.uploads];
  }, [data]);

  const totalSize = React.useMemo(() => allEntries.reduce((acc, e) => acc + (e.sizeBytes || 0), 0), [allEntries]);
  const lastCreated = React.useMemo(
    () => allEntries.filter((e) => !e.invalidReason).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0],
    [allEntries]
  );
  const verifiedCount = React.useMemo(
    () => allEntries.filter((e) => e.level === "VALIDATED" || e.level === "RESTORE_VERIFIED").length,
    [allEntries]
  );

  return (
    <div className="space-y-6" dir="rtl">
      {/* بطاقات الملخص */}
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <SummaryCard icon={<DatabaseBackup className="size-4" />} label="النسخ الرسمية" value={String(data?.local.length ?? 0)} tone="emerald" />
        <SummaryCard icon={<ShieldCheck className="size-4" />} label="متحقق منها (VALIDATED+)" value={String(verifiedCount)} tone="teal" />
        <SummaryCard icon={<HardDriveDownload className="size-4" />} label="الحجم الإجمالي للحزم" value={fmtBytes(totalSize)} tone="amber" />
        <SummaryCard icon={<Clockish />} label="آخر نسخة" value={lastCreated ? fmtDate(lastCreated.createdAt) : "—"} tone="slate" />
      </motion.section>

      {/* شريط الإجراءات */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onCreate} disabled={creating || loading} className="gap-1.5" size="sm">
          {creating ? <Loader2 className="size-4 animate-spin" /> : <DatabaseBackup className="size-4" />}
          {creating ? "جارٍ الإنشاء والتحقق…" : "إنشاء نسخة الآن"}
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setUploadOpen(true)} disabled={uploading}>
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          رفع نسخة للتحقق
        </Button>
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => void fetchAll()} disabled={loading}>
          <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          تحديث
        </Button>
        {data && (
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            حدود الرفع: {data.config.maxUploadMB}MB مضغوط · {data.config.maxUncompressedMB}MB غير مضغوط · المحتوى المقبول: {data.config.allowedZipEntries.join(" + ")}
          </span>
        )}
      </div>

      {/* الجدول */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <DatabaseBackup className="size-4 text-emerald-600" />
            النسخ الاحتياطية
          </CardTitle>
          <CardDescription>
            القائمة من الـ Manifest لا من أسماء الملفات — الصلاحية من المحتوى والـ Manifest (D-1). المرفوعات تبقى في المرحل حصرًا.
          </CardDescription>
        </CardHeader>
        <CardContent className="max-h-[32rem] overflow-y-auto p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> جارٍ التحميل…
            </div>
          ) : allEntries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <ShieldQuestion className="size-8 text-slate-300 dark:text-slate-600" />
              <p className="text-sm text-slate-500 dark:text-slate-400">لا توجد نسخ بعد — أنشئ أول نسخة احتياطية.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>المعرف</TableHead>
                  <TableHead className="hidden sm:table-cell">التاريخ</TableHead>
                  <TableHead>المستوى</TableHead>
                  <TableHead className="hidden md:table-cell">الحجم</TableHead>
                  <TableHead className="hidden lg:table-cell">تقارير/مستخدمون</TableHead>
                  <TableHead className="hidden lg:table-cell">periodRange</TableHead>
                  <TableHead className="text-left">إجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allEntries.map((e) => (
                  <TableRow key={`${e.source}-${e.fileName}`} className={cn(e.invalidReason && "bg-rose-50/50 dark:bg-rose-950/20")}>
                    <TableCell className="font-mono text-[11px] leading-tight">
                      <div className="font-sans font-semibold text-slate-800 dark:text-slate-100">{e.backupId}</div>
                      <div className="text-[10px] text-slate-400">
                        {e.source === "local" ? "رسمية" : "مرفوعة (staging)"} · {e.backupType} · v{e.appVersion}
                      </div>
                      {e.manifestFormat !== 0 && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {e.manifestFormat === 2 ? (
                            <span className="rounded border border-amber-300 bg-amber-50 px-1 py-0.5 text-[9px] font-sans font-semibold text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300" title="Manifest إرث v2 — يُستخرج الـ canonical من database.db وقت التحقق">
                              Legacy v2
                            </span>
                          ) : (
                            <span className="rounded border border-emerald-300 bg-emerald-50 px-1 py-0.5 text-[9px] font-sans font-semibold text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                              Manifest v3
                            </span>
                          )}
                          {e.canonicalFingerprintShort && (
                            <span className="font-mono text-[9px] text-slate-400" dir="ltr">c:{e.canonicalFingerprintShort}</span>
                          )}
                        </div>
                      )}
                      {e.invalidReason && <div className="mt-1 text-[10px] text-rose-600 dark:text-rose-400">{e.invalidReason}</div>}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-xs">
                      {fmtDate(e.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("gap-1 text-[10px]", levelBadgeClass(e.level))}>
                        {e.level === "INVALID" ? <ShieldAlert className="size-3" /> : e.level === "RESTORE_VERIFIED" ? <ShieldCheck className="size-3" /> : <ShieldCheck className="size-3" />}
                        {LEVEL_LABELS[e.level]}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs">{fmtBytes(e.sizeBytes)}</TableCell>
                    <TableCell className="hidden lg:table-cell text-xs">
                      {e.counts ? `${e.counts.reports} / ${e.counts.users}` : "—"}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-[10px] text-slate-500">
                      {e.periodRange?.minPeriodEnd || e.periodRange?.maxPeriodEnd
                        ? `${e.periodRange?.minPeriodEnd ?? "؟"} → ${e.periodRange?.maxPeriodEnd ?? "؟"}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-left">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-[11px]" onClick={() => void onDetails(e.backupId)}>
                          <FileJson className="size-3.5" /> تفاصيل
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1 px-2 text-[11px]"
                          disabled={!!e.invalidReason || busyId === e.backupId}
                          onClick={() => void onValidate(e.backupId)}
                        >
                          {busyId === e.backupId ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                          تحقق
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1 px-2 text-[11px]"
                          disabled={!!e.invalidReason || busyId === e.backupId}
                          onClick={() => void onDrill(e.backupId)}
                        >
                          <PlayCircle className="size-3.5" />
                          Drill
                        </Button>
                        <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-[11px]" disabled={!!e.invalidReason} asChild>
                          <a href={`/api/backups/${e.backupId}/download`} download>
                            <Download className="size-3.5" /> تنزيل
                          </a>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* سجل الاسترجاع التشغيلي */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Info className="size-4 text-amber-600" />
            السجل التشغيلي الخارجي (Recovery Log)
          </CardTitle>
          <CardDescription>
            خارج قاعدة البيانات — يبقى بعد أي استعادة. Append-only: لا يوجد أي تعديل/حذف عبر API.
            operationId يربط كل عملية من بدايتها لنهايتها.
          </CardDescription>
        </CardHeader>
        <CardContent className="max-h-96 overflow-y-auto">
          {recoveryLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> جارٍ التحميل…
            </div>
          ) : recovery.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">لا أحداث بعد.</p>
          ) : (
            <div className="space-y-1.5">
              {recovery.map((ev) => (
                <div
                  key={ev.eventId}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs dark:border-slate-800"
                >
                  <span
                    className={cn(
                      "inline-block size-2 shrink-0 rounded-full",
                      ev.result === "success" ? "bg-emerald-500" : ev.result === "failure" ? "bg-rose-500" : "bg-slate-400"
                    )}
                    aria-hidden
                  />
                  <span className="font-semibold text-slate-800 dark:text-slate-100">
                    {RECOVERY_EVENT_LABELS[ev.event] ?? ev.event}
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">{fmtDate(ev.timestamp)}</span>
                  <span className="text-slate-500 dark:text-slate-400">
                    بواسطة: {ev.actor?.username || "نظامي"}
                  </span>
                  {ev.backupId && <span className="font-mono text-[10px] text-slate-500">{ev.backupId}</span>}
                  <span className="ms-auto rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[9px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    {ev.operationId}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* بطاقة السياسة */}
      {data?.policy && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Info className="size-4 text-slate-500" />
              سياسة النسخ والاسترجاع (معتمدة)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {Object.entries(data.policy).map(([k, v]) => (
                <li key={k} className="flex gap-2">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-slate-400" aria-hidden />
                  <span>{v}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* حوار الرفع */}
      <Dialog open={uploadOpen} onOpenChange={(o) => !uploading && setUploadOpen(o)}>
        <DialogContent className="sm:max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="size-4 text-emerald-600" /> رفع نسخة للتحقق
            </DialogTitle>
            <DialogDescription>
              ZIP يحتوي database.db + manifest.json حصرًا. يُفحص بأمن صارم ثم يُتحقق منه — ويبقى في المرحل
              (staging) فقط دون دخول النسخ الرسمية. لا يمس قاعدة التشغيل إطلاقًا.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="backup-upload-file">ملف الحزمة (ZIP)</Label>
            <Input
              id="backup-upload-file"
              type="file"
              accept=".zip,application/zip"
              disabled={uploading}
              onChange={(ev) => {
                const f = ev.target.files?.[0];
                if (f) void onUploadFile(f);
              }}
            />
            <p className="text-[11px] text-slate-500">
              الحدود: {data?.config.maxUploadMB ?? 200}MB مضغوط · {data?.config.maxUncompressedMB ?? 500}MB غير مضغوط.
              رفض zip-slip/symlink/الأرشيفات المتداخلة/الملفات الزائدة تلقائيًا.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)} disabled={uploading}>
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار التفاصيل */}
      <Dialog open={!!details || detailsLoading} onOpenChange={(o) => !o && setDetails(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileJson className="size-4 text-emerald-600" /> تفاصيل الـ Manifest
            </DialogTitle>
            <DialogDescription>
              حقول الـ Manifest (v3 الحالي أو v2 إرث) — لا أسرار ولا هاشات كلمات مرور ولا مسارات داخلية.
            </DialogDescription>
          </DialogHeader>
          {detailsLoading || !details ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> جارٍ التحميل…
            </div>
          ) : (
            <div className="space-y-4 text-xs">
              <div className="grid gap-2 sm:grid-cols-2">
                <Kv k="backupId" v={details.backupId} mono />
                <Kv k="backupType" v={details.backupType} />
                <Kv k="createdAt" v={fmtDate(details.createdAt)} />
                <Kv k="createdBy (وصفية)" v={details.createdBy?.username || "—"} />
                <Kv k="appVersion" v={details.appVersion} />
                <Kv k="schemaVersion" v={details.schemaVersion} />
                <Kv
                  k="formatVersion"
                  v={details.formatVersion === 3 ? "3 (canonical مضمّن)" : "2 (إرث — legacy)"}
                />
                <Kv k="verification.level" v={details.verification?.level ?? ""} />
                <Kv
                  k="verification.drillRuns"
                  v={typeof details.verification?.drillRuns === "number" ? `${details.verification.drillRuns} تشغيل ناجح` : "—"}
                />
                <Kv k="integrityCheck" v={details.database?.integrityCheck ?? ""} />
                <Kv k="database.bytes" v={fmtBytes(details.database?.bytes ?? 0)} />
                <Kv k="journalModeAtBackup" v={details.database?.journalModeAtBackup ?? ""} />
                <Kv
                  k="periodRange"
                  v={`${details.periodRange?.minPeriodEnd ?? "—"} → ${details.periodRange?.maxPeriodEnd ?? "—"}`}
                />
                <Kv
                  k="counts"
                  v={
                    details.counts
                      ? `تقارير ${details.counts.reports} · مستخدمون ${details.counts.users} · مجموعات ${details.counts.groups}`
                      : "—"
                  }
                />
                {details.uploadInfo && (
                  <Kv k="رفع أصلي (عرض)" v={details.uploadInfo.originalNameSanitized} />
                )}
              </div>
              {details.canonicalSchemaFingerprint && (
                <div>
                  <div className="mb-1 font-semibold text-slate-700 dark:text-slate-200">
                    البصمة القاعدية الدلالية canonicalSchemaFingerprint (الحاكمة — 4A.1)
                  </div>
                  <div className="break-all rounded-md bg-slate-100 p-2 font-mono text-[10px] text-slate-700 dark:bg-slate-800 dark:text-slate-300" dir="ltr">
                    {details.canonicalSchemaFingerprint}
                  </div>
                </div>
              )}
              <div>
                <div className="mb-1 font-semibold text-slate-700 dark:text-slate-200">SHA-256 لقاعدة البيانات (للتحقق الخارجي اليدوي)</div>
                <div className="break-all rounded-md bg-slate-100 p-2 font-mono text-[10px] text-slate-700 dark:bg-slate-800 dark:text-slate-300" dir="ltr">
                  {details.database?.sha256}
                </div>
              </div>
              {details.formatVersion === 2 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                  Manifest إرث (legacy v2، سابق 4A.1): بلا بصمة canonical مضمّنة — تُستخرج من database.db
                  نفسها عند كل تحقق ويُعاد تصنيفه كما هو دون أي ترقية صامتة.
                </div>
              )}
              <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                {details.authenticity?.note}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetails(null)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار تقارير التحقق/الـ Drill/الرفع */}
      <Dialog open={!!report} onOpenChange={(o) => !o && setReport(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {report?.ok ? <ShieldCheck className="size-4 text-emerald-600" /> : <ShieldAlert className="size-4 text-rose-600" />}
              {report?.title}
            </DialogTitle>
            <DialogDescription>
              {report?.report?.level ? `المستوى الناتج: ${report.report.level}` : ""}{" "}
              {report?.report?.durationMs ? `· المدة: ${(report.report.durationMs / 1000).toFixed(2)} ثانية` : ""}
            </DialogDescription>
          </DialogHeader>
          {report && (
            <div className="space-y-3 text-xs">
              <ChecksList title="المراحل والفحوص" checks={report.report.steps ?? report.report.checks ?? []} />
              {report.report.prismaReadTests && report.report.prismaReadTests.length > 0 && (
                <ChecksList title="اختبارات قراءة Prisma على القاعدة المؤقتة" checks={report.report.prismaReadTests} />
              )}
              {report.report.warnings && report.report.warnings.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                  <div className="mb-1 font-semibold">تحذيرات sanity:</div>
                  <ul className="list-inside list-disc space-y-0.5">
                    {report.report.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="rounded-md bg-slate-50 p-2 text-[11px] text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                كل الفحوص نفّذت على نسخ مرحلية معزولة — قاعدة التشغيل لم تُلمس إطلاقًا.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReport(null)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  عناصر صغيرة                                                             */
/* ──────────────────────────────────────────────────────────────────────── */

function ChecksList({ title, checks }: { title: string; checks: CheckResult[] }) {
  if (checks.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 font-semibold text-slate-700 dark:text-slate-200">{title}</div>
      <div className="space-y-1">
        {checks.map((c, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1 dark:border-slate-800">
            <span className={cn("size-1.5 rounded-full", c.ok ? "bg-emerald-500" : "bg-rose-500")} aria-hidden />
            <span className="text-slate-700 dark:text-slate-200">{c.name}</span>
            {c.detail && <span className="text-[10px] text-slate-400">{c.detail}</span>}
            {typeof c.ms === "number" && <span className="ms-auto font-mono text-[10px] text-slate-400">{c.ms}ms</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Kv({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="rounded-md border border-slate-200 px-2 py-1.5 dark:border-slate-800">
      <div className="text-[10px] text-slate-400">{k}</div>
      <div className={cn("font-semibold text-slate-800 dark:text-slate-100", mono && "font-mono text-[11px]")} dir={mono ? "ltr" : undefined}>
        {v}
      </div>
    </div>
  );
}

function Clockish() {
  return <RefreshCw className="size-4" />;
}

function SummaryCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "emerald" | "teal" | "amber" | "slate";
}) {
  const tones: Record<string, string> = {
    emerald: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
    teal: "bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400",
    amber: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
    slate: "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300",
  };
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
      <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", tones[tone])}>{icon}</div>
      <div className="min-w-0 leading-tight">
        <div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
        <div className="truncate text-sm font-bold text-slate-800 dark:text-slate-100">{value}</div>
      </div>
    </div>
  );
}
