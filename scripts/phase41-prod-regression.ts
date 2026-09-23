// Phase 4A.1 — Regression مختصر على قاعدة التشغيل الحية (بعد migrate resolve).
//
// قرار المستخدم (4A.1 البند 7): بعد resolve — لا تغيير أي بيانات أعمال قائمة،
// وتشغيل regression كامل عبر HTTP الحقيقي ضد الخادم على 3000:
//   login → إنشاء/قراءة/تعديل/حذف مسودة اختبار → Workflow كامل حتى APPROVED →
//   Dashboard read → Backup + Validation + Drill RESTORE_VERIFIED.
// ثم تنظيف كل بيانات الاختبار عبر APIs شرعية (REOPEN→RESUME_EDIT→DELETE للمسودة)
// مع بقاء أدلة Audit وWorkflowHistory كما صمم النظام (append-only).
//
// مستخدمو الاختبار مؤقتون بأسماء موسومة __4a1_* ويُحذفون في النهاية.

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { ADMIN_PERMISSIONS, stringifyPermissions, DEFAULT_USER_PERMISSIONS } from "@/lib/permissions";

const BASE = "http://127.0.0.1:3000";
const PROD = "/home/z/my-project/db/custom.db";

function line(title: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${title}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

/* ── HTTP helper: جلسة NextAuth يدوية (csrf + credentials + cookie jar) ── */
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
    const session = await whoami();
    return !!session?.id;
  }
  async function whoami(): Promise<{ id?: string; username?: string; role?: string } | null> {
    const res = await fetch(`${BASE}/api/auth/session`, { headers: { Cookie: cookieHeader() }, cache: "no-store" });
    await capture(res);
    if (!res.ok) return null;
    const j = (await res.json()) as { user?: { id?: string; username?: string; role?: string } };
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
  return { login, whoami, api, cookieHeader };
}

