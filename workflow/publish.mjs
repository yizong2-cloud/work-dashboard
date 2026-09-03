#!/usr/bin/env node
// Publish gate: freezes a human-readable update preview and records the
// owner's explicit confirmation before apply is allowed to write or notify.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { summarizeNotificationIntents, notificationIntentFor } from './operation-intent.mjs'
import { summarizeReconciliation, validateReviewSpec } from './review-packet.mjs'
import { readJson, writeJsonAtomic } from './pending.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_OPS_FILE = path.join(ROOT, 'workflow', 'ops.json')
export const DEFAULT_REVIEW_FILE = path.join(ROOT, 'workflow', 'review-packet.json')
export const DEFAULT_PREVIEW_FILE = path.join(ROOT, 'workflow', 'publish-preview.json')
export const DEFAULT_APPROVAL_FILE = path.join(ROOT, 'workflow', 'publish-approval.json')
const NEGATED_APPROVAL = /(?:先(?:不|别)|暂(?:不|缓)|不要|不能|别|取消)(?:再)?(?:更新|推送|确认)|(?:更新|推送)(?:先)?(?:不要|不行|取消)/
const EXPLICIT_APPROVAL_PATTERNS = [
  /^(?:确认|同意)(?:更新|推送)?(?:吧|了)?$/,
  /^(?:可以|没问题)(?:更新|推送)?(?:吧|了)?$/,
  /^按(?:这|此|这个|当前)(?:版|个)?(?:内容)?(?:更新|推送|来)(?:吧)?$/,
  /^(?:就)?(?:这样|这么)(?:更新|推送|做|来)(?:吧)?$/,
  /^(?:更新|推送)(?:吧|即可)$/,
  /(?:改完|改好|改了|修改后).*(?:可以|就).*(?:更新|推送)/,
  /(?:可以|就可以)(?:直接)?(?:更新|推送)(?:了|吧)?$/,
]

