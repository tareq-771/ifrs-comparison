// Phase 4B.2 — اختبار الاستعادة الإنتاجية الكامل (Full Production Recovery Test).
//
// يعمل على قاعدة التشغيل الحقيقية عبر API/محرك الاستعادة الحقيقي حصرًا —
// ممنوع أي استبدال يدوي لملفات DB (نص قرار المستخدم). مسار كل شيء: HTTP على
// المنفذ 3000 (نفس الخادم الذي يستخدمه المستخدم عبر Preview).
//
// التسلسل الإلزامي (نص الموافقة):
//   1  سلامة الحالة الأساسية + Safety Backup إضافية (RESTORE_VERIFIED)
//   2  Dataset A → Backup A → RESTORE_VERIFIED
//   3  تعديل البيانات شرعيًا إلى Dataset B → Backup B → RESTORE_VERIFIED
//   4  حفظ جلسة JWT من حالة B
//   5  Restore A عبر المسار الحقيقي (بالتأكيدات الخادمية)
//   6  إثبات أن الإنتاج أصبح A فعلًا
//   7  إثبات موت جلسة B القديمة (Session Epoch)
//   8  إثبات بقاء External Recovery Log كاملًا رغم رجوع DB تاريخيًا
//   9  إثبات العودة إلى NORMAL
//  10  Restore B عبر نفس الآلية → إثبات العودة إلى B
//  11  تنظيف شرعي لبيانات الاختبار عبر API
//  12  integrity_check + تحقق نهائي
//
// الأدلة المجمعة: طوابع زمنية، operationIds، قيم epoch قبل/بعد، counts،
// معرفات نسخ الأمان pre-restore، وأحداث السجل الخارجي لكل عملية.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASE = "http://127.0.0.1:3000";
const ROOT = process.cwd();
const EPOCH_FILE = path.join(ROOT, "var", "auth", "session-epoch");
const OUT = path.join(ROOT, "var", "test", "4b2");

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
let failure = false;

function line(name: string, ok: boolean, detail = ""): boolean {
  results.push({ name, ok, detail });
  if (!ok) failure = true;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function readEpoch(): string {
  try {
    return readFileSync(EPOCH_FILE, "utf8").trim();
  } catch {
    return "(غير قابل للقراءة)";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
    return !!(await whoami())?.id;
  }
  async function whoami(): Promise<{ id?: string; username?: string } | null> {
    const res = await fetch(`${BASE}/api/auth/session`, { headers: { Cookie: cookieHeader() }, cache: "no-store" });
    await capture(res);
    if (!res.ok) return null;
    const j = (await res.json()) as { user?: { id?: string; username?: string } };
    return j?.user ?? null;
  }
  async function api<T = unknown>(p: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${p}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookieHeader(), ...(init?.headers ?? {}) },
    });
    await capture(res);
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
  }
  return { login, whoami, api, cookieHeader };
}
type Session = ReturnType<typeof makeSession>;

interface StatusPayload {
  maintenance: { active: boolean; state: string; operationId: string | null };
  epoch: { available: boolean };
  restoreEngineEnabled: boolean;
}

interface RestoreBody {
  result?: string;
  operationId?: string;
  code?: string;
  error?: string;
  abortReason?: string;
  epochBumped?: boolean;
  newEpoch?: number | null;
  preRestoreBackupId?: string | null;
  durationMs?: number;
  [key: string]: unknown;
}

async function createBackupAndDrill(s: Session, label: string): Promise<string> {
  let bk = await s.api<{ backupId?: string; level?: string; retryAfterMs?: number; error?: string }>("/api/backups", { method: "POST" });
  while (bk.status === 429) {
    const wait = Math.min(Number(bk.body.retryAfterMs ?? 60_000) + 500, 65_000);
    console.log(`   ⏳ تهدئة النسخ (${(wait / 1000).toFixed(0)}s)…`);
    await sleep(wait);
    bk = await s.api<{ backupId?: string; retryAfterMs?: number }>("/api/backups", { method: "POST" });
  }
  if (bk.status !== 201 || !bk.body.backupId) throw new Error(`فشل إنشاء ${label}: ${JSON.stringify(bk.body)}`);
  const drill = await s.api<{ level?: string; error?: string }>(`/api/backups/${bk.body.backupId}/drill`, { method: "POST" });
  if (drill.status !== 200 || drill.body.level !== "RESTORE_VERIFIED") {
    throw new Error(`فشل Drill ${label}: ${JSON.stringify(drill.body)}`);
  }
  return bk.body.backupId;
}

