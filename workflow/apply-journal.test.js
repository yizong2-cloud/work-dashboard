import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExecutionPlan, mergeOperationResults } from './apply-journal.mjs'

const ops = [
  { op: 'create', title: '新任务' },
  { op: 'progress', id: 'task-1', to: 80 },
  { op: 'note', id: 'task-2', content: '补记' },
]

test('首次执行包含整批操作', () => {
  assert.deepEqual(buildExecutionPlan(ops, null, 'fp-1').map((entry) => entry.index), [0, 1, 2])
})

test('同一指纹重试只执行上次失败或未执行的操作', () => {
  const previous = {
    fingerprint: 'fp-1', all_ok: false,
    operation_results: [
      { index: 0, ok: true, result_id: 'created-1' },
      { index: 1, ok: false, message: 'temporary failure' },
      { index: 2, ok: true, result_id: 'update-2' },
    ],
  }
  assert.deepEqual(buildExecutionPlan(ops, previous, 'fp-1').map((entry) => entry.index), [1])
  assert.deepEqual(buildExecutionPlan(ops, previous, 'different-fp').map((entry) => entry.index), [0, 1, 2])
})

test('重试结果合并后仍保留原始整批审计记录', () => {
  const previous = {
    fingerprint: 'fp-1', all_ok: false,
    operation_results: [
      { index: 0, ok: true, result_id: 'created-1', attempts: 1 },
      { index: 1, ok: false, message: 'temporary failure', attempts: 1 },
      { index: 2, ok: true, result_id: 'update-2', attempts: 1 },
    ],
  }
  const plan = buildExecutionPlan(ops, previous, 'fp-1')
  const merged = mergeOperationResults(ops, previous, plan, [{ op: 'progress', ok: true, id: 'task-1' }])
  assert.equal(merged.length, 3)
  assert.deepEqual(merged.map((item) => item.ok), [true, true, true])
  assert.equal(merged[0].result_id, 'created-1')
  assert.equal(merged[1].attempts, 2)
})
