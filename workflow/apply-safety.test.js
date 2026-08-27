import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { notificationIntentFor, summarizeNotificationIntents } from './apply.mjs'

test('apply 只读取当前快照，不把最近健康副本当成写入依据', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'workflow', 'apply.mjs'), 'utf8')
  assert.doesNotMatch(source, /last-healthy|lastHealthy/i)
})

test('自动化 apply 拒绝 delete 操作，删除不进入普通更新通道', () => {
  const file = path.join(os.tmpdir(), `workboard-delete-${Date.now()}.json`)
  const context = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'update-context.json'), 'utf8'))
  const packet = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'review-packet.json'), 'utf8'))
  const reconciliation = packet.review_items.map((item) => ({ source_id: item.source_id, decision: 'irrelevant' }))
  fs.writeFileSync(file, JSON.stringify({ snapshot_id: context.snapshot_id, reconciliation, ops: [{ op: 'delete', id: 'task-1' }] }))
  try {
    assert.throws(
      () => execFileSync('node', ['workflow/apply.mjs', '--file', file, '--dry-run'], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('未知操作 "delete"'),
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('apply 的 --force 不能绕过任何安全闸门', () => {
  assert.throws(
    () => execFileSync('node', ['workflow/apply.mjs', '--force'], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('不再支持 --force'),
  )
})

test('apply 不允许带着 needs_confirmation 写入看板', () => {
  const file = path.join(os.tmpdir(), `workboard-pending-${Date.now()}.json`)
  const context = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'update-context.json'), 'utf8'))
  const packet = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'review-packet.json'), 'utf8'))
  const reconciliation = packet.review_items.map((item, index) => ({
    source_id: item.source_id,
    decision: index === 0 ? 'needs_confirmation' : 'irrelevant',
    ...(index === 0 ? { reason: '归属不明确' } : {}),
  }))
  fs.writeFileSync(file, JSON.stringify({ snapshot_id: context.snapshot_id, reconciliation, ops: [] }))
  try {
    assert.throws(
      () => execFileSync('node', ['workflow/apply.mjs', '--file', file, '--dry-run'], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('待确认'),
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('通知意图与百分比进度字段语义独立', () => {
  assert.equal(notificationIntentFor({ op: 'note', type: 'note' }), 'silent')
  assert.equal(notificationIntentFor({ op: 'note', type: 'progress' }), 'immediate')
  assert.deepEqual(summarizeNotificationIntents([
    { op: 'progress', to: 80, note: '完成验收', notify_mode: 'merge' },
    { op: 'note', type: 'note' },
    { op: 'note', type: 'progress', at: '2026-08-21' },
  ]), { immediate: 0, merge: 1, silent: 1, historical: 1 })
})

test('通知模式可独立于看板写入选择即时、合并或静默', () => {
  assert.equal(notificationIntentFor({ op: 'complete', notify_mode: 'silent' }), 'silent')
  assert.equal(notificationIntentFor({ op: 'progress', notify_mode: 'merge' }), 'merge')
  assert.equal(notificationIntentFor({ op: 'update', current_status: '完成', notify_mode: 'silent' }), 'silent')
})

test('workflow 操作必须显式声明通知模式，避免预览与 batch 默认行为不一致', () => {
  const file = path.join(os.tmpdir(), `workboard-notify-mode-${Date.now()}.json`)
  const context = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'update-context.json'), 'utf8'))
  const packet = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'review-packet.json'), 'utf8'))
  const reconciliation = packet.review_items.map((item) => ({ source_id: item.source_id, decision: 'reviewed_no_change' }))
  fs.writeFileSync(file, JSON.stringify({
    snapshot_id: context.snapshot_id,
    reconciliation,
    ops: [{ op: 'note', id: 'task-1', type: 'note', content: '只写一个备注' }],
  }))
  try {
    assert.throws(
      () => execFileSync('node', ['workflow/apply.mjs', '--file', file, '--dry-run'], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('必须显式提供 notify_mode'),
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('百分比进度不能只写 progress note 而不更新任务字段', () => {
  const file = path.join(os.tmpdir(), `workboard-progress-note-${Date.now()}.json`)
  const context = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'update-context.json'), 'utf8'))
  const packet = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'review-packet.json'), 'utf8'))
  const reconciliation = packet.review_items.map((item) => ({ source_id: item.source_id, decision: 'irrelevant' }))
  fs.writeFileSync(file, JSON.stringify({
    snapshot_id: context.snapshot_id,
    reconciliation,
    ops: [{ op: 'note', id: 'task-1', type: 'progress', content: '排行榜调研进度提升至 80%' }],
  }))
  try {
    assert.throws(
      () => execFileSync('node', ['workflow/apply.mjs', '--file', file, '--dry-run'], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('必须改用 progress 操作'),
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('精确百分比必须标注来源口径，不能把 Agent 模糊判断伪装成事实', () => {
  const file = path.join(os.tmpdir(), `workboard-progress-basis-${Date.now()}.json`)
  const context = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'update-context.json'), 'utf8'))
  const packet = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'review-packet.json'), 'utf8'))
  const reconciliation = packet.review_items.map((item) => ({ source_id: item.source_id, decision: 'reviewed_no_change' }))
  fs.writeFileSync(file, JSON.stringify({
    snapshot_id: context.snapshot_id,
    reconciliation,
    ops: [{ op: 'progress', id: 'task-1', to: 70, note: '进度不错，所以估算为 70%' }],
  }))
  try {
    assert.throws(
      () => execFileSync('node', ['workflow/apply.mjs', '--file', file, '--dry-run'], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('progress_basis'),
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('Agent 估算使用阶段锚点，拒绝 92% 这类伪精度', () => {
  const file = path.join(os.tmpdir(), `workboard-progress-anchor-${Date.now()}.json`)
  const context = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'update-context.json'), 'utf8'))
  const packet = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'review-packet.json'), 'utf8'))
  const reconciliation = packet.review_items.map((item) => ({ source_id: item.source_id, decision: 'reviewed_no_change' }))
  fs.writeFileSync(file, JSON.stringify({
    snapshot_id: context.snapshot_id,
    reconciliation,
    ops: [{ op: 'progress', id: 'task-1', to: 92, note: 'Agent 综合判断', progress_basis: 'agent_estimate', notify_mode: 'silent' }],
  }))
  try {
    assert.throws(
      () => execFileSync('node', ['workflow/apply.mjs', '--file', file, '--dry-run'], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('阶段锚点'),
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('实际 apply 没有当前预览确认时必须停止', () => {
  const file = path.join(os.tmpdir(), `workboard-unapproved-${Date.now()}.json`)
  const context = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'update-context.json'), 'utf8'))
  const packet = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'review-packet.json'), 'utf8'))
  const reconciliation = packet.review_items.map((item) => ({ source_id: item.source_id, decision: 'irrelevant' }))
  fs.writeFileSync(file, JSON.stringify({ snapshot_id: context.snapshot_id, reconciliation, ops: [] }))
  try {
    assert.throws(
      () => execFileSync('node', ['workflow/apply.mjs', '--file', file], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('确认推送'),
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
})
