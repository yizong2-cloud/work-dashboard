import type { TaskPriority } from '../types'

const PRIORITY_META: Record<TaskPriority, { label: string; className: string }> = {
  urgent: { label: '加急', className: 'pr-urgent' },
  high: { label: '高', className: 'pr-high' },
  normal: { label: '普通', className: 'pr-normal' },
  low: { label: '低', className: 'pr-low' },
}

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const meta = PRIORITY_META[priority] ?? PRIORITY_META.normal
  return <span className={`badge pr-badge ${meta.className}`}>{meta.label}</span>
}
