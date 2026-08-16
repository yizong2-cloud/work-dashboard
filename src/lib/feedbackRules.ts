// ============================================================
// 反馈线程领域校验（纯函数，与数据库 RPC 校验保持一致）
// 供前端 service 与测试共用；数据库层（schema.sql RPC）也会强制同样的规则。
// ============================================================

import type { FeedbackRole, FeedbackStatus } from '../types'

export const FEEDBACK_ROLES: FeedbackRole[] = ['leader', 'owner']
export const FEEDBACK_STATUSES: FeedbackStatus[] = ['open', 'in_progress', 'resolved']
export const FEEDBACK_BODY_MAX = 2000

/** 校验反馈/回复正文；返回错误信息，合法返回 null */
export function validateFeedbackBody(body: string): string | null {
  const b = (body ?? '').trim()
  if (!b) return '内容不能为空'
  if (b.length > FEEDBACK_BODY_MAX) return `内容最多 ${FEEDBACK_BODY_MAX} 个字`
  return null
}

/** 校验角色；非法返回 null */
export function validateFeedbackRole(role: string): FeedbackRole | null {
  return FEEDBACK_ROLES.includes(role as FeedbackRole) ? (role as FeedbackRole) : null
}

/** 校验线程状态迁移：目标必须合法；resolved 是终态（新回复会自动重新打开） */
export function isValidFeedbackStatus(status: string): status is FeedbackStatus {
  return FEEDBACK_STATUSES.includes(status as FeedbackStatus)
}

/** 展示名：有署名用署名，否则按角色给默认名 */
export function feedbackDisplayName(role: FeedbackRole, name: string): string {
  const n = (name ?? '').trim()
  if (n) return n
  return role === 'leader' ? 'Leader' : '本人'
}
