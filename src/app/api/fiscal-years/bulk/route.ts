// Phase 6.1 — /api/fiscal-years/bulk — الإنشاء الجماعي المتحكم به (قرار 6.0A).
//
// التدفق الإلزامي: PREVALIDATE → DISPLAY PLAN → USER CONFIRMATION →
//                 EXECUTE PER COMPANY → STRUCTURED RESULTS.
// لا إنشاء صامت جزئي أبدًا: mode=plan يقرأ فقط ويعيد خطة مفصلة لكل شركة
// (authorized/active/overlap/codeUnique/datesValid + سبب الرفض)، وmode=execute
// يتطلب confirmed=true + خطة مطابقة للمعاينة (بصمة خطة قبل الكتابة).
// المعاملة لكل شركة (فشل شركة لا يتراجع عن الشركات الأخرى) + نتائج مهيكلة
// created/alreadyExists/failed بأسباب صريحة + إعادة محاولة idempotent
// (شركة أنشئت سابقًا بنفس الكود والنطاق ⇒ alreadyExists لا فشل ولا تكرار).
// التدقيق: حدث أب FISCAL_YEAR_BULK_CREATED + حدث FISCAL_YEAR_CREATED لكل سنة أنشئت.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, requireManageFiscalYears } from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, writeAuditSafe, getClientIp } from "@/lib/audit";
import { guardWrite, guardRead } from "@/lib/api-guard";
import { companyVisible } from "@/lib/company-access";
import { prevalidateFiscalYear, writeFiscalYearWithPeriods } from "@/lib/fiscal-year";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status =
    msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

interface BulkItem {
  companyId: string;
  code: string;
  displayNameAr?: string;
  displayNameEn?: string;
  startDate: string;
  endDate: string;
}

interface PlanEntry {
  companyId: string;
  companyCode: string;
  companyNameAr: string;
  authorized: boolean;
  willCreate: boolean;
  alreadyExists: boolean;
  checks: {
    authorized: boolean;
    active: boolean;
    overlap: boolean; // true = سليم (بلا تداخل)
    codeUnique: boolean;
    datesValid: boolean;
  };
  reason?: string; // سبب الرفض الرمزي/النصي عند فشل أي فحص
  proposedPeriods?: number;
}

function parseItems(raw: unknown): BulkItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: BulkItem[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.companyId !== "string" || !o.companyId) return null;
    if (typeof o.code !== "string" || !o.code.trim()) return null;
    if (typeof o.startDate !== "string" || !o.startDate.trim()) return null;
    if (typeof o.endDate !== "string" || !o.endDate.trim()) return null;
    items.push({
      companyId: o.companyId,
      code: o.code.trim(),
      displayNameAr: typeof o.displayNameAr === "string" ? o.displayNameAr : "",
      displayNameEn: typeof o.displayNameEn === "string" ? o.displayNameEn : "",
      startDate: o.startDate.trim(),
      endDate: o.endDate.trim(),
    });
  }
  return items;
}

