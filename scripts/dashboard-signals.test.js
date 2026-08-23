import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dashboardSignals, matchesDashboardFilter, nextDashboardAction } from '../src/lib/dashboardSignals.ts'

const task = (id, status, expected_end_date = null) => ({
  id,
  title: id,
  status,
  expected_end_date,
})

test('看板把真实交付预警和待补排期分开，避免把缺日期误称为逾期风险', () => {
  const blockedWithoutDate = task('blocked-no-date', 'blocked')
  const overdue = task('overdue', 'in_progress', '2026-08-19')
  const dueSunday = task('due-this-week', 'in_progress', '2026-08-23')
  const unscheduled = task('unscheduled', 'in_progress')
  const nextWeek = task('next-week', 'in_progress', '2026-08-25')
  const signals = dashboardSignals([blockedWithoutDate, overdue, dueSunday, unscheduled, nextWeek], '2026-08-23')

  assert.deepEqual(signals.deliveryWarning.map((item) => item.id), ['overdue', 'due-this-week'])
  assert.deepEqual(signals.dueThisWeek.map((item) => item.id), ['due-this-week'])
  assert.deepEqual(signals.unscheduled.map((item) => item.id), ['blocked-no-date', 'unscheduled'])
  assert.deepEqual(signals.attention.map((item) => item.id), ['blocked-no-date', 'overdue'])
  assert.equal(matchesDashboardFilter(unscheduled, 'delivery_warning', '2026-08-23'), false)
  assert.equal(matchesDashboardFilter(dueSunday, 'delivery_warning', '2026-08-23'), true)
  assert.equal(matchesDashboardFilter(blockedWithoutDate, 'blocked', '2026-08-23'), true)
})

test('首页下一步行动按阻塞、逾期、临近交付、留言和优先级排序，而不是只看任务优先级', () => {
  const blocked = { ...task('blocked', 'blocked'), block_reason: '等待接口确认', priority: 'low' }
  const overdue = { ...task('overdue', 'in_progress', '2026-08-22'), priority: 'low' }
  const dueSoon = { ...task('due-soon', 'in_progress', '2026-08-25'), priority: 'normal' }
  const high = { ...task('high', 'in_progress', '2026-09-01'), priority: 'high' }

  assert.equal(nextDashboardAction(blocked, '2026-08-23').rank, 0)
  assert.equal(nextDashboardAction(overdue, '2026-08-23').rank, 1)
  assert.equal(nextDashboardAction(dueSoon, '2026-08-23').rank, 2)
  assert.equal(nextDashboardAction(high, '2026-08-23', true).rank, 3)
  assert.equal(nextDashboardAction(high, '2026-08-23').rank, 4)
})
