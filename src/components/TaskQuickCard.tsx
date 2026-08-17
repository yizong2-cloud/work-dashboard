import type { PlanBlock, Task } from '../types'
import type { DB } from '../lib/db'
import { shortDate, todayISO } from '../lib/format'

// 就地操作卡：单击任务弹此卡（进度/截止日/今日计划 + 安排到今天/更新进度/查看详情），不跳页。
export function TaskQuickCard({
  task,
  blocks,
  db,
  onQuickProgress,
  onOpenTask,
  onClose,
  onChanged,
}: {
  task: Task
  blocks: PlanBlock[]
  db: DB
  onQuickProgress: (taskId: string) => void
  onOpenTask: (taskId: string) => void
  onClose: () => void
  onChanged?: () => void
}) {
  const today = todayISO()
  const todayBlock = blocks.find((b) => b.task_id === task.id && b.start_date <= today && b.end_date >= today && b.status !== 'done')

  async function planToday() {
    if (todayBlock) return
    try {
      await db.createPlanBlock({ task_id: task.id, start_date: today, end_date: today, summary: '', created_by: '本人' })
      onChanged?.()
    } catch {
      /* 失败不阻塞 */
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{task.title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>关闭</button>
        </div>
        <div className="modal-body">
          {task.current_status && <p className="muted">{task.current_status}</p>}
          <div className="week-quick-facts">
            <div><span>进度</span><strong>{task.progress}%</strong></div>
            <div><span>状态</span><strong>{task.status}</strong></div>
            <div><span>预计完成</span><strong>{shortDate(task.expected_end_date) || '未排期'}</strong></div>
            <div><span>今日计划</span><strong>{todayBlock ? '已安排' : '未安排'}</strong></div>
          </div>
          {task.block_reason ? <p className="week-block-reason">阻塞：{task.block_reason}</p> : null}
        </div>
        <div className="modal-foot week-quick-actions">
          <button className="btn btn-ghost" onClick={() => void planToday()}>
            {todayBlock ? '已安排到今天' : '＋ 安排到今天'}
          </button>
          <button className="btn btn-ghost" onClick={() => onQuickProgress(task.id)}>更新进度</button>
          <button className="btn btn-primary" onClick={() => onOpenTask(task.id)}>查看详情</button>
        </div>
      </div>
    </div>
  )
}
