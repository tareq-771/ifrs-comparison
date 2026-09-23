// Phase 6.2A — PATCH/DELETE /api/account-nature/overrides/[id]
// optimistic locking (version) + تدقيق before/after/reason — نفس عقود 6.1.

import { NextRequest, NextResponse } from "next/server";
import { requireManageAccountNature } from "@/lib/session";
import { guardWrite } from "@/lib/api-guard";
import { getClientIp } from "@/lib/audit";
import { AccountNatureError } from "@/lib/account-nature";
import {
  deleteMappingOverride,
  updateMappingOverride,
} from "@/lib/account-nature-server";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof AccountNatureError) {
    const status =
      error.code === "VERSION_CONFLICT" ? 409
      : error.code === "RULE_NOT_FOUND" || error.code === "OVERRIDE_NOT_FOUND" ? 403
      : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return NextResponse.json({ error: status === 500 ? `${fallback}: ${msg}` : msg }, { status });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/account-nature/overrides/[id]", async () => {
    try {
      const user = await requireManageAccountNature();
      const { id } = await ctx.params;
      const body = await req.json().catch(() => ({}));
      const updated = await updateMappingOverride({ user, ip: getClientIp(req), id, input: body });
      return NextResponse.json(updated);
    } catch (error) {
      return errorResponse(error, "فشل في تعديل استثناء الحساب");
    }
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guardWrite("/api/account-nature/overrides/[id]", async () => {
    try {
      const user = await requireManageAccountNature();
      const { id } = await ctx.params;
      const body = await req.json().catch(() => ({}));
      const deleted = await deleteMappingOverride({ user, ip: getClientIp(req), id, input: body });
      return NextResponse.json(deleted);
    } catch (error) {
      return errorResponse(error, "فشل في حذف استثناء الحساب");
    }
  });
}
