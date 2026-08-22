import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPendingPlan, pendingForSnapshot, readJson } from './pending.mjs'

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
  assert.match(plan.questions[0].candidates[0], /排行榜研究/)
  assert.equal(pendingForSnapshot(plan, 'snap-pending'), true)
  assert.equal(pendingForSnapshot(plan, 'other-snapshot'), false)
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
      '--source', 'dsh:0', '--decision', 'mapped', '--task', 'task-rank', '--reason', '用户确认归入排行榜研究',
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
