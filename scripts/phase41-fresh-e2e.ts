// Phase 4A.1 — Fresh Database Reproducibility (اختبار إلزامي — البند 6).
//
// Empty DB ← prisma migrate deploy ← ثم على خادم حقيقي يعمل على هذه القاعدة:
//   setup(مدير) → login → إنشاء مراجع/معتمد → مجموعة → تقرير → Workflow كامل
//   حتى APPROVED → Dashboard read → Backup → Validation → Restore Drill.
// لا يكفي CRUD بسيط — إثبات أن القاعدة المبنية من migrations تدير التطبيق كاملًا.
//
// الخادم المؤقت يُشغَّل على 3100 بمتغيرات معزولة: DATABASE_URL للقاعدة الجديدة
// وVAR_DIR خاص (نسخ/سجلات الاسترجاع منفصلة عن الإنتاج حصرًا).

const BASE = "http://127.0.0.1:3100";
const ROOT = "/home/z/my-project";
const FRESH_DB = `${ROOT}/var/tmp-41/e2e-fresh.db`;

function line(title: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${title}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function makeSession() {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  async function capture(res: Response): Promise<void> {
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  async function login(username: string, password: string): Promise<boolean> {
    const csrfRes = await fetch(`${BASE}/api/auth/csrf`, { redirect: "manual" });
    await capture(csrfRes);
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const body = new URLSearchParams({ csrfToken, username, password, json: "true" });
    const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader() },
      body: body.toString(),
      redirect: "manual",
    });
    await capture(res);
    const who = await whoami();
    return !!who?.id;
  }
  async function whoami(): Promise<{ id?: string; username?: string } | null> {
    const res = await fetch(`${BASE}/api/auth/session`, { headers: { Cookie: cookieHeader() }, cache: "no-store" });
    await capture(res);
    if (!res.ok) return null;
    const j = (await res.json()) as { user?: { id?: string; username?: string } };
    return j?.user ?? null;
  }
  async function api<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookieHeader(), ...(init?.headers ?? {}) },
    });
    await capture(res);
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
  }
  return { login, whoami, api };
}

