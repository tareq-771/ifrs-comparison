// Phase 6.10 — تعيين أخطاء خدمة الأعمار إلى استجابات HTTP (نمط trial-balance):
// NOT_FOUND → 403 (إخفاء النطاق)، الفوربيدن → 403، التحقق → 400، الحجم → 413،
// التعارض/SOD → 409، غير المصادق → 401، غير المتوقع → 500 بنص عربي.

import { NextResponse } from "next/server";
import { AgingError } from "@/lib/aging-server";

export function agingErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof AgingError) {
    let status = 400;
    if (error.code === "NOT_FOUND" || error.code === "FORBIDDEN") status = 403;
    else if (error.code === "TOO_LARGE" || error.code === "TOO_MANY_ROWS") status = 413;
    else if (error.code === "CONFLICT" || error.code === "EXISTING_APPROVED_SNAPSHOT" || error.code === "SOD_VIOLATION") status = 409;
    return NextResponse.json({ error: error.message, code: error.code, ...(error.detail ? { detail: error.detail } : {}) }, { status });
  }
  const msg = error instanceof Error ? error.message : "";
  if (msg === "Unauthorized") return NextResponse.json({ error: "غير مصادق" }, { status: 401 });
  if (msg === "Forbidden" || msg.startsWith("Forbidden")) return NextResponse.json({ error: "ممنوع — لا تملك الصلاحية اللازمة" }, { status: 403 });
  return null;
}
