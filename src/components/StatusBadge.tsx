import type { TaskStatus } from '../types'

const STATUS_META: Record<TaskStatus, { label: string; className: string }> = {
  planned: { label: '待开始', className: 'st-planned' },
  in_progress: { label: '进行中', className: 'st-inprogress' },
  blocked: { label: '阻塞', className: 'st-blocked' },
  paused: { label: '暂停', className: 'st-paused' },
  completed: { label: '已完成', className: 'st-completed' },
  cancelled: { label: '已取消', className: 'st-cancelled' },
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.planned
  return <span className={`badge ${meta.className}`}>{meta.label}</span>
}
