"use client";

// Phase 6.2A — تبويب «دليل الحسابات وقواعد التصنيف» (التصميم النهائي المعتمد):
//   1) الجذور النظامية الثابتة 1/2/3/4 — للقراءة فقط (لا إنشاء/تعديل/حذف إطلاقًا).
//   2) البادئات التفصيلية لكل شركة — تُعدّ مرة واحدة وتُعاد استخدامها في كل
//      الفترات والسنوات، مع هرمية بصرية (ترتيب البادئات + إزاحة طبقات) وربط
//      اختياري ببند قائمة مالية — إنشاء/تعديل/تفعيل/حذف بأسباب تدقيق.
//   3) استثناءات الحسابات المحددة (Account Override) — أولويتها فوق كل بادئة.
//   4) مرجع بنود القوائم المالية — قراءة فقط (بناء القوائم لاحقًا).
//   5) مُختبر الحل — الحل الخادمي المركزي نفسه الذي ستستهلكه التقارير: الحالة
//      (FULLY_MAPPED / ROOT_ONLY / NEEDS_DETAILED_CLASSIFICATION / NEEDS_CLASSIFICATION).
//   6) نسخ خريطة شركة إلى شركة — نسخة مستقلة تمامًا بعد الإنشاء.
// منطق FLOW/BALANCE الحسابي لا يعيش هنا — هنا عرض وإدارة قواعد فقط.

import * as React from "react";
import { useSession } from "next-auth/react";
import {
  Copy, FlaskConical, ListTree, Loader2, Lock, Pencil, Plus, Power, RefreshCw, ScrollText, Tag, Trash2, TriangleAlert,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ACCOUNT_CLASSIFICATION_LABELS,
  ACCOUNT_CLASSIFICATIONS,
  AGGREGATION_BEHAVIOR_LABELS,
  AGGREGATION_BEHAVIORS,
  MAPPING_SOURCE_LABELS,
  MAPPING_STATUS_LABELS,
  MAIN_CATEGORY_LABELS,
  ROOT2_CLASSIFICATION_HINT,
  SUGGESTED_BEHAVIOR_BY_CLASSIFICATION,
  STATEMENT_TYPE_LABELS,
  accountRootDigit,
  isStatementLineConsistent,
  type AccountClassification,
  type AggregationBehavior,
  type MappingStatus,
} from "@/lib/account-nature";
import { canManageAccountNature, parsePermissions } from "@/lib/permissions";

interface CompanyOption { id: string; code: string; nameAr: string; status: string; }
interface LineRef { code: string; nameAr: string; statementType: string; }
interface RuleRow {
  id: string;
  companyId: string | null;
  company?: { code: string; nameAr: string } | null;
  prefix: string;
  mainCategory: string | null;
  classification: string | null;
  aggregationBehavior: string;
  statementLine?: LineRef | null;
  source: string;
  note: string;
  isActive: boolean;
  version: number;
  createdByName: string;
  updatedByName: string;
}
interface OverrideRow {
  id: string;
  companyId: string;
  company?: { code: string; nameAr: string } | null;
  accountCode: string;
  classification: string;
  aggregationBehavior: string;
  statementLine?: LineRef | null;
  note: string;
  isActive: boolean;
  version: number;
  createdByName: string;
  updatedByName: string;
}
interface StatementLineRow {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  statementType: string;
  parentId: string | null;
  parent?: { code: string; nameAr: string } | null;
  displayOrder: number;
  isSubtotal: boolean;
  isActive: boolean;
  version: number;
}
interface MappingResultRow {
  accountCode: string;
  mainCategory: string | null;
  classification: string | null;
  aggregationBehavior: string | null;
  statementType: string | null;
  statementLineCode: string | null;
  statementLineNameAr: string | null;
  source: string | null;
  matchedPrefix: string | null;
  rootPrefix: string | null;
  companyPrefix: string | null;
  mappingStatus: MappingStatus;
}

const CLASSIFICATION_BADGE: Record<string, string> = {
  ASSET: "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  LIABILITY: "bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  EQUITY: "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  REVENUE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  EXPENSE: "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  OTHER: "bg-stone-100 text-stone-700 dark:bg-stone-950/60 dark:text-stone-300",
};

const STATUS_BADGE: Record<MappingStatus, string> = {
  FULLY_MAPPED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  ROOT_ONLY: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  NEEDS_DETAILED_CLASSIFICATION: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
  NEEDS_CLASSIFICATION: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

/** عمق بصري للهرمية حسب طول البادئة (1⇒جذر، 2⇒مجموعة، 3-4⇒بند، 5+⇒تفصيلي). */
function prefixDepth(prefix: string): number {
  return Math.min(Math.max(prefix.length - 1, 0), 3);
}

function ClassificationBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-xs text-muted-foreground" title="الجذر مركّب — يحتاج بادئة شركة تفصيلية">غير محسوم</span>;
  return (
    <Badge className={CLASSIFICATION_BADGE[value] ?? ""}>
      {ACCOUNT_CLASSIFICATION_LABELS[value as AccountClassification] ?? value}
    </Badge>
  );
}

function StatusBadge({ status }: { status: MappingStatus }) {
  return <Badge className={STATUS_BADGE[status]}>{MAPPING_STATUS_LABELS[status]}</Badge>;
}

