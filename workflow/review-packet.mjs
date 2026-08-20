// Compact, complete review index for a dashboard snapshot.
// Raw source material stays in update-context.json and is retrieved only by id.

import { redactSensitiveText, redactSensitiveValue } from './redaction.mjs'

const MAX_EXCERPT = 420
const RECONCILIATION_DECISIONS = new Set(['mapped', 'irrelevant', 'needs_confirmation'])

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
  return redactSensitiveText(line)
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

// Candidate mappings are intentionally broad so a source directory/chat can
// cover several related tasks. Only explicitly curated source-map keywords may
// reorder them: deriving keywords from titles made generic words such as
// “测试/反馈” look authoritative and increased the chance of false attribution.
function rankCandidateTasks(candidate, evidenceText) {
  const tasks = Array.isArray(candidate?.tasks) ? candidate.tasks : []
  const keywordMap = candidate?.task_keywords
  if (tasks.length < 2 || !keywordMap || typeof keywordMap !== 'object') return { tasks, applied: false }
  const corpus = String(evidenceText || '').toLowerCase()
  const ranked = tasks.map((task, index) => {
    const keywords = Array.isArray(keywordMap[task]) ? keywordMap[task] : []
    const matches = keywords.filter((term) => term && corpus.includes(String(term).toLowerCase()))
    const score = matches.reduce((sum, term) => sum + Math.min(String(term).length, 8), 0)
    return { task, index, score }
  }).sort((a, b) => b.score - a.score || a.index - b.index)
  return {
    tasks: ranked.map(({ task }) => task),
    applied: ranked[0].score > 0 && ranked[0].score > ranked[1].score,
  }
}

// This is review effort, not task urgency. Keep the legacy review_priority
// field for compatibility, but expose why an item needs human attention so an
// Agent never treats it as the task's `priority` value.
function reviewMeta(candidate, fallbackReason = null, evidenceText = '') {
  const candidateCount = Array.isArray(candidate?.tasks) ? candidate.tasks.length : 0
  const reviewReason = fallbackReason
    || (candidateCount === 0 ? 'no_candidate_mapping' : candidateCount > 1 ? 'multiple_candidate_tasks' : 'single_candidate')
  const ranking = rankCandidateTasks(candidate, evidenceText)
  return {
    candidate_count: candidateCount,
    candidate_tasks: ranking.tasks,
    ...(ranking.applied ? { candidate_ranked_by: 'keyword_overlap' } : {}),
    review_priority: reviewReason === 'single_candidate' ? 'normal' : 'high',
    review_reason: reviewReason,
  }
}

function sessionKey(session) {
  if (session?.file) return `file:${session.file}`
  return `fallback:${session?.cwd || ''}|${session?.lastTs || session?.lastTsMs || session?.start || ''}`
}

// Compact summaries are the complete inventory; detail rows enrich matching
// sessions with longer user text/actions. Detail extraction is intentionally
// capped, so review must never use it as the source of truth for coverage.
export function mergeSessionRows(summaryRows, detailRows) {
  const summary = Array.isArray(summaryRows) ? summaryRows : []
  const detail = Array.isArray(detailRows) ? detailRows : []
  const detailByKey = new Map(detail.map((row) => [sessionKey(row), row]))
  const seen = new Set()
  const merged = summary.map((row) => {
    const key = sessionKey(row)
    seen.add(key)
    return { ...row, ...(detailByKey.get(key) || {}) }
  })
  for (const row of detail) {
    const key = sessionKey(row)
    if (!seen.has(key)) merged.push(row)
  }
  return merged
}

