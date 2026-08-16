import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskUpdate } from '../types'
import type { TaskService } from '../lib/taskService'
import { commentBody } from '../lib/comments'
import { shortDateTime } from '../lib/format'

const AUTHOR_KEY = 'work-dashboard:comment-author'
const COMMENT_MASCOT = `${import.meta.env.BASE_URL}mascots/mascot-comment.png`

interface LeaderCommentPanelProps {
  taskId: string
  comments: TaskUpdate[]
  service: TaskService
  autoFocus?: boolean
  onDone: (message: string) => void
}

export function LeaderCommentPanel({
  taskId,
  comments,
  service,
  autoFocus = false,
  onDone,
}: LeaderCommentPanelProps) {
  const [author, setAuthor] = useState(() => localStorage.getItem(AUTHOR_KEY) || 'Leader')
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sorted = useMemo(
    () => [...comments].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [comments],
  )

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, [autoFocus])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const cleanAuthor = author.trim()
    const cleanContent = content.trim()
    if (!cleanAuthor) return setError('请填写称呼')
    if (!cleanContent) return setError('请输入留言内容')
    if (cleanContent.length > 1000) return setError('留言最多 1000 个字')

    setSubmitting(true)
    setError('')
    try {
      localStorage.setItem(AUTHOR_KEY, cleanAuthor)
      await service.addComment(taskId, cleanAuthor, cleanContent)
      setContent('')
      onDone('留言已记录')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="comment-panel card" id="comments">
      <div className="comment-panel-head">
        <div>
          <span className="eyebrow">Leader feedback</span>
          <h2>留言与反馈</h2>
        </div>
        <span className="comment-count">{comments.length}</span>
      </div>

      <form className="comment-form" onSubmit={(event) => void submit(event)}>
        <label className="comment-author-field">
          <span>署名</span>
          <input
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
            maxLength={40}
            aria-label="留言署名"
          />
        </label>
        <label className="comment-content-field">
          <span className="sr-only">留言内容</span>
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={4}
            maxLength={1000}
            placeholder="写下建议、决策或需要跟进的问题…"
            aria-label="留言内容"
          />
        </label>
        <div className="comment-form-foot">
          <span className="comment-hint">当前免登录，署名仅用于展示</span>
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? '提交中…' : '提交留言'}
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>

      <div className="comment-list">
        {sorted.length === 0 ? (
          <div className="comment-empty">
            <div className="comment-empty-art" aria-hidden="true">
              <img src={COMMENT_MASCOT} alt="" loading="lazy" decoding="async" />
              <span>这里适合记录决策、反馈和需要跟进的问题。</span>
            </div>
          </div>
        ) : (
          sorted.map((comment) => (
            <article className="comment-item" key={comment.id}>
              <div className="comment-avatar" aria-hidden="true">
                {(comment.created_by || 'L').slice(0, 1).toUpperCase()}
              </div>
              <div className="comment-item-body">
                <div className="comment-meta">
                  <strong>{comment.created_by || 'Leader'}</strong>
                  <time>{shortDateTime(comment.created_at)}</time>
                </div>
                <p>{commentBody(comment)}</p>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  )
}
