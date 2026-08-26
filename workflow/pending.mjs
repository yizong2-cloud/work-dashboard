#!/usr/bin/env node
// Pending reconciliation plan: make an unresolved dashboard review resumable
// without re-collecting the four sources or rewriting the full ops file.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_OPS_FILE = path.join(ROOT, 'workflow', 'ops.json')
export const DEFAULT_REVIEW_FILE = path.join(ROOT, 'workflow', 'review-packet.json')
export const DEFAULT_PENDING_FILE = path.join(ROOT, 'workflow', 'pending-plan.json')

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

export const loadPendingPlan = readJson

export function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch { /* best effort */ }
  }
}

export function unresolvedEntries(spec) {
  return (spec?.reconciliation || []).filter((entry) => entry?.decision === 'needs_confirmation')
}

function taskLabel(task) {
  if (typeof task === 'string') return task
  return task?.title ? `${task.title}（${task.id}）` : task?.id || null
}

function sourceName(item) {
  if (item?.source === 'codex') return 'Codex 工作会话'
  if (item?.source === 'dsh') return 'DSH 工作会话'
  if (item?.source === 'feishu') return '飞书群聊'
  if (item?.source === 'local') return item.kind === 'artifact_bundle' ? '本地文件组' : '本地文件'
  return '工作证据'
}

function readableTime(value) {
  if (!value) return '时间未记录'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(parsed)
}

function humanReason(value) {
  const labels = {
    no_candidate_mapping: '当前工作目录或群聊还没有匹配到看板任务。',
    multiple_candidate_tasks: '这段记录同时可能涉及多个任务，现有证据无法安全判断应更新哪一个。',
    metadata_only: '目前只有文件名和时间等元数据，无法确认文件内容是否代表新的任务进展。',
    single_candidate: '虽然只有一个候选任务，但证据仍不足以确认是否需要改看板。',
  }
  return labels[value] || value
}

export function buildPendingPlan(spec, reviewPacket, now = new Date().toISOString(), previous = null) {
  const itemsById = new Map((reviewPacket?.review_items || []).map((item) => [item.source_id, item]))
  const previousQuestionIds = new Map((previous?.questions || []).map((question) => [question.source_id, question.question_id]))
  let nextQuestionNumber = Math.max(0, ...(previous?.questions || []).map((question) => Number(String(question.question_id || '').replace(/^Q/i, '')) || 0)) + 1
  const questions = unresolvedEntries(spec).map((entry) => {
    const item = itemsById.get(entry.source_id)
    const candidates = (item?.candidate_tasks || []).map(taskLabel).filter(Boolean)
    return {
      question_id: previousQuestionIds.get(entry.source_id) || `Q${nextQuestionNumber++}`,
      source_id: entry.source_id,
      source: item?.source || entry.source_id.split(':')[0] || 'unknown',
      source_name: sourceName(item),
      subject: item?.label || '未命名工作记录',
      occurred_at: readableTime(item?.at),
      reason: humanReason(entry.reason || entry.evidence || item?.review_reason || '证据无法安全归属到唯一任务'),
      excerpt: item?.excerpt || '（当前没有可读摘录；Agent 应先展开原始证据，不应让你猜。）',
      candidates,
      impact: entry.impact || '你的回答只决定这条证据如何归档，以及是否需要改动看板；不会直接执行其他操作。',
      recommendation: entry.recommendation || '如果现有信息不足，建议暂不写入，并让 Agent 继续核对证据。',
    }
  })
  return {
    version: 2,
    state: questions.length ? 'awaiting_confirmation' : 'resolved',
    snapshot_id: spec?.snapshot_id || null,
    created_at: previous?.snapshot_id === spec?.snapshot_id ? previous.created_at : now,
    updated_at: now,
    questions,
  }
}

export function pendingForSnapshot(plan, snapshotId) {
  return Boolean(plan
    && plan.state === 'awaiting_confirmation'
    && plan.snapshot_id
    && plan.snapshot_id === snapshotId
    && Array.isArray(plan.questions)
    && plan.questions.length > 0)
}

