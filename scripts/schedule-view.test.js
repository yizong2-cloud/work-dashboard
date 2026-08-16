import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMonthCalendar, buildScheduleEntries } from '../src/lib/scheduleView.ts'

const task = (id, title, startDate = null, endDate = null, status = 'in_progress') => ({
  id,
  title,
  start_date: startDate,
  expected_end_date: endDate,
  status,
})
const block = (id, taskId, start, end) => ({
  id,
  task_id: taskId,
  start_date: start,
  end_date: end,
  summary: '',
  status: 'planned',
})

test('月日程只显示有任务日期排期或实际计划块的任务', () => {
  const entries = buildScheduleEntries(
    [
      task('dated', '已有任务排期', '2026-08-17', '2026-08-19'),
      task('block-only', '只有计划块'),
      task('empty', '完全未排期'),
    ],
    [block('visible-block', 'block-only', '2026-08-20', '2026-08-21')],
    '2026-08-17',
    '2026-09-20',
  )

  assert.deepEqual(entries.map((entry) => entry.task.id), ['dated', 'block-only'])
  assert.deepEqual(entries.map((entry) => entry.source), ['task_schedule', 'plan_block'])
})

test('同一任务有计划块时以计划块为准，不重复显示任务日期排期', () => {
  const entries = buildScheduleEntries(
    [task('planned', '已细化计划', '2026-08-17', '2026-08-28')],
    [
      block('phase-one', 'planned', '2026-08-17', '2026-08-19'),
      block('phase-two', 'planned', '2026-08-24', '2026-08-26'),
    ],
    '2026-08-17',
    '2026-09-20',
  )

  assert.deepEqual(entries.map((entry) => entry.id), ['phase-one', 'phase-two'])
  assert.ok(entries.every((entry) => entry.source === 'plan_block'))
})

test('跨越月视图边界的排期仍应显示，区间外排期不显示', () => {
  const entries = buildScheduleEntries(
    [
      task('crossing', '跨边界任务', '2026-08-10', '2026-08-18'),
      task('outside', '区间外任务', '2026-10-01', '2026-10-03'),
    ],
    [],
    '2026-08-17',
    '2026-09-20',
  )

  assert.deepEqual(entries.map((entry) => entry.task.id), ['crossing'])
})

test('自然月按实际日历生成 5 行或 6 行，而不是固定五周', () => {
  const august = buildMonthCalendar('2026-08-01')
  const september = buildMonthCalendar('2026-09-01')

  assert.equal(august.weeks.length, 6)
  assert.equal(august.rangeStart, '2026-07-27')
  assert.equal(august.rangeEnd, '2026-09-06')
  assert.equal(september.weeks.length, 5)
  assert.equal(september.weeks.flat().length, 35)
})
