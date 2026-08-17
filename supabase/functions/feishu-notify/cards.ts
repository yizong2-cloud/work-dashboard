// ============================================================
// feishu-notify / cards.ts —— 飞书卡片构建（纯函数，无 Deno 依赖）
// 供 Edge Function 与本地单元测试共用（node --experimental-strip-types 可直接测）。
// 事件类型与 notification_outbox.event_type 对应。
// ============================================================

export interface TaskSummary {
  id: string
  title: string
  status: string
  progress: number
  expected_end_date: string | null
  block_reason: string
}

export interface OutboxEvent {
  id: string
  event_type: string
  payload: Record<string, unknown>
}

export interface OriginalFeedback {
  body: string
  author_name: string
  created_at: string
}

const STATUS_LABEL: Record<string, string> = {
  planned: '待开始', in_progress: '进行中', blocked: '阻塞',
  paused: '暂停', completed: '已完成', cancelled: '已取消',
}

function trimText(value: string, max: number): string {
  const clean = (value ?? '').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function escapeMarkdown(value: string): string {
  return String(value).replace(/([*_~`])/g, '\\$1')
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status
}

export function formatTime(value: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return value
  }
}

export function deepLink(baseUrl: string, taskId: string, threadId?: string): string {
  const base = (baseUrl || '').replace(/\/?$/, '/')
  return threadId ? `${base}#/task/${taskId}?thread=${threadId}` : `${base}#/task/${taskId}`
}

function baseCard(tone: string, title: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: tone,
      title: { tag: 'plain_text', content: 'Workboard · 通知' },
      subtitle: { tag: 'plain_text', content: title },
    },
    elements: [],
  }
}

// ---- 任务时间线事件（blocked/unblocked/completed/schedule_change 等即时通知）----

export function eventTitle(type: string): string {
  return (
    {
      progress: '任务进度更新', status_change: '任务状态更新', schedule_change: '任务排期调整',
      blocked: '任务出现阻塞', unblocked: '任务解除阻塞', interrupt: '新增临时任务',
      completed: '任务已经完成', note: '任务有新进展', urgent: '任务加急', deurgent: '任务取消加急', nudge: '进度催办',
    } as Record<string, string>
  )[type] || '任务内容更新'
}

function taskTone(type: string, status: string): string {
  if (type === 'blocked' || status === 'blocked') return 'red'
  if (type === 'urgent' || status === 'urgent') return 'red'
  if (type === 'deurgent') return 'blue'
  if (type === 'completed' || status === 'completed') return 'green'
  if (type === 'schedule_change' || type === 'nudge') return 'orange'
  if (type === 'note') return 'purple'
  return 'blue'
}

export function buildTaskCard(event: OutboxEvent, task: TaskSummary, baseUrl: string): Record<string, unknown> {
  const type = String(event.payload.type || 'note')
  const content = trimText(String(event.payload.content || ''), 700)
  const title = eventTitle(type)
  const card = baseCard(taskTone(type, task.status), title)
  const elements = card.elements as Array<Record<string, unknown>>
  elements.push({ tag: 'markdown', content: `**${escapeMarkdown(task.title)}**\n${escapeMarkdown(content)}` })
  elements.push({
    tag: 'column_set', flex_mode: 'none', background_style: 'grey',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**状态**\n${statusLabel(task.status)}` }] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**进度**\n${task.progress}%` }] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**预计完成**\n${task.expected_end_date || '未排期'}` }] },
    ],
  })
  if (task.status === 'blocked' && task.block_reason) {
    elements.push({ tag: 'markdown', content: `**阻塞原因**\n<font color='red'>${escapeMarkdown(trimText(task.block_reason, 300))}</font>` })
  }
  elements.push({
    tag: 'action',
    actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看任务详情' }, url: deepLink(baseUrl, task.id) }],
  })
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `${String(event.payload.created_by || 'Agent')} · ${formatTime(String(event.payload.created_at || ''))}` }] })
  return card
}

// ---- 反馈事件 ----

export function buildFeedbackCreatedCard(event: OutboxEvent, task: TaskSummary, baseUrl: string): Record<string, unknown> {
  const threadId = String(event.payload.thread_id || '')
  const body = trimText(String(event.payload.body || ''), 500)
  const author = String(event.payload.author_name || 'Leader')
  const card = baseCard('purple', `💬 ${author} 发起了新反馈`)
  const elements = card.elements as Array<Record<string, unknown>>
  elements.push({ tag: 'markdown', content: `**${escapeMarkdown(task.title)}**\n> ${escapeMarkdown(body)}` })
  elements.push({
    tag: 'action',
    actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看反馈并回复' }, url: deepLink(baseUrl, task.id, threadId) }],
  })
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `请负责人及时回应 · ${formatTime(String(event.payload.created_at || ''))}` }] })
  return card
}

export function buildFeedbackRepliedCard(
  event: OutboxEvent,
  task: TaskSummary,
  baseUrl: string,
  original: OriginalFeedback | null,
): Record<string, unknown> {
  const threadId = String(event.payload.thread_id || '')
  const body = trimText(String(event.payload.body || ''), 500)
  const author = String(event.payload.author_name || '本人')
  const originalLine = original ? `\n\n> 原反馈（${trimText(original.author_name || 'Leader', 40)}）：${trimText(original.body, 200)}` : ''
  const card = baseCard('blue', `${author} 回复了反馈`)
  const elements = card.elements as Array<Record<string, unknown>>
  elements.push({ tag: 'markdown', content: `**${escapeMarkdown(task.title)}**\n${escapeMarkdown(body)}${escapeMarkdown(originalLine)}` })
  elements.push({
    tag: 'action',
    actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看反馈并回复' }, url: deepLink(baseUrl, task.id, threadId) }],
  })
  return card
}

export function buildFeedbackResolvedCard(event: OutboxEvent, task: TaskSummary, baseUrl: string): Record<string, unknown> {
  const threadId = String(event.payload.thread_id || '')
  const newStatus = String(event.payload.new_status || '')
  const resolved = newStatus === 'resolved'
  const by = String(event.payload.resolved_by || '')
  const card = baseCard(resolved ? 'green' : 'orange', resolved ? '✅ 反馈已解决' : '↩️ 反馈已重新打开')
  const elements = card.elements as Array<Record<string, unknown>>
  elements.push({ tag: 'markdown', content: `**${escapeMarkdown(task.title)}**\n${resolved ? `已由 ${by || '负责人'} 标记解决` : '该反馈被重新打开，需要继续跟进'}` })
  elements.push({
    tag: 'action',
    actions: [{ tag: 'button', type: 'default', text: { tag: 'plain_text', content: '查看反馈线程' }, url: deepLink(baseUrl, task.id, threadId) }],
  })
  return card
}

// ---- progress 聚合摘要 ----

export function buildProgressDigestCard(event: OutboxEvent, task: TaskSummary, baseUrl: string): Record<string, unknown> {
  const count = Number(event.payload.count ?? 1)
  const latest = trimText(String(event.payload.latest || event.payload.content || ''), 400)
  const card = baseCard('blue', `任务进度更新（${count} 条）`)
  const elements = card.elements as Array<Record<string, unknown>>
  elements.push({ tag: 'markdown', content: `**${escapeMarkdown(task.title)}**\n${escapeMarkdown(latest)}` })
  elements.push({
    tag: 'column_set', flex_mode: 'none', background_style: 'grey',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**状态**\n${statusLabel(task.status)}` }] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**进度**\n${task.progress}%` }] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**预计完成**\n${task.expected_end_date || '未排期'}` }] },
    ],
  })
  elements.push({
    tag: 'action',
    actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看任务详情' }, url: deepLink(baseUrl, task.id) }],
  })
  return card
}

