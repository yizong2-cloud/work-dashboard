import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import type { PlanBlock, Task } from '../types'
import { getDB } from '../lib/dbFactory'
import { useTaskService } from '../hooks/useTaskService'
import { validatePlanDates } from '../lib/planRules'
import { shortDate, todayISO } from '../lib/format'

const RANGE_DAYS_MIN = 7
const WORKING_MASCOT = `${import.meta.env.BASE_URL}mascots/mascot-working.png`

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function Schedule() {
  const navigate = useNavigate()
  const db = getDB()
  const service = useTaskService(db)

  const [tasks, setTasks] = useState<Task[]>([])
  const [blocks, setBlocks] = useState<PlanBlock[]>([])
  const [rangeStart, setRangeStart] = useState(() => todayISO())
  const [rangeDays, setRangeDays] = useState(RANGE_DAYS_MIN)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  // 添加计划块表单
  const [formTask, setFormTask] = useState('')
  const [formFrom, setFormFrom] = useState(todayISO())
  const [formTo, setFormTo] = useState(addDays(todayISO(), 1))
  const [formSummary, setFormSummary] = useState('')
  const [busy, setBusy] = useState(false)
  // 调整表单（块）
  const [adjustBlock, setAdjustBlock] = useState<PlanBlock | null>(null)
  const [adjFrom, setAdjFrom] = useState('')
  const [adjTo, setAdjTo] = useState('')
  const [adjNote, setAdjNote] = useState('')

  const rangeEnd = addDays(rangeStart, rangeDays - 1)
  const dayWidth = rangeDays === 30 ? 42 : 84
  const planMinWidth = 190 + rangeDays * dayWidth
  const timelineStyle = {
    '--plan-day-width': `${dayWidth}px`,
  } as CSSProperties

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [ts, bs] = await Promise.all([
        service.listTasks(),
        db.listPlanBlocks({ from: addDays(rangeStart, -2), to: addDays(rangeEnd, 2) }),
      ])
      setTasks(ts)
      setBlocks(bs)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [service, db, rangeStart, rangeEnd])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const days = useMemo(
    () => Array.from({ length: rangeDays }, (_, i) => addDays(rangeStart, i)),
    [rangeStart, rangeDays],
  )
  const today = todayISO()

  const activeTasks = useMemo(
    () =>
      tasks
        .filter((t) => ['in_progress', 'blocked', 'paused'].includes(t.status))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [tasks],
  )
  // 有计划块的任务 + 活跃任务（去重）
  const rows = useMemo(() => {
    const ids = new Set<string>()
    for (const b of blocks) ids.add(b.task_id)
    for (const t of activeTasks) ids.add(t.id)
    return [...ids]
      .map((id) => ({ task: byId.get(id), blocks: blocks.filter((b) => b.task_id === id) }))
      .filter((r) => r.task)
      .sort((a, b) => a.task!.title.localeCompare(b.task!.title))
  }, [blocks, activeTasks, byId])

  const unscheduled = useMemo(
    () => activeTasks.filter((t) => !blocks.some((b) => b.task_id === t.id)),
    [activeTasks, blocks],
  )

  const todayBlocks = useMemo(
    () => blocks.filter((b) => b.start_date <= today && b.end_date >= today && b.status !== 'done'),
    [blocks, today],
  )
  const tomorrow = addDays(today, 1)
  const tomorrowBlocks = useMemo(
    () => blocks.filter((b) => b.start_date <= tomorrow && b.end_date >= tomorrow && b.status !== 'done'),
    [blocks, tomorrow],
  )

  function notify(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(''), 3000)
    void refresh()
  }

  async function addBlock() {
    const err = validatePlanDates(formFrom, formTo)
    if (err) return setError(err)
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function doAdjust() {
    if (!adjustBlock) return
    if (!adjNote.trim()) return setError('调整计划块必须填写原因')
    const err = validatePlanDates(adjFrom, adjTo)
    if (err) return setError(err)
    setBusy(true)
    setError('')
    try {
      await db.movePlanBlock(adjustBlock.id, { start_date: adjFrom, end_date: adjTo }, adjNote.trim(), '本人')
      setAdjustBlock(null)
      notify('计划块已调整（历史已记录）')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function pos(block: { start_date: string; end_date: string }): { left: number; width: number } {
    const start = Math.max(0, dayIndex(block.start_date))
    const end = Math.min(rangeDays - 1, dayIndex(block.end_date))
    return {
      left: (start / rangeDays) * 100,
      width: ((end - start + 1) / rangeDays) * 100,
    }
  }
  function dayIndex(iso: string): number {
    return Math.round((new Date(iso + 'T00:00:00').getTime() - new Date(rangeStart + 'T00:00:00').getTime()) / 86400000)
  }

  if (loading && tasks.length === 0) {
    return <div className="page"><p className="muted">加载中…</p></div>
  }

  return (
    <div className="page schedule-page">
      {error && <div className="banner banner-error">{error}</div>}

      <header className="dashboard-intro schedule-intro">
        <div>
          <span className="eyebrow">Plan · 日粒度计划</span>
          <h1>工作计划</h1>
          <p>看每天安排什么：计划块（具体哪几天投入）与任务生命周期（开始/预计完成）相互独立。</p>
        </div>
        <div className="schedule-mascot-frame" aria-hidden="true">
          <img src={WORKING_MASCOT} alt="" decoding="async" />
        </div>
        <div className="intro-actions">
          <button className="btn btn-ghost" onClick={() => setRangeStart(addDays(rangeStart, -rangeDays))}>← 前 {rangeDays} 天</button>
          <button className="btn btn-ghost" onClick={() => setRangeStart(addDays(rangeStart, rangeDays))}>后 {rangeDays} 天 →</button>
          <button className={`btn btn-sm ${rangeDays === 7 ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setRangeDays(7)}>7 天</button>
          <button className={`btn btn-sm ${rangeDays === 30 ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setRangeDays(30)}>30 天</button>
          <button className="btn btn-ghost" onClick={() => setRangeStart(todayISO())}>回到今天</button>
        </div>
      </header>

      {/* 今天 / 明天 */}
      <section className="plan-today-grid">
        <article className="card plan-today-card">
          <h3>今天（{shortDate(today)}）</h3>
          {todayBlocks.length === 0 ? <p className="muted">今天没有安排的计划块。</p> : null}
          {todayBlocks.map((b) => (
            <div key={b.id} className="plan-today-item" onClick={() => navigate(`/task/${b.task_id}`)}>
              <strong>{byId.get(b.task_id)?.title}</strong>
              <span>{b.summary || '（无摘要）'}</span>
            </div>
          ))}
        </article>
        <article className="card plan-today-card">
          <h3>明天（{shortDate(tomorrow)}）</h3>
          {tomorrowBlocks.length === 0 ? <p className="muted">明天没有安排的计划块。</p> : null}
          {tomorrowBlocks.map((b) => (
            <div key={b.id} className="plan-today-item" onClick={() => navigate(`/task/${b.task_id}`)}>
              <strong>{byId.get(b.task_id)?.title}</strong>
              <span>{b.summary || '（无摘要）'}</span>
            </div>
          ))}
        </article>
      </section>

      {/* 添加计划块 */}
      <details className="card plan-add-card">
        <summary>＋ 添加计划块</summary>
        <div className="plan-add-form">
          <label className="field">
            <span>任务</span>
            <select value={formTask} onChange={(e) => setFormTask(e.target.value)}>
              <option value="">选择任务…</option>
              {activeTasks.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
          </label>
          <label className="field"><span>开始日期</span><input type="date" value={formFrom} onChange={(e) => setFormFrom(e.target.value)} /></label>
          <label className="field"><span>结束日期</span><input type="date" value={formTo} onChange={(e) => setFormTo(e.target.value)} /></label>
          <label className="field plan-add-summary"><span>阶段说明</span><input value={formSummary} onChange={(e) => setFormSummary(e.target.value)} placeholder="如：完成接口联调" /></label>
          <button className="btn btn-primary" disabled={busy} onClick={() => void addBlock()}>添加</button>
        </div>
      </details>

      {/* 时间轴 */}
      <section className="plan-timeline card" style={timelineStyle}>
        <div className="plan-board-title">
          <div><span className="eyebrow">Calendar strip</span><h2>{rangeDays} 日工作带</h2></div>
          <span>按天阅读计划，不拆分小时</span>
        </div>
        <div className="plan-head" style={{ minWidth: planMinWidth }}>
          <span className="plan-head-task">任务</span>
          <div className="plan-head-days" style={{ gridTemplateColumns: `repeat(${rangeDays}, minmax(${dayWidth}px, 1fr))` }}>
            {days.map((d) => (
              <span key={d} className={`plan-day-label ${d === today ? 'plan-day-today' : ''}`}>
                <strong>{d === today ? '今天' : shortDate(d)}</strong>
                <small>{weekdayLabel(d)}</small>
              </span>
            ))}
          </div>
        </div>
        {rows.length === 0 ? <p className="muted">还没有活跃任务或排期。</p> : null}
        {rows.map(({ task, blocks: taskBlocks }) => {
          const hasSchedule = !!task!.start_date && !!task!.expected_end_date
          const scheduleBar = hasSchedule ? pos({ start_date: task!.start_date!, end_date: task!.expected_end_date! }) : null
          return (
            <div key={task!.id} className="plan-row" style={{ minWidth: planMinWidth }}>
              <button className="plan-task-name" onClick={() => navigate(`/task/${task!.id}`)}>
                {task!.title}
                {task!.status === 'blocked' && ' ⛔'}
                {!task!.expected_end_date && <span className="tag tag-noschedule">未排期</span>}
              </button>
              <div className="plan-track">
                {/* 自动排期条：任务生命周期（开始 ~ 预计完成），无需手动维护 */}
                {scheduleBar && (
                  <div
                    className={`plan-schedule-bar ${isOverdueSchedule(task!) ? 'plan-schedule-overdue' : ''}`}
                    style={{ left: `${scheduleBar.left}%`, width: `${scheduleBar.width}%` }}
                    title={`排期：${task!.start_date} ~ ${task!.expected_end_date}${isOverdueSchedule(task!) ? '（已逾期）' : ''}`}
                  >
                    <span className="plan-schedule-label">
                      排期 {shortDate(task!.start_date)} ~ {shortDate(task!.expected_end_date)}
                    </span>
                  </div>
                )}
                {taskBlocks.map((b) => {
                  const p = pos(b)
                  const done = b.status === 'done'
                  const changed = b.status === 'changed'
                  return (
                    <div
                      key={b.id}
                      className={`plan-block ${done ? 'plan-done' : ''} ${changed ? 'plan-changed' : ''} ${b.task_id === adjustBlock?.id ? 'plan-adjusting' : ''}`}
                      style={{ left: `${p.left}%`, width: `${p.width}%` }}
                      title={`${b.start_date} ~ ${b.end_date} · ${b.summary || '无摘要'}`}
                    >
                      <span className="plan-block-text">{b.summary || '计划'}</span>
                      <span className="plan-block-actions">
                        <button onClick={(e) => { e.stopPropagation(); void toggleDone(b) }}>{done ? '恢复' : '完成'}</button>
                        <button onClick={(e) => {
                          e.stopPropagation()
                          setAdjustBlock(b); setAdjFrom(b.start_date); setAdjTo(b.end_date); setAdjNote('')
                        }}>调整</button>
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
        {unscheduled.length > 0 && (
          <p className="plan-unscheduled muted">
            ⚠️ {unscheduled.length} 个活跃任务未安排计划：{unscheduled.map((t) => t.title).join('、')}
          </p>
        )}
        <div className="plan-legend muted">
          <span className="plan-legend-dot plan-legend-schedule" />自动排期（任务开始~预计完成） · <span className="plan-legend-dot plan-legend-planned" />计划块 · <span className="plan-legend-dot plan-legend-done" />已完成 · <span className="plan-legend-dot plan-legend-changed" />已调整 · 今天列高亮
        </div>
      </section>

      {adjustBlock && (
        <div className="modal-mask" onClick={() => setAdjustBlock(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>调整计划块：{byId.get(adjustBlock.task_id)?.title}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setAdjustBlock(null)}>关闭</button>
            </div>
            <div className="modal-body">
              <label className="field"><span>开始日期</span><input type="date" value={adjFrom} onChange={(e) => setAdjFrom(e.target.value)} /></label>
              <label className="field"><span>结束日期</span><input type="date" value={adjTo} onChange={(e) => setAdjTo(e.target.value)} /></label>
              <label className="field"><span>调整原因（记录到历史）</span><textarea rows={2} value={adjNote} onChange={(e) => setAdjNote(e.target.value)} placeholder="如：临时需求插入" /></label>
              {error && <p className="form-error">{error}</p>}
            </div>
            <div className="modal-foot">
              <button className="btn btn-primary" disabled={busy} onClick={() => void doAdjust()}>保存调整</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function isOverdueSchedule(task: Task): boolean {
  return (
    !!task.expected_end_date &&
    task.status !== 'completed' &&
    task.status !== 'cancelled' &&
    task.expected_end_date < todayISO()
  )
}

function weekdayLabel(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: 'Asia/Shanghai' })
    .format(new Date(`${iso}T00:00:00+08:00`))
}