export function formatPendingPlan(plan) {
  if (!plan) return '没有保存的待确认计划。'
  if (plan.state !== 'awaiting_confirmation' || !plan.questions?.length) {
    return `待确认计划：已解决（快照 ${plan.snapshot_id || '未知'}）。`
  }
  const lines = [
    `⏸️ 当前快照有 ${plan.questions.length} 项待确认；尚未写入看板，也不要重新运行 prepare。`,
    `快照：${plan.snapshot_id}`,
    '请逐项确认：',
  ]
  for (const [index, question] of plan.questions.entries()) {
    lines.push('')
    lines.push(`${question.question_id || `Q${index + 1}`} · 请确认这段工作信息应如何处理`)
    lines.push(`- 来自：${question.source_name || question.source} · ${question.subject || '未命名记录'} · ${question.occurred_at || '时间未记录'}`)
    lines.push(`- 原始内容：${question.excerpt}`)
    lines.push(`- 为什么要问：${question.reason}`)
    if (question.candidates?.length) lines.push(`- 可能相关的任务：${question.candidates.join(' / ')}`)
    lines.push(`- 回答会影响：${question.impact}`)
    lines.push(`- Agent 建议：${question.recommendation}`)
    lines.push(`- 请直接回答：任务名称 / “多个任务：A、B” / “已看过但不用改看板” / “与看板无关”`)
    lines.push(`  追踪信息（无需理解或照抄）：${question.source_id}`)
  }
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = { command: 'show', file: DEFAULT_OPS_FILE, review: DEFAULT_REVIEW_FILE, pending: DEFAULT_PENDING_FILE }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--') && i === 0) args.command = arg
    else if (arg === '--file') args.file = argv[++i]
    else if (arg === '--review') args.review = argv[++i]
    else if (arg === '--pending') args.pending = argv[++i]
    else if (arg === '--source') args.source = argv[++i]
    else if (arg === '--question') args.question = argv[++i]
    else if (arg === '--decision') args.decision = argv[++i]
    else if (arg === '--task') args.task = argv[++i]
    else if (arg === '--tasks') args.tasks = argv[++i]
    else if (arg === '--reason') args.reason = argv[++i]
  }
  return args
}

function fail(message) {
  console.error(`❌ ${message}`)
  process.exit(1)
}

function hold(args) {
  const spec = readJson(args.file)
  const reviewPacket = readJson(args.review)
  if (!spec || !reviewPacket) fail('缺少有效 ops.json 或 review-packet.json')
  if (!spec.snapshot_id || spec.snapshot_id !== reviewPacket.snapshot_id) fail('ops 与审查包不是同一快照，不能保存待确认计划')
  const plan = buildPendingPlan(spec, reviewPacket, new Date().toISOString(), readJson(args.pending))
  writeJsonAtomic(args.pending, plan)
  console.log(formatPendingPlan(plan))
  if (plan.state === 'awaiting_confirmation') process.exitCode = 2
}

function resolve(args) {
  if ((!args.source && !args.question) || !args.decision || !args.reason) fail('resolve 需要 --question Q1（或 --source）、--decision、--reason')
  if (!['mapped', 'reviewed_no_change', 'irrelevant'].includes(args.decision)) fail('resolve 的 --decision 只允许 mapped、reviewed_no_change 或 irrelevant')
  const taskIds = String(args.tasks || args.task || '').split(',').map((value) => value.trim()).filter(Boolean)
  if (args.decision === 'mapped' && taskIds.length === 0) fail('mapped 必须提供 --task <任务 UUID> 或 --tasks <UUID1,UUID2>')

  const spec = readJson(args.file)
  const reviewPacket = readJson(args.review)
  const previous = readJson(args.pending)
  if (!spec || !reviewPacket || !previous) fail('缺少待确认计划、ops 或审查包')
  if (!pendingForSnapshot(previous, spec.snapshot_id)) fail('当前没有与 ops 快照匹配的待确认计划；请勿把旧确认套到新快照')
  const selectedQuestion = args.question
    ? previous.questions.find((question) => question.question_id === String(args.question).toUpperCase())
    : null
  const sourceId = args.source || selectedQuestion?.source_id
  if (!sourceId) fail(`未找到待确认问题: ${args.question}`)
  const entry = (spec.reconciliation || []).find((item) => item?.source_id === sourceId)
  if (!entry || entry.decision !== 'needs_confirmation') fail(`未找到待确认项: ${args.question || sourceId}`)

  entry.decision = args.decision
  entry.reason = args.reason
  delete entry.evidence
  if (args.decision === 'mapped' && taskIds.length === 1) {
    entry.task_id = taskIds[0]
    delete entry.task_ids
  } else if (args.decision === 'mapped') {
    entry.task_ids = taskIds
    delete entry.task_id
  } else {
    delete entry.task_id
    delete entry.task_ids
  }
  writeJsonAtomic(args.file, spec)

  const next = buildPendingPlan(spec, reviewPacket, new Date().toISOString(), previous)
  writeJsonAtomic(args.pending, next)
  console.log(`✅ 已解决 ${args.question || sourceId} → ${args.decision}`)
  console.log(formatPendingPlan(next))
}

function cancel(args) {
  if (!args.reason) fail('cancel 需要 --reason，说明为什么放弃当前待确认快照')
  const plan = readJson(args.pending)
  if (!plan || plan.state !== 'awaiting_confirmation') fail('当前没有等待确认的计划')
  plan.state = 'cancelled'
  plan.cancelled_at = new Date().toISOString()
  plan.cancel_reason = args.reason
  plan.updated_at = plan.cancelled_at
  writeJsonAtomic(args.pending, plan)
  console.log(`✅ 已取消待确认计划（${plan.snapshot_id}）：${args.reason}`)
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.command === 'hold') return hold(args)
  if (args.command === 'resolve') return resolve(args)
  if (args.command === 'cancel') return cancel(args)
  if (args.command === 'show') return console.log(formatPendingPlan(readJson(args.pending)))
  fail('用法: dashboard:pending -- hold|show|resolve|cancel')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
