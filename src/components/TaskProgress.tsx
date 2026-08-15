interface TaskProgressProps {
  progress: number
  /** 是否逾期（预计结束日期已过且未完成） */
  overdue?: boolean
  size?: 'sm' | 'md'
}

export function TaskProgress({ progress, overdue = false, size = 'md' }: TaskProgressProps) {
  const p = Math.max(0, Math.min(100, progress))
  const tone = p >= 100 ? 'ok' : overdue ? 'warn' : 'normal'
  return (
    <div className={`progress ${size === 'sm' ? 'progress-sm' : ''}`}>
      <div className="progress-track">
        <div className={`progress-fill fill-${tone}`} style={{ width: `${p}%` }} />
      </div>
      <span className={`progress-num ${overdue ? 'txt-warn' : ''}`}>{p}%</span>
    </div>
  )
}
