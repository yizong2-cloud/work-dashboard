// ============================================================
// 本地模式数据层（浏览器 localStorage）
// 用途：Supabase 未配置时演示看板；不依赖网络。
// ============================================================

import type { DB } from './db'
import { newId } from './db'
import type {
  DecisionAnswer,
  DecisionClarification,
  DecisionForm,
  DecisionFormDetail,
  DecisionFormPayload,
  DecisionOption,
  DecisionQuestion,
  DecisionResponse,
  FeedbackMessage,
  FeedbackThread,
  PlanBlock,
  PlanBlockChange,
  Task,
  TaskUpdate,
} from '../types'
import { buildSeed } from './seedData'
import { activePlanForDay } from './dailyPlan'
import { validateDecisionPayload, validateDecisionSubmission } from './decisionRules'
const STORE_KEY = 'work-dashboard:db:v1'

interface LocalStore {
  tasks: Task[]
  updates: TaskUpdate[]
  feedbackThreads: FeedbackThread[]
  feedbackMessages: FeedbackMessage[]
  planBlocks: PlanBlock[]
  planBlockChanges: PlanBlockChange[]
  decisionForms: DecisionForm[]
  decisionQuestions: DecisionQuestion[]
  decisionOptions: DecisionOption[]
  decisionResponses: DecisionResponse[]
  decisionAnswers: DecisionAnswer[]
  decisionClarifications: DecisionClarification[]
}

function load(): LocalStore {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as LocalStore
      if (parsed && Array.isArray(parsed.tasks) && Array.isArray(parsed.updates)) {
        // 兼容旧结构（无反馈/计划/决策字段时初始化）
        const seed = buildSeed()
        return {
          ...parsed,
          feedbackThreads: parsed.feedbackThreads ?? [],
          feedbackMessages: parsed.feedbackMessages ?? [],
          planBlocks: parsed.planBlocks ?? [],
          planBlockChanges: parsed.planBlockChanges ?? [],
          decisionForms: parsed.decisionForms ?? seed.decisionForms,
          decisionQuestions: parsed.decisionQuestions ?? seed.decisionQuestions,
          decisionOptions: parsed.decisionOptions ?? seed.decisionOptions,
          decisionResponses: parsed.decisionResponses ?? seed.decisionResponses,
          decisionAnswers: parsed.decisionAnswers ?? seed.decisionAnswers,
          decisionClarifications: parsed.decisionClarifications ?? [],
        }
      }
    }
  } catch {
    // 数据损坏则重建
  }
  const seed = buildSeed()
  const fresh: LocalStore = {
    ...seed,
    feedbackThreads: [],
    feedbackMessages: [],
    planBlocks: [],
    planBlockChanges: [],
  }
  save(fresh)
  return fresh
}

function save(store: LocalStore): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(store))
}

const now = () => new Date().toISOString()

