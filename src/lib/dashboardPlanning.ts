import type { Task } from '../types'

export type PlannedStartState = 'awaiting_start' | 'today' | 'upcoming' | 'unscheduled'

/**
 * Copy for a task that has been planned but has not begun yet.
 *
 * A past start date does not make a task overdue by itself: it can be waiting
 * on a dependency and still have a future expected completion date. The
 * dashboard must make that distinction visible instead of calling it “next”.
 */
export function plannedStartPresentation(task: Pick<Task, 'start_date'>, today = localTodayISO()): {
  state: PlannedStartState
  label: string
  needsAttention: boolean
} {
  if (!task.start_date) return { state: 'unscheduled', label: '启动日待定', needsAttention: true }
  if (task.start_date < today) {
    return { state: 'awaiting_start', label: `待启动 · 原定 ${shortStartDate(task.start_date)}`, needsAttention: true }
  }
  if (task.start_date === today) return { state: 'today', label: '今日启动', needsAttention: false }
  return { state: 'upcoming', label: `${shortStartDate(task.start_date)} 启动`, needsAttention: false }
}

function localTodayISO(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function shortStartDate(iso: string): string {
  const [, month, day] = iso.split('-')
  return `${Number(month)}/${Number(day)}`
}