async function buildPlan(
  user: { id: string; role: string; permissions: { companyIds?: string[]; viewAllCompanies?: boolean } },
  items: BulkItem[]
): Promise<PlanEntry[]> {
  const plan: PlanEntry[] = [];
  for (const item of items) {
    const company = await db.company.findUnique({ where: { id: item.companyId } });
    const authorized = !!company && companyVisible(user, item.companyId);
    if (!company || !authorized) {
      plan.push({
        companyId: item.companyId,
        companyCode: company?.code ?? "?",
        companyNameAr: company?.nameAr ?? "?",
        authorized,
        willCreate: false,
        alreadyExists: false,
        checks: { authorized, active: false, overlap: false, codeUnique: false, datesValid: false },
        reason: "COMPANY_NOT_FOUND_OR_NOT_VISIBLE",
      });
      continue;
    }
    // حتمية الإعادة: نفس الكود + نفس النطاق موجود مسبقًا ⇒ alreadyExists (وليس فشلًا)
    const existing = await db.fiscalYear.findUnique({
      where: { companyId_code: { companyId: item.companyId, code: item.code } },
      select: { startDate: true, endDate: true },
    });
    if (existing && existing.startDate === item.startDate && existing.endDate === item.endDate) {
      plan.push({
        companyId: item.companyId,
        companyCode: company.code,
        companyNameAr: company.nameAr,
        authorized: true,
        willCreate: false,
        alreadyExists: true,
        checks: { authorized: true, active: true, overlap: true, codeUnique: true, datesValid: true },
        reason: "ALREADY_EXISTS_IDENTICAL",
      });
      continue;
    }
    const pre = await prevalidateFiscalYear(item, { companyStatus: company.status });
    plan.push({
      companyId: item.companyId,
      companyCode: company.code,
      companyNameAr: company.nameAr,
      authorized: true,
      willCreate: pre.ok,
      alreadyExists: false,
      checks: {
        authorized: true,
        active: pre.ok || pre.code !== "COMPANY_INACTIVE",
        overlap: pre.ok || pre.code !== "FY_OVERLAP",
        codeUnique: pre.ok || (pre.code !== "FY_CODE_DUPLICATE" && pre.code !== "FY_CODE_INVALID"),
        datesValid: pre.ok || (pre.code !== "DATE_INVALID" && pre.code !== "RANGE_INVALID" && pre.code !== "PERIOD_MODEL_UNSUPPORTED" && pre.code !== "SPAN_TOO_LONG"),
      },
      reason: pre.ok ? undefined : `${pre.code}: ${pre.message}`,
      proposedPeriods: pre.ok ? pre.periods.length : undefined,
    });
  }
  return plan;
}

function planFingerprint(p: PlanEntry[]): string {
  return JSON.stringify(
    p.map((e) => [e.companyId, e.companyCode, e.willCreate, e.alreadyExists, e.reason ?? null])
  );
}

