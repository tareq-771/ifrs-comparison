// Phase 6.2A — GET /api/account-nature/statement-lines
// مرجع بنود القوائم المالية (قراءة فقط) — تغذية قوائم الربط والعرض الهرمي.
// الإدارة الكاملة للبنود (إنشاء/تعديل) ليست في 6.2A — مرجع seed قابل للربط.

import { NextResponse } from "next/server";
import { requireManageAccountNature } from "@/lib/session";
import { guardRead } from "@/lib/api-guard";
import { listStatementLines } from "@/lib/account-nature-server";

export async function GET() {
  return guardRead("/api/account-nature/statement-lines", async () => {
    try {
      await requireManageAccountNature();
      const lines = await listStatementLines(true); // تشمل غير النشطة (شفافية المرجع)
      return NextResponse.json(lines);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "خطأ";
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return NextResponse.json({ error: status === 500 ? `فشل في جلب بنود القوائم المالية: ${msg}` : msg }, { status });
    }
  });
}
