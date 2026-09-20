/**
 * Phase 4B.3 — Permission Matrix عبر HTTP فعلي ضد الخادم الحي (3000).
 *
 * الإثبات المطلوب (قرار المستخدم 4B.3):
 *   • غير مصدق → 401 على كل شيء.
 *   • مستخدم عادي → 403.
 *   • manageBackups فقط → إدارة النسخ/Validate/Drill/Download/سجل الاسترجاع مسموحة،
 *     وRestore (preview/execute) ⇒ 403.
 *   • restoreDatabase فقط → يصل للحد الأدنى من Restore workflow حصرًا
 *     (preview 200 + تنفيذ يتجاوز التفويض)، ولا يمنحه أي إدارة نسخ عامة (403).
 *   • Admin بدون restoreDatabase → إدارة حسب صلاحياته (manageBackups بالدور)
 *     لكن Restore ⇒ 403 — وليس 409 RESTORE_ENGINE_DISABLED — أي أن حالة المحرك
 *     لا تُكشف لغير المخوّل قبل رفض التفويض.
 *   • manageBackups + restoreDatabase → كل ما سبق مسموح.
 *   • المدير الأصلي (لا يملك المفتاح مخزنًا صراحة) → 403 (least privilege).
 *
 * أمان التنفيذ: لا DB swap إطلاقًا — المحرك معطّل (RESTORE_ENGINE_ENABLED غائب)،
 * ومسارات restore للمخولين تُجرّب بمعرف نسخة غير موجود (يرفضه المحرك بعد التفويض
 * وقبل أي لمس)، والفحص داخل executeRestore للمحرك يقع قبل أي تغيير حالة.
 *
 * التنظيف: مستخدمو الاختبار يُحذفون عبر API. نسخة الاختبار (إنشاؤها mb) تبقى كدليل.
 */
export {}; // وحدة معزولة (منع تعارض النطاق العام مع باقي السكربتات في tsc)

const PROD_BASE = "http://127.0.0.1:3000";
const PROBE_BACKUP_ID = "bk-nonexistent-4b3probe"; // غير موجود عمدًا — آمن حتى لو مُخوّل

