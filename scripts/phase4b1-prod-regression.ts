// Phase 4B.1 — انحدار الإنتاج بعد التغييرات (عبر HTTP فعلي على 3000).
// يثبت أن الحراس شفافون في NORMAL، وأن epoch يعمل، وأن محرك الاستعادة
// معطّل على الإنتاج (RESTORE_ENGINE_DISABLED)، وأن 4A ما زال يعمل.
// النظافة: مجموعة/تقرير اختباريان يُحذفان بطريقة شرعية عبر API.

const PROD_BASE = "http://127.0.0.1:3000";

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
    const csrfRes = await fetch(`${PROD_BASE}/api/auth/csrf`, { redirect: "manual" });
    await capture(csrfRes);
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const body = new URLSearchParams({ csrfToken, username, password, json: "true" });
    const res = await fetch(`${PROD_BASE}/api/auth/callback/credentials`, {
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
    const res = await fetch(`${PROD_BASE}/api/auth/session`, { headers: { Cookie: cookieHeader() }, cache: "no-store" });
    await capture(res);
    if (!res.ok) return null;
    const j = (await res.json()) as { user?: { id?: string; username?: string } };
    return j?.user ?? null;
  }
  async function api<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const res = await fetch(`${PROD_BASE}${path}`, {
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
  console.log("=== Phase 4B.1 — انحدار الإنتاج (3000) ===\n");

  const s = makeSession();

  // 0) بلا جلسة: الكتابة تُرد 401 (الحارس يمر ثم المصادقة ترفض)
  const anon = await fetch(`${PROD_BASE}/api/groups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  line("0) بلا جلسة — POST /api/groups ⇒ 401", anon.status === 401, String(anon.status));

  // 1) دخول المدير
  const loginOk = await s.login("admin", "admin123");
  line("1) دخول المدير (JWT يحمل epoch الآن)", loginOk);

  // 2) مجموعة + تقرير اختباريان
  const rnd = crypto.randomUUID().slice(0, 6);
  const grp = await s.api<{ id: string }>("/api/groups", { method: "POST", body: JSON.stringify({ name: `مجموعة انحدار 4B.1 ${rnd}` }) });
  line("2أ) كتابة طبيعية في NORMAL — إنشاء مجموعة", grp.status === 201, String(grp.status));
  const rep = await s.api<{ id: string; version: number }>("/api/reports", {
    method: "POST",
    body: JSON.stringify({ name: `تقرير انحدار 4B.1 ${rnd}`, label1: "ر1", label2: "ر2", groupId: grp.body.id, periodEnd: "2026-09-30" }),
  });
  line("2ب) إنشاء تقرير", rep.status === 201, String(rep.status));
  const upd = await s.api(`/api/reports/${rep.body.id}`, { method: "PUT", body: JSON.stringify({ name: `تقرير انحدار 4B.1 ${rnd} معدّل`, version: rep.body.version }) });
  line("2ج) تعديل التقرير", upd.status === 200, String(upd.status));

  // 3) قراءات
  const dash = await s.api<Record<string, unknown>>("/api/dashboard/summary");
  line("3أ) Dashboard read", dash.status === 200);
  const repRead = await s.api<{ name: string }>(`/api/reports/${rep.body.id}`);
  line("3ب) قراءة التقرير المعدّل", repRead.status === 200 && String(repRead.body.name).includes("معدّل"));

  // 4) نسخة احتياطية + Drill (4A ما زالت تعمل)
  const bk = await s.api<{ backupId: string; level: string }>("/api/backups", { method: "POST" });
  line("4أ) إنشاء نسخة (VALIDATED تلقائيًا)", bk.status === 201 && bk.body.level === "VALIDATED", `${bk.body?.backupId ?? ""} ${bk.body?.level ?? ""}`);
  if (bk.status === 201) {
    const drill = await s.api<{ level: string }>(`/api/backups/${bk.body.backupId}/drill`, { method: "POST" });
    line("4ب) Drill ⇒ RESTORE_VERIFIED", drill.status === 200 && drill.body.level === "RESTORE_VERIFIED");
  }

  // 5) محرك الاستعادة معطّل على الإنتاج — باب 4B.2 لم يُفتح
  const rest = await s.api<{ code?: string }>(`/api/backups/${bk.body.backupId || "bk-x"}/restore`, {
    method: "POST",
    body: JSON.stringify({ confirmationText: "RESTORE" }),
  });
  line(
    "5) POST restore ⇒ 409 RESTORE_ENGINE_DISABLED (4B.2 غير مفعّلة)",
    rest.status === 409 && rest.body.code === "RESTORE_ENGINE_DISABLED",
    `${rest.status} ${String(rest.body?.code ?? "")}`
  );

  // 6) نظافة شرعية: REOPEN غير مطلوب (التقرير DRAFT) — DELETE مباشر
  const delRep = await s.api(`/api/reports/${rep.body.id}`, { method: "DELETE" });
  line("6أ) حذف التقرير الاختباري", delRep.status === 200 || delRep.status === 204, String(delRep.status));
  const delGrp = await s.api(`/api/groups/${grp.body.id}`, { method: "DELETE" });
  line("6ب) حذف المجموعة الاختبارية", delGrp.status === 200 || delGrp.status === 204, String(delGrp.status));

  // 7) الحالة النهائية + integrity
  const { execSync } = await import("node:child_process");
  const integ = execSync(
    `sqlite3 db/custom.db "PRAGMA integrity_check;" 2>/dev/null || bun -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient({datasources:{db:{url:'file:'+process.cwd()+'/db/custom.db'}},log:[]});p.\\$queryRawUnsafe('PRAGMA integrity_check').then(r=>{console.log(r[0].integrity_check);return p.\\$disconnect();})"`,
    { cwd: process.cwd(), encoding: "utf8", shell: "/bin/bash" }
  ).trim();
  line("7) integrity_check على قاعدة الإنتاج", integ === "ok", integ);

  console.log("\n=== انتهى انحدار الإنتاج ===");
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
