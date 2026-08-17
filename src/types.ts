// ============================================================
// 数据模型 —— 与 supabase/schema.sql 保持一致
// 这是「看板」与「Agent 更新接口」之间的唯一契约。
// ============================================================

export type TaskStatus =
  | 'planned'      // 待开始
  | 'in_progress'  // 进行中
  | 'blocked'      // 阻塞
  | 'paused'       // 暂停
  | 'completed'    // 已完成
  | 'cancelled'    // 已取消

export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low'

export type UpdateType =
  | 'progress'        // 进度更新
  | 'status_change'   // 状态变更
  | 'schedule_change' // 排期调整
  | 'blocked'         // 标记阻塞
  | 'unblocked'       // 解除阻塞
  | 'interrupt'       // 临时插入
  | 'note'            // 普通说明
  | 'completed'       // 标记完成
  | 'urgent'          // 加急 / 取消加急（priority 变化）
  | 'nudge'           // Leader 催进度

export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  /** 0-100 整数 */
  progress: number
  /** 实际或计划开始日期 YYYY-MM-DD */
  start_date: string | null
  /** 预计结束日期 YYYY-MM-DD */
  expected_end_date: string | null
  /** 实际完成日期 YYYY-MM-DD */
  actual_end_date: string | null
  /** 一句话描述当前最新状态，如「UI 已完成，正在接入后端接口」 */
  current_status: string
  /** 阻塞原因（status=blocked 时填写） */
  block_reason: string
  /** 是否为临时插入任务 */
  is_interrupt_task: boolean
  created_at: string
  updated_at: string
}

export interface TaskUpdate {
  id: string
  task_id: string
  type: UpdateType
  content: string
  old_expected_end_date: string | null
  new_expected_end_date: string | null
  created_at: string
  created_by: string
}

/** 新建任务入参（Agent 与网页共用同一套字段名） */
export interface TaskCreateInput {
  title: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  progress?: number
  start_date?: string | null
  expected_end_date?: string | null
  is_interrupt_task?: boolean
  current_status?: string
  block_reason?: string
}

/** 更新任务入参：字段可选，只传需要改的 */
export type TaskUpdateInput = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'status'
    | 'priority'
    | 'progress'
    | 'start_date'
    | 'expected_end_date'
    | 'actual_end_date'
    | 'current_status'
    | 'block_reason'
    | 'is_interrupt_task'
  >
>

/** 添加一条任务进展（Timeline） */
export interface UpdateCreateInput {
  task_id: string
  type: UpdateType
  content: string
  old_expected_end_date?: string | null
  new_expected_end_date?: string | null
  created_by?: string
}

// ============================================================
// 反馈线程（任务一：Leader 留言升级为可回复/可跟进的线程）
// 免登录：author_name/author_role 仅用于展示，不做身份校验
// ============================================================

export type FeedbackRole = 'leader' | 'owner'

export type FeedbackStatus = 'open' | 'in_progress' | 'resolved'

export interface FeedbackThread {
  id: string
  task_id: string
  status: FeedbackStatus
  created_at: string
  created_by: string
  resolved_at: string | null
  resolved_by: string
  updated_at: string
  /** 消息数（列表查询时填充） */
  message_count?: number
  /** 最新一条消息摘要（列表查询时填充，供 Dashboard 展示） */
  latest_message?: string
  latest_message_at?: string
  latest_author?: string
}

export interface FeedbackMessage {
  id: string
  thread_id: string
  body: string
  author_name: string
  author_role: FeedbackRole
  created_at: string
}

// ============================================================
// 日粒度工作计划（任务三）
// ============================================================

export type PlanBlockStatus = 'planned' | 'active' | 'done' | 'changed'

export interface PlanBlock {
  id: string
  task_id: string
  start_date: string
  end_date: string
  summary: string
  status: PlanBlockStatus
  created_at: string
  updated_at: string
  created_by: string
}

export interface PlanBlockChange {
  id: string
  block_id: string
  old_start_date: string | null
  old_end_date: string | null
  old_status: string | null
  new_start_date: string | null
  new_end_date: string | null
  new_status: string | null
  note: string
  changed_at: string
  changed_by: string
}
