"use client";

// 6.7 — التقارير الموحدة: إدارة المجموعات (أعضاء/بنود/خرائط) + قيود التسوية والإلغاء
//       + التقرير الموحد الأولي (Preliminary) فوق خدمات 6.6 الحالية حصرًا.
// توحيد أولي: لا NCI ولا شهرة ولا محاسبة استحواذ ولا فروقات عملة — تُعلن كمراحل لاحقة.

import * as React from "react";
import {
  AlertTriangle, Building2, ChevronDown, FileStack, Layers, Loader2, Lock, Plus, RefreshCw, Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatMinor } from "@/lib/money";
import { canManageTrialBalances, parsePermissions, type Permissions } from "@/lib/permissions";
import { useSession } from "next-auth/react";

interface MemberRow {
  membershipId: string; companyId: string; companyCode: string; companyNameAr: string;
  ownershipPercentage: number | null; effectiveFrom: string; effectiveTo: string | null;
}
interface GroupListRow {
  id: string; code: string; nameAr: string; status: string; memberCount: number;
  members: MemberRow[]; adjustmentsCount: number;
}
interface GroupDetail extends GroupListRow {
  createdBy: string;
  reportingLines: Array<{ id: string; code: string; nameAr: string; statementType: string; displayOrder: number; isActive: boolean }>;
  mappingsCount: number;
  adjustments: Array<{
    id: string; kind: string; eliminationType: string | null; startDate: string; endDate: string;
    reason: string; status: string; preparedBy: string; postedBy: string | null; postedAt: string | null; createdAt: string;
    lines: Array<{ id: string; groupLineCode: string | null; debitMinor: string; creditMinor: string }>;
  }>;
}
interface AdjustmentRow {
  id: string; kind: string; eliminationType: string | null; startDate: string; endDate: string;
  reason: string; status: string; preparedBy: string; postedAt: string | null; createdAt: string;
  lines: Array<{ id: string; groupLineCode: string | null; debitMinor: string; creditMinor: string }>;
}
interface ConsolidatedResponse {
  group: { id: string; code: string; nameAr: string };
  range: { startDate: string; endDate: string };
  members: Array<{ companyId: string; companyCode: string; ownershipPercentage: number | null; dataStatus: string; fiscalYearCode: string | null }>;
  workingPaper: Array<{
    groupLineCode: string; groupLineNameAr: string; statementType: string;
    companyValues: Array<{ companyId: string; companyCode: string; valueMinor: string | null; status: string }>;
    totalBeforeEliminationsMinor: string | null;
    adjustmentsMinor: string | null;
    consolidatedTotalMinor: string | null;
  }>;
  profitOrLoss: { totalRevenueMinor: string | null; totalExpensesMinor: string | null; netResultMinor: string | null };
  financialPosition: { totalAssetsMinor: string | null; totalLiabilitiesMinor: string | null; totalEquityMinor: string | null; differenceMinor: string | null; reconciled: boolean | null };
  status: string;
  completenessNotes: string[];
  preliminary: boolean;
}

const ELIMINATION_TYPES = [
  { value: "INTERCOMPANY_AR_AP", label: "أرصدة مدينة/دائنة بين الشركات" },
  { value: "INTERCOMPANY_SALES_PURCHASES", label: "بيع/شراء بين الشركات" },
  { value: "INTERCOMPANY_LOANS", label: "قروض بين الشركات" },
  { value: "INTERCOMPANY_DIVIDENDS", label: "توزيعات بين الشركات" },
  { value: "OTHER", label: "أخرى" },
];

function fmt(minor: string | null | undefined, minorUnits = 2): string {
  if (minor === null || minor === undefined) return "—";
  return formatMinor(minor, minorUnits);
}

