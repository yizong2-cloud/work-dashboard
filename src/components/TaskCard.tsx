import type { ReactNode } from 'react'
import type { Task, TaskUpdate } from '../types'
import { StatusBadge } from './StatusBadge'
import { PriorityBadge } from './PriorityBadge'
import { TaskProgress } from './TaskProgress'
import { shortDate } from '../lib/format'

interface TaskCardProps {
  task: Task
  latestUpdate?: TaskUpdate
  onOpen: (task: Task) => void
  onQuickUpdate?: (task: Task) => void
}

export function TaskCard({ task, latestUpdate, onOpen, onQuickUpdate }: TaskCardProps) {
  const overdue =
    !!task.expected_end_date &&
    task.status !== 'completed' &&
    task.status !== 'cancelled' &&
    task.expected_end_date < new Date().toISOString().slice(0, 10)

  return (
    <article className={`card task-card ${task.status === 'blocked' ? 'card-blocked' : ''}`}>
      <div className="task-card-head">
        <h3 className="task-card-title" onClick={() => onOpen(task)}>
          {task.is_interrupt_task && <span className="tag tag-interrupt">临时</span>}
          {task.title}
        </h3>
        <div className="task-card-badges">
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
        </div>
      </div>

      <TaskProgress progress={task.progress} overdue={overdue} />

      <div className="task-card-dates">
        <span>开始 {shortDate(task.start_date)}</span>
        <span className={overdue ? 'txt-warn' : ''}>
          预计结束 {shortDate(task.expected_end_date)}
          {overdue && '（已逾期）'}
        </span>
      </div>

      {(task.current_status || (task.status === 'blocked' && task.block_reason)) && (
        <div className="task-card-status">
          {task.current_status && <p>{task.current_status}</p>}
          {task.status === 'blocked' && task.block_reason && (
            <p className="block-reason">⛔ {task.block_reason}</p>
          )}
        </div>
      )}

      {latestUpdate && (
        <div className="task-card-update">
          <span className="muted">最新：</span>
          {latestUpdate.content}
        </div>
      )}

      <div className="task-card-actions">
        <button className="btn btn-ghost btn-sm" onClick={() => onOpen(task)}>
          详情
        </button>
        {onQuickUpdate && (
          <button className="btn btn-primary btn-sm" onClick={() => onQuickUpdate(task)}>
            更新
          </button>
        )}
      </div>
    </article>
  )
}

export function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{children}</h2>
      {extra}
    </div>
  )
}
