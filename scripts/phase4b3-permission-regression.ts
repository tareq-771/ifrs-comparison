/**
 * Phase 4B.3 — Regression حفظ صلاحية الاستعادة (دورة حياة كاملة عبر HTTP حقيقي).
 *
 * الاختبار المطلوب حرفيًا من المستخدم (كشف bug محتمل في مسار users PUT):
 *   1. أنشئ Admin مع restoreDatabase=false            ⇒ المخزنة false
 *   2. عدّل اسمه أو صلاحية أخرى                        ⇒ تبقى false (لا منح من القالب)
 *   3. امنحه restoreDatabase=true                      ⇒ المخزنة true
 *   4. عدّل خاصية أخرى (بصلاحيات كاملة مثل المحرر)     ⇒ تبقى true (لا محو)
 *   5. عدّل خاصية أخرى دون إرسال permissions إطلاقًا   ⇒ تبقى true (لا محو صامت)
 *   6. اسحبها (false صريح)                             ⇒ المخزنة false
 *   7. جلسة جديدة بعد كل منح/سحب ⇒ سلوك Restore يتبع القيمة الجديدة فورًا
 *      (الصلاحيات في JWT حسب تصميم 4B.1 تتطلب إعادة دخول)
 *   8. Audit Trail: كل تغيير ظاهر في before/after.permissions
 *      + metadata.restoreDatabaseChanged مركّز
 *
 * لا تنفيذ استعادة إطلاقًا — المحرك معطل وprobe التنفيذ بمعرف نسخة غير موجود.
 */
export {}; // وحدة معزولة (منع تعارض النطاق العام مع باقي السكربتات في tsc)