export function isExplicitApproval(value) {
  const text = String(value ?? '')
    .replace(/[`*_]/g, '')
    .replace(/[\s，,。.!！]+/g, '')
    .trim()
  if (!text || /[?？]/.test(text) || NEGATED_APPROVAL.test(text)) return false
  return EXPLICIT_APPROVAL_PATTERNS.some((pattern) => pattern.test(text))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

export function specFingerprint(spec) {
  const stable = JSON.stringify(canonicalize({
    snapshot_id: spec?.snapshot_id ?? null,
    reconciliation: spec?.reconciliation ?? [],
    ops: spec?.ops ?? [],
  }))
  return createHash('sha256').update(stable).digest('hex')
}

function boardTaskMap(reviewPacket) {
  return new Map((reviewPacket?.board || []).map((task) => [task.id, task.title || task.id]))
}

function taskLabel(op, tasks) {
  return op.op === 'create' ? op.title : tasks.get(op.id) || `任务 ${op.id || '未知'}`
}

const PROGRESS_BASIS_LABELS = {
  user_explicit: '用户明确给出',
  milestone_ratio: '按已完成里程碑计算',
  agent_estimate: 'Agent 估算（需你确认）',
}

function operationText(op, tasks) {
  const task = taskLabel(op, tasks)
  const note = String(op.note ?? op.content ?? op.reason ?? '').trim()
  switch (op.op) {
    case 'create': {
      const status = { planned: '待开始', in_progress: '进行中', blocked: '阻塞', paused: '暂停', completed: '已完成', cancelled: '已取消' }[op.status] || op.status || '待开始'
      const priority = { urgent: '紧急', high: '高', normal: '普通', low: '低' }[op.priority] || op.priority || '普通'
      const start = op.start ?? op.start_date
      const end = op.end ?? op.expected_end ?? op.expected_end_date
      const fields = [
        op.description ? `描述：${op.description}` : null,
        `状态：${status}`,
        `优先级：${priority}`,
        `进度：${op.progress ?? 0}%`,
        start ? `开始：${start}` : null,
        end ? `预计完成：${end}` : null,
        op.current_status ? `当前情况：${op.current_status}` : null,
        op.creation_basis ? `创建依据类型：${{ source_explicit: '来源明确安排', user_explicit: '用户明确提出', owner_confirmed: '用户已确认归属' }[op.creation_basis] || op.creation_basis}` : null,
        note ? `创建依据：${note}` : null,
      ].filter(Boolean)
      return `新建任务：${task}；${fields.join('；')}`
    }
    case 'progress': return `更新进度：${task} → ${op.to}%${op.current_status ? `；同步现状：${op.current_status}` : ''}${op.progress_basis ? `；口径：${PROGRESS_BASIS_LABELS[op.progress_basis] || op.progress_basis}` : ''}${op.evidence_quote ? `；用户原话：${op.evidence_quote}` : ''}${note ? `；依据：${note}` : ''}`
    case 'status': return `更新状态：${task} → ${op.to}${note ? `；说明：${note}` : ''}`
    case 'schedule': return `调整排期：${task} → ${op.end}${note ? `；原因：${note}` : ''}`
    case 'block': return `标记阻塞：${task}；原因：${note}`
    case 'unblock': return `解除阻塞：${task}${note ? `；说明：${note}` : ''}`
    case 'complete': return `标记完成：${task}${note ? `；说明：${note}` : ''}`
    case 'reopen': return `重新打开：${task} → 进行中 ${op.to}%（清除实际完成日期）${op.current_status ? `；同步现状：${op.current_status}` : ''}${op.progress_basis ? `；口径：${PROGRESS_BASIS_LABELS[op.progress_basis] || op.progress_basis}` : ''}${note ? `；依据：${note}` : ''}`
    case 'note': return `补充${(op.type ?? 'progress') === 'note' ? '备注' : '进展'}：${task}；${note}`
    case 'update': {
      const fields = Object.entries(op)
        .filter(([key]) => !['op', 'id', 'note', 'content', 'notify', 'notify_mode', 'evidence_quote'].includes(key))
        .map(([key, value]) => `${key}=${value}`)
      return `更新任务信息：${task}${fields.length ? `；${fields.join('，')}` : ''}${note ? `；说明：${note}` : ''}`
    }
    default: return `未知操作：${op.op}`
  }
}

function previewWarnings(ops, reviewPacket, now) {
  const board = new Map((reviewPacket?.board || []).map((task) => [task.id, task]))
  const today = String(now || '').slice(0, 10)
  const warnings = []
  for (const op of ops) {
    if (op.op !== 'progress') continue
    const task = board.get(op.id)
    if (task?.expected_end_date && task.expected_end_date <= today && Number(op.to) < 100) {
      warnings.push(`${task.title || op.id} 的预计完成日为 ${task.expected_end_date}，本次更新后仍为 ${op.to}%；请确认是否还要同步调整排期。`)
    }
    if (op.current_status === undefined) {
      warnings.push(`${task?.title || op.id} 更新了百分比但没有同步“当前情况”；若已有新的阶段结论，建议放进同一个 progress 操作。`)
    }
  }
  return warnings
}

export function buildPublishPreview(spec, reviewPacket, now = new Date().toISOString()) {
  const ops = Array.isArray(spec?.ops) ? spec.ops : []
  const tasks = boardTaskMap(reviewPacket)
  const groupsByTask = new Map()
  for (const [index, op] of ops.entries()) {
    const key = op.op === 'create' ? `create:${op.title}` : `task:${op.id || `unknown:${index}`}`
    if (!groupsByTask.has(key)) {
      groupsByTask.set(key, {
        item_id: `T${groupsByTask.size + 1}`,
        task: taskLabel(op, tasks),
        changes: [],
      })
    }
    groupsByTask.get(key).changes.push({
      index: index + 1,
      text: operationText(op, tasks),
      notification: notificationIntentFor(op),
    })
  }
  return {
    version: 2,
    state: 'awaiting_owner_confirmation',
    snapshot_id: spec?.snapshot_id || null,
    fingerprint: specFingerprint(spec),
    created_at: now,
    reconciliation: summarizeReconciliation(spec?.reconciliation),
    notification_intent: summarizeNotificationIntents(ops),
    operations: ops.map((op, index) => ({
      index: index + 1,
      text: operationText(op, tasks),
      notification: notificationIntentFor(op),
    })),
    task_changes: [...groupsByTask.values()],
    warnings: previewWarnings(ops, reviewPacket, now),
  }
}

function notificationText(intent) {
  if (intent === 'immediate') return '单独进入飞书投递队列'
  if (intent === 'merge') return '与本批同类进展合并后进入飞书队列'
  if (intent === 'historical') return '历史补记，不推送'
  return '静默写入，不推送'
}

export function formatPublishPreview(preview) {
  if (!preview) return '没有待确认的更新预览。'
  const lines = [
    '⏸️ 更新预览（尚未写入看板，尚未触发飞书通知）',
    `快照：${preview.snapshot_id || '未知'}`,
    `对账：共 ${preview.reconciliation.total} 项 · 已映射 ${preview.reconciliation.mapped} · 已审查无需改动 ${preview.reconciliation.reviewed_no_change || 0} · 无关 ${preview.reconciliation.irrelevant} · 待确认 ${preview.reconciliation.needs_confirmation}`,
  ]
  if (!preview.operations.length) {
    lines.push('拟写入：无任务数据变更；确认后仅记录本次全量审查结案，不会发送飞书。')
  } else {
    const groups = preview.task_changes?.length ? preview.task_changes : preview.operations.map((operation) => ({ item_id: String(operation.index), task: '', changes: [operation] }))
    lines.push(`拟写入：${groups.length} 个任务，共 ${preview.operations.length} 项变更`)
    for (const group of groups) {
      lines.push(`${group.item_id}. ${group.task}`)
      for (const change of group.changes) {
        lines.push(`   - ${change.text.replace(`：${group.task}`, '')}`)
        lines.push(`     飞书：${notificationText(change.notification)}`)
      }
    }
  }
  if (preview.warnings?.length) {
    lines.push('风险提示：')
    for (const warning of preview.warnings) lines.push(`- ${warning}`)
  }
  lines.push('请审核以上完整内容；明确回复同意即可，例如“确认”“可以更新”或“按这版推送”，无需固定口令。在此之前，任何 apply 都会被机器拒绝。')
  return lines.join('\n')
}

export function approvalMatchesSpec(approval, spec) {
  return Boolean(approval
    && approval.state === 'approved'
    && approval.snapshot_id === spec?.snapshot_id
    && approval.fingerprint === specFingerprint(spec))
}

export function consumeApproval(spec, {
  previewFile = DEFAULT_PREVIEW_FILE,
  approvalFile = DEFAULT_APPROVAL_FILE,
  now = new Date().toISOString(),
} = {}) {
  const preview = readJson(previewFile)
  if (preview?.fingerprint === specFingerprint(spec) && preview.snapshot_id === spec?.snapshot_id) {
    preview.state = 'executing'
    preview.apply_started_at = now
    writeJsonAtomic(previewFile, preview)
  }
  try { fs.unlinkSync(approvalFile) } catch { /* missing approval is handled by apply before this point */ }
}

export function markPreviewExecuting(spec, {
  previewFile = DEFAULT_PREVIEW_FILE,
  now = new Date().toISOString(),
} = {}) {
  const preview = readJson(previewFile)
  if (preview?.fingerprint !== specFingerprint(spec) || preview.snapshot_id !== spec?.snapshot_id) return
  preview.state = 'executing'
  preview.apply_started_at = preview.apply_started_at || now
  delete preview.last_error
  writeJsonAtomic(previewFile, preview)
}

export function markPreviewRetryable(spec, message, {
  previewFile = DEFAULT_PREVIEW_FILE,
  now = new Date().toISOString(),
} = {}) {
  const preview = readJson(previewFile)
  if (preview?.fingerprint !== specFingerprint(spec) || preview.snapshot_id !== spec?.snapshot_id) return
  preview.state = 'awaiting_retry'
  preview.last_failed_at = now
  preview.last_error = String(message || '部分操作执行失败')
  writeJsonAtomic(previewFile, preview)
}

export function markPreviewApplied(spec, changesetId, {
  previewFile = DEFAULT_PREVIEW_FILE,
  now = new Date().toISOString(),
} = {}) {
  const preview = readJson(previewFile)
  if (preview?.fingerprint !== specFingerprint(spec) || preview.snapshot_id !== spec?.snapshot_id) return
  preview.state = 'applied'
  preview.applied_at = now
  preview.changeset_id = changesetId
  writeJsonAtomic(previewFile, preview)
}

function parseArgs(argv) {
  const args = {
    command: 'show', file: DEFAULT_OPS_FILE, review: DEFAULT_REVIEW_FILE,
    preview: DEFAULT_PREVIEW_FILE, approval: DEFAULT_APPROVAL_FILE, phrase: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--') && i === 0) args.command = arg
    else if (arg === '--file') args.file = argv[++i]
    else if (arg === '--review') args.review = argv[++i]
    else if (arg === '--preview') args.preview = argv[++i]
    else if (arg === '--approval') args.approval = argv[++i]
    else if (arg === '--phrase') args.phrase = argv[++i]
  }
  return args
}

function fail(message) {
  console.error(`❌ ${message}`)
  process.exit(1)
}

function loadCurrentSpec(args) {
  const spec = readJson(args.file)
  const review = readJson(args.review)
  if (!spec || !review) fail('缺少有效 ops.json 或 review-packet.json')
  const errors = validateReviewSpec(spec.snapshot_id, review, spec)
  if ((spec.reconciliation || []).some((entry) => entry?.decision === 'needs_confirmation')) {
    errors.push('仍有 needs_confirmation，必须先完成逐项确认，不能生成推送预览')
  }
  if (errors.length) fail(`预览校验失败：${errors.join('；')}`)
  return { spec, review }
}

function preview(args) {
  const { spec, review } = loadCurrentSpec(args)
  const result = buildPublishPreview(spec, review)
  writeJsonAtomic(args.preview, result)
  console.log(formatPublishPreview(result))
}

function confirm(args) {
  if (!isExplicitApproval(args.phrase)) fail('没有识别到明确同意；请在审核完整预览后回复“确认”“可以更新”或“按这版推送”等清晰授权')
  const { spec } = loadCurrentSpec(args)
  const previewRecord = readJson(args.preview)
  if (!previewRecord || previewRecord.fingerprint !== specFingerprint(spec) || previewRecord.snapshot_id !== spec.snapshot_id) {
    fail('找不到与当前内容一致的预览；请先运行 dashboard:publish -- preview，并把预览发给用户确认')
  }
  const approval = {
    version: 1,
    state: 'approved',
    snapshot_id: spec.snapshot_id,
    fingerprint: specFingerprint(spec),
    confirmed_at: new Date().toISOString(),
    confirmation_phrase: String(args.phrase).trim(),
  }
  writeJsonAtomic(args.approval, approval)
  console.log(`✅ 已记录用户确认；当前快照 ${spec.snapshot_id} 可执行 dashboard:apply。`)
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.command === 'preview') return preview(args)
  if (args.command === 'confirm') return confirm(args)
  if (args.command === 'show') return console.log(formatPublishPreview(readJson(args.preview)))
  fail('用法: dashboard:publish -- preview|show|confirm --phrase "<用户明确同意原话>"')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
