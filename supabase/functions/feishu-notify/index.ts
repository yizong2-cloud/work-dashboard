// ============================================================
// feishu-notify Edge Function（任务二改造）
// 入口：Supabase Database Webhook 监听 notification_outbox 的 INSERT/UPDATE
// 流程：验签 → 幂等 claim（pending→sending）→ 加载任务/原反馈 → 建卡 → 发飞书 → 回写状态
// 失败：状态置 failed（可审计），由 public.retry_failed_notifications() 重新触发（webhook 监听 UPDATE）
// 卡片构建逻辑在 ./cards.ts（纯函数，可本地单测）
// ============================================================

import { buildCard, type OriginalFeedback, type OutboxEvent, type TaskSummary } from './cards.ts'

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' }

interface OutboxRecord {
  id: string
  event_type: string
  payload: Record<string, unknown> | null
}

interface DatabaseWebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE'
  table: string
  record: OutboxRecord | null
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405)
  try {
    verifyWebhook(request)
    const payload = await request.json() as DatabaseWebhookPayload
    if (payload.table !== 'notification_outbox' || !payload.record) {
      return response({ skipped: true, reason: 'Only notification_outbox is supported' })
    }
    const record = payload.record
    const event: OutboxEvent = {
      id: record.id,
      event_type: record.event_type,
      payload: record.payload ?? {},
    }

    // 幂等 claim：只有 pending 能抢到（webhook 重试/重复投递不会重复处理）
    const claimed = await claimEvent(record.id)
    if (!claimed) return response({ skipped: true, reason: 'already processed or in flight' })

    try {
      const task = await resolveTask(event)
      const original = event.event_type === 'feedback_replied'
        ? await loadOriginalFeedback(String(event.payload.thread_id || ''))
        : null
      const baseUrl = Deno.env.get('DASHBOARD_BASE_URL') || 'https://yizong-boop.github.io/work-dashboard/'
      const card = buildCard(event, task, baseUrl, original)
      if (!card) {
        await markStatus(record.id, 'skipped', 'unsupported event type')
        return response({ ok: true, skipped: true, reason: 'unsupported event type' })
      }
      const channel = await sendFeishu(card)
      await markStatus(record.id, 'sent', '', channel)
      return response({ ok: true, channel, event_id: record.id })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[feishu-notify] deliver failed for ${record.id}: ${message}`)
      await markStatus(record.id, 'failed', message)
      // 返回 200：避免 webhook 自动重试造成并发；失败事件留在 outbox，由 retry_failed_notifications() 重试
      return response({ ok: false, error: message, queued: 'failed' }, 200)
    }
  } catch (error) {
    console.error(error)
    return response({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

// ---------------- Supabase REST 辅助 ----------------

function adminHeaders(): Record<string, string> {
  const url = requiredEnv('SUPABASE_URL')
  const key = requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  }
}

function adminUrl(): string {
  return requiredEnv('SUPABASE_URL').replace(/\/?$/, '')
}

async function claimEvent(id: string): Promise<boolean> {
  // PATCH where id AND status=pending → sending；只有 1 行受影响才成功
  const result = await fetch(
    `${adminUrl()}/rest/v1/notification_outbox?id=eq.${encodeURIComponent(id)}&status=eq.pending`,
    {
      method: 'PATCH',
      headers: { ...adminHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'sending' }),
    },
  )
  if (!result.ok) throw new Error(`claim failed: ${result.status} ${await result.text()}`)
  const rows = await result.json() as unknown[]
  return rows.length === 1
}

async function markStatus(id: string, status: string, lastError: string, sentAt?: string): Promise<void> {
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() }
  if (lastError) patch.last_error = lastError
  if (status === 'sent') patch.sent_at = new Date().toISOString()
  if (status === 'failed') patch.attempts = 1 // 用 UPDATE 表达式自增更稳，这里简化为标记；重试次数看 attempts
  const result = await fetch(
    `${adminUrl()}/rest/v1/notification_outbox?id=eq.${encodeURIComponent(id)}`,
    { method: 'PATCH', headers: adminHeaders(), body: JSON.stringify(patch) },
  )
  if (!result.ok) console.error(`[feishu-notify] markStatus(${status}) failed: ${await result.text()}`)
}

// ---------------- 事件解析 ----------------

async function resolveTask(event: OutboxEvent): Promise<TaskSummary> {
  let taskId = String(event.payload.task_id || '')
  if (!taskId && event.payload.thread_id) {
    // feedback 事件只有 thread_id → 查线程拿 task_id
    const threads = await restGet('task_feedback_threads', `id=eq.${encodeURIComponent(String(event.payload.thread_id))}`, 'task_id')
    const thread = threads[0] as { task_id?: string } | undefined
    if (!thread?.task_id) throw new Error(`Thread not found: ${event.payload.thread_id}`)
    taskId = thread.task_id
  }
  if (!taskId) throw new Error('Event has no task_id')
  return loadTask(taskId)
}

async function loadTask(taskId: string): Promise<TaskSummary> {
  const rows = await restGet('tasks', `id=eq.${encodeURIComponent(taskId)}`, 'id,title,status,progress,expected_end_date,block_reason')
  const task = rows[0] as TaskSummary | undefined
  if (!task) throw new Error(`Task not found: ${taskId}`)
  return task
}

async function loadOriginalFeedback(threadId: string): Promise<OriginalFeedback | null> {
  if (!threadId) return null
  const rows = await restGet('task_feedback_messages', `thread_id=eq.${encodeURIComponent(threadId)}&order=created_at.asc&limit=1`, 'body,author_name,created_at')
  const first = rows[0] as OriginalFeedback | undefined
  return first ?? null
}

async function restGet(table: string, query: string, select: string): Promise<unknown[]> {
  const result = await fetch(`${adminUrl()}/rest/v1/${table}?${query}&select=${encodeURIComponent(select)}`, {
    headers: adminHeaders(),
  })
  if (!result.ok) throw new Error(`Failed to query ${table}: ${result.status} ${await result.text()}`)
  return result.json() as Promise<unknown[]>
}

// ---------------- 飞书发送（沿用原实现） ----------------

async function sendFeishu(card: Record<string, unknown>): Promise<'custom_bot' | 'app_bot'> {
  const webhookUrl = Deno.env.get('FEISHU_BOT_WEBHOOK_URL')
  if (webhookUrl) {
    const payload: Record<string, unknown> = { msg_type: 'interactive', card }
    const signingSecret = Deno.env.get('FEISHU_BOT_SIGNING_SECRET')
    if (signingSecret) {
      const timestamp = Math.floor(Date.now() / 1000).toString()
      payload.timestamp = timestamp
      payload.sign = await createBotSignature(timestamp, signingSecret)
    }
    const result = await fetch(webhookUrl, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload) })
    const body = await result.text()
    if (!result.ok) throw new Error(`Feishu custom bot failed: ${result.status} ${body}`)
    const parsed = JSON.parse(body) as { code?: number; StatusCode?: number; msg?: string; StatusMessage?: string }
    if ((parsed.code ?? parsed.StatusCode ?? 0) !== 0) {
      throw new Error(`Feishu custom bot rejected: ${parsed.msg || parsed.StatusMessage || body}`)
    }
    return 'custom_bot'
  }

  const appId = Deno.env.get('FEISHU_APP_ID')
  const appSecret = Deno.env.get('FEISHU_APP_SECRET')
  const receiverId = Deno.env.get('FEISHU_RECEIVER_ID')
  const receiverType = Deno.env.get('FEISHU_RECEIVER_ID_TYPE') || 'open_id'
  if (!appId || !appSecret || !receiverId) {
    throw new Error('Configure FEISHU_BOT_WEBHOOK_URL or FEISHU_APP_ID/FEISHU_APP_SECRET/FEISHU_RECEIVER_ID')
  }
  const tokenResult = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const tokenBody = await tokenResult.json() as { code: number; msg: string; tenant_access_token?: string }
  if (!tokenResult.ok || tokenBody.code !== 0 || !tokenBody.tenant_access_token) {
    throw new Error(`Failed to get Feishu tenant token: ${tokenBody.msg || tokenResult.status}`)
  }
  const result = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiverType)}`, {
    method: 'POST',
    headers: { ...jsonHeaders, authorization: `Bearer ${tokenBody.tenant_access_token}` },
    body: JSON.stringify({ receive_id: receiverId, msg_type: 'interactive', content: JSON.stringify(card) }),
  })
  const body = await result.json() as { code: number; msg: string }
  if (!result.ok || body.code !== 0) throw new Error(`Feishu app bot failed: ${body.msg || result.status}`)
  return 'app_bot'
}

async function createBotSignature(timestamp: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${timestamp}\n${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array()))
  return btoa(String.fromCharCode(...signature))
}

// ---------------- 工具 ----------------

function verifyWebhook(request: Request): void {
  const expected = Deno.env.get('DASHBOARD_WEBHOOK_SECRET')
  if (!expected) throw new Error('DASHBOARD_WEBHOOK_SECRET is not configured')
  if (request.headers.get('x-dashboard-secret') !== expected) throw new Error('Invalid webhook secret')
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders })
}
