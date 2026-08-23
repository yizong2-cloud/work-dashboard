import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  ChevronRight,
  MessageSquare,
  Plus,
  Search,
  Target,
  type LucideIcon,
} from 'lucide-react'
import type { FeedbackThread, Task, TaskUpdate } from '../types'
import { appConfig } from '../config'
import { getDB } from '../lib/dbFactory'
import { useTaskService } from '../hooks/useTaskService'
import { useFeedbackService } from '../hooks/useFeedbackService'
import { TaskProgress } from '../components/TaskProgress'
import { StatusBadge } from '../components/StatusBadge'
import { QuickUpdateModal } from '../components/QuickUpdateModal'
import { CreateTaskModal } from '../components/CreateTaskModal'
import { commentBody, isComment } from '../lib/comments'
import { shortDate, shortDateTime, relativeDay, taskDataFreshness, todayISO, zhDate } from '../lib/format'
import { plannedStartPresentation } from '../lib/dashboardPlanning'
import { dashboardSignals, isDashboardActive, isTaskOverdue, matchesDashboardFilter, type DashboardWorkFilter } from '../lib/dashboardSignals'

const PRIORITY_ORDER = { urgent: -1, high: 0, normal: 1, low: 2 } as const
type WorkFilter = DashboardWorkFilter
const mascotAsset = (name: string) => `${import.meta.env.BASE_URL}mascots/mascot-${name}.png`

