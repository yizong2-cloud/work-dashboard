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

export function buildPendingPlan(spec, reviewPacket, now = new Date().toISOString(), previous = null) {
  const itemsById = new Map((reviewPacket?.review_items || []).map((item) => [item.source_id, item]))
  const questions = unresolvedEntries(spec).map((entry) => {
    const item = itemsById.get(entry.source_id)
    const candidates = (item?.candidate_tasks || []).map(taskLabel).filter(Boolean)
    return {
      source_id: entry.source_id,
      source: item?.source || entry.source_id.split(':')[0] || 'unknown',
      reason: entry.reason || entry.evidence || item?.review_reason || '证据无法安全归属到唯一任务',
      excerpt: item?.excerpt || '（无短摘录；请按 source_id 展开证据）',
      candidates,
    }
  })
  return {
    version: 1,
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
    lines.push(`${index + 1}. ${question.source_id}：${question.reason}`)
    lines.push(`   证据：${question.excerpt}`)
    if (question.candidates.length) lines.push(`   候选：${question.candidates.join(' / ')}`)
    lines.push('   请答：归入哪个既有任务，或确认无关。')
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
    else if (arg === '--decision') args.decision = argv[++i]
    else if (arg === '--task') args.task = argv[++i]
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
  if (!args.source || !args.decision || !args.reason) fail('resolve 需要 --source、--decision、--reason')
  if (!['mapped', 'irrelevant'].includes(args.decision)) fail('resolve 的 --decision 只允许 mapped 或 irrelevant')
  if (args.decision === 'mapped' && !args.task) fail('mapped 必须提供 --task <任务 UUID>')

  const spec = readJson(args.file)
  const reviewPacket = readJson(args.review)
  const previous = readJson(args.pending)
  if (!spec || !reviewPacket || !previous) fail('缺少待确认计划、ops 或审查包')
  if (!pendingForSnapshot(previous, spec.snapshot_id)) fail('当前没有与 ops 快照匹配的待确认计划；请勿把旧确认套到新快照')
  const entry = (spec.reconciliation || []).find((item) => item?.source_id === args.source)
  if (!entry || entry.decision !== 'needs_confirmation') fail(`未找到待确认 source_id: ${args.source}`)

  entry.decision = args.decision
  entry.reason = args.reason
  delete entry.evidence
  if (args.decision === 'mapped') entry.task_id = args.task
  else delete entry.task_id
  writeJsonAtomic(args.file, spec)

  const next = buildPendingPlan(spec, reviewPacket, new Date().toISOString(), previous)
  writeJsonAtomic(args.pending, next)
  console.log(`✅ 已解决 ${args.source} → ${args.decision}`)
  console.log(formatPendingPlan(next))
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.command === 'hold') return hold(args)
  if (args.command === 'resolve') return resolve(args)
  if (args.command === 'show') return console.log(formatPendingPlan(readJson(args.pending)))
  fail('用法: dashboard:pending -- hold|show|resolve')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
