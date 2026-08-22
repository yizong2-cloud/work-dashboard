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
export const CONFIRM_PHRASE = '确认推送'

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

function operationText(op, tasks) {
  const task = taskLabel(op, tasks)
  const note = String(op.note ?? op.content ?? op.reason ?? '').trim()
  switch (op.op) {
    case 'create': return `新建任务：${task}${note ? `；说明：${note}` : ''}`
    case 'progress': return `更新进度：${task} → ${op.to}%${note ? `；依据：${note}` : ''}`
    case 'status': return `更新状态：${task} → ${op.to}${note ? `；说明：${note}` : ''}`
    case 'schedule': return `调整排期：${task} → ${op.end}${note ? `；原因：${note}` : ''}`
    case 'block': return `标记阻塞：${task}；原因：${note}`
    case 'unblock': return `解除阻塞：${task}${note ? `；说明：${note}` : ''}`
    case 'complete': return `标记完成：${task}${note ? `；说明：${note}` : ''}`
    case 'note': return `补充${(op.type ?? 'progress') === 'note' ? '备注' : '进展'}：${task}；${note}`
    case 'update': {
      const fields = Object.entries(op)
        .filter(([key]) => !['op', 'id', 'note', 'content', 'notify'].includes(key))
        .map(([key, value]) => `${key}=${value}`)
      return `更新任务信息：${task}${fields.length ? `；${fields.join('，')}` : ''}${note ? `；说明：${note}` : ''}`
    }
    default: return `未知操作：${op.op}`
  }
}

export function buildPublishPreview(spec, reviewPacket, now = new Date().toISOString()) {
  const ops = Array.isArray(spec?.ops) ? spec.ops : []
  const tasks = boardTaskMap(reviewPacket)
  return {
    version: 1,
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
  }
}

export function formatPublishPreview(preview) {
  if (!preview) return '没有待确认的更新预览。'
  const lines = [
    '⏸️ 更新预览（尚未写入看板，尚未触发飞书通知）',
    `快照：${preview.snapshot_id || '未知'}`,
    `对账：共 ${preview.reconciliation.total} 项 · 已映射 ${preview.reconciliation.mapped} · 无关 ${preview.reconciliation.irrelevant} · 待确认 ${preview.reconciliation.needs_confirmation}`,
  ]
  if (!preview.operations.length) {
    lines.push('拟写入：无任务数据变更；确认后仅记录本次全量审查结案，不会发送飞书。')
  } else {
    lines.push(`拟写入与通知：${preview.operations.length} 项`)
    for (const operation of preview.operations) {
      const notification = operation.notification === 'immediate'
        ? '将进入飞书投递队列'
        : operation.notification === 'historical' ? '历史补记，不推送' : '静默，不推送'
      lines.push(`${operation.index}. ${operation.text}`)
      lines.push(`   飞书：${notification}`)
    }
  }
  lines.push('请审核以上内容；同意后请回复“确认推送”。在此之前，任何 apply 都会被机器拒绝。')
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
  if (args.phrase !== CONFIRM_PHRASE) fail(`确认必须显式带 --phrase "${CONFIRM_PHRASE}"`)
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
    confirmation_phrase: CONFIRM_PHRASE,
  }
  writeJsonAtomic(args.approval, approval)
  console.log(`✅ 已记录用户确认；当前快照 ${spec.snapshot_id} 可执行 dashboard:apply。`)
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.command === 'preview') return preview(args)
  if (args.command === 'confirm') return confirm(args)
  if (args.command === 'show') return console.log(formatPublishPreview(readJson(args.preview)))
  fail('用法: dashboard:publish -- preview|show|confirm --phrase "确认推送"')
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