let failures = 0;
function check(id: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${id}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function makeSession() {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  async function capture(res: Response): Promise<void> {
    const setCookies =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
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
  async function whoami(): Promise<{ id?: string; username?: string; role?: string } | null> {
    const res = await fetch(`${PROD_BASE}/api/auth/session`, {
      headers: { Cookie: cookieHeader() },
      cache: "no-store",
    });
    await capture(res);
    if (!res.ok) return null;
    const j = (await res.json()) as { user?: { id?: string; username?: string; role?: string } };
    return j?.user ?? null;
  }
  async function api<T = unknown>(
    path: string,
    init?: RequestInit
  ): Promise<{ status: number; body: T; bytes: number }> {
    const res = await fetch(`${PROD_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookieHeader(), ...(init?.headers ?? {}) },
    });
    await capture(res);
    const buf = await res.arrayBuffer();
    let body = {} as T;
    try {
      body = JSON.parse(new TextDecoder().decode(buf)) as T;
    } catch {
      body = {} as T; // download binary
    }
    return { status: res.status, body, bytes: buf.byteLength };
  }
  return { login, whoami, api };
}

interface ApiRes {
  status: number;
  body: { error?: string; code?: string; local?: unknown[]; users?: unknown[] };
}

async function main() {
  console.log("=== Phase 4B.3 — Permission Matrix (HTTP حقيقي، بلا أي DB swap) ===\n");

  const admin = makeSession();
  if (!(await admin.login("admin", "admin123"))) {
    console.log("❌ فشل دخول المدير — لا يمكن تجهيز مستخدمي الاختبار");
    process.exit(1);
  }
  check("A0) دخول المدير الأصلي", true);

  // ── 0) نسخة الفحص: إن أعادة تعيين البيئة أفرغت var/backups (اكتشاف 4B.3) —
  // يعاد بناء نقطة الاستعادة شرعيًا عبر API حصرًا (نسخة إنتاج حقيقية كدليل) ──
  let list = (await admin.api("/api/backups")) as unknown as ApiRes;
  let localList = (list.body.local ?? []) as { backupId: string; level: string }[];
  let lastCreateAt = 0;
  if (localList.length === 0) {
    console.log("ℹ️  var/backups فارغ (ضحية إعادة تعيين البيئة) — إنشاء نسخة مرجعية عبر API");
    const cr = (await admin.api("/api/backups", { method: "POST" })) as unknown as ApiRes;
    if (cr.status !== 201) {
      console.log(`❌ فشل إنشاء النسخة المرجعية: ${cr.status} ${JSON.stringify(cr.body)}`);
      process.exit(1);
    }
    lastCreateAt = Date.now();
    check("A0b) نسخة مرجعية جديدة أُنشئت (إعادة بناء نقطة الاستعادة)", true, String((cr.body as unknown as { backupId?: string }).backupId ?? ""));
    list = (await admin.api("/api/backups")) as unknown as ApiRes;
    localList = (list.body.local ?? []) as { backupId: string; level: string }[];
  }
  if (localList.length === 0) {
    console.log("❌ لا توجد نسخ قائمة للفحص");
    process.exit(1);
  }
  const A = localList[0]!.backupId; // الأحدث
  check("A1) نسخة الفحص المختارة", true, `${A} (${localList[0]!.level})`);

  // ── 1) إنشاء مستخدمي الاختبار ──
  const PWD = "p4b3-matrix-pass";
  const specs: { username: string; role?: string; permissions?: Record<string, unknown> }[] = [
    { username: "u4b3-plain" },
    { username: "u4b3-mb", permissions: { manageBackups: true } },
    { username: "u4b3-rd", permissions: { restoreDatabase: true } },
    { username: "u4b3-both", permissions: { manageBackups: true, restoreDatabase: true } },
    { username: "u4b3-adminnr", role: "admin" }, // مدير بلا مفتاح استعادة (القالب لا يمنحه بعد 4B.3)
  ];
  const created: { id: string; username: string }[] = [];
  for (const sp of specs) {
    const r = (await admin.api("/api/users", {
      method: "POST",
      body: JSON.stringify({
        username: sp.username,
        password: PWD,
        displayName: sp.username,
        role: sp.role ?? "user",
        ...(sp.permissions ? { permissions: sp.permissions } : {}),
      }),
    })) as unknown as ApiRes & { body: { id?: string } };
    check(`A2) إنشاء ${sp.username}`, r.status === 201, `status=${r.status}`);
    if (r.body?.id) created.push({ id: r.body.id, username: sp.username });
  }

  // توثيق القيم المخزنة (least privilege)
  const usersList = (await admin.api("/api/users")) as unknown as ApiRes & {
    body: { id: string; username: string; role: string; permissions: Record<string, unknown> }[];
  };
  for (const u of usersList.body) {
    if (u.username.startsWith("u4b3-")) {
      check(
        `A3) ${u.username} (role=${u.role}) — restoreDatabase المخزنة`,
        u.permissions.restoreDatabase === (u.username === "u4b3-rd" || u.username === "u4b3-both"),
        String(u.permissions.restoreDatabase)
      );
    }
  }

  // ── 2) جلسات المستخدمين (دخول حقيقي NextAuth) ──
  const sPlain = makeSession();
  const sMb = makeSession();
  const sRd = makeSession();
  const sBoth = makeSession();
  const sAdminNr = makeSession();
  check("B0) جلسات", (
    (await sPlain.login("u4b3-plain", PWD)) &&
    (await sMb.login("u4b3-mb", PWD)) &&
    (await sRd.login("u4b3-rd", PWD)) &&
    (await sBoth.login("u4b3-both", PWD)) &&
    (await sAdminNr.login("u4b3-adminnr", PWD))
  ), "5/5 دخول حقيقي");

  const restoreBody = JSON.stringify({ confirmationText: "", downgradeConfirmation: null });

  // ── 3) المصفوفة ──
  console.log("\n--- غير مصدق ---");
  const anon = makeSession();
  check("M1) GET /api/backups ⇒ 401", (await anon.api("/api/backups")).status === 401);
  check("M2) GET recovery-log ⇒ 401", (await anon.api("/api/backups/recovery-log")).status === 401);
  check("M3) GET restore-preview ⇒ 401", (await anon.api(`/api/backups/${A}/restore-preview`)).status === 401);
  check("M4) POST restore ⇒ 401", (await anon.api(`/api/backups/${PROBE_BACKUP_ID}/restore`, { method: "POST", body: restoreBody })).status === 401);

  console.log("\n--- مستخدم عادي (بلا صلاحيات خاصة) ---");
  check("M5) GET /api/backups ⇒ 403", (await sPlain.api("/api/backups")).status === 403);
  check("M6) GET recovery-log ⇒ 403", (await sPlain.api("/api/backups/recovery-log")).status === 403);
  check("M7) GET restore-preview ⇒ 403", (await sPlain.api(`/api/backups/${A}/restore-preview`)).status === 403);
  check("M8) POST restore ⇒ 403", (await sPlain.api(`/api/backups/${PROBE_BACKUP_ID}/restore`, { method: "POST", body: restoreBody })).status === 403);
  check("M9) GET /api/reports ⇒ 200 (عمله الطبيعي غير متأثر)", (await sPlain.api("/api/reports")).status === 200);

  console.log("\n--- manageBackups فقط ---");
  const rMbList = await sMb.api("/api/backups");
  check("M10) GET /api/backups ⇒ 200", rMbList.status === 200);
  check("M11) GET recovery-log ⇒ 200 (سياسة القراءة: manageBackups)", (await sMb.api("/api/backups/recovery-log")).status === 200);
  // فترة التهدئة بين النسخ (60 ثانية) — حد معدل بعد التفويض لا بوابة تفويض؛
  // ننتظر حتى تمر كي يكون الإثبات 201 حقيقيًا لا 429
  const cooldownWait = lastCreateAt + 61_000 - Date.now();
  if (cooldownWait > 0) {
    console.log(`   ⏳ انتظار فترة التهدئة (${Math.ceil(cooldownWait / 1000)} ثانية)…`);
    await new Promise((r) => setTimeout(r, cooldownWait + 500));
  }
  lastCreateAt = Date.now();
  const rCreate = (await sMb.api("/api/backups", { method: "POST" })) as unknown as ApiRes;
  check("M12) POST /api/backups ⇒ 201 (نسخة جديدة كدليل)", rCreate.status === 201, rCreate.status === 201 ? String((rCreate.body as unknown as { backupId?: string }).backupId ?? "") : `status=${rCreate.status}`);
  check("M13) POST validate ⇒ 200", (await sMb.api(`/api/backups/${A}/validate`, { method: "POST" })).status === 200);
  check("M14) POST drill ⇒ 200 (معزول على مؤقتة)", (await sMb.api(`/api/backups/${A}/drill`, { method: "POST" })).status === 200);
  check("M15) GET download ⇒ 200 (ZIP)", (await sMb.api(`/api/backups/${A}/download`)).bytes > 0);
  check("M16) GET restore-preview ⇒ 403 (لا معاينة استعادة)", (await sMb.api(`/api/backups/${A}/restore-preview`)).status === 403);
  check("M17) POST restore ⇒ 403 (لا تنفيذ استعادة)", (await sMb.api(`/api/backups/${PROBE_BACKUP_ID}/restore`, { method: "POST", body: restoreBody })).status === 403);
  check("M18) GET /api/users ⇒ 403", (await sMb.api("/api/users")).status === 403);

  console.log("\n--- restoreDatabase فقط (الحد الأدنى من Restore workflow) ---");
  check("M19) GET /api/backups ⇒ 403 (لا إدارة نسخ عامة)", (await sRd.api("/api/backups")).status === 403);
  check("M20) GET recovery-log ⇒ 403 (القراءة لـ manageBackups)", (await sRd.api("/api/backups/recovery-log")).status === 403);
  check("M21) GET /api/backups/[A] ⇒ 403 (لا تفاصيل عامة)", (await sRd.api(`/api/backups/${A}`)).status === 403);
  check("M22) POST /api/backups ⇒ 403", (await sRd.api("/api/backups", { method: "POST" })).status === 403);
  check("M23) POST validate ⇒ 403", (await sRd.api(`/api/backups/${A}/validate`, { method: "POST" })).status === 403);
  check("M24) POST drill ⇒ 403", (await sRd.api(`/api/backups/${A}/drill`, { method: "POST" })).status === 403);
  check("M25) GET download ⇒ 403", (await sRd.api(`/api/backups/${A}/download`)).status === 403);
  check("M26) GET restore-preview ⇒ 200 (مسموح — بنود التأكيد)", (await sRd.api(`/api/backups/${A}/restore-preview`)).status === 200);
  const rRdRestore = (await sRd.api(`/api/backups/${PROBE_BACKUP_ID}/restore`, { method: "POST", body: restoreBody })) as unknown as ApiRes;
  check(
    "M27) POST restore ⇒ 409 RESTORE_ENGINE_DISABLED (تجاوز التفويض — المحرك معطّل، لا swap)",
    rRdRestore.status === 409 && rRdRestore.body.code === "RESTORE_ENGINE_DISABLED",
    `status=${rRdRestore.status} code=${rRdRestore.body.code ?? "-"}`
  );
  check("M28) GET /api/users ⇒ 403", (await sRd.api("/api/users")).status === 403);

  console.log("\n--- Admin بدون restoreDatabase (مفتاح 4B.3 الحاسم) ---");
  check("M29) GET /api/backups ⇒ 200 (إدارته بالدور سليمة)", (await sAdminNr.api("/api/backups")).status === 200);
  check("M30) GET recovery-log ⇒ 200", (await sAdminNr.api("/api/backups/recovery-log")).status === 200);
  check("M31) POST drill ⇒ 200", (await sAdminNr.api(`/api/backups/${A}/drill`, { method: "POST" })).status === 200);
  check("M32) GET restore-preview ⇒ 403 (المفتاح الصريح مطلوب)", (await sAdminNr.api(`/api/backups/${A}/restore-preview`)).status === 403);
  const rAdmNrRestore = (await sAdminNr.api(`/api/backups/${PROBE_BACKUP_ID}/restore`, { method: "POST", body: restoreBody })) as unknown as ApiRes;
  check(
    "M33) POST restore ⇒ 403 بالضبط (وليس 409 — لا كشف حالة المحرك قبل التفويض)",
    rAdmNrRestore.status === 403 && rAdmNrRestore.body.code === undefined,
    `status=${rAdmNrRestore.status} code=${rAdmNrRestore.body.code ?? "-"}`
  );
  check("M34) GET /api/users ⇒ 200 (manageUsers سليمة)", (await sAdminNr.api("/api/users")).status === 200);

  console.log("\n--- manageBackups + restoreDatabase ---");
  check("M35) GET restore-preview ⇒ 200", (await sBoth.api(`/api/backups/${A}/restore-preview`)).status === 200);
  const rBothRestore = (await sBoth.api(`/api/backups/${PROBE_BACKUP_ID}/restore`, { method: "POST", body: restoreBody })) as unknown as ApiRes;
  check(
    "M36) POST restore ⇒ 409 RESTORE_ENGINE_DISABLED (تفويض ناجح — بلا تنفيذ)",
    rBothRestore.status === 409 && rBothRestore.body.code === "RESTORE_ENGINE_DISABLED",
    `status=${rBothRestore.status} code=${rBothRestore.body.code ?? "-"}`
  );
  check("M37) GET /api/backups ⇒ 200 + recovery-log ⇒ 200", (await sBoth.api("/api/backups")).status === 200 && (await sBoth.api("/api/backups/recovery-log")).status === 200);

  console.log("\n--- المدير الأصلي (القيمة المخزنة لا تحتوي المفتاح — least privilege) ---");
  check("M38) GET /api/backups ⇒ 200 (إدارة النسخ بالدور لم تتغير)", (await admin.api("/api/backups")).status === 200);
  check("M39) GET restore-preview ⇒ 403 (قدرته السابقة كانت من الدور فقط — لم تُمنح بصمت)", (await admin.api(`/api/backups/${A}/restore-preview`)).status === 403);
  check("M40) POST restore ⇒ 403", (await admin.api(`/api/backups/${PROBE_BACKUP_ID}/restore`, { method: "POST", body: restoreBody })).status === 403);

  // ── 4) التنظيف الشرعي ──
  console.log("\n--- تنظيف مستخدمي الاختبار ---");
  for (const u of created) {
    const r = (await admin.api(`/api/users/${u.id}`, { method: "DELETE" })) as unknown as ApiRes;
    check(`C) حذف ${u.username}`, r.status === 200, `status=${r.status}`);
  }
  const finalUsers = (await admin.api("/api/users")) as unknown as ApiRes & { body: unknown[] };
  check("C+) عدد المستخدمين النهائي = 1 (المدير)", Array.isArray(finalUsers.body) && finalUsers.body.length === 1, String(Array.isArray(finalUsers.body) ? finalUsers.body.length : "?"));

  console.log(
    failures === 0
      ? "\n✅✅ المصفوفة كاملة نجحت — الفصل مثبت عبر HTTP حقيقي وبدون أي تنفيذ استعادة"
      : `\n❌ فشل ${failures} بندًا`
  );
  if (failures > 0) process.exitCode = 1;
}

main();