const PROD_BASE = "http://127.0.0.1:3000";
const PROBE_BACKUP_ID = "bk-nonexistent-4b3probe";

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
  async function whoami(): Promise<{ id?: string; username?: string } | null> {
    const res = await fetch(`${PROD_BASE}/api/auth/session`, {
      headers: { Cookie: cookieHeader() },
      cache: "no-store",
    });
    await capture(res);
    if (!res.ok) return null;
    const j = (await res.json()) as { user?: { id?: string; username?: string } };
    return j?.user ?? null;
  }
  async function api<T = unknown>(
    path: string,
    init?: RequestInit
  ): Promise<{ status: number; body: T }> {
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

interface ApiRes {
  status: number;
  body: Record<string, unknown>;
}

async function storedRestoreOf(admin: ReturnType<typeof makeSession>, userId: string): Promise<boolean | null> {
  const r = (await admin.api(`/api/users/${userId}`)) as unknown as ApiRes;
  if (r.status !== 200) return null;
  const perms = (r.body as { permissions?: Record<string, unknown> }).permissions ?? {};
  return perms.restoreDatabase === true;
}

/** جسم الصلاحيات بنمط محرر الواجهة: مفاتيح المدير true + قيمة الاستعادة الصريحة */
function editorAdminPerms(restore: boolean): Record<string, unknown> {
  return {
    view: true, add: true, edit: true, delete: true, groups: true, export: true,
    settings: true, manageUsers: true, manageBackups: true,
    restoreDatabase: restore,
  };
}

async function main() {
  console.log("=== Phase 4B.3 — Permission Preservation Regression (HTTP حقيقي) ===\n");

  const admin = makeSession();
  if (!(await admin.login("admin", "admin123"))) {
    console.log("❌ فشل دخول المدير");
    process.exit(1);
  }

  const PWD = "p4b3-regression-pass";
  const U = "u4b3-admlife";

  // نسخة حقيقية للفحوص الموجبة (preview 200 يحتاج معرفًا صيغيّه صحيحًا —
  // المسار يفحص الصيغة بعد بوابة الصلاحية)
  const bl = (await admin.api("/api/backups")) as unknown as ApiRes & {
    body: { local?: { backupId: string }[] };
  };
  const REAL_A = bl.body.local?.[0]?.backupId;
  if (!REAL_A) { console.log("❌ لا نسخة للفحص الموجب"); process.exit(1); }

  // ── 1) إنشاء Admin مع restoreDatabase=false (القالب الجديد لا يمنحها) ──
  const cr = (await admin.api("/api/users", {
    method: "POST",
    body: JSON.stringify({
      username: U, password: PWD, displayName: "دورة حياة الصلاحية",
      role: "admin", permissions: editorAdminPerms(false),
    }),
  })) as unknown as ApiRes & { body: { id?: string } };
  check("R1) إنشاء مدير بـrestoreDatabase=false ⇒ 201", cr.status === 201, `status=${cr.status}`);
  const uid = cr.body?.id;
  if (!uid) { console.log("❌ لا معرف للمستخدم — توقف"); process.exit(1); }
  check("R1b) المخزنة false", (await storedRestoreOf(admin, uid)) === false);

  const victim = makeSession();
  const loginOk = () => victim.login(U, PWD);
  const previewStatus = async () =>
    (await victim.api("/api/backups/whatever/restore-preview")).status;
  const restoreStatus = async () =>
    (await victim.api(`/api/backups/${PROBE_BACKUP_ID}/restore`, {
      method: "POST",
      body: JSON.stringify({ confirmationText: "", downgradeConfirmation: null }),
    })).status;

  check("R1c) جلسة أولى: preview ⇒ 403 وrestore ⇒ 403 (وليس 409)",
    (await loginOk()) && (await previewStatus()) === 403 && (await restoreStatus()) === 403);

  // ── 2) تعديل الاسم فقط (بدون permissions) ⇒ تبقى false ──
  const p2 = (await admin.api(`/api/users/${uid}`, {
    method: "PUT",
    body: JSON.stringify({ displayName: "دورة حياة الصلاحية — تعديل اسم فقط" }),
  })) as unknown as ApiRes;
  check("R2) PUT displayName فقط ⇒ 200", p2.status === 200);
  check("R2b) المخزنة ما تزال false (القالب لم يمنحها)", (await storedRestoreOf(admin, uid)) === false);

  // تعديل مع permissions كاملة دون مفتاح الاستعادة (محرر قديم شبه جزئي) ⇒ تبقى false
  const p2c = (await admin.api(`/api/users/${uid}`, {
    method: "PUT",
    body: JSON.stringify({
      displayName: "دورة حياة الصلاحية — بدون مفتاح",
      permissions: { view: true, add: true, edit: true, delete: true, groups: true, export: true, settings: true, manageUsers: true, manageBackups: true },
    }),
  })) as unknown as ApiRes;
  check("R2c) PUT بصلاحيات كاملة بلا مفتاح الاستعادة ⇒ المخزنة false (غياب المفتاح لا يمنح)",
    p2c.status === 200 && (await storedRestoreOf(admin, uid)) === false);

  // ── 3) منح صريح true ⇒ جلسة جديدة ⇒ التفويض يمر ──
  const p3 = (await admin.api(`/api/users/${uid}`, {
    method: "PUT",
    body: JSON.stringify({ permissions: editorAdminPerms(true) }),
  })) as unknown as ApiRes;
  check("R3) منح restoreDatabase=true ⇒ 200", p3.status === 200);
  check("R3b) المخزنة true", (await storedRestoreOf(admin, uid)) === true);
  check("R3c) الجلسة القديمة (JWT) ما زالت مرفوضة 403 — التصميم: الصلاحيات عند الدخول",
    (await previewStatus()) === 403 && (await victim.api(`/api/backups/${REAL_A}/restore-preview`)).status === 403);
  // دخول جديد (JWT جديد يحمل الصلاحيات الجديدة) ثم الفحوص الموجبة
  const newLogin = await loginOk();
  const pvAfterGrant = (await victim.api(`/api/backups/${REAL_A}/restore-preview`)).status;
  const rsAfterGrant = (await victim.api(`/api/backups/${PROBE_BACKUP_ID}/restore`, {
    method: "POST",
    body: JSON.stringify({ confirmationText: "", downgradeConfirmation: null }),
  })).status;
  check("R3d) جلسة جديدة: preview ⇒ 200 وrestore ⇒ 409 (تفويض ناجح، محرك معطل، لا swap)",
    newLogin && pvAfterGrant === 200 && rsAfterGrant === 409,
    `preview=${pvAfterGrant} restore=${rsAfterGrant}`);

  // ── 4) تعديل آخر بصلاحيات كاملة تحوي true (نمط المحرر) ⇒ تبقى true ──
  const p4 = (await admin.api(`/api/users/${uid}`, {
    method: "PUT",
    body: JSON.stringify({ displayName: "دورة حياة الصلاحية — تعديل لاحق", permissions: editorAdminPerms(true) }),
  })) as unknown as ApiRes;
  check("R4) PUT تعديل آخر مع true صريح ⇒ المخزنة true", p4.status === 200 && (await storedRestoreOf(admin, uid)) === true);

  // ── 5) تعديل دون permissions إطلاقًا (مثل تبديل التفعيل) ⇒ تبقى true — لا محو صامت ──
  const p5 = (await admin.api(`/api/users/${uid}`, {
    method: "PUT",
    body: JSON.stringify({ displayName: "دورة حياة الصلاحية — تعديل بلا permissions" }),
  })) as unknown as ApiRes;
  check("R5) PUT بلا permissions ⇒ المخزنة true (لا محو صامت من قالب المدير)",
    p5.status === 200 && (await storedRestoreOf(admin, uid)) === true);

  // ── 6) سحب صريح false ⇒ جلسة جديدة ⇒ 403 فورًا ──
  const p6 = (await admin.api(`/api/users/${uid}`, {
    method: "PUT",
    body: JSON.stringify({ permissions: editorAdminPerms(false) }),
  })) as unknown as ApiRes;
  check("R6) سحب restoreDatabase=false ⇒ 200 والمخزنة false", p6.status === 200 && (await storedRestoreOf(admin, uid)) === false);
  check("R6b) جلسة جديدة: preview ⇒ 403 وrestore ⇒ 403 فورًا (على نسخة حقيقية أيضًا)",
    (await loginOk()) && (await previewStatus()) === 403 && (await restoreStatus()) === 403 &&
    (await victim.api(`/api/backups/${REAL_A}/restore-preview`)).status === 403);

  // ── 7) Audit Trail — قبل/بعد + metadata مركّز ──
  const audit = (await admin.api(
    `/api/audit?entityType=User&entityId=${uid}&pageSize=50`
  )) as unknown as ApiRes & {
    body: { rows?: { action: string; beforeData?: Record<string, unknown>; afterData?: Record<string, unknown>; metadata?: Record<string, unknown> }[]; total?: number };
  };
  const items = audit.body.rows ?? [];
  const permsEvents = items.filter((e) => e.action === "PERMISSIONS_CHANGED");
  console.log(`\n--- Audit Trail: ${items.length} حدثًا للمستخدم، منها ${permsEvents.length} PERMISSIONS_CHANGED ---`);
  // التحقق الدلالي:
  //   • حدث المنح: false→true مع metadata {from:false,to:true}
  //   • حدث السحب: true→false مع metadata {from:true,to:false}
  //   • أي حدث آخر (تغير سلسلة JSON دون تغيّر القيمة): قبل==بعد وبلا marker — سليم
  const withMeta = permsEvents.filter((e) => e.metadata?.restoreDatabaseChanged !== undefined);
  const metaOf = (e: (typeof withMeta)[number]): { from?: boolean; to?: boolean } | undefined =>
    e.metadata?.restoreDatabaseChanged as { from?: boolean; to?: boolean } | undefined;
  const grantEv = withMeta.find((e) => metaOf(e)?.from === false && metaOf(e)?.to === true);
  const revokeEv = withMeta.find((e) => metaOf(e)?.from === true && metaOf(e)?.to === false);
  let auditOk = grantEv !== undefined && revokeEv !== undefined;
  for (const e of permsEvents) {
    const before = (e.beforeData?.permissions as Record<string, unknown> | undefined)?.restoreDatabase;
    const after = (e.afterData?.permissions as Record<string, unknown> | undefined)?.restoreDatabase;
    const meta = e.metadata?.restoreDatabaseChanged as { from?: boolean; to?: boolean } | undefined;
    const consistent = typeof before === "boolean" && typeof after === "boolean" &&
      (before !== after ? !!meta && meta.from === before && meta.to === after : !meta);
    console.log(
      `   • ${e.action}: restoreDatabase ${String(before)} → ${String(after)}` +
      (meta ? ` (metadata: from=${meta.from} to=${meta.to})` : " (بلا metadata — لا تغيّر قيمة)") +
      (consistent ? " ✓" : " ✗ غير متسق")
    );
    if (!consistent) auditOk = false;
  }
  check("R7) Audit Trail: المنح والسحب موثقان في before/after + metadata مركّز، وأحداث بلا تغيّر قيمة بلا marker",
    auditOk);

  // ── 8) تنظيف ──
  const del = (await admin.api(`/api/users/${uid}`, { method: "DELETE" })) as unknown as ApiRes;
  check("R8) حذف مستخدم الاختبار ⇒ 200", del.status === 200);
  const finalUsers = (await admin.api("/api/users")) as unknown as ApiRes & { body: unknown[] };
  check("R8b) عدد المستخدمين النهائي = 1", Array.isArray(finalUsers.body) && finalUsers.body.length === 1);

  console.log(
    failures === 0
      ? "\n✅✅ Regression كامل: الصلاحية لا تُمنح من القالب ولا تُمحى بصمت، وتتبع الجلسات الجديدة حرفيًا"
      : `\n❌ فشل ${failures} بندًا`
  );
  if (failures > 0) process.exitCode = 1;
}

main();
