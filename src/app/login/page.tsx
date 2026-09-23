"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { ArrowLeftRight, Loader2, LockKeyhole, Palette, ShieldCheck, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/* ──────────────────────────────────────────────────────────────────────── */
/*  Login screen themes                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

type LoginTheme = "emerald" | "ocean" | "sunset" | "royal";

const THEMES: Record<LoginTheme, {
  label: string;
  bg: string;
  blob1: string;
  blob2: string;
  logo: string;
  button: string;
  buttonHover: string;
}> = {
  emerald: {
    label: "زمردي",
    bg: "bg-gradient-to-br from-slate-50 via-emerald-50/40 to-teal-50/30 dark:from-slate-950 dark:via-slate-950 dark:to-emerald-950/20",
    blob1: "bg-emerald-400/20 dark:bg-emerald-500/10",
    blob2: "bg-teal-400/20 dark:bg-teal-500/10",
    logo: "from-emerald-600 to-teal-700",
    button: "from-emerald-600 to-teal-700",
    buttonHover: "hover:from-emerald-700 hover:to-teal-800",
  },
  ocean: {
    label: "محيط",
    bg: "bg-gradient-to-br from-slate-50 via-sky-50/40 to-cyan-50/30 dark:from-slate-950 dark:via-slate-950 dark:to-sky-950/20",
    blob1: "bg-sky-400/20 dark:bg-sky-500/10",
    blob2: "bg-cyan-400/20 dark:bg-cyan-500/10",
    logo: "from-sky-600 to-cyan-700",
    button: "from-sky-600 to-cyan-700",
    buttonHover: "hover:from-sky-700 hover:to-cyan-800",
  },
  sunset: {
    label: "غروب",
    bg: "bg-gradient-to-br from-slate-50 via-orange-50/40 to-rose-50/30 dark:from-slate-950 dark:via-slate-950 dark:to-orange-950/20",
    blob1: "bg-orange-400/20 dark:bg-orange-500/10",
    blob2: "bg-rose-400/20 dark:bg-rose-500/10",
    logo: "from-orange-600 to-rose-700",
    button: "from-orange-600 to-rose-700",
    buttonHover: "hover:from-orange-700 hover:to-rose-800",
  },
  royal: {
    label: "ملكي",
    bg: "bg-gradient-to-br from-slate-50 via-violet-50/40 to-purple-50/30 dark:from-slate-950 dark:via-slate-950 dark:to-violet-950/20",
    blob1: "bg-violet-400/20 dark:bg-violet-500/10",
    blob2: "bg-purple-400/20 dark:bg-purple-500/10",
    logo: "from-violet-600 to-purple-700",
    button: "from-violet-600 to-purple-700",
    buttonHover: "hover:from-violet-700 hover:to-purple-800",
  },
};

/* ──────────────────────────────────────────────────────────────────────── */
/*  Types                                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

type View = "loading" | "login" | "setup";

interface SetupResponse {
  id: string;
  username: string;
  displayName: string;
  role: string;
  active: boolean;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Page                                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

export default function LoginPage() {
  const router = useRouter();

  const [view, setView] = React.useState<View>("loading");

  // ── Login theme (persisted in localStorage) ──
  const [theme, setTheme] = React.useState<LoginTheme>("emerald");
  React.useEffect(() => {
    const saved = localStorage.getItem("login-theme") as LoginTheme | null;
    if (saved && THEMES[saved]) setTheme(saved);
  }, []);

  // ── Login form state ──
  const [loginUsername, setLoginUsername] = React.useState("");
  const [loginPassword, setLoginPassword] = React.useState("");
  const [loginError, setLoginError] = React.useState<string | null>(null);
  const [loginLoading, setLoginLoading] = React.useState(false);

  // ── Setup form state ──
  const [setupUsername, setSetupUsername] = React.useState("admin");
  const [setupPassword, setSetupPassword] = React.useState("");
  const [setupConfirm, setSetupConfirm] = React.useState("");
  const [setupDisplayName, setSetupDisplayName] = React.useState("مدير النظام");
  const [setupError, setSetupError] = React.useState<string | null>(null);
  const [setupLoading, setSetupLoading] = React.useState(false);

  const t = THEMES[theme];

  /* ── Initial setup check ── */
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/setup", { cache: "no-store" });
        if (!res.ok) throw new Error("setup check failed");
        const data = (await res.json()) as { needsSetup?: boolean };
        if (cancelled) return;
        setView(data.needsSetup ? "setup" : "login");
      } catch {
        if (cancelled) return;
        setView("login");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* ── Login submit ── */
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    if (!loginUsername.trim() || !loginPassword) {
      setLoginError("الرجاء إدخال اسم المستخدم وكلمة المرور");
      return;
    }
    setLoginLoading(true);
    try {
      const res = await signIn("credentials", {
        username: loginUsername.trim(),
        password: loginPassword,
        redirect: false,
      });
      if (!res || res.error) {
        setLoginError("اسم المستخدم أو كلمة المرور غير صحيحة");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setLoginError("حدث خطأ غير متوقع، حاول مرة أخرى");
    } finally {
      setLoginLoading(false);
    }
  }

  /* ── Setup submit ── */
  async function handleSetup(e: React.FormEvent) {
    e.preventDefault();
    setSetupError(null);
    if (!setupUsername.trim()) { setSetupError("اسم المستخدم مطلوب"); return; }
    if (!setupPassword) { setSetupError("كلمة المرور مطلوبة"); return; }
    if (setupPassword.length < 6) { setSetupError("يجب ألا تقل كلمة المرور عن 6 أحرف"); return; }
    if (setupPassword !== setupConfirm) { setSetupError("تأكيد كلمة المرور غير مطابق"); return; }
    setSetupLoading(true);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: setupUsername.trim(),
          password: setupPassword,
          displayName: setupDisplayName.trim() || "مدير النظام",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as SetupResponse | { error?: string };
      if (!res.ok) {
        const msg = (data as { error?: string }).error || "تعذّر إنشاء حساب المدير، حاول مرة أخرى";
        setSetupError(msg);
        return;
      }
      const si = await signIn("credentials", {
        username: setupUsername.trim(),
        password: setupPassword,
        redirect: false,
      });
      if (!si || si.error) {
        setView("login");
        setLoginUsername(setupUsername.trim());
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setSetupError("حدث خطأ غير متوقع، حاول مرة أخرى");
    } finally {
      setSetupLoading(false);
    }
  }

  /* ──────────────────────────────────────────────────────────────────── */
  /*  Render                                                                */
  /* ──────────────────────────────────────────────────────────────────── */

  return (
    <div
      dir="rtl"
      className={cn("relative flex min-h-screen items-center justify-center px-4 py-8 transition-colors duration-300", t.bg)}
    >
      {/* Decorative gradient blobs */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className={cn("absolute -right-32 -top-32 h-96 w-96 rounded-full blur-3xl", t.blob1)} />
        <div className={cn("absolute -bottom-40 -left-32 h-96 w-96 rounded-full blur-3xl", t.blob2)} />
      </div>

      {/* Theme selector */}
      <div className="absolute top-4 right-4 z-20 flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/70 px-3 py-1.5 backdrop-blur-md dark:border-slate-700/80 dark:bg-slate-900/70">
        <Palette className="size-3.5 text-slate-400" />
        {(Object.keys(THEMES) as LoginTheme[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => { setTheme(key); localStorage.setItem("login-theme", key); }}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[10px] font-semibold transition-colors",
              theme === key
                ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
                : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            )}
            title={THEMES[key].label}
          >
            {THEMES[key].label}
          </button>
        ))}
      </div>

      <div className="relative z-10 w-full max-w-md">
        {/* Logo / Header */}
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className={cn("flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-lg", t.logo)}>
            <ArrowLeftRight className="size-7" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-tight text-slate-800 dark:text-slate-100">
              تسجيل الدخول
            </h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              نظام التقارير المالية الموحدة
            </p>
          </div>
        </div>

        {view === "loading" && <LoadingCard />}
        {view === "login" && (
          <LoginCard
            username={loginUsername}
            password={loginPassword}
            onUsernameChange={setLoginUsername}
            onPasswordChange={setLoginPassword}
            onSubmit={handleLogin}
            loading={loginLoading}
            error={loginError}
            theme={t}
          />
        )}
        {view === "setup" && (
          <SetupCard
            username={setupUsername}
            password={setupPassword}
            confirm={setupConfirm}
            displayName={setupDisplayName}
            onUsernameChange={setSetupUsername}
            onPasswordChange={setSetupPassword}
            onConfirmChange={setSetupConfirm}
            onDisplayNameChange={setSetupDisplayName}
            onSubmit={handleSetup}
            loading={setupLoading}
            error={setupError}
          />
        )}

        <p className="mt-6 text-center text-[11px] text-slate-400 dark:text-slate-600">
          © {new Date().getFullYear()} — جميع الحقوق محفوظة
        </p>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Sub-components                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

