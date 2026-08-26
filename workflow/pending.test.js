import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPendingPlan, formatPendingPlan, pendingForSnapshot, readJson } from './pending.mjs'

const reviewPacket = {
  snapshot_id: 'snap-pending',
  review_items: [{
    source_id: 'dsh:0', source: 'dsh', excerpt: '排行榜系统是否有成就入口？',
    candidate_tasks: ['排行榜研究'],
  }],
}
const spec = {
  snapshot_id: 'snap-pending',
  reconciliation: [{ source_id: 'dsh:0', decision: 'needs_confirmation', reason: '候选任务无法唯一判断' }],
  ops: [],
}

test('pending plan keeps a concise, snapshot-bound question', () => {
  const plan = buildPendingPlan(spec, reviewPacket, '2026-08-22T00:00:00Z')
  assert.equal(plan.state, 'awaiting_confirmation')
  assert.equal(plan.questions[0].source_id, 'dsh:0')
  assert.equal(plan.questions[0].question_id, 'Q1')
  assert.match(plan.questions[0].candidates[0], /排行榜研究/)
  const text = formatPendingPlan(plan)
  assert.match(text, /Q1 · 请确认这段工作信息应如何处理/)
  assert.match(text, /DSH 工作会话/)
  assert.match(text, /原始内容：排行榜系统是否有成就入口/)
  assert.match(text, /追踪信息（无需理解或照抄）：dsh:0/)
  assert.equal(pendingForSnapshot(plan, 'snap-pending'), true)
  assert.equal(pendingForSnapshot(plan, 'other-snapshot'), false)
})

test('question ids stay stable when an earlier question is resolved', () => {
  const twoQuestionSpec = {
    ...spec,
    reconciliation: [
      spec.reconciliation[0],
      { source_id: 'codex:1', decision: 'needs_confirmation', reason: '归属不明确' },
    ],
  }
  const twoQuestionReview = {
    ...reviewPacket,
    review_items: [...reviewPacket.review_items, { source_id: 'codex:1', source: 'codex', label: '/repo/b', excerpt: '完成了测试' }],
  }
  const first = buildPendingPlan(twoQuestionSpec, twoQuestionReview, '2026-08-22T00:00:00Z')
  const remaining = buildPendingPlan({
    ...twoQuestionSpec,
    reconciliation: [{ source_id: 'dsh:0', decision: 'reviewed_no_change' }, twoQuestionSpec.reconciliation[1]],
  }, twoQuestionReview, '2026-08-22T01:00:00Z', first)
  assert.equal(remaining.questions[0].source_id, 'codex:1')
  assert.equal(remaining.questions[0].question_id, 'Q2')
})

test('resolve updates only the confirmed source and closes the pending plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-pending-'))
  const opsFile = path.join(dir, 'ops.json')
  const reviewFile = path.join(dir, 'review.json')
  const pendingFile = path.join(dir, 'pending.json')
  fs.writeFileSync(opsFile, JSON.stringify(spec))
  fs.writeFileSync(reviewFile, JSON.stringify(reviewPacket))
  try {
    assert.throws(
      () => execFileSync('node', ['workflow/pending.mjs', 'hold', '--file', opsFile, '--review', reviewFile, '--pending', pendingFile], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => error.status === 2,
    )
    execFileSync('node', [
      'workflow/pending.mjs', 'resolve', '--file', opsFile, '--review', reviewFile, '--pending', pendingFile,
      '--question', 'Q1', '--decision', 'mapped', '--task', 'task-rank', '--reason', '用户确认归入排行榜研究',
    ], { encoding: 'utf8', stdio: 'pipe' })
    const resolved = readJson(opsFile)
    assert.deepEqual(resolved.reconciliation[0], {
      source_id: 'dsh:0', decision: 'mapped', task_id: 'task-rank', reason: '用户确认归入排行榜研究',
    })
    assert.equal(readJson(pendingFile).state, 'resolved')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
