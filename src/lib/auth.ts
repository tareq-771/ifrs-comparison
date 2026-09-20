import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "@/lib/audit-actions";
import { writeAuditSafe, getClientIp } from "@/lib/audit";

// استخراج IP من كائن req الخاص بـ next-auth (يختلف شكله حسب البيئة — نتعامل دفاعيًا)
function authReqIp(req: unknown): string | null {
  try {
    const r = req as { headers?: unknown };
    if (!r?.headers) return null;
    const h = r.headers as Record<string, string | string[] | undefined>;
    const xff = typeof h["x-forwarded-for"] === "string" ? h["x-forwarded-for"] : undefined;
    if (xff) return xff.split(",")[0]?.trim() || null;
    const real = typeof h["x-real-ip"] === "string" ? h["x-real-ip"] : undefined;
    return real || null;
  } catch {
    return null;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        if (!credentials?.username || !credentials?.password) return null;
        const ip = authReqIp(req) ?? getClientIp(req as Request | null);
        const attempted = credentials.username;
        const user = await db.user.findUnique({
          where: { username: credentials.username },
        });
        if (!user || !user.active) {
          // حدث أمني: اسم مستخدم غير موجود أو الحساب معطل
          await writeAuditSafe({
            user: null,
            username: attempted,
            action: AUDIT_ACTIONS.LOGIN_FAILED,
            entityType: AUDIT_ENTITY_TYPES.Auth,
            entityId: user?.id ?? null,
            description: `محاولة دخول فاشلة للاسم «${attempted}» — ${user ? "الحساب معطل" : "اسم المستخدم غير موجود"}`,
            metadata: { reason: user ? "inactive" : "user_not_found" },
            ip,
          });
          return null;
        }
        const isValid = await bcrypt.compare(
          credentials.password,
          user.passwordHash
        );
        if (!isValid) {
          // حدث أمني: كلمة مرور خاطئة (لا تُسجل الكلمة نفسها إطلاقًا)
          await writeAuditSafe({
            user: null,
            username: attempted,
            action: AUDIT_ACTIONS.LOGIN_FAILED,
            entityType: AUDIT_ENTITY_TYPES.Auth,
            entityId: user.id,
            description: `محاولة دخول فاشلة للاسم «${attempted}» — كلمة المرور غير صحيحة`,
            metadata: { reason: "bad_password" },
            ip,
          });
          return null;
        }
        await writeAuditSafe({
          user: { id: user.id, username: user.username, name: user.displayName },
          action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
          entityType: AUDIT_ENTITY_TYPES.Auth,
          entityId: user.id,
          description: `تسجيل دخول ناجح للمستخدم «${user.username}»`,
          ip,
        });
        return {
          id: user.id,
          name: user.displayName || user.username,
          email: user.username,
          role: user.role,
          permissions: user.permissions,
        };
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = (user as any).role;
        token.permissions = (user as any).permissions;
        token.username = (user as any).email || (user as any).name;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).role = token.role;
        (session.user as any).permissions = token.permissions;
        (session.user as any).username = token.username;
        (session.user as any).id = token.sub;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
};