async function restoreViaApi(s: Session, backupId: string, downgradeConfirmation?: string): Promise<{ status: number; body: RestoreBody }> {
  const res = await fetch(`${BASE}/api/backups/${backupId}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: s.cookieHeader() },
    body: JSON.stringify({ confirmationText: "RESTORE", ...(downgradeConfirmation ? { downgradeConfirmation } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as RestoreBody;
  return { status: res.status, body };
}

interface PreviewBody {
  downgradeRequired?: boolean;
  requiredConfirmations?: { secondary: string | null };
  error?: { code: string; message: string } | null;
}

/** مثل الواجهة تمامًا: تُشتق حاجة التأكيد الثاني من المعاينة ثم تُرسل من الاستدعاء الأول. */
async function restoreSmart(s: Session, backupId: string): Promise<{ status: number; body: RestoreBody; usedSecondary: boolean }> {
  const prev = await s.api<PreviewBody>(`/api/backups/${backupId}/restore-preview`);
  const needSecondary =
    prev.status === 200 && !!prev.body?.downgradeRequired && prev.body?.requiredConfirmations?.secondary === backupId;
  let out = await restoreViaApi(s, backupId, needSecondary ? backupId : undefined);
  // شبكة أمان: ABORTED بسبب التأكيد الثاني ⇒ إعادة بالتأكيد (الخادم يتحقق بنفسه دائمًا)
  if (out.body.result === "ABORTED" && String(out.body.abortReason ?? "").includes("تأكيد ثانٍ")) {
    out = await restoreViaApi(s, backupId, backupId);
    return { ...out, usedSecondary: true };
  }
  return { ...out, usedSecondary: needSecondary };
}

async function ensureLogin(s: Session, u: string, p: string): Promise<void> {
  if ((await s.whoami())?.id) return;
  if (!(await s.login(u, p))) throw new Error("فشل إعادة الدخول بعد epoch+1");
}

async function reportNames(s: Session): Promise<string[]> {
  const r = await s.api<Array<{ name: string }> | { error?: string }>("/api/reports");
  if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`قراءة التقارير فشلت: ${r.status}`);
  return (r.body as Array<{ name: string }>).map((x) => x.name);
}

async function integrityCheck(): Promise<string> {
  const res = spawnSync(
    "bun",
    ["-e", `const {PrismaClient}=require('@prisma/client');const p=new PrismaClient({datasources:{db:{url:'file:'+process.cwd()+'/db/custom.db'}},log:[]});p.$queryRawUnsafe('PRAGMA integrity_check').then(r=>{console.log(r[0].integrity_check);return p.$disconnect();})`],
    { encoding: "utf8", timeout: 60_000 }
  );
  return (res.stdout ?? "").trim();
}

async function main(): Promise<void> {
  const T0 = new Date();
  console.log(`=== Phase 4B.2 — اختبار الاستعادة الإنتاجية الكامل (A/B عبر API الحقيقي) ===`);
  console.log(`البداية: ${T0.toISOString()} · epoch الحالي: ${readEpoch()}\n`);

  const s = makeSession();

  // ── 0) الحالة الأساسية ─────────────────────────────────────────────────
  const st0 = (await s.api<StatusPayload>("/api/system/status")).body;
  line(
    "0أ) الحالة الأساسية NORMAL + epoch متاح + المحرك مفعّل (4B.2)",
    st0.maintenance.state === "NORMAL" && st0.epoch.available && st0.restoreEngineEnabled,
    `state=${st0.maintenance.state} engine=${st0.restoreEngineEnabled}`
  );
  const integ0 = await integrityCheck();
  line("0ب) integrity_check على قاعدة التشغيل قبل البدء", integ0 === "ok", integ0);
  const epoch0 = readEpoch();

  if (!(await s.login("admin", "admin123"))) throw new Error("فشل دخول المدير على الإنتاج");
  line("0ج) دخول المدير (JWT يحمل epoch)", true);

  // ── 1) Safety Backup إضافية ────────────────────────────────────────────
  const safetyId = await createBackupAndDrill(s, "Safety Backup");
  line("1) Safety Backup إضافية — RESTORE_VERIFIED", true, safetyId);

  // ── 2) Dataset A + Backup A ────────────────────────────────────────────
  const TAG_A = "4B2-DatasetA";
  const TAG_B = "4B2-DatasetB";
  const grpA = await s.api<{ id?: string; error?: string }>("/api/groups", { method: "POST", body: JSON.stringify({ name: `مجموعة ${TAG_A}` }) });
  if (grpA.status !== 201) throw new Error(`فشل مجموعة A: ${JSON.stringify(grpA.body)}`);
  const repA = await s.api<{ id?: string; version?: number; error?: string }>("/api/reports", {
    method: "POST",
    body: JSON.stringify({ name: `تقرير ${TAG_A} رقم 1`, label1: TAG_A, label2: "A1", groupId: grpA.body!.id, periodEnd: "2026-09-30" }),
  });
  if (repA.status !== 201) throw new Error(`فشل تقرير A: ${JSON.stringify(repA.body)}`);
  line("2أ) Dataset A مُنشأ عبر API (مجموعة + تقرير موسوم)", true, `group=${grpA.body!.id} report=${repA.body!.id}`);
  const backupA = await createBackupAndDrill(s, "Backup A");
  line("2ب) Backup A — RESTORE_VERIFIED", true, backupA);

  // ── 3) التحول شرعيًا إلى Dataset B + Backup B ─────────────────────────
  const delA1 = await s.api(`/api/reports/${repA.body!.id}`, { method: "DELETE" });
  const delA2 = await s.api(`/api/groups/${grpA.body!.id}`, { method: "DELETE" });
  if (![delA1.status, delA2.status].every((x) => x === 200 || x === 204)) throw new Error("فشل حذف Dataset A");
  const grpB = await s.api<{ id?: string }>("/api/groups", { method: "POST", body: JSON.stringify({ name: `مجموعة ${TAG_B}` }) });
  if (grpB.status !== 201) throw new Error(`فشل مجموعة B: ${JSON.stringify(grpB.body)}`);
  const repB1 = await s.api<{ id?: string }>("/api/reports", {
    method: "POST",
    body: JSON.stringify({ name: `تقرير ${TAG_B} رقم 1`, label1: TAG_B, label2: "B1", groupId: grpB.body!.id, periodEnd: "2026-09-30" }),
  });
  const repB2 = await s.api<{ id?: string }>("/api/reports", {
    method: "POST",
    body: JSON.stringify({ name: `تقرير ${TAG_B} رقم 2`, label1: TAG_B, label2: "B2", groupId: grpB.body!.id, periodEnd: "2026-09-30" }),
  });
  if (repB1.status !== 201 || repB2.status !== 201) throw new Error("فشل إنشاء تقارير B");
  const namesBefore = await reportNames(s);
  line("3أ) Dataset B (حذف A شرعيًا + تقريران موسومان B)", namesBefore.length === 2 && namesBefore.every((n) => n.includes(TAG_B)), namesBefore.join(" · "));
  const backupB = await createBackupAndDrill(s, "Backup B");
  line("3ب) Backup B — RESTORE_VERIFIED", true, backupB);

  // ── 4) جلسة JWT من حالة B ─────────────────────────────────────────────
  const sessionB = makeSession();
  const bLogin = await sessionB.login("admin", "admin123");
  line("4) جلسة JWT مستقلة محفوظة من حالة B", bLogin && !!(await sessionB.whoami())?.id);

  // ── 5) Restore A عبر المسار الحقيقي ───────────────────────────────────
  const tRestoreA = new Date().toISOString();
  const rA = await restoreSmart(s, backupA);
  const outA = rA;
  if (rA.usedSecondary) console.log("   ⏳ أُرسل التأكيد الثاني (مشتق من المعاينة — تحقق خادمي)");
  line(
    "5) Restore A عبر محرك الاستعادة الحقيقي — COMPLETED",
    outA.status === 200 && outA.body.result === "COMPLETED",
    `op=${outA.body.operationId} · pre=${outA.body.preRestoreBackupId} · ${((outA.body.durationMs ?? 0) / 1000).toFixed(1)}s${outA.body.result !== "COMPLETED" ? ` · result=${outA.body.result} · ${String(outA.body.abortReason ?? "").slice(0, 60)}` : ""}`
  );

  // ── 6) الإنتاج أصبح A فعلًا ───────────────────────────────────────────
  await ensureLogin(s, "admin", "admin123");
  const namesAfterA = await reportNames(s);
  line("6أ) الإنتاج = Dataset A حرفيًا (تقرير واحد موسوم A)", namesAfterA.length === 1 && namesAfterA[0].includes(TAG_A), namesAfterA.join(" · "));
  const prevA = (await s.api<{ current?: { counts?: Record<string, number> } | null }>(`/api/backups/${backupA}/restore-preview`)).body;
  const countsNow = (await s.api<Record<string, unknown>>("/api/dashboard/summary")).status === 200;
  line("6ب) قراءات الإنتاج تعمل بعد التبديل (Dashboard 200)", countsNow && !!prevA);
  const stA = (await s.api<StatusPayload>("/api/system/status")).body;
  line("6ج) الخروج الطبيعي من الصيانة إلى NORMAL بعد Restore A", stA.maintenance.state === "NORMAL", `state=${stA.maintenance.state}`);

  // ── 7) موت جلسة B القديمة (Session Epoch) ─────────────────────────────
  const oldWho = await sessionB.whoami();
  const epochAfterA = readEpoch();
  line(
    "7أ) جلسة JWT القديمة (من حالة B) ماتت بعد الاستعادة",
    !oldWho?.id,
    oldWho?.id ? "ما زالت حية!" : `epoch ${epoch0} → ${epochAfterA}`
  );
  line("7ب) epoch ارتفع فعليًا (+1 بعد Restore A)", Number(epochAfterA) === Number(epoch0) + 1, `${epoch0} → ${epochAfterA}`);
  await ensureLogin(s, "admin", "admin123");
  line("7ج) الدخول الجديد يعمل بعد epoch+1", !!(await s.whoami())?.id);

  // ── 8) السجل الخارجي احتفظ بكامل العملية ──────────────────────────────
  const logRes = await s.api<{ events: Array<{ operationId: string; event: string; timestamp: string; backupId: string | null }> }>("/api/backups/recovery-log?limit=200");
  const log = logRes.body?.events ?? [];
  if (!Array.isArray(log) || log.length === 0) throw new Error("قراءة السجل الخارجي عبر API فشلت");
  const opA = String(outA.body.operationId ?? "");
  const eventsA = log.filter((e) => e.operationId === opA).map((e) => e.event);
  const seqA = [
    "RESTORE_STARTED", "MAINTENANCE_ENTERED", "CANDIDATE_VERIFIED", "PRE_RESTORE_STARTED", "PRE_RESTORE_VERIFIED",
    "DRAIN_COMPLETED", "DB_DISCONNECTED", "SWAP_STARTED", "SWAP_COMPLETED", "POST_VERIFY_STARTED", "RESTORE_COMPLETED",
  ];
  line(
    "8أ) السجل الخارجي (خارج DB المستبدلة) يحمل التسلسل الحرفي الكامل لعملية Restore A",
    seqA.every((e) => eventsA.includes(e)),
    `${eventsA.length} حدثًا · op=${opA}`
  );
  const safetyEvents = log.filter((e) => e.backupId === safetyId).length;
  line("8ب) أحداث Safety Backup ونسختي A/B باقية في السجل", safetyEvents > 0 && log.some((e) => e.backupId === backupA) && log.some((e) => e.backupId === backupB), `safety=${safetyEvents} حدثًا`);

  // ── 9) العودة إلى NORMAL موثقة أعلاه (6ج) — إثبات إضافي بالقراءة ────────
  line("9) النظام في NORMAL بعد استعادة A (قراءة ثانية)", (await s.api<StatusPayload>("/api/system/status")).body.maintenance.state === "NORMAL");

  // ── 10) Restore B عبر نفس الآلية → العودة إلى B ───────────────────────
  const tRestoreB = new Date().toISOString();
  const rB = await restoreSmart(s, backupB);
  const outB = rB;
  if (rB.usedSecondary) console.log("   ⏳ أُرسل التأكيد الثاني (مشتق من المعاينة — تحقق خادمي)");
  line(
    "10أ) Restore B عبر المحرك نفسه — COMPLETED",
    outB.status === 200 && outB.body.result === "COMPLETED",
    `op=${outB.body.operationId} · pre=${outB.body.preRestoreBackupId}${outB.body.result !== "COMPLETED" ? ` · result=${outB.body.result} · ${String(outB.body.abortReason ?? "").slice(0, 60)}` : ""}`
  );
  await ensureLogin(s, "admin", "admin123");
  const namesAfterB = await reportNames(s);
  line("10ب) الإنتاج عاد إلى Dataset B حرفيًا (تقريران موسومان B)", namesAfterB.length === 2 && namesAfterB.every((n) => n.includes(TAG_B)), namesAfterB.join(" · "));
  const epochAfterB = readEpoch();
  line("10ج) epoch ارتفع مجددًا (+1 بعد Restore B)", Number(epochAfterB) === Number(epochAfterA) + 1, `${epochAfterA} → ${epochAfterB}`);
  const stB = (await s.api<StatusPayload>("/api/system/status")).body;
  line("10د) NORMAL بعد Restore B", stB.maintenance.state === "NORMAL", `state=${stB.maintenance.state}`);
  const opB = String(outB.body.operationId ?? "");
  const eventsB = log.filter((e) => e.operationId === opB).map((e) => e.event);
  const log2 = await s.api<{ events: Array<{ operationId: string; event: string }> }>("/api/backups/recovery-log?limit=200");
  const eventsB2 = (log2.body?.events ?? []).filter((e) => e.operationId === opB).map((e) => e.event);
  line(
    "10هـ) أحداث Restore B موثقة في السجل الخارجي (بما فيها PRE_RESTORE الجديد)",
    eventsB2.includes("RESTORE_STARTED") && eventsB2.includes("RESTORE_COMPLETED") && eventsB2.includes("PRE_RESTORE_VERIFIED"),
    `${eventsB2.length} حدثًا · op=${opB}`
  );
  void eventsB;

  // ── 11) التنظيف الشرعي لبيانات الاختبار ───────────────────────────────
  for (const id of [repB1.body!.id!, repB2.body!.id!]) {
    const d = await s.api(`/api/reports/${id}`, { method: "DELETE" });
    if (![d.status].every((x) => x === 200 || x === 204)) throw new Error(`فشل حذف تقرير ${id}`);
  }
  const dG = await s.api(`/api/groups/${grpB.body!.id}`, { method: "DELETE" });
  if (![dG.status].every((x) => x === 200 || x === 204)) throw new Error("فشل حذف مجموعة B");
  const namesClean = await reportNames(s);
  line("11) تنظيف شرعي عبر API (حذف تقارير ومجموعة B)", namesClean.length === 0, namesClean.join(" · ") || "صفر تقارير — كما كانت قبل الاختبار");

  // ── 12) التحقق النهائي ────────────────────────────────────────────────
  const integF = await integrityCheck();
  line("12أ) integrity_check نهائي على قاعدة التشغيل", integF === "ok", integF);
  const stF = (await s.api<StatusPayload>("/api/system/status")).body;
  line("12ب) الحالة النهائية NORMAL + epoch متاح", stF.maintenance.state === "NORMAL" && stF.epoch.available, `epoch=${readEpoch()}`);

  // ── الأدلة ────────────────────────────────────────────────────────────
  const evidence = {
    run: "phase4b2-full-production-recovery-test",
    startedAt: T0.toISOString(),
    finishedAt: new Date().toISOString(),
    epochBefore: epoch0,
    epochAfterRestoreA: epochAfterA,
    epochAfterRestoreB: epochAfterB,
    safetyBackupId: safetyId,
    backupA,
    backupB,
    restoreA: {
      operationId: opA,
      preRestoreBackupId: outA.body.preRestoreBackupId,
      result: outA.body.result,
      abortReason: outA.body.abortReason ?? null,
      usedSecondary: rA.usedSecondary,
      httpAt: tRestoreA,
      durationMs: outA.body.durationMs,
      events: eventsA,
    },
    restoreB: {
      operationId: opB,
      preRestoreBackupId: outB.body.preRestoreBackupId,
      result: outB.body.result,
      abortReason: outB.body.abortReason ?? null,
      usedSecondary: rB.usedSecondary,
      httpAt: tRestoreB,
      durationMs: outB.body.durationMs,
      events: eventsB2,
    },
    finalIntegrity: integF,
    results,
  };
  if (!existsSync(OUT)) await import("node:fs").then((fs) => fs.mkdirSync(OUT, { recursive: true }));
  const evidencePath = path.join(OUT, `evidence-${T0.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "")}.json`);
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== النتيجة: ${passed}/${results.length} ناجحًا ===`);
  console.log(`الأدلة: ${path.relative(ROOT, evidencePath)}`);
  process.exit(failure ? 1 : 0);
}

main().catch((e) => {
  console.error("❌ فشل غير متوقع:", e);
  process.exit(1);
});
