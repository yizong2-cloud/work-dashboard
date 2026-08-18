import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activePlanForDay } from '../src/lib/dailyPlan.ts'

test('日计划幂等规则：同任务同日复用未完成计划，已完成计划可重新安排', () => {
  const blocks = [
    { id: 'active', task_id: 'task-a', start_date: '2026-08-19', end_date: '2026-08-19', status: 'planned' },
    { id: 'done', task_id: 'task-b', start_date: '2026-08-19', end_date: '2026-08-19', status: 'done' },
  ]

  assert.equal(activePlanForDay(blocks, 'task-a', '2026-08-19')?.id, 'active')
  assert.equal(activePlanForDay(blocks, 'task-b', '2026-08-19'), undefined)
  assert.equal(activePlanForDay(blocks, 'task-a', '2026-08-20'), undefined)
})
