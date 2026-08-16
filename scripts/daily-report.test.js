import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDailyReport } from '../src/lib/dailyReport.ts'

const tasks = [
  { id: 'a', title: '任务 A' },
  { id: 'b', title: '任务 B' },
]

test('今日动态按上海日期筛选、按任务分组，并忽略旧留言记录', () => {
  const report = buildDailyReport(tasks, [
    { id: '1', task_id: 'a', type: 'progress', content: '上午完成接口', created_at: '2026-08-16T01:00:00Z' },
    { id: '2', task_id: 'a', type: 'note', content: '💬 Leader 留言', created_at: '2026-08-16T02:00:00Z' },
    { id: '3', task_id: 'b', type: 'blocked', content: '下午遇到阻塞', created_at: '2026-08-16T08:00:00Z' },
    { id: '4', task_id: 'a', type: 'progress', content: '前一天记录', created_at: '2026-08-15T01:00:00Z' },
  ], '2026-08-16')

  assert.equal(report.updateCount, 2)
  assert.deepEqual(report.groups.map((group) => group.task.id), ['b', 'a'])
  assert.deepEqual(report.groups[1].updates.map((update) => update.id), ['1'])
})

test('UTC 跨日时间按上海时区归入正确日报', () => {
  const report = buildDailyReport(tasks, [
    { id: 'late', task_id: 'a', type: 'progress', content: '凌晨进展', created_at: '2026-08-15T16:30:00Z' },
  ], '2026-08-16')

  assert.equal(report.updateCount, 1)
})
