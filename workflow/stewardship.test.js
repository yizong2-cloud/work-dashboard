import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStewardshipReport, formatStewardshipReport } from './stewardship.mjs'

const now = new Date('2026-08-24T09:00:00+08:00')
const task = (id, title, patch = {}) => ({
  id, title, status: 'in_progress', priority: 'normal', progress: 20,
  updated_at: '2026-08-23T09:00:00+08:00', current_status: '正在推进',
  expected_end_date: '2026-08-30', actual_end_date: null, ...patch,
})

test('治理体检只输出可行动线索，并把阻塞的事实改变留在确认路径', () => {
  const report = buildStewardshipReport({
    now,
    tasks: [
      task('late', '逾期任务', { expected_end_date: '2026-08-22', updated_at: '2026-08-10T09:00:00+08:00' }),
      task('gap', '待补状态', { current_status: '', expected_end_date: null }),
      task('same-a', '重复任务'),
      task('same-b', '重复-任务'),
      task('done', '完成异常', { status: 'completed', progress: 70, actual_end_date: null }),
    ],
    updates: [{ id: 'orphan', task_id: 'gone', type: 'note', created_at: '2026-08-20T09:00:00+08:00' }],
    instructions: [{ id: 'inbox-1', task_id: 'gap', status: 'open', updated_at: '2026-08-24T08:00:00+08:00', latest_message: '请核对日期' }],
    planBlocks: [],
  })

  assert.equal(report.mode, 'read_only')
  assert.equal(report.counts.agent_inbox, 1)
  assert.equal(report.counts.overdue, 1)
  assert.equal(report.counts.stale, 1)
  assert.equal(report.counts.missing_current_status, 1)
  assert.equal(report.counts.missing_schedule, 1)
  assert.equal(report.counts.completed_inconsistent, 1)
  assert.equal(report.counts.duplicate_candidates, 1)
  assert.equal(report.counts.orphan_updates, 1)
  assert.match(formatStewardshipReport(report), /只读/)
  assert.match(report.policy, /不会改写/)
})

test('已有近期日计划的本周承诺不会被误报为未拆日计划', () => {
  const report = buildStewardshipReport({
    now,
    tasks: [task('planned', '本周交付', { expected_end_date: '2026-08-27' })],
    planBlocks: [{ id: 'p1', task_id: 'planned', start_date: '2026-08-25', end_date: '2026-08-26', status: 'planned' }],
  })
  assert.equal(report.counts.upcoming_without_plan, 0)
  assert.equal(report.counts.stale, 0)
})
