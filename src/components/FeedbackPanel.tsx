import { useEffect, useMemo, useState } from 'react'
import type { FeedbackKind, FeedbackMessage, FeedbackRole, FeedbackStatus, FeedbackThread } from '../types'
import type { FeedbackService, LegacyComment } from '../lib/feedbackService'
import { feedbackDisplayName } from '../lib/feedbackRules'
import { shortDateTime } from '../lib/format'

const ROLE_KEY = 'work-dashboard:feedback-role'
const COMMENT_MASCOT = `${import.meta.env.BASE_URL}mascots/mascot-comment.png`

export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  open: '待回应',
  in_progress: '处理中',
  resolved: '已解决',
}

interface FeedbackPanelProps {
  taskId: string
  service: FeedbackService
  threads: FeedbackThread[]
  legacyComments: LegacyComment[]
  autoFocus?: boolean
  /** 深链接定位：初始展开的线程 id */
  initialThreadId?: string | null
  /** 变更后由父级刷新数据 */
  onChanged: () => void
  onNotify: (message: string) => void
  /** Leader 协作反馈与给 Agent 的处理指令是两个独立入口，不能互相改名替代。 */
  kind: FeedbackKind
}

export function FeedbackPanel({
  taskId,
  service,
  threads,
  legacyComments,
  autoFocus = false,
  initialThreadId = null,
  onChanged,
  onNotify,
  kind,
}: FeedbackPanelProps) {
  const agentMode = kind === 'agent_instruction'
  const [role, setRole] = useState<FeedbackRole>(() =>
    localStorage.getItem(ROLE_KEY) === 'owner' ? 'owner' : 'leader',
  )
  const [newBody, setNewBody] = useState('')
  const [expanded, setExpanded] = useState<string | null>(initialThreadId)
  const [messages, setMessages] = useState<Record<string, FeedbackMessage[]>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 深链接定位（?thread=xxx）：初始展开并自动加载消息
  useEffect(() => {
    if (initialThreadId) {
      void loadMessages(initialThreadId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialThreadId])

  const scopedThreads = useMemo(
    () => threads.filter((thread) => (thread.kind ?? 'leader_feedback') === kind),
    [kind, threads],
  )
  const openCount = scopedThreads.filter((t) => t.status !== 'resolved').length
  const pendingLabel = agentMode ? '待处理' : '待回应'

  const sorted = useMemo(
    () => [...scopedThreads].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [scopedThreads],
  )

  function switchRole(next: FeedbackRole) {
    setRole(next)
    localStorage.setItem(ROLE_KEY, next)
  }

  async function loadMessages(threadId: string, force = false) {
    if (!force && messages[threadId]) return
    try {
      const ms = await service.listMessages(threadId)
      setMessages((m) => ({ ...m, [threadId]: ms }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function toggleThread(threadId: string) {
    const next = expanded === threadId ? null : threadId
    setExpanded(next)
    if (next) void loadMessages(next)
  }

  async function submitNew() {
    const body = newBody.trim()
    if (!body) return setError('请填写反馈内容')
    setBusy(true)
    setError('')
    try {
      await service.createThread(taskId, body, agentMode ? 'owner' : role, kind)
      setNewBody('')
      onNotify(agentMode ? '已保存到处理箱，Agent 可按任务定位' : '反馈已发起')
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function submitReply(threadId: string) {
    const body = (drafts[threadId] ?? '').trim()
    if (!body) return setError('请填写回复内容')
    setBusy(true)
    setError('')
    try {
      await service.reply(threadId, body, role)
      setDrafts((d) => ({ ...d, [threadId]: '' }))
      await loadMessages(threadId, true)
      onNotify('回复已发送')
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function resolve(threadId: string, status: FeedbackStatus) {
    setBusy(true)
    setError('')
    try {
      await service.setStatus(threadId, status)
      onNotify(status === 'resolved' ? '反馈已标记解决' : '反馈已重新打开')
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="comment-panel card" id={agentMode ? 'agent-inbox' : 'comments'}>
      <div className="comment-panel-head">
        <div>
          <span className="eyebrow">{agentMode ? 'Agent inbox' : 'Leader feedback'}</span>
          <h2>{agentMode ? '给 Agent 的处理留言' : '反馈线程'}</h2>
        </div>
        <span className={`comment-count ${openCount > 0 ? 'comment-count-open' : ''}`}>
          {openCount > 0 ? `${openCount} ${pendingLabel}` : '全部已解决'}
        </span>
      </div>

      {/* 发起反馈 */}
      <form
        className="comment-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submitNew()
        }}
      >
        {!agentMode && <div className="feedback-role-row">
          <span className="feedback-role-label">我是</span>
          <button type="button" className={`btn btn-sm ${role === 'leader' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => switchRole('leader')}>
            Leader
          </button>
          <button type="button" className={`btn btn-sm ${role === 'owner' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => switchRole('owner')}>
            负责人（本人）
          </button>
        </div>}
        <label className="comment-content-field">
          <span className="sr-only">反馈内容</span>
          <textarea
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={agentMode ? '例如：预计完成时间记错了，改到 8 月 25 日；或：这个任务已经完成了。' : '写下建议、决策或需要跟进的问题…'}
            aria-label="反馈内容"
            autoFocus={autoFocus}
          />
        </label>
        <div className="comment-form-foot">
          <span className="comment-hint">{agentMode ? '保存后会绑定当前任务；Agent 读取后再决定如何修改。' : '当前免登录，身份仅用于展示'}</span>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? '保存中…' : agentMode ? '保存到处理箱' : '发起反馈'}
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>

      {/* 历史留言（兼容只读） */}
      {!agentMode && legacyComments.length > 0 && (
        <details className="feedback-legacy">
          <summary>历史留言（{legacyComments.length} 条，来自旧版本，只读）</summary>
          <div className="comment-list">
            {legacyComments.map((c) => (
              <article className="comment-item comment-item-legacy" key={c.id}>
                <div className="comment-avatar" aria-hidden="true">{(c.author || 'L').slice(0, 1).toUpperCase()}</div>
                <div className="comment-item-body">
                  <div className="comment-meta">
                    <strong>{c.author}</strong>
                    <time>{shortDateTime(c.createdAt)}</time>
                  </div>
                  <p>{c.body}</p>
                </div>
              </article>
            ))}
          </div>
        </details>
      )}

      {/* 反馈线程列表 */}
      <div className="comment-list">
        {sorted.length === 0 && (agentMode || legacyComments.length === 0) ? (
          <div className="comment-empty">
            <div className="comment-empty-art" aria-hidden="true">
              <img src={COMMENT_MASCOT} alt="" loading="lazy" decoding="async" />
              <span>{agentMode ? '还没有待处理留言。写下任务问题后，Agent 会从处理箱读取。' : '还没有反馈。Leader 的留言会以线程形式出现在这里，可回复、可标记解决。'}</span>
            </div>
          </div>
        ) : null}
        {sorted.map((thread) => {
          const open = expanded === thread.id
          const msgs = messages[thread.id] ?? []
          return (
            <article className="thread-item" key={thread.id}>
              <button className="thread-head" onClick={() => toggleThread(thread.id)}>
                <span className={`thread-status st-${thread.status}`}>
                  {agentMode && thread.status === 'open' ? '待处理' : FEEDBACK_STATUS_LABEL[thread.status]}
                </span>
                <span className="thread-summary">
                  {thread.latest_message || `来自 ${thread.created_by || 'Leader'} 的反馈`}
                </span>
                <span className="thread-meta muted">
                  {thread.created_by || 'Leader'} · {shortDateTime(thread.latest_message_at ?? thread.created_at)}
                </span>
              </button>

              {open && (
                <div className="thread-body">
                  {msgs.map((m) => (
                    <div key={m.id} className={`thread-msg msg-${m.author_role}`}>
                      <div className="comment-meta">
                        <strong>{feedbackDisplayName(m.author_role, m.author_name)}</strong>
                        <span className={`thread-role-tag ${m.author_role === 'leader' ? 'role-leader' : 'role-owner'}`}>
                          {m.author_role === 'leader' ? 'Leader' : '负责人'}
                        </span>
                        <time>{shortDateTime(m.created_at)}</time>
                      </div>
                      <p>{m.body}</p>
                    </div>
                  ))}

                  {thread.status === 'resolved' && (
                    <p className="thread-resolved-note muted">
                      ✅ 已由 {thread.resolved_by || '负责人'} 解决（{shortDateTime(thread.resolved_at)}）
                    </p>
                  )}

                  <div className="thread-reply">
                    <textarea
                      value={drafts[thread.id] ?? ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, [thread.id]: e.target.value }))}
                      rows={2}
                      maxLength={2000}
                      placeholder={thread.status === 'resolved' ? '回复将重新打开该反馈…' : '回复这条反馈…'}
                      aria-label="回复内容"
                    />
                    <div className="thread-reply-foot">
                      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submitReply(thread.id)}>
                        回复
                      </button>
                      {thread.status === 'resolved' ? (
                        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resolve(thread.id, 'open')}>
                          重新打开
                        </button>
                      ) : (
                        <>
                          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resolve(thread.id, 'in_progress')}>
                            处理中
                          </button>
                          <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void resolve(thread.id, 'resolved')}>
                            标记解决
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
