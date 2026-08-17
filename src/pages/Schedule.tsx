import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { PlanBlock, Task, TaskUpdate, UpdateType } from '../types'
import { getDB } from '../lib/dbFactory'
import { useTaskService } from '../hooks/useTaskService'
import { validatePlanDates } from '../lib/planRules'
import { buildMonthCalendar, buildScheduleEntries, type ScheduleEntry } from '../lib/scheduleView'
import { buildDailyReport } from '../lib/dailyReport'
import { taskColorClass } from '../lib/taskColor'
import { ScheduleWeek } from '../components/ScheduleWeek'
import { TaskQuickCard } from '../components/TaskQuickCard'
import { shortDate, todayISO } from '../lib/format'

const WORKING_MASCOT = `${import.meta.env.BASE_URL}mascots/mascot-working.png`
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

type ScheduleViewMode = 'week' | 'calendar' | 'today'

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
  const date = new Date(Date.UTC(year, month - 1, day + amount))
  return isoFromUTC(date)
}

function daysBetween(from: string, to: string): number {
  const a = dateParts(from)
  const b = dateParts(to)
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000)
}

function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

function addMonths(monthStart: string, amount: number): string {
  const { year, month } = dateParts(monthStart)
  return isoFromUTC(new Date(Date.UTC(year, month - 1 + amount, 1)))
}

function monthLabel(monthStart: string): string {
  const { year, month } = dateParts(monthStart)
  return `${year} 年 ${month} 月`
}

function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

function updateTypeLabel(type: UpdateType): string {
  const labels: Record<UpdateType, string> = {
    progress: '进展',
    status_change: '状态',
    schedule_change: '排期',
    blocked: '阻塞',
    unblocked: '解除阻塞',
    interrupt: '临时任务',
    note: '说明',
    completed: '完成',
    urgent: '加急',
    deurgent: '取消加急',
    nudge: '催办',
  }
  return labels[type]
}

