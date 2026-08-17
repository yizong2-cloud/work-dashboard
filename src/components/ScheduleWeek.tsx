import { useMemo, useState } from 'react'
import type { PlanBlock, Task } from '../types'
import type { DB } from '../lib/db'
import { buildScheduleEntries } from '../lib/scheduleView'
import { taskColorClass } from '../lib/taskColor'
import { TaskQuickCard } from './TaskQuickCard'
import { shortDate, todayISO } from '../lib/format'

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const MIN_PLAN_PER_DAY = 3 // 容量提示阈值

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
/** 本周（周一~周日，北京时间） */
function weekOf(iso: string): string[] {
  const { year, month, day } = dateParts(iso)
  const dow = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7
  const monday = isoFromUTC(new Date(Date.UTC(year, month - 1, day - dow)))
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
}

export function ScheduleWeek({
  tasks,
  blocks,
  db,
  onQuickProgress,
  onOpenTask,
  onPlanned,
}: {
  tasks: Task[]
  blocks: PlanBlock[]
  db: DB
  onQuickProgress: (taskId: string) => void
  onOpenTask: (taskId: string) => void
  onPlanned?: () => void
}) {
  const today = todayISO()
  const week = useMemo(() => weekOf(today), [today])
  const [activeTask, setActiveTask] = useState<Task | null>(null)

  const active = useMemo(
    () => tasks.filter((t) => ['in_progress', 'planned', 'blocked', 'paused'].includes(t.status)),
    [tasks],
  )
  const entries = useMemo(
    () => buildScheduleEntries(tasks, blocks, week[0], week[6]),
    [tasks, blocks, week],
  )
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  // 本周承诺：预计完成在本周 且 未完成
  const weekPromises = useMemo(
    () => active
      .filter((t) => t.expected_end_date && t.expected_end_date >= week[0] && t.expected_end_date <= week[6])
      .sort((a, b) => (a.expected_end_date || '').localeCompare(b.expected_end_date || '')),
    [active, week],
  )
  const overdue = active.filter((t) => t.expected_end_date && t.expected_end_date < today)
  const unscheduled = active.filter((t) => !t.expected_end_date)
  const risks = active.filter((t) => t.status === 'blocked' || t.priority === 'urgent')

  // 某天要展示的「计划块」（深色）与「到期任务」（浅色：该天是某承诺的开始/截止）
  function dayPlans(day: string) {
    return entries.filter((e) => e.source === 'plan_block' && e.startDate <= day && e.endDate >= day)
  }

  async function planForToday(taskId: string) {
    const t = byId.get(taskId)
    if (!t) return
    // 已有今天的计划块则不重复
    const exists = blocks.some((b) => b.task_id === taskId && b.start_date <= today && b.end_date >= today && b.status !== 'done')
    if (exists) {
      setActiveTask(null)
      return
    }
    await db.createPlanBlock({ task_id: taskId, start_date: today, end_date: today, summary: '', created_by: '本人' })
    setActiveTask(null)
  }

  return (
    <div className="week-view">
      {/* 顶部行动摘要 */}
      <section className="card week-summary" aria-label="本周行动摘要">
        <div className="week-summary-item"><span>本周承诺</span><strong>{weekPromises.length}</strong></div>
        <div className="week-summary-item is-risk"><span>逾期</span><strong>{overdue.length}</strong></div>
        <div className="week-summary-item is-warn"><span>未排期</span><strong>{unscheduled.length}</strong></div>
        <div className="week-summary-item is-risk"><span>需处理（阻塞/加急）</span><strong>{risks.length}</strong></div>
      </section>

      <div className="week-layout">
        {/* 左侧：本周承诺 / 任务池 */}
        <aside className="week-task-pool card">
          <div className="panel-heading"><div><span className="eyebrow">This week</span><h2>本周承诺</h2></div></div>
          {weekPromises.length === 0 ? (
            <p className="muted">本周无到期承诺。</p>
          ) : (
            <ul className="week-promise-list">
              {weekPromises.map((t) => (
                <li key={t.id}>
                  <button
                    className={`task-color-bar ${taskColorClass(t.id)} ${t.status === 'blocked' ? 'is-blocked' : ''} ${t.priority === 'urgent' ? 'is-urgent' : ''}`}
                    onClick={() => setActiveTask(t)}
                  >
                    <span className="task-chip-title">{t.title}</span>
                    <span className="task-chip-meta">{shortDate(t.expected_end_date!)} · {t.progress}%</span>
                  </button>
                  <button className="task-chip-quick" onClick={() => void planForToday(t.id)} title="安排到今天">＋今天</button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* 中间：本周时间轴（周一到周日，每日计划块） */}
        <section className="week-timeline card">
          <div className="panel-heading"><div><span className="eyebrow">Plan</span><h2>本周安排</h2></div></div>
          <div className="week-grid">
            <div className="week-head empty-weekhead" />
            {week.map((day) => (
              <div key={day} className={`week-head${day === today ? ' is-today' : ''}`}>
                <strong>{WEEKDAYS[week.indexOf(day)]}</strong>
                <span>{Number(day.slice(8))}</span>
              </div>
            ))}
            <div className="week-body-title">计划</div>
            {week.map((day) => {
              const plans = dayPlans(day)
              const overload = plans.length >= MIN_PLAN_PER_DAY
              return (
                <div key={day} className={`week-day${day === today ? ' is-today' : ''}`}>
                  {plans.length === 0 ? <span className="week-day-empty" /> :
                    plans.map((e) => (
                      <button
                        key={e.id}
                        className={`week-plan task-color-solid-${taskColorClass(e.task.id)}${e.block?.status === 'done' ? ' is-done' : ''}`}
                        onClick={() => setActiveTask(e.task)}
                        title={e.task.title}
                      >
                        <span className="week-plan-title">{e.task.title}</span>
                        {e.label && <small>{e.label}</small>}
                      </button>
                    ))}
                  {overload && <span className="week-overload">已安排 {plans.length} 项</span>}
                </div>
              )
            })}
          </div>
          <div className="week-legend">
            <span><i className="legend-plan-dark" />具体日计划</span>
            <span><i className="legend-risk-line" />阻塞 / 加急（边框）</span>
            <span>同一任务格子同色</span>
          </div>
        </section>
      </div>

      {/* 就地操作卡（共享组件，月历/周视图一致） */}
      {activeTask && (
        <TaskQuickCard
          task={activeTask}
          blocks={blocks}
          db={db}
          onQuickProgress={onQuickProgress}
          onOpenTask={onOpenTask}
          onClose={() => setActiveTask(null)}
          onChanged={onPlanned}
        />
      )}
    </div>
  )
}
