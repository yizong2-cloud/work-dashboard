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
  | 'urgent'          // 加急（priority 变化）
  | 'deurgent'        // 取消加急（priority 变化）
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
  /** 通知投递意图；旧数据兼容为空。 */
  notify_mode?: 'immediate' | 'merge' | 'silent'
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
  /** 推送意图：immediate 即时 / merge 合并 / silent 静默（Agent 与统一领域操作用） */
  notify_mode?: 'immediate' | 'merge' | 'silent'
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

// ============================================================
// 决策中心（Decision Hub）
// 数据、页面与任务看板解耦，面向 Agent 与决策人流转
// ============================================================

export type DecisionFormStatus = 'draft' | 'open' | 'closed'

export type DecisionQuestionType = 'single_choice' | 'multiple_choice' | 'free_text' | 'confirmation'
export type DecisionQuestionResolution = 'pending' | 'clarified' | 'decided' | 'changed'
export type DecisionClarificationKind = 'clarification' | 'decision' | 'change'

export interface DecisionForm {
  id: string
  slug: string
  title: string
  summary: string
  source_document: string | null
  status: DecisionFormStatus
  created_by: string
  created_at: string
  closed_at: string | null
  updated_at: string
  /** 答卷计数（查询列表时附加） */
  response_count?: number
  /** 题目计数（查询列表时附加） */
  question_count?: number
}

export interface DecisionOption {
  id: string
  question_id: string
  code: string
  label: string
  detail: string
  sort_order: number
}

export interface DecisionQuestion {
  id: string
  form_id: string
  code: string
  sort_order: number
  title: string
  context: string
  /** 表单中的分组标题，例如“星芒方案” */
  group_name?: string
  /** 与当前题直接相关的原文摘录，不要求填写者先读完整文档 */
  source_excerpt?: string
  /** Agent 如何把原文转换为本题与候选项 */
  conversion_note?: string
  resolution_status?: DecisionQuestionResolution
  type: DecisionQuestionType
  required: boolean
  allow_other: boolean
  recommended_option_id: string | null
  /** 推荐理由说明（PRD 推荐项标识及推荐理由） */
  recommended_reason?: string
  /** 前端/导出展示用，或由 recommended_option_id 关联查出 */
  recommended_option_code?: string | null
  options: DecisionOption[]
}

/** 从飞书等讨论渠道同步回来的、会影响理解或结论的正式记录 */
export interface DecisionClarification {
  id: string
  form_id: string
  question_id: string
  kind: DecisionClarificationKind
  content: string
  source_channel: string
  source_url: string
  created_by: string
  created_at: string
}

export interface DecisionAnswer {
  id: string
  response_id: string
  question_id: string
  selected_option_ids: string[]
  text_answer: string
  other_text: string
}

export interface DecisionResponse {
  id: string
  form_id: string
  respondent_name: string
  respondent_note: string
  submitted_at: string
  answers?: DecisionAnswer[]
}

/** 包含完整题目、选项及答卷的表单聚合数据 */
export interface DecisionFormDetail extends DecisionForm {
  questions: DecisionQuestion[]
  responses: DecisionResponse[]
  clarifications: DecisionClarification[]
}

/** Agent 导入 Payload 契约结构 */
export interface DecisionOptionPayload {
  code: string
  label: string
  detail?: string
}

export interface DecisionQuestionPayload {
  code: string
  title: string
  context?: string
  group_name?: string
  source_excerpt?: string
  conversion_note?: string
  type: DecisionQuestionType
  required?: boolean
  allow_other?: boolean
  recommended_option_code?: string | null
  recommended_reason?: string
  options?: DecisionOptionPayload[]
}

export interface DecisionFormPayload {
  slug: string
  title: string
  summary?: string
  source_document?: string | null
  status?: DecisionFormStatus
  created_by?: string
  questions: DecisionQuestionPayload[]
}

/** 用户填答提交入参 */
export interface DecisionAnswerInput {
  question_id: string
  selected_option_ids?: string[]
  text_answer?: string
  other_text?: string
}

export interface DecisionSubmissionInput {
  respondent_name: string
  respondent_note?: string
  answers: DecisionAnswerInput[]
}
