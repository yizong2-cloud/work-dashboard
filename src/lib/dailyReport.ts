import type { Task, TaskUpdate } from '../types'
import { isComment } from './comments.ts'

export interface DailyReportGroup {
  task: Task
  updates: TaskUpdate[]
  latestAt: string
}

export interface DailyReport {
  date: string
  updateCount: number
  groups: DailyReportGroup[]
}

export function shanghaiDate(isoTimestamp: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(isoTimestamp))
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

/** 按上海自然日汇总真实任务时间线；旧版留言不计入工作日报。 */
export function buildDailyReport(tasks: Task[], updates: TaskUpdate[], date: string): DailyReport {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const updatesByTask = new Map<string, TaskUpdate[]>()

  for (const update of updates) {
    if (isComment(update) || shanghaiDate(update.created_at) !== date) continue
    if (!taskById.has(update.task_id)) continue
    const taskUpdates = updatesByTask.get(update.task_id) ?? []
    taskUpdates.push(update)
    updatesByTask.set(update.task_id, taskUpdates)
  }

  const groups = [...updatesByTask.entries()]
    .map(([taskId, taskUpdates]): DailyReportGroup => {
      const ordered = taskUpdates.sort((a, b) => a.created_at.localeCompare(b.created_at))
      return {
        task: taskById.get(taskId)!,
        updates: ordered,
        latestAt: ordered[ordered.length - 1].created_at,
      }
    })
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt))

  return {
    date,
    updateCount: groups.reduce((count, group) => count + group.updates.length, 0),
    groups,
  }
}
