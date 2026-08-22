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
  ops: [{ op: 'progress', id: 'task-1', to: 80, note: '已完成联调验收' }],
}

test('发布预览明确列出拟写入内容与飞书意图', () => {
  const preview = buildPublishPreview(spec, review, '2026-08-23T00:00:00Z')
  const text = formatPublishPreview(preview)
  assert.match(text, /尚未写入看板，尚未触发飞书通知/)
  assert.match(text, /成就系统收尾 → 80%/)
  assert.match(text, /将进入飞书投递队列/)
  assert.match(text, /确认推送/)
})

test('确认只能消费与当前快照和变更完全一致的预览', () => {
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
      () => execFileSync('node', ['workflow/publish.mjs', 'confirm', '--file', opsFile, '--review', reviewFile, '--preview', previewFile, '--approval', approvalFile, '--phrase', '同意'], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('确认必须显式'),
    )
    execFileSync('node', ['workflow/publish.mjs', 'confirm', '--file', opsFile, '--review', reviewFile, '--preview', previewFile, '--approval', approvalFile, '--phrase', '确认推送'], { encoding: 'utf8' })
    const approval = readJson(approvalFile)
    assert.equal(approvalMatchesSpec(approval, spec), true)
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
