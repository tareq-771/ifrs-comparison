// حماية الصفحات على مستوى الحافة (Edge) — Next.js 16 (proxy.ts هو اصطلاح middleware الجديد)
//
// القواعد:
//   - "/" تتطلب جلسة مسجلة (غير المسجل يُحوَّل إلى /login)
//   - "/admin" تتطلب جلسة سارية + واحدة من: دور admin، صلاحية manageUsers،
//     صلاحية manageBackups (4B.3 — فصل الصلاحيات: حامل النسخ يدير النسخ من الواجهة
//     دون أن يكون مديرًا؛ ما يراه داخل الصفحة يحدده صفحة admin نفسها)
//   - مسارات /api محمية ذاتيًا داخل معالجاتها (requireAuth/requireAdmin) ولا تمر من هنا
//   - /login عامة دائمًا (وبها تدفق الإعداد الأولي عند عدم وجود مستخدمين)
//
// ملاحظة: الاعتماد على توكن JWT فقط (بدون Prisma) لأن middleware يعمل على Edge runtime.
// حقول role/permissions موجودة داخل التوكن من jwt callback في src/lib/auth.ts.

import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { canManageBackups, parsePermissions } from "@/lib/permissions";

export default async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });

  // غير مسجل الدخول → صفحة الدخول (مع الإبقاء على مسار /login متاحًا دائمًا)
  if (!token) {
    const loginUrl = new URL("/login", req.url);
    // منع حلقة تحويل لا نهائية إذا كان الهدف login نفسه (احتياط)
    if (pathname !== "/login") {
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  // /admin: دور المدير، أو صلاحية manageUsers صريحة، أو صلاحية manageBackups صريحة
  // (نفس دلالة canManageBackups: المدير ضمنيًا بالدور — 4B.3 يفتح الصفحة لحاملي النسخ)
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    const role = typeof token.role === "string" ? token.role : "user";
    const perms = parsePermissions(typeof token.permissions === "string" ? token.permissions : null);
    const canOpen = role === "admin" || perms.manageUsers === true || canManageBackups(perms, role);
    if (!canOpen) {
      return NextResponse.redirect(new URL("/", req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  // "/" الصفحة الرئيسية (مطابقة تامة) + "/admin" بأي عمق
  matcher: ["/", "/admin", "/admin/:path*"],
};
