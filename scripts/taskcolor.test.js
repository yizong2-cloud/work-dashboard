// 任务稳定颜色：同任务恒同色（周/月/卡一致），哈希在 0..keys.length
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TASK_COLOR_KEYS, taskColorIndex, taskColorKey, taskColorClass } from '../src/lib/taskColor.ts'

test('taskColor：同一 taskId 恒同色（稳定性）', () => {
  assert.equal(taskColorIndex('task-abc'), taskColorIndex('task-abc'))
  assert.equal(taskColorKey('task-abc'), taskColorKey('task-abc'))
})
test('taskColor：哈希落在合法调色板范围', () => {
  const idx = taskColorIndex('some-task-id')
  assert.ok(idx >= 0 && idx < TASK_COLOR_KEYS.length)
  assert.ok(TASK_COLOR_KEYS.includes(taskColorKey('some-task-id')))
  assert.match(taskColorClass('some-task-id'), /^[a-z]+$/)
})
test('taskColor：不同任务颜色尽量分散（碰撞率可接受）', () => {
  const seen = new Set()
  for (let i = 0; i < 40; i++) seen.add(taskColorIndex(`id-${i}`))
  assert.ok(seen.size >= 8, `40 个不同任务应分布在至少 8 个色（实际 ${seen.size}）`)
})
