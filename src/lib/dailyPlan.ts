import type { PlanBlock } from '../types'

/** 返回覆盖该日期的未完成日计划；用于 UI 禁用重复操作与数据层幂等保障。 */
export function activePlanForDay(blocks: PlanBlock[], taskId: string, date: string): PlanBlock | undefined {
  return blocks.find((block) => (
    block.task_id === taskId
    && block.start_date <= date
    && block.end_date >= date
    && block.status !== 'done'
  ))
}
