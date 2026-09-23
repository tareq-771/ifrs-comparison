// Phase 6.2A — PATCH /api/account-nature/rules/[id] (تعديل بادئة شركة تفصيلية)
//               DELETE /api/account-nature/rules/[id] (حذف — version-guarded)
//
// الجذور النظامية 1/2/3/4 مرفوضة هنا نهائيًا (SYSTEM_IMMUTABLE — للقراءة فقط).
// النمط: optimistic locking (version إلزامي في الجسم) + تدقيق before/after/reason
// عبر writeAudit داخل نفس المعاملة — نفس عقود 6.1 حرفيًا.

import { NextRequest, NextResponse } from "next/server";
import { requireManageAccountNature } from "@/lib/session";
import { guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { AccountNatureError } from "@/lib/account-nature";
import {
  deleteNatureRule,
  updateNatureRule,
} from "@/lib/account-nature-server";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof AccountNatureError) {
    const status =
      error.code === "VERSION_CONFLICT" ? 409
      : error.code === "RULE_NOT_FOUND" || error.code === "SYSTEM_IMMUTABLE" ? 403
      : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return NextResponse.json({ error: status === 500 ? `${fallback}: ${msg}` : msg }, { status });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/account-nature/rules/[id]", async () => {
    try {
      const user = await requireManageAccountNature();
      const { id } = await ctx.params;
      const body = await req.json().catch(() => ({}));
      const updated = await updateNatureRule({
        user,
        ip: getClientIp(req),
        id,
        input: body,
      });
      return NextResponse.json(updated);
    } catch (error) {
      return errorResponse(error, "فشل في تعديل بادئة الشركة");
    }
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/account-nature/rules/[id]", async () => {
    try {
      const user = await requireManageAccountNature();
      const { id } = await ctx.params;
      const body = await req.json().catch(() => ({}));
      const deleted = await deleteNatureRule({
        user,
        ip: getClientIp(req),
        id,
        input: body,
      });
      return NextResponse.json(deleted);
    } catch (error) {
      return errorResponse(error, "فشل في حذف بادئة الشركة");
    }
  });
}
