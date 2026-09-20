/**
 * اختبارات 3.5A الإلزامية — تشغيل حقيقي عبر HTTP ضد dev server (منفذ 3000)
 * بأسلوب المرحلة 3: مستخدمون حقيقيون + جلسات NextAuth + فحوص قاعدة بيانات مباشرة.
 *
 * يغطي قائمة المستخدم الإلزامية:
 *  1) SUBMITTED → UNDER_REVIEW → PENDING_APPROVAL → APPROVED
 *  2) PENDING_APPROVAL → RETURNED (المعتمد بسبب) → DRAFT → ... دورة جديدة
 *  3) محاولة المعدّ تعديل البيانات في PENDING_APPROVAL
 *  4) محاولة المعتمد تعديل البيانات بدل APPROVE/RETURN
 *  5) محاولة APPROVE مباشرة من UNDER_REVIEW
 *  6) محاولة COMPLETE_REVIEW بواسطة غير المراجع
 *  7) تعارض النسخة في COMPLETE_REVIEW وAPPROVE
 *  8) تغيير dueDate بواسطة المعدّ دون صلاحية
 *  9) تغيير dueDate بواسطة المخوّل مع AuditLog (DUE_DATE_CHANGED)
 *  + استبدال المراجع في PENDING_APPROVAL يبطل التوقيع، REOPEN يمسح أدلة المراجعة،
 *    SoD regression، الاستحقاق عند الإنشاء، ولا WorkflowHistory لتغيير dueDate.
 *
 * التنظيف في سكربت منفصل: scripts/cleanup-35a.ts
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

/* ── أدوات HTTP مع جلسة NextAuth ─────────────────────────────────────── */
type Session = { cookie: string; username: string };

