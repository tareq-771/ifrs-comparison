// حماية الصفحات على مستوى الحافة (Edge) — Next.js 16 (proxy.ts هو اصطلاح middleware الجديد)
//
// القواعد:
//   - "/" تتطلب جلسة مسجلة (غير المسجل يُحوَّل إلى /login)
//   - "/admin" تتطلب جلسة سارية + دور admin (غير المدير يُعاد إلى "/")
//   - مسارات /api محمية ذاتيًا داخل معالجاتها (requireAuth/requireAdmin) ولا تمر من هنا
//   - /login عامة دائمًا (وبها تدفق الإعداد الأولي عند عدم وجود مستخدمين)
//
// ملاحظة: الاعتماد على توكن JWT فقط (بدون Prisma) لأن middleware يعمل على Edge runtime.
// حقل role موجود داخل التوكن من jwt callback في src/lib/auth.ts.

import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

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

  // /admin للمدير فقط
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (token.role !== "admin") {
      return NextResponse.redirect(new URL("/", req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  // "/" الصفحة الرئيسية (مطابقة تامة) + "/admin" بأي عمق
  matcher: ["/", "/admin", "/admin/:path*"],
};
