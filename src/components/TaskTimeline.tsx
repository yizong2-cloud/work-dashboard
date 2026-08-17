import type { TaskUpdate, UpdateType } from '../types'
import { shortDateTime, shortDate } from '../lib/format'
import { commentBody, isComment } from '../lib/comments'

const TYPE_META: Record<UpdateType, { label: string; className: string }> = {
  progress: { label: '进展', className: 'tl-progress' },
  status_change: { label: '状态', className: 'tl-status' },
  schedule_change: { label: '排期', className: 'tl-schedule' },
  blocked: { label: '阻塞', className: 'tl-blocked' },
  unblocked: { label: '解除', className: 'tl-unblocked' },
  interrupt: { label: '插入', className: 'tl-interrupt' },
  note: { label: '说明', className: 'tl-note' },
  completed: { label: '完成', className: 'tl-completed' },
  urgent: { label: '加急', className: 'tl-urgent' },
  deurgent: { label: '取消', className: 'tl-deurgent' },
  nudge: { label: '催办', className: 'tl-nudge' },
}

export function TaskTimeline({ updates }: { updates: TaskUpdate[] }) {
  if (updates.length === 0) {
    return <p className="muted">暂无时间线记录。</p>
  }
  const sorted = [...updates].sort((a, b) => b.created_at.localeCompare(a.created_at))
  return (
    <ol className="timeline">
      {sorted.map((u) => {
        const comment = isComment(u)
        const meta = comment
          ? { label: '留言', className: 'tl-comment' }
          : (TYPE_META[u.type] ?? TYPE_META.note)
        const hasSchedule = u.old_expected_end_date || u.new_expected_end_date
        return (
          <li key={u.id} className="timeline-item">
            <div className={`tl-dot ${meta.className}`} title={meta.label} />
            <div className="tl-body">
              <div className="tl-head">
                <span className={`tl-type ${meta.className}`}>{meta.label}</span>
                <time>{shortDateTime(u.created_at)}</time>
              </div>
              <p className="tl-content">{comment ? commentBody(u) : u.content}</p>
              {hasSchedule && (
                <p className="tl-schedule-change">
                  {shortDate(u.old_expected_end_date)} → {shortDate(u.new_expected_end_date)}
                </p>
              )}
              {u.created_by && <span className="tl-author muted">{u.created_by}</span>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