async function main() {
  console.log("=== Phase 4A.1 — Regression على قاعدة التشغيل (HTTP فعلي) ===\n");

  const admin = new PrismaClient({ datasources: { db: { url: `file:${PROD}` } }, log: [] });
  const baseline = {
    users: await admin.user.count(),
    groups: await admin.group.count(),
    reports: await admin.report.count(),
    workflowHistory: await admin.workflowHistory.count(),
    auditLog: await admin.auditLog.count(),
  };
  console.log(`حالة الأساس: ${JSON.stringify(baseline)}\n`);

  const rnd = crypto.randomUUID().slice(0, 8);
  const adminUsername = `__4a1_regress_admin_${rnd}`;
  const reviewerUsername = `__4a1_regress_rev_${rnd}`;
  const approverUsername = `__4a1_regress_app_${rnd}`;
  const passAdmin = `Rg-${crypto.randomUUID()}-Aa1!`;
  const passReviewer = `Rg-${crypto.randomUUID()}-Bb2!`;
  const passApprover = `Rg-${crypto.randomUUID()}-Cc3!`;

  // ── 0) مستخدم اختبار إداري (مباشر عبر Prisma — لا جلسة قبل وجوده) ──────
  await admin.user.create({
    data: {
      username: adminUsername,
      passwordHash: await bcrypt.hash(passAdmin, 10),
      displayName: "مؤقت regression 4A.1",
      role: "admin",
      permissions: stringifyPermissions(ADMIN_PERMISSIONS),
      active: true,
    },
  });

  const sAdmin = makeSession();
  const sReviewer = makeSession();
  const sApprover = makeSession();

  // ── 1) Login ────────────────────────────────────────────────────────────
  const loginOk = await sAdmin.login(adminUsername, passAdmin);
  line("1) تسجيل دخول HTTP فعلي (NextAuth credentials)", loginOk, `user=${(await sAdmin.whoami())?.username}`);

  // ── 2) إنشاء مراجع ومعتمد (عبر API) ────────────────────────────────────
  const rev = await sAdmin.api<{ id: string }>("/api/users", {
    method: "POST",
    body: JSON.stringify({
      username: reviewerUsername,
      password: passReviewer,
      displayName: "مراجع مؤقت 4A.1",
      role: "user",
      permissions: { ...DEFAULT_USER_PERMISSIONS },
    }),
  });
  const app = await sAdmin.api<{ id: string }>("/api/users", {
    method: "POST",
    body: JSON.stringify({
      username: approverUsername,
      password: passApprover,
      displayName: "معتمد مؤقت 4A.1",
      role: "user",
      permissions: { ...DEFAULT_USER_PERMISSIONS },
    }),
  });
  line("2) إنشاء مراجع ومعتمد عبر /api/users", rev.status === 201 && app.status === 201, `reviewer=${rev.status} approver=${app.status}`);

  // ── 3) مجموعة ───────────────────────────────────────────────────────────
  const grp = await sAdmin.api<{ id: string; name: string }>("/api/groups", {
    method: "POST",
    body: JSON.stringify({ name: `مجموعة regression 4A.1 ${rnd}` }),
  });
  line("3) إنشاء مجموعة عبر /api/groups", grp.status === 201, `id=${grp.body?.id ?? ""}`);

  // ── 4) CRUD كامل على مسودة اختبار (T1) ─────────────────────────────────
  const t1 = await sAdmin.api<{ id: string; name: string; version: number }>("/api/reports", {
    method: "POST",
    body: JSON.stringify({ name: `مسودة CRUD 4A.1 ${rnd}`, label1: "قبل", label2: "قبل", groupId: grp.body.id, periodEnd: "2026-09-30" }),
  });
  line("4أ) create مسودة T1", t1.status === 201, `id=${t1.body?.id ?? ""} v=${t1.body?.version}`);
  const t1read = await sAdmin.api<{ id: string; name: string }>(`/api/reports/${t1.body.id}`);
  line("4ب) read T1", t1read.status === 200 && t1read.body.id === t1.body.id);
  const t1upd = await sAdmin.api<{ name: string; version: number }>(`/api/reports/${t1.body.id}`, {
    method: "PUT",
    body: JSON.stringify({ name: `مسودة CRUD 4A.1 ${rnd} معدلة`, label1: "بعد", version: t1read.body.version, periodEnd: "2026-09-30" }),
  });
  line("4ج) update T1 (قفل تفاؤلي)", t1upd.status === 200 && t1upd.body.version === t1read.body.version + 1, `v=${t1upd.body?.version}`);
  const t1del = await sAdmin.api(`/api/reports/${t1.body.id}`, { method: "DELETE" });
  line("4د) delete T1 (مسودة)", t1del.status === 200, `status=${t1del.status}`);

  // ── 5) Workflow كامل حتى APPROVED (T2) ─────────────────────────────────
  const t2 = await sAdmin.api<{ id: string; version: number; status: string }>("/api/reports", {
    method: "POST",
    body: JSON.stringify({ name: `تقرير workflow 4A.1 ${rnd}`, label1: "ق1", label2: "ق2", groupId: grp.body.id, periodEnd: "2026-09-30" }),
  });
  line("5أ) create تقرير T2 (DRAFT + prepared=المنشئ)", t2.status === 201 && t2.body.status === "DRAFT", `id=${t2.body.id} v=${t2.body.version}`);

  const asg = await sAdmin.api(`/api/reports/${t2.body.id}/assignments`, {
    method: "PUT",
    body: JSON.stringify({ reviewedById: rev.body.id, approvedById: app.body.id, version: t2.body.version }),
  });
  line("5ب) إسناد مراجع+معتمد (PUT assignments)", asg.status === 200, `status=${asg.status}`);

  // جلب النسخة الحالية قبل كل انتقال (موثوقية السلسلة)
  const curVersion = async (): Promise<number> => {
    const r = await sAdmin.api<{ version: number }>(`/api/reports/${t2.body.id}`);
    return r.body.version;
  };
  const wv = async (
    sess: ReturnType<typeof makeSession>,
    action: string,
    extra: Record<string, unknown> = {}
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const v = await curVersion();
    return sess.api(`/api/reports/${t2.body.id}/workflow`, {
      method: "POST",
      body: JSON.stringify({ action, version: v, ...extra }),
    });
  };

  const sub = await wv(sAdmin, "SUBMIT");
  line("5ج) SUBMIT (المعد)", sub.status === 200 && sub.body.status === "SUBMITTED", `status=${String(sub.body?.status)}`);

  const revLogin = await sReviewer.login(reviewerUsername, passReviewer);
  line("5د) دخول المراجع", revLogin, `user=${(await sReviewer.whoami())?.username}`);
  const sr = await wv(sReviewer, "START_REVIEW");
  line("5هـ) START_REVIEW", sr.status === 200 && sr.body.status === "UNDER_REVIEW", String(sr.body?.status));
  const cr = await wv(sReviewer, "COMPLETE_REVIEW");
  line("5و) COMPLETE_REVIEW (توقيع المراجع)", cr.status === 200 && cr.body.status === "PENDING_APPROVAL", String(cr.body?.status));

  const appLogin = await sApprover.login(approverUsername, passApprover);
  line("5ز) دخول المعتمد", appLogin, `user=${(await sApprover.whoami())?.username}`);
  const ap = await wv(sApprover, "APPROVE");
  line("5ح) APPROVE — دورة كاملة DRAFT→SUBMITTED→UNDER_REVIEW→PENDING_APPROVAL→APPROVED", ap.status === 200 && ap.body.status === "APPROVED", String(ap.body?.status));

  // ── 6) Dashboard read ──────────────────────────────────────────────────
  const dash = await sAdmin.api<{ totalReports?: number } | Record<string, unknown>>("/api/dashboard/summary");
  const dashOk = dash.status === 200 && Object.keys(dash.body).length > 0;
  line("6) Dashboard summary read (200 + بيانات)", dashOk, JSON.stringify(dash.body).slice(0, 140));
  const recs = await sAdmin.api<{ items?: unknown[]; total?: number }>(`/api/dashboard/reconciliations?limit=10`);
  line("6ب) Dashboard reconciliations read", recs.status === 200, `status=${recs.status}`);

  // ── 7) Backup + Validation + Drill ─────────────────────────────────────
  const bk = await sAdmin.api<{ backupId: string; level: string; manifest?: { formatVersion: number; canonicalSchemaFingerprint?: string } }>("/api/backups", { method: "POST" });
  line(
    "7أ) إنشاء نسخة عبر HTTP (v3 + VALIDATED تلقائي)",
    bk.status === 201 && bk.body.level === "VALIDATED" && bk.body.manifest?.formatVersion === 3,
    `${bk.body?.backupId} · canonical=${bk.body?.manifest?.canonicalSchemaFingerprint?.slice(0, 21)}…`
  );
  const drill = await sAdmin.api<{ level: string; manifestClass?: string }>(`/api/backups/${bk.body.backupId}/drill`, { method: "POST" });
  line(
    "7ب) Restore Drill عبر HTTP ⇒ RESTORE_VERIFIED",
    drill.status === 200 && drill.body.level === "RESTORE_VERIFIED",
    `manifestClass=${drill.body?.manifestClass}`
  );

  // ── 8) تنظيف بيانات الاختبار عبر APIs شرعية (الأدلة تبقى) ──────────────
  const reopen = await wv(sAdmin, "REOPEN", { reason: "تنظيف بيانات اختبار regression 4A.1 — الأدلة في السجل" });
  line("8أ) REOPEN التقرير المعتمد (بسبب إلزامي)", reopen.status === 200 && reopen.body.status === "REOPENED", String(reopen.body?.status));
  const resume = await wv(sAdmin, "RESUME_EDIT");
  line("8ب) RESUME_EDIT → DRAFT", resume.status === 200 && resume.body.status === "DRAFT", String(resume.body?.status));
  const delT2 = await sAdmin.api(`/api/reports/${t2.body.id}`, { method: "DELETE" });
  line("8ج) DELETE T2 (مسودة بعد الدورة)", delT2.status === 200, `status=${delT2.status}`);
  const delGrp = await sAdmin.api(`/api/groups/${grp.body.id}`, { method: "DELETE" });
  line("8د) DELETE المجموعة", delGrp.status === 200 || delGrp.status === 204, `status=${delGrp.status}`);
  const delRev = await sAdmin.api(`/api/users/${rev.body.id}`, { method: "DELETE" });
  const delApp = await sAdmin.api(`/api/users/${app.body.id}`, { method: "DELETE" });
  line("8هـ) DELETE المراجع والمعتمد", delRev.status === 200 && delApp.status === 200, `rev=${delRev.status} app=${delApp.status}`);
  // تنظيف شامل لكل مستخدمي اختبار 4A.1 (يشمل بقايا المحاولات الفاشلة سابقًا)
  const leftover = await admin.user.findMany({ where: { username: { startsWith: "__4a1_" } }, select: { username: true } });
  for (const u of leftover) {
    await admin.user.delete({ where: { username: u.username } });
  }
  line(
    "8و) حذف كل مستخدمي اختبار 4A.1 (المؤقت + بقايا المحاولات الفاشلة)",
    (await admin.user.count({ where: { username: { startsWith: "__4a1_" } } })) === 0,
    `حُذف ${leftover.length} مستخدمًا مؤقتًا`
  );

  // ── 9) الحالة النهائية: بيانات الأعمال كما كانت + أدلة باقية ────────────
  const final = {
    users: await admin.user.count(),
    groups: await admin.group.count(),
    reports: await admin.report.count(),
    workflowHistory: await admin.workflowHistory.count(),
    auditLog: await admin.auditLog.count(),
  };
  line(
    "9أ) بيانات الأعمال عادت للحالة الصافية (مستخدم حقيقي واحد، صفر مجموعات/تقارير)",
    final.users === 1 && final.groups === 0 && final.reports === 0,
    JSON.stringify(final)
  );
  line(
    "9ب) أدلة append-only باقية (WorkflowHistory وAuditLog زادت — مقصود)",
    final.workflowHistory > baseline.workflowHistory && final.auditLog > baseline.auditLog,
    `workflowHistory+${final.workflowHistory - baseline.workflowHistory} · auditLog+${final.auditLog - baseline.auditLog}`
  );
  const integ = (await admin.$queryRawUnsafe<{ integrity_check: string }[]>(`PRAGMA integrity_check`))[0]?.integrity_check;
  line("9ج) integrity_check على قاعدة التشغيل", integ === "ok", String(integ));

  await admin.$disconnect();
  console.log("\n=== انتهى Regression — قاعدة التشغيل سليمة والأدلة الرقابية باقية ===");
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
