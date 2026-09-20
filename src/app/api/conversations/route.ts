import { db } from '@/lib/db'

export const runtime = 'nodejs'

/** GET /api/conversations — قائمة المحادثات مرتبة بالأحدث */
export async function GET() {
  try {
    const conversations = await db.conversation.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: {
        _count: { select: { messages: true } },
      },
    })
    return Response.json({ conversations })
  } catch (err) {
    console.error('GET /api/conversations failed:', err)
    return Response.json({ error: 'تعذر تحميل المحادثات' }, { status: 500 })
  }
}
