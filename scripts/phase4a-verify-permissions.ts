// Phase 4A — اختبار مصفوفة الصلاحيات عبر HTTP فعليًا ضد الخادم الجاري.
//
// السيناريوهات:
//  - مستخدم بلا manageBackups: لا قائمة/إنشاء/تنزيل/رفع/Drill/قراءة سجل (403)
//  - مستخدم settings:true فقط: لا شيء أيضًا (D-5 — settings لا تمنح شيئًا)
//  - مستخدم غير مدير مع manageBackups: القائمة والسجل تعمل، غير الموجود = 404
//  - مدير بالدور: وصول ضمني كامل
//  - غير مصدق: 401
//
// كل مستخدمي الاختبار موسومون __4a_ ويُحذفون في النهاية.

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const BASE = "http://localhost:3000";
const MARKER = "__4a_";

let failures = 0;
function line(title: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${title}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/* ── كوكي جار بسيط ── */
function jar(): { get: () => string; absorb: (res: Response) => void } {
  const store = new Map<string, string>();
  return {
    absorb(res: Response) {
      const raw = res.headers.getSetCookie?.() ?? [];
      for (const c of raw) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    get() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

async function login(username: string, password: string): Promise<string> {
  const j = jar();
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`, { cache: "no-store" });
  j.absorb(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: j.get(),
    },
    body: new URLSearchParams({
      username,
      password,
      csrfToken,
      callbackUrl: `${BASE}/admin`,
      json: "true",
    }),
    redirect: "manual",
  });
  j.absorb(res);
  const cookie = j.get();
  if (!cookie.includes("next-auth.session-token") && !cookie.includes("authjs.session-token")) {
    throw new Error(`فشل دخول ${username} — لا توكن جلسة (HTTP ${res.status})`);
  }
  return cookie;
}

async function http(cookie: string | null, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
}

async function main() {
  console.log("=== مصفوفة صلاحيات النسخ الاحتياطي (4A — HTTP فعلي) ===\n");

  const db = new PrismaClient({ log: [] });

  // تنظيف بقايا سابقة + إنشاء مستخدمي الاختبار
  await db.user.deleteMany({ where: { username: { startsWith: MARKER } } });
  const passHash = await bcrypt.hash("x4A-test-pass", 8);
  const mk = async (username: string, role: string, perms: Record<string, unknown>) =>
    db.user.create({
      data: {
        username,
        passwordHash: passHash,
        displayName: username,
        role,
        permissions: JSON.stringify(perms),
        active: true,
      },
    });
  await mk(`${MARKER}noperm`, "user", {});
  await mk(`${MARKER}settings`, "user", { settings: true });
  await mk(`${MARKER}holder`, "user", { manageBackups: true });
  await mk(`${MARKER}admin`, "admin", {});
  line("إنشاء مستخدمي الاختبار الأربعة", true, "noperm / settings / holder / admin");

  const sessions: Record<string, string> = {};
  for (const u of ["noperm", "settings", "holder", "admin"]) {
    sessions[u] = await login(`${MARKER}${u}`, "x4A-test-pass");
  }
  line("دخول HTTP ناجح للأربعة (credentials flow)", true);

  const PROTECTED_GETS: Array<[string, string]> = [
    ["GET القائمة", "/api/backups"],
    ["GET تفاصيل", "/api/backups/bk-nonexistent"],
    ["GET تنزيل", "/api/backups/bk-nonexistent/download"],
    ["GET سجل الاسترجاع", "/api/backups/recovery-log"],
  ];
  const PROTECTED_POSTS: Array<[string, string, unknown]> = [
    ["POST إنشاء", "/api/backups", {}],
    ["POST تحقق", "/api/backups/bk-nonexistent/validate", {}],
    ["POST Drill", "/api/backups/bk-nonexistent/drill", {}],
    ["POST رفع", "/api/backups/upload", { name: "x.zip", dataBase64: "aGVsbG8=" }],
  ];

  // 1) بلا manageBackups: كل شيء 403
  {
    const c = sessions["noperm"];
    let okAll = true;
    const codes: string[] = [];
    for (const [label, path] of PROTECTED_GETS) {
      const res = await http(c, "GET", path);
      codes.push(`${label}=${res.status}`);
      if (res.status !== 403) okAll = false;
    }
    for (const [label, path, body] of PROTECTED_POSTS) {
      const res = await http(c, "POST", path, body);
      codes.push(`${label}=${res.status}`);
      if (res.status !== 403) okAll = false;
    }
    line("مستخدم بلا manageBackups: رفض 403 على كل المسارات الثمانية", okAll, codes.join(" · "));
  }

  // 2) settings فقط: لا تمنح شيئًا (D-5)
  {
    const c = sessions["settings"];
    let okAll = true;
    const codes: string[] = [];
    for (const [label, path] of PROTECTED_GETS) {
      const res = await http(c, "GET", path);
      codes.push(`${label}=${res.status}`);
      if (res.status !== 403) okAll = false;
    }
    const resCreate = await http(c, "POST", "/api/backups", {});
    codes.push(`POST إنشاء=${resCreate.status}`);
    if (resCreate.status !== 403) okAll = false;
    line("مستخدم settings فقط: رفض 403 (settings لا تمنح أي شيء — D-5)", okAll, codes.join(" · "));
  }

  // 3) حامل manageBackups (غير مدير): وصول فعلي — 200 للقائمة والسجل، 404 لغير الموجود
  {
    const c = sessions["holder"];
    const list = await http(c, "GET", "/api/backups");
    const listBody = list.status === 200 ? await list.json() : null;
    const listOk = list.status === 200 && Array.isArray(listBody?.local) && Array.isArray(listBody?.uploads);
    line("حامل manageBackups: GET القائمة = 200", listOk, `local=${listBody?.local?.length ?? "?"} uploads=${listBody?.uploads?.length ?? "?"}`);
    const rec = await http(c, "GET", "/api/backups/recovery-log");
    const recOk = rec.status === 200 && (await rec.json()).appendOnly === true;
    line("حامل manageBackups: GET سجل الاسترجاع = 200 (append-only)", recOk);
    const nf = await http(c, "GET", "/api/backups/bk-nonexistent");
    line("حامل manageBackups: معرف غير موجود = 404 (بلغ المسار بعد التصريح)", nf.status === 404, `status=${nf.status}`);
  }

  // 4) المدير بالدور: وصول ضمني
  {
    const c = sessions["admin"];
    const list = await http(c, "GET", "/api/backups");
    line("مدير بالدور: GET القائمة = 200 (ضمني بالدور)", list.status === 200);
  }

  // 5) غير مصدق: 401
  {
    const res = await http(null, "GET", "/api/backups");
    line("غير مصدق: 401", res.status === 401, `status=${res.status}`);
  }

  // 6) تنظيف مستخدمي الاختبار
  const del = await db.user.deleteMany({ where: { username: { startsWith: MARKER } } });
  line("تنظيف مستخدمي الاختبار", del.count === 4, `حُذف ${del.count}`);

  await db.$disconnect();
  console.log(failures === 0 ? "\n=== مصفوفة الصلاحيات: نجاح كامل ===" : `\n=== فشل ${failures} فحص ===`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