export function Schedule() {
  const navigate = useNavigate()
  const db = getDB()
  const service = useTaskService(db)

  const [tasks, setTasks] = useState<Task[]>([])
  const [blocks, setBlocks] = useState<PlanBlock[]>([])
  const [allUpdates, setAllUpdates] = useState<TaskUpdate[]>([])
  const [viewMode, setViewMode] = useState<ScheduleViewMode>('week')
  const [monthStart, setMonthStart] = useState(() => startOfMonth(todayISO()))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')

  const [formTask, setFormTask] = useState('')
  const [formFrom, setFormFrom] = useState(todayISO())
  const [formTo, setFormTo] = useState(addDays(todayISO(), 1))
  const [formSummary, setFormSummary] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [adjustBlock, setAdjustBlock] = useState<PlanBlock | null>(null)
  const [adjFrom, setAdjFrom] = useState('')
  const [adjTo, setAdjTo] = useState('')
  const [adjNote, setAdjNote] = useState('')
  const [activeTask, setActiveTask] = useState<import('../types').Task | null>(null)

  const { rangeStart, rangeEnd, weeks } = useMemo(() => buildMonthCalendar(monthStart), [monthStart])
  const today = todayISO()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [taskRows, planRows, updateRows] = await Promise.all([
        service.listTasks(),
        db.listPlanBlocks({ from: rangeStart, to: rangeEnd }),
        db.listAllUpdates(),
      ])
      setTasks(taskRows)
      setBlocks(planRows)
      setAllUpdates(updateRows)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [service, db, rangeStart, rangeEnd])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const schedulableTasks = useMemo(
    () => tasks
      .filter((task) => !['completed', 'cancelled'].includes(task.status))
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN')),
    [tasks],
  )
  const entries = useMemo(
    () => buildScheduleEntries(tasks, blocks, rangeStart, rangeEnd),
    [tasks, blocks, rangeStart, rangeEnd],
  )
  const scheduledTaskCount = useMemo(
    () => new Set(entries.map((entry) => entry.task.id)).size,
    [entries],
  )
  const dailyReport = useMemo(
    () => buildDailyReport(tasks, allUpdates, today),
    [tasks, allUpdates, today],
  )

  function notify(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(''), 3000)
    void refresh()
  }

  function openPlanner(taskId = '') {
    if (taskId) setFormTask(taskId)
    setViewMode('calendar')
    setAddOpen(true)
    window.setTimeout(() => {
      document.getElementById('plan-add')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 0)
  }

  function weekPosition(entry: ScheduleEntry, weekStart: string, weekEnd: string) {
    const visibleStart = entry.startDate < weekStart ? weekStart : entry.startDate
    const visibleEnd = entry.endDate > weekEnd ? weekEnd : entry.endDate
    const startColumn = daysBetween(weekStart, visibleStart) + 1
    const span = daysBetween(visibleStart, visibleEnd) + 1
    return { gridColumn: `${startColumn} / span ${span}` }
  }

  async function addBlock() {
    const validationError = validatePlanDates(formFrom, formTo)
    if (validationError) return setError(validationError)
    if (!formTask) return setError('请选择任务')
    setBusy(true)
    setError('')
    try {
      await db.createPlanBlock({
        task_id: formTask,
        start_date: formFrom,
        end_date: formTo,
        summary: formSummary.trim(),
        created_by: '本人',
      })
      setFormSummary('')
      notify('计划块已添加')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  async function doAdjust() {
    if (!adjustBlock) return
    if (!adjNote.trim()) return setError('调整计划块必须填写原因')
    const validationError = validatePlanDates(adjFrom, adjTo)
    if (validationError) return setError(validationError)
    setBusy(true)
    setError('')
    try {
      await db.movePlanBlock(
        adjustBlock.id,
        { start_date: adjFrom, end_date: adjTo },
        adjNote.trim(),
        '本人',
      )
      setAdjustBlock(null)
      notify('计划块已调整（历史已记录）')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  async function toggleDone(block: PlanBlock) {
    setBusy(true)
    setError('')
    try {
      if (block.status === 'done') {
        await db.movePlanBlock(block.id, {}, '恢复为未完成', '本人')
        notify('计划块已恢复')
      } else {
        await db.donePlanBlock(block.id, '', '本人')
        notify('计划块已完成')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  if (loading && tasks.length === 0) {
    return <div className="page"><p className="muted">加载中…</p></div>
  }

  return (
    <div className="page schedule-page">
      {error && <div className="banner banner-error">{error}</div>}

      <header className="dashboard-intro schedule-intro">
        <div>
          <span className="eyebrow">Plan & Report</span>
          <h1>{viewMode === 'week' ? '本周排期' : viewMode === 'calendar' ? '工作月历' : '今日动态'}</h1>
          <p>
            {viewMode === 'week'
              ? '本周视图回答“这周到底做什么、会不会撞期”：本周承诺 + 每日计划块 + 未排期/风险一览。'
              : viewMode === 'calendar'
                ? '月历回答“什么时候准备做什么”，未排期任务不会出现在日历中。'
                : '今日动态只回答“今天实际推进了什么”，数据来自当天任务时间线。'}
          </p>
        </div>
        <div className="schedule-mascot-frame" aria-hidden="true">
          <img src={WORKING_MASCOT} alt="" decoding="async" />
        </div>
        <div className="intro-actions schedule-actions">
          <div className="schedule-view-tabs" role="tablist" aria-label="日程视图">
            <button
              className={`btn btn-sm ${viewMode === 'week' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setViewMode('week')}
            >本周</button>
            <button
              className={`btn btn-sm ${viewMode === 'calendar' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setViewMode('calendar')}
            >月历</button>
            <button
              className={`btn btn-sm ${viewMode === 'today' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setViewMode('today')}
            >今日动态</button>
          </div>
          {viewMode === 'calendar' && (
            <div className="month-nav">
              <button className="btn btn-ghost btn-sm" onClick={() => setMonthStart(addMonths(monthStart, -1))}>← 上月</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setMonthStart(startOfMonth(today))}>本月</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setMonthStart(addMonths(monthStart, 1))}>下月 →</button>
            </div>
          )}
        </div>
      </header>

      {viewMode === 'week' ? (
        <ScheduleWeek
          tasks={tasks}
          blocks={blocks}
          db={db}
          onQuickProgress={(taskId) => navigate(`/task/${taskId}?action=progress`)}
          onOpenTask={(taskId) => navigate(`/task/${taskId}`)}
          onPlanned={() => void refresh()}
        />
      ) : viewMode === 'calendar' ? (
        <>
          <section className="calendar-summary-strip" aria-label="本月排期摘要">
            <div><span>当前月份</span><strong>{monthLabel(monthStart)}</strong></div>
            <div><span>已排任务</span><strong>{scheduledTaskCount}</strong></div>
            <div><span>排期条目</span><strong>{entries.length}</strong></div>
            <div><span>显示规则</span><strong>只看已排期</strong></div>
          </section>

          <details
            id="plan-add"
            className="card plan-add-card"
            open={addOpen}
            onToggle={(event) => setAddOpen(event.currentTarget.open)}
          >
            <summary>＋ 添加具体日计划</summary>
            <div className="plan-add-form">
              <label className="field">
                <span>任务</span>
                <select value={formTask} onChange={(event) => setFormTask(event.target.value)}>
                  <option value="">选择任务…</option>
                  {schedulableTasks.map((task) => (
                    <option key={task.id} value={task.id}>{task.title}</option>
                  ))}
                </select>
              </label>
              <label className="field"><span>开始日期</span><input type="date" value={formFrom} onChange={(event) => setFormFrom(event.target.value)} /></label>
              <label className="field"><span>结束日期</span><input type="date" value={formTo} onChange={(event) => setFormTo(event.target.value)} /></label>
              <label className="field plan-add-summary"><span>阶段说明</span><input value={formSummary} onChange={(event) => setFormSummary(event.target.value)} placeholder="如：完成接口联调" /></label>
              <button className="btn btn-primary" disabled={busy} onClick={() => void addBlock()}>添加</button>
            </div>
          </details>

          <section className="card month-board">
            <div className="month-board-head">
              <div>
                <span className="eyebrow">自然月视图</span>
                <h2>{monthLabel(monthStart)}</h2>
              </div>
              <span>星期一至星期日 · 跨周任务自动续到下一行</span>
            </div>
            <div className="month-calendar-scroll">
              <div className="month-calendar">
                <div className="month-weekday-head">
                  {WEEKDAYS.map((weekday, index) => (
                    <span key={weekday} className={index >= 5 ? 'is-weekend' : ''}>{weekday}</span>
                  ))}
                </div>
                {weeks.map((week) => {
                  const weekStart = week[0]
                  const weekEnd = week[6]
                  const weekEntries = entries.filter(
                    (entry) => entry.startDate <= weekEnd && entry.endDate >= weekStart,
                  )
                  return (
                    <section key={weekStart} className="month-week">
                      <div className="month-week-days">
                        {week.map((day, index) => {
                          const outside = day.slice(0, 7) !== monthStart.slice(0, 7)
                          return (
                            <span
                              key={day}
                              className={`${outside ? 'is-outside' : ''} ${day === today ? 'is-today' : ''} ${index >= 5 ? 'is-weekend' : ''}`}
                            >
                              <strong>{Number(day.slice(8))}</strong>
                              {day === today && <small>今天</small>}
                            </span>
                          )
                        })}
                      </div>
                      <div className="month-week-entries">
                        {weekEntries.length === 0 ? (
                          <span className="month-week-empty">本周暂无排期</span>
                        ) : weekEntries.map((entry) => {
                          const block = entry.block
                          const done = block?.status === 'done' || entry.task.status === 'completed'
                          const changed = block?.status === 'changed'
                          return (
                            <div
                              key={`${weekStart}:${entry.id}`}
                              className={`month-entry task-color-line-${taskColorClass(entry.task.id)} is-${entry.source.replace('_', '-')} ${done ? 'is-done' : ''} ${changed ? 'is-changed' : ''}`}
                              style={weekPosition(entry, weekStart, weekEnd)}
                              title={`${entry.task.title} · ${entry.startDate} ~ ${entry.endDate}${entry.source === 'plan_block' ? ` · ${entry.label}` : ''}`}
                            >
                              <button className="month-entry-main" onClick={() => setActiveTask(entry.task)}>
                                <strong>{entry.task.title}</strong>
                                <small>{entry.source === 'plan_block' ? entry.label : `${shortDate(entry.startDate)}—${shortDate(entry.endDate)}`}</small>
                              </button>
                              {block && (
                                <span className="month-entry-actions">
                                  <button onClick={() => void toggleDone(block)}>{block.status === 'done' ? '恢复' : '完成'}</button>
                                  <button onClick={() => {
                                    setAdjustBlock(block)
                                    setAdjFrom(block.start_date)
                                    setAdjTo(block.end_date)
                                    setAdjNote('')
                                  }}>调整</button>
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )
                })}
              </div>
            </div>
            {entries.length === 0 && (
              <div className="month-empty-callout">
                <strong>这个月还没有任何明确排期。</strong>
                <span>未排期任务不会被硬塞进日历。你可以为任务设置开始/预计完成日期，或添加具体日计划。</span>
                <button className="btn btn-primary btn-sm" onClick={() => openPlanner()}>添加日计划</button>
              </div>
            )}
            <div className="month-legend">
              <span><i className="legend-task-schedule" />任务开始—预计完成</span>
              <span><i className="legend-plan-block" />具体日计划</span>
              <span><i className="legend-done" />已完成</span>
              <span>没有日期的任务不会显示</span>
            </div>
          </section>
        </>
      ) : (
        <TodayReport
          report={dailyReport}
          onOpenTask={(taskId) => navigate(`/task/${taskId}`)}
        />
      )}

      {adjustBlock && (
        <div className="modal-mask" onClick={() => setAdjustBlock(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>调整计划块：{byId.get(adjustBlock.task_id)?.title}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setAdjustBlock(null)}>关闭</button>
            </div>
            <div className="modal-body">
              <label className="field"><span>开始日期</span><input type="date" value={adjFrom} onChange={(event) => setAdjFrom(event.target.value)} /></label>
              <label className="field"><span>结束日期</span><input type="date" value={adjTo} onChange={(event) => setAdjTo(event.target.value)} /></label>
              <label className="field"><span>调整原因（记录到历史）</span><textarea rows={2} value={adjNote} onChange={(event) => setAdjNote(event.target.value)} placeholder="如：临时需求插入" /></label>
              {error && <p className="form-error">{error}</p>}
            </div>
            <div className="modal-foot">
              <button className="btn btn-primary" disabled={busy} onClick={() => void doAdjust()}>保存调整</button>
            </div>
          </div>
        </div>
      )}

      {activeTask && (
        <TaskQuickCard
          task={activeTask}
          blocks={blocks}
          db={db}
          onQuickProgress={(taskId) => navigate(`/task/${taskId}?action=progress`)}
          onOpenTask={(taskId) => navigate(`/task/${taskId}`)}
          onClose={() => setActiveTask(null)}
          onChanged={() => void refresh()}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function TodayReport({
  report,
  onOpenTask,
}: {
  report: ReturnType<typeof buildDailyReport>
  onOpenTask: (taskId: string) => void
}) {
  return (
    <section className="daily-report">
      <div className="card daily-report-summary">
        <div>
          <span className="eyebrow">Daily report · {shortDate(report.date)}</span>
          <h2>今天推进了什么</h2>
          <p>仅汇总今天真实写入任务时间线的记录；每次定时同步后自动形成最新日报。</p>
        </div>
        <div className="daily-report-metrics">
          <span><strong>{report.groups.length}</strong> 个任务</span>
          <span><strong>{report.updateCount}</strong> 条动态</span>
        </div>
      </div>

      {report.groups.length === 0 ? (
        <div className="card daily-report-empty">
          <strong>今天还没有采集到工作动态。</strong>
          <p>下一次定时同步写入任务进展后，这里会自动形成当天日报；不会拿旧记录或未更新任务充数。</p>
        </div>
      ) : (
        <div className="daily-task-list">
          {report.groups.map((group) => (
            <article key={group.task.id} className="card daily-task-card">
              <header>
                <button onClick={() => onOpenTask(group.task.id)}>{group.task.title}</button>
                <span>{group.updates.length} 条进展</span>
              </header>
              <div className="daily-update-list">
                {group.updates.map((update) => (
                  <div key={update.id} className={`daily-update daily-update-${update.type}`}>
                    <time>{timeLabel(update.created_at)}</time>
                    <span className="daily-update-type">{updateTypeLabel(update.type)}</span>
                    <p>{update.content}</p>
                    {update.created_by && <small>记录人：{update.created_by}</small>}
                  </div>
                ))}
              </div>
              {group.task.current_status && (
                <footer><strong>当前状态：</strong>{group.task.current_status}</footer>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
