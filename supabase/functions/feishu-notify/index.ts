// Supabase Database Webhook → 飞书任务简报
// 只监听 task_updates INSERT：仓库铁律保证任何有意义的变化都会产生一条时间线，
// 因此这里只需要一个通知入口，避免 tasks UPDATE + timeline INSERT 重复提醒。

interface TaskUpdateRecord {
  id: string
  task_id: string
  type: string
  content: string
  created_at: string
  created_by: string
}

interface DatabaseWebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE'
  table: string
  schema: string
  record: TaskUpdateRecord | null
}

interface TaskSummary {
  id: string
  title: string
  status: string
  progress: number
  expected_end_date: string | null
  block_reason: string
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' }

Deno.serve(async (request) => {
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405)

  try {
    verifyWebhook(request)
    const payload = await request.json() as DatabaseWebhookPayload
    if (payload.table !== 'task_updates' || payload.type !== 'INSERT' || !payload.record) {
      return response({ skipped: true, reason: 'Only task_updates INSERT is supported' })
    }

    const task = await loadTask(payload.record.task_id)
    const card = buildTaskCard(task, payload.record)
    const channel = await sendFeishu(card)
    return response({ ok: true, channel, update_id: payload.record.id })
  } catch (error) {
    console.error(error)
    return response({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

function verifyWebhook(request: Request) {
  const expected = Deno.env.get('DASHBOARD_WEBHOOK_SECRET')
  if (!expected) throw new Error('DASHBOARD_WEBHOOK_SECRET is not configured')
  if (request.headers.get('x-dashboard-secret') !== expected) throw new Error('Invalid webhook secret')
}

async function loadTask(taskId: string): Promise<TaskSummary> {
  const supabaseUrl = requiredEnv('SUPABASE_URL')
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY')
  const select = 'id,title,status,progress,expected_end_date,block_reason'
  const result = await fetch(
    `${supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}&select=${select}`,
    { headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` } },
  )
  if (!result.ok) throw new Error(`Failed to load task: ${result.status} ${await result.text()}`)
  const rows = await result.json() as TaskSummary[]
  if (!rows[0]) throw new Error(`Task not found: ${taskId}`)
  return rows[0]
}

function buildTaskCard(task: TaskSummary, update: TaskUpdateRecord) {
  const comment = update.type === 'note' && update.content.startsWith('💬 ')
  const title = comment ? `${update.created_by || 'Leader'} 留下了新留言` : eventTitle(update.type)
  const detailUrl = `${(Deno.env.get('DASHBOARD_BASE_URL') || 'https://yizong-boop.github.io/work-dashboard/').replace(/\/?$/, '/')}#/task/${task.id}${comment ? '?comment=1' : ''}`
  const schedule = task.expected_end_date || '未排期'
  const content = trimText(comment ? update.content.slice(3) : update.content, 700)

  return {
    config: { wide_screen_mode: true },
    header: {
      template: cardTone(update.type, task.status),
      title: { tag: 'plain_text', content: 'Workboard · 任务简报' },
      subtitle: { tag: 'plain_text', content: title },
    },
    elements: [
      { tag: 'markdown', content: `**${escapeMarkdown(task.title)}**\n${escapeMarkdown(content)}` },
      {
        tag: 'column_set',
        flex_mode: 'none',
        background_style: 'grey',
        columns: [
          { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**状态**\n${statusLabel(task.status)}` }] },
          { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**进度**\n${task.progress}%` }] },
          { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**预计完成**\n${schedule}` }] },
        ],
      },
      ...(task.status === 'blocked' && task.block_reason
        ? [{ tag: 'markdown', content: `**阻塞原因**\n<font color='red'>${escapeMarkdown(trimText(task.block_reason, 300))}</font>` }]
        : []),
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          type: 'primary',
          text: { tag: 'plain_text', content: comment ? '查看并回复' : '查看任务详情' },
          url: detailUrl,
        }],
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `${update.created_by || 'Agent'} · ${formatTime(update.created_at)}` }] },
    ],
  }
}

async function sendFeishu(card: Record<string, unknown>): Promise<'custom_bot' | 'app_bot'> {
  const webhookUrl = Deno.env.get('FEISHU_BOT_WEBHOOK_URL')
  if (webhookUrl) {
    const result = await fetch(webhookUrl, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ msg_type: 'interactive', card }),
    })
    const body = await result.text()
    if (!result.ok) throw new Error(`Feishu custom bot failed: ${result.status} ${body}`)
    const parsed = JSON.parse(body) as { code?: number; StatusCode?: number; msg?: string; StatusMessage?: string }
    if ((parsed.code ?? parsed.StatusCode ?? 0) !== 0) throw new Error(`Feishu custom bot rejected: ${parsed.msg || parsed.StatusMessage || body}`)
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

function eventTitle(type: string): string {
  return ({
    progress: '任务进度更新', status_change: '任务状态更新', schedule_change: '任务排期调整',
    blocked: '任务出现阻塞', unblocked: '任务解除阻塞', interrupt: '新增临时任务',
    completed: '任务已经完成', note: '任务有新进展',
  } as Record<string, string>)[type] || '任务内容更新'
}

function cardTone(type: string, status: string): string {
  if (type === 'blocked' || status === 'blocked') return 'red'
  if (type === 'completed' || status === 'completed') return 'green'
  if (type === 'schedule_change') return 'orange'
  if (type === 'note') return 'purple'
  return 'blue'
}

function statusLabel(status: string): string {
  return ({ planned: '待开始', in_progress: '进行中', blocked: '阻塞', paused: '暂停', completed: '已完成', cancelled: '已取消' } as Record<string, string>)[status] || status
}

function trimText(value: string, max: number): string {
  const clean = value.trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function escapeMarkdown(value: string): string {
  return value.replace(/([*_~`])/g, '\\$1')
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders })
}
