// ============================================================
// 数据访问接口（DB 契约）
// 看板页面、任务服务、Agent 脚本共用同一套字段与语义。
// 实现：
//   - dbLocal.ts    浏览器 localStorage（演示 / 未配置 Supabase 时）
//   - dbSupabase.ts Supabase PostgreSQL（正式环境）
// ============================================================

import type {
  DecisionAnswerInput,
  DecisionForm,
  DecisionFormDetail,
  DecisionFormPayload,
  DecisionResponse,
  FeedbackMessage,
  FeedbackRole,
  FeedbackStatus,
  FeedbackThread,
  PlanBlock,
  PlanBlockChange,
  Task,
  TaskCreateInput,
  TaskUpdate,
  TaskUpdateInput,
  UpdateCreateInput,
  UpdateType,
} from '../types'

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
   * 原子创建：任务 + 初始时间线 一次完成（supabase 走 RPC 事务 / local 单次写盘）。
   */
  applyCreate(input: TaskCreateInput, note?: string, createdBy?: string): Promise<Task>
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

  // ---- 反馈线程（任务一） ----
  /** 某任务的全部反馈线程（含 message_count / 最新消息摘要） */
  listFeedbackThreads(taskId: string): Promise<FeedbackThread[]>
  /** 全部反馈线程（Dashboard 未解决统计用） */
  listAllFeedbackThreads(): Promise<FeedbackThread[]>
  listFeedbackMessages(threadId: string): Promise<FeedbackMessage[]>
  /** 原子创建线程（线程 + 首条消息） */
  createFeedbackThread(taskId: string, body: string, authorName: string, authorRole: FeedbackRole): Promise<FeedbackThread>
  /** 原子回复（线程已解决时自动重新打开） */
  addFeedbackMessage(threadId: string, body: string, authorName: string, authorRole: FeedbackRole): Promise<FeedbackMessage>
  /** 状态迁移（resolved 记录解决者与时间） */
  setFeedbackStatus(threadId: string, status: FeedbackStatus, byName: string): Promise<FeedbackThread>

  // ---- 日粒度计划（任务三） ----
  /** 指定日期范围（含边界）的计划块，或某任务的计划块 */
  listPlanBlocks(opts?: { taskId?: string; from?: string; to?: string }): Promise<PlanBlock[]>
  /** 计划块的调整历史 */
  listPlanBlockChanges(blockId: string): Promise<PlanBlockChange[]>
  /** 原子创建计划块 */
  createPlanBlock(input: {
    task_id: string
    start_date: string
    end_date: string
    summary?: string
    status?: string
    created_by?: string
  }): Promise<PlanBlock>
  /**
   * 幂等地把任务安排到指定日：同任务同日已有未完成计划时直接返回；
   * 否则原子创建计划块并写入静默 task_updates 审计记录。
   */
  ensurePlanForDay(input: { task_id: string; date: string; created_by?: string }): Promise<PlanBlock>
  /** 原子调整（更新 + 写变更历史） */
  movePlanBlock(blockId: string, patch: { start_date?: string; end_date?: string }, note: string, by: string): Promise<PlanBlock>
  /** 原子标记完成（写历史） */
  donePlanBlock(blockId: string, note: string, by: string): Promise<PlanBlock>

  // ---- 决策中心（Decision Hub） ----
  /** 决策表单列表（包含题目与答卷计数） */
  listDecisionForms(): Promise<DecisionForm[]>
  /** 决策表单详情（含题目、选项、答卷、答案） */
  getDecisionFormBySlug(slug: string): Promise<DecisionFormDetail | null>
  /** 原子创建决策表单 */
  createDecisionForm(payload: DecisionFormPayload): Promise<{ id: string; slug: string }>
  /** 原子提交答卷 */
  submitDecisionResponse(
    slug: string,
    respondentName: string,
    answers: DecisionAnswerInput[],
    respondentNote?: string,
  ): Promise<DecisionResponse>
  /** 关闭决策表单 */
  closeDecisionForm(slug: string): Promise<void>
  /** 重新开放决策表单 */
  openDecisionForm(slug: string): Promise<void>
}

export function newId(prefix = 't'): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
