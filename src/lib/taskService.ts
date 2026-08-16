// ============================================================
// 任务领域服务：把「网页快速更新」与「Agent 更新」的语义统一起来。
//
// 核心规则（与 docs/AGENT_GUIDE.md 完全一致，两边必须同步维护）：
//   1. 任何「变化」都要追加一条 task_updates 记录，绝不只覆盖字段。
//   2. 调整排期必须记录 old/new 两个日期。
//   3. 标记完成 = status=completed + progress=100 + actual_end_date=今天。
//   4. 标记阻塞必须填写阻塞原因；解除阻塞清空原因。
// ============================================================

import type { DB } from './db'
import type { Task, TaskCreateInput, TaskStatus, TaskUpdate, UpdateType } from '../types'
import { todayISO } from './format'

export interface TaskServiceOptions {
  /** 当前操作者标识（邮箱或 'admin'），写入 created_by */
  createdBy: string
}

export interface TaskService {
  listTasks(): Promise<Task[]>
  getTask(id: string): Promise<Task | null>
  listUpdates(taskId: string): Promise<TaskUpdate[]>

  /** 创建任务，并写入一条「任务创建」时间线 */
  createTask(input: TaskCreateInput): Promise<Task>
  deleteTask(id: string): Promise<void>

  /** 修改进度（0-100），自动追加 progress 时间线 */
  setProgress(id: string, progress: number, content?: string): Promise<Task>

  /** 修改状态，自动追加 status_change 时间线 */
  setStatus(id: string, status: TaskStatus, content?: string): Promise<Task>

  /** 调整预计完成日期，自动记录 old/new */
  setSchedule(id: string, expectedEndDate: string, content?: string): Promise<Task>

  /** 标记阻塞（必须给原因），自动追加 blocked 时间线 */
  setBlocked(id: string, reason: string): Promise<Task>

  /** 解除阻塞，自动追加 unblocked 时间线 */
  setUnblocked(id: string, content?: string): Promise<Task>

  /** 标记完成，自动追加 completed 时间线 */
  completeTask(id: string, content?: string): Promise<Task>

  /** 追加一条任意类型的时间线（note / interrupt / progress 说明等） */
  addNote(id: string, type: UpdateType, content: string): Promise<TaskUpdate>
}

export function createTaskService(db: DB, opts: TaskServiceOptions): TaskService {
  const who = () => opts.createdBy

  return {
    async listTasks() {
      return db.listTasks()
    },
    async getTask(id) {
      return db.getTask(id)
    },
    async listUpdates(taskId) {
      return db.listUpdates(taskId)
    },

    async createTask(input) {
      const task = await db.createTask(input)
      await db.addUpdate({ task_id: task.id, type: 'note', content: '任务创建。', created_by: who() })
      return task
    },

    async deleteTask(id) {
      await db.deleteTask(id)
    },

    async setProgress(id, progress, content) {
      const p = Math.max(0, Math.min(100, Math.round(progress)))
      return db.applyTaskUpdate(id, { progress: p }, {
        type: 'progress',
        content: content?.trim() || `进度更新为 ${p}%。`,
        created_by: who(),
      })
    },

    async setStatus(id, status, content) {
      return db.applyTaskUpdate(id, { status }, {
        type: 'status_change',
        content: content?.trim() || `状态变更为 ${status}。`,
        created_by: who(),
      })
    },

    async setSchedule(id, expectedEndDate, content) {
      const before = await db.getTask(id)
      if (!before) throw new Error(`任务不存在: ${id}`)
      return db.applyTaskUpdate(id, { expected_end_date: expectedEndDate }, {
        type: 'schedule_change',
        content: content?.trim() || '调整预计完成日期。',
        old_expected_end_date: before.expected_end_date,
        new_expected_end_date: expectedEndDate,
        created_by: who(),
      })
    },

    async setBlocked(id, reason) {
      if (!reason || !reason.trim()) throw new Error('标记阻塞必须提供阻塞原因')
      const r = reason.trim()
      return db.applyTaskUpdate(id, { status: 'blocked', block_reason: r }, {
        type: 'blocked',
        content: `标记阻塞：${r}`,
        created_by: who(),
      })
    },

    async setUnblocked(id, content) {
      return db.applyTaskUpdate(id, { status: 'in_progress', block_reason: '' }, {
        type: 'unblocked',
        content: content?.trim() || '阻塞解除，恢复进行。',
        created_by: who(),
      })
    },

    async completeTask(id, content) {
      return db.applyTaskUpdate(id, {
        status: 'completed',
        progress: 100,
        actual_end_date: todayISO(),
      }, {
        type: 'completed',
        content: content?.trim() || '任务完成。',
        created_by: who(),
      })
    },

    async addNote(id, type, content) {
      if (!content || !content.trim()) throw new Error('进展内容不能为空')
      return db.addUpdate({
        task_id: id,
        type,
        content: content.trim(),
        created_by: who(),
      })
    },
  }
}
