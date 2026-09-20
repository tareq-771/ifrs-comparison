// Phase 4A — قراءة السجل التشغيلي الخارجي (عرض فقط).
// لا يوجد أي endpoint تعديل/حذف لهذا السجل إطلاقًا — append-only تطبيقياً.

import { NextRequest, NextResponse } from "next/server";
import { requireManageBackups } from "@/lib/session";
import { readRecoveryEvents } from "@/lib/recovery-log";

function authError(error: unknown) {
  const msg = error instanceof Error ? error.message : "خطأ";
  const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
  return { status, msg };
}

export async function GET(req: NextRequest) {
  try {
    await requireManageBackups();
    const { searchParams } = new URL(req.url);
    const limitRaw = parseInt(searchParams.get("limit") || "50", 10);
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));
    const data = await readRecoveryEvents(limit);
    return NextResponse.json({
      events: data.events,
      corruptLines: data.corruptLines,
      totalBytes: data.totalBytes,
      exists: data.exists,
      appendOnly: true,
      note: "سجل خارج قاعدة البيانات — يبقى بعد أي استعادة. لا يوجد أي تعديل/حذف عبر API.",
    });
  } catch (error) {
    const { status, msg } = authError(error);
    return NextResponse.json(
      { error: status === 500 ? "فشل قراءة سجل الاسترجاع: " + msg : msg },
      { status }
    );
  }
}
