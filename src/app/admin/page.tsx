"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { motion } from "framer-motion";
import {
  ChevronRight,
  DatabaseBackup,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  Power,
  Save,
  ShieldAlert,
  ShieldCheck,
  ScrollText,
  Trash2,
  User,
  UserCog,
  Users as UsersIcon,
  FolderOpen,
  ArchiveRestore,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { ModeToggle } from "@/components/mode-toggle";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuditTrailTab } from "@/components/admin/audit-trail";
import { BackupManagerTab } from "@/components/admin/backup-manager";
import {
  parsePermissions,
  DEFAULT_USER_PERMISSIONS,
  canManageBackups,
  type Permissions,
} from "@/lib/permissions";

/* ──────────────────────────────────────────────────────────────────────── */
/*  Types                                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: string;
  permissions: Permissions;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface GroupRow {
  id: string;
  name: string;
  reportCount: number;
  createdAt: string;
  updatedAt: string;
}

const PERMISSION_KEYS: { key: Exclude<keyof Permissions, "groupIds">; label: string; desc: string }[] = [
  { key: "view", label: "عرض", desc: "تصفّح التقارير" },
  { key: "add", label: "إضافة", desc: "حفظ التقارير" },
  { key: "edit", label: "تعديل", desc: "تعديل التقارير" },
  { key: "delete", label: "حذف", desc: "حذف التقارير" },
  { key: "groups", label: "المجموعات", desc: "إنشاء وإدارة المجموعات" },
  { key: "export", label: "تصدير", desc: "تنزيل ملفات Excel" },
  { key: "settings", label: "الإعدادات", desc: "تعديل البادئات" },
  { key: "manageUsers", label: "إدارة المستخدمين", desc: "الوصول لهذه الصفحة" },
  { key: "manageBackups", label: "النسخ الاحتياطي", desc: "إنشاء/تحقق/Drill/تنزيل النسخ (Phase 4A)" },
  // 4B.3 — صلاحية مستقلة عالية الخطورة: لا تُمنح مع المدير تلقائيًا (Explicit High-Risk)
  {
    key: "restoreDatabase",
    label: "استعادة قاعدة البيانات",
    desc: "استبدال قاعدة التشغيل بالكامل — مفتاح صريح مستقل لا يُمنح تلقائيًا لأي دور (4B.3)",
  },
];

/* ──────────────────────────────────────────────────────────────────────── */
/*  Page                                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

export default function AdminPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const { toast } = useToast();

  const [users, setUsers] = React.useState<UserRow[]>([]);
  const [groups, setGroups] = React.useState<GroupRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadingGroups, setLoadingGroups] = React.useState(false);

  // Create/Edit dialog state
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editingUser, setEditingUser] = React.useState<UserRow | null>(null);
  const [form, setForm] = React.useState<UserFormState>(emptyForm());
  const [saving, setSaving] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = React.useState<UserRow | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  // Toggle active state
  const [togglingId, setTogglingId] = React.useState<string | null>(null);

  /* ── Session / permission gate ── */
  const perms = React.useMemo<Permissions>(() => {
    if (!session?.user) return { ...DEFAULT_USER_PERMISSIONS };
    const raw = (session.user as any).permissions;
    if (typeof raw === "string") return parsePermissions(raw);
    if (raw && typeof raw === "object") return { ...DEFAULT_USER_PERMISSIONS, ...raw };
    return { ...DEFAULT_USER_PERMISSIONS };
  }, [session]);

  const currentUserId = (session?.user as any)?.id as string | undefined;
  const currentUserRole = ((session?.user as any)?.role as string) || "user";
  const showBackupsTab = canManageBackups(perms, currentUserRole);
  // 4B.3 — صفحة الإدارة تفتح لصاحب manageUsers أو manageBackups (فصل الصلاحيات):
  // حامل النسخ فقط يرى تبويب النسخ حصرًا، وحامل manageUsers يرى المستخدمين.
  const canOpenAdminPage = perms.manageUsers || showBackupsTab;
  // تبويب التدقيق: الـAPI خلف requireAdmin (دور) — يُخفى لغير المدير دورًا.
  const showAuditTab = currentUserRole === "admin";
  const showUsersTab = perms.manageUsers;
  const defaultTab = showUsersTab ? "users" : "backups";

  React.useEffect(() => {
    if (status === "loading") return;
    if (status === "unauthenticated") {
      router.replace("/login?callbackUrl=/admin");
      return;
    }
    if (!canOpenAdminPage) {
      toast({
        title: "غير مصرّح",
        description: "لا تملك صلاحية إدارة المستخدمين أو النسخ الاحتياطي",
        variant: "destructive",
      });
      router.replace("/");
      return;
    }
    if (perms.manageUsers) {
      void fetchUsers();
      void fetchGroups();
    }
  }, [status, canOpenAdminPage, perms.manageUsers]);

  async function fetchUsers() {
    setLoading(true);
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      if (!res.ok) throw new Error("فشل جلب المستخدمين");
      const data = await res.json();
      setUsers(data as UserRow[]);
    } catch (err) {
      toast({
        title: "خطأ",
        description: err instanceof Error ? err.message : "خطأ",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  /* ── Fetch groups owned by the current admin (for the multi-select) ── */
  async function fetchGroups() {
    setLoadingGroups(true);
    try {
      const res = await fetch("/api/groups", { cache: "no-store" });
      if (!res.ok) {
        // Most likely the admin doesn't have `groups` permission — silently
        // keep the list empty so the multi-select simply shows no options.
        if (res.status !== 401 && res.status !== 403) {
          throw new Error("فشل جلب المجموعات");
        }
        setGroups([]);
        return;
      }
      const data = await res.json();
      setGroups(data as GroupRow[]);
    } catch (err) {
      toast({
        title: "خطأ",
        description: err instanceof Error ? err.message : "خطأ",
        variant: "destructive",
      });
    } finally {
      setLoadingGroups(false);
    }
  }

  /* ── Open create dialog ── */
  function openCreate() {
    setEditingUser(null);
    setForm(emptyForm());
    setShowPassword(false);
    setEditorOpen(true);
  }

  /* ── Open edit dialog ── */
  function openEdit(u: UserRow) {
    setEditingUser(u);
    setForm({
      username: u.username,
      displayName: u.displayName,
      password: "",
      role: u.role === "admin" ? "admin" : "user",
      active: u.active,
      permissions: { ...u.permissions },
      // Defensive: coerce to a clean array. Undefined → [] (no linkage).
      groupIds: Array.isArray(u.permissions.groupIds) ? [...u.permissions.groupIds] : [],
    });
    setShowPassword(false);
    setEditorOpen(true);
  }

  /* ── Save (create or update) ── */
  async function handleSave() {
    if (!form.username.trim()) {
      toast({ title: "اسم المستخدم مطلوب", variant: "destructive" });
      return;
    }
    if (!editingUser && !form.password) {
      toast({ title: "كلمة المرور مطلوبة لإنشاء المستخدم", variant: "destructive" });
      return;
    }
    if (form.password && form.password.length < 6) {
      toast({ title: "كلمة المرور يجب ألا تقل عن 6 أحرف", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const isAdmin = form.role === "admin";
      // Only filter groupIds to ones that still exist in the admin's group list.
      // (Helps avoid stale linkage if a group was deleted.)
      const validGroupIds = isAdmin
        ? []
        : (form.groupIds || []).filter(
            (gid) => groups.length === 0 || groups.some((g) => g.id === gid)
          );
      const body: Record<string, unknown> = {
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        role: form.role,
        active: form.active,
        // 4B.3 — نرسل صلاحيات النموذج دائمًا كما هي (من بينها restoreDatabase):
        // الخادم يطبق قالب المدير على باقي الصلاحيات لكن يأخذ restoreDatabase
        // من القيمة الصريحة هنا — لا ADMIN_PERMISSIONS جاهزة (كانت تمنح/تمحو بصمت).
        permissions: form.permissions,
        groupIds: validGroupIds,
      };
      if (form.password) body.password = form.password;

      const url = editingUser ? `/api/users/${editingUser.id}` : "/api/users";
      const method = editingUser ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data as { error?: string }).error || "فشل الحفظ";
        throw new Error(msg);
      }
      toast({
        title: editingUser ? "تم تحديث المستخدم" : "تم إنشاء المستخدم",
        description: form.username,
      });
      setEditorOpen(false);
      await fetchUsers();
    } catch (err) {
      toast({
        title: "خطأ في الحفظ",
        description: err instanceof Error ? err.message : "خطأ",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  /* ── Toggle active ── */
  async function handleToggleActive(u: UserRow) {
    setTogglingId(u.id);
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !u.active }),
      });
      if (!res.ok) throw new Error("فشل التحديث");
      toast({ title: !u.active ? "تم تفعيل المستخدم" : "تم تعطيل المستخدم", description: u.username });
      await fetchUsers();
    } catch (err) {
      toast({
        title: "خطأ",
        description: err instanceof Error ? err.message : "خطأ",
        variant: "destructive",
      });
    } finally {
      setTogglingId(null);
    }
  }

  /* ── Delete ── */
  async function handleDelete() {
    if (!deleteTarget) return;
    if (deleteTarget.id === currentUserId) {
      toast({ title: "لا يمكن حذف حسابك الحالي", variant: "destructive" });
      setDeleteTarget(null);
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/users/${deleteTarget.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || "فشل الحذف");
      toast({ title: "تم حذف المستخدم", description: deleteTarget.username });
      setDeleteTarget(null);
      await fetchUsers();
    } catch (err) {
      toast({
        title: "خطأ في الحذف",
        description: err instanceof Error ? err.message : "خطأ",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  }

  // 4B.3 — حالة التحقق عند التحميل، أو إذا انتهى التحميل بلا أي صلاحية إدارية
  if (status === "loading" || (!canOpenAdminPage && status === "authenticated")) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="flex items-center gap-3 text-slate-500 dark:text-slate-400">
          <Loader2 className="size-5 animate-spin text-emerald-600" />
          <span className="text-sm">جارٍ التحقق من الصلاحيات…</span>
        </div>
      </div>
    );
  }

  if (!canOpenAdminPage) return null;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 dark:bg-slate-950">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/80">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-600 to-teal-700 text-white shadow-md">
              <UserCog className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-extrabold leading-tight text-slate-800 dark:text-slate-100 sm:text-lg">
                لوحة الإدارة
              </h1>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 sm:text-xs">
                إدارة الحسابات والصلاحيات وسجل التدقيق
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild className="gap-1.5 border-slate-300 dark:border-slate-700">
              <a href="/" aria-label="العودة للصفحة الرئيسية">
                <ChevronRight className="size-3.5" />
                <span className="hidden sm:inline">الرئيسية</span>
              </a>
            </Button>
            {session?.user && (
              <div className="hidden items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs dark:border-slate-700 sm:flex">
                <div className="flex size-6 items-center justify-center rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                  <User className="size-3.5" />
                </div>
                <div className="leading-tight">
                  <div className="font-semibold text-slate-800 dark:text-slate-100">{session.user.name}</div>
                  <div className="text-[10px] text-slate-400">{(session.user as { role?: string }).role || "user"}</div>
                </div>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-9 text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950/30"
              onClick={() => signOut({ callbackUrl: "/login" })}
              aria-label="تسجيل الخروج"
            >
              <LogOut className="size-4" />
            </Button>
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <Tabs defaultValue={defaultTab} className="w-full">
          <TabsList  className={cn(
              "mb-4 grid w-full",
              showUsersTab && showAuditTab && showBackupsTab && "grid-cols-3",
              showUsersTab && !showBackupsTab && "grid-cols-2",
              !showUsersTab && "grid-cols-1",
              "sm:w-fit"
            )}
          >
            {showUsersTab && (
              <TabsTrigger value="users" className="gap-1.5">
                <UsersIcon className="size-3.5" />
                المستخدمون
              </TabsTrigger>
            )}
            {showAuditTab && (
              <TabsTrigger value="audit" className="gap-1.5">
                <ScrollText className="size-3.5" />
                سجل التدقيق
              </TabsTrigger>
            )}
            {showBackupsTab && (
              <TabsTrigger value="backups" className="gap-1.5">
                <DatabaseBackup className="size-3.5" />
                النسخ الاحتياطي
              </TabsTrigger>
            )}
          </TabsList>

          {showUsersTab && (
          <TabsContent value="users" className="mt-0 space-y-6">
        {/* Summary cards */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-6 grid gap-3 sm:grid-cols-3"
        >
          <SummaryCard
            icon={<UsersIcon className="size-4" />}
            label="إجمالي المستخدمين"
            value={String(users.length)}
            tone="emerald"
          />
          <SummaryCard
            icon={<ShieldCheck className="size-4" />}
            label="المدراء"
            value={String(users.filter((u) => u.role === "admin").length)}
            tone="teal"
          />
          <SummaryCard
            icon={<Power className="size-4" />}
            label="الحسابات النشطة"
            value={String(users.filter((u) => u.active).length)}
            tone="amber"
          />
        </motion.section>

        {/* Users table */}
        <Card className="border-slate-200 shadow-sm dark:border-slate-800">
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-slate-800 dark:text-slate-100">
                <UsersIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
                قائمة المستخدمين
              </CardTitle>
              <CardDescription>إدارة الحسابات والصلاحيات وتفعيل/تعطيل الدخول</CardDescription>
            </div>
            <Button onClick={openCreate} className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700">
              <Plus className="size-4" />
              <span className="hidden sm:inline">مستخدم جديد</span>
              <span className="sm:hidden">جديد</span>
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center gap-3 py-16 text-slate-400 dark:text-slate-500">
                <Loader2 className="size-5 animate-spin text-emerald-600" />
                <span className="text-sm">جارٍ التحميل…</span>
              </div>
            ) : users.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white/50 py-14 text-center dark:border-slate-700 dark:bg-slate-900/30">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                  <UsersIcon className="size-6" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">لا يوجد مستخدمون</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">ابدأ بإنشاء مستخدم جديد</p>
                </div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-slate-200 dark:border-slate-700">
                      <TableHead className="text-right">المستخدم</TableHead>
                      <TableHead className="text-right">الدور</TableHead>
                      <TableHead className="text-right">الصلاحيات</TableHead>
                      <TableHead className="text-right">الحالة</TableHead>
                      <TableHead className="text-right">أُنشئ في</TableHead>
                      <TableHead className="text-center">إجراءات</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((u) => (
                      <TableRow key={u.id} className="border-slate-100 dark:border-slate-800">
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <div className={cn(
                              "flex size-8 items-center justify-center rounded-lg text-xs font-bold text-white",
                              u.role === "admin"
                                ? "bg-gradient-to-br from-emerald-600 to-teal-700"
                                : "bg-slate-400 dark:bg-slate-600"
                            )}>
                              {(u.displayName || u.username).charAt(0).toUpperCase()}
                            </div>
                            <div className="leading-tight">
                              <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
                                {u.displayName || u.username}
                                {u.id === currentUserId && (
                                  <Badge variant="outline" className="border-emerald-300 bg-emerald-50 px-1.5 py-0 text-[9px] text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-400">
                                    أنت
                                  </Badge>
                                )}
                              </div>
                              <div className="text-[11px] text-slate-400" dir="ltr">{u.username}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {u.role === "admin" ? (
                            <Badge className="border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                              <ShieldCheck className="size-3" /> مدير
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300">
                              <User className="size-3" /> مستخدم
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {PERMISSION_KEYS
                              .filter((p) => u.permissions[p.key])
                              .map((p) => (
                                <span
                                  key={p.key}
                                  className={cn(
                                    "rounded-md px-1.5 py-0.5 text-[9px] font-medium",
                                    p.key === "restoreDatabase"
                                      ? "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
                                      : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                                  )
                                  }
                                  title={p.desc}
                                >
                                  {p.label}
                                </span>
                              ))}
                            {u.role === "admin" && (
                              <span
                                className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                                title="صلاحيات الإدارة كاملة بالدور — عدا استعادة قاعدة البيانات (مفتاح صريح مستقل — 4B.3)"
                              >
                                إدارة كاملة (عدا الاستعادة)
                              </span>
                            )}
                            {u.role !== "admin" && Array.isArray(u.permissions.groupIds) && u.permissions.groupIds.length > 0 && (
                              <span
                                className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                                title={u.permissions.groupIds.length + " مجموعات مسموح بها"}
                              >
                                <FolderOpen className="inline size-2.5 align-middle" /> {u.permissions.groupIds.length} مجموعة
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {u.active ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                              <span className="size-1.5 rounded-full bg-emerald-500" /> نشط
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 dark:text-slate-500">
                              <span className="size-1.5 rounded-full bg-slate-400" /> معطّل
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-slate-500 dark:text-slate-400">
                          {new Date(u.createdAt).toLocaleDateString("ar")}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-slate-500 hover:bg-slate-100 hover:text-emerald-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-emerald-400"
                              onClick={() => openEdit(u)}
                              aria-label="تعديل"
                              title="تعديل"
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-slate-500 hover:bg-amber-50 hover:text-amber-700 dark:text-slate-400 dark:hover:bg-amber-950/30 dark:hover:text-amber-400"
                              onClick={() => handleToggleActive(u)}
                              disabled={togglingId === u.id || u.id === currentUserId}
                              aria-label={u.active ? "تعطيل" : "تفعيل"}
                              title={u.active ? "تعطيل" : "تفعيل"}
                            >
                              {togglingId === u.id ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Power className="size-3.5" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                              onClick={() => setDeleteTarget(u)}
                              disabled={u.id === currentUserId}
                              aria-label="حذف"
                              title={u.id === currentUserId ? "لا يمكن حذف حسابك" : "حذف"}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Permission legend */}
        <Card className="mt-6 border-slate-200 dark:border-slate-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
              مفتاح الصلاحيات
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {PERMISSION_KEYS.map((p) => (
                <div
                  key={p.key}
                  className={cn(
                    "rounded-lg border p-2.5",
                    p.key === "restoreDatabase"
                      ? "border-rose-200 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/30"
                      : "border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/40"
                  )}
                >
                  <div className={cn(
                    "text-xs font-bold",
                    p.key === "restoreDatabase"
                      ? "text-rose-700 dark:text-rose-300"
                      : "text-slate-700 dark:text-slate-200"
                  )}>{p.label}</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">{p.desc}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
          </TabsContent>
          )}

          {showAuditTab && (
          <TabsContent value="audit" className="mt-0">
            <AuditTrailTab />
          </TabsContent>
          )}

          {showBackupsTab && (
            <TabsContent value="backups" className="mt-0">
              <BackupManagerTab />
            </TabsContent>
          )}
        </Tabs>
      </main>

      <footer className="mt-auto border-t border-slate-200 bg-white/80 backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/80">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-1 px-4 py-4 text-center sm:flex-row sm:px-6 sm:text-right">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            لوحة الإدارة · جميع العمليات مسجّلة ومرتبطة بحسابك
          </p>
          <p className="text-xs text-slate-400 dark:text-slate-500">Next.js 16 · NextAuth v4 · Prisma</p>
        </div>
      </footer>

      {/* Create / Edit dialog */}
      <Dialog open={editorOpen} onOpenChange={(open) => {
        if (!saving) setEditorOpen(open);
      }}>
        <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {editingUser ? (
                <><Pencil className="size-4 text-emerald-600" /> تعديل المستخدم</>
              ) : (
                <><Plus className="size-4 text-emerald-600" /> مستخدم جديد</>
              )}
            </DialogTitle>
            <DialogDescription>
              {editingUser
                ? "تعديل بيانات الحساب والصلاحيات. اترك كلمة المرور فارغة للإبقاء عليها."
                : "أنشئ حساباً جديداً وحدد صلاحياته."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Username */}
            <div className="space-y-1.5">
              <Label htmlFor="u-username">اسم المستخدم</Label>
              <div className="relative">
                <User className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                <Input
                  id="u-username"
                  value={form.username}
                  onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                  placeholder="username"
                  className="pr-9"
                  dir="ltr"
                  autoFocus
                />
              </div>
            </div>

            {/* Display name */}
            <div className="space-y-1.5">
              <Label htmlFor="u-display">الاسم المعروض</Label>
              <Input
                id="u-display"
                value={form.displayName}
                onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
                placeholder="مثلاً: محمد أحمد"
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <Label htmlFor="u-password">
                كلمة المرور {editingUser && <span className="text-[11px] text-slate-400">(اتركها فارغة للإبقاء على الحالية)</span>}
              </Label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                <Input
                  id="u-password"
                  type={showPassword ? "text" : "password"}
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder={editingUser ? "••••••••" : "أدخل كلمة المرور"}
                  className="px-9"
                  dir="ltr"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                  aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {!editingUser && (
                <p className="text-[11px] text-slate-400">٦ أحرف على الأقل</p>
              )}
            </div>

            {/* Role + Active */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>الدور</Label>
                <Select
                  value={form.role}
                  onValueChange={(v) => setForm((f) => ({ ...f, role: v as "admin" | "user" }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="— اختر —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">مستخدم</SelectItem>
                    <SelectItem value="admin">مدير</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>حالة الحساب</Label>
                <div className="flex h-9 items-center gap-2 rounded-md border border-slate-200 px-3 dark:border-slate-700">
                  <Switch
                    id="u-active"
                    checked={form.active}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, active: v }))}
                  />
                  <Label htmlFor="u-active" className="cursor-pointer text-xs">
                    {form.active ? "نشط" : "معطّل"}
                  </Label>
                </div>
              </div>
            </div>

            {/* Permissions */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>الصلاحيات</Label>
                {form.role === "admin" && (
                  <Badge className="border-transparent bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                    <ShieldAlert className="size-3" /> المدير يملك الصلاحيات الإدارية تلقائياً (عدا الاستعادة)
                  </Badge>
                )}
              </div>
              <div
                className={cn(
                  "grid grid-cols-1 gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700 sm:grid-cols-2",
                  form.role === "admin" && "pointer-events-none opacity-50"
                )}
              >
                {PERMISSION_KEYS.filter((p) => p.key !== "restoreDatabase").map((p) => (
                  <label
                    key={p.key}
                    htmlFor={`perm-${p.key}`}
                    className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                  >
                    <Checkbox
                      id={`perm-${p.key}`}
                      checked={form.role === "admin" ? true : form.permissions[p.key]}
                      onCheckedChange={(v) =>
                        setForm((f) => ({
                          ...f,
                          permissions: { ...f.permissions, [p.key]: v === true },
                        }))
                      }
                    />
                    <div className="leading-tight">
                      <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">{p.label}</div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">{p.desc}</div>
                    </div>
                  </label>
                ))}
              </div>

              {/* 4B.3 — صلاحية الاستعادة: مستقلة دائمًا عن الدور، قابلة للمنح/السحب
                  لكل من المدير والمستخدم — لا تُمنح تلقائيًا أبدًا */}
              <div className="rounded-lg border border-rose-300 bg-rose-50/70 p-3 dark:border-rose-900 dark:bg-rose-950/30">
                <label
                  htmlFor="perm-restoreDatabase"
                  className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                >
                  <Checkbox
                    id="perm-restoreDatabase"
                    checked={form.permissions.restoreDatabase === true}
                    onCheckedChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        permissions: { ...f.permissions, restoreDatabase: v === true },
                      }))
                    }
                  />
                  <div className="leading-tight">
                    <div className="flex items-center gap-1 text-xs font-semibold text-rose-700 dark:text-rose-300">
                      <ArchiveRestore className="size-3.5" />
                      استعادة قاعدة البيانات (خطورة عالية)
                    </div>
                    <div className="text-[10px] text-rose-600/90 dark:text-rose-400/90">
                      استبدال قاعدة التشغيل بالكامل عبر Recovery Engine — مفتاح صريح مستقل لا
                      يُمنح مع دور المدير ولا مع أي صلاحية أخرى. يظهر إجراء الاستعادة في واجهة
                      النسخ لحاملي هذا المفتاح فقط (4B.3).
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {/* Group linkage (multi-select) — controls which groups the user can
                see in the main page. Hidden for admins (they see everything). */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <FolderOpen className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                  المجموعات المسموح بها
                </Label>
                <span className="text-[10px] text-slate-400">
                  {form.role === "admin"
                    ? "المدير يرى جميع المجموعات"
                    : form.groupIds.length === 0
                    ? "بلا تحديد → يرى مجموعاته الخاصة فقط"
                    : `${form.groupIds.length} مجموعة محددة`}
                </span>
              </div>
              {form.role === "admin" ? (
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-3 py-3 text-center text-[11px] text-slate-400 dark:border-slate-700 dark:bg-slate-900/40">
                  المدراء يملكون صلاحية كاملة على المجموعات — لا حاجة للتحديد.
                </div>
              ) : loadingGroups ? (
                <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-3 text-[11px] text-slate-400 dark:border-slate-700">
                  <Loader2 className="size-3.5 animate-spin" /> جارٍ تحميل المجموعات…
                </div>
              ) : groups.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-3 py-3 text-center text-[11px] text-slate-400 dark:border-slate-700 dark:bg-slate-900/40">
                  لا توجد مجموعات لديك. أنشئ مجموعات أولاً من الصفحة الرئيسية.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-1.5 rounded-lg border border-slate-200 p-3 dark:border-slate-700 sm:grid-cols-2">
                  {groups.map((g) => {
                    const checked = form.groupIds.includes(g.id);
                    return (
                      <label
                        key={g.id}
                        htmlFor={`link-group-${g.id}`}
                        className="flex cursor-pointer items-center gap-2 rounded-md p-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      >
                        <Checkbox
                          id={`link-group-${g.id}`}
                          checked={checked}
                          onCheckedChange={(v) =>
                            setForm((f) => ({
                              ...f,
                              groupIds: v
                                ? [...f.groupIds, g.id]
                                : f.groupIds.filter((gid) => gid !== g.id),
                            }))
                          }
                        />
                        <div className="leading-tight">
                          <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                            {g.name}
                          </div>
                          <div className="text-[10px] text-slate-500 dark:text-slate-400">
                            {g.reportCount} تقرير
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
              {form.role !== "admin" && groups.length > 0 && (
                <div className="flex items-center gap-3 text-[10px] text-slate-400">
                  <button
                    type="button"
                    onClick={() =>
                      setForm((f) => ({ ...f, groupIds: groups.map((g) => g.id) }))
                    }
                    className="text-emerald-600 underline-offset-2 hover:underline dark:text-emerald-400"
                  >
                    تحديد الكل
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, groupIds: [] }))}
                    className="text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
                  >
                    مسح التحديد
                  </button>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>
              إلغاء
            </Button>
            <Button onClick={handleSave} disabled={saving} className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700">
              {saving ? (
                <><Loader2 className="size-4 animate-spin" /> جارٍ الحفظ…</>
              ) : (
                <><Save className="size-4" /> {editingUser ? "حفظ التعديلات" : "إنشاء المستخدم"}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => {
        if (!deleting) setDeleteTarget(open ? deleteTarget : null);
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-rose-600" />
              تأكيد الحذف
            </AlertDialogTitle>
            <AlertDialogDescription>
              سيتم حذف المستخدم <strong className="text-slate-800 dark:text-slate-100">{deleteTarget?.displayName || deleteTarget?.username}</strong> نهائياً
              {deleteTarget && " ("}
              <span className="text-slate-500" dir="ltr">{deleteTarget?.username}</span>
              {deleteTarget && ") "} مع جميع تقاريره ومجموعاته. لا يمكن التراجع عن هذا الإجراء.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>إلغاء</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
              disabled={deleting}
              className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700"
            >
              {deleting ? (
                <><Loader2 className="size-4 animate-spin" /> جارٍ الحذف…</>
              ) : (
                <><Trash2 className="size-4" /> حذف نهائي</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

interface UserFormState {
  username: string;
  displayName: string;
  password: string;
  role: "admin" | "user";
  active: boolean;
  permissions: Permissions;
  /** IDs of groups this user is allowed to see in the main page. */
  groupIds: string[];
}

function emptyForm(): UserFormState {
  return {
    username: "",
    displayName: "",
    password: "",
    role: "user",
    active: true,
    permissions: { ...DEFAULT_USER_PERMISSIONS },
    groupIds: [],
  };
}

type Tone = "emerald" | "teal" | "amber";

function SummaryCard({
  icon, label, value, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: Tone;
}) {
  const tones: Record<Tone, string> = {
    emerald: "from-emerald-600 to-teal-700",
    teal: "from-teal-600 to-cyan-700",
    amber: "from-amber-500 to-orange-600",
  };
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/40">
      <div className={cn("flex size-10 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-md", tones[tone])}>
        {icon}
      </div>
      <div className="leading-tight">
        <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">{value}</div>
        <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      </div>
    </div>
  );
}
