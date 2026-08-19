// Compact, complete review index for a dashboard snapshot.
// Raw source material stays in update-context.json and is retrieved only by id.

const MAX_EXCERPT = 420

function redact(text) {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
}

function redactValue(value) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)]))
  }
  return value
}

function removeToolNoise(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item !== 'string' || !item.trim().startsWith('<system-reminder>'))
      .map(removeToolNoise)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, removeToolNoise(child)]))
  }
  return value
}

function cleanLine(line) {
  return redact(line)
    .replace(/^[-*]\s*/, '')
    .replace(/^\*\*[^*]+\*\*\s*\([^)]*\):\s*/, '')
    .replace(/\[图片\]\([^)]*\)/g, '')
    .replace(/\[表情[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isUseful(line) {
  if (line.length < 3 || line.length > 500) return false
  if (/^(图片|文件|消息|undefined|null)$/i.test(line)) return false
  return true
}

function rankLine(line) {
  const signals = /完成|上线|发布|测试|修复|阻塞|排期|预计|需求|请|需要|安排|交付|复核|确认|问题|排图|逆向|联调|进度|今天|明天|本周/g
  return (line.match(signals) || []).length * 10 + Math.min(line.length, 120) / 120
}

export function compactExcerpt(text, limit = MAX_EXCERPT) {
  const lines = String(text || '').split('\n').map(cleanLine).filter(isUseful)
  const ranked = lines
    .map((line, index) => ({ line, index, score: rankLine(line) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 4)
    .sort((a, b) => a.index - b.index)
    .map(({ line }) => line)

  const selected = ranked.length ? ranked : lines.slice(0, 3)
  return selected.join(' / ').slice(0, limit) || '（未提取到可读文本；按需展开原始证据）'
}

function candidateForSession(ctx, source, cwd) {
  return (ctx.candidates?.[source] || []).find((item) => item.cwd === cwd) || null
}

function candidateForGroup(ctx, group) {
  return (ctx.candidates?.feishu || []).find((item) => item.group === group) || null
}

export function splitFeishuGroups(text) {
  const headings = [...String(text || '').matchAll(/^##\s+(.+)$/gm)]
  return headings.map((match, index) => {
    const start = match.index + match[0].length
    const end = headings[index + 1]?.index ?? String(text || '').length
    return { group: match[1].trim(), content: String(text || '').slice(start, end).trim() }
  })
}

function taskBrief(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    progress: task.progress,
    expected_end_date: task.expected_end_date || null,
    current_status: task.current_status || null,
  }
}

export function buildReviewItems(ctx) {
  const items = []
  const add = (item) => items.push({ ...item, raw_available: true })

  for (const [index, session] of (ctx.codex_detail || []).entries()) {
    const candidate = candidateForSession(ctx, 'codex', session.cwd)
    add({
      source_id: `codex:${index}`,
      source: 'codex',
      kind: 'session',
      label: session.cwd || session.file || `Codex 会话 ${index + 1}`,
      at: session.lastTs || session.start || null,
      candidate_tasks: candidate?.tasks || [],
      hint: candidate?.hint || null,
      excerpt: compactExcerpt((session.userReqs || []).join('\n')),
      review_priority: candidate?.tasks?.length === 1 ? 'normal' : 'high',
    })
  }

  for (const [index, session] of (ctx.dsh_detail || []).entries()) {
    const candidate = candidateForSession(ctx, 'dsh', session.cwd)
    add({
      source_id: `dsh:${index}`,
      source: 'dsh',
      kind: 'session',
      label: session.cwd || session.file || `DSH 会话 ${index + 1}`,
      at: session.lastTs || session.lastTsMs || session.start || null,
      candidate_tasks: candidate?.tasks || [],
      hint: candidate?.hint || null,
      excerpt: compactExcerpt((session.userMsgs || []).join('\n')),
      review_priority: candidate?.tasks?.length === 1 ? 'normal' : 'high',
    })
  }

  for (const [index, group] of splitFeishuGroups(ctx.feishu?.content).entries()) {
    const candidate = candidateForGroup(ctx, group.group)
    add({
      source_id: `feishu:${index}`,
      source: 'feishu',
      kind: 'chat_group',
      label: group.group,
      at: null,
      candidate_tasks: candidate?.tasks || [],
      hint: candidate?.hint || null,
      excerpt: compactExcerpt(group.content),
      review_priority: candidate?.tasks?.length === 1 ? 'normal' : 'high',
    })
  }

  for (const [index, file] of (ctx.sources?.local_files || []).entries()) {
    add({
      source_id: `local:${index}`,
      source: 'local',
      kind: 'file',
      label: file.name || file.path || `本地文件 ${index + 1}`,
      at: file.mtime || null,
      candidate_tasks: [],
      hint: '本地文件只采集元数据；按文件名判断，必要时展开或读取文件。',
      excerpt: `${file.ext || 'file'} · ${file.size || 0} bytes · ${file.path || ''}`,
      review_priority: 'high',
    })
  }
  return items
}

export function buildReviewPacket(ctx) {
  const items = buildReviewItems(ctx)
  const bySource = Object.fromEntries(['codex', 'dsh', 'feishu', 'local'].map((source) => [source, items.filter((item) => item.source === source).length]))
  return {
    schema_version: 1,
    snapshot_id: ctx.snapshot_id,
    captured_at: ctx.captured_at,
    snapshot_health: ctx.snapshot_health,
    review_contract: {
      required_decisions: ['mapped', 'irrelevant', 'needs_confirmation'],
      instruction: '每个 source_id 恰好写一条 reconciliation。先看短摘录；不确定时用 dashboard:evidence 按 id 展开原始材料。',
    },
    counts: { total: items.length, by_source: bySource, high_priority: items.filter((item) => item.review_priority === 'high').length },
    risks: {
      unmapped_cwd: ctx.candidates?.unmapped_cwd || [],
      unmapped_feishu_groups: ctx.candidates?.unmapped_feishu_groups || [],
      unscheduled: ctx.candidates?.unscheduled || [],
      overdue: ctx.candidates?.overdue || [],
    },
    board: (ctx.board || []).map(taskBrief),
    review_items: items,
  }
}

export function getEvidence(ctx, sourceId) {
  const match = /^([a-z]+):(\d+)$/.exec(String(sourceId || ''))
  if (!match) return null
  const [, source, rawIndex] = match
  const index = Number(rawIndex)
  if (source === 'codex') return redactValue(removeToolNoise(ctx.codex_detail?.[index] || null))
  if (source === 'dsh') return redactValue(removeToolNoise(ctx.dsh_detail?.[index] || null))
  if (source === 'local') return redactValue(removeToolNoise(ctx.sources?.local_files?.[index] || null))
  if (source === 'feishu') return redactValue(removeToolNoise(splitFeishuGroups(ctx.feishu?.content)[index] || null))
  return null
}

export function validateReconciliation(reviewItems, reconciliation) {
  const errors = []
  const allowed = new Set(['mapped', 'irrelevant', 'needs_confirmation'])
  const expected = new Set(reviewItems.map((item) => item.source_id))
  const seen = new Set()
  if (!Array.isArray(reconciliation)) return ['reconciliation 必须是数组']

  for (const [index, entry] of reconciliation.entries()) {
    const id = entry?.source_id
    if (!id) {
      errors.push(`reconciliation[${index}]: 缺 source_id`)
      continue
    }
    if (!expected.has(id)) errors.push(`reconciliation[${index}]: source_id 不属于当前快照: ${id}`)
    if (seen.has(id)) errors.push(`reconciliation[${index}]: source_id 重复: ${id}`)
    seen.add(id)
    if (!allowed.has(entry?.decision)) errors.push(`reconciliation[${index}]: decision 非法`)
    if (entry?.decision === 'mapped' && !entry.task_id) errors.push(`reconciliation[${index}]: mapped 项缺 task_id`)
  }
  for (const id of expected) {
    if (!seen.has(id)) errors.push(`缺少对账结论: ${id}`)
  }
  return errors
}

export function validateReviewSpec(snapshotId, reviewPacket, spec) {
  const errors = []
  if (!reviewPacket || !Array.isArray(reviewPacket.review_items)) {
    return ['找不到有效 review-packet.json；请先运行 dashboard:prepare']
  }
  if (reviewPacket.snapshot_id !== snapshotId) {
    errors.push('review-packet.json 与 update-context.json 不属于同一次快照；请重新运行 dashboard:prepare')
  }
  if (spec?.snapshot_id !== reviewPacket.snapshot_id) {
    errors.push('ops.snapshot_id 必须等于当前 review-packet 的 snapshot_id，避免把旧结论套到新快照')
  }
  errors.push(...validateReconciliation(reviewPacket.review_items, spec?.reconciliation))
  return errors
}