// ---- Leader 催进度（task_nudged）----

export function buildNudgeCard(event: OutboxEvent, task: TaskSummary, baseUrl: string): Record<string, unknown> {
  const note = trimText(String(event.payload.content || '请关注一下这个任务的进度'), 500)
  const by = String(event.payload.created_by || 'Leader')
  const card = baseCard('orange', '⏰ 有人催进度了')
  const elements = card.elements as Array<Record<string, unknown>>
  elements.push({ tag: 'markdown', content: `**${escapeMarkdown(task.title)}**\n> ${escapeMarkdown(note)}` })
  elements.push({
    tag: 'column_set', flex_mode: 'none', background_style: 'grey',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**状态**\n${statusLabel(task.status)}` }] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**进度**\n${task.progress}%` }] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**预计完成**\n${task.expected_end_date || '未排期'}` }] },
    ],
  })
  elements.push({
    tag: 'action',
    actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看任务并更新进度' }, url: deepLink(baseUrl, task.id) }],
  })
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `${by} 催办 · ${formatTime(String(event.payload.created_at || ''))}` }] })
  return card
}

/** 根据事件类型分发卡片构建（供 Edge Function 与测试使用） */
export function buildCard(
  event: OutboxEvent,
  task: TaskSummary,
  baseUrl: string,
  original: OriginalFeedback | null = null,
): Record<string, unknown> | null {
  switch (event.event_type) {
    case 'task_update': return buildTaskCard(event, task, baseUrl)
    case 'task_update_progress': return buildProgressDigestCard(event, task, baseUrl)
    case 'task_nudged': return buildNudgeCard(event, task, baseUrl)
    case 'feedback_created': return buildFeedbackCreatedCard(event, task, baseUrl)
    case 'feedback_replied': return buildFeedbackRepliedCard(event, task, baseUrl, original)
    case 'feedback_resolved': return buildFeedbackResolvedCard(event, task, baseUrl)
    default: return null
  }
}
