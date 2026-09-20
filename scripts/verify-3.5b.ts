/**
 * اختبارات 3.5B الإلزامية — لوحة المتابعة (HTTP حقيقي + مستخدمون حقيقيون).
 *
 * Dataset يغطي كل الحالات والفترات والمسؤولين، ثم:
 *  - مجموع الحالات الحصرية = الإجمالي، وتكافؤ KPI↔فلتر↔صفوف لكل بطاقة
 *  - Current Responsibility لكل حالة، حدود المتأخر (أمس/اليوم/غد/null × معتمد/غير معتمد)
 *  - daysOverdue، null dueDate، cycle>1، الرؤية لكل دور، facets بلا تسريب
 *  - Pagination/Sorting/Filters المركبة + باراميترات غير صالحة
 *  - بحث الاسم برموز % _ حرفيًا (بلا wildcards)
 *  - قراءة فقط: لا تغيير في أي جدول بعد جلسة لوحة كاملة
 */
import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const db = new PrismaClient();
let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL ${name} ${detail}`); }
}

/* ── HTTP helpers (نفس أسلوب verify-3.5a) ───────────────────────────── */
type Session = { cookie: string; username: string };
async function login(username: string, password: string): Promise<Session> {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`, { headers: { accept: "application/json" } });
  const csrfJson = await csrfRes.json();
  const jar: Record<string, string> = {};
  for (const c of csrfRes.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";"); const eq = pair.indexOf("=");
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  const body = new URLSearchParams({ csrfToken: csrfJson.csrfToken, username, password, json: "true" });
  await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") },
    body: body.toString(), redirect: "manual",
  }).then(async (r) => {
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";"); const eq = pair.indexOf("=");
      jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  });
  return { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "), username };
}
async function api(s: Session, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie: s.cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as any };
}

async function upsertUser(username: string, displayName: string, permOverrides: Record<string, unknown> = {}) {
  const bcrypt = (await import("bcryptjs")).default;
  const hash = await bcrypt.hash(`${username}123456`, 8);
  const perms = JSON.stringify({
    view: true, add: true, edit: true, delete: false, groups: false, export: true,
    settings: false, manageUsers: false, assignWorkflow: false, reopenReport: false,
    ...permOverrides,
  });
  const existing = await db.user.findUnique({ where: { username } });
  if (existing) {
    await db.user.update({ where: { username }, data: { passwordHash: hash, displayName, permissions: perms, active: true } });
    return existing.id;
  }
  const u = await db.user.create({ data: { username, passwordHash: hash, displayName, role: "user", permissions: perms, active: true } });
  return u.id;
}

/** سائق الانتقالات: يقرأ النسخة الطازجة قبل كل خطوة وينفذ بالترتيب */
async function drive(reportId: string, steps: { s: Session; action: string; reason?: string }[]) {
  for (const st of steps) {
    const fresh = await api(st.s, "GET", `/api/reports/${reportId}`);
    if (!fresh.json?.version) throw new Error(`drive: تقرير ${reportId} غير قابل للقراءة`);
    const r = await api(st.s, "POST", `/api/reports/${reportId}/workflow`, { action: st.action, version: fresh.json.version, ...(st.reason ? { reason: st.reason } : {}) });
    if (r.status !== 200) throw new Error(`drive: ${st.action} فشل (${r.status}) ${JSON.stringify(r.json?.error)}`);
  }
}

