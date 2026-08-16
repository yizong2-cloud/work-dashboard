// ============================================================
// 反馈线程领域服务（任务一）
// - 新反馈使用结构化线程（task_feedback_threads / messages）
// - 旧历史留言（task_updates 里 💬 前缀的 note）兼容读取为只读「历史留言」，
//   数据不动，不静默丢失；UI 上明确区分「任务进展 / Leader 反馈 / 历史留言」
// ============================================================

import type { DB } from './db'
import type { FeedbackMessage, FeedbackRole, FeedbackStatus, FeedbackThread } from '../types'
import type { TaskUpdate } from '../types'
import { commentBody, isComment } from './comments'
import { feedbackDisplayName, isValidFeedbackStatus, validateFeedbackBody, validateFeedbackRole } from './feedbackRules'

/** 历史留言（来自 task_updates 的 💬 note，兼容只读） */
export interface LegacyComment {
  id: string
  author: string
  body: string
  createdAt: string
}

export interface FeedbackServiceOptions {
  /** 当前操作者展示名（免登录，仅展示用） */
  displayName: string
}

export interface FeedbackService {
  /** 任务的全部反馈线程 + 历史留言 */
  listThreads(taskId: string): Promise<{ threads: FeedbackThread[]; legacyComments: LegacyComment[] }>
  /** 全部线程（Dashboard 统计/最近反馈） */
  listAllThreads(): Promise<FeedbackThread[]>
  listMessages(threadId: string): Promise<FeedbackMessage[]>
  /** 发起反馈（leader 视角）；role 默认 leader */
  createThread(taskId: string, body: string, role?: FeedbackRole): Promise<FeedbackThread>
  /** 回复线程；role 默认 owner（负责人）；已解决线程回复后自动重新打开 */
  reply(threadId: string, body: string, role?: FeedbackRole): Promise<FeedbackMessage>
  /** 状态迁移（resolved 记录解决者）；任务负责人标记解决 */
  setStatus(threadId: string, status: FeedbackStatus): Promise<FeedbackThread>
}

export function createFeedbackService(db: DB, opts: FeedbackServiceOptions): FeedbackService {
  const who = () => opts.displayName || ''

  function roleOr(role?: FeedbackRole, fallback: FeedbackRole = 'leader'): FeedbackRole {
    const r = validateFeedbackRole(role ?? fallback)
    if (!r) throw new Error('非法身份角色')
    return r
  }

  return {
    async listThreads(taskId) {
      const [threads, allUpdates] = await Promise.all([
        db.listFeedbackThreads(taskId),
        db.listUpdates(taskId),
      ])
      const legacyComments: LegacyComment[] = allUpdates
        .filter(isComment)
        .map((u: TaskUpdate) => ({
          id: u.id,
          author: u.created_by || 'Leader',
          body: commentBody(u),
          createdAt: u.created_at,
        }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      return { threads, legacyComments }
    },

    async listAllThreads() {
      return db.listAllFeedbackThreads()
    },

    async listMessages(threadId) {
      return db.listFeedbackMessages(threadId)
    },

    async createThread(taskId, body, role) {
      const err = validateFeedbackBody(body)
      if (err) throw new Error(err)
      const r = roleOr(role, 'leader')
      return db.createFeedbackThread(taskId, body.trim(), feedbackDisplayName(r, who()), r)
    },

    async reply(threadId, body, role) {
      const err = validateFeedbackBody(body)
      if (err) throw new Error(err)
      const r = roleOr(role, 'owner')
      return db.addFeedbackMessage(threadId, body.trim(), feedbackDisplayName(r, who()), r)
    },

    async setStatus(threadId, status) {
      if (!isValidFeedbackStatus(status)) throw new Error(`非法反馈状态: ${status}`)
      return db.setFeedbackStatus(threadId, status, who())
    },
  }
}