function LoadingCard() {
  return (
    <Card className="border-slate-200/80 shadow-xl shadow-slate-900/5 dark:border-slate-800 dark:shadow-black/20">
      <CardContent className="flex items-center justify-center gap-3 py-12 text-slate-500 dark:text-slate-400">
        <Loader2 className="size-5 animate-spin text-emerald-600" />
        <span className="text-sm">جارٍ التحقق…</span>
      </CardContent>
    </Card>
  );
}

function LoginCard({
  username, password, onUsernameChange, onPasswordChange, onSubmit, loading, error, theme,
}: {
  username: string; password: string;
  onUsernameChange: (v: string) => void; onPasswordChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void; loading: boolean; error: string | null;
  theme: typeof THEMES[LoginTheme];
}) {
  return (
    <Card className="border-slate-200/80 shadow-xl shadow-slate-900/5 dark:border-slate-800 dark:shadow-black/20">
      <CardHeader>
        <CardTitle className="text-lg text-slate-800 dark:text-slate-100">مرحباً بك</CardTitle>
        <CardDescription className="text-slate-500 dark:text-slate-400">سجّل دخولك للوصول إلى نظام التقارير المالية الموحدة</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username" className="text-slate-700 dark:text-slate-300">اسم المستخدم</Label>
            <div className="relative">
              <User className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input id="username" value={username} onChange={(e) => onUsernameChange(e.target.value)} placeholder="أدخل اسم المستخدم" autoComplete="username" autoFocus disabled={loading} className="pr-9" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-slate-700 dark:text-slate-300">كلمة المرور</Label>
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input id="password" type="password" value={password} onChange={(e) => onPasswordChange(e.target.value)} placeholder="••••••••" autoComplete="current-password" disabled={loading} className="pr-9" />
            </div>
          </div>
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
              <span className="mt-0.5 text-base leading-none">⚠</span>
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
          <Button type="submit" disabled={loading} className={cn("w-full bg-gradient-to-l text-white shadow-md", theme.button, theme.buttonHover, "disabled:opacity-70")}>
            {loading ? (<><Loader2 className="size-4 animate-spin" />جارٍ تسجيل الدخول…</>) : "تسجيل الدخول"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SetupCard({
  username, password, confirm, displayName,
  onUsernameChange, onPasswordChange, onConfirmChange, onDisplayNameChange,
  onSubmit, loading, error,
}: {
  username: string; password: string; confirm: string; displayName: string;
  onUsernameChange: (v: string) => void; onPasswordChange: (v: string) => void;
  onConfirmChange: (v: string) => void; onDisplayNameChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void; loading: boolean; error: string | null;
}) {
  return (
    <Card className="border-amber-200/80 shadow-xl shadow-slate-900/5 dark:border-amber-900/40 dark:shadow-black/20">
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
            <ShieldCheck className="size-4" />
          </div>
          <CardTitle className="text-lg text-slate-800 dark:text-slate-100">إعداد النظام</CardTitle>
        </div>
        <CardDescription className="text-slate-500 dark:text-slate-400">لا يوجد مستخدمون بعد. أنشئ حساب المدير الأول للبدء.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="setup-displayName" className="text-slate-700 dark:text-slate-300">الاسم المعروض</Label>
            <Input id="setup-displayName" value={displayName} onChange={(e) => onDisplayNameChange(e.target.value)} placeholder="مدير النظام" disabled={loading} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-username" className="text-slate-700 dark:text-slate-300">اسم المستخدم</Label>
            <div className="relative">
              <User className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input id="setup-username" value={username} onChange={(e) => onUsernameChange(e.target.value)} placeholder="admin" autoComplete="username" disabled={loading} className="pr-9" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-password" className="text-slate-700 dark:text-slate-300">كلمة المرور</Label>
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input id="setup-password" type="password" value={password} onChange={(e) => onPasswordChange(e.target.value)} placeholder="••••••••" autoComplete="new-password" disabled={loading} className="pr-9" />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="setup-confirm" className="text-slate-700 dark:text-slate-300">تأكيد كلمة المرور</Label>
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input id="setup-confirm" type="password" value={confirm} onChange={(e) => onConfirmChange(e.target.value)} placeholder="••••••••" autoComplete="new-password" disabled={loading} className="pr-9" />
            </div>
          </div>
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
              <span className="mt-0.5 text-base leading-none">⚠</span>
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
          <Button type="submit" disabled={loading} className={cn("w-full bg-gradient-to-l from-amber-600 to-orange-700 text-white shadow-md shadow-amber-600/20 hover:from-amber-700 hover:to-orange-800 disabled:opacity-70")}>
            {loading ? (<><Loader2 className="size-4 animate-spin" />جارٍ الإنشاء…</>) : "إنشاء حساب المدير"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