/* ═════════════════════════════════════════════════════════════════════ */
async function main() {
  console.log("== 3.5B Verification ==");
  const stamp = Date.now().toString(36);

  /* ── تنظيف ذاتي: بداية نظيفة دائمة (نفس هدف cleanup — بيانات اختبار فقط) ── */
  await db.workflowHistory.deleteMany({});
  await db.auditLog.deleteMany({});
  await db.report.deleteMany({});
  await db.group.deleteMany({});
  const adminUser = await db.user.findFirst({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
  await db.user.deleteMany({ where: { id: { not: adminUser?.id ?? "" } } });
  console.log("SELF-CLEAN: بداية نظيفة");

  // المستخدمون
  const saraId = await upsertUser("sara", "سارة المعدّة", { groups: true });
  const hudaId = await upsertUser("huda", "هدى المراجعة");
  const omarId = await upsertUser("omar", "عمر المعتمد");
  const noorId = await upsertUser("noor", "نور");
  await upsertUser("governor", "حاكم الاستحقاق", { assignWorkflow: true });
  const majedId = await upsertUser("majed", "ماجد قارئ المجموعة");
  const waleedId = await upsertUser("waleed", "وليد outsider");

  const admin = await login("admin", "admin123");
  const sara = await login("sara", "sara123456");

  /* ── المجموعات (قبل دخول ماجد — إذن الربط يُخبز في JWT عند الدخول) ── */
  // تُنشأ بواسطة sara حتى يجوز لها إنشاء التقارير فيها (المالك هو من ينشئ فيها)
  const g1 = await api(sara, "POST", "/api/groups", { name: `شركة أ ${stamp}` });
  const g2 = await api(sara, "POST", "/api/groups", { name: `شركة ب ${stamp}` });
  ok("SEED: مجموعتان أُنشئتا", g1.status === 201 || g1.status === 200, JSON.stringify(g1.json?.error));
  const G1 = g1.json.id, G2 = g2.json.id;
  // majed مرتبط بـ G1 فقط (رؤية قراءة — بلا أي صلاحية workflow جديدة) — قبل دخوله
  const majedPerms = JSON.parse((await db.user.findUnique({ where: { username: "majed" } }))!.permissions);
  majedPerms.groupIds = [G1];
  await db.user.update({ where: { username: "majed" }, data: { permissions: JSON.stringify(majedPerms) } });

  const huda = await login("huda", "huda123456");
  const omar = await login("omar", "omar123456");
  const majed = await login("majed", "majed123456");
  const waleed = await login("waleed", "waleed123456");

  /* ── إنشاء التقارير (بواسطة sara — تصبح المعدّ والمالك) ─────────────── */
  async function mk(name: string, periodEnd?: string, groupId?: string): Promise<string> {
    const r = await api(sara, "POST", "/api/reports", { name, periodEnd: periodEnd ?? null, ...(groupId ? { groupId } : {}) });
    if (r.status !== 201) throw new Error(`mk: فشل إنشاء ${name}: ${JSON.stringify(r.json)}`);
    return r.json.id;
  }
  async function due(id: string, d: string | null) {
    const fresh = await api(admin, "GET", `/api/reports/${id}`);
    const r = await api(admin, "PATCH", `/api/reports/${id}/due-date`, { dueDate: d, version: fresh.json.version });
    if (r.status !== 200) throw new Error(`due: فشل ${id}: ${JSON.stringify(r.json)}`);
  }
  async function assign(id: string) {
    const fresh = await api(admin, "GET", `/api/reports/${id}`);
    const r = await api(admin, "PUT", `/api/reports/${id}/assignments`, { reviewedById: hudaId, approvedById: omarId, version: fresh.json.version });
    if (r.status !== 200) throw new Error(`assign: فشل ${id}: ${JSON.stringify(r.json)}`);
  }

  const todayUtc3 = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const d = (offsetDays: number) => {
    const t = new Date(Date.now() + 180 * 60_000 + offsetDays * 86_400_000);
    return t.toISOString().slice(0, 10);
  };

  console.log("-- SEED: بناء Dataset الحالات");
  const R1 = await mk(`R1 بانتظار اعتماد متأخرة ${stamp}`, "2025-09-30", G1);
  await assign(R1); await due(R1, d(-1));
  await drive(R1, [
    { s: sara, action: "SUBMIT" }, { s: huda, action: "START_REVIEW" }, { s: huda, action: "COMPLETE_REVIEW" },
  ]);

  const R2 = await mk(`R2 مسودة متأخرة ${stamp}`, "2025-09-30", G1); await due(R2, d(-1));
  const R3 = await mk(`R3 مسودة تستحق اليوم ${stamp}`, "2025-08-31", G1); await due(R3, d(0));
  const R4 = await mk(`R4 مرسلة بلا استحقاق ${stamp}`, "2025-08-31", G1); await assign(R4);
  await drive(R4, [{ s: sara, action: "SUBMIT" }]);
  const R5 = await mk(`R5 قيد مراجعة ${stamp}`, null, G1); await assign(R5);
  await drive(R5, [{ s: sara, action: "SUBMIT" }, { s: huda, action: "START_REVIEW" }]);

  const R6 = await mk(`R6 معتمدة متأخرة استحقاقًا ${stamp}`, "2025-09-30", G2); await assign(R6); await due(R6, d(-1));
  await drive(R6, [{ s: sara, action: "SUBMIT" }, { s: huda, action: "START_REVIEW" }, { s: huda, action: "COMPLETE_REVIEW" }, { s: omar, action: "APPROVE" }]);
  const R7 = await mk(`R7 مرتجعة متأخرة ${stamp}`, "2025-09-30", G2); await assign(R7); await due(R7, d(-1));
  await drive(R7, [{ s: sara, action: "SUBMIT" }, { s: huda, action: "START_REVIEW" }, { s: huda, action: "RETURN", reason: "أرقام ناقصة" }]);
  const R8 = await mk(`R8 مرتجعة من بانتظار الاعتماد ${stamp}`, null, G2); await assign(R8);
  await drive(R8, [{ s: sara, action: "SUBMIT" }, { s: huda, action: "START_REVIEW" }, { s: huda, action: "COMPLETE_REVIEW" }, { s: omar, action: "RETURN", reason: "خطأ تصنيف قبل الاعتماد" }]);
  const R9 = await mk(`R9 معاد فتحها ${stamp}`, "2025-08-31", G2); await assign(R9); await due(R9, d(1));
  await drive(R9, [
    { s: sara, action: "SUBMIT" }, { s: huda, action: "START_REVIEW" }, { s: huda, action: "COMPLETE_REVIEW" }, { s: omar, action: "APPROVE" },
    { s: admin, action: "REOPEN", reason: "اكتشف خطأ بعد الاعتماد" },
  ]);
  const R10 = await mk(`R10 معتمدة بلا استحقاق ${stamp}`, null, G2); await assign(R10);
  await drive(R10, [{ s: sara, action: "SUBMIT" }, { s: huda, action: "START_REVIEW" }, { s: huda, action: "COMPLETE_REVIEW" }, { s: omar, action: "APPROVE" }]);
  const R11 = await mk(`R11 مسودة بلا مجموعة ${stamp}`, null);
  const R12 = await mk(`R12 مرسلة متأخرة يومين ${stamp}`, "2025-09-30"); await assign(R12); await due(R12, d(-2));
  await drive(R12, [{ s: sara, action: "SUBMIT" }]);
  const R13 = await mk(`R13 معتمدة تستحق غدًا ${stamp}`, "2025-08-31", G2); await assign(R13); await due(R13, d(1));
  await drive(R13, [{ s: sara, action: "SUBMIT" }, { s: huda, action: "START_REVIEW" }, { s: huda, action: "COMPLETE_REVIEW" }, { s: omar, action: "APPROVE" }]);
  const R14 = await mk(`R14 معتمدة تستحق اليوم ${stamp}`, "2025-08-31", G2); await assign(R14); await due(R14, d(0));
  await drive(R14, [{ s: sara, action: "SUBMIT" }, { s: huda, action: "START_REVIEW" }, { s: huda, action: "COMPLETE_REVIEW" }, { s: omar, action: "APPROVE" }]);
  const bulk: string[] = [];
  for (let i = 1; i <= 10; i++) bulk.push(await mk(`R-bulk-${i} ${stamp}`, null));
  const QPct = await mk(`بحث%تخصص ${stamp}`, null);
  const QUsc = await mk(`بحث_تخصص ${stamp}`, null);
  const QX = await mk(`بحثXتخصص ${stamp}`, null);

  const TOTAL = 27;
  console.log(`-- SEED: ${TOTAL} تقريرًا`);

  /* ══ 1) التجميع والتكافؤ ══ */
  console.log("-- A: التجميع وتكافؤ بطاقة↔فلتر");
  const sum = await api(admin, "GET", "/api/dashboard/summary");
  ok("A0: summary 200", sum.status === 200 && sum.json?.success, JSON.stringify(sum.json?.error));
  const c = sum.json.data.counts;
  ok("A1: today من الخادم date-only بتوقيت الأعمال", sum.json.data.today === todayUtc3, `got ${sum.json.data.today} want ${todayUtc3}`);
  const exclusiveSum = c.newDraft + c.submitted + c.underReview + c.returned + c.pendingApproval + c.reopenedAwaiting + c.approved;
  ok("A2: مجموع المراحل الحصرية السبع = الإجمالي", exclusiveSum === c.total && c.total === TOTAL, `sum=${exclusiveSum} total=${c.total}`);
  ok("A3: التوزيع المتوقع", c.newDraft === 16 && c.submitted === 2 && c.underReview === 1 && c.returned === 2 && c.pendingApproval === 1 && c.reopenedAwaiting === 1 && c.approved === 4, JSON.stringify(c));
  ok("A4: المتأخرة = 4 (علم متراكب خارج التقسيم)", c.overdue === 4, `got ${c.overdue}`);
  ok("A5: أعيد فتحها (cycle>1) = 1", c.everReopened === 1, `got ${c.everReopened}`);

  const stagePairs: [string, number][] = [
    ["NEW_DRAFT", c.newDraft], ["SUBMITTED", c.submitted], ["UNDER_REVIEW", c.underReview],
    ["RETURNED", c.returned], ["PENDING_APPROVAL", c.pendingApproval], ["REOPENED", c.reopenedAwaiting],
    ["APPROVED", c.approved],
  ];
  for (const [stage, expected] of stagePairs) {
    const lst = await api(admin, "GET", `/api/dashboard/reconciliations?stage=${stage}&pageSize=100`);
    ok(`A6-eq: فلتر stage=${stage} يساوي بطاقته (${expected})`, lst.status === 200 && lst.json.data.pagination.total === expected, `got ${lst.json?.data?.pagination?.total}`);
    // تكافؤ الصفوف: قيمة stage في كل صف = المرحلة نفسها
    const rowsStages = new Set((lst.json.data.rows as any[]).map((r) => r.stage));
    ok(`A6-pure: كل صفوف stage=${stage} قيمتها ${stage}`, rowsStages.size === 1 && rowsStages.has(stage), JSON.stringify([...rowsStages]));
  }
  const odList = await api(admin, "GET", "/api/dashboard/reconciliations?overdue=true&pageSize=100");
  ok("A6-eq: فلتر overdue=true يساوي بطاقة المتأخرة", odList.json.data.pagination.total === c.overdue);
  const cyList = await api(admin, "GET", "/api/dashboard/reconciliations?cycle=>1&pageSize=100");
  ok("A6-eq: فلتر cycle>1 يساوي بطاقة أعيد فتحها", cyList.json.data.pagination.total === c.everReopened);

  /* ══ 2) المسؤولية الحالية ══ */
  console.log("-- B: Current Responsibility");
  const all = await api(admin, "GET", "/api/dashboard/reconciliations?pageSize=100");
  const rowsById = new Map<string, any>((all.json.data.rows as any[]).map((r) => [r.id, r]));
  const ownerOf = (id: string) => rowsById.get(id)?.currentOwner;
  ok("B1: PENDING_APPROVAL → المعتمد عمر", ownerOf(R1)?.role === "APPROVER" && ownerOf(R1)?.name === "عمر المعتمد", JSON.stringify(ownerOf(R1)));
  ok("B2: DRAFT → المعدّ سارة", ownerOf(R2)?.role === "PREPARER" && ownerOf(R2)?.name === "سارة المعدّة");
  ok("B3: SUBMITTED → المراجع هدى", ownerOf(R4)?.role === "REVIEWER" && ownerOf(R4)?.name === "هدى المراجعة");
  ok("B4: UNDER_REVIEW → المراجع", ownerOf(R5)?.role === "REVIEWER");
  ok("B5: RETURNED → المعدّ", ownerOf(R7)?.role === "PREPARER" && ownerOf(R8)?.role === "PREPARER");
  ok("B6: REOPENED → المعدّ", ownerOf(R9)?.role === "PREPARER");
  ok("B7: APPROVED → مقفولة (لا أحد)", ownerOf(R6)?.role === "NONE" && ownerOf(R10)?.role === "NONE");
  const ownerRoleList = await api(admin, "GET", "/api/dashboard/reconciliations?ownerRole=APPROVER&pageSize=100");
  ok("B8: فلتر ownerRole=APPROVER → R1 فقط", ownerRoleList.json.data.pagination.total === 1 && ownerRoleList.json.data.rows[0]?.id === R1);
  const ownerRoleRev = await api(admin, "GET", "/api/dashboard/reconciliations?ownerRole=REVIEWER&pageSize=100");
  ok("B9: فلتر ownerRole=REVIEWER → SUBMITTED/UNDER_REVIEW (3)", ownerRoleRev.json.data.pagination.total === 3, `got ${ownerRoleRev.json?.data?.pagination?.total}`);
  const omarMe = await api(omar, "GET", "/api/dashboard/reconciliations?ownerMe=true&pageSize=100");
  ok("B10: ownerMe=true للمعتمد → R1 فقط (حالة إنجازية فعلية)", omarMe.json.data.pagination.total === 1 && omarMe.json.data.rows[0]?.id === R1, `got ${omarMe.json?.data?.pagination?.total}`);

  /* ══ 3) حدود المتأخر ══ */
  console.log("-- C: حدود المتأخر (مصفوفة)");
  const odCases: [string, boolean, number | null][] = [
    [R1, true, 1],   // أمس × PENDING_APPROVAL
    [R2, true, 1],   // أمس × DRAFT
    [R3, false, null], // اليوم × DRAFT (يستحق اليوم — ليس متأخرًا)
    [R7, true, 1],   // أمس × RETURNED
    [R9, false, null], // غدًا × REOPENED
    [R6, false, null], // أمس × APPROVED (الاعتماد يغلق ساعة الاستحقاق)
    [R13, false, null], // غدًا × APPROVED
    [R14, false, null], // اليوم × APPROVED
    [R10, false, null], // null × APPROVED
    [R4, false, null], // null × SUBMITTED
    [R12, true, 2],  // قبل يومين × SUBMITTED
  ];
  for (const [id, wantOverdue, wantDays] of odCases) {
    const r = rowsById.get(id);
    ok(`C: ${r?.name.slice(0, 24)}… overdue=${wantOverdue}${wantDays ? ` days=${wantDays}` : ""}`, r?.overdue === wantOverdue && r?.daysOverdue === wantDays, JSON.stringify({ overdue: r?.overdue, days: r?.daysOverdue }));
  }
  const odNone = await api(admin, "GET", "/api/dashboard/reconciliations?overdue=none&pageSize=100");
  ok("C2: فلتر بدون استحقاق يصطاد null dueDate (18)", odNone.json.data.pagination.total === 18, `got ${odNone.json?.data?.pagination?.total}`);
  ok("C3: null dueDate لا يدخل المتأخرة أبدًا (مثال R4)", rowsById.get(R4)?.overdue === false && rowsById.get(R4)?.dueDate === null);

  /* ══ 4) الرؤية لكل دور ══ */
  console.log("-- D: الرؤية لكل دور");
  const visFor = async (s: Session) => (await api(s, "GET", "/api/dashboard/summary")).json.data.counts.total;
  ok("D1: المدير يرى الكل (27)", (await visFor(admin)) === TOTAL, `got ${await visFor(admin)}`);
  ok("D2: المالكة (سارة) ترى كل تقاريرها (27)", (await visFor(sara)) === TOTAL);
  ok("D3: عضو مجموعة مرتبطة (ماجد/G1) يرى 5 قراءة فقط", (await visFor(majed)) === 5, `got ${await visFor(majed)}`);
  const hudaTotal = await visFor(huda);
  ok("D4: المراجع ترى مشاركتها فقط (11 — كل ما أُسندت مراجعةً له)", hudaTotal === 11, `got ${hudaTotal}`);
  const omarTotal = await visFor(omar);
  ok("D5: المعتمد يرى مشاركته فقط (10 — REOPEN أزال إسناد الاعتماد من R9)", omarTotal === 10, `got ${omarTotal}`);
  ok("D6: outsider يرى أصفارًا", (await visFor(waleed)) === 0);
  const majedList = await api(majed, "GET", "/api/dashboard/reconciliations?pageSize=100");
  ok("D7: صفوف ماجد كلها من G1", (majedList.json.data.rows as any[]).every((r) => r.groupId === G1));
  // قراءة فقط لماجد: لا أزرار انتقالات (لا يشارك في الأدوار)
  ok("D8: ماجد لا يملك أي إجراء workflow في الصفوف", (majedList.json.data.rows as any[]).every((r) => !r.myActions.canSubmit && !r.myActions.canStartReview && !r.myActions.canCompleteReview && !r.myActions.canReturn && !r.myActions.canApprove && !r.myActions.canReopen && !r.myActions.canResume));
  // omar على R1: canApprove/canReturn صحيحان — وsara مقفولة التعديل
  const omarRows = await api(omar, "GET", "/api/dashboard/reconciliations?pageSize=100");
  const omarR1 = (omarRows.json.data.rows as any[]).find((r) => r.id === R1);
  ok("D9: myActions للمعتمد في PENDING_APPROVAL (اعتماد/إرجاع فقط)", omarR1?.myActions?.canApprove === true && omarR1?.myActions?.canReturn === true && omarR1?.myActions?.canEdit === false);
  const saraRows = await api(sara, "GET", "/api/dashboard/reconciliations?pageSize=100");
  const saraR1 = (saraRows.json.data.rows as any[]).find((r) => r.id === R1);
  ok("D10: المعدّ في PENDING_APPROVAL بلا أي إجراء انتقال", saraR1?.myActions?.canApprove === false && saraR1?.myActions?.canSubmit === false && saraR1?.myActions?.canEdit === false);

  /* ══ 5) facets بلا تسريب ══ */
  console.log("-- E: facets ومنع التسريب");
  const fAdmin = await api(admin, "GET", "/api/dashboard/facets");
  ok("E1: facets المدير فيها الفترتان والمجموعتان", fAdmin.json.data.periods.includes("2025-09-30") && fAdmin.json.data.periods.includes("2025-08-31") && fAdmin.json.data.groups.length === 2);
  const fWaleed = await api(waleed, "GET", "/api/dashboard/facets");
  ok("E2: facets outsider فارغة كليًا (لا تسريب أسماء)", fWaleed.json.data.periods.length === 0 && fWaleed.json.data.groups.length === 0 && fWaleed.json.data.users.preparers.length === 0 && fWaleed.json.data.users.reviewers.length === 0 && fWaleed.json.data.users.approvers.length === 0);
  const fMajed = await api(majed, "GET", "/api/dashboard/facets");
  const majedUserIds = [...fMajed.json.data.users.preparers, ...fMajed.json.data.users.reviewers, ...fMajed.json.data.users.approvers].map((u: any) => u.id);
  ok("E3: facets ماجد لا تحوي مستخدمًا خارج تقاريره المرئية", majedUserIds.every((id: string) => [saraId, hudaId, omarId].includes(id)) && majedUserIds.includes(saraId));
  ok("E4: facets ماجد لا تحوي نور/وليد/حاكم (غير مرئيين)", !majedUserIds.includes(noorId) && !majedUserIds.includes(waleedId));
  const wFiltered = await api(waleed, "GET", `/api/dashboard/reconciliations?preparedById=${saraId}`);
  ok("E5: فلتر بمعرّف غير مرئي → 200 بقائمة فارغة (لا 404)", wFiltered.status === 200 && wFiltered.json.data.pagination.total === 0);

  /* ══ 6) الترقيم والترتيب ══ */
  console.log("-- F: Pagination/Sorting");
  const p1 = await api(admin, "GET", "/api/dashboard/reconciliations?page=1&pageSize=20");
  const p2 = await api(admin, "GET", "/api/dashboard/reconciliations?page=2&pageSize=20");
  ok("F1: pageSize=20 → صفحتان (20+7)", p1.json.data.rows.length === 20 && p2.json.data.rows.length === 7 && p1.json.data.pagination.totalPages === 2);
  const pFar = await api(admin, "GET", "/api/dashboard/reconciliations?page=99&pageSize=20");
  ok("F2: صفحة خارج النطاق → قائمة فارغة سليمة", pFar.status === 200 && pFar.json.data.rows.length === 0);
  ok("F3: pageSize=7 مرفوض (400)", (await api(admin, "GET", "/api/dashboard/reconciliations?pageSize=7")).status === 400);
  ok("F4: page=0 مرفوض (400)", (await api(admin, "GET", "/api/dashboard/reconciliations?page=0")).status === 400);
  const nameAsc = await api(admin, "GET", "/api/dashboard/reconciliations?sort=name&dir=asc&pageSize=100");
  const names = (nameAsc.json.data.rows as any[]).map((r) => r.name);
  ok("F5: ترتيب بالاسم asc سليم", names.every((n, i) => i === 0 || names[i - 1] <= n));
  const cycleDesc = await api(admin, "GET", "/api/dashboard/reconciliations?sort=cycle&dir=desc&pageSize=100");
  const cycles = (cycleDesc.json.data.rows as any[]).map((r) => r.cycle);
  ok("F6: ترتيب بالدورة desc (الأعلى أولًا)", cycles[0] === 2 && cycles.every((v, i) => i === 0 || cycles[i - 1] >= v), JSON.stringify(cycles.slice(0, 4)));
  ok("F7: sort خارج القائمة مرفوض (400)", (await api(admin, "GET", "/api/dashboard/reconciliations?sort=(UPDATE)")).status === 400);
  ok("F8: dir غير صالح مرفوض (400)", (await api(admin, "GET", "/api/dashboard/reconciliations?dir=UP")).status === 400);

  /* ══ 7) الفلاتر المركبة وغير الصالحة ══ */
  console.log("-- G: فلاتر مركبة + باراميترات غير صالحة");
  const comp1 = await api(admin, "GET", "/api/dashboard/reconciliations?stage=RETURNED&overdue=true&pageSize=100");
  ok("G1: RETURNED ∧ متأخرة → R7 فقط", comp1.json.data.pagination.total === 1 && comp1.json.data.rows[0]?.id === R7);
  const comp2 = await api(admin, "GET", `/api/dashboard/reconciliations?groupId=${G1}&period=2025-09-30&stage=PENDING_APPROVAL`);
  ok("G2: G1 ∧ فترة ∧ بانتظار الاعتماد → R1", comp2.json.data.pagination.total === 1 && comp2.json.data.rows[0]?.id === R1);
  const comp3 = await api(admin, "GET", `/api/dashboard/reconciliations?groupId=${G2}&status=APPROVED&pageSize=100`);
  ok("G3: G2 ∧ APPROVED → 4 (R6,R10,R13,R14)", comp3.json.data.pagination.total === 4, `got ${comp3.json?.data?.pagination?.total}`);
  ok("G4: status=FOO مرفوض (400)", (await api(admin, "GET", "/api/dashboard/reconciliations?status=FOO")).status === 400);
  ok("G5: stage=NOPE مرفوض (400)", (await api(admin, "GET", "/api/dashboard/reconciliations?stage=NOPE")).status === 400);
  ok("G6: overdue=maybe مرفوض (400)", (await api(admin, "GET", "/api/dashboard/reconciliations?overdue=maybe")).status === 400);
  ok("G7: ownerRole=KING مرفوض (400)", (await api(admin, "GET", "/api/dashboard/reconciliations?ownerRole=KING")).status === 400);
  ok("G8: cycle=abc مرفوض (400)", (await api(admin, "GET", "/api/dashboard/reconciliations?cycle=abc")).status === 400);
  ok("G9: period=2025-13-99 مرفوض (400)", (await api(admin, "GET", "/api/dashboard/reconciliations?period=2025-13-99")).status === 400);
  const summaryBad = await api(admin, "GET", "/api/dashboard/summary?period=bad-date");
  ok("G10: summary بفترة غير صالحة مرفوض (400)", summaryBad.status === 400);

  /* ══ 8) بحث الاسم برموز % _ حرفيًا ══ */
  console.log("-- H: بحث الاسم وescape");
  const qPct = await api(admin, "GET", `/api/dashboard/reconciliations?q=${encodeURIComponent("بحث%تخصص")}&pageSize=100`);
  ok("H1: % حرفي — يطابق الاسم الحرفي فقط (1)", qPct.json.data.pagination.total === 1 && qPct.json.data.rows[0]?.id === QPct, `got ${qPct.json?.data?.pagination?.total}`);
  const qUsc = await api(admin, "GET", `/api/dashboard/reconciliations?q=${encodeURIComponent("بحث_تخصص")}&pageSize=100`);
  ok("H2: _ حرفي — لا يعمل كبدل (1 وليس 2)", qUsc.json.data.pagination.total === 1 && qUsc.json.data.rows[0]?.id === QUsc, `got ${qUsc.json?.data?.pagination?.total}`);
  const qPlain = await api(admin, "GET", `/api/dashboard/reconciliations?q=${encodeURIComponent("R-bulk")}&pageSize=100`);
  ok("H3: بحث عادي يعمل (10)", qPlain.json.data.pagination.total === 10);

  /* ══ 9) فلاتر النطاق على البطاقات ══ */
  console.log("-- I: نطاق البطاقات");
  const sumG1 = await api(admin, "GET", `/api/dashboard/summary?groupId=${G1}`);
  ok("I1: summary بفلتر G1 → 5", sumG1.json.data.counts.total === 5, `got ${sumG1.json?.data?.counts?.total}`);
  const sumP = await api(admin, "GET", "/api/dashboard/summary?period=2025-09-30");
  ok("I2: summary بفلتر فترة → 5", sumP.json.data.counts.total === 5, `got ${sumP.json?.data?.counts?.total}`);
  const sumNone = await api(admin, "GET", "/api/dashboard/summary?period=none");
  ok("I3: خيار بدون فترة يعمل (17)", sumNone.json.data.counts.total === 17, `got ${sumNone.json?.data?.counts?.total}`);

  /* ══ 10) قراءة فقط: لا أي تغيير بيانات بجلسة لوحة كاملة ══ */
  console.log("-- J: إثبات القراءة فقط");
  const beforeCounts = {
    reports: await db.report.count(),
    wh: await db.workflowHistory.count(),
    audit: await db.auditLog.count(),
    maxVersion: (await db.report.aggregate({ _max: { version: true } }))._max.version,
  };
  // جلسة استخدام كاملة: كل البطاقات + كل الفلاتر + كل الصفحات + facets + ترتيب
  for (const st of ["NEW_DRAFT", "SUBMITTED", "UNDER_REVIEW", "RETURNED", "PENDING_APPROVAL", "REOPENED", "APPROVED"]) {
    await api(admin, "GET", `/api/dashboard/reconciliations?stage=${st}&pageSize=100&page=1`);
  }
  for (let p = 1; p <= 2; p++) await api(admin, "GET", `/api/dashboard/reconciliations?page=${p}&pageSize=20`);
  await api(admin, "GET", "/api/dashboard/reconciliations?overdue=true&pageSize=100");
  await api(admin, "GET", "/api/dashboard/reconciliations?cycle=>1&pageSize=100");
  await api(admin, "GET", "/api/dashboard/reconciliations?ownerMe=true&pageSize=100");
  await api(admin, "GET", "/api/dashboard/facets");
  await api(admin, "GET", "/api/dashboard/summary");
  const afterCounts = {
    reports: await db.report.count(),
    wh: await db.workflowHistory.count(),
    audit: await db.auditLog.count(),
    maxVersion: (await db.report.aggregate({ _max: { version: true } }))._max.version,
  };
  ok("J1: لا أي تغيير في Report/WorkflowHistory/AuditLog/versions بعد جلسة كاملة", JSON.stringify(beforeCounts) === JSON.stringify(afterCounts), `${JSON.stringify(beforeCounts)} vs ${JSON.stringify(afterCounts)}`);
  // لا مسارات كتابة في اللوحة: POST/PUT/PATCH/DELETE ⇒ 405
  const postList = await api(admin, "POST", "/api/dashboard/reconciliations", {});
  const putSummary = await api(admin, "PUT", "/api/dashboard/summary", {});
  const delFacets = await api(admin, "DELETE", "/api/dashboard/facets");
  const patchList = await api(admin, "PATCH", "/api/dashboard/reconciliations", {});
  ok("J2: كل أفعال الكتابة على مسارات اللوحة ⇒ 405", postList.status === 405 && putSummary.status === 405 && delFacets.status === 405 && patchList.status === 405);

  console.log(`\n== RESULT: pass=${pass} fail=${fail} ==`);
  if (failures.length) { console.log("Failures:"); for (const f of failures) console.log(" -", f); }
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
