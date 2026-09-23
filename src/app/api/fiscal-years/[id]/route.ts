// Phase 6.1 — /api/fiscal-years/[id] — قراءة سنة بفتراتها + انتقالات الحالة.
//
// الانتقالات (خادمي التحقق حصرًا — FISCAL_YEAR_TRANSITIONS):
//   close (OPEN→CLOSED): manageFiscalYears
//   lock (CLOSED→LOCKED): lockFiscalYears
//   unlock (LOCKED→CLOSED): lockFiscalYears + سبب إلزامي + حدث تدقيق
//   reopen (CLOSED→OPEN): reopenFiscalYears + سبب إلزامي + حدث تدقيق
//   confirm-provisional (PROVISIONAL_IMPORTED→USER_CREATED): manageFiscalYears
// لا حسابات إقفال مالية في 6.1 — الحالة إدارية فقط (طبقة القوائم في 6.2).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  requireAuth,
  requireManageFiscalYears,
} from "@/lib/session";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAudit, getClientIp } from "@/lib/audit";
import { guardWrite, guardRead } from "@/lib/api-guard";
import {
  assertFiscalYearVisible,
  FISCAL_YEAR_STATUS,
  FISCAL_YEAR_TRANSITIONS,
  FISCAL_YEAR_ORIGIN,
  isFiscalYearStatus,
  FiscalYearError,
  type FiscalYearStatus,
} from "@/lib/fiscal-year";
import { canLockFiscalYears, canReopenFiscalYears } from "@/lib/permissions";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status =
    msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

// GET /api/fiscal-years/[id] — السنة + فتراتها (الرؤية عبر الشركة — fail-closed)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return guardRead("/api/fiscal-years/[id]", async () => {
    try {
      const user = await requireAuth();
      const { id } = await params;
      const fy = await assertFiscalYearVisible(id, user);
      const periods = await db.fiscalPeriod.findMany({
        where: { fiscalYearId: fy.id },
        orderBy: { ordinal: "asc" },
      });
      return NextResponse.json({ ...fy, periods });
    } catch (error) {
      if (error instanceof FiscalYearError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.code === "FY_NOT_FOUND" ? 404 : 403 }
        );
      }
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في جلب السنة المالية: " + msg : msg },
        { status }
      );
    }
  });
}

