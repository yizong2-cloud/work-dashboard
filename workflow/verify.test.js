import test from 'node:test'
import assert from 'node:assert/strict'
import { validateTaskInvariants } from './verify.mjs'

test('active tasks may not retain an actual completion date', () => {
  assert.deepEqual(validateTaskInvariants([{
    title: '重新打开的任务', status: 'in_progress', progress: 95,
    actual_end_date: '2026-08-20', block_reason: '',
  }]), ['未完成任务残留实际完成日期: 重新打开的任务（status=in_progress, actual=2026-08-20）'])
})

test('completed and blocked invariants remain enforced', () => {
  const issues = validateTaskInvariants([
    { title: '伪完成', status: 'completed', progress: 90, actual_end_date: null, block_reason: '' },
    { title: '空阻塞', status: 'blocked', progress: 50, actual_end_date: null, block_reason: ' ' },
  ])
  assert.equal(issues.length, 2)
  assert.match(issues[0], /completed 但不完整/)
  assert.match(issues[1], /blocked 无原因/)
})