export function createLocalDB(): DB {
  return {
    mode: 'local',

    async listTasks() {
      return load().tasks
    },

    async getTask(id) {
      return load().tasks.find((t) => t.id === id) ?? null
    },

    async listUpdates(taskId) {
      return load()
        .updates.filter((u) => u.task_id === taskId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    },

    async listAllUpdates() {
      return load().updates.sort((a, b) => b.created_at.localeCompare(a.created_at))
    },

    async createTask(input) {
      const store = load()
      const task: Task = {
        id: newId(),
        title: input.title,
        description: input.description ?? '',
        status: input.status ?? 'planned',
        priority: input.priority ?? 'normal',
        progress: input.progress ?? 0,
        start_date: input.start_date ?? null,
        expected_end_date: input.expected_end_date ?? null,
        actual_end_date: null,
        current_status: input.current_status ?? '',
        block_reason: input.block_reason ?? '',
        is_interrupt_task: input.is_interrupt_task ?? false,
        created_at: now(),
        updated_at: now(),
      }
      store.tasks.push(task)
      save(store)
      return task
    },

    async updateTask(id, patch) {
      const store = load()
      const task = store.tasks.find((t) => t.id === id)
      if (!task) throw new Error(`任务不存在: ${id}`)
      Object.assign(task, patch, { updated_at: now() })
      save(store)
      return task
    },

    async addUpdate(input) {
      const store = load()
      if (!store.tasks.some((t) => t.id === input.task_id)) {
        throw new Error(`任务不存在: ${input.task_id}（拒绝写入孤儿时间线）`)
      }
      const update: TaskUpdate = {
        id: newId('u'),
        task_id: input.task_id,
        type: input.type,
        content: input.content,
        old_expected_end_date: input.old_expected_end_date ?? null,
        new_expected_end_date: input.new_expected_end_date ?? null,
        created_at: now(),
        created_by: input.created_by ?? 'admin',
      }
      store.updates.push(update)
      save(store)
      return update
    },

    async applyTaskUpdate(taskId, patch, update) {
      const store = load()
      const task = store.tasks.find((t) => t.id === taskId)
      if (!task) throw new Error(`任务不存在: ${taskId}`)
      Object.assign(task, patch, { updated_at: now() })
      store.updates.push({
        id: newId('u'),
        task_id: taskId,
        type: update.type,
        content: update.content,
        old_expected_end_date: update.old_expected_end_date ?? null,
        new_expected_end_date: update.new_expected_end_date ?? null,
        created_at: now(),
        created_by: update.created_by ?? 'admin',
      })
      save(store)
      return task
    },

    async deleteTask(id) {
      const store = load()
      store.tasks = store.tasks.filter((t) => t.id !== id)
      store.updates = store.updates.filter((u) => u.task_id !== id)
      save(store)
    },

    async applyCreate(input, note, createdBy) {
      const store = load()
      const task: Task = {
        id: newId(),
        title: input.title,
        description: input.description ?? '',
        status: input.status ?? 'planned',
        priority: input.priority ?? 'normal',
        progress: input.progress ?? 0,
        start_date: input.start_date ?? null,
        expected_end_date: input.expected_end_date ?? null,
        actual_end_date: null,
        current_status: input.current_status ?? '',
        block_reason: input.block_reason ?? '',
        is_interrupt_task: input.is_interrupt_task ?? false,
        created_at: now(),
        updated_at: now(),
      }
      store.tasks.push(task)
      store.updates.push({
        id: newId('u'),
        task_id: task.id,
        type: 'note',
        content: note ?? '任务创建。',
        old_expected_end_date: null,
        new_expected_end_date: null,
        created_at: now(),
        created_by: createdBy ?? 'admin',
      })
      save(store)
      return task
    },

    // ---- 反馈线程（任务一） ----

    async listFeedbackThreads(taskId, kind) {
      const store = load()
      return store.feedbackThreads
        .filter((t) => t.task_id === taskId && (!kind || (t.kind ?? 'leader_feedback') === kind))
        .map((t) => enrichThread(t, store))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    },

    async listAllFeedbackThreads(kind) {
      const store = load()
      return store.feedbackThreads
        .filter((t) => !kind || (t.kind ?? 'leader_feedback') === kind)
        .map((t) => enrichThread(t, store))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    },

    async listFeedbackMessages(threadId) {
      return load()
        .feedbackMessages.filter((m) => m.thread_id === threadId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    },

    async createFeedbackThread(taskId, body, authorName, authorRole, kind) {
      if (!body || !body.trim()) throw new Error('反馈内容不能为空')
      const store = load()
      if (!store.tasks.some((t) => t.id === taskId)) throw new Error(`任务不存在: ${taskId}`)
      const thread: FeedbackThread = {
        id: newId('ft'),
        task_id: taskId,
        kind,
        status: 'open',
        created_at: now(),
        created_by: authorName || '',
        resolved_at: null,
        resolved_by: '',
        updated_at: now(),
      }
      store.feedbackThreads.push(thread)
      store.feedbackMessages.push({
        id: newId('fm'),
        thread_id: thread.id,
        body: body.trim(),
        author_name: authorName || '',
        author_role: authorRole,
        created_at: now(),
      })
      save(store)
      return thread
    },

    async addFeedbackMessage(threadId, body, authorName, authorRole) {
      if (!body || !body.trim()) throw new Error('回复内容不能为空')
      const store = load()
      const thread = store.feedbackThreads.find((t) => t.id === threadId)
      if (!thread) throw new Error(`反馈线程不存在: ${threadId}`)
      const message: FeedbackMessage = {
        id: newId('fm'),
        thread_id: threadId,
        body: body.trim(),
        author_name: authorName || '',
        author_role: authorRole,
        created_at: now(),
      }
      store.feedbackMessages.push(message)
      // 已解决的线程被再次回复 → 重新打开
      if (thread.status === 'resolved') {
        thread.status = 'open'
        thread.resolved_at = null
        thread.resolved_by = ''
      }
      thread.updated_at = now()
      save(store)
      return message
    },

    async setFeedbackStatus(threadId, status, byName) {
      const store = load()
      const thread = store.feedbackThreads.find((t) => t.id === threadId)
      if (!thread) throw new Error(`反馈线程不存在: ${threadId}`)
      thread.status = status
      thread.resolved_at = status === 'resolved' ? now() : null
      thread.resolved_by = status === 'resolved' ? byName || '' : ''
      thread.updated_at = now()
      save(store)
      return thread
    },

    // ---- 日粒度计划（任务三） ----

    async listPlanBlocks(opts) {
      const store = load()
      return store.planBlocks
        .filter((b) => {
          if (opts?.taskId && b.task_id !== opts.taskId) return false
          if (opts?.from && b.end_date < opts.from) return false
          if (opts?.to && b.start_date > opts.to) return false
          return true
        })
        .sort((a, b) => a.start_date.localeCompare(b.start_date))
    },

    async listPlanBlockChanges(blockId) {
      return load()
        .planBlockChanges.filter((c) => c.block_id === blockId)
        .sort((a, b) => a.changed_at.localeCompare(b.changed_at))
    },

    async createPlanBlock(input) {
      if (input.end_date < input.start_date) throw new Error('结束日期不得早于开始日期')
      const store = load()
      if (!store.tasks.some((t) => t.id === input.task_id)) throw new Error(`任务不存在: ${input.task_id}`)
      const block: PlanBlock = {
        id: newId('pb'),
        task_id: input.task_id,
        start_date: input.start_date,
        end_date: input.end_date,
        summary: input.summary ?? '',
        status: (input.status as PlanBlock['status']) ?? 'planned',
        created_at: now(),
        updated_at: now(),
        created_by: input.created_by ?? '',
      }
      store.planBlocks.push(block)
      save(store)
      return block
    },

    async ensurePlanForDay(input) {
      const store = load()
      if (!store.tasks.some((t) => t.id === input.task_id)) throw new Error(`任务不存在: ${input.task_id}`)
      const existing = activePlanForDay(store.planBlocks, input.task_id, input.date)
      if (existing) return existing

      // local 模式将计划块和审计记录写入同一份 store，再一次性 save，保持与线上 RPC 一致的原子语义。
      const block: PlanBlock = {
        id: newId('pb'),
        task_id: input.task_id,
        start_date: input.date,
        end_date: input.date,
        summary: '',
        status: 'planned',
        created_at: now(),
        updated_at: now(),
        created_by: input.created_by ?? '',
      }
      store.planBlocks.push(block)
      store.updates.push({
        id: newId('u'),
        task_id: input.task_id,
        type: 'note',
        content: `安排到今天日计划（${input.date}）`,
        old_expected_end_date: null,
        new_expected_end_date: null,
        created_at: now(),
        created_by: input.created_by ?? 'admin',
        notify_mode: 'silent',
      })
      save(store)
      return block
    },

    async movePlanBlock(blockId, patch, note, by) {
      const store = load()
      const block = store.planBlocks.find((b) => b.id === blockId)
      if (!block) throw new Error(`计划块不存在: ${blockId}`)
      const newStart = patch.start_date ?? block.start_date
      const newEnd = patch.end_date ?? block.end_date
      if (newEnd < newStart) throw new Error('结束日期不得早于开始日期')
      store.planBlockChanges.push({
        id: newId('pc'),
        block_id: blockId,
        old_start_date: block.start_date,
        old_end_date: block.end_date,
        old_status: block.status,
        new_start_date: newStart,
        new_end_date: newEnd,
        new_status: 'changed',
        note,
        changed_at: now(),
        changed_by: by,
      })
      block.start_date = newStart
      block.end_date = newEnd
      block.status = 'changed'
      block.updated_at = now()
      save(store)
      return block
    },

    async donePlanBlock(blockId, note, by) {
      const store = load()
      const block = store.planBlocks.find((b) => b.id === blockId)
      if (!block) throw new Error(`计划块不存在: ${blockId}`)
      store.planBlockChanges.push({
        id: newId('pc'),
        block_id: blockId,
        old_start_date: block.start_date,
        old_end_date: block.end_date,
        old_status: block.status,
        new_start_date: block.start_date,
        new_end_date: block.end_date,
        new_status: 'done',
        note,
        changed_at: now(),
        changed_by: by,
      })
      block.status = 'done'
      block.updated_at = now()
      save(store)
      return block
    },

    // ---- 决策中心（Decision Hub） ----

    async listDecisionForms() {
      const store = load()
      return store.decisionForms
        .map((f) => ({
          ...f,
          question_count: store.decisionQuestions.filter((q) => q.form_id === f.id).length,
          response_count: store.decisionResponses.filter((r) => r.form_id === f.id).length,
        }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
    },

    async getDecisionFormBySlug(slug: string) {
      const store = load()
      const cleanSlug = slug.trim()
      const form = store.decisionForms.find((f) => f.slug === cleanSlug)
      if (!form) return null

      const questions = store.decisionQuestions
        .filter((q) => q.form_id === form.id)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((q) => {
          const options = store.decisionOptions
            .filter((o) => o.question_id === q.id)
            .sort((a, b) => a.sort_order - b.sort_order)
          const recOpt = q.recommended_option_id
            ? options.find((o) => o.id === q.recommended_option_id)
            : null
          return {
            ...q,
            options,
            recommended_option_code: recOpt ? recOpt.code : null,
          }
        })

      const responses = store.decisionResponses
        .filter((r) => r.form_id === form.id)
        .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))
        .map((r) => {
          const answers = store.decisionAnswers.filter((a) => a.response_id === r.id)
          return {
            ...r,
            answers,
          }
        })
      const clarifications = store.decisionClarifications
        .filter((entry) => entry.form_id === form.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))

      return {
        ...form,
        question_count: questions.length,
        response_count: responses.length,
        questions,
        responses,
        clarifications,
      } as DecisionFormDetail
    },

    async createDecisionForm(payload: DecisionFormPayload) {
      const validation = validateDecisionPayload(payload)
      if (!validation.valid) {
        throw new Error(`创建表单校验失败: ${validation.errors.join('; ')}`)
      }

      const store = load()
      const cleanSlug = payload.slug.trim()
      if (store.decisionForms.some((f) => f.slug === cleanSlug)) {
        throw new Error(`slug 已存在: ${cleanSlug}`)
      }

      const formId = newId('df')
      const newForm: DecisionForm = {
        id: formId,
        slug: cleanSlug,
        title: payload.title.trim(),
        summary: payload.summary?.trim() ?? '',
        source_document: payload.source_document ?? null,
        status: payload.status ?? 'open',
        created_by: payload.created_by?.trim() || 'agent',
        created_at: now(),
        closed_at: null,
        updated_at: now(),
      }

      const newQuestions: DecisionQuestion[] = []
      const newOptions: DecisionOption[] = []

      payload.questions.forEach((qp, qIdx) => {
        const qId = newId('dq')
        let recOptId: string | null = null

        const qOpts: DecisionOption[] = (qp.options || []).map((op, oIdx) => {
          const oId = newId('do')
          if (qp.recommended_option_code && qp.recommended_option_code.trim() === op.code.trim()) {
            recOptId = oId
          }
          return {
            id: oId,
            question_id: qId,
            code: op.code.trim(),
            label: op.label.trim(),
            detail: op.detail?.trim() ?? '',
            sort_order: oIdx,
          }
        })

        newOptions.push(...qOpts)

        newQuestions.push({
          id: qId,
          form_id: formId,
          code: qp.code.trim(),
          sort_order: qIdx,
          title: qp.title.trim(),
          context: qp.context?.trim() ?? '',
          group_name: qp.group_name?.trim() || '待确认事项',
          source_excerpt: qp.source_excerpt?.trim() ?? '',
          conversion_note: qp.conversion_note?.trim() ?? '',
          resolution_status: 'pending',
          type: qp.type,
          required: qp.required ?? true,
          allow_other: qp.allow_other ?? false,
          recommended_option_id: recOptId,
          recommended_reason: qp.recommended_reason?.trim() ?? '',
          recommended_option_code: qp.recommended_option_code?.trim() ?? null,
          options: qOpts,
        })
      })

      store.decisionForms.push(newForm)
      store.decisionQuestions.push(...newQuestions)
      store.decisionOptions.push(...newOptions)
      save(store)

      return { id: formId, slug: cleanSlug }
    },

    async submitDecisionResponse(slug, respondentName, answers, respondentNote) {
      const store = load()
      const cleanSlug = slug.trim()
      const form = store.decisionForms.find((f) => f.slug === cleanSlug)
      if (!form) throw new Error(`表单不存在: ${cleanSlug}`)
      if (form.status !== 'open') throw new Error('表单已关闭或未开放，无法提交答卷')

      const detail = await this.getDecisionFormBySlug(cleanSlug)
      if (!detail) throw new Error(`表单不存在: ${cleanSlug}`)

      const validation = validateDecisionSubmission(detail, {
        respondent_name: respondentName,
        respondent_note: respondentNote,
        answers,
      })
      if (!validation.valid) {
        const errMsgs = Object.entries(validation.errors).map(([k, v]) => `${k}: ${v}`)
        throw new Error(`提交答卷校验失败: ${errMsgs.join('; ')}`)
      }

      const responseId = newId('dr')
      const newResponse: DecisionResponse = {
        id: responseId,
        form_id: form.id,
        respondent_name: respondentName.trim(),
        respondent_note: respondentNote?.trim() ?? '',
        submitted_at: now(),
      }

      const newAnswers: DecisionAnswer[] = answers.map((ans) => ({
        id: newId('da'),
        response_id: responseId,
        question_id: ans.question_id,
        selected_option_ids: ans.selected_option_ids ?? [],
        text_answer: ans.text_answer?.trim() ?? '',
        other_text: ans.other_text?.trim() ?? '',
      }))

      store.decisionResponses.push(newResponse)
      store.decisionAnswers.push(...newAnswers)
      save(store)

      return {
        ...newResponse,
        answers: newAnswers,
      }
    },

    async appendDecisionClarification(input) {
      const store = load()
      const form = store.decisionForms.find((item) => item.slug === input.slug.trim())
      if (!form) throw new Error(`表单不存在: ${input.slug}`)
      const question = store.decisionQuestions.find(
        (item) => item.form_id === form.id && item.code === input.questionCode.trim(),
      )
      if (!question) throw new Error(`题目不存在: ${input.questionCode}`)
      const content = input.content.trim()
      if (!content) throw new Error('澄清内容不能为空')
      const entry: DecisionClarification = {
        id: newId('dc'),
        form_id: form.id,
        question_id: question.id,
        kind: input.kind,
        content,
        source_channel: input.sourceChannel?.trim() || 'feishu',
        source_url: input.sourceUrl?.trim() || '',
        created_by: input.createdBy?.trim() || 'agent',
        created_at: now(),
      }
      store.decisionClarifications.push(entry)
      question.resolution_status = input.kind === 'decision'
        ? 'decided'
        : input.kind === 'change'
          ? 'changed'
          : question.resolution_status === 'decided'
            ? 'decided'
            : 'clarified'
      form.updated_at = now()
      save(store)
      return entry
    },

    async closeDecisionForm(slug: string) {
      const store = load()
      const cleanSlug = slug.trim()
      const form = store.decisionForms.find((f) => f.slug === cleanSlug)
      if (!form) throw new Error(`表单不存在: ${cleanSlug}`)
      form.status = 'closed'
      form.closed_at = now()
      form.updated_at = now()
      save(store)
    },

    async openDecisionForm(slug: string) {
      const store = load()
      const cleanSlug = slug.trim()
      const form = store.decisionForms.find((f) => f.slug === cleanSlug)
      if (!form) throw new Error(`表单不存在: ${cleanSlug}`)
      form.status = 'open'
      form.closed_at = null
      form.updated_at = now()
      save(store)
    },
  }
}

function enrichThread(t: FeedbackThread, store: LocalStore): FeedbackThread {
  const msgs = store.feedbackMessages
    .filter((m) => m.thread_id === t.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  const last = msgs[msgs.length - 1]
  return {
    ...t,
    message_count: msgs.length,
    latest_message: last?.body.slice(0, 80),
    latest_message_at: last?.created_at,
    latest_author: last?.author_name,
  }
}

// ---- 日粒度计划（任务三，local 实现，附在 LocalStore 内）----
