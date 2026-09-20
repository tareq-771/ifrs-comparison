import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { guardWrite, guardRead } from "@/lib/api-guard";

export const runtime = 'nodejs'

interface RouteContext {
  params: Promise<{ id: string }>
}

/** GET /api/conversations/[id] — تفاصيل محادثة مع رسائلها */
export async function GET(_req: NextRequest, ctx: RouteContext) {
  return guardRead("/api/conversations/[id]", async () => {
    const { id } = await ctx.params
    try {
      const conversation = await db.conversation.findUnique({
        where: { id },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              role: true,
              content: true,
              thinking: true,
              model: true,
              createdAt: true,
            },
          },
        },
      })
      if (!conversation) {
        return Response.json({ error: 'المحادثة غير موجودة' }, { status: 404 })
      }
      return Response.json({ conversation, messages: conversation.messages })
    } catch (err) {
      console.error(`GET /api/conversations/${id} failed:`, err)
      return Response.json({ error: 'تعذر تحميل المحادثة' }, { status: 500 })
    }
  });
}

/** PATCH /api/conversations/[id] — إعادة تسمية المحادثة */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  return guardWrite("/api/conversations/[id]", async () => {
    const { id } = await ctx.params
    try {
      const body = await req.json().catch(() => null)
      const title = typeof body?.title === 'string' ? body.title.trim() : ''
      if (!title) {
        return Response.json({ error: 'العنوان مطلوب' }, { status: 400 })
      }
      const conversation = await db.conversation.update({
        where: { id },
        data: { title: title.slice(0, 120) },
      })
      return Response.json({ conversation })
    } catch (err) {
      console.error(`PATCH /api/conversations/${id} failed:`, err)
      return Response.json({ error: 'تعذر تحديث المحادثة' }, { status: 500 })
    }
  });
}

/** DELETE /api/conversations/[id] — حذف المحادثة ورسائلها */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  return guardWrite("/api/conversations/[id]", async () => {
    const { id } = await ctx.params
    try {
      await db.conversation.delete({ where: { id } })
      return Response.json({ ok: true })
    } catch (err) {
      console.error(`DELETE /api/conversations/${id} failed:`, err)
      return Response.json({ error: 'تعذر حذف المحادثة' }, { status: 500 })
    }
  });
}
