import { useMemo, useState } from 'react'
import type { PlanBlock, Task } from '../types'
import { buildScheduleEntries, buildWeekScheduleSignals, schedulingRecommendation, selectTodayFocus } from '../lib/scheduleView'
import { taskColorClass } from '../lib/taskColor'
import { TaskQuickCard } from './TaskQuickCard'
import { shortDate, todayISO } from '../lib/format'

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
// 容量阈值：某天计划块条数达到该值即提示"已安排 N 项"（N 是计划块数量，不是小时数）
const MAX_PLANS_PER_DAY = 3

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
/** 本周（周一~周日） */
export function weekOf(iso: string): string[] {
  const { year, month, day } = dateParts(iso)
  const dow = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7
  const monday = isoFromUTC(new Date(Date.UTC(year, month - 1, day - dow)))
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
}

export function ScheduleWeek({
  tasks,
  blocks,
  onPlanToday,
  onQuickProgress,
  onQuickSchedule,
  onOpenTask,
}: {
  tasks: Task[]
  blocks: PlanBlock[]
  onPlanToday: (taskId: string) => void
  onQuickProgress: (taskId: string) => void
  onQuickSchedule: (taskId: string) => void
  onOpenTask: (taskId: string) => void
}) {
  const today = todayISO()
  const week = useMemo(() => weekOf(today), [today])
  const [activeTask, setActiveTask] = useState<Task | null>(null)

  const signals = useMemo(() => buildWeekScheduleSignals(tasks, week[0], week[6], today), [tasks, week, today])
  const { weekPromises, overdue, unscheduled, risks } = signals
  const entries = useMemo(
    () => buildScheduleEntries(tasks, blocks, week[0], week[6]),
    [tasks, blocks, week],
  )

  const plannedToday = useMemo(
    () => new Set(blocks.filter((b) => b.start_date <= today && b.end_date >= today && b.status !== 'done').map((b) => b.task_id)),
    [blocks, today],
  )
  const todayPlanTasks = useMemo(() => {
    const taskById = new Map<string, Task>()
    entries
      .filter((entry) => entry.source === 'plan_block' && entry.startDate <= today && entry.endDate >= today && entry.block?.status !== 'done')
      .forEach((entry) => taskById.set(entry.task.id, entry.task))
    return [...taskById.values()]
  }, [entries, today])
  const todayFocus = useMemo(
    () => selectTodayFocus(weekPromises, unscheduled, plannedToday),
    [weekPromises, unscheduled, plannedToday],
  )

  function dayPlans(day: string) {
    return entries.filter((e) => e.source === 'plan_block' && e.startDate <= day && e.endDate >= day)
  }

  return (
    <div className="week-view">
      {/* 顶部行动摘要 */}
      <section className="card week-summary" aria-label="本周行动摘要">
        <div className="week-summary-item"><span>本周承诺</span><strong>{weekPromises.length}</strong></div>
        <div className="week-summary-item is-risk"><span>逾期</span><strong>{overdue.length}</strong></div>
        <div className="week-summary-item is-warn"><span>待补排期</span><strong>{unscheduled.length}</strong></div>
        <div className="week-summary-item is-risk"><span>需处理（阻塞/加急）</span><strong>{risks.length}</strong></div>
      </section>

      <section className="card week-today-focus" aria-label="今日安排建议">
        <div className="week-today-focus-heading">
          <span className="eyebrow">Today</span>
          <h2>{todayPlanTasks.length > 0 ? `今天已安排 ${todayPlanTasks.length} 项` : '今天先做什么'}</h2>
        </div>
        {todayPlanTasks.length > 0 ? (
          <div className="week-today-focus-content">
            <p>这些任务已有具体日计划；点击可查看或调整。</p>
            <div className="week-today-task-list">
              {todayPlanTasks.map((task) => (
                <button key={task.id} className={`week-today-task task-color-bar-${taskColorClass(task.id)}`} onClick={() => setActiveTask(task)}>
                  {task.title}
                </button>
              ))}
            </div>
          </div>
        ) : todayFocus ? (
          <div className="week-today-focus-content is-suggested">
            <div>
              <strong>{todayFocus.task.title}</strong>
              <p>{todayFocus.reason}</p>
            </div>
            <div className="week-today-actions">
              <button className="primary-btn compact" onClick={() => onPlanToday(todayFocus.task.id)}>＋安排到今天</button>
              <button className="secondary-btn compact" onClick={() => setActiveTask(todayFocus.task)}>查看任务</button>
            </div>
          </div>
        ) : (
          <p className="week-today-empty">今天暂无需要补充的日计划。</p>
        )}
      </section>

      <div className="week-layout">
        {/* 左侧：本周承诺 */}
        <aside className="week-task-pool card">
          <div className="panel-heading"><div><span className="eyebrow">This week</span><h2>本周承诺</h2></div></div>
          {weekPromises.length === 0 ? (
            <p className="muted">本周无到期承诺。</p>
          ) : (
            <ul className="week-promise-list">
              {weekPromises.map((t) => (
                <li key={t.id}>
                  <button
                    className={`task-chip task-color-bar-${taskColorClass(t.id)} ${t.status === 'blocked' ? 'is-blocked' : ''} ${t.priority === 'urgent' ? 'is-urgent' : ''} ${overdue.some((o) => o.id === t.id) ? 'is-overdue' : ''}`}
                    onClick={() => setActiveTask(t)}
                  >
                    <span className="task-chip-title">{t.title}</span>
                    <span className="task-chip-meta">{shortDate(t.expected_end_date!)} · {t.progress}%</span>
                  </button>
                  <button className="task-chip-quick" disabled={plannedToday.has(t.id)} onClick={() => onPlanToday(t.id)} title={plannedToday.has(t.id) ? '今天已安排' : '安排到今天'}>
                    {plannedToday.has(t.id) ? '已安排' : '＋今天'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <section className="week-gap-section" aria-label="待补排期任务">
            <div className="week-gap-heading">
              <div><span className="eyebrow">Suggested first</span><h3>本周建议先排</h3></div>
              <strong>{unscheduled.length}</strong>
            </div>
            <p>按阻塞 / 优先级 / 当前进度排序；仅给建议，不会自动改日期。</p>
            {unscheduled.length === 0 ? <p className="muted">所有活跃任务均已设置预计完成日。</p> : (
              <ul className="week-promise-list week-gap-list">
                {unscheduled.slice(0, 3).map((t) => (
                  <li key={t.id}>
                    <button className={`task-chip task-color-bar-${taskColorClass(t.id)}`} onClick={() => setActiveTask(t)}>
                      <span className="task-chip-title">{t.title}</span>
                      <span className="task-chip-meta">{schedulingRecommendation(t)}</span>
                    </button>
                    <button className="task-chip-quick" onClick={() => onQuickSchedule(t.id)} title="直接打开预计完成日期表单">补日期</button>
                  </li>
                ))}
              </ul>
            )}
            {unscheduled.length > 3 && <p className="week-gap-more">另有 {unscheduled.length - 3} 项待补；完整清单仍可逐项进入详情处理。</p>}
          </section>
        </aside>

        {/* 中间：本周时间轴 */}
        <section className="week-timeline card">
          <div className="panel-heading"><div><span className="eyebrow">Plan</span><h2>本周安排</h2></div></div>
          <div className="week-grid">
            <div className="week-head empty-weekhead" />
            {week.map((day) => {
              const planCount = dayPlans(day).length
              return (
                <div key={day} className={`week-head${day === today ? ' is-today' : ''}`}>
                  <strong>{WEEKDAYS[week.indexOf(day)]}</strong>
                  <span>{Number(day.slice(8))}</span>
                  <small className={planCount > 0 ? 'has-plans' : ''}>{planCount > 0 ? `${planCount} 项计划` : '未安排'}</small>
                </div>
              )
            })}
            <div className="week-body-title">计划</div>
            {week.map((day) => {
              const plans = dayPlans(day)
              const overload = plans.length >= MAX_PLANS_PER_DAY
              const overdueTasksOnDay = overdue.filter((t) => t.expected_end_date === day)
              return (
                <div key={day} className={`week-day${day === today ? ' is-today' : ''}`}>
                  {plans.length === 0 && overdueTasksOnDay.length === 0 ? <span className="week-day-empty" /> :
                    <>
                      {plans.map((e) => {
                        const risk = e.task.status === 'blocked' ? 'is-blocked' : e.task.priority === 'urgent' ? 'is-urgent' : ''
                        return (
                          <button
                            key={e.id}
                            className={`week-plan task-color-solid-${taskColorClass(e.task.id)}${e.block?.status === 'done' ? ' is-done' : ''} ${risk}`}
                            onClick={() => setActiveTask(e.task)}
                            title={e.task.title}
                          >
                            <span className="week-plan-title">{e.task.title}</span>
                            {e.label && <small>{e.label}</small>}
                          </button>
                        )
                      })}
                      {overdueTasksOnDay.map((t) => (
                        <button key={`ov:${t.id}`} className="week-risk day-overdue" onClick={() => setActiveTask(t)} title={`${t.title} 已逾期（原计划 ${shortDate(t.expected_end_date!)}）`}>
                          ⚠️ {t.title}（逾期）
                        </button>
                      ))}
                    </>
                  }
                  {overload && <span className="week-overload">已安排 {plans.length} 项</span>}
                </div>
              )
            })}
          </div>
          <div className="week-legend">
            <span><i className="legend-plan-dark" />具体日计划</span>
            <span><i className="legend-risk-line" />阻塞 / 加急（边框）</span>
            <span><i className="legend-overdue-dot" />逾期</span>
            <span>同一任务格子同色</span>
          </div>
        </section>
      </div>

      {/* 就地操作卡（共享组件，周视图/月历一致） */}
      {activeTask && (
        <TaskQuickCard
          task={activeTask}
          blocks={blocks}
          onPlanToday={onPlanToday}
          onQuickProgress={onQuickProgress}
          onOpenTask={onOpenTask}
          onClose={() => setActiveTask(null)}
        />
      )}
    </div>
  )
}
