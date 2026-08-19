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

export function decisionExportLink(baseUrl: string, slug: string): string {
  const base = (baseUrl || '').replace(/\/?$/, '/')
  return `${base}#/decisions/${encodeURIComponent(slug)}/export`
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
  // 档位 A 智能跳转：按钮文案/动作按任务状态变化，逾期/催办直接进快速更新弹窗
  const todayStr = (() => {
    const t = new Date()
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  })()
  const isOverdue = task.status !== 'completed' && task.status !== 'cancelled'
    && !!task.expected_end_date && task.expected_end_date < todayStr
  const actionUrl = isOverdue || type === 'nudge'
    ? `${deepLink(baseUrl, task.id)}?action=progress`
    : deepLink(baseUrl, task.id)
  const actionLabel = isOverdue ? '⚠️ 去更新进度' : '查看任务详情'
  elements.push({
    tag: 'action',
    actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: actionLabel }, url: actionUrl }],
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

export function buildDecisionResponseCard(event: OutboxEvent, baseUrl: string): Record<string, unknown> {
  const formSlug = String(event.payload.form_slug || '')
  const formTitle = trimText(String(event.payload.form_title || '未命名决策表单'), 120)
  const respondent = String(event.payload.respondent_name || '').trim() || '未填写身份'
  const submittedAt = formatTime(String(event.payload.submitted_at || ''))
  const card = baseCard('purple', '🔔 收到新的决策答卷')
  const elements = card.elements as Array<Record<string, unknown>>
  elements.push({
    tag: 'markdown',
    content: `**${escapeMarkdown(formTitle)}**\n提交人：${escapeMarkdown(respondent)}\n提交时间：${escapeMarkdown(submittedAt)}`,
  })
  elements.push({
    tag: 'action',
    actions: [{
      tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看决策结果' },
      url: decisionExportLink(baseUrl, formSlug),
    }],
  })
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: 'Workboard · 决策中心 · 仅发送给 Leader' }] })
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
    actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看任务并更新进度' }, url: `${deepLink(baseUrl, task.id)}?action=progress` }],
  })
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `${by} 催办 · ${formatTime(String(event.payload.created_at || ''))}` }] })
  return card
}

// ---- 工作日日报（send_daily_report 定时生成，Leader 全局视角）----

interface DailyItem {
  task_id: string
  title: string
  progress: number
  expected_end_date?: string | null
  current_status?: string
  block_reason?: string
}

function daysFromToday(dateStr: string): number {
  const today = new Date()
  const target = new Date(`${dateStr}T00:00:00`)
  return Math.round((target.getTime() - today.getTime()) / 86400000)
}

function dailyItemLines(items: DailyItem[], baseUrl: string, suffix?: (it: DailyItem) => string): string[] {
  return items.map((it) => {
    const link = `[${escapeMarkdown(trimText(it.title, 24))}](${deepLink(baseUrl, it.task_id)})`
    return `· ${link} · ${it.progress}%${suffix ? ` · ${suffix(it)}` : ''}`
  })
}

export function buildDailyCard(event: OutboxEvent, baseUrl: string): Record<string, unknown> {
  const p = event.payload
  const dateStr = String(p.date || '')
  const overdue = (p.overdue || []) as DailyItem[]
  const week = (p.week || []) as DailyItem[]
  const urgent = (p.urgent || []) as DailyItem[]
  const blocked = (p.blocked || []) as DailyItem[]
  const unscheduled = (p.unscheduled || []) as DailyItem[]
  const feedbackOpen = Number(p.feedback_open ?? 0)
  const updatesToday = Number(p.updates_today ?? 0)
  const activeCount = Number(p.active_count ?? 0)
  const plannedCount = Number(p.planned_count ?? 0)

  const dateLabel = (() => {
    try {
      const d = new Date(`${dateStr}T00:00:00`)
      return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', weekday: 'short' }).format(d)
    } catch {
      return dateStr || ''
    }
  })()

  const hasRisk = overdue.length > 0 || urgent.length > 0 || blocked.length > 0
  const card = baseCard(hasRisk ? 'orange' : 'blue', `Workboard · 日报 ${dateLabel}`)
  const elements = card.elements as Array<Record<string, unknown>>

  elements.push({
    tag: 'markdown',
    content: `**进行中** ${activeCount} · **待开始** ${plannedCount} · **今日更新** ${updatesToday} · **待回应反馈** ${feedbackOpen}`,
  })

  if (overdue.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `🔴 **已逾期（${overdue.length}）**\n${dailyItemLines(overdue, baseUrl, (it) => `逾期 ${Math.abs(daysFromToday(String(it.expected_end_date)))} 天`).join('\n')}`,
    })
  }
  if (urgent.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `🔥 **加急中（${urgent.length}）**\n${dailyItemLines(urgent, baseUrl, (it) => it.expected_end_date ? `预计 ${it.expected_end_date}` : '未排期').join('\n')}`,
    })
  }
  if (blocked.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `⛔ **阻塞（${blocked.length}）**\n${dailyItemLines(blocked, baseUrl, (it) => trimText(it.block_reason || '', 18)).join('\n')}`,
    })
  }
  if (week.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `🟡 **本周到期（${week.length}）**\n${dailyItemLines(week, baseUrl, (it) => `预计 ${it.expected_end_date}`).join('\n')}`,
    })
  }
  if (unscheduled.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `🟠 **未排期（${unscheduled.length}）**\n${dailyItemLines(unscheduled, baseUrl, (it) => trimText(it.current_status || '暂无说明', 18)).join('\n')}`,
    })
  }
  if (overdue.length === 0 && urgent.length === 0 && blocked.length === 0 && week.length === 0 && unscheduled.length === 0) {
    elements.push({ tag: 'markdown', content: '✅ 无逾期 · 无加急 · 无阻塞 · 本周无到期 · 活跃任务均已排期' })
  }

  elements.push({
    tag: 'action',
    actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看完整看板' }, url: `${(baseUrl || '').replace(/\/?$/, '/')}#/` }],
  })
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: 'Workboard 定时日报 · 工作日 19:30' }] })
  return card
}

/** 根据事件类型分发卡片构建（供 Edge Function 与测试使用） */
export function buildCard(
  event: OutboxEvent,
  task: TaskSummary | null,
  baseUrl: string,
  original: OriginalFeedback | null = null,
): Record<string, unknown> | null {
  if (event.event_type === 'decision_response_submitted') {
    return buildDecisionResponseCard(event, baseUrl)
  }
  if (!task) return null
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
