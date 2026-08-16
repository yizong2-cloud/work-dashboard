// ============================================================
// 数据访问接口（DB 契约）
// 看板页面、任务服务、Agent 脚本共用同一套字段与语义。
// 实现：
//   - dbLocal.ts    浏览器 localStorage（演示 / 未配置 Supabase 时）
//   - dbSupabase.ts Supabase PostgreSQL（正式环境）
// ============================================================

import type { Task, TaskCreateInput, TaskUpdate, TaskUpdateInput, UpdateCreateInput, UpdateType } from '../types'

export interface DB {
  readonly mode: 'local' | 'supabase'

  listTasks(): Promise<Task[]>
  getTask(id: string): Promise<Task | null>
  listUpdates(taskId: string): Promise<TaskUpdate[]>
  /** 全部更新（按时间倒序），用于首页「最近更新」feed */
  listAllUpdates(): Promise<TaskUpdate[]>
  createTask(input: TaskCreateInput): Promise<Task>
  updateTask(id: string, patch: TaskUpdateInput): Promise<Task>
  addUpdate(input: UpdateCreateInput): Promise<TaskUpdate>
  deleteTask(id: string): Promise<void>
  /**
   * 原子更新：任务字段修改 + 时间线追加 一次完成（supabase 走 RPC 事务 / local 单次写盘）。
   * 状态类更新（进度/状态/排期/阻塞/完成）必须走这里，保证不出现"改了字段没记时间线"。
   */
  applyTaskUpdate(
    taskId: string,
    patch: TaskUpdateInput,
    update: {
      type: UpdateType
      content: string
      old_expected_end_date?: string | null
      new_expected_end_date?: string | null
      created_by?: string
    },
  ): Promise<Task>
}

export function newId(prefix = 't'): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
