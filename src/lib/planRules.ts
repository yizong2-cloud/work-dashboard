// ============================================================
// 日粒度计划领域校验（任务三，纯函数）
// 与数据库 RPC（create/move_plan_block）校验一致：日期真实、end >= start。
// CLI 侧由 agent.js 的 assertDate 提供等价校验；数据库 RPC 兜底。
// ============================================================

import type { PlanBlockStatus } from '../types'

export const PLAN_STATUSES: PlanBlockStatus[] = ['planned', 'active', 'done', 'changed']

function isRealDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

/** 校验计划块日期（格式 + 真实性 + end >= start）；合法返回 null */
export function validatePlanDates(start: string, end: string): string | null {
  const re = /^\d{4}-\d{2}-\d{2}$/
  if (!re.test(start ?? '')) return '开始日期格式应为 YYYY-MM-DD'
  if (!re.test(end ?? '')) return '结束日期格式应为 YYYY-MM-DD'
  if (!isRealDate(start)) return `开始日期不是真实日期: ${start}`
  if (!isRealDate(end)) return `结束日期不是真实日期: ${end}`
  if (end < start) return '结束日期不得早于开始日期'
  return null
}

export function validatePlanStatus(status: string): PlanBlockStatus | null {
  return PLAN_STATUSES.includes(status as PlanBlockStatus) ? (status as PlanBlockStatus) : null
}
