import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, CheckCircle2, Clock3, Inbox, MessageSquare } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { FeedbackThread, Task } from '../types'
import { getDB } from '../lib/dbFactory'
import { useFeedbackService } from '../hooks/useFeedbackService'
import { shortDateTime } from '../lib/format'

const STATUS_LABEL = { open: '待处理', in_progress: '处理中', resolved: '已解决' } as const

/**
 * Agent 处理箱：未解决线程的统一入口。
 * 这里只负责聚合与定位，不自动解释或执行自然语言，避免误改任务。
 */
export function FeedbackInbox() {
  const db = getDB()
  const feedback = useFeedbackService(db)
  const [threads, setThreads] = useState<FeedbackThread[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [showResolved, setShowResolved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [nextThreads, nextTasks] = await Promise.all([feedback.listAllThreads('agent_instruction'), db.listTasks()])
      setThreads(nextThreads)
      setTasks(nextTasks)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [db, feedback])

  useEffect(() => { void refresh() }, [refresh])

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks])
  const visible = useMemo(
    () => threads
      .filter((thread) => showResolved || thread.status !== 'resolved')
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [threads, showResolved],
  )
  const pendingCount = threads.filter((thread) => thread.status !== 'resolved').length

  return (
    <div className="page feedback-inbox-page">
      <header className="page-heading inbox-heading">
        <div>
          <span className="eyebrow">Agent inbox</span>
          <h1>处理箱</h1>
          <p>你在任务上留下的问题会集中在这里，Agent 读取后再决定如何修改。</p>
        </div>
        <div className="inbox-heading-actions">
          <span className={`inbox-count ${pendingCount > 0 ? 'inbox-count-open' : ''}`}>
            {pendingCount > 0 ? `${pendingCount} 条待处理` : '当前没有待处理留言'}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowResolved((value) => !value)}>
            {showResolved ? '只看待处理' : '查看已解决'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </header>

      {error && <div className="banner banner-error">{error}</div>}
      {!loading && visible.length === 0 && (
        <section className="inbox-empty card">
          <Inbox size={30} strokeWidth={1.5} aria-hidden="true" />
          <h2>{showResolved ? '还没有留言' : '处理箱是空的'}</h2>
          <p>打开任意任务，点击「交给 Agent 处理」，用自然语言写下需要修正的地方。</p>
        </section>
      )}
      <section className="inbox-list">
        {visible.map((thread) => {
          const task = taskById.get(thread.task_id)
          return (
            <article className={`inbox-item card inbox-item-${thread.status}`} key={thread.id}>
              <div className="inbox-item-main">
                <div className="inbox-item-topline">
                  <span className={`thread-status st-${thread.status}`}>{STATUS_LABEL[thread.status]}</span>
                  <span className="inbox-time"><Clock3 size={13} />{shortDateTime(thread.updated_at)}</span>
                </div>
                <h2>{task?.title ?? `任务 ${thread.task_id}`}</h2>
                <p className="inbox-message"><MessageSquare size={15} />{thread.latest_message || '打开任务查看留言内容'}</p>
                <span className="inbox-meta">{thread.created_by || 'Leader'} · {thread.message_count ?? 1} 条消息</span>
              </div>
              <Link className="btn btn-ghost btn-sm inbox-open-link" to={`/task/${thread.task_id}?agent=1&thread=${thread.id}`}>
                打开任务 <ArrowRight size={15} />
              </Link>
            </article>
          )
        })}
      </section>
      <p className="inbox-safety-note"><CheckCircle2 size={14} />处理箱只保存留言，不会自动把自然语言直接改成任务字段。</p>
    </div>
  )
}
