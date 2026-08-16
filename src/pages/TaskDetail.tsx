import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { Task, TaskUpdate } from '../types'
import { getDB } from '../lib/dbFactory'
import { useTaskService } from '../hooks/useTaskService'
import { StatusBadge } from '../components/StatusBadge'
import { PriorityBadge } from '../components/PriorityBadge'
import { TaskProgress } from '../components/TaskProgress'
import { TaskTimeline } from '../components/TaskTimeline'
import { QuickUpdateModal } from '../components/QuickUpdateModal'
import { zhDate, shortDateTime } from '../lib/format'

export function TaskDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const db = getDB()
  const service = useTaskService(db)

  const [task, setTask] = useState<Task | null>(null)
  const [updates, setUpdates] = useState<TaskUpdate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [quick, setQuick] = useState(false)
  const [toast, setToast] = useState('')

  const refresh = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError('')
    try {
      const [t, us] = await Promise.all([service.getTask(id), service.listUpdates(id)])
      if (!t) {
        setError('任务不存在或已被删除')
      } else {
        setTask(t)
        setUpdates(us)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [id, service])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function remove() {
    if (!task) return
    if (!window.confirm(`确定删除任务「${task.title}」？其时间线记录也会一并删除。`)) return
    try {
      await service.deleteTask(task.id)
      navigate('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (loading) {
    return (
      <div className="page">
        <p className="muted">加载中…</p>
      </div>
    )
  }
  if (error || !task) {
    return (
      <div className="page">
        <p className="banner banner-error">{error || '任务不存在'}</p>
        <Link className="btn btn-ghost" to="/">
          返回看板
        </Link>
      </div>
    )
  }

  const overdue =
    !!task.expected_end_date &&
    task.status !== 'completed' &&
    task.status !== 'cancelled' &&
    task.expected_end_date < new Date().toISOString().slice(0, 10)

  return (
    <div className="page">
      <Link className="back-link" to="/">
        ← 返回看板
      </Link>

      <div className="detail-head card">
        <div className="detail-title-row">
          <h1>
            {task.is_interrupt_task && <span className="tag tag-interrupt">临时</span>}
            {task.title}
          </h1>
          <div className="row-gap">
            <StatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
          </div>
        </div>
        {task.description && <p className="detail-desc">{task.description}</p>}
        <TaskProgress progress={task.progress} overdue={overdue} />

        <div className="detail-info">
          <div className="info-item">
            <span className="info-label">开始日期</span>
            <span>{zhDate(task.start_date)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">预计完成</span>
            <span className={overdue ? 'txt-warn' : ''}>
              {zhDate(task.expected_end_date)}
              {overdue && '（已逾期）'}
            </span>
          </div>
          <div className="info-item">
            <span className="info-label">实际完成</span>
            <span>{zhDate(task.actual_end_date)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">创建于</span>
            <span>{shortDateTime(task.created_at)}</span>
          </div>
          <div className="info-item">
            <span className="info-label">最后更新</span>
            <span>
              {shortDateTime(
                updates.length > 0
                  ? updates[updates.length - 1].created_at // 最新时间线时间（真实活动）
                  : task.updated_at,
              )}
            </span>
          </div>
        </div>

        {task.current_status && (
          <div className="current-status">
            <span className="info-label">当前情况</span>
            <p>{task.current_status}</p>
          </div>
        )}
        {task.status === 'blocked' && task.block_reason && (
          <div className="current-status">
            <span className="info-label">阻塞原因</span>
            <p className="block-reason">⛔ {task.block_reason}</p>
          </div>
        )}

        <div className="row-gap">
          <button className="btn btn-primary" onClick={() => setQuick(true)}>
            快速更新
          </button>
          <button className="btn btn-danger btn-sm" onClick={() => void remove()}>
            删除任务
          </button>
        </div>
      </div>

      <section className="detail-section">
        <h2>任务时间线</h2>
        <p className="muted">每一次进展、阻塞、排期调整都会记录在这里。</p>
        <TaskTimeline updates={updates} />
      </section>

      {quick && (
        <QuickUpdateModal
          task={task}
          service={service}
          onClose={() => setQuick(false)}
          onDone={(msg) => {
            setToast(msg)
            window.setTimeout(() => setToast(''), 3000)
            void refresh()
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
