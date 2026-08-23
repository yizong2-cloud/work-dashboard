import type { PlanBlock, Task } from '../types'

export interface ScheduleEntry {
  id: string
  task: Task
  source: 'task_schedule' | 'plan_block'
  startDate: string
  endDate: string
  label: string
  block?: PlanBlock
}

export interface MonthCalendar {
  rangeStart: string
  rangeEnd: string
  weeks: string[][]
}

/**
 * Signals for the weekly planning view.
 *
 * A commitment due earlier than today is an overdue item, not a remaining
 * commitment for this week. Keeping the two lists separate prevents a missed
 * date from being presented as if it were still an upcoming plan.
 */
export function buildWeekScheduleSignals(tasks: Task[], weekStart: string, weekEnd: string, today: string) {
  const active = tasks.filter((task) => ['in_progress', 'planned', 'blocked', 'paused'].includes(task.status))
  const weekPromises = active
    .filter((task) => task.expected_end_date && task.expected_end_date >= today && task.expected_end_date <= weekEnd)
    .sort((a, b) => (a.expected_end_date || '').localeCompare(b.expected_end_date || ''))
  const overdue = active.filter((task) => task.expected_end_date && task.expected_end_date < today)
  const unscheduled = active
    .filter((task) => !task.expected_end_date)
    .sort((a, b) => schedulingPriority(a) - schedulingPriority(b) || b.progress - a.progress || a.title.localeCompare(b.title, 'zh-CN'))
  const risks = active.filter((task) => task.status === 'blocked' || task.priority === 'urgent')
  return { active, weekPromises, overdue, unscheduled, risks, weekStart, weekEnd }
}

function schedulingPriority(task: Task): number {
  if (task.status === 'blocked') return -1
  return ({ urgent: 0, high: 1, normal: 2, low: 3 } as const)[task.priority] ?? 2
}

/** A transparent explanation for the small weekly recommendation queue. */
export function schedulingRecommendation(task: Task): string {
  if (task.status === 'blocked') return '阻塞任务尚未定期，先明确协调后的完成预期'
  if (task.priority === 'urgent') return '加急任务，建议优先明确本周完成预期'
  if (task.priority === 'high') return '高优先级任务，建议先落下预计完成日'
  if (task.progress >= 80) return '已接近交付，补日期能更早暴露风险'
  return '活跃任务尚未排期，建议明确完成预期'
}

function dateParts(iso: string) {
  const [year, month, day] = iso.split('-').map(Number)
  return { year, month, day }
}

function isoFromUTC(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}-${day}`
}

function addDays(iso: string, amount: number): string {
  const { year, month, day } = dateParts(iso)
  return isoFromUTC(new Date(Date.UTC(year, month - 1, day + amount)))
}

function addMonths(monthStart: string, amount: number): string {
  const { year, month } = dateParts(monthStart)
  return isoFromUTC(new Date(Date.UTC(year, month - 1 + amount, 1)))
}

function daysBetween(from: string, to: string): number {
  const a = dateParts(from)
  const b = dateParts(to)
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000)
}

function mondayIndex(iso: string): number {
  const { year, month, day } = dateParts(iso)
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7
}

/** 自然月日历：周一开头，按该月实际需要返回 5 行或 6 行。 */
export function buildMonthCalendar(monthStart: string): MonthCalendar {
  const monthEnd = addDays(addMonths(monthStart, 1), -1)
  const rangeStart = addDays(monthStart, -mondayIndex(monthStart))
  const rangeEnd = addDays(monthEnd, 6 - mondayIndex(monthEnd))
  const days = Array.from(
    { length: daysBetween(rangeStart, rangeEnd) + 1 },
    (_, index) => addDays(rangeStart, index),
  )
  const weeks = Array.from(
    { length: days.length / 7 },
    (_, index) => days.slice(index * 7, index * 7 + 7),
  )
  return { rangeStart, rangeEnd, weeks }
}

function overlaps(startDate: string, endDate: string, rangeStart: string, rangeEnd: string) {
  return startDate <= rangeEnd && endDate >= rangeStart
}

/**
 * 统一月日程中的两种真实排期：
 * 1. 任务本身的开始日 ~ 预计完成日；
 * 2. 更具体的日计划块。
 * 同一任务在当前区间有计划块时，以计划块为准，避免重复展示两套横条。
 */
export function buildScheduleEntries(
  tasks: Task[],
  blocks: PlanBlock[],
  rangeStart: string,
  rangeEnd: string,
): ScheduleEntry[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const visibleBlocks = blocks.filter((block) =>
    overlaps(block.start_date, block.end_date, rangeStart, rangeEnd),
  )
  const tasksWithBlocks = new Set(visibleBlocks.map((block) => block.task_id))

  const taskScheduleEntries = tasks
    .filter((task) =>
      task.status !== 'cancelled' &&
      !tasksWithBlocks.has(task.id) &&
      Boolean(task.start_date) &&
      Boolean(task.expected_end_date) &&
      overlaps(task.start_date!, task.expected_end_date!, rangeStart, rangeEnd),
    )
    .map((task): ScheduleEntry => ({
      id: `task:${task.id}`,
      task,
      source: 'task_schedule',
      startDate: task.start_date!,
      endDate: task.expected_end_date!,
      label: task.title,
    }))

  const blockEntries = visibleBlocks
    .map((block): ScheduleEntry | null => {
      const task = taskById.get(block.task_id)
      if (!task) return null
      return {
        id: block.id,
        task,
        source: 'plan_block',
        startDate: block.start_date,
        endDate: block.end_date,
        label: block.summary || task.title,
        block,
      }
    })
    .filter((entry): entry is ScheduleEntry => entry !== null)

  return [...taskScheduleEntries, ...blockEntries].sort((a, b) => {
    const byStart = a.startDate.localeCompare(b.startDate)
    if (byStart !== 0) return byStart
    const byEnd = b.endDate.localeCompare(a.endDate)
    if (byEnd !== 0) return byEnd
    return a.task.title.localeCompare(b.task.title, 'zh-CN')
  })
}
