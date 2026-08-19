import test from 'node:test'
import assert from 'node:assert/strict'
import { taskDataFreshness } from '../src/lib/format.ts'

test('任务更新时间在 24 小时内显示为新鲜', () => {
  const result = taskDataFreshness('2026-08-20T01:00:00Z', new Date('2026-08-20T12:00:00Z'))
  assert.equal(result.tone, 'fresh')
  assert.equal(result.label, '最近任务更新')
})

test('任务更新时间超过 24 小时显示低干扰滞后提示', () => {
  const result = taskDataFreshness('2026-08-18T12:00:00Z', new Date('2026-08-20T12:00:00Z'))
  assert.equal(result.tone, 'stale')
  assert.match(result.detail, /24 小时/)
})

test('没有任务时间线时不伪装成已同步', () => {
  const result = taskDataFreshness(null, new Date('2026-08-20T12:00:00Z'))
  assert.equal(result.tone, 'unknown')
  assert.equal(result.label, '暂无任务更新')
})