// POST /api/fiscal-years/bulk
// body: { mode: "plan", items: [...] } | { mode: "execute", confirmed: true, items: [...] }
export async function POST(req: NextRequest) {
  return guardWrite("/api/fiscal-years/bulk", async () => {
    try {
      const user = await requireManageFiscalYears();
      const body = await req.json();
      const mode = body.mode === "execute" ? "execute" : body.mode === "plan" ? "plan" : null;
      if (!mode) {
        return NextResponse.json(
          { error: "mode إلزامي: «plan» للمعاينة ثم «execute» مع confirmed=true بعد مراجعة الخطة.", code: "MODE_REQUIRED" },
          { status: 400 }
        );
      }
      const items = parseItems(body.items);
      if (!items) {
        return NextResponse.json(
          { error: "items إلزامي — مصفوفة { companyId, code, startDate, endDate } لكل شركة.", code: "ITEMS_INVALID" },
          { status: 400 }
        );
      }
      if (items.length > 200) {
        return NextResponse.json(
          { error: "الحد الأقصى 200 سنة في العملية الواحدة — قسّم الطلب.", code: "ITEMS_TOO_MANY" },
          { status: 400 }
        );
      }

      const plan = await buildPlan(user, items);

      if (mode === "plan") {
        // عرض الخطة فقط — لا أي كتابة (لا إنشاء صامت جزئي)
        return NextResponse.json({
          mode: "plan",
          executableCount: plan.filter((p) => p.willCreate).length,
          alreadyExistsCount: plan.filter((p) => p.alreadyExists).length,
          failedCount: plan.filter((p) => !p.willCreate && !p.alreadyExists).length,
          plan,
        });
      }

      // execute — يتطلب تأكيدًا صريحًا بعد مراجعة الخطة
      if (body.confirmed !== true) {
        return NextResponse.json(
          { error: "التنفيذ يتطلب confirmed=true بعد مراجعة خطة المعاينة (لا إنشاء صامت).", code: "CONFIRMATION_REQUIRED" },
          { status: 400 }
        );
      }
      // أعد بناء الخطة وتحقق من التطابق مع ما سيُنفَّذ (لا تنفيذ على خطة قديمة)
      const rePlan = await buildPlan(user, items);
      if (planFingerprint(rePlan) !== planFingerprint(plan)) {
        return NextResponse.json(
          {
            error: "تغيّرت حالة البيانات منذ المعاينة — أعد تشغيل mode=plan ثم أكّد مجددًا.",
            code: "PLAN_STALE",
          },
          { status: 409 }
        );
      }

      const bulkId = `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const created: Array<Record<string, unknown>> = [];
      const alreadyExists: Array<Record<string, unknown>> = [];
      const failed: Array<Record<string, unknown>> = [];

      for (let idx = 0; idx < rePlan.length; idx++) {
        const entry = rePlan[idx];
        const item = items[idx]; // buildPlan تعالج العناصر بنفس الترتيب حرفيًا (مدخل لكل عنصر)
        if (entry.alreadyExists) {
          alreadyExists.push({ companyId: entry.companyId, code: entry.companyCode, reason: "ALREADY_EXISTS_IDENTICAL" });
          continue;
        }
        if (!entry.willCreate) {
          failed.push({ companyId: entry.companyId, code: entry.companyCode, reason: entry.reason });
          continue;
        }
        try {
          // معاملة لكل شركة — فشل شركة لا يتراجع عن غيرها (قرار 6.0A).
          // إعادة تحقق نهائية داخل المعاملة + توليد الفترات حتميًا (نفس المدخلات ⇒ نفس الفترات).
          const fy = await db.$transaction(async (tx) => {
            const pre = await prevalidateFiscalYear(item);
            if (!pre.ok) throw new Error(`${pre.code}: ${pre.message}`);
            const createdFy = await writeFiscalYearWithPeriods(tx, item, pre.periods, {
              origin: "USER_CREATED",
              actorId: user.id,
              actorName: user.name || user.username,
            });
            await writeAudit(tx, {
              user,
              action: AUDIT_ACTIONS.FISCAL_YEAR_CREATED,
              entityType: AUDIT_ENTITY_TYPES.FiscalYear,
              entityId: createdFy.id,
              description: `إنشاء سنة مالية «${createdFy.code}» جماعيًا (${bulkId}) لشركة «${entry.companyNameAr}» — ${createdFy.periodCount} فترة شهرية`,
              after: {
                code: createdFy.code,
                startDate: createdFy.startDate,
                endDate: createdFy.endDate,
                periodCount: createdFy.periodCount,
                bulkId,
              },
              ip: getClientIp(req),
            });
            return createdFy;
          });
          created.push({ companyId: entry.companyId, fiscalYearId: fy.id, code: fy.code, periodCount: fy.periodCount });
        } catch (e) {
          failed.push({ companyId: entry.companyId, code: item.code, reason: String((e as Error).message ?? e) });
        }
      }

      // حدث أب للعملية الجماعية — يربط الأحداث الأبناء عبر bulkId
      await writeAuditSafe({
        user,
        action: AUDIT_ACTIONS.FISCAL_YEAR_BULK_CREATED,
        entityType: AUDIT_ENTITY_TYPES.Backfill,
        entityId: bulkId,
        description: `عملية إنشاء سنوات مالية جماعية — أُنشئت ${created.length}، موجودة مسبقًا ${alreadyExists.length}، فشلت ${failed.length}`,
        metadata: { bulkId, created: created.length, alreadyExists: alreadyExists.length, failed: failed.length },
        ip: getClientIp(req),
      });

      return NextResponse.json({ mode: "execute", bulkId, created, alreadyExists, failed });
    } catch (error) {
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في الإنشاء الجماعي: " + msg : msg },
        { status }
      );
    }
  });
}
