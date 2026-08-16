import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Task, TaskUpdate } from '../types'
import { appConfig } from '../config'
import { getDB } from '../lib/dbFactory'
import { useTaskService } from '../hooks/useTaskService'
import { TaskCard, SectionTitle } from '../components/TaskCard'
import { TaskProgress } from '../components/TaskProgress'
import { StatusBadge } from '../components/StatusBadge'
import { QuickUpdateModal } from '../components/QuickUpdateModal'
import { CreateTaskModal } from '../components/CreateTaskModal'
import { zhDate, shortDate, shortDateTime, relativeDay } from '../lib/format'

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 } as const

export function Dashboard() {
  const navigate = useNavigate()
  const isLocalMode = appConfig.dataMode === 'local'

  const db = getDB()
  const service = useTaskService(db)

  const [tasks, setTasks] = useState<Task[]>([])
  const [allUpdates, setAllUpdates] = useState<TaskUpdate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [quickTask, setQuickTask] = useState<Task | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [toast, setToast] = useState('')
  const [showAllUpdates, setShowAllUpdates] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [ts, us] = await Promise.all([service.listTasks(), db.listAllUpdates()])
      setTasks(ts)
      setAllUpdates(us)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [service, db])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const latestByTask = useMemo(() => {
    const map = new Map<string, TaskUpdate>()
    for (const u of allUpdates) {
      if (!map.has(u.task_id)) map.set(u.task_id, u)
    }
    return map
  }, [allUpdates])

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  const activeTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'in_progress' || t.status === 'blocked' || t.status === 'paused')
        .sort((a, b) => {
          const pa = PRIORITY_ORDER[a.priority]
          const pb = PRIORITY_ORDER[b.priority]
          if (pa !== pb) return pa - pb
          return b.updated_at.localeCompare(a.updated_at)
        }),
    [tasks],
  )

  const heroTask = activeTasks[0] ?? null

  const interruptTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.is_interrupt_task)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [tasks],
  )

  const plannedTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'planned')
        .sort((a, b) => (a.start_date ?? '9999').localeCompare(b.start_date ?? '9999')),
    [tasks],
  )

  const completedTasks = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'completed')
        .sort((a, b) => (a.actual_end_date ?? '').localeCompare(b.actual_end_date ?? ''))
        .slice(-5)
        .reverse(),
    [tasks],
  )

  const recentUpdates = useMemo(
    () => allUpdates.slice(0, showAllUpdates ? 20 : 5),
    [allUpdates, showAllUpdates],
  )

  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    const ws = weekStartISO()
    const we = new Date(ws + 'T00:00:00')
    we.setDate(we.getDate() + 6)
    const weISO = `${we.getFullYear()}-${String(we.getMonth() + 1).padStart(2, '0')}-${String(we.getDate()).padStart(2, '0')}`
    const unfinished = (t: Task) => t.status !== 'completed' && t.status !== 'cancelled'
    return {
      active: activeTasks.length,
      blocked: tasks.filter((t) => t.status === 'blocked').length,
      dueThisWeek: tasks.filter(
        (t) => unfinished(t) && !!t.expected_end_date && t.expected_end_date >= ws && t.expected_end_date <= weISO,
      ).length,
      // Leader 最关心：逾期 或 活跃任务没排期（无法回答"什么时候完成"）
      overdueOrUnscheduled: tasks.filter(
        (t) => unfinished(t) && (!t.expected_end_date || t.expected_end_date < today),
      ).length,
    }
  }, [tasks, activeTasks.length])

  function notify(msg: string) {
    setToast(msg)
    window.setTimeout(() => setToast(''), 3000)
    void refresh()
  }

  if (loading && tasks.length === 0) {
    return (
      <div className="page">
        <p className="muted">加载中…</p>
      </div>
    )
  }

  return (
    <div className="page">
      {isLocalMode && (
        <div className="banner banner-info">
          本地演示模式：数据仅保存在当前浏览器，未连接 Supabase。配置后会自动切换。
        </div>
      )}
      {error && <div className="banner banner-error">{error}</div>}

      {/* 工具栏 */}
      <div className="toolbar">
        <div className="toolbar-title">
          <h1>工作进度看板</h1>
          <span className="muted">{todayText()}</span>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          ＋ 新建任务
        </button>
      </div>

      {/* 统计条：Leader 决策视角 */}
      <div className="stats">
        <div className="stat"><b>{stats.active}</b><span>进行中</span></div>
        <div className="stat warn-stat"><b>{stats.blocked}</b><span>已阻塞</span></div>
        <div className="stat"><b>{stats.dueThisWeek}</b><span>本周到期</span></div>
        <div className="stat warn-stat"><b>{stats.overdueOrUnscheduled}</b><span>逾期/未排期</span></div>
      </div>

      {/* 第一优先级：我现在正在干什么 */}
      {heroTask ? (
        <section className="hero card">
          <div className="hero-head">
            <span className="hero-label">
              {heroTask.status === 'blocked' ? '当前被阻塞' : '当前正在做'}
            </span>
            <StatusBadge status={heroTask.status} />
          </div>
          <h2 className="hero-title">{heroTask.title}</h2>
          <TaskProgress progress={heroTask.progress} overdue={isOverdue(heroTask)} size="md" />
          <div className="hero-meta">
            <span>开始 {zhDate(heroTask.start_date)}</span>
            <span>
              预计完成{' '}
              <b className={isOverdue(heroTask) ? 'txt-warn' : ''}>{zhDate(heroTask.expected_end_date)}</b>
            </span>
          </div>
          {heroTask.status === 'blocked' && heroTask.block_reason && (
            <p className="block-reason">⛔ 阻塞原因：{heroTask.block_reason}</p>
          )}
          {heroTask.current_status && <p className="hero-status">最新：{heroTask.current_status}</p>}
          {latestByTask.get(heroTask.id) && (
            <p className="hero-update muted">
              最近更新（{shortDateTime(latestByTask.get(heroTask.id)!.created_at)}）：
              {latestByTask.get(heroTask.id)!.content}
            </p>
          )}
          <div className="row-gap">
            <button className="btn btn-ghost" onClick={() => navigate(`/task/${heroTask.id}`)}>
              查看详情
            </button>
            <button className="btn btn-primary" onClick={() => setQuickTask(heroTask)}>
              快速更新
            </button>
          </div>
        </section>
      ) : (
        <section className="hero card">
          <span className="hero-label">当前没有进行中的任务</span>
          <p className="muted">可以查看下面的「接下来」了解后续计划。</p>
        </section>
      )}

      {/* 第二优先级：进行中的任务 */}
      {activeTasks.length > 0 && (
        <section>
          <SectionTitle
            extra={
              <span className="muted">
                {activeTasks.length} 个任务 · 共{' '}
                {((activeTasks.reduce((s, t) => s + t.progress, 0) / Math.max(1, activeTasks.length)) | 0)}%
                平均进度
              </span>
            }
          >
            进行中的任务
          </SectionTitle>
          <div className="card-grid">
            {activeTasks.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                latestUpdate={latestByTask.get(t.id)}
                onOpen={(task) => navigate(`/task/${task.id}`)}
                onQuickUpdate={setQuickTask}
              />
            ))}
          </div>
        </section>
      )}

      {/* 第四优先级：临时任务（解释排期变化） */}
      {interruptTasks.length > 0 && (
        <section>
          <SectionTitle extra={<span className="muted">临时插入的工作，可解释排期变化</span>}>
            临时任务
          </SectionTitle>
          <div className="list">
            {interruptTasks.map((t) => (
              <div key={t.id} className="list-row" onClick={() => navigate(`/task/${t.id}`)}>
                <div className="list-main">
                  <span className="tag tag-interrupt">临时</span>
                  <span className="list-title">{t.title}</span>
                </div>
                <span className="muted">
                  {relativeDay(t.actual_end_date ?? t.created_at.slice(0, 10))} ·{' '}
                  <StatusBadge status={t.status} />
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 第五优先级：接下来 */}
      {plannedTasks.length > 0 && (
        <section>
          <SectionTitle>接下来</SectionTitle>
          <div className="list">
            {plannedTasks.map((t) => (
              <div key={t.id} className="list-row" onClick={() => navigate(`/task/${t.id}`)}>
                <div className="list-main">
                  <span className="list-date">{shortDate(t.start_date)}</span>
                  <span className="list-title">{t.title}</span>
                </div>
                <span className="muted">预计 {shortDate(t.expected_end_date)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 第三优先级：最近发生了什么（默认 5 条，可展开） */}
      {recentUpdates.length > 0 && (
        <section>
          <SectionTitle
            extra={
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAllUpdates((v) => !v)}>
                {showAllUpdates ? '收起' : '查看全部'}
              </button>
            }
          >
            最近更新
          </SectionTitle>
          <div className="feed">
            {recentUpdates.map((u) => {
              const task = byId.get(u.task_id)
              return (
                <div key={u.id} className="feed-row">
                  <time className="feed-time">{shortDateTime(u.created_at)}</time>
                  <div className="feed-body">
                    <span className="feed-task">
                      {task ? (
                        <a onClick={() => navigate(`/task/${task.id}`)}>{task.title}</a>
                      ) : (
                        '（已删除任务）'
                      )}
                    </span>
                    <p>{u.content}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 已完成 */}
      {completedTasks.length > 0 && (
        <section>
          <SectionTitle>最近完成</SectionTitle>
          <div className="list">
            {completedTasks.map((t) => (
              <div key={t.id} className="list-row" onClick={() => navigate(`/task/${t.id}`)}>
                <div className="list-main">
                  <span className="list-title">{t.title}</span>
                </div>
                <span className="muted">完成于 {relativeDay(t.actual_end_date)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {quickTask && (
        <QuickUpdateModal
          task={quickTask}
          service={service}
          onClose={() => setQuickTask(null)}
          onDone={notify}
        />
      )}
      {showCreate && <CreateTaskModal service={service} onClose={() => setShowCreate(false)} onDone={notify} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function weekStartISO(): string {
  const d = new Date()
  const day = d.getDay() || 7
  d.setDate(d.getDate() - day + 1)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${dd}`
}

function isOverdue(task: Task): boolean {
  return (
    !!task.expected_end_date &&
    task.status !== 'completed' &&
    task.status !== 'cancelled' &&
    task.expected_end_date < new Date().toISOString().slice(0, 10)
  )
}

function todayText(): string {
  const d = new Date()
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${week}`
}