/** اختيار بند مالي مُصفّى اتساقًا مع التصنيف (نفس حاجز الخادم — عرض فقط). */
function StatementLineSelect({
  value, onChange, lines, classification,
}: {
  value: string;
  onChange: (v: string) => void;
  lines: StatementLineRow[];
  classification: string;
}) {
  const consistent = lines.filter(
    (l) => l.isActive && isStatementLineConsistent(classification as AccountClassification, l.statementType)
  );
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label="بند القائمة المالية">
        <SelectValue placeholder="— بلا بند (ROOT_ONLY) —" />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        <SelectItem value="__none__">— بلا بند (ROOT_ONLY) —</SelectItem>
        {consistent.map((l) => (
          <SelectItem key={l.code} value={l.code}>
            {l.code} — {l.nameAr} ({STATEMENT_TYPE_LABELS[l.statementType as keyof typeof STATEMENT_TYPE_LABELS] ?? l.statementType})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AccountNatureTab() {
  const { data: session } = useSession();
  const { toast } = useToast();

  const perms = React.useMemo(() => {
    if (!session?.user) return null;
    const raw = (session.user as any).permissions;
    if (typeof raw === "string") return parsePermissions(raw);
    if (raw && typeof raw === "object") return parsePermissions(JSON.stringify(raw));
    return null;
  }, [session]);

  const role = ((session?.user as any)?.role as string) || "user";
  const canManage = perms ? canManageAccountNature(perms, role) : false;

  const [rules, setRules] = React.useState<RuleRow[]>([]);
  const [overrides, setOverrides] = React.useState<OverrideRow[]>([]);
  const [lines, setLines] = React.useState<StatementLineRow[]>([]);
  const [companies, setCompanies] = React.useState<CompanyOption[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = React.useState<string>("");
  const [loading, setLoading] = React.useState(true);

  /* ── dialog state ── */
  const [addPrefixOpen, setAddPrefixOpen] = React.useState(false);
  const [editPrefix, setEditPrefix] = React.useState<RuleRow | null>(null);
  const [deletePrefix, setDeletePrefix] = React.useState<RuleRow | null>(null);
  const [addOverrideOpen, setAddOverrideOpen] = React.useState(false);
  const [editOverride, setEditOverride] = React.useState<OverrideRow | null>(null);
  const [deleteOverride, setDeleteOverride] = React.useState<OverrideRow | null>(null);
  const [copyOpen, setCopyOpen] = React.useState(false);

  /* ── tester state ── */
  const [testerCodes, setTesterCodes] = React.useState("");
  const [testerResults, setTesterResults] = React.useState<MappingResultRow[] | null>(null);
  const [testerSummary, setTesterSummary] = React.useState<{ total: number; fullyMapped: number; needsAttention: number; unclassified: number } | null>(null);
  const [testing, setTesting] = React.useState(false);

  const systemRoots = React.useMemo(() => rules.filter((r) => r.companyId === null), [rules]);
  const companyPrefixes = React.useMemo(
    () =>
      rules
        .filter((r) => r.companyId === selectedCompanyId)
        .sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0)),
    [rules, selectedCompanyId]
  );
  const companyOverrides = React.useMemo(
    () => overrides.filter((o) => o.companyId === selectedCompanyId),
    [overrides, selectedCompanyId]
  );

  const loadAll = React.useCallback(async () => {
    try {
      const [rulesRes, overridesRes, linesRes, companiesRes] = await Promise.all([
        fetch("/api/account-nature/rules", { cache: "no-store" }),
        fetch("/api/account-nature/overrides", { cache: "no-store" }),
        fetch("/api/account-nature/statement-lines", { cache: "no-store" }),
        fetch("/api/companies", { cache: "no-store" }),
      ]);
      const rulesData = await rulesRes.json().catch(() => null);
      if (!rulesRes.ok) throw new Error(rulesData?.error || `HTTP ${rulesRes.status}`);
      setRules(Array.isArray(rulesData) ? rulesData : []);
      if (overridesRes.ok) {
        const od = await overridesRes.json().catch(() => null);
        setOverrides(Array.isArray(od) ? od : []);
      }
      if (linesRes.ok) {
        const ld = await linesRes.json().catch(() => null);
        setLines(Array.isArray(ld) ? ld : []);
      }
      if (companiesRes.ok) {
        const cd = await companiesRes.json().catch(() => null);
        const list: CompanyOption[] = Array.isArray(cd) ? cd : [];
        setCompanies(list);
        setSelectedCompanyId((prev) => (prev && list.some((c) => c.id === prev) ? prev : list[0]?.id ?? ""));
      }
    } catch (e) {
      toast({ title: "تعذر جلب بيانات دليل الحسابات", description: e instanceof Error ? e.message : "", variant: "destructive" });
    }
  }, [toast]);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      await loadAll();
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [loadAll]);

  const runResolve = async () => {
    const codes = testerCodes.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
    if (codes.length === 0) {
      toast({ title: "أدخل كود حساب واحدًا على الأقل", variant: "destructive" });
      return;
    }
    setTesting(true);
    setTesterResults(null);
    try {
      const res = await fetch("/api/account-nature/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: selectedCompanyId || null, codes }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setTesterResults(data.results ?? []);
      setTesterSummary(data.summary ?? null);
    } catch (e) {
      toast({ title: "فشل الحل", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  const selectedCompany = companies.find((c) => c.id === selectedCompanyId);

  return (
    <div className="space-y-6" dir="rtl">
      {/* ── الجذور النظامية الثابتة (LEVEL 1) ── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Lock className="size-4" />
              الجذور الرئيسية الثابتة للنظام (LEVEL 1)
            </CardTitle>
            <CardDescription>
              الهيكل الرئيسي المعتمد: 1 = الأصول و2 = الخصوم وحقوق الملكية (BALANCE)، 3 = المصروفات و4 = الإيرادات (FLOW).
              الجذر «2» مركّب (LIABILITIES AND EQUITY) — الفصل بين الالتزامات وحقوق الملكية يتم عبر البادئات التفصيلية لكل شركة.
              البادئات القديمة 5/6/7 ليست قواعد نظامية في المحرك الجديد (تبقى في الدليل القديم للتوافق فقط).
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => { setLoading(true); loadAll().finally(() => setLoading(false)); }} aria-label="تحديث البيانات">
            <RefreshCw className={"size-3.5" + (loading ? " animate-spin" : "")} />
          </Button>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">الجذر</TableHead>
                  <TableHead className="text-right">الفئة الرئيسية</TableHead>
                  <TableHead className="text-right">التصنيف التفصيلي</TableHead>
                  <TableHead className="text-right">سلوك التجميع</TableHead>
                  <TableHead className="text-right">التوضيح</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {systemRoots.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-sm font-semibold">{r.prefix}</TableCell>
                    <TableCell className="text-sm">{r.mainCategory ? MAIN_CATEGORY_LABELS[r.mainCategory as keyof typeof MAIN_CATEGORY_LABELS] ?? r.mainCategory : "—"}</TableCell>
                    <TableCell><ClassificationBadge value={r.classification} /></TableCell>
                    <TableCell className="text-sm">{AGGREGATION_BEHAVIOR_LABELS[r.aggregationBehavior as AggregationBehavior] ?? r.aggregationBehavior}</TableCell>
                    <TableCell className="max-w-md text-xs text-muted-foreground" title={r.note}>{r.note}</TableCell>
                  </TableRow>
                ))}
                {systemRoots.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-16 text-center text-sm text-muted-foreground">
                      لم تُحمّل الجذور النظامية — تحقق من القاعدة.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            الجذور ثابتة للقراءة فقط (seed نظامي) — أي حسم إضافي يتم عبر البادئات التفصيلية والاستثناءات أدناه.
          </p>
        </CardContent>
      </Card>

      {/* ── البادئات التفصيلية للشركة (LEVEL 2) ── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <ListTree className="size-4" />
              البادئات التفصيلية للشركة (LEVEL 2)
            </CardTitle>
            <CardDescription>
              إعداد مرة واحدة لكل شركة ثم يُعاد استخدامه تلقائيًا في جميع الفترات والسنوات — لا يُعاد إدخاله عند رفع ميزان المراجعة.
              الحل بأطول بادئة مطابقة (LONGEST PREFIX MATCH WINS) — مثال: 11010105 ⇒ 1101.
              كل شركة تحدد بادئاتها بنفسها؛ نفس الكود لا يعني نفس البند في جميع الشركات.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {canManage && companies.length > 0 && (
              <>
                <Button variant="outline" size="sm" onClick={() => setCopyOpen(true)} aria-label="نسخ خريطة من شركة">
                  <Copy className="size-3.5" />
                  نسخ من شركة
                </Button>
                <Button size="sm" onClick={() => setAddPrefixOpen(true)} disabled={!selectedCompanyId}>
                  <Plus className="size-3.5" />
                  بادئة جديدة
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-[280px_1fr] md:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="prefix-company">الشركة</Label>
              <Select value={selectedCompanyId} onValueChange={setSelectedCompanyId}>
                <SelectTrigger id="prefix-company" aria-label="اختيار الشركة">
                  <SelectValue placeholder={companies.length === 0 ? "لا توجد شركات" : "اختر شركة"} />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.code} — {c.nameAr}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {companies.length === 0 && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                لا توجد شركات بعد — أنشئ الشركة من تبويب «الشركات والسنوات المالية» أولًا.
              </p>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">البادئة</TableHead>
                  <TableHead className="text-right">اسم التصنيف</TableHead>
                  <TableHead className="text-right">التصنيف</TableHead>
                  <TableHead className="text-right">سلوك التجميع</TableHead>
                  <TableHead className="text-right">بند القائمة المالية</TableHead>
                  <TableHead className="text-right">الحالة</TableHead>
                  <TableHead className="text-right">ملاحظة</TableHead>
                  {canManage && <TableHead className="text-left">إجراءات</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {companyPrefixes.map((r) => (
                  <TableRow key={r.id} className={!r.isActive ? "opacity-60" : undefined}>
                    <TableCell
                      className="font-mono text-sm"
                      style={{ paddingInlineStart: `${prefixDepth(r.prefix) * 20 + 12}px` }}
                    >
                      {r.prefix.length >= 3 ? <span className="text-muted-foreground">└ </span> : null}
                      {r.prefix}
                    </TableCell>
                    <TableCell className="text-sm">{r.mainCategory ? MAIN_CATEGORY_LABELS[r.mainCategory as keyof typeof MAIN_CATEGORY_LABELS] ?? r.mainCategory : "—"}</TableCell>
                    <TableCell><ClassificationBadge value={r.classification} /></TableCell>
                    <TableCell className="text-sm">
                      <span className="whitespace-nowrap">{AGGREGATION_BEHAVIOR_LABELS[r.aggregationBehavior as AggregationBehavior] ?? r.aggregationBehavior}</span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.statementLine ? (
                        <span>
                          <Badge variant="outline" className="me-1 px-1 py-0 text-[9px]" title={STATEMENT_TYPE_LABELS[r.statementLine.statementType as keyof typeof STATEMENT_TYPE_LABELS] ?? r.statementLine.statementType}>
                            {r.statementLine.statementType === "PROFIT_OR_LOSS" ? "الدخل" : "المركز المالي"}
                          </Badge>
                          <span className="font-mono text-xs">{r.statementLine.code}</span> — {r.statementLine.nameAr}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">— بلا بند (ROOT_ONLY)</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {r.isActive
                        ? <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">نشطة</Badge>
                        : <Badge variant="secondary">معطلة</Badge>}
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-xs text-muted-foreground" title={r.note}>{r.note}</TableCell>
                    {canManage && (
                      <TableCell className="text-left">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost" size="sm"
                            aria-label={r.isActive ? `تعطيل بادئة ${r.prefix}` : `تفعيل بادئة ${r.prefix}`}
                            onClick={() => setEditPrefix(r)}
                          >
                            <Power className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" aria-label={`تعديل بادئة ${r.prefix}`} onClick={() => setEditPrefix(r)}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" aria-label={`حذف بادئة ${r.prefix}`} onClick={() => setDeletePrefix(r)}>
                            <Trash2 className="size-3.5 text-rose-600" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {selectedCompanyId && companyPrefixes.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={canManage ? 8 : 7} className="h-20 text-center text-sm text-muted-foreground">
                      لا بادئات تفصيلية لهذه الشركة بعد — أضف دليلها التفصيلي (أرقام الأقسام توضيحية فقط لكل شركة).
                    </TableCell>
                  </TableRow>
                )}
                {!selectedCompanyId && (
                  <TableRow>
                    <TableCell colSpan={canManage ? 8 : 7} className="h-20 text-center text-sm text-muted-foreground">
                      اختر شركة لعرض بادئاتها التفصيلية.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ── استثناءات الحسابات المحددة ── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Tag className="size-4" />
              استثناءات الحسابات المحددة (Account Override)
            </CardTitle>
            <CardDescription>
              أولوية الاستثناء حاكمة: استثناء حساب محدد يفوز على أي بادئة شركة أو جذر نظامي.
              مثال: بادئة 31 ⇒ مصروفات، لكن الحساب 310199 باستثناء «مصروفات إدارية» ⇒ الاستثناء يفوز.
            </CardDescription>
          </div>
          {canManage && (
            <Button size="sm" onClick={() => setAddOverrideOpen(true)} disabled={!selectedCompanyId}>
              <Plus className="size-3.5" />
              استثناء جديد
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <div className="max-h-80 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">كود الحساب</TableHead>
                  <TableHead className="text-right">التصنيف</TableHead>
                  <TableHead className="text-right">سلوك التجميع</TableHead>
                  <TableHead className="text-right">بند القائمة المالية</TableHead>
                  <TableHead className="text-right">الحالة</TableHead>
                  <TableHead className="text-right">ملاحظة</TableHead>
                  {canManage && <TableHead className="text-left">إجراءات</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {companyOverrides.map((o) => (
                  <TableRow key={o.id} className={!o.isActive ? "opacity-60" : undefined}>
                    <TableCell className="font-mono text-sm font-semibold">{o.accountCode}</TableCell>
                    <TableCell><ClassificationBadge value={o.classification} /></TableCell>
                    <TableCell className="text-sm">{AGGREGATION_BEHAVIOR_LABELS[o.aggregationBehavior as AggregationBehavior] ?? o.aggregationBehavior}</TableCell>
                    <TableCell className="text-sm">
                      {o.statementLine
                        ? <span><span className="font-mono text-xs">{o.statementLine.code}</span> — {o.statementLine.nameAr}</span>
                        : <span className="text-xs text-muted-foreground">— بلا بند (ROOT_ONLY)</span>}
                    </TableCell>
                    <TableCell>
                      {o.isActive
                        ? <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">نشط</Badge>
                        : <Badge variant="secondary">معطل</Badge>}
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-xs text-muted-foreground" title={o.note}>{o.note}</TableCell>
                    {canManage && (
                      <TableCell className="text-left">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" aria-label={`تعديل استثناء ${o.accountCode}`} onClick={() => setEditOverride(o)}>
                            <Pencil className="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" aria-label={`حذف استثناء ${o.accountCode}`} onClick={() => setDeleteOverride(o)}>
                            <Trash2 className="size-3.5 text-rose-600" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {selectedCompanyId && companyOverrides.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={canManage ? 7 : 6} className="h-16 text-center text-sm text-muted-foreground">
                      لا استثناءات لهذه الشركة — البادئات التفصيلية كافية عادةً، والاستثناء للحوافّ الفردية.
                    </TableCell>
                  </TableRow>
                )}
                {!selectedCompanyId && (
                  <TableRow>
                    <TableCell colSpan={canManage ? 7 : 6} className="h-16 text-center text-sm text-muted-foreground">
                      اختر شركة لعرض استثناءاتها.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ── مُختبر الحل ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="size-4" />
            مُختبر الحل (Mapping Resolver)
          </CardTitle>
          <CardDescription>
            أدخل أكواد حسابات (كود لكل سطر) — النتيجة من الحل الخادمي المركزي نفسه الذي ستستهلكه التقارير لاحقًا،
            بنفس أولوية: استثناء الحساب ثم أطول بادئة شركة ثم الجذر النظامي. ROOT_ONLY لا يصلح لإصدار قائمة نهائية.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[1fr_240px]">
            <div className="space-y-2">
              <Label htmlFor="mapping-codes">أكواد الحسابات</Label>
              <Textarea
                id="mapping-codes"
                placeholder={"11010105\n210101\n230101\n310199\n9999"}
                value={testerCodes}
                onChange={(e) => setTesterCodes(e.target.value)}
                rows={5}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mapping-company">نطاق الحل</Label>
              <Select value={selectedCompanyId || "__none__"} onValueChange={(v) => v !== "__none__" && setSelectedCompanyId(v)}>
                <SelectTrigger id="mapping-company" aria-label="نطاق الحل">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.code} — {c.nameAr}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button className="w-full" onClick={runResolve} disabled={testing || !selectedCompanyId}>
                {testing ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
                حلّ الخريطة
              </Button>
            </div>
          </div>

          {testerResults && (
            <div className="space-y-2">
              {testerSummary && (
                <p className="text-sm text-muted-foreground">
                  الإجمالي: {testerSummary.total} —{" "}
                  <span className="font-semibold text-emerald-700 dark:text-emerald-400">مصنّفة بالكامل: {testerSummary.fullyMapped}</span> —{" "}
                  <span className="font-semibold text-amber-600 dark:text-amber-400">تحتاج اهتمامًا: {testerSummary.needsAttention}</span> —{" "}
                  <span className="font-semibold text-rose-600 dark:text-rose-400">غير مصنفة: {testerSummary.unclassified}</span>
                </p>
              )}
              {/* 6.7 — عرض صريح: حسابات تحتاج إلى تصنيف (لا تُصنّف بصمت كـ OTHER) */}
              {testerSummary && testerSummary.needsAttention > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                  <p className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
                    <TriangleAlert className="size-4" />
                    حسابات تحتاج إلى تصنيف: {testerSummary.needsAttention}
                    {testerSummary.unclassified > 0 && <> — منها غير مصنفة إطلاقًا: {testerSummary.unclassified}</>}
                  </p>
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    هذه الحسابات لن تظهر في القوائم النهائية حتى تُصنّف — أضف بادئة تفصيلية أو استثناء حساب، ثم أعد التحقق من ميزان المراجعة.
                    النظام لا يصنف الحسابات غير المعروفة بصمت كـ OTHER.
                  </p>
                </div>
              )}
              <div className="max-h-96 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-right">الكود</TableHead>
                      <TableHead className="text-right">الحالة</TableHead>
                      <TableHead className="text-right">الفئة الرئيسية</TableHead>
                      <TableHead className="text-right">التصنيف</TableHead>
                      <TableHead className="text-right">السلوك</TableHead>
                      <TableHead className="text-right">البند المالي</TableHead>
                      <TableHead className="text-right">المصدر</TableHead>
                      <TableHead className="text-right">البادئة المطابقة</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {testerResults.map((r, i) => (
                      <TableRow
                        key={`${r.accountCode}-${i}`}
                        className={r.mappingStatus !== "FULLY_MAPPED" ? "bg-amber-50/60 dark:bg-amber-950/20" : undefined}
                      >
                        <TableCell className="font-mono text-sm">{r.accountCode || "—"}</TableCell>
                        <TableCell><StatusBadge status={r.mappingStatus} /></TableCell>
                        <TableCell className="text-sm">{r.mainCategory ? MAIN_CATEGORY_LABELS[r.mainCategory as keyof typeof MAIN_CATEGORY_LABELS] ?? r.mainCategory : "—"}</TableCell>
                        <TableCell><ClassificationBadge value={r.classification} /></TableCell>
                        <TableCell className="text-sm">{r.aggregationBehavior ? AGGREGATION_BEHAVIOR_LABELS[r.aggregationBehavior as AggregationBehavior] : "—"}</TableCell>
                        <TableCell className="text-sm">
                          {r.statementLineCode
                            ? <span><span className="font-mono text-xs">{r.statementLineCode}</span> — {r.statementLineNameAr}</span>
                            : <span className="text-xs text-muted-foreground">لا بند — لا قائمة نهائية</span>}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.source ? MAPPING_SOURCE_LABELS[r.source as keyof typeof MAPPING_SOURCE_LABELS] ?? r.source : "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {r.matchedPrefix ? <span className="font-mono">{r.matchedPrefix}</span> : "لا يوجد"}
                          {r.rootPrefix ? <span className="text-xs"> (جذر: <span className="font-mono">{r.rootPrefix}</span>)</span> : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── مرجع بنود القوائم المالية (قراءة فقط) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="size-4" />
            مرجع بنود القوائم المالية (قراءة فقط)
          </CardTitle>
          <CardDescription>
            بنود مرجعية هرمية تُربط بها البادئات والاستثناءات — بناء القوائم المالية نفسه (المركز المالي / الربح والخسارة /
            الدخل الشامل الآخر) مرحلة لاحقة ولا يُنفذ هنا.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">الكود</TableHead>
                  <TableHead className="text-right">الاسم بالعربية</TableHead>
                  <TableHead className="text-right">القائمة</TableHead>
                  <TableHead className="text-right">النوع</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => {
                  const depth = l.parentId ? 1 : 0;
                  return (
                    <TableRow key={l.id} className={!l.isActive ? "opacity-60" : undefined}>
                      <TableCell
                        className="font-mono text-sm"
                        style={{ paddingInlineStart: `${depth * 20 + 12}px` }}
                      >
                        {depth > 0 ? <span className="text-muted-foreground">└ </span> : null}
                        {l.code}
                      </TableCell>
                      <TableCell className="text-sm">
                        {l.nameAr}
                        {l.nameEn ? <span className="ms-2 text-xs text-muted-foreground" dir="ltr">{l.nameEn}</span> : null}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{STATEMENT_TYPE_LABELS[l.statementType as keyof typeof STATEMENT_TYPE_LABELS] ?? l.statementType}</TableCell>
                      <TableCell>{l.isSubtotal ? <Badge variant="outline">مجموع</Badge> : <Badge variant="secondary">بند</Badge>}</TableCell>
                    </TableRow>
                  );
                })}
                {lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="h-16 text-center text-sm text-muted-foreground">لا بنود مرجعية.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ── حوارات البادئات ── */}
      <AddPrefixDialog
        open={addPrefixOpen}
        onOpenChange={setAddPrefixOpen}
        companyId={selectedCompanyId}
        lines={lines}
        onSaved={loadAll}
      />
      <EditPrefixDialog
        target={editPrefix}
        lines={lines}
        onClose={() => setEditPrefix(null)}
        onSaved={() => { setEditPrefix(null); loadAll(); }}
      />
      <DeletePrefixDialog
        target={deletePrefix}
        onClose={() => setDeletePrefix(null)}
        onDeleted={() => { setDeletePrefix(null); loadAll(); }}
      />
      {/* ── حوارات الاستثناءات ── */}
      <AddOverrideDialog
        open={addOverrideOpen}
        onOpenChange={setAddOverrideOpen}
        companyId={selectedCompanyId}
        lines={lines}
        onSaved={loadAll}
      />
      <EditOverrideDialog
        target={editOverride}
        lines={lines}
        onClose={() => setEditOverride(null)}
        onSaved={() => { setEditOverride(null); loadAll(); }}
      />
      <DeleteOverrideDialog
        target={deleteOverride}
        onClose={() => setDeleteOverride(null)}
        onDeleted={() => { setDeleteOverride(null); loadAll(); }}
      />
      {/* ── نسخ الخريطة ── */}
      <CopyMappingDialog
        open={copyOpen}
        onOpenChange={setCopyOpen}
        companies={companies}
        toCompanyId={selectedCompanyId}
        onCopied={() => { setCopyOpen(false); loadAll(); }}
      />
    </div>
  );
}

/* ══════════════════════════ حوارات البادئات ══════════════════════════ */

interface PrefixFormState {
  prefix: string;
  classification: AccountClassification;
  aggregationBehavior: AggregationBehavior;
  statementLineCode: string; // "__none__" = بلا بند
  note: string;
  reason: string; // 6.7 — سبب إدخالي إلزامي (سجل التدقيق)
}

function PrefixFormFields({
  form, setForm, lines, lockPrefix,
}: {
  form: PrefixFormState;
  setForm: (patch: Partial<PrefixFormState>) => void;
  lines: StatementLineRow[];
  lockPrefix?: boolean;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pf-prefix">البادئة</Label>
          <Input
            id="pf-prefix"
            dir="ltr"
            className="font-mono"
            placeholder="1101"
            value={form.prefix}
            disabled={lockPrefix}
            onChange={(e) => setForm({ prefix: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">هرمية حقيقية: 1 ثم 11 ثم 1101 — الأطول يفوز دائمًا.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pf-classification">التصنيف التفصيلي</Label>
          <Select
            value={form.classification}
            onValueChange={(v) => {
              const suggested = SUGGESTED_BEHAVIOR_BY_CLASSIFICATION[v as AccountClassification];
              setForm({
                classification: v as AccountClassification,
                // اقتراح عرض فقط — OTHER بلا افتراض (يبقى على ما اختاره المستخدم).
                ...(suggested ? { aggregationBehavior: suggested } : {}),
              });
            }}
          >
            <SelectTrigger id="pf-classification"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.values(ACCOUNT_CLASSIFICATIONS).map((c) => (
                <SelectItem key={c} value={c}>{ACCOUNT_CLASSIFICATION_LABELS[c]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {accountRootDigit(form.prefix) === "2" ? (
            <p className="text-xs text-muted-foreground" dir="rtl">
              {ROOT2_CLASSIFICATION_HINT.ar} — {ROOT2_CLASSIFICATION_HINT.en}
            </p>
          ) : null}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="pf-behavior">سلوك التجميع الزمني</Label>
          <Select value={form.aggregationBehavior} onValueChange={(v) => setForm({ aggregationBehavior: v as AggregationBehavior })}>
            <SelectTrigger id="pf-behavior"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.values(AGGREGATION_BEHAVIORS).map((b) => (
                <SelectItem key={b} value={b}>{AGGREGATION_BEHAVIOR_LABELS[b]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">منفصل عن التصنيف عمدًا — إيرادات/مصروفات حركة (FLOW) وأصول/التزامات/حقوق أرصدة (BALANCE).</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pf-line">بند القائمة المالية (اختياري)</Label>
          <StatementLineSelect
            value={form.statementLineCode}
            onChange={(v) => setForm({ statementLineCode: v })}
            lines={lines}
            classification={form.classification}
          />
          <p className="text-xs text-muted-foreground">بلا بند ⇒ ROOT_ONLY (لا قائمة نهائية بهذا الحساب) — لا تخمين بنود.</p>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pf-note">ملاحظة (اختياري)</Label>
        <Input id="pf-note" value={form.note} onChange={(e) => setForm({ note: e.target.value })} maxLength={300} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pf-reason">سبب الحفظ/التعديل (إلزامي — يُدوّن في سجل التدقيق)</Label>
        <Input
          id="pf-reason"
          value={form.reason}
          onChange={(e) => setForm({ reason: e.target.value })}
          maxLength={300}
          placeholder="مثال: إضافة بادئة للمخزون بعد مراجعة دليل الحسابات"
        />
      </div>
    </div>
  );
}

function AddPrefixDialog({
  open, onOpenChange, companyId, lines, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  companyId: string;
  lines: StatementLineRow[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);
  const [form, setFormState] = React.useState<PrefixFormState>({
    prefix: "", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineCode: "__none__", note: "", reason: "",
  });
  const setForm = (patch: Partial<PrefixFormState>) => setFormState((f) => ({ ...f, ...patch }));

  const submit = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/account-nature/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          prefix: form.prefix,
          classification: form.classification,
          aggregationBehavior: form.aggregationBehavior,
          statementLineCode: form.statementLineCode === "__none__" ? "" : form.statementLineCode,
          note: form.note,
          reason: form.reason.trim(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "أُنشئت البادئة التفصيلية" });
      setFormState({ prefix: "", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineCode: "__none__", note: "", reason: "" });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast({ title: "فشل الإنشاء", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" dir="rtl">
        <DialogHeader>
          <DialogTitle>بادئة تفصيلية جديدة</DialogTitle>
          <DialogDescription>تُحفظ مرة واحدة لهذه الشركة وتُستخدم في كل الفترات والسنوات.</DialogDescription>
        </DialogHeader>
        <PrefixFormFields form={form} setForm={setForm} lines={lines} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>إلغاء</Button>
          <Button onClick={submit} disabled={saving || !form.prefix.trim() || !form.reason.trim()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            حفظ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditPrefixDialog({
  target, lines, onClose, onSaved,
}: {
  target: RuleRow | null;
  lines: StatementLineRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);
  const [isActive, setIsActive] = React.useState(true);
  const [form, setFormState] = React.useState<PrefixFormState>({
    prefix: "", classification: "ASSET", aggregationBehavior: "BALANCE", statementLineCode: "__none__", note: "", reason: "",
  });
  const setForm = (patch: Partial<PrefixFormState>) => setFormState((f) => ({ ...f, ...patch }));

  React.useEffect(() => {
    if (target) {
      setIsActive(target.isActive);
      setFormState({
        prefix: target.prefix,
        classification: (target.classification ?? "OTHER") as AccountClassification,
        aggregationBehavior: target.aggregationBehavior as AggregationBehavior,
        statementLineCode: target.statementLine?.code ?? "__none__",
        note: target.note ?? "",
        reason: "",
      });
    }
  }, [target]);

  const submit = async () => {
    if (!target) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/account-nature/rules/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classification: form.classification,
          aggregationBehavior: form.aggregationBehavior,
          statementLineCode: form.statementLineCode === "__none__" ? "" : form.statementLineCode,
          note: form.note,
          isActive,
          version: target.version,
          reason: form.reason.trim(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "حُفظ التعديل", description: "سُجّل في سجل التدقيق مع السبب." });
      onSaved();
    } catch (e) {
      toast({ title: "فشل الحفظ", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl" dir="rtl">
        <DialogHeader>
          <DialogTitle>تعديل البادئة «{target?.prefix}»</DialogTitle>
          <DialogDescription>البادئة نفسها لا تتغير — التعديل على التصنيف/السلوك/البند/التفعيل (مع تدقيق قبل/بعد).</DialogDescription>
        </DialogHeader>
        <PrefixFormFields form={form} setForm={setForm} lines={lines} lockPrefix />
        <div className="flex items-center gap-2">
          <Checkbox id="pf-active" checked={isActive} onCheckedChange={(v) => setIsActive(v === true)} />
          <Label htmlFor="pf-active">نشطة</Label>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>إلغاء</Button>
          <Button onClick={submit} disabled={saving || !form.reason.trim()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            حفظ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeletePrefixDialog({
  target, onClose, onDeleted,
}: {
  target: RuleRow | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);

  const submit = async () => {
    if (!target) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/account-nature/rules/${target.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: target.version, reason: "حذف بادئة من الواجهة" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "حُذفت البادئة", description: "سُجّل الحذف في سجل التدقيق." });
      onDeleted();
    } catch (e) {
      toast({ title: "فشل الحذف", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle>حذف البادئة «{target?.prefix}»؟</DialogTitle>
          <DialogDescription>
            الحذف نهائي ويُدوَّن في سجل التدقيق. الحسابات التي كانت تعتمد عليها ستعود لحسم الجذر النظامي أو «تحتاج تصنيفًا».
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>إلغاء</Button>
          <Button variant="destructive" onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            حذف
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ══════════════════════════ حوارات الاستثناءات ══════════════════════════ */

interface OverrideFormState {
  accountCode: string;
  classification: AccountClassification;
  aggregationBehavior: AggregationBehavior;
  statementLineCode: string;
  note: string;
  reason: string; // 6.7 — سبب إدخالي إلزامي (سجل التدقيق)
}

function OverrideFormFields({
  form, setForm, lines, lockCode,
}: {
  form: OverrideFormState;
  setForm: (patch: Partial<OverrideFormState>) => void;
  lines: StatementLineRow[];
  lockCode?: boolean;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="of-code">كود الحساب (كامل — لا بادئة)</Label>
          <Input
            id="of-code"
            dir="ltr"
            className="font-mono"
            placeholder="310199"
            value={form.accountCode}
            disabled={lockCode}
            onChange={(e) => setForm({ accountCode: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="of-classification">التصنيف التفصيلي</Label>
          <Select
            value={form.classification}
            onValueChange={(v) => {
              const suggested = SUGGESTED_BEHAVIOR_BY_CLASSIFICATION[v as AccountClassification];
              setForm({
                classification: v as AccountClassification,
                ...(suggested ? { aggregationBehavior: suggested } : {}),
              });
            }}
          >
            <SelectTrigger id="of-classification"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.values(ACCOUNT_CLASSIFICATIONS).map((c) => (
                <SelectItem key={c} value={c}>{ACCOUNT_CLASSIFICATION_LABELS[c]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="of-behavior">سلوك التجميع الزمني</Label>
          <Select value={form.aggregationBehavior} onValueChange={(v) => setForm({ aggregationBehavior: v as AggregationBehavior })}>
            <SelectTrigger id="of-behavior"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.values(AGGREGATION_BEHAVIORS).map((b) => (
                <SelectItem key={b} value={b}>{AGGREGATION_BEHAVIOR_LABELS[b]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="of-line">بند القائمة المالية (اختياري)</Label>
          <StatementLineSelect
            value={form.statementLineCode}
            onChange={(v) => setForm({ statementLineCode: v })}
            lines={lines}
            classification={form.classification}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="of-note">ملاحظة (اختياري)</Label>
        <Input id="of-note" value={form.note} onChange={(e) => setForm({ note: e.target.value })} maxLength={300} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="of-reason">سبب الحفظ/التعديل (إلزامي — يُدوّن في سجل التدقيق)</Label>
        <Input
          id="of-reason"
          value={form.reason}
          onChange={(e) => setForm({ reason: e.target.value })}
          maxLength={300}
          placeholder="مثال: استثناء حساب تمويل مُصنّف خاطئًا سابقًا"
        />
      </div>
    </div>
  );
}

function AddOverrideDialog({
  open, onOpenChange, companyId, lines, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  companyId: string;
  lines: StatementLineRow[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);
  const [form, setFormState] = React.useState<OverrideFormState>({
    accountCode: "", classification: "EXPENSE", aggregationBehavior: "FLOW", statementLineCode: "__none__", note: "", reason: "",
  });
  const setForm = (patch: Partial<OverrideFormState>) => setFormState((f) => ({ ...f, ...patch }));

  const submit = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/account-nature/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          accountCode: form.accountCode,
          classification: form.classification,
          aggregationBehavior: form.aggregationBehavior,
          statementLineCode: form.statementLineCode === "__none__" ? "" : form.statementLineCode,
          note: form.note,
          reason: form.reason.trim(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "أُنشئ الاستثناء", description: "أولويته الآن فوق كل البادئات لهذا الحساب." });
      setFormState({ accountCode: "", classification: "EXPENSE", aggregationBehavior: "FLOW", statementLineCode: "__none__", note: "", reason: "" });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast({ title: "فشل الإنشاء", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" dir="rtl">
        <DialogHeader>
          <DialogTitle>استثناء حساب محدد</DialogTitle>
          <DialogDescription>يفوز على أي بادئة شركة أو جذر نظامي عند حل هذا الكود تحديدًا.</DialogDescription>
        </DialogHeader>
        <OverrideFormFields form={form} setForm={setForm} lines={lines} />
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>إلغاء</Button>
          <Button onClick={submit} disabled={saving || !form.accountCode.trim() || !form.reason.trim()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            حفظ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditOverrideDialog({
  target, lines, onClose, onSaved,
}: {
  target: OverrideRow | null;
  lines: StatementLineRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);
  const [isActive, setIsActive] = React.useState(true);
  const [form, setFormState] = React.useState<OverrideFormState>({
    accountCode: "", classification: "EXPENSE", aggregationBehavior: "FLOW", statementLineCode: "__none__", note: "", reason: "",
  });
  const setForm = (patch: Partial<OverrideFormState>) => setFormState((f) => ({ ...f, ...patch }));

  React.useEffect(() => {
    if (target) {
      setIsActive(target.isActive);
      setFormState({
        accountCode: target.accountCode,
        classification: target.classification as AccountClassification,
        aggregationBehavior: target.aggregationBehavior as AggregationBehavior,
        statementLineCode: target.statementLine?.code ?? "__none__",
        note: target.note ?? "",
        reason: "",
      });
    }
  }, [target]);

  const submit = async () => {
    if (!target) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/account-nature/overrides/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classification: form.classification,
          aggregationBehavior: form.aggregationBehavior,
          statementLineCode: form.statementLineCode === "__none__" ? "" : form.statementLineCode,
          note: form.note,
          isActive,
          version: target.version,
          reason: form.reason.trim(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "حُفظ التعديل", description: "سُجّل في سجل التدقيق مع السبب." });
      onSaved();
    } catch (e) {
      toast({ title: "فشل الحفظ", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl" dir="rtl">
        <DialogHeader>
          <DialogTitle>تعديل استثناء الحساب «{target?.accountCode}»</DialogTitle>
          <DialogDescription>كود الحساب لا يتغير — التعديل على التصنيف/السلوك/البند/التفعيل.</DialogDescription>
        </DialogHeader>
        <OverrideFormFields form={form} setForm={setForm} lines={lines} lockCode />
        <div className="flex items-center gap-2">
          <Checkbox id="of-active" checked={isActive} onCheckedChange={(v) => setIsActive(v === true)} />
          <Label htmlFor="of-active">نشط</Label>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>إلغاء</Button>
          <Button onClick={submit} disabled={saving || !form.reason.trim()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            حفظ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteOverrideDialog({
  target, onClose, onDeleted,
}: {
  target: OverrideRow | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);

  const submit = async () => {
    if (!target) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/account-nature/overrides/${target.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: target.version, reason: "حذف استثناء من الواجهة" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "حُذف الاستثناء", description: "سُجّل الحذف في سجل التدقيق." });
      onDeleted();
    } catch (e) {
      toast({ title: "فشل الحذف", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle>حذف استثناء الحساب «{target?.accountCode}»؟</DialogTitle>
          <DialogDescription>سيعود حسم الحساب إلى أولوية البادئات التفصيلية ثم الجذر النظامي.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>إلغاء</Button>
          <Button variant="destructive" onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            حذف
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ══════════════════════════ نسخ الخريطة ══════════════════════════ */

function CopyMappingDialog({
  open, onOpenChange, companies, toCompanyId, onCopied,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  companies: CompanyOption[];
  toCompanyId: string;
  onCopied: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = React.useState(false);
  const [fromId, setFromId] = React.useState("");
  const [replace, setReplace] = React.useState(false);
  const [reason, setReason] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setFromId(companies.find((c) => c.id !== toCompanyId)?.id ?? "");
      setReplace(false);
      setReason("");
    }
  }, [open, companies, toCompanyId]);

  const target = companies.find((c) => c.id === toCompanyId);

  const submit = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/account-nature/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromCompanyId: fromId, toCompanyId, replaceExisting: replace, reason: reason || "نسخ خريطة من الواجهة" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "تمت النسخ", description: `نُسخت ${data?.rulesCopied ?? 0} بادئة و${data?.overridesCopied ?? 0} استثناءً — نسخة مستقلة تمامًا.` });
      onCopied();
    } catch (e) {
      toast({ title: "فشل النسخ", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle>نسخ دليل الحسابات من شركة</DialogTitle>
          <DialogDescription>
            يُنسخ إعداد «{target ? `${target.code} — ${target.nameAr}` : "الشركة المحددة"}» من شركة أخرى — تصبح النسخة مستقلة تمامًا بعد الإنشاء (تعديل المصدر لاحقًا لا يمسها).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="cp-from">من شركة</Label>
            <Select value={fromId} onValueChange={setFromId}>
              <SelectTrigger id="cp-from"><SelectValue placeholder="اختر شركة المصدر" /></SelectTrigger>
              <SelectContent>
                {companies.filter((c) => c.id !== toCompanyId).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.code} — {c.nameAr}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="cp-replace" checked={replace} onCheckedChange={(v) => setReplace(v === true)} />
            <Label htmlFor="cp-replace" className="font-normal">
              استبدال قواعد/استثناءات الشركة الهدف القائمة (بدونها يُرفض النسخ إن وُجد إعداد قائم)
            </Label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp-reason">سبب (يُدوَّن في سجل التدقيق)</Label>
            <Input id="cp-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>إلغاء</Button>
          <Button onClick={submit} disabled={saving || !fromId}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Copy className="size-4" />}
            نسخ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