async function main() {
  console.log("=== Phase 4A.1 — Fresh DB (من migrations) E2E كامل ===\n");

  // 0) القاعدة الجديدة فعلًا مبنية من migrations ولا تحوي مستخدمين
  const setupCheck = await fetch(`${BASE}/api/setup`, { cache: "no-store" });
  const setupState = (await setupCheck.json()) as { needsSetup: boolean };
  line("0) خادم على قاعدة fresh — شاشة الإعداد الأولي مفعّلة", setupCheck.status === 200 && setupState.needsSetup === true, `needsSetup=${setupState.needsSetup}`);

  const rnd = crypto.randomUUID().slice(0, 8);
  const adminUser = `e2e_admin_${rnd}`;
  const passAdmin = `E2-${crypto.randomUUID()}-Aa1!`;
  const revUser = `e2e_rev_${rnd}`;
  const passRev = `E2-${crypto.randomUUID()}-Bb2!`;
  const appUser = `e2e_app_${rnd}`;
  const passApp = `E2-${crypto.randomUUID()}-Cc3!`;

  const sAdmin = makeSession();
  const sRev = makeSession();
  const sApp = makeSession();

  // 1) الإعداد الأولي (إنشاء المدير من الصفر — قاعدة فارغة حرفيًا)
  const setupPost = await sAdmin.api<{ id: string; username: string }>("/api/setup", {
    method: "POST",
    body: JSON.stringify({ username: adminUser, password: passAdmin, displayName: "مدير E2E 4A.1" }),
  });
  line("1) POST /api/setup — إنشاء المدير الأول على القاعدة الجديدة", setupPost.status === 201, `user=${setupPost.body?.username}`);

  const loginOk = await sAdmin.login(adminUser, passAdmin);
  line("2) تسجيل دخول المدير", loginOk, `user=${(await sAdmin.whoami())?.username}`);

  // 3) مراجع ومعتمد
  const rev = await sAdmin.api<{ id: string }>("/api/users", {
    method: "POST",
    body: JSON.stringify({ username: revUser, password: passRev, displayName: "مراجع E2E", role: "user" }),
  });
  const app = await sAdmin.api<{ id: string }>("/api/users", {
    method: "POST",
    body: JSON.stringify({ username: appUser, password: passApp, displayName: "معتمد E2E", role: "user" }),
  });
  line("3) إنشاء مراجع ومعتمد", rev.status === 201 && app.status === 201);

  // 4) مجموعة + تقرير
  const grp = await sAdmin.api<{ id: string }>("/api/groups", { method: "POST", body: JSON.stringify({ name: `مجموعة E2E ${rnd}` }) });
  line("4أ) مجموعة", grp.status === 201);
  const rep = await sAdmin.api<{ id: string; version: number; status: string }>("/api/reports", {
    method: "POST",
    body: JSON.stringify({ name: `تقرير E2E ${rnd}`, label1: "هـ1", label2: "هـ2", groupId: grp.body.id, periodEnd: "2026-09-30" }),
  });
  line("4ب) تقرير DRAFT", rep.status === 201 && rep.body.status === "DRAFT", `id=${rep.body.id}`);

  // 5) إسناد + Workflow كامل
  const asg = await sAdmin.api(`/api/reports/${rep.body.id}/assignments`, {
    method: "PUT",
    body: JSON.stringify({ reviewedById: rev.body.id, approvedById: app.body.id, version: rep.body.version }),
  });
  line("5أ) إسناد", asg.status === 200);
  const gv = async (sess: ReturnType<typeof makeSession>): Promise<number> => {
    const r = await sess.api<{ version: number }>(`/api/reports/${rep.body.id}`);
    return r.body.version;
  };
  const wv = async (sess: ReturnType<typeof makeSession>, action: string, extra: Record<string, unknown> = {}) => {
    const v = await gv(sess);
    return sess.api<{ status?: string; error?: string }>(`/api/reports/${rep.body.id}/workflow`, {
      method: "POST",
      body: JSON.stringify({ action, version: v, ...extra }),
    });
  };
  const sub = await wv(sAdmin, "SUBMIT");
  line("5ب) SUBMIT", sub.status === 200 && sub.body.status === "SUBMITTED", String(sub.body?.status ?? sub.body?.error));
  await sRev.login(revUser, passRev);
  const sr = await wv(sRev, "START_REVIEW");
  line("5ج) START_REVIEW", sr.status === 200 && sr.body.status === "UNDER_REVIEW");
  const cr = await wv(sRev, "COMPLETE_REVIEW");
  line("5د) COMPLETE_REVIEW", cr.status === 200 && cr.body.status === "PENDING_APPROVAL");
  await sApp.login(appUser, passApp);
  const ap = await wv(sApp, "APPROVE");
  line("5هـ) APPROVE — الدورة كاملة على قاعدة migrations حتى APPROVED", ap.status === 200 && ap.body.status === "APPROVED", String(ap.body?.status ?? ap.body?.error));

  // 6) Dashboard read
  const dash = await sAdmin.api<Record<string, unknown>>("/api/dashboard/summary");
  line("6) Dashboard read", dash.status === 200 && Object.keys(dash.body).length > 0, JSON.stringify(dash.body).slice(0, 130));

  // 7) Backup → Validation → Drill (كلها في VAR_DIR معزول)
  const bk = await sAdmin.api<{ backupId: string; level: string; manifest?: { formatVersion: number; canonicalSchemaFingerprint?: string } }>("/api/backups", { method: "POST" });
  line(
    "7أ) Backup عبر HTTP (v3 + VALIDATED)",
    bk.status === 201 && bk.body.level === "VALIDATED" && bk.body.manifest?.formatVersion === 3,
    `${bk.body?.backupId} · canonical=${bk.body?.manifest?.canonicalSchemaFingerprint?.slice(0, 21)}…`
  );
  const drill = await sAdmin.api<{ level: string; manifestClass?: string; prismaReadTests?: unknown[] }>(`/api/backups/${bk.body.backupId}/drill`, { method: "POST" });
  line(
    "7ب) Restore Drill ⇒ RESTORE_VERIFIED على قاعدة fresh",
    drill.status === 200 && drill.body.level === "RESTORE_VERIFIED",
    `manifestClass=${drill.body?.manifestClass} · prismaReads=${drill.body?.prismaReadTests?.length}`
  );

  // 8) الحالة النهائية للتقرير APPROVED باقية كدليل
  const finalRep = await sAdmin.api<{ status: string; cycle: number }>(`/api/reports/${rep.body.id}`);
  line("8) التقرير باقٍ APPROVED على القاعدة الجديدة (دورة 1)", finalRep.status === 200 && finalRep.body.status === "APPROVED" && finalRep.body.cycle === 1, `status=${finalRep.body?.status} cycle=${finalRep.body?.cycle}`);

  console.log("\n=== انتهى Fresh-DB E2E — القاعدة المبنية من migrations تدير التطبيق كاملًا ===");
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