export function buildCoverage(ctx, items) {
  const expected = {
    codex: mergeSessionRows(ctx.codex, ctx.codex_detail).length,
    dsh: mergeSessionRows(ctx.dsh, ctx.dsh_detail).length,
    feishu: splitFeishuGroups(ctx.feishu?.content).length,
    local: Array.isArray(ctx.sources?.local_files) ? ctx.sources.local_files.length : 0,
  }
  const actual = Object.fromEntries(['codex', 'dsh', 'feishu', 'local'].map((source) => [
    source,
    (items || []).filter((item) => item.source === source).length,
  ]))
  const gaps = Object.keys(expected).filter((source) => expected[source] !== actual[source])
  return { expected, actual, complete: gaps.length === 0, gaps }
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

function sourceHealth(ctx) {
  const steps = new Map((ctx.steps || []).map((step) => [step.name, step]))
  const source = (name, fallback = {}) => ({
    ok: fallback.ok !== false,
    count: fallback.count ?? null,
    file: fallback.file ?? null,
    detail: steps.get(name)?.detail ? redactSensitiveText(steps.get(name).detail).slice(0, 240) : null,
  })
  return {
    feishu: source('飞书增量导出', ctx.sources?.feishu),
    codex: source('Codex 摘要', ctx.sources?.codex),
    dsh: source('DSH 摘要', ctx.sources?.dsh),
    local_files: {
      ok: true,
      count: Array.isArray(ctx.sources?.local_files) ? ctx.sources.local_files.length : 0,
      file: null,
      detail: steps.get('本地新文件')?.detail ? redactSensitiveText(steps.get('本地新文件').detail).slice(0, 240) : null,
    },
  }
}

export function buildReviewItems(ctx) {
  const items = []
  const add = (item) => items.push({ ...item, raw_available: true })

  for (const [index, session] of mergeSessionRows(ctx.codex, ctx.codex_detail).entries()) {
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
      ...reviewMeta(candidate, null, (session.userReqs || []).join('\n')),
    })
  }

  for (const [index, session] of mergeSessionRows(ctx.dsh, ctx.dsh_detail).entries()) {
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
      ...reviewMeta(candidate, null, (session.userMsgs || []).join('\n')),
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
      ...reviewMeta(candidate, null, group.content),
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
      ...reviewMeta(null, 'metadata_only', file.name || file.path || ''),
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
    source_health: sourceHealth(ctx),
    review_contract: {
      required_decisions: ['mapped', 'irrelevant', 'needs_confirmation'],
      instruction: '每个 source_id 恰好写一条 reconciliation。先看短摘录；不确定时用 dashboard:evidence 按 id 展开原始材料。',
      review_priority_semantics: 'review_priority/review_attention 表示证据需要多少人工判断，不是任务 priority，也不代表加急。以 review_reason 解释原因。candidate_tasks 仅在 source-map 为任务明确配置关键词且证据唯一命中时做稳定排序；仍须人工确认，不代表自动归属。',
    },
    coverage: buildCoverage(ctx, items),
    counts: {
      total: items.length,
      by_source: bySource,
      // Keep high_priority for older consumers; new consumers should use the
      // explicit name so task urgency and review effort cannot be conflated.
      high_priority: items.filter((item) => item.review_priority === 'high').length,
      review_attention: items.filter((item) => item.review_priority === 'high').length,
    },
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
  if (source === 'codex') return redactSensitiveValue(removeToolNoise(mergeSessionRows(ctx.codex, ctx.codex_detail)[index] || null))
  if (source === 'dsh') return redactSensitiveValue(removeToolNoise(mergeSessionRows(ctx.dsh, ctx.dsh_detail)[index] || null))
  if (source === 'local') return redactSensitiveValue(removeToolNoise(ctx.sources?.local_files?.[index] || null))
  if (source === 'feishu') return redactSensitiveValue(removeToolNoise(splitFeishuGroups(ctx.feishu?.content)[index] || null))
  return null
}

export function validateReconciliation(reviewItems, reconciliation) {
  const errors = []
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
    if (!RECONCILIATION_DECISIONS.has(entry?.decision)) errors.push(`reconciliation[${index}]: decision 非法`)
    if (entry?.decision === 'mapped' && !entry.task_id) errors.push(`reconciliation[${index}]: mapped 项缺 task_id`)
  }
  for (const id of expected) {
    if (!seen.has(id)) errors.push(`缺少对账结论: ${id}`)
  }
  return errors
}

// 回复只需要这份摘要；逐条结论仍完整保存在 ops.json / changeset，并由上面的闸门校验。
export function summarizeReconciliation(reconciliation) {
  const rows = Array.isArray(reconciliation) ? reconciliation : []
  const summary = {
    total: rows.length,
    mapped: 0,
    irrelevant: 0,
    needs_confirmation: 0,
    invalid: 0,
    needs_confirmation_source_ids: [],
  }
  for (const row of rows) {
    if (!RECONCILIATION_DECISIONS.has(row?.decision)) {
      summary.invalid += 1
      continue
    }
    summary[row.decision] += 1
    if (row.decision === 'needs_confirmation' && row.source_id) summary.needs_confirmation_source_ids.push(row.source_id)
  }
  return summary
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
