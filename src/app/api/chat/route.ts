import { NextRequest } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { DEFAULT_MODEL, isAllowedModel as isKnownModel } from '@/lib/ai-config'
import { guardWrite } from "@/lib/api-guard";

export const runtime = 'nodejs'
export const maxDuration = 120

/** أقصى عدد رسائل سابقة تُرسل للنموذج كسياق */
const MAX_HISTORY = 20

interface ChatRequestBody {
  conversationId?: string
  message?: string
  model?: string
  thinking?: boolean
}

/** استخراج مقطع تفكير/محتوى من دلتة SSE */
function extractDelta(obj: unknown): { content: string; thinking: string } {
  const o = obj as {
    choices?: Array<{
      delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }
    }>
  }
  const delta = o?.choices?.[0]?.delta ?? {}
  const content = typeof delta.content === 'string' ? delta.content : ''
  const thinking =
    (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '') ||
    (typeof delta.reasoning === 'string' ? delta.reasoning : '')
  return { content, thinking }
}

export async function POST(req: NextRequest) {
  return guardWrite("/api/chat", async () => {
    let body: ChatRequestBody
    try {
      body = await req.json()
    } catch {
      return Response.json({ error: 'صيغة الطلب غير صالحة' }, { status: 400 })
    }

    const userMessage = (body.message ?? '').trim()
    if (!userMessage) {
      return Response.json({ error: 'الرسالة مطلوبة' }, { status: 400 })
    }
    if (userMessage.length > 8000) {
      return Response.json({ error: 'الرسالة طويلة جدًا (الحد الأقصى 8000 حرف)' }, { status: 400 })
    }

    // التحقق من النموذج — الافتراضي بعد الترقية: GLM-5.3-Flash
    const model = body.model && isKnownModel(body.model) ? body.model : DEFAULT_MODEL
    const thinkingEnabled = body.thinking === true

    // إيجاد أو إنشاء المحادثة
    let conversationId = body.conversationId ?? null
    if (conversationId) {
      const existing = await db.conversation.findUnique({ where: { id: conversationId } })
      if (!existing) conversationId = null
    }
    const isNew = !conversationId
    if (!conversationId) {
      const title = userMessage.length > 40 ? `${userMessage.slice(0, 40)}…` : userMessage
      const created = await db.conversation.create({
        data: { title, model },
      })
      conversationId = created.id
    } else {
      // تحديث نموذج المحادثة عند تغييره
      await db.conversation.update({ where: { id: conversationId }, data: { model } })
    }

    // حفظ رسالة المستخدم
    await db.message.create({
      data: {
        conversationId,
        role: 'user',
        content: userMessage,
        model,
      },
    })

    // بناء السياق من الرسائل السابقة
    const history = await db.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: MAX_HISTORY,
    })
    history.reverse()

    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      {
        role: 'system',
        content:
          'أنت مساعد ذكي ودود يعمل بنموذج GLM-5.3-Flash. أجب بلغة المستخدم (العربية أو الإنجليزية أو غيرها)، وكن دقيقًا ومفيدًا وموجزًا عند الحاجة، واستخدم تنسيق Markdown عند الفائدة.',
      },
      ...history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ]

    const encoder = new TextEncoder()
    const finalConversationId = conversationId

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let fullContent = ''
        let fullThinking = ''
        let closed = false

        const send = (event: Record<string, unknown>) => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
          } catch {
            closed = true
          }
        }

        // إرسال بيانات المحادثة
        const conversation = await db.conversation.findUnique({ where: { id: finalConversationId } })
        send({
          type: 'meta',
          conversationId: finalConversationId,
          title: conversation?.title ?? '',
          model,
        })

        let saved = false
        const saveAssistantMessage = async () => {
          if (saved) return
          saved = true
          const content = fullContent.trim()
          if (!content) {
            send({ type: 'done', model })
            return
          }
          try {
            const created = await db.message.create({
              data: {
                conversationId: finalConversationId,
                role: 'assistant',
                content,
                thinking: fullThinking.trim() || null,
                model,
              },
            })
            await db.conversation.update({
              where: { id: finalConversationId },
              data: { updatedAt: new Date() },
            })
            send({ type: 'done', messageId: created.id, model })
          } catch {
            send({ type: 'done', model })
          }
        }

        try {
          const zai = await ZAI.create()
          const completion = await zai.chat.completions.create({
            model,
            messages,
            stream: true,
            thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
          })

          // الحالة 1: بث SSE من الخادم
          if (completion && typeof (completion as ReadableStream).getReader === 'function') {
            const reader = (completion as ReadableStream<Uint8Array>).getReader()
            const decoder = new TextDecoder()
            let buffer = ''

            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })

              const lines = buffer.split('\n')
              buffer = lines.pop() ?? ''

              for (const rawLine of lines) {
                const line = rawLine.trim()
                if (!line || !line.startsWith('data:')) continue
                const data = line.slice(5).trim()
                if (!data || data === '[DONE]') continue
                try {
                  const obj = JSON.parse(data)
                  const { content, thinking } = extractDelta(obj)
                  if (thinking) {
                    fullThinking += thinking
                    send({ type: 'thinking', content: thinking })
                  }
                  if (content) {
                    fullContent += content
                    send({ type: 'delta', content })
                  }
                } catch {
                  // سطر غير صالح — تجاهله
                }
              }
            }
          } else {
            // الحالة 2: استجابة JSON كاملة
            const completionObj = completion as {
              choices?: Array<{
                message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }
              }>
            }
            const msg = completionObj?.choices?.[0]?.message
            const thinking =
              typeof msg?.reasoning_content === 'string'
                ? msg.reasoning_content
                : typeof msg?.reasoning === 'string'
                  ? msg.reasoning
                  : ''
            const content = typeof msg?.content === 'string' ? msg.content : ''
            if (thinking) {
              fullThinking = thinking
              send({ type: 'thinking', content: thinking })
            }
            if (content) {
              fullContent = content
              send({ type: 'delta', content })
            }
          }

          await saveAssistantMessage()
          if (!closed) {
            closed = true
            controller.close()
          }
        } catch (err) {
          // حفظ الجزء المكتوب قبل الخطأ
          await saveAssistantMessage()
          const message = err instanceof Error ? err.message : 'خطأ غير معروف في النموذج'
          if (!closed) {
            send({ type: 'error', error: message })
            closed = true
            try {
              controller.close()
            } catch {
              // تم الإغلاق مسبقًا
            }
          }
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Conversation-Id': conversationId,
        'X-Conversation-Is-New': isNew ? '1' : '0',
      },
    })
  });}