export function Dashboard() {
  const navigate = useNavigate()
  const isLocalMode = appConfig.dataMode === 'local'
  const db = getDB()
  const service = useTaskService(db)
  const feedback = useFeedbackService(db)

  const [tasks, setTasks] = useState<Task[]>([])
  const [allUpdates, setAllUpdates] = useState<TaskUpdate[]>([])
  const [allThreads, setAllThreads] = useState<FeedbackThread[]>([])
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
      const [ts, us, th] = await Promise.all([
        service.listTasks(),
        db.listAllUpdates(),
        feedback.listAllThreads(),
      ])
      setTasks(ts)
      setAllUpdates(us)
      setAllThreads(th)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [service, db, feedback])

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

  // 待处理催办：仅当任务最新一条时间线是 nudge（Leader 催了但尚未回应）时显示。
  // 负责人一旦更新任务（进度/备注等），最新时间线不再是 nudge，闹钟自动消失。
  const pendingNudgesByTask = useMemo(() => {
    const byTask = new Map<string, TaskUpdate[]>()
    for (const update of allUpdates) {
      const arr = byTask.get(update.task_id) ?? []
      arr.push(update)
      byTask.set(update.task_id, arr)
    }
    const map = new Map<string, number>()
    for (const [taskId, updates] of byTask) {
      const sorted = [...updates].sort((a, b) => a.created_at.localeCompare(b.created_at))
      let count = 0
      for (let i = sorted.length - 1; i >= 0 && sorted[i].type === 'nudge'; i--) count++
      if (count > 0) map.set(taskId, count)
    }
    return map
  }, [allUpdates])

  // 反馈线程（任务一）：未解决统计 + 每任务未解决数 + 最近反馈
  const unresolvedThreads = useMemo(
    () =>
      allThreads
        .filter((t) => (t.kind ?? 'leader_feedback') === 'leader_feedback' && t.status !== 'resolved')
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [allThreads],
  )
  const unresolvedByTask = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of unresolvedThreads) map.set(t.task_id, (map.get(t.task_id) ?? 0) + 1)
    return map
  }, [unresolvedThreads])

  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const activeTasks = useMemo(
    () =>
      tasks
        .filter(isDashboardActive)
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
    () => activeTasks.find((task) => task.status === 'in_progress' && (task.priority === 'urgent' || task.priority === 'high')) ?? activeTasks[0] ?? null,
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

  const metrics = useMemo(() => dashboardSignals(tasks, todayISO()), [tasks])

  const attentionTasks = useMemo(
    () => metrics.attention.slice(0, 5),
    [metrics],
  )

  const visibleTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return activeTasks.filter((task) => {
      const matchesQuery = !normalizedQuery || `${task.title} ${task.current_status} ${task.description}`.toLowerCase().includes(normalizedQuery)
      const matchesFilter = matchesDashboardFilter(task, workFilter, todayISO())
      return matchesQuery && matchesFilter
    })
  }, [activeTasks, query, workFilter])

  const recentUpdates = useMemo(() => allUpdates.slice(0, showAllUpdates ? 16 : 6), [allUpdates, showAllUpdates])
  const averageProgress = activeTasks.length ? Math.round(activeTasks.reduce((sum, task) => sum + task.progress, 0) / activeTasks.length) : 0
  const scheduledCount = activeTasks.filter((task) => task.expected_end_date).length
  const scheduledRate = activeTasks.length ? Math.round((scheduledCount / activeTasks.length) * 100) : 100
  const completedCount = tasks.filter((task) => task.status === 'completed').length
  const completionRate = tasks.length ? Math.round((completedCount / tasks.length) * 100) : 0
  const dataFreshness = taskDataFreshness(allUpdates[0]?.created_at)

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
        <div>
          <span className="eyebrow">Delivery overview · {todayText()}</span>
          <h1>工作进度总览</h1>
          <p>聚焦正在推进的事项、交付预警、待补排期与需要决策的问题。</p>
        </div>
        <div className="intro-actions">
          <div className={`sync-state sync-state-${dataFreshness.tone}`} title={dataFreshness.detail}>
            <span className="sync-dot" />
            <span>{dataFreshness.label} {shortDateTime(allUpdates[0]?.created_at)}</span>
          </div>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            <DashboardIcon name="plus" />新建任务
          </button>
        </div>
      </header>

      <section className="metric-grid" aria-label="工作状态概览">
        <MetricCard icon="pulse" tone="blue" value={activeTasks.length} label="活跃任务" hint={`${averageProgress}% 平均进度`} onClick={() => applyMetricFilter('all')} />
        <MetricCard icon="alert" tone="red" value={metrics.blocked.length} label="已阻塞" hint={metrics.blocked.length ? '需要协调处理' : '当前无阻塞'} onClick={() => applyMetricFilter('blocked')} />
        <MetricCard icon="calendar" tone="violet" value={metrics.dueThisWeek.length} label="本周到期" hint="按预计完成日统计" onClick={() => applyMetricFilter('delivery_warning')} />
        <MetricCard icon="radar" tone="amber" value={metrics.unscheduled.length} label="待补排期" hint={`${activeTasks.length} 个活跃任务中未设完成日`} onClick={() => applyMetricFilter('unscheduled')} />
        <MetricCard
          icon="message"
          tone="blue"
          value={unresolvedThreads.length}
          label="待回应反馈"
          hint={unresolvedThreads.length ? 'Leader 留言待跟进' : '当前无未解决反馈'}
          onClick={() => {
            const t = unresolvedThreads[0]
            if (t) navigate(`/task/${t.task_id}?thread=${t.id}`)
          }}
        />
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
              <TaskProgress progress={focusTask.progress} overdue={isOverdue(focusTask)} />
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
              <div className="focus-mascot-frame" aria-hidden="true">
                <img src={mascotAsset('hero')} alt="" decoding="async" />
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
            <div className="attention-heading-side">
              <span className="section-caption">优先展示阻塞与已逾期事项；待补排期单独查看</span>
              <span className="mini-mascot-frame" aria-hidden="true"><img src={mascotAsset('blocked')} alt="" loading="lazy" decoding="async" /></span>
            </div>
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
            {([['all', '全部'], ['delivery_warning', '交付预警'], ['blocked', '阻塞'], ['unscheduled', '待补排期']] as const).map(([value, label]) => (
              <button key={value} className={`filter-chip ${workFilter === value ? 'filter-chip-active' : ''}`} onClick={() => setWorkFilter(value)}>{label}</button>
            ))}
          </div>
        </div>

        <div className="work-list">
          {visibleTasks.length === 0 ? <div className="work-empty">没有匹配的活跃任务</div> : visibleTasks.map((task) => (
            <article className="work-row" key={task.id}>
              <span className={`work-rail rail-${statusTone(task)}`} />
              <button className="work-main" onClick={() => navigate(`/task/${task.id}`)}>
                <span className="work-title-line"><strong>{task.title}</strong>{task.is_interrupt_task && <span className="tag tag-interrupt">临时</span>}{task.priority === 'urgent' && <span className="tag tag-urgent">🔥 加急</span>}{pendingNudgesByTask.get(task.id) ? <span className="nudge-count" title="Leader 催了进度，尚未回应；更新任务后自动消失">⏰ ×{pendingNudgesByTask.get(task.id)}</span> : null}</span>
                <span className="work-status-text">{task.current_status || '尚未填写当前情况'}</span>
              </button>
              <div className="work-progress"><TaskProgress progress={task.progress} overdue={isOverdue(task)} size="sm" /></div>
              <div className="work-due"><span>预计完成</span><strong className={isOverdue(task) || !task.expected_end_date ? 'txt-warn' : ''}>{task.expected_end_date ? shortDate(task.expected_end_date) : '未排期'}</strong>{!task.expected_end_date && task.current_status && <small className="due-reason" title={task.current_status.slice(0, 80)}>{task.current_status.slice(0, 18)}{task.current_status.length > 18 ? '…' : ''}</small>}</div>
              <StatusBadge status={task.status} />
              <button
                className={`comment-shortcut ${unresolvedByTask.get(task.id) ? 'comment-shortcut-open' : ''}`}
                onClick={() => {
                  const t = unresolvedThreads.find((x) => x.task_id === task.id)
                  navigate(t ? `/task/${task.id}?thread=${t.id}` : `/task/${task.id}?comment=1`)
                }}
                title="未解决反馈或留言"
                aria-label={`${task.title}的反馈与留言`}
              >
                <DashboardIcon name="comment" />
                <span>{unresolvedByTask.get(task.id) ?? commentsByTask.get(task.id) ?? 0}</span>
              </button>
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
            <div className="panel-heading compact-heading">
              <div><span className="eyebrow">Feedback</span><h2>待回应反馈</h2></div>
              <span className={`count-pill ${unresolvedThreads.length > 0 ? 'count-pill-open' : ''}`}>{unresolvedThreads.length}</span>
            </div>
            <div className="compact-list">
              {unresolvedThreads.length === 0 ? (
                <p className="empty-copy">暂无未解决反馈</p>
              ) : (
                unresolvedThreads.slice(0, 4).map((thread) => {
                  const task = byId.get(thread.task_id)
                  return (
                    <button key={thread.id} onClick={() => navigate(`/task/${thread.task_id}?thread=${thread.id}`)}>
                      <span className="compact-date">{shortDate(thread.latest_message_at ?? thread.created_at)}</span>
                      <span>{task?.title || '（已删除任务）'}：{thread.latest_message || thread.latest_author || '反馈'}</span>
                      <DashboardIcon name="chevron" />
                    </button>
                  )
                })
              )}
            </div>
          </article>
          <article className="side-card card">
            <div className="panel-heading compact-heading"><div><span className="eyebrow">Awaiting start</span><h2>待启动</h2></div><span className="count-pill">{plannedTasks.length}</span></div>
            <div className="compact-list compact-list-planned">
              {plannedTasks.length === 0 ? <p className="empty-copy">暂无待启动任务</p> : plannedTasks.slice(0, 4).map((task) => {
                const start = plannedStartPresentation(task)
                return (
                  <button key={task.id} onClick={() => navigate(`/task/${task.id}`)} title={task.current_status || start.label}>
                    <span className={`compact-date ${start.needsAttention ? 'compact-date-warning' : ''}`}>{start.label}</span>
                    <span>{task.title}</span><DashboardIcon name="chevron" />
                  </button>
                )
              })}
            </div>
          </article>

          <article className="side-card card">
            <div className="panel-heading compact-heading">
              <div><span className="eyebrow">Recently shipped</span><h2>最近完成</h2></div>
              <span className="mini-mascot-frame mini-mascot-completed" aria-hidden="true"><img src={mascotAsset('completed')} alt="" loading="lazy" decoding="async" /></span>
            </div>
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
  return <div className="page dashboard-page" aria-label="看板加载中"><div className="skeleton skeleton-title" /><div className="metric-grid">{[0, 1, 2, 3].map((item) => <div className="skeleton skeleton-metric" key={item} />)}</div><div className="skeleton skeleton-panel skeleton-mascot-panel"><img src={mascotAsset('working')} alt="" aria-hidden="true" decoding="async" /></div></div>
}

type DashboardIconName = 'pulse' | 'alert' | 'calendar' | 'radar' | 'arrow' | 'chevron' | 'comment' | 'message' | 'plus' | 'search'

function DashboardIcon({ name }: { name: DashboardIconName }) {
  const icons: Record<DashboardIconName, LucideIcon> = {
    message: MessageSquare,
    pulse: Activity,
    alert: AlertTriangle,
    calendar: CalendarDays,
    radar: Target,
    arrow: ArrowRight,
    chevron: ChevronRight,
    comment: MessageSquare,
    plus: Plus,
    search: Search,
  }
  const Icon = icons[name]
  return <Icon className="dashboard-icon" strokeWidth={1.8} aria-hidden="true" />
}

function isOverdue(task: Task): boolean {
  return isTaskOverdue(task, todayISO())
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

function todayText(): string {
  const date = new Date()
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()]
  return `${date.getMonth() + 1}月${date.getDate()}日 周${weekday}`
}
