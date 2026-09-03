import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { approvalMatchesSpec, buildPublishPreview, consumeApproval, formatPublishPreview, markPreviewApplied, specFingerprint } from './publish.mjs'
import { readJson } from './pending.mjs'

const review = {
  snapshot_id: 'snap-publish',
  board: [{ id: 'task-1', title: '成就系统收尾' }],
  review_items: [{ source_id: 'feishu:0' }],
}
const spec = {
  snapshot_id: 'snap-publish',
  reconciliation: [{ source_id: 'feishu:0', decision: 'mapped', task_id: 'task-1' }],
  ops: [{ op: 'progress', id: 'task-1', to: 80, current_status: '联调已验收', progress_basis: 'milestone_ratio', notify_mode: 'merge', note: '已完成联调验收' }],
}

test('发布预览明确列出拟写入内容与飞书意图', () => {
  const preview = buildPublishPreview(spec, review, '2026-08-23T00:00:00Z')
  const text = formatPublishPreview(preview)
  assert.match(text, /尚未写入看板，尚未触发飞书通知/)
  assert.match(text, /更新进度 → 80%/)
  assert.match(text, /T1\. 成就系统收尾/)
  assert.match(text, /同步现状：联调已验收/)
  assert.match(text, /按已完成里程碑计算/)
  assert.match(text, /合并后进入飞书队列/)
  assert.match(text, /无需固定口令/)
})

test('新建任务预览展示所有会影响看板审核的字段', () => {
  const preview = buildPublishPreview({
    ...spec,
    ops: [{
      op: 'create', title: 'Target 36 升级', description: '完成兼容性升级与验证',
      status: 'in_progress', priority: 'high', progress: 25,
      start_date: '2026-09-01', expected_end: '2026-09-05',
      current_status: '调研已完成，准备修改代码', note: 'Leader 安排的新任务',
    }],
  }, review, '2026-09-03T00:00:00Z')
  const text = formatPublishPreview(preview)
  assert.match(text, /完成兼容性升级与验证/)
  assert.match(text, /进行中/)
  assert.match(text, /高/)
  assert.match(text, /25%/)
  assert.match(text, /2026-09-01/)
  assert.match(text, /2026-09-05/)
  assert.match(text, /调研已完成，准备修改代码/)
})

test('发布预览提醒到期未完成和百分比未同步现状，而不是静默制造看板矛盾', () => {
  const risky = buildPublishPreview({
    ...spec,
    ops: [{ op: 'progress', id: 'task-1', to: 70, progress_basis: 'agent_estimate', notify_mode: 'silent', note: '根据对话估算' }],
  }, {
    ...review,
    board: [{ id: 'task-1', title: '成就系统收尾', expected_end_date: '2026-08-22' }],
  }, '2026-08-23T00:00:00Z')
  const text = formatPublishPreview(risky)
  assert.match(text, /Agent 估算（需你确认）/)
  assert.match(text, /预计完成日为 2026-08-22/)
  assert.match(text, /没有同步“当前情况”/)
  assert.match(text, /静默写入，不推送/)
})

test('用户明确百分比在预览里展示可核对的原话', () => {
  const preview = buildPublishPreview({
    ...spec,
    ops: [{
      op: 'progress', id: 'task-1', to: 80, progress_basis: 'user_explicit',
      evidence_quote: '这个任务现在做到 80% 了', current_status: '继续验收',
      notify_mode: 'silent', note: '用户口头同步',
    }],
  }, review, '2026-09-03T00:00:00Z')
  assert.match(formatPublishPreview(preview), /用户原话：这个任务现在做到 80% 了/)
})

test('自然语言确认只能消费与当前快照和变更完全一致的预览', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-publish-'))
  const opsFile = path.join(dir, 'ops.json')
  const reviewFile = path.join(dir, 'review.json')
  const previewFile = path.join(dir, 'preview.json')
  const approvalFile = path.join(dir, 'approval.json')
  fs.writeFileSync(opsFile, JSON.stringify(spec))
  fs.writeFileSync(reviewFile, JSON.stringify(review))
  try {
    const base = ['workflow/publish.mjs', 'preview', '--file', opsFile, '--review', reviewFile, '--preview', previewFile, '--approval', approvalFile]
    const output = execFileSync('node', base, { encoding: 'utf8' })
    assert.match(output, /尚未写入看板/)
    assert.throws(
      () => execFileSync('node', ['workflow/publish.mjs', 'confirm', '--file', opsFile, '--review', reviewFile, '--preview', previewFile, '--approval', approvalFile, '--phrase', '先不要推送'], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('明确同意'),
    )
    execFileSync('node', ['workflow/publish.mjs', 'confirm', '--file', opsFile, '--review', reviewFile, '--preview', previewFile, '--approval', approvalFile, '--phrase', '确认'], { encoding: 'utf8' })
    const approval = readJson(approvalFile)
    assert.equal(approvalMatchesSpec(approval, spec), true)
    assert.equal(approval.confirmation_phrase, '确认')
    consumeApproval(spec, { previewFile, approvalFile, now: '2026-08-23T01:00:00Z' })
    assert.equal(readJson(approvalFile), null)
    assert.equal(readJson(previewFile).state, 'executing')
    markPreviewApplied(spec, 'chg-test', { previewFile, now: '2026-08-23T01:01:00Z' })
    assert.equal(readJson(previewFile).state, 'applied')
    const changed = { ...spec, ops: [{ ...spec.ops[0], to: 81 }] }
    assert.notEqual(specFingerprint(changed), approval.fingerprint)
    assert.equal(approvalMatchesSpec(approval, changed), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
