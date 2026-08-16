import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { FeedbackThread, Task, TaskUpdate } from '../types'
import { getDB } from '../lib/dbFactory'
import { useTaskService } from '../hooks/useTaskService'
import { useFeedbackService } from '../hooks/useFeedbackService'
import type { LegacyComment } from '../lib/feedbackService'
import { StatusBadge } from '../components/StatusBadge'
import { PriorityBadge } from '../components/PriorityBadge'
import { TaskProgress } from '../components/TaskProgress'
import { TaskTimeline } from '../components/TaskTimeline'
import { QuickUpdateModal } from '../components/QuickUpdateModal'
import { FeedbackPanel } from '../components/FeedbackPanel'
import { isComment } from '../lib/comments'
import { todayISO, zhDate, shortDateTime } from '../lib/format'

export function TaskDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const db = getDB()
  const service = useTaskService(db)
  const feedback = useFeedbackService(db)

  const [task, setTask] = useState<Task | null>(null)
  const [updates, setUpdates] = useState<TaskUpdate[]>([])
  const [threads, setThreads] = useState<FeedbackThread[]>([])
  const [legacyComments, setLegacyComments] = useState<LegacyComment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [quick, setQuick] = useState(false)
  const [toast, setToast] = useState('')

  const focusThreadId = searchParams.get('thread')
  const focusFeedback = searchParams.get('comment') === '1' || !!focusThreadId

  const refresh = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError('')
    try {
      const [nextTask, nextUpdates, feedbackData] = await Promise.all([
        service.getTask(id),
        service.listUpdates(id),
        feedback.listThreads(id),
      ])
      if (!nextTask) setError('任务不存在或已被删除')
      else {
        setTask(nextTask)
        setUpdates(nextUpdates)
        setThreads(feedbackData.threads)
        setLegacyComments(feedbackData.legacyComments)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [id, service, feedback])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const timelineUpdates = useMemo(() => updates.filter((update) => !isComment(update)), [updates])

  function notify(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(''), 3000)
    void refresh()
  }

  async function remove() {
    if (!task) return
    if (!window.confirm(`确定删除任务「${task.title}」？其时间线和留言也会一并删除。`)) return
    try {
      await service.deleteTask(task.id)
      navigate('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (loading) {
    return <div className="page detail-page"><div className="skeleton skeleton-title" /><div className="skeleton skeleton-panel" /></div>
  }

  if (error || !task) {
    return (
      <div className="page detail-page">
        <p className="banner banner-error">{error || '任务不存在'}</p>
        <Link className="btn btn-ghost" to="/">返回看板</Link>
      </div>
    )
  }

  const overdue = !!task.expected_end_date
    && task.status !== 'completed'
    && task.status !== 'cancelled'
    && task.expected_end_date < todayISO()
  const lastActivity = updates.length > 0 ? updates[updates.length - 1].created_at : task.updated_at

  return (
    <div className="page detail-page">
      <div className="detail-topbar">
        <Link className="back-link" to="/"><span aria-hidden="true">←</span> 返回总览</Link>
        <span className="detail-activity">最近活动 {shortDateTime(lastActivity)}</span>
      </div>

      <article className={`detail-hero card ${task.status === 'blocked' ? 'detail-hero-blocked' : ''}`}>
        <div className="detail-kicker-row">
          <div className="detail-badges">
            <StatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
            {task.is_interrupt_task && <span className="tag tag-interrupt">临时任务</span>}
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setQuick(true)}>快速更新</button>
        </div>
        <h1>{task.title}</h1>
        {task.description && <p className="detail-desc">{task.description}</p>}

        <div className="detail-progress-block">
          <div className="detail-progress-label"><span>任务进度</span></div>
          <TaskProgress progress={task.progress} overdue={overdue} />
        </div>

        <div className="detail-facts">
          <Fact label="开始日期" value={zhDate(task.start_date)} />
          <Fact label="预计完成" value={zhDate(task.expected_end_date)} warn={overdue || !task.expected_end_date} suffix={overdue ? '已逾期' : undefined} />
          <Fact label="实际完成" value={zhDate(task.actual_end_date)} />
          <Fact label="创建时间" value={shortDateTime(task.created_at)} />
        </div>

        {task.current_status && (
          <div className="detail-current">
            <span>当前情况</span>
            <p>{task.current_status}</p>
          </div>
        )}
        {task.status === 'blocked' && task.block_reason && (
          <div className="detail-blocker"><strong>当前阻塞</strong><p>{task.block_reason}</p></div>
        )}
      </article>

      <div className="detail-content-grid">
        <section className="timeline-panel card">
          <div className="panel-heading">
            <div><span className="eyebrow">Activity history</span><h2>任务时间线</h2></div>
            <span className="count-pill">{timelineUpdates.length}</span>
          </div>
          <p className="section-intro">进展、阻塞与排期变化会按时间完整保留。</p>
          <TaskTimeline updates={timelineUpdates} />
        </section>

        <aside className="detail-sidebar">
          <FeedbackPanel
            taskId={task.id}
            service={feedback}
            threads={threads}
            legacyComments={legacyComments}
            autoFocus={focusFeedback}
            initialThreadId={focusThreadId}
            onChanged={() => void refresh()}
            onNotify={notify}
          />
          <details className="danger-zone">
            <summary>任务管理</summary>
            <p>删除后任务、时间线和留言都不可恢复。</p>
            <button className="btn btn-danger btn-sm" onClick={() => void remove()}>删除任务</button>
          </details>
        </aside>
      </div>

      {quick && <QuickUpdateModal task={task} service={service} onClose={() => setQuick(false)} onDone={notify} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function Fact({ label, value, warn = false, suffix }: { label: string; value: string; warn?: boolean; suffix?: string }) {
  return (
    <div className="detail-fact">
      <span>{label}</span>
      <strong className={warn ? 'txt-warn' : ''}>{value}</strong>
      {suffix && <small>{suffix}</small>}
    </div>
  )
}
