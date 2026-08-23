import type { Task } from '../types'

/**
 * Signals shown at the top of the dashboard.
 *
 * "交付预警" deliberately means a time-bound delivery signal only (overdue or
 * due this week). Missing a planned completion date is a planning-data gap,
 * not evidence that delivery itself has slipped; it therefore remains a
 * separate "待补排期" signal.
 */
export type DashboardWorkFilter = 'all' | 'delivery_warning' | 'blocked' | 'unscheduled'

export type DashboardNextAction = {
  /** Lower ranks are shown first. This is an action order, not a task priority. */
  rank: number
  label: string
  detail: string
}

export function isDashboardActive(task: Task): boolean {
  return task.status === 'in_progress' || task.status === 'blocked' || task.status === 'paused'
}

export function isTaskOverdue(task: Pick<Task, 'expected_end_date' | 'status'>, today: string): boolean {
  return isActiveStatus(task.status) && !!task.expected_end_date && task.expected_end_date < today
}

export function isDueThisWeek(task: Pick<Task, 'expected_end_date'>, today: string, weekStart: string, weekEnd: string): boolean {
  // "本周到期" is an upcoming commitment. A date earlier than today is
  // already represented by "逾期" and must not be counted in both cards.
  return !!task.expected_end_date && task.expected_end_date >= today && task.expected_end_date >= weekStart && task.expected_end_date <= weekEnd
}

export function dashboardWeekRange(today: string): { start: string; end: string } {
  const date = new Date(`${today}T00:00:00`)
  const day = date.getDay() || 7
  date.setDate(date.getDate() - day + 1)
  const start = localDateISO(date)
  const endDate = new Date(`${start}T00:00:00`)
  endDate.setDate(endDate.getDate() + 6)
  return { start, end: localDateISO(endDate) }
}

export function dashboardSignals(tasks: Task[], today: string) {
  const active = tasks.filter(isDashboardActive)
  const week = dashboardWeekRange(today)
  const blocked = active.filter((task) => task.status === 'blocked')
  const dueThisWeek = active.filter((task) => isDueThisWeek(task, today, week.start, week.end))
  const overdue = active.filter((task) => isTaskOverdue(task, today))
  const unscheduled = active.filter((task) => !task.expected_end_date)
  const deliveryWarning = active.filter((task) => isTaskOverdue(task, today) || isDueThisWeek(task, today, week.start, week.end))
  const attention = active.filter((task) => task.status === 'blocked' || isTaskOverdue(task, today))
  return { blocked, dueThisWeek, overdue, unscheduled, deliveryWarning, attention, week }
}

/**
 * Pick the one task that deserves the largest visual treatment on the overview.
 * This intentionally differs from the task-list sort: a high-priority task is
 * not automatically the next thing the owner should do if an older delivery,
 * blocker, or Leader message needs attention first.
 */
export function nextDashboardAction(task: Task, today: string, hasUnresolvedFeedback = false): DashboardNextAction {
  if (task.status === 'blocked') {
    return { rank: 0, label: '先处理阻塞', detail: task.block_reason?.trim() || '需要协调后才能继续推进' }
  }
  if (isTaskOverdue(task, today)) {
    return { rank: 1, label: '先处理逾期', detail: `原计划 ${task.expected_end_date} 完成` }
  }
  if (isDueWithinDays(task, today, 2)) {
    return { rank: 2, label: '临近交付', detail: `预计 ${task.expected_end_date} 完成` }
  }
  if (hasUnresolvedFeedback) {
    return { rank: 3, label: '回应 Leader 留言', detail: '有未解决反馈等待跟进' }
  }
  if (task.priority === 'urgent' || task.priority === 'high') {
    return { rank: 4, label: '推进高优先级', detail: '当前优先级较高，适合作为下一步推进' }
  }
  if (!task.expected_end_date) {
    return { rank: 5, label: '补齐排期', detail: '尚未设置预计完成日期' }
  }
  return { rank: 6, label: '持续推进', detail: task.current_status || '保持当前节奏推进' }
}

export function matchesDashboardFilter(task: Task, filter: DashboardWorkFilter, today: string): boolean {
  if (filter === 'all') return true
  if (filter === 'blocked') return task.status === 'blocked'
  if (filter === 'unscheduled') return !task.expected_end_date
  const week = dashboardWeekRange(today)
  return isTaskOverdue(task, today) || isDueThisWeek(task, today, week.start, week.end)
}

function isActiveStatus(status: Task['status']): boolean {
  return status === 'in_progress' || status === 'blocked' || status === 'paused'
}

function isDueWithinDays(task: Pick<Task, 'expected_end_date'>, today: string, days: number): boolean {
  if (!task.expected_end_date || task.expected_end_date < today) return false
  const deadline = new Date(`${today}T00:00:00`)
  deadline.setDate(deadline.getDate() + days)
  return task.expected_end_date <= localDateISO(deadline)
}

function localDateISO(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
