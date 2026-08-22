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
      () => execFileSync('node', ['workflow/apply.mjs', '--file', file, '--force'], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('未知操作 "delete"'),
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
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
      () => execFileSync('node', ['workflow/apply.mjs', '--file', file, '--force'], { encoding: 'utf8', stdio: 'pipe' }),
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
    { op: 'progress', to: 80, note: '完成验收' },
    { op: 'note', type: 'note' },
    { op: 'note', type: 'progress', at: '2026-08-21' },
  ]), { immediate: 1, silent: 1, historical: 1 })
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
      () => execFileSync('node', ['workflow/apply.mjs', '--file', file, '--force'], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('必须改用 progress 操作'),
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
})