export function ConsolidationView() {
  const { toast } = useToast();
  const { data: session } = useSession();

  const perms = React.useMemo<Permissions>(() => {
    if (!session?.user) return parsePermissions(null);
    const raw = (session.user as { permissions?: unknown }).permissions;
    if (typeof raw === "string") return parsePermissions(raw);
    if (raw && typeof raw === "object") return parsePermissions(JSON.stringify(raw));
    return parsePermissions(null);
  }, [session]);
  const role = ((session?.user as { role?: string } | undefined)?.role) ?? "user";
  const canManage = canManageTrialBalances(perms, role);

  const [groups, setGroups] = React.useState<GroupListRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [detail, setDetail] = React.useState<GroupDetail | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // create dialog
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createCode, setCreateCode] = React.useState("");
  const [createName, setCreateName] = React.useState("");
  const [createMembers, setCreateMembers] = React.useState<Array<{ companyId: string; effectiveFrom: string; ownership: string }>>([]);
  const [createSaving, setCreateSaving] = React.useState(false);

  // add member
  const [addMemberFor, setAddMemberFor] = React.useState<GroupDetail | null>(null);
  const [memberCompany, setMemberCompany] = React.useState("");
  const [memberFrom, setMemberFrom] = React.useState("");
  const [memberOwnership, setMemberOwnership] = React.useState("");
  const [memberSaving, setMemberSaving] = React.useState(false);

  const [companies, setCompanies] = React.useState<Array<{ id: string; code: string; nameAr: string; status: string }>>([]);

  const loadGroups = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/consolidation/groups", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as GroupListRow[];
      setGroups(Array.isArray(rows) ? rows : []);
    } catch (e) {
      toast({ title: "فشل جلب المجموعات", description: e instanceof Error ? e.message : "", variant: "destructive" });
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadCompanies = React.useCallback(async () => {
    try {
      const res = await fetch("/api/companies", { cache: "no-store" });
      if (res.ok) {
        const rows = (await res.json()) as Array<{ id: string; code: string; nameAr: string; status: string }>;
        setCompanies(Array.isArray(rows) ? rows : []);
      }
    } catch {
      setCompanies([]);
    }
  }, []);

  React.useEffect(() => {
    void loadGroups();
    void loadCompanies();
  }, [loadGroups, loadCompanies]);

  const openDetail = async (g: GroupListRow) => {
    setBusyId(g.id);
    try {
      const res = await fetch(`/api/consolidation/groups/${g.id}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setDetail(data);
      setDetailOpen(true);
    } catch (e) {
      toast({ title: "فشل جلب التفاصيل", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const submitCreate = async () => {
    if (createMembers.length === 0) {
      toast({ title: "أضف شركة عضو واحدة على الأقل", variant: "destructive" });
      return;
    }
    setCreateSaving(true);
    try {
      const res = await fetch("/api/consolidation/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: createCode.trim(),
          nameAr: createName.trim(),
          members: createMembers.map((m) => ({
            companyId: m.companyId,
            effectiveFrom: m.effectiveFrom,
            ownershipPercentage: m.ownership === "" ? null : Number(m.ownership),
          })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "أُنشئت المجموعة", description: "بُذرت البنود الجماعية وخرائط الهوية للأعضاء." });
      setCreateOpen(false);
      setCreateCode(""); setCreateName(""); setCreateMembers([]);
      await loadGroups();
    } catch (e) {
      toast({ title: "فشل إنشاء المجموعة", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setCreateSaving(false);
    }
  };

  const submitAddMember = async () => {
    if (!addMemberFor || !memberCompany || !memberFrom) return;
    setMemberSaving(true);
    try {
      const res = await fetch(`/api/consolidation/groups/${addMemberFor.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: memberCompany,
          effectiveFrom: memberFrom,
          ownershipPercentage: memberOwnership === "" ? null : Number(memberOwnership),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "أُضيف العضو" });
      setAddMemberFor(null);
      setMemberCompany(""); setMemberFrom(""); setMemberOwnership("");
      await loadGroups();
      if (detail) await openDetail(detail);
    } catch (e) {
      toast({ title: "فشل إضافة العضو", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setMemberSaving(false);
    }
  };

  const removeMember = async (groupId: string, membershipId: string) => {
    setBusyId(membershipId);
    try {
      const res = await fetch(`/api/consolidation/groups/${groupId}/members/${membershipId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "إزالة من واجهة الإدارة" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: "أُزيلت العضوية" });
      await loadGroups();
      if (detail) await openDetail(detail);
    } catch (e) {
      toast({ title: "فشل الإزالة", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6" dir="rtl">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="size-4 text-emerald-600 dark:text-emerald-400" />
              المجموعات والتقارير الموحدة — توحيد أولي
            </CardTitle>
            <CardDescription>
              إدارة مجموعات التوحيد وأعضائها وتواريخ السريان ونسب الملكية (أساس)، وقيود التسوية/الاستبعاد المتوازنة،
              والتقرير الموحد المبدئي (P&L + المركز المالي). لا يشمل هذه المرحلة: حصص غير مسيطرة، شهرة، محاسبة استحواذ،
              ملكية معقدة، أو فروقات عملة — تُوثق كمراحل لاحقة.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void loadGroups()} aria-label="تحديث">
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
            {canManage && (
              <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700">
                <Plus className="size-3.5" /> مجموعة جديدة
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />جارٍ التحميل…</div>
          ) : groups.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">لا مجموعات توحيد بعد — أنشئ مجموعة وأضف الشركات الأعضاء.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">الكود</TableHead>
                    <TableHead className="text-right">الاسم</TableHead>
                    <TableHead className="text-right">الأعضاء</TableHead>
                    <TableHead className="text-right">القيود</TableHead>
                    <TableHead className="text-left">إجراءات</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((g) => (
                    <TableRow key={g.id}>
                      <TableCell className="font-mono text-sm">{g.code}</TableCell>
                      <TableCell className="text-sm">{g.nameAr}</TableCell>
                      <TableCell className="text-sm tnum">{g.memberCount}</TableCell>
                      <TableCell className="text-sm tnum">{g.adjustmentsCount}</TableCell>
                      <TableCell className="text-left">
                        <Button variant="ghost" size="sm" onClick={() => void openDetail(g)} disabled={busyId === g.id} aria-label="إدارة المجموعة">
                          <Building2 className="size-3.5" /> إدارة
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* التقرير الموحد الأولي */}
      <ConsolidatedReportPanel canManage={canManage} groups={groups} />

      {/* ── حوار إنشاء مجموعة ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" dir="rtl">
          <DialogHeader>
            <DialogTitle>مجموعة توحيد جديدة</DialogTitle>
            <DialogDescription>
              تُبذر تلقائيًا البنود الجماعية (P&L + المركز المالي) وخرائط الهوية لكل شركة عضو.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>الكود (لاتيني)</Label>
                <Input value={createCode} onChange={(e) => setCreateCode(e.target.value)} dir="ltr" className="font-mono" placeholder="GRP-1" maxLength={40} />
              </div>
              <div className="space-y-1.5">
                <Label>الاسم بالعربية</Label>
                <Input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="مجموعة فروع" maxLength={120} />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>الشركات الأعضاء</Label>
                <Button
                  variant="outline" size="sm"
                  onClick={() => setCreateMembers((m) => [...m, { companyId: "", effectiveFrom: new Date().toISOString().slice(0, 10), ownership: "" }])}
                >
                  <Plus className="size-3.5" /> إضافة شركة
                </Button>
              </div>
              {createMembers.length === 0 && (
                <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">أضف شركة عضو واحدة على الأقل.</p>
              )}
              {createMembers.map((m, i) => (
                <div key={i} className="grid grid-cols-[1fr_140px_90px_auto] items-end gap-2 rounded-md border p-2">
                  <div className="space-y-1">
                    <Label className="text-[10px]">الشركة</Label>
                    <Select value={m.companyId} onValueChange={(v) => setCreateMembers((arr) => arr.map((x, j) => (j === i ? { ...x, companyId: v } : x)))}>
                      <SelectTrigger><SelectValue placeholder="اختر شركة" /></SelectTrigger>
                      <SelectContent className="max-h-56">
                        {companies.map((c) => <SelectItem key={c.id} value={c.id}><span className="tnum">{c.code}</span> — {c.nameAr}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">سريان من</Label>
                    <Input type="date" value={m.effectiveFrom} onChange={(e) => setCreateMembers((arr) => arr.map((x, j) => (j === i ? { ...x, effectiveFrom: e.target.value } : x)))} dir="ltr" className="tnum" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">ملكية %</Label>
                    <Input type="number" min={0} max={100} value={m.ownership} onChange={(e) => setCreateMembers((arr) => arr.map((x, j) => (j === i ? { ...x, ownership: e.target.value } : x)))} dir="ltr" className="tnum" placeholder="—" />
                  </div>
                  <Button variant="ghost" size="icon" className="size-8 text-rose-600" aria-label="إزالة" onClick={() => setCreateMembers((arr) => arr.filter((_, j) => j !== i))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={createSaving}>إلغاء</Button>
            <Button onClick={submitCreate} disabled={createSaving || !createCode.trim() || !createName.trim()}>
              {createSaving ? <Loader2 className="size-4 animate-spin" /> : null}
              إنشاء المجموعة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── حوار تفاصيل/إدارة مجموعة ── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="size-4" /> {detail?.code} — {detail?.nameAr}
            </DialogTitle>
            <DialogDescription>
              أنشأها: {detail?.createdBy || "—"} · عدد خرائط البنود: <span className="tnum">{detail?.mappingsCount ?? 0}</span>
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <Tabs defaultValue="members">
              <TabsList className="flex flex-wrap">
                <TabsTrigger value="members">الأعضاء ({detail.members.length})</TabsTrigger>
                <TabsTrigger value="lines">بنود جماعية ({detail.reportingLines.length})</TabsTrigger>
                <TabsTrigger value="adjustments">القيود ({detail.adjustments.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="members" className="space-y-3">
                {canManage && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAddMemberFor(detail)}>
                    <Plus className="size-3.5" /> إضافة عضو
                  </Button>
                )}
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">الشركة</TableHead>
                        <TableHead className="text-right">سريان من</TableHead>
                        <TableHead className="text-right">سريان إلى</TableHead>
                        <TableHead className="text-right">ملكية %</TableHead>
                        {canManage && <TableHead className="text-left">إجراءات</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.members.map((m) => (
                        <TableRow key={m.membershipId}>
                          <TableCell className="text-sm"><span className="tnum">{m.companyCode}</span> — {m.companyNameAr}</TableCell>
                          <TableCell className="text-xs tnum" dir="ltr">{m.effectiveFrom}</TableCell>
                          <TableCell className="text-xs tnum" dir="ltr">{m.effectiveTo ?? "مفتوحة"}</TableCell>
                          <TableCell className="text-xs tnum">{m.ownershipPercentage ?? "—"}</TableCell>
                          {canManage && (
                            <TableCell className="text-left">
                              <Button variant="ghost" size="sm" aria-label="إزالة العضوية" onClick={() => void removeMember(detail.id, m.membershipId)} disabled={busyId === m.membershipId}>
                                <Trash2 className="size-3.5 text-rose-600" />
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                      {detail.members.length === 0 && (
                        <TableRow><TableCell colSpan={5} className="h-12 text-center text-sm text-muted-foreground">لا أعضاء.</TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              <TabsContent value="lines">
                <p className="mb-2 text-xs text-muted-foreground">
                  البنود الجماعية وخرائطها (بند الشركة ← البند الجماعي) تُبذر تلقائيًا بالهوية — إعادة الربط اليدوي مرحلة لاحقة.
                </p>
                <div className="max-h-56 overflow-y-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">الكود</TableHead>
                        <TableHead className="text-right">الاسم</TableHead>
                        <TableHead className="text-right">القائمة</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.reportingLines.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell className="font-mono text-xs">{l.code}</TableCell>
                          <TableCell className="text-xs">{l.nameAr}</TableCell>
                          <TableCell className="text-xs">{l.statementType === "PROFIT_OR_LOSS" ? "الدخل" : "المركز المالي"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              <TabsContent value="adjustments" className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  إنشاء القيود من لوحة القيود أدناه (خارج هذا الحوار) — هنا العرض. الداخلة في الإجماليات: POSTED فقط.
                </p>
                {detail.adjustments.length === 0 ? (
                  <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">لا قيود بعد.</p>
                ) : (
                  detail.adjustments.map((a) => (
                    <div key={a.id} className="rounded-md border p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={a.status === "POSTED" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" : "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300"}>
                          {a.status === "POSTED" ? "مُرحّل" : "مسودة"}
                        </Badge>
                        <Badge variant="outline">{a.kind === "ELIMINATION" ? "استبعاد" : "تسوية"}</Badge>
                        {a.eliminationType && (
                          <Badge variant="outline">{ELIMINATION_TYPES.find((t) => t.value === a.eliminationType)?.label ?? a.eliminationType}</Badge>
                        )}
                        <span className="tnum" dir="ltr">{a.startDate} → {a.endDate}</span>
                        <span className="text-muted-foreground">بواسطة {a.preparedBy}</span>
                      </div>
                      <p className="mt-1 text-muted-foreground">{a.reason}</p>
                      <ul className="mt-1 space-y-0.5">
                        {a.lines.map((l) => (
                          <li key={l.id} className="flex items-center justify-between gap-2 tnum">
                            <span className="font-mono">{l.groupLineCode ?? "—"}</span>
                            <span dir="ltr">مدين {fmt(l.debitMinor)} / دائن {fmt(l.creditMinor)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      {/* ── حوار إضافة عضو ── */}
      <Dialog open={!!addMemberFor} onOpenChange={(v) => { if (!v) setAddMemberFor(null); }}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>إضافة عضو إلى {addMemberFor?.code}</DialogTitle>
            <DialogDescription>تُبذر خرائط الهوية للشركة الجديدة تلقائيًا.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>الشركة</Label>
              <Select value={memberCompany} onValueChange={setMemberCompany}>
                <SelectTrigger><SelectValue placeholder="اختر شركة" /></SelectTrigger>
                <SelectContent className="max-h-56">
                  {companies.filter((c) => !addMemberFor?.members.some((m) => m.companyId === c.id)).map((c) => (
                    <SelectItem key={c.id} value={c.id}><span className="tnum">{c.code}</span> — {c.nameAr}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>سريان من</Label>
                <Input type="date" value={memberFrom} onChange={(e) => setMemberFrom(e.target.value)} dir="ltr" className="tnum" />
              </div>
              <div className="space-y-1.5">
                <Label>ملكية % (أساس)</Label>
                <Input type="number" min={0} max={100} value={memberOwnership} onChange={(e) => setMemberOwnership(e.target.value)} dir="ltr" className="tnum" placeholder="—" />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setAddMemberFor(null)} disabled={memberSaving}>إلغاء</Button>
            <Button onClick={submitAddMember} disabled={memberSaving || !memberCompany || !memberFrom} className="bg-emerald-600 text-white hover:bg-emerald-700">
              {memberSaving ? <Loader2 className="size-4 animate-spin" /> : null} إضافة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AdjustmentsPanel canManage={canManage} groups={groups} onChanged={() => void loadGroups()} />
    </div>
  );
}

/* ── لوحة إنشاء قيود التسوية/الاستبعاد ── */
function AdjustmentsPanel({ canManage, groups, onChanged }: {
  canManage: boolean; groups: GroupListRow[]; onChanged: () => void;
}) {
  const { toast } = useToast();
  const [groupId, setGroupId] = React.useState("");
  const [kind, setKind] = React.useState("ELIMINATION");
  const [elimType, setElimType] = React.useState("INTERCOMPANY_AR_AP");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [post, setPost] = React.useState(true);
  const [lines, setLines] = React.useState<Array<{ groupLineCode: string; debit: string; credit: string }>>([
    { groupLineCode: "", debit: "", credit: "" },
    { groupLineCode: "", debit: "", credit: "" },
  ]);
  const [saving, setSaving] = React.useState(false);
  const [groupLines, setGroupLines] = React.useState<Array<{ code: string; nameAr: string }>>([]);

  const loadGroupLines = React.useCallback(async (id: string) => {
    if (!id) { setGroupLines([]); return; }
    try {
      const res = await fetch(`/api/consolidation/groups/${id}`, { cache: "no-store" });
      if (res.ok) {
        const d = (await res.json()) as GroupDetail;
        setGroupLines(d.reportingLines.filter((l) => l.isActive).map((l) => ({ code: l.code, nameAr: l.nameAr })));
      }
    } catch {
      setGroupLines([]);
    }
  }, []);

  React.useEffect(() => { void loadGroupLines(groupId); }, [groupId, loadGroupLines]);

  const balancedTotalDebit = lines.reduce((acc, l) => acc + (parseFloat(l.debit) || 0), 0);
  const balancedTotalCredit = lines.reduce((acc, l) => acc + (parseFloat(l.credit) || 0), 0);
  const locallyBalanced = Math.abs(balancedTotalDebit - balancedTotalCredit) < 0.0001 && balancedTotalDebit > 0;

  const submit = async () => {
    if (!groupId || !startDate || !endDate || !reason.trim()) {
      toast({ title: "أكمل المجموعة والمدى والسبب", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payloadLines = lines
        .filter((l) => l.groupLineCode && (l.debit !== "" || l.credit !== ""))
        .map((l) => ({
          groupLineCode: l.groupLineCode,
          debitMinor: l.debit === "" ? "0" : BigInt(Math.round(parseFloat(l.debit) * 100)).toString(),
          creditMinor: l.credit === "" ? "0" : BigInt(Math.round(parseFloat(l.credit) * 100)).toString(),
        }));
      const res = await fetch("/api/consolidation/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId, kind, eliminationType: kind === "ELIMINATION" ? elimType : undefined, startDate, endDate, reason: reason.trim(), post, lines: payloadLines }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      toast({ title: post ? "رُحّل القيد" : "حُفظ كمسودة", description: "القيود المتوازنة حصرًا تدخل الإجماليات الموحدة." });
      setReason("");
      setLines([{ groupLineCode: "", debit: "", credit: "" }, { groupLineCode: "", debit: "", credit: "" }]);
      onChanged();
    } catch (e) {
      toast({ title: "فشل حفظ القيد", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileStack className="size-4 text-emerald-600 dark:text-emerald-400" />
          قيد تسوية / استبعاد بين الشركات
        </CardTitle>
        <CardDescription>
          قيد journal متوازن إلزامًا (Σمدين = Σدائن) — بحالة POSTED يدخل الإجماليات الموحدة، ومسودة لا تدخلها.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!canManage ? (
          <p className="text-sm text-muted-foreground">لا تملك صلاحية إنشاء قيود التوحيد.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label>المجموعة</Label>
                <Select value={groupId} onValueChange={setGroupId}>
                  <SelectTrigger aria-label="المجموعة"><SelectValue placeholder="اختر مجموعة" /></SelectTrigger>
                  <SelectContent>
                    {groups.map((g) => <SelectItem key={g.id} value={g.id}><span className="font-mono">{g.code}</span> — {g.nameAr}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>النوع</Label>
                <Select value={kind} onValueChange={setKind}>
                  <SelectTrigger aria-label="النوع"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ELIMINATION">استبعاد (ELIMINATION)</SelectItem>
                    <SelectItem value="ADJUSTMENT">تسوية (ADJUSTMENT)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {kind === "ELIMINATION" && (
                <div className="space-y-1.5">
                  <Label>نوع الاستبعاد</Label>
                  <Select value={elimType} onValueChange={setElimType}>
                    <SelectTrigger aria-label="نوع الاستبعاد"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ELIMINATION_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label>من تاريخ</Label>
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} dir="ltr" className="tnum" />
                </div>
                <div className="space-y-1.5">
                  <Label>إلى تاريخ</Label>
                  <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} dir="ltr" className="tnum" />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>سطور القيد (بند جماعي — مدين/دائن)</Label>
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_130px_130px_auto] items-end gap-2 rounded-md border p-2">
                  <div className="space-y-1">
                    <Label className="text-[10px]">البند الجماعي</Label>
                    <Select value={l.groupLineCode} onValueChange={(v) => setLines((arr) => arr.map((x, j) => (j === i ? { ...x, groupLineCode: v } : x)))}>
                      <SelectTrigger><SelectValue placeholder="اختر بندًا" /></SelectTrigger>
                      <SelectContent className="max-h-56">
                        {groupLines.map((gl) => <SelectItem key={gl.code} value={gl.code}><span className="font-mono text-[10px]">{gl.code}</span> — {gl.nameAr}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">مدين</Label>
                    <Input value={l.debit} onChange={(e) => setLines((arr) => arr.map((x, j) => (j === i ? { ...x, debit: e.target.value, credit: e.target.value !== "" ? "" : x.credit } : x)))} dir="ltr" className="tnum" placeholder="0.00" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">دائن</Label>
                    <Input value={l.credit} onChange={(e) => setLines((arr) => arr.map((x, j) => (j === i ? { ...x, credit: e.target.value, debit: e.target.value !== "" ? "" : x.debit } : x)))} dir="ltr" className="tnum" placeholder="0.00" />
                  </div>
                  <Button variant="ghost" size="icon" className="size-8 text-rose-600" aria-label="إزالة السطر" onClick={() => setLines((arr) => arr.filter((_, j) => j !== i))}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <Button variant="outline" size="sm" onClick={() => setLines((arr) => [...arr, { groupLineCode: "", debit: "", credit: "" }])}>
                  <Plus className="size-3.5" /> سطر
                </Button>
                <p className={cn("text-xs tnum", locallyBalanced ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                  مدين {balancedTotalDebit.toFixed(2)} / دائن {balancedTotalCredit.toFixed(2)} {locallyBalanced ? "— متوازن" : "— غير متوازن (سيُرفض)"}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>سبب القيد (إلزامي — يُدوّن في التدقيق)</Label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={post} onChange={(e) => setPost(e.target.checked)} />
                ترحيل مباشر (POSTED) — يُلغيها لاحقًا بقيد معاكس يدوي
              </label>
              <Button onClick={submit} disabled={saving || !groupId || !locallyBalanced} className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700">
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Lock className="size-4" />}
                حفظ القيد
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ── التقرير الموحد الأولي ── */
function ConsolidatedReportPanel({ canManage, groups }: { canManage: boolean; groups: GroupListRow[] }) {
  const { toast } = useToast();
  const [groupId, setGroupId] = React.useState("");
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [data, setData] = React.useState<ConsolidatedResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [openLines, setOpenLines] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(async () => {
    if (!groupId || !startDate || !endDate) { setData(null); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/consolidation/statements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId, startDate, endDate }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setData(body);
      setOpenLines(new Set());
    } catch (e) {
      setData(null);
      toast({ title: "فشل جلب التقرير الموحد", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [groupId, startDate, endDate, toast]);

  const toggleLine = (code: string) => {
    setOpenLines((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Layers className="size-4 text-emerald-600 dark:text-emerald-400" />
          التقرير الموحد الأولي (Preliminary Consolidation)
          <Badge variant="outline" className="border-amber-400 text-[10px] text-amber-700 dark:text-amber-400">PRELIMINARY — توحيد أولي</Badge>
        </CardTitle>
        <CardDescription>
          الشركة أ + ب + … ← الإجمالي قبل الاستبعادات ← الاستبعادات ← الموحد. كل رقم قابل للتتبع من ورقة العمل.
          شركة بلا بيانات ⇒ INCOMPLETE_DATA (لا صفر صامت).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canManage ? (
          <p className="text-sm text-muted-foreground">لا تملك صلاحية عرض التقارير الموحدة.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1.5">
                <Label>المجموعة</Label>
                <Select value={groupId} onValueChange={setGroupId}>
                  <SelectTrigger aria-label="المجموعة"><SelectValue placeholder="اختر مجموعة" /></SelectTrigger>
                  <SelectContent>
                    {groups.map((g) => <SelectItem key={g.id} value={g.id}><span className="font-mono">{g.code}</span> — {g.nameAr}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>من تاريخ</Label>
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} dir="ltr" className="tnum" />
              </div>
              <div className="space-y-1.5">
                <Label>إلى تاريخ</Label>
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} dir="ltr" className="tnum" />
              </div>
              <div className="flex items-end">
                <Button onClick={() => void load()} disabled={loading || !groupId || !startDate || !endDate} className="gap-1.5 w-full">
                  {loading ? <Loader2 className="size-4 animate-spin" /> : null} توليد التقرير
                </Button>
              </div>
            </div>

            {data && (
              <>
                {data.status === "INCOMPLETE_DATA" && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                    <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" />INCOMPLETE_DATA — ملاحظات الاكتمال:</p>
                    <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs">
                      {data.completenessNotes.map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  </div>
                )}
                <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                  {data.members.map((m) => (
                    <div key={m.companyId} className={cn("rounded-md border p-2", m.dataStatus === "OK" ? "border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20" : "border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30")}>
                      <p className="font-semibold"><span className="tnum">{m.companyCode}</span>{m.ownershipPercentage !== null ? ` · ${m.ownershipPercentage}%` : ""}</p>
                      <p className="text-muted-foreground">سنة: {m.fiscalYearCode ?? "—"} · حالة: {m.dataStatus}</p>
                    </div>
                  ))}
                </div>

                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">البند الجماعي</TableHead>
                        {data.members.map((m) => <TableHead key={m.companyId} className="text-left text-[11px]">{m.companyCode}</TableHead>)}
                        <TableHead className="text-left">قبل الاستبعادات</TableHead>
                        <TableHead className="text-left">الاستبعادات</TableHead>
                        <TableHead className="text-left">الموحد</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.workingPaper.map((row) => {
                        const open = openLines.has(row.groupLineCode);
                        return (
                          <React.Fragment key={row.groupLineCode}>
                            <TableRow>
                              <TableCell>
                                <button type="button" className="flex items-center gap-1 text-xs hover:text-emerald-700 dark:hover:text-emerald-400" onClick={() => toggleLine(row.groupLineCode)} aria-expanded={open}>
                                  <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
                                  <span className="font-mono text-[10px]">{row.groupLineCode}</span> {row.groupLineNameAr}
                                </button>
                              </TableCell>
                              {row.companyValues.map((cv) => (
                                <TableCell key={cv.companyId} className="text-left text-xs tnum" dir="ltr">
                                  {cv.valueMinor === null ? <span className="text-amber-600 dark:text-amber-400">INCOMPLETE</span> : fmt(cv.valueMinor)}
                                </TableCell>
                              ))}
                              <TableCell className="text-left text-xs tnum" dir="ltr">{fmt(row.totalBeforeEliminationsMinor)}</TableCell>
                              <TableCell className={cn("text-left text-xs tnum", row.adjustmentsMinor !== null && row.adjustmentsMinor !== "0" && "font-semibold text-sky-700 dark:text-sky-400")} dir="ltr">{fmt(row.adjustmentsMinor)}</TableCell>
                              <TableCell className="text-left text-xs font-semibold tnum" dir="ltr">{fmt(row.consolidatedTotalMinor)}</TableCell>
                            </TableRow>
                            {open && (
                              <TableRow className="bg-muted/40 hover:bg-muted/40">
                                <TableCell colSpan={data.members.length + 4} className="py-2">
                                  <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                                    {row.companyValues.map((cv) => (
                                      <li key={cv.companyId} className="flex items-center justify-between gap-2">
                                        <span>{cv.companyCode}</span>
                                        <span dir="ltr" className="tnum">{cv.valueMinor === null ? "INCOMPLETE_DATA" : fmt(cv.valueMinor)}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </TableCell>
                              </TableRow>
                            )}
                          </React.Fragment>
                        );
                      })}
                      {data.workingPaper.length === 0 && (
                        <TableRow><TableCell colSpan={data.members.length + 4} className="h-14 text-center text-sm text-muted-foreground">لا بنود جماعية معرفة.</TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border p-3 text-sm">
                    <p className="mb-2 font-bold">قائمة الدخل الموحدة</p>
                    <p className="flex justify-between"><span>إجمالي الإيرادات</span><span className="tnum" dir="ltr">{fmt(data.profitOrLoss.totalRevenueMinor)}</span></p>
                    <p className="flex justify-between"><span>(إجمالي المصروفات)</span><span className="tnum" dir="ltr">{fmt(data.profitOrLoss.totalExpensesMinor)}</span></p>
                    <p className="flex justify-between border-t pt-1 font-bold"><span>صافي النتيجة</span><span className="tnum" dir="ltr">{fmt(data.profitOrLoss.netResultMinor)}</span></p>
                  </div>
                  <div className={cn("rounded-lg border p-3 text-sm", data.financialPosition.reconciled === false ? "border-rose-300 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/30" : "")}>
                    <p className="mb-2 font-bold">المركز المالي الموحد</p>
                    <p className="flex justify-between"><span>إجمالي الأصول</span><span className="tnum" dir="ltr">{fmt(data.financialPosition.totalAssetsMinor)}</span></p>
                    <p className="flex justify-between"><span>إجمالي الالتزامات</span><span className="tnum" dir="ltr">{fmt(data.financialPosition.totalLiabilitiesMinor)}</span></p>
                    <p className="flex justify-between"><span>إجمالي حقوق الملكية</span><span className="tnum" dir="ltr">{fmt(data.financialPosition.totalEquityMinor)}</span></p>
                    <p className="flex justify-between border-t pt-1 font-bold">
                      <span>فرق المعادلة (أ − ل − ح)</span>
                      <span className={cn("tnum", data.financialPosition.reconciled === false && "text-rose-700 dark:text-rose-400")} dir="ltr">{fmt(data.financialPosition.differenceMinor)}</span>
                    </p>
                    {data.financialPosition.reconciled === false && (
                      <p className="mt-1 text-xs text-rose-700 dark:text-rose-400">الفرق يُعرض ولا يُصحح تلقائيًا (بلا plug).</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
