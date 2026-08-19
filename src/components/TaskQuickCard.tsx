import type { PlanBlock, Task } from '../types'
import { taskColorClass } from '../lib/taskColor'
import { shortDate, todayISO } from '../lib/format'
import { activePlanForDay } from '../lib/dailyPlan'

// 就地操作卡：单击任务弹此卡（进度/截止日/今日计划 + 安排到今天/更新进度/查看详情），不跳页。
// 「安排到今天」统一走上层传入的 onPlanToday（= taskService.planToday，含审计时间线 + 刷新 + 错误处理）。
export function TaskQuickCard({
  task,
  blocks,
  onPlanToday,
  onQuickProgress,
  onOpenTask,
  onClose,
}: {
  task: Task
  blocks: PlanBlock[]
  onPlanToday: (taskId: string) => void
  onQuickProgress: (taskId: string) => void
  onOpenTask: (taskId: string) => void
  onClose: () => void
}) {
  const today = todayISO()
  const todayBlock = activePlanForDay(blocks, task.id, today)

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className={`task-color-dot task-color-${taskColorClass(task.id)}`} aria-hidden="true" />
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
          {task.status === 'blocked' && task.block_reason ? <p className="week-block-reason">⛔ 阻塞：{task.block_reason}</p> : null}
          {task.priority === 'urgent' ? <p className="week-block-reason">🔥 加急</p> : null}
        </div>
        <div className="modal-foot week-quick-actions">
          <button className="btn btn-ghost" disabled={Boolean(todayBlock)} onClick={() => onPlanToday(task.id)}>
            {todayBlock ? '已安排到今天' : '＋ 安排到今天'}
          </button>
          <button className="btn btn-ghost" onClick={() => onQuickProgress(task.id)}>更新进度</button>
          <button className="btn btn-primary" onClick={() => onOpenTask(task.id)}>查看详情</button>
        </div>
      </div>
    </div>
  )
}
