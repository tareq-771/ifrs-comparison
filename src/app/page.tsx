"use client";

// 6.7 — الهيكل الموحد لنظام التقارير المالية الموحدة.
// الصفحة الرئيسية = لوحة معلومات + ملاحة RTL واضحة؛ المسار الوظيفي:
//   الشركة ← السنة/الفترة ← ميزان المراجعة ← القوائم المالية ← الموازنة والمقارنات ← التقارير الموحدة.
// أداة مقارنة Excel القديمة محفوظة كأداة ضمن النظام (تبويب مستقل) — ليست مركز الشاشة.
// الملاحة تبديل حالات داخل "/" (بلا مسارات وهمية) + ترابط ?view= للروابط العميقة.

import * as React from "react";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import {
  BarChart3, FileBarChart, FileSpreadsheet, Layers, LayoutDashboard, LogOut, Palette, Scale, Settings2,
  Target, UserCog, User as UserIcon, ArrowLeftRight, Map, Wallet,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { ModeToggle } from "@/components/mode-toggle";
import { CompanyPeriodProvider } from "@/components/reporting/company-period-context";
import { DashboardView, type HomeView } from "@/components/reporting/dashboard-view";
import { StatementsView } from "@/components/reporting/statements-view";
import { BudgetView } from "@/components/reporting/budget-view";
import { ConsolidationView } from "@/components/reporting/consolidation-view";
import { ReportsCenter } from "@/components/reporting/reports-center";
import { TrialBalanceTab } from "@/components/admin/trial-balance-tab";
import { CompareWorkspace } from "@/components/compare/compare-workspace";
import { AgingView } from "@/components/reporting/aging-view";
import { AppearanceView } from "@/components/appearance/appearance-view";
import {
  parsePermissions, DEFAULT_USER_PERMISSIONS, type Permissions,
} from "@/lib/permissions";

const VIEW_PARAM = "view";

const NAV_ITEMS: Array<{
  key: HomeView; label: string; icon: React.ReactNode; hint: string;
}> = [
  { key: "dashboard", label: "لوحة المعلومات", icon: <LayoutDashboard className="size-4" />, hint: "حالة التقارير والاختصارات" },
  { key: "trial-balance", label: "ميزان المراجعة", icon: <Scale className="size-4" />, hint: "استيراد واعتماد المصدر الفعلي" },
  { key: "statements", label: "القوائم المالية", icon: <FileBarChart className="size-4" />, hint: "ربح شامل · مركز مالي · حقوق ملكية · تدفقات" },
  { key: "budget", label: "الموازنة والمقارنات", icon: <Target className="size-4" />, hint: "الموازنة وفعلي مقابل موازنة" },
  { key: "aging", label: "أعمار الديون والتحصيل", icon: <Wallet className="size-4" />, hint: "أعمار الديون والمخاطر والرؤى (6.10)" },
  { key: "reports", label: "مركز التقارير", icon: <FileSpreadsheet className="size-4" />, hint: "الشركة ← السنة ← الفترة ← نوع التقرير + طباعة A4" },
  { key: "consolidation", label: "التقارير الموحدة", icon: <Layers className="size-4" />, hint: "المجموعات والتوحيد الأولي" },
  { key: "compare", label: "أدوات المقارنة", icon: <ArrowLeftRight className="size-4" />, hint: "أداة مقارنة Excel (الوظيفة السابقة)" },
  { key: "appearance", label: "المظهر والتخصيص", icon: <Palette className="size-4" />, hint: "الثيمات والخطوط والأحجام والكثافة وتخصيص اللوحة (6.11)" },
];

function readViewFromUrl(): HomeView {
  if (typeof window === "undefined") return "dashboard";
  const v = new URLSearchParams(window.location.search).get(VIEW_PARAM);
  return (NAV_ITEMS.some((n) => n.key === v) ? v : "dashboard") as HomeView;
}

export default function Home() {
  const { toast } = useToast();
  const { data: session, status: sessionStatus } = useSession();

  const perms = React.useMemo<Permissions>(() => {
    if (!session?.user) return { ...DEFAULT_USER_PERMISSIONS };
    const raw = (session.user as { permissions?: unknown }).permissions;
    if (typeof raw === "string") return parsePermissions(raw);
    if (raw && typeof raw === "object") return { ...DEFAULT_USER_PERMISSIONS, ...(raw as Partial<Permissions>) };
    return { ...DEFAULT_USER_PERMISSIONS };
  }, [session]);

  const role = ((session?.user as { role?: string } | undefined)?.role) ?? "user";
  const username = ((session?.user as { username?: string } | undefined)?.username) ?? "";
  const displayName = session?.user?.name || username;

  const [view, setView] = React.useState<HomeView>("dashboard");

  // مزامنة الملاحة مع ?view= (روابط عميقة من لوحة المعلومات والإدارة)
  React.useEffect(() => {
    setView(readViewFromUrl());
    const onPop = () => setView(readViewFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 6.8 — navigate يدعم باراميترات إضافية للروابط العميقة من مركز التقارير
  const navigate = React.useCallback((next: HomeView, params?: Record<string, string | undefined>) => {
    setView(next);
    const q = new URLSearchParams();
    if (next !== "dashboard") q.set(VIEW_PARAM, next);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== "") q.set(k, v);
    }
    const qs = q.toString();
    window.history.pushState(null, "", qs ? `/?${qs}` : "/");
  }, []);

  const canOpenAdmin =
    role === "admin" || perms.manageUsers || perms.manageBackups ||
    perms.manageCompanies || perms.manageFiscalYears || perms.manageTrialBalances ||
    perms.manageAccountNature || perms.managePeriods;

  // جلسة قيد التحميل — شاشة انتظار هادئة
  if (sessionStatus === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
          <BarChart3 className="size-5 animate-pulse text-emerald-600 dark:text-emerald-400" />
          جارٍ تحميل نظام التقارير المالية الموحدة…
        </div>
      </div>
    );
  }

  return (
    <CompanyPeriodProvider>
      <div className="flex min-h-screen flex-col bg-slate-50 dark:bg-slate-950">
        {/* الهيدر الموحد — هوية النظام */}
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/85">
          <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
            <div className="flex h-14 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-600 to-teal-700 text-white shadow-md">
                  <BarChart3 className="size-5" />
                </div>
                <div className="min-w-0">
                  <h1 className="truncate text-sm font-extrabold leading-tight text-slate-800 dark:text-slate-100 sm:text-base">
                    نظام التقارير المالية الموحدة
                  </h1>
                  <p className="hidden text-[11px] text-slate-500 dark:text-slate-400 sm:block">
                    تقارير مالية وفق المعايير الدولية IFRS — إعداد · اعتماد · توحيد
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {canOpenAdmin && (
                  <Button
                    variant="outline" size="sm" asChild
                    className="gap-1.5 border-emerald-300 bg-emerald-50/50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-400 dark:hover:bg-emerald-950/50"
                  >
                    <Link href="/admin" aria-label="لوحة الإدارة">
                      <UserCog className="size-3.5" />
                      <span className="hidden sm:inline">الإدارة</span>
                    </Link>
                  </Button>
                )}
                {sessionStatus === "authenticated" && session?.user && (
                  <div className="hidden items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 text-xs dark:border-slate-700 md:flex">
                    <div className="flex size-6 items-center justify-center rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                      <UserIcon className="size-3.5" />
                    </div>
                    <div className="leading-tight">
                      <div className="font-semibold text-slate-800 dark:text-slate-100">{displayName}</div>
                      <div className="text-[10px] text-slate-400">{role === "admin" ? "مدير النظام" : "مستخدم"}</div>
                    </div>
                  </div>
                )}
                <Button
                  variant="ghost" size="icon"
                  className="size-9 text-slate-500 hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950/30"
                  onClick={() => signOut({ callbackUrl: "/login" })}
                  aria-label="تسجيل الخروج" title="تسجيل الخروج"
                >
                  <LogOut className="size-4" />
                </Button>
                <ModeToggle />
              </div>
            </div>
            {/* الملاحة الرئيسية */}
            <nav aria-label="الملاحة الرئيسية" className="scroll-thin -mx-1 overflow-x-auto pb-px">
              <ul className="flex min-w-max items-stretch gap-1 px-1">
                {NAV_ITEMS.map((item) => {
                  const active = view === item.key;
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        onClick={() => navigate(item.key)}
                        aria-current={active ? "page" : undefined}
                        title={item.hint}
                        className={cn(
                          "flex min-h-[40px] items-center gap-1.5 rounded-t-lg border-b-2 px-3 text-xs font-bold transition-colors sm:text-[13px]",
                          active
                            ? "border-emerald-600 text-emerald-700 dark:border-emerald-400 dark:text-emerald-400"
                            : "border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-200"
                        )}
                      >
                        {item.icon}
                        {item.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          </div>
        </header>

        {/* المحتوى */}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
          {view === "dashboard" && (
            <DashboardView onNavigate={navigate} perms={perms} role={role} />
          )}
          {view === "trial-balance" && (
            <TrialBalanceTab />
          )}
          {view === "compare" && (
            <CompareWorkspace />
          )}
          {view === "statements" && (
            <StatementsView />
          )}
          {view === "budget" && (
            <BudgetView />
          )}
          {view === "aging" && (
            <AgingView />
          )}
          {view === "consolidation" && (
            <ConsolidationView />
          )}
          {view === "reports" && (
            <ReportsCenter onNavigate={navigate} />
          )}
          {view === "appearance" && (
            <AppearanceView />
          )}
        </main>

        {/* تذييل ثابت أسفل الشاشة — مع مراعاة مناطق الأمان على الجوال */}
        <footer className="mt-auto border-t border-slate-200 bg-white/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/80">
          <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-1 px-4 py-3 text-center sm:flex-row sm:px-6 sm:text-right">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              نظام التقارير المالية الموحدة — قوائم وموازنات وتقارير موحدة وفق IFRS
            </p>
            <p className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500">
              <Map className="size-3" />
              <span>المرحلة 6.11 — المظهر والتجربة والتنبيهات الذكية</span>
            </p>
          </div>
        </footer>
      </div>
    </CompanyPeriodProvider>
  );
}