// PATCH /api/fiscal-years/[id] — انتقال حالة / تأكيد حاوية مؤقتة
// body: { action: "close" | "lock" | "unlock" | "reopen" | "confirm-provisional", reason?: string }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return guardWrite("/api/fiscal-years/[id]", async () => {
    try {
      const user = await requireAuth();
      const { id } = await params;
      const fy = await assertFiscalYearVisible(id, user);
      const body = await req.json();
      const action = typeof body.action === "string" ? body.action : "";
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      const actorName = user.name || user.username;
      const ip = getClientIp(req);

      if (action === "confirm-provisional") {
        // تأكيد حاوية مؤقتة (من أداة الربط) — قرار مدير يحمّلها كموثقة
        const gate = await requireManageFiscalYears();
        if (fy.origin !== FISCAL_YEAR_ORIGIN.PROVISIONAL_IMPORTED) {
          return NextResponse.json(
            { error: "هذه السنة ليست حاوية مؤقتة.", code: "NOT_PROVISIONAL" },
            { status: 400 }
          );
        }
        const updated = await db.$transaction(async (tx) => {
          const u = await tx.fiscalYear.update({
            where: { id: fy.id },
            data: {
              origin: FISCAL_YEAR_ORIGIN.USER_CREATED,
              confirmedAt: new Date(),
              confirmedByName: gate.name || gate.username,
            },
          });
          await writeAudit(tx, {
            user: gate,
            action: AUDIT_ACTIONS.FISCAL_YEAR_PROVISIONAL_CONFIRMED,
            entityType: AUDIT_ENTITY_TYPES.FiscalYear,
            entityId: fy.id,
            description: `تأكيد حاوية سنة مؤقتة «${fy.code}» (شركة: ${fy.companyId}) — أُقرت كسنة موثقة`,
            before: { origin: fy.origin },
            after: { origin: u.origin },
            ip,
          });
          return u;
        });
        return NextResponse.json(updated);
      }

      if (action !== "close" && action !== "lock" && action !== "unlock" && action !== "reopen") {
        return NextResponse.json(
          { error: "action غير معروف — close | lock | unlock | reopen | confirm-provisional.", code: "ACTION_UNKNOWN" },
          { status: 400 }
        );
      }

      // بوابة الصلاحية لكل فعل (المدير ضمنيًا بالدور — قاعدة موثقة في permissions.ts)
      if (action === "close") await requireManageFiscalYears();
      if (action === "lock" || action === "unlock") {
        if (!canLockFiscalYears(user.permissions, user.role)) throw new Error("Forbidden");
      }
      if (action === "reopen") {
        if (!canReopenFiscalYears(user.permissions, user.role)) throw new Error("Forbidden");
      }

      // خريطة الفعل → الحالة الهدف
      const target: Record<string, FiscalYearStatus> = {
        close: FISCAL_YEAR_STATUS.CLOSED,
        lock: FISCAL_YEAR_STATUS.LOCKED,
        unlock: FISCAL_YEAR_STATUS.CLOSED,
        reopen: FISCAL_YEAR_STATUS.OPEN,
      };
      const to = target[action];
      const current = fy.status as FiscalYearStatus;
      if (!isFiscalYearStatus(current)) {
        return NextResponse.json(
          { error: `حالة سنة غير معروفة في القاعدة: ${fy.status}`, code: "FY_STATUS_CORRUPT" },
          { status: 500 }
        );
      }
      if (!FISCAL_YEAR_TRANSITIONS[current].includes(to)) {
        return NextResponse.json(
          {
            error: `انتقال حالة غير مسموح: ${current} → ${to} (المسموح من ${current}: ${FISCAL_YEAR_TRANSITIONS[current].join(", ") || "لا شيء"}).`,
            code: "FY_TRANSITION_INVALID",
          },
          { status: 409 }
        );
      }
      // سبب إلزامي لإعادة الفتح وفك القفل (قرار 6.1 §7)
      if ((action === "reopen" || action === "unlock") && reason.length < 3) {
        return NextResponse.json(
          {
            error: "سبب إلزامي (3 أحرف فأكثر) لإعادة الفتح أو فك القفل — يُسجل في التدقيق.",
            code: "REASON_REQUIRED",
          },
          { status: 400 }
        );
      }

      const data: Record<string, unknown> = { status: to };
      const now = new Date();
      if (action === "close") {
        data.closedById = user.id;
        data.closedByName = actorName;
        data.closedAt = now;
      } else if (action === "lock") {
        data.lockedById = user.id;
        data.lockedByName = actorName;
        data.lockedAt = now;
      } else if (action === "reopen") {
        data.reopenedById = user.id;
        data.reopenedByName = actorName;
        data.reopenedAt = now;
        data.reopenReason = reason.slice(0, 2000);
      } else if (action === "unlock") {
        data.unlockReason = reason.slice(0, 2000);
      }

      const updated = await db.$transaction(async (tx) => {
        const u = await tx.fiscalYear.update({ where: { id: fy.id }, data });
        await writeAudit(tx, {
          user,
          action:
            action === "close"
              ? AUDIT_ACTIONS.FISCAL_YEAR_CLOSED
              : action === "lock"
                ? AUDIT_ACTIONS.FISCAL_YEAR_LOCKED
                : action === "unlock"
                  ? AUDIT_ACTIONS.FISCAL_YEAR_UNLOCKED
                  : AUDIT_ACTIONS.FISCAL_YEAR_REOPENED,
          entityType: AUDIT_ENTITY_TYPES.FiscalYear,
          entityId: fy.id,
          description: `${
            action === "close"
              ? "إغلاق"
              : action === "lock"
                ? "قفل"
                : action === "unlock"
                  ? "فك قفل"
                  : "إعادة فتح"
          } سنة مالية «${fy.code}» — ${current} → ${to}${reason ? ` — السبب: ${reason}` : ""}`,
          before: { status: current },
          after: { status: to },
          metadata: { ...(reason ? { reason } : {}), companyId: fy.companyId },
          ip,
        });
        return u;
      });
      return NextResponse.json(updated);
    } catch (error) {
      if (error instanceof FiscalYearError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.code === "FY_NOT_FOUND" ? 404 : 403 }
        );
      }
      const { status, msg } = authError(error);
      return NextResponse.json(
        { error: status === 500 ? "فشل في انتقال حالة السنة المالية: " + msg : msg },
        { status }
      );
    }
  });
}
