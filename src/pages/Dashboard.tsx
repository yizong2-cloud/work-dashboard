import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Task, TaskUpdate } from '../types'
import { appConfig } from '../config'
import { getDB } from '../lib/dbFactory'
import { useTaskService } from '../hooks/useTaskService'
import { TaskProgress } from '../components/TaskProgress'
import { StatusBadge } from '../components/StatusBadge'
import { QuickUpdateModal } from '../components/QuickUpdateModal'
import { CreateTaskModal } from '../components/CreateTaskModal'
import { commentBody, isComment } from '../lib/comments'
import { shortDate, shortDateTime, relativeDay, todayISO, zhDate } from '../lib/format'

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 } as const
type WorkFilter = 'all' | 'risk' | 'blocked' | 'unscheduled'

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
  const [workFilter, setWorkFilter] = useState<WorkFilter>('all')
  const [query, setQuery] = useState('')

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
    for (const update of allUpdates) if (!map.has(update.task_id)) map.set(update.task_id, update)
    return map
  }, [allUpdates])

  const commentsByTask = useMemo(() => {
    const map = new Map<string, number>()
    for (const update of allUpdates) {
      if (isComment(update)) map.set(update.task_id, (map.get(update.task_id) ?? 0) + 1)
    }
    return map
  }, [allUpdates])

  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const activeTasks = useMemo(
    () =>
      tasks
        .filter(isActive)
        .sort((a, b) => {
          if (riskRank(a) !== riskRank(b)) return riskRank(a) - riskRank(b)
          if (PRIORITY_ORDER[a.priority] !== PRIORITY_ORDER[b.priority]) {
            return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
          }
          return latestActivity(b, latestByTask).localeCompare(latestActivity(a, latestByTask))
        }),
    [tasks, latestByTask],
  )

  const focusTask = useMemo(
    () => activeTasks.find((task) => task.status === 'in_progress' && task.priority === 'high') ?? activeTasks[0] ?? null,
    [activeTasks],
  )

  const plannedTasks = useMemo(
    () => tasks.filter((task) => task.status === 'planned').sort((a, b) => (a.start_date ?? '9999').localeCompare(b.start_date ?? '9999')),
    [tasks],
  )

  const completedTasks = useMemo(
    () => tasks.filter((task) => task.status === 'completed').sort((a, b) => (b.actual_end_date ?? '').localeCompare(a.actual_end_date ?? '')).slice(0, 5),
    [tasks],
  )

  const metrics = useMemo(() => {
    const today = todayISO()
    const weekStart = weekStartISO()
    const weekEnd = addDaysISO(weekStart, 6)
    const unfinished = tasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled')
    const blocked = activeTasks.filter((task) => task.status === 'blocked')
    const dueThisWeek = unfinished.filter((task) => task.expected_end_date && task.expected_end_date >= weekStart && task.expected_end_date <= weekEnd)
    const overdue = unfinished.filter((task) => task.expected_end_date && task.expected_end_date < today)
    const unscheduled = activeTasks.filter((task) => !task.expected_end_date)
    return { blocked, dueThisWeek, overdue, unscheduled }
  }, [tasks, activeTasks])

  const attentionTasks = useMemo(
    () => activeTasks.filter((task) => task.status === 'blocked' || isOverdue(task) || !task.expected_end_date).slice(0, 5),
    [activeTasks],
  )

  const visibleTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return activeTasks.filter((task) => {
      const matchesQuery = !normalizedQuery || `${task.title} ${task.current_status} ${task.description}`.toLowerCase().includes(normalizedQuery)
      const matchesFilter = workFilter === 'all'
        || (workFilter === 'risk' && (task.status === 'blocked' || isOverdue(task) || !task.expected_end_date))
        || (workFilter === 'blocked' && task.status === 'blocked')
        || (workFilter === 'unscheduled' && !task.expected_end_date)
      return matchesQuery && matchesFilter
    })
  }, [activeTasks, query, workFilter])

  const recentUpdates = useMemo(() => allUpdates.slice(0, showAllUpdates ? 16 : 6), [allUpdates, showAllUpdates])
  const averageProgress = activeTasks.length ? Math.round(activeTasks.reduce((sum, task) => sum + task.progress, 0) / activeTasks.length) : 0
  const scheduledCount = activeTasks.filter((task) => task.expected_end_date).length
  const scheduledRate = activeTasks.length ? Math.round((scheduledCount / activeTasks.length) * 100) : 100
  const completedCount = tasks.filter((task) => task.status === 'completed').length
  const completionRate = tasks.length ? Math.round((completedCount / tasks.length) * 100) : 0

  function notify(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(''), 3000)
    void refresh()
  }

  function applyMetricFilter(filter: WorkFilter) {
    setWorkFilter(filter)
    document.getElementById('active-work')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (loading && tasks.length === 0) return <DashboardSkeleton />

  return (
    <div className="page dashboard-page">
      {isLocalMode && <div className="banner banner-info">本地演示模式：数据仅保存在当前浏览器。</div>}
      {error && <div className="banner banner-error">{error}</div>}

      <header className="dashboard-intro">
        <div className="intro-copy">
          <span className="eyebrow">Delivery overview · {todayText()}</span>
          <h1>工作进度总览</h1>
          <p>聚焦正在推进的事项、交付风险与需要决策的问题。</p>
          <span className="intro-ribbon"><span aria-hidden="true">✦</span> 给 Leader 的今日工作简报 <span aria-hidden="true">✦</span></span>
        </div>
        <div className="intro-actions">
          <div className="sync-state" title="依据最新一条时间线记录">
            <span className="sync-dot" />
            <span>最近同步 {shortDateTime(allUpdates[0]?.created_at)}</span>
          </div>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <DashboardIcon name="plus" />新建任务
          </button>
        </div>
      </header>

      <section className="metric-grid" aria-label="工作状态概览">
        <MetricCard icon="pulse" tone="blue" value={activeTasks.length} label="活跃任务" hint={`${averageProgress}% 平均进度`} onClick={() => applyMetricFilter('all')} />
        <MetricCard icon="alert" tone="red" value={metrics.blocked.length} label="已阻塞" hint={metrics.blocked.length ? '需要协调处理' : '当前无阻塞'} onClick={() => applyMetricFilter('blocked')} />
        <MetricCard icon="calendar" tone="violet" value={metrics.dueThisWeek.length} label="本周到期" hint="按预计完成日统计" onClick={() => applyMetricFilter('risk')} />
        <MetricCard icon="radar" tone="amber" value={metrics.overdue.length + metrics.unscheduled.length} label="交付风险" hint={`${metrics.overdue.length} 逾期 · ${metrics.unscheduled.length} 未排期`} onClick={() => applyMetricFilter('risk')} />
      </section>

      <section className="overview-grid">
        <article className="focus-card card">
          {focusTask ? (
            <>
              <div className="panel-heading">
                <div><span className="eyebrow">Highest priority</span><h2>当前最高优先级</h2></div>
                <StatusBadge status={focusTask.status} />
              </div>
              <button className="focus-title" onClick={() => navigate(`/task/${focusTask.id}`)}>{focusTask.title}</button>
              <p className="focus-status">{focusTask.current_status || '尚未填写当前情况'}</p>
              <div className="focus-progress-wrap">
                <TaskProgress progress={focusTask.progress} overdue={isOverdue(focusTask)} />
                <FocusMascot />
              </div>
              <div className="focus-meta-grid">
                <div><span>开始日期</span><strong>{zhDate(focusTask.start_date)}</strong></div>
                <div><span>预计完成</span><strong className={isOverdue(focusTask) ? 'txt-warn' : ''}>{zhDate(focusTask.expected_end_date)}</strong></div>
                <div><span>最近活动</span><strong>{relativeActivity(latestActivity(focusTask, latestByTask))}</strong></div>
              </div>
              {focusTask.status === 'blocked' && focusTask.block_reason && <div className="focus-alert">阻塞：{focusTask.block_reason}</div>}
              <div className="focus-actions">
                <button className="btn btn-primary" onClick={() => navigate(`/task/${focusTask.id}`)}>查看详情<DashboardIcon name="arrow" /></button>
                <button className="btn btn-ghost" onClick={() => navigate(`/task/${focusTask.id}?comment=1`)}><DashboardIcon name="comment" />留言</button>
              </div>
            </>
          ) : (
            <div className="empty-focus"><span className="eyebrow">All clear</span><h2>当前没有活跃任务</h2><p>可以从后续计划中启动下一项工作。</p></div>
          )}
        </article>

        <article className="health-card card">
          <div className="panel-heading"><div><span className="eyebrow">Portfolio health</span><h2>工作组合健康度</h2></div></div>
          <div className="health-visual">
            <div className="completion-ring" style={{ '--completion': `${completionRate * 3.6}deg` } as CSSProperties} aria-label={`整体完成率 ${completionRate}%`}>
              <div><strong>{completionRate}%</strong><span>整体完成率</span></div>
            </div>
            <div className="health-legend">
              <HealthLegend tone="blue" label="活跃" value={activeTasks.length} />
              <HealthLegend tone="green" label="已完成" value={completedCount} />
              <HealthLegend tone="gray" label="待开始" value={plannedTasks.length} />
            </div>
          </div>
          <div className="health-bars">
            <HealthBar label="活跃任务平均进度" value={averageProgress} tone="blue" />
            <HealthBar label="活跃任务排期完整度" value={scheduledRate} tone={scheduledRate < 60 ? 'amber' : 'green'} />
          </div>
        </article>
      </section>

      {attentionTasks.length > 0 && (
        <section className="attention-panel card">
          <div className="panel-heading">
            <div><span className="eyebrow">Needs attention</span><h2>需要关注</h2></div>
            <span className="section-caption">优先展示阻塞、逾期和未排期事项</span>
          </div>
          <div className="attention-list">
            {attentionTasks.map((task) => (
              <button className="attention-row" key={task.id} onClick={() => navigate(`/task/${task.id}`)}>
                <span className={`risk-indicator risk-${riskTone(task)}`} />
                <span className="attention-main"><strong>{task.title}</strong><span>{riskLabel(task)}</span></span>
                <span className="attention-progress">{task.progress}%</span>
                <DashboardIcon name="chevron" />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="active-work-section" id="active-work">
        <div className="section-heading-row">
          <div><span className="eyebrow">Active portfolio</span><h2>活跃任务</h2></div>
          <span className="section-caption">显示 {visibleTasks.length} / {activeTasks.length}</span>
        </div>
        <div className="work-controls">
          <label className="search-box"><DashboardIcon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务或当前进展" aria-label="搜索活跃任务" /></label>
          <div className="filter-chips" role="group" aria-label="任务筛选">
            {([['all', '全部'], ['risk', '有风险'], ['blocked', '阻塞'], ['unscheduled', '未排期']] as const).map(([value, label]) => (
              <button key={value} className={`filter-chip ${workFilter === value ? 'filter-chip-active' : ''}`} onClick={() => setWorkFilter(value)}>{label}</button>
            ))}
          </div>
        </div>

        <div className="work-list">
          {visibleTasks.length === 0 ? <div className="work-empty">没有匹配的活跃任务</div> : visibleTasks.map((task) => (
            <article className="work-row" key={task.id}>
              <span className={`work-rail rail-${statusTone(task)}`} />
              <button className="work-main" onClick={() => navigate(`/task/${task.id}`)}>
                <span className="work-title-line"><strong>{task.title}</strong>{task.is_interrupt_task && <span className="tag tag-interrupt">临时</span>}</span>
                <span className="work-status-text">{task.current_status || '尚未填写当前情况'}</span>
              </button>
              <div className="work-progress"><TaskProgress progress={task.progress} overdue={isOverdue(task)} size="sm" /></div>
              <div className="work-due"><span>预计完成</span><strong className={isOverdue(task) || !task.expected_end_date ? 'txt-warn' : ''}>{task.expected_end_date ? shortDate(task.expected_end_date) : '未排期'}</strong></div>
              <StatusBadge status={task.status} />
              <button className="comment-shortcut" onClick={() => navigate(`/task/${task.id}?comment=1`)} title="查看或添加留言" aria-label={`${task.title}的留言`}><DashboardIcon name="comment" /><span>{commentsByTask.get(task.id) ?? 0}</span></button>
            </article>
          ))}
        </div>
      </section>

      <section className="dashboard-bottom-grid">
        <article className="activity-card card">
          <div className="panel-heading">
            <div><span className="eyebrow">Latest activity</span><h2>最近动态</h2></div>
            <button className="text-button" onClick={() => setShowAllUpdates((value) => !value)}>{showAllUpdates ? '收起' : '展开更多'}</button>
          </div>
          <div className="activity-list">
            {recentUpdates.map((update) => {
              const task = byId.get(update.task_id)
              const comment = isComment(update)
              return (
                <button className={`activity-row ${comment ? 'activity-comment' : ''}`} key={update.id} onClick={() => task && navigate(`/task/${task.id}${comment ? '?comment=1' : ''}`)}>
                  <span className={`activity-icon ${comment ? 'activity-icon-comment' : ''}`}><DashboardIcon name={comment ? 'comment' : 'pulse'} /></span>
                  <span className="activity-body">
                    <span className="activity-meta"><strong>{comment ? `${update.created_by || 'Leader'} 留言` : task?.title || '已删除任务'}</strong><time>{shortDateTime(update.created_at)}</time></span>
                    <span>{comment ? commentBody(update) : update.content}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </article>

        <div className="side-stack">
          <article className="side-card card">
            <div className="panel-heading compact-heading"><div><span className="eyebrow">Coming next</span><h2>接下来</h2></div><span className="count-pill">{plannedTasks.length}</span></div>
            <div className="compact-list">
              {plannedTasks.length === 0 ? <p className="empty-copy">暂无待开始任务</p> : plannedTasks.slice(0, 4).map((task) => (
                <button key={task.id} onClick={() => navigate(`/task/${task.id}`)}><span className="compact-date">{shortDate(task.start_date)}</span><span>{task.title}</span><DashboardIcon name="chevron" /></button>
              ))}
            </div>
          </article>

          <article className="side-card card">
            <div className="panel-heading compact-heading"><div><span className="eyebrow">Recently shipped</span><h2>最近完成</h2></div></div>
            <div className="compact-list compact-list-success">
              {completedTasks.map((task) => (
                <button key={task.id} onClick={() => navigate(`/task/${task.id}`)}><span className="success-check">✓</span><span>{task.title}</span><time>{relativeDay(task.actual_end_date)}</time></button>
              ))}
            </div>
          </article>
        </div>
      </section>

      {quickTask && <QuickUpdateModal task={quickTask} service={service} onClose={() => setQuickTask(null)} onDone={notify} />}
      {showCreate && <CreateTaskModal service={service} onClose={() => setShowCreate(false)} onDone={notify} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function MetricCard({ icon, tone, value, label, hint, onClick }: { icon: DashboardIconName; tone: 'blue' | 'red' | 'violet' | 'amber'; value: number; label: string; hint: string; onClick: () => void }) {
  return <button className={`metric-card metric-${tone}`} onClick={onClick}><span className="metric-icon"><DashboardIcon name={icon} /></span><span className="metric-copy"><strong>{value}</strong><span>{label}</span><small>{hint}</small></span><DashboardIcon name="chevron" /></button>
}

function HealthLegend({ tone, label, value }: { tone: string; label: string; value: number }) {
  return <div className="health-legend-row"><span className={`legend-dot legend-${tone}`} /><span>{label}</span><strong>{value}</strong></div>
}

function HealthBar({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className="health-bar-row"><div><span>{label}</span><strong>{value}%</strong></div><div className="health-bar-track"><span className={`health-bar-fill health-${tone}`} style={{ width: `${value}%` }} /></div></div>
}

function DashboardSkeleton() {
  return <div className="page dashboard-page" aria-label="看板加载中"><div className="skeleton skeleton-title" /><div className="metric-grid">{[0, 1, 2, 3].map((item) => <div className="skeleton skeleton-metric" key={item} />)}</div><div className="skeleton skeleton-panel" /></div>
}

type DashboardIconName = 'pulse' | 'alert' | 'calendar' | 'radar' | 'arrow' | 'chevron' | 'comment' | 'plus' | 'search'

function DashboardIcon({ name }: { name: DashboardIconName }) {
  const paths: Record<DashboardIconName, ReactNode> = {
    pulse: <path d="M3 12h4l2-5 4 10 2-5h6" />,
    alert: <><path d="M12 3 2.8 19h18.4L12 3Z" /><path d="M12 9v4M12 16.5v.1" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>,
    radar: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="m12 12 6-6" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    chevron: <path d="m9 6 6 6-6 6" />,
    comment: <path d="M20 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4v8Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  }
  return <svg className="dashboard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function FocusMascot() {
  return (
    <svg className="focus-mascot" viewBox="0 0 92 62" aria-hidden="true">
      <path d="M20 25 27 9l12 12M72 25 65 9 53 21" fill="#fffaf6" stroke="#695883" strokeWidth="3" strokeLinejoin="round" />
      <path d="M24 29c0-14 10-23 22-23s22 9 22 23v7c0 13-10 21-22 21s-22-8-22-21v-7Z" fill="#fffaf6" stroke="#695883" strokeWidth="3" />
      <path d="M31 17 27 10l9 9M61 17l4-7-9 9" fill="#f6b8ca" opacity=".72" />
      <ellipse cx="37" cy="33" rx="2.5" ry="3.5" fill="#514260" />
      <ellipse cx="55" cy="33" rx="2.5" ry="3.5" fill="#514260" />
      <path d="M43 39c2 2 4 2 6 0M46 36v3" fill="none" stroke="#514260" strokeWidth="2" strokeLinecap="round" />
      <ellipse cx="31" cy="39" rx="5" ry="2.6" fill="#f7b4c6" opacity=".55" />
      <ellipse cx="61" cy="39" rx="5" ry="2.6" fill="#f7b4c6" opacity=".55" />
      <path d="M8 57h76" stroke="#8c75d8" strokeWidth="5" strokeLinecap="round" />
      <path d="M21 55c5-6 8-8 13-8M71 55c-5-6-8-8-13-8" fill="none" stroke="#695883" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

function isActive(task: Task): boolean {
  return task.status === 'in_progress' || task.status === 'blocked' || task.status === 'paused'
}

function isOverdue(task: Task): boolean {
  return !!task.expected_end_date && isActive(task) && task.expected_end_date < todayISO()
}

function riskRank(task: Task): number {
  if (task.status === 'blocked') return 0
  if (isOverdue(task)) return 1
  if (!task.expected_end_date) return 2
  return 3
}

function riskTone(task: Task): 'red' | 'amber' | 'blue' {
  if (task.status === 'blocked' || isOverdue(task)) return 'red'
  if (!task.expected_end_date) return 'amber'
  return 'blue'
}

function riskLabel(task: Task): string {
  if (task.status === 'blocked') return `阻塞：${task.block_reason || '等待处理'}`
  if (isOverdue(task)) return `已逾期 · 原计划 ${shortDate(task.expected_end_date)}`
  if (!task.expected_end_date) return '尚未设置预计完成日期'
  return task.current_status || '需要关注'
}

function statusTone(task: Task): string {
  if (task.status === 'blocked') return 'red'
  if (task.status === 'paused') return 'amber'
  return 'blue'
}

function latestActivity(task: Task, latestByTask: Map<string, TaskUpdate>): string {
  return latestByTask.get(task.id)?.created_at ?? task.updated_at
}

function relativeActivity(iso: string): string {
  const timestamp = new Date(iso).getTime()
  if (!Number.isFinite(timestamp)) return shortDateTime(iso)
  const days = Math.floor((Date.now() - timestamp) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  return `${days} 天前`
}

function weekStartISO(): string {
  const date = new Date()
  const day = date.getDay() || 7
  date.setDate(date.getDate() - day + 1)
  return localDateISO(date)
}

function addDaysISO(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00`)
  date.setDate(date.getDate() + days)
  return localDateISO(date)
}

function localDateISO(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function todayText(): string {
  const date = new Date()
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()]
  return `${date.getMonth() + 1}月${date.getDate()}日 周${weekday}`
}