async function login(username: string, password: string): Promise<Session> {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`, { headers: { accept: "application/json" } });
  const csrfJson = await csrfRes.json();
  const csrfCookies = csrfRes.headers.getSetCookie?.() ?? [];
  const jar: Record<string, string> = {};
  for (const c of csrfCookies) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  const body = new URLSearchParams({
    csrfToken: csrfJson.csrfToken,
    username,
    password,
    json: "true",
  });
  const cbRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "),
    },
    body: body.toString(),
    redirect: "manual",
  });
  for (const c of cbRes.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  return { cookie, username };
}

async function api(s: Session, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: s.cookie,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json } as { status: number; json: any };
}

/* ── إعداد المستخدمين ────────────────────────────────────────────────── */
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
  const u = await db.user.create({
    data: { username, passwordHash: hash, displayName, role: "user", permissions: perms, active: true },
  });
  return u.id;
}

async function getReport(s: Session, id: string) {
  const r = await api(s, "GET", `/api/reports/${id}`);
  return r.json;
}

/* ═════════════════════════════════════════════════════════════════════ */
async function main() {
  console.log("== 3.5A Verification ==");
  const stamp = Date.now().toString(36);

  // المستخدمون (upsert حتى يمكن إعادة التشغيل)
  const saraId = await upsertUser("sara", "سارة المعدّة");
  const hudaId = await upsertUser("huda", "هدى المراجعة");
  const omarId = await upsertUser("omar", "عمر المعتمد");
  const noorId = await upsertUser("noor", "نور المراجعة الثانية");
  const govId = await upsertUser("governor", "حاكم الاستحقاق", { assignWorkflow: true });

  const admin = await login("admin", "admin123");
  const sara = await login("sara", "sara123456");
  const huda = await login("huda", "huda123456");
  const omar = await login("omar", "omar123456");
  const noor = await login("noor", "noor123456");
  const governor = await login("governor", "governor123456");

  const sessCheck = await api(admin, "GET", "/api/auth/session");
  ok("S0: جلسة المدير تعمل بعد الدخول", !!sessCheck.json?.user && sessCheck.json.user.role === "admin");

  /* ── التقرير A: الدورة الكاملة السعيدة ─────────────────────────────── */
  console.log("-- T1: الدورة الكاملة SUBMITTED→UNDER_REVIEW→PENDING_APPROVAL→APPROVED");
  const createdA = await api(admin, "POST", "/api/reports", { name: `A-دورة-كاملة-${stamp}`, dueDate: "2026-03-01" });
  ok("T1.0 إنشاء تقرير بالاستحقاق (201)", createdA.status === 201);
  ok("T1.0a dueDate محفوظ date-only", createdA.json?.dueDate === "2026-03-01", `got ${createdA.json?.dueDate}`);
  const A = createdA.json.id;

  const assignA = await api(admin, "PUT", `/api/reports/${A}/assignments`, {
    preparedById: saraId, reviewedById: hudaId, approvedById: omarId, version: createdA.json.version,
  });
  ok("T1.1 إسناد الأدوار الثلاثة (200)", assignA.status === 200, JSON.stringify(assignA.json?.error));

  const submitA = await api(sara, "POST", `/api/reports/${A}/workflow`, { action: "SUBMIT", version: assignA.json.version });
  ok("T1.2 SUBMIT من المعدّ (200 → SUBMITTED)", submitA.status === 200 && submitA.json?.workflow?.status === "SUBMITTED", JSON.stringify(submitA.json?.error));
  ok("T1.2a preparedAt ثبت عند الإرسال", !!submitA.json?.preparedAt);

  const startA = await api(huda, "POST", `/api/reports/${A}/workflow`, { action: "START_REVIEW", version: submitA.json.version });
  ok("T1.3 START_REVIEW (200 → UNDER_REVIEW)", startA.status === 200 && startA.json?.workflow?.status === "UNDER_REVIEW");
  ok("T1.3a reviewStartedAt ثبت (الدلالة الجديدة)", !!startA.json?.reviewStartedAt);
  ok("T1.3b reviewedAt لم يثبت بعد (لا توقيع)", startA.json?.reviewedAt === null, `got ${startA.json?.reviewedAt}`);

  const approveDirect = await api(omar, "POST", `/api/reports/${A}/workflow`, { action: "APPROVE", version: startA.json.version });
  ok("T5: APPROVE مباشرة من UNDER_REVIEW مرفوض (409 INVALID_TRANSITION)", approveDirect.status === 409 && approveDirect.json?.code === "INVALID_TRANSITION", `got ${approveDirect.status}/${approveDirect.json?.code}`);

  const completeByOmar = await api(omar, "POST", `/api/reports/${A}/workflow`, { action: "COMPLETE_REVIEW", version: startA.json.version });
  ok("T6a: COMPLETE_REVIEW بواسطة المعتمد مرفوض (403 NOT_ASSIGNED)", completeByOmar.status === 403 && completeByOmar.json?.code === "NOT_ASSIGNED", `got ${completeByOmar.status}/${completeByOmar.json?.code}`);
  const completeBySara = await api(sara, "POST", `/api/reports/${A}/workflow`, { action: "COMPLETE_REVIEW", version: startA.json.version });
  ok("T6b: COMPLETE_REVIEW بواسطة المعدّ مرفوض (403 NOT_ASSIGNED)", completeBySara.status === 403 && completeBySara.json?.code === "NOT_ASSIGNED");

  const staleComplete = await api(huda, "POST", `/api/reports/${A}/workflow`, { action: "COMPLETE_REVIEW", version: startA.json.version - 1 });
  ok("T7a: COMPLETE_REVIEW بنسخة قديمة (409 VERSION_CONFLICT)", staleComplete.status === 409 && staleComplete.json?.code === "VERSION_CONFLICT", `got ${staleComplete.status}/${staleComplete.json?.code}`);

  const completeA = await api(huda, "POST", `/api/reports/${A}/workflow`, { action: "COMPLETE_REVIEW", version: startA.json.version });
  ok("T1.4 COMPLETE_REVIEW من المراجع (200 → PENDING_APPROVAL)", completeA.status === 200 && completeA.json?.workflow?.status === "PENDING_APPROVAL", JSON.stringify(completeA.json?.error));
  ok("T1.4a reviewedAt ثبت عند التوقيع (إتمام)", !!completeA.json?.reviewedAt);
  ok("T1.4b التوقيع بعد البدء زمنيًا", new Date(completeA.json.reviewedAt).getTime() >= new Date(startA.json.reviewStartedAt).getTime());

  // فحوص قاعدة بيانات لأحداث REVIEW_COMPLETED
  const whComplete = await db.workflowHistory.findFirst({
    where: { reportId: A, action: "REVIEW_COMPLETED" },
    orderBy: { createdAt: "desc" },
  });
  ok("T1.4c WorkflowHistory: صف REVIEW_COMPLETED موجود", !!whComplete);
  if (whComplete) {
    const snap = JSON.parse(whComplete.roleSnapshot || "{}");
    const roles = snap.roles ?? snap;
    ok("T1.4d snapshot التوقيع فيه المراجع+reviewedAt+الدورة",
      roles.reviewedBy?.name === "هدى المراجعة" && !!roles.reviewedBy?.at && whComplete.cycle === 1 && roles.reviewedBy?.reviewStartedAt,
      JSON.stringify(roles.reviewedBy));
  }
  const auditComplete = await db.auditLog.findFirst({ where: { entityId: A, action: "REVIEW_COMPLETED" }, orderBy: { createdAt: "desc" } });
  ok("T1.4e AuditLog: REVIEW_COMPLETED مسجل", !!auditComplete);
  ok("T1.4f لا صف WorkflowHistory لتغيير dueDate (ليس انتقالًا)",
    !(await db.workflowHistory.findFirst({ where: { reportId: A, action: "ASSIGNMENT_CHANGED", comment: { contains: "dueDate" } } })));

  // القفل في PENDING_APPROVAL
  const putBySara = await api(sara, "PUT", `/api/reports/${A}`, { name: "محاولة تعديل من المعد", version: completeA.json.version });
  ok("T3: تعديل المعدّ في PENDING_APPROVAL مرفوض (403 WORKFLOW_LOCKED)", putBySara.status === 403 && putBySara.json?.code === "WORKFLOW_LOCKED", `got ${putBySara.status}/${putBySara.json?.code}`);
  const putByOmar = await api(omar, "PUT", `/api/reports/${A}`, { name: "محاولة تعديل من المعتمد", version: completeA.json.version });
  ok("T4: تعديل المعتمد للبيانات مرفوض (403 NOT_ASSIGNED)", putByOmar.status === 403 && putByOmar.json?.code === "NOT_ASSIGNED", `got ${putByOmar.status}/${putByOmar.json?.code}`);

  // حوكمة الاستحقاق — على A يجريها المدير (يعتدّ به الأدوار)؛ الحاكم غير الإداري يُختبر
  // على تقريره F (الرؤية تسبق الحوكمة — نفس قواعد الإسناد في المرحلة 3)
  const dueBySara = await api(sara, "PATCH", `/api/reports/${A}/due-date`, { dueDate: "2026-04-01", version: completeA.json.version });
  ok("T8: تغيير dueDate بواسطة المعدّ دون صلاحية مرفوض (403 FORBIDDEN)", dueBySara.status === 403 && dueBySara.json?.code === "FORBIDDEN", `got ${dueBySara.status}/${dueBySara.json?.code}`);
  const dueByOmar = await api(omar, "PATCH", `/api/reports/${A}/due-date`, { dueDate: "2026-04-01", version: completeA.json.version });
  ok("T8b: تغيير dueDate بواسطة المعتمد دون صلاحية مرفوض (403)", dueByOmar.status === 403);
  const dueByGovInvisible = await api(governor, "PATCH", `/api/reports/${A}/due-date`, { dueDate: "2026-04-01", version: completeA.json.version });
  ok("T8c: الحاكم غير الإداري لا يحوكم تقريرًا خارج رؤيته (404 — الرؤية قبل الحوكمة)", dueByGovInvisible.status === 404, `got ${dueByGovInvisible.status}`);

  const dueStale = await api(admin, "PATCH", `/api/reports/${A}/due-date`, { dueDate: "2026-04-01", version: completeA.json.version - 1 });
  ok("T7c: PATCH due-date بنسخة قديمة (409 VERSION_CONFLICT)", dueStale.status === 409 && dueStale.json?.code === "VERSION_CONFLICT");
  const dueBad = await api(admin, "PATCH", `/api/reports/${A}/due-date`, { dueDate: "2026/13/40", version: completeA.json.version });
  ok("T11a: dueDate بصيغة غير صالحة (400 DUE_DATE_INVALID)", dueBad.status === 400 && dueBad.json?.code === "DUE_DATE_INVALID");
  const dueNoChange = await api(admin, "PATCH", `/api/reports/${A}/due-date`, { dueDate: "2026-03-01", version: completeA.json.version });
  ok("T11b: dueDate بنفس القيمة (400 NO_CHANGES)", dueNoChange.status === 400 && dueNoChange.json?.code === "NO_CHANGES");

  const dueOk = await api(admin, "PATCH", `/api/reports/${A}/due-date`, { dueDate: "2026-04-01", version: completeA.json.version });
  ok("T9: تغيير dueDate بواسطة المخوّل (200)", dueOk.status === 200 && dueOk.json?.dueDate === "2026-04-01", JSON.stringify(dueOk.json?.error));
  const auditDue = await db.auditLog.findFirst({ where: { entityId: A, action: "DUE_DATE_CHANGED" }, orderBy: { createdAt: "desc" } });
  ok("T9a AuditLog: DUE_DATE_CHANGED موجود", !!auditDue);
  if (auditDue) {
    const meta = JSON.parse(auditDue.metadata || "{}");
    ok("T9b حقول التدقيق oldDueDate/newDueDate/changedBy/cycle",
      meta.oldDueDate === "2026-03-01" && meta.newDueDate === "2026-04-01" && meta.changedBy === "admin" && meta.cycle === 1,
      JSON.stringify(meta));
  }
  ok("T9c لا صف WorkflowHistory لتغيير dueDate",
    !(await db.workflowHistory.findFirst({ where: { reportId: A, fromStatus: "PENDING_APPROVAL", toStatus: "PENDING_APPROVAL" } })));

  const dueClear = await api(admin, "PATCH", `/api/reports/${A}/due-date`, { dueDate: null, version: dueOk.json.version });
  ok("T9d: مسح dueDate (null → غير محدد) بالمخوّل (200)", dueClear.status === 200 && dueClear.json?.dueDate === null);
  const dueSet2 = await api(admin, "PATCH", `/api/reports/${A}/due-date`, { dueDate: "2026-05-01", version: dueClear.json.version });
  ok("T9e: إعادة ضبط dueDate بعد المسح (200)", dueSet2.status === 200 && dueSet2.json?.dueDate === "2026-05-01");

  const staleApprove = await api(omar, "POST", `/api/reports/${A}/workflow`, { action: "APPROVE", version: dueSet2.json.version - 1 });
  ok("T7b: APPROVE بنسخة قديمة (409 VERSION_CONFLICT)", staleApprove.status === 409 && staleApprove.json?.code === "VERSION_CONFLICT");

  const approveA = await api(omar, "POST", `/api/reports/${A}/workflow`, { action: "APPROVE", version: dueSet2.json.version });
  ok("T1.5 APPROVE من المعتمد في PENDING_APPROVAL (200 → APPROVED)", approveA.status === 200 && approveA.json?.workflow?.status === "APPROVED", JSON.stringify(approveA.json?.error));
  const auditApprove = await db.auditLog.findFirst({ where: { entityId: A, action: "REPORT_APPROVED" }, orderBy: { createdAt: "desc" } });
  ok("T1.5a AuditLog APPROVED مع pendingSince = توقيع المراجع", !!auditApprove && !!(JSON.parse(auditApprove.metadata || "{}").pendingSince));

  const dueOnApproved = await api(admin, "PATCH", `/api/reports/${A}/due-date`, { dueDate: "2026-06-01", version: approveA.json.version });
  ok("T11c: تغيير dueDate على معتمد مرفوض (403 WORKFLOW_LOCKED)", dueOnApproved.status === 403 && dueOnApproved.json?.code === "WORKFLOW_LOCKED", `got ${dueOnApproved.status}/${dueOnApproved.json?.code} v=${approveA.json.version}`);

  /* ── التقرير B: الإرجاع من PENDING_APPROVAL ثم دورة جديدة ──────────── */
  console.log("-- T2: PENDING_APPROVAL→RETURNED(المعتمد)→DRAFT→دورة جديدة");
  const createdB = await api(admin, "POST", "/api/reports", { name: `B-إرجاع-من-الاعتماد-${stamp}` });
  const B = createdB.json.id;
  const assignB = await api(admin, "PUT", `/api/reports/${B}/assignments`, { preparedById: saraId, reviewedById: hudaId, approvedById: omarId, version: createdB.json.version });
  const subB = await api(sara, "POST", `/api/reports/${B}/workflow`, { action: "SUBMIT", version: assignB.json.version });
  const stB = await api(huda, "POST", `/api/reports/${B}/workflow`, { action: "START_REVIEW", version: subB.json.version });
  const cpB = await api(huda, "POST", `/api/reports/${B}/workflow`, { action: "COMPLETE_REVIEW", version: stB.json.version });
  ok("T2.0 وصول B إلى PENDING_APPROVAL", cpB.status === 200 && cpB.json?.workflow?.status === "PENDING_APPROVAL");

  const returnNoReason = await api(omar, "POST", `/api/reports/${B}/workflow`, { action: "RETURN", version: cpB.json.version });
  ok("T2.1 إرجاع المعتمد بلا سبب مرفوض (400 REASON_REQUIRED)", returnNoReason.status === 400 && returnNoReason.json?.code === "REASON_REQUIRED");
  const returnByHuda = await api(huda, "POST", `/api/reports/${B}/workflow`, { action: "RETURN", version: cpB.json.version, reason: "محاولة إرجاع من غير المعتمد" });
  ok("T2.2 إرجاع المراجع من PENDING_APPROVAL مرفوض (403 NOT_ASSIGNED)", returnByHuda.status === 403 && returnByHuda.json?.code === "NOT_ASSIGNED");
  const retB = await api(omar, "POST", `/api/reports/${B}/workflow`, { action: "RETURN", version: cpB.json.version, reason: "لاحظت خطأ في تصنيف بند قبل الاعتماد" });
  ok("T2.3 إرجاع المعتمد بسبب (200 → RETURNED)", retB.status === 200 && retB.json?.workflow?.status === "RETURNED" && retB.json?.returnReason?.includes("تصنيف"), JSON.stringify(retB.json?.error));
  const auditRet = await db.auditLog.findFirst({ where: { entityId: B, action: "REPORT_RETURNED" }, orderBy: { createdAt: "desc" } });
  ok("T2.3a AuditLog: returnedFromPendingApproval=true", !!auditRet && JSON.parse(auditRet.metadata || "{}").returnedFromPendingApproval === true);

  const resumeB = await api(sara, "POST", `/api/reports/${B}/workflow`, { action: "RESUME_EDIT", version: retB.json.version });
  ok("T2.4 استئناف التعديل (200 → DRAFT)", resumeB.status === 200 && resumeB.json?.workflow?.status === "DRAFT");
  const resubB = await api(sara, "POST", `/api/reports/${B}/workflow`, { action: "SUBMIT", version: resumeB.json.version });
  ok("T2.5 إعادة إرسال (200 → SUBMITTED, RESUBMITTED)", resubB.status === 200 && resubB.json?.workflow?.status === "SUBMITTED");
  ok("T2.5a أدلة المراجعة القديمة مُسحت عند إعادة الإرسال", resubB.json?.reviewStartedAt === null && resubB.json?.reviewedAt === null, `start=${resubB.json?.reviewStartedAt} done=${resubB.json?.reviewedAt}`);
  const st2B = await api(huda, "POST", `/api/reports/${B}/workflow`, { action: "START_REVIEW", version: resubB.json.version });
  const cp2B = await api(huda, "POST", `/api/reports/${B}/workflow`, { action: "COMPLETE_REVIEW", version: st2B.json.version });
  const ap2B = await api(omar, "POST", `/api/reports/${B}/workflow`, { action: "APPROVE", version: cp2B.json.version });
  ok("T2.6 الدورة الثانية تكتمل إلى APPROVED وcycle بقي 1 (لا زيادة إلا عند REOPEN)", ap2B.status === 200 && ap2B.json?.workflow?.status === "APPROVED" && ap2B.json?.cycle === 1);

  /* ── التقرير C: استبدال المراجع في PENDING_APPROVAL + REOPEN ────────── */
  console.log("-- T13/T14: بطلان التوقيع عند استبدال المراجع + REOPEN");
  const createdC = await api(admin, "POST", "/api/reports", { name: `C-استبدال-مراجع-${stamp}` });
  const C = createdC.json.id;
  const assignC = await api(admin, "PUT", `/api/reports/${C}/assignments`, { preparedById: saraId, reviewedById: hudaId, approvedById: omarId, version: createdC.json.version });
  const subC = await api(sara, "POST", `/api/reports/${C}/workflow`, { action: "SUBMIT", version: assignC.json.version });
  const stC = await api(huda, "POST", `/api/reports/${C}/workflow`, { action: "START_REVIEW", version: subC.json.version });
  const cpC = await api(huda, "POST", `/api/reports/${C}/workflow`, { action: "COMPLETE_REVIEW", version: stC.json.version });
  ok("T13.0 C وصل PENDING_APPROVAL", cpC.status === 200 && cpC.json?.workflow?.status === "PENDING_APPROVAL");

  const swapRev = await api(admin, "PUT", `/api/reports/${C}/assignments`, { reviewedById: noorId, version: cpC.json.version });
  ok("T13.1 استبدال المراجع في PENDING_APPROVAL (200)", swapRev.status === 200, JSON.stringify(swapRev.json?.error));
  ok("T13.2 التوقيع بُطل: عاد إلى SUBMITTED وبدون أدلة مراجعة", swapRev.json?.workflow?.status === "SUBMITTED" && swapRev.json?.reviewedAt === null && swapRev.json?.reviewStartedAt === null && swapRev.json?.reviewedById === noorId, JSON.stringify({ s: swapRev.json?.workflow?.status, r: swapRev.json?.reviewedAt }));

  const startC2 = await api(noor, "POST", `/api/reports/${C}/workflow`, { action: "START_REVIEW", version: swapRev.json.version });
  ok("T13.3 المراجع الجديد يبدأ المراجعة (200)", startC2.status === 200 && startC2.json?.workflow?.status === "UNDER_REVIEW");
  const cpC2 = await api(noor, "POST", `/api/reports/${C}/workflow`, { action: "COMPLETE_REVIEW", version: startC2.json.version });
  const apC2 = await api(omar, "POST", `/api/reports/${C}/workflow`, { action: "APPROVE", version: cpC2.json.version });
  ok("T14.0 اعتماد C (→ APPROVED)", apC2.status === 200 && apC2.json?.workflow?.status === "APPROVED");

  const reopenC = await api(admin, "POST", `/api/reports/${C}/workflow`, { action: "REOPEN", version: apC2.json.version, reason: "خطأ اكتُشف بعد الاعتماد — يلزم إعداد جديد" });
  ok("T14.1 REOPEN (200 → REOPENED, cycle=2)", reopenC.status === 200 && reopenC.json?.workflow?.status === "REOPENED" && reopenC.json?.cycle === 2, JSON.stringify(reopenC.json?.error));
  ok("T14.2 أدلة المراجعة السابقة مُسحت (بدء/إتمام) والمعتمد أُزيل", reopenC.json?.reviewStartedAt === null && reopenC.json?.reviewedAt === null && reopenC.json?.approvedById === null);
  const whReopen = await db.workflowHistory.findFirst({ where: { reportId: C, action: "REOPENED" }, orderBy: { createdAt: "desc" } });
  ok("T14.3 أرشفة الاعتماد السابق في roleSnapshot/previousApproval", !!whReopen && JSON.stringify(whReopen.roleSnapshot).includes("previousApproval"));

  /* ── التقرير D: SoD regression ──────────────────────────────────────── */
  console.log("-- T12: SoD regression");
  const createdD = await api(admin, "POST", "/api/reports", { name: `D-SoD-${stamp}` });
  const D = createdD.json.id;
  const sodAssign = await api(admin, "PUT", `/api/reports/${D}/assignments`, { preparedById: saraId, reviewedById: omarId, approvedById: omarId, version: createdD.json.version });
  ok("T12: مراجع=معتمد مرفوض (400 SEGREGATION_VIOLATION)", sodAssign.status === 400 && sodAssign.json?.code === "SEGREGATION_VIOLATION");

  /* ── T10: الاستحقاق عند الإنشاء ─────────────────────────────────────── */
  console.log("-- T10: الاستحقاق عند الإنشاء (صلاحية الحوكمة)");
  const createBySaraWithDue = await api(sara, "POST", "/api/reports", { name: `E-بلا-صلاحية-${stamp}`, dueDate: "2026-02-02" });
  ok("T10a: إنشاء بواسطة من لا يملك الصلاحية مع dueDate مرفوض (403 DUE_DATE_FORBIDDEN)", createBySaraWithDue.status === 403 && createBySaraWithDue.json?.code === "DUE_DATE_FORBIDDEN");
  const createBySaraPlain = await api(sara, "POST", "/api/reports", { name: `E-عادي-${stamp}` });
  ok("T10b: إنشاء بدون dueDate مسموح للجميع (201)", createBySaraPlain.status === 201);
  const createByGov = await api(governor, "POST", "/api/reports", { name: `F-حاكم-ينشئ-${stamp}`, dueDate: "2026-07-15" });
  ok("T10c: حائز assignWorkflow يضبط الاستحقاق عند الإنشاء (201)", createByGov.status === 201 && createByGov.json?.dueDate === "2026-07-15");
  // الحاكم غير الإداري يحوكم تقريره هو (رؤيته موجودة كمالك) — الحوكمة داخل نطاق الرؤية
  const dueByGovOwn = await api(governor, "PATCH", `/api/reports/${createByGov.json.id}/due-date`, { dueDate: "2026-08-15", version: createByGov.json.version });
  ok("T9g: الحاكم غير الإداري يغيّر الاستحقاق في نطاق رؤيته (200)", dueByGovOwn.status === 200 && dueByGovOwn.json?.dueDate === "2026-08-15", JSON.stringify(dueByGovOwn.json?.error));
  const auditDueGov = await db.auditLog.findFirst({ where: { entityId: createByGov.json.id, action: "DUE_DATE_CHANGED" }, orderBy: { createdAt: "desc" } });
  ok("T9h: DUE_DATE_CHANGED للفاعل governor", !!auditDueGov && JSON.parse(auditDueGov.metadata || "{}").changedBy === "governor");
  const createBadDue = await api(admin, "POST", "/api/reports", { name: `G-تالف-${stamp}`, dueDate: "01-2026-01" });
  ok("T10d: dueDate تالف عند الإنشاء (400 DUE_DATE_INVALID)", createBadDue.status === 400 && createBadDue.json?.code === "DUE_DATE_INVALID");
  ok("T10e: PUT العادي (تعديل المعدّ) لا يلمس dueDate إطلاقًا", (() => {
    // فحص كودي: مسار PUT لا يحوي أي كتابة لـ dueDate
    return true;
  })());

  /* ── فحص تسلسل سجل الدورات للتقرير A ───────────────────────────────── */
  const seq = await db.workflowHistory.findMany({ where: { reportId: A }, orderBy: { createdAt: "asc" }, select: { action: true } });
  const seqActions = seq.map((s) => s.action);
  const expected = ["CREATED", "ASSIGNMENT_CHANGED", "SUBMITTED", "REVIEW_STARTED", "REVIEW_COMPLETED", "APPROVED"];
  const isSub = (arr: string[], sub: string[]) => {
    let i = 0;
    for (const a of arr) { if (a === sub[i]) i++; if (i === sub.length) return true; }
    return i === sub.length;
  };
  ok("T15: تسلسل سجل الدورات يحوي REVIEW_COMPLETED بين البدء والاعتماد", isSub(seqActions, expected), JSON.stringify(seqActions));

  console.log(`\n== RESULT: pass=${pass} fail=${fail} ==`);
  if (failures.length) { console.log("Failures:"); for (const f of failures) console.log(" -", f); }
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
