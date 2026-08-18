// ============================================================
// Supabase 数据层
// 使用前端 anon key 访问；数据库已配置「全开放」策略
// （无登录、无权限控制，见 supabase/schema.sql）。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { DB } from './db'
import type {
  DecisionAnswer,
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

const TASKS = 'tasks'
const UPDATES = 'task_updates'

export function createSupabaseDB(client: SupabaseClient): DB {
  return {
    mode: 'supabase',

    async listTasks() {
      const { data, error } = await client
        .from(TASKS)
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw new Error(error.message)
      return (data ?? []) as Task[]
    },

    async getTask(id) {
      const { data, error } = await client.from(TASKS).select('*').eq('id', id).maybeSingle()
      if (error) throw new Error(error.message)
      return (data as Task) ?? null
    },

    async listUpdates(taskId) {
      const { data, error } = await client
        .from(UPDATES)
        .select('*')
        .eq('task_id', taskId)
        .order('created_at', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []) as TaskUpdate[]
    },

    async listAllUpdates() {
      const { data, error } = await client
        .from(UPDATES)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) throw new Error(error.message)
      return (data ?? []) as TaskUpdate[]
    },

    async createTask(input) {
      const { data, error } = await client.from(TASKS).insert(input).select().single()
      if (error) throw new Error(error.message)
      return data as Task
    },

    async updateTask(id, patch) {
      const { data, error } = await client
        .from(TASKS)
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data as Task
    },

    async addUpdate(input) {
      const { data, error } = await client.from(UPDATES).insert(input).select().single()
      if (error) throw new Error(error.message)
      return data as TaskUpdate
    },

    async applyTaskUpdate(taskId, patch, update) {
      const { data, error } = await client.rpc('apply_task_update', {
        p_task_id: taskId,
        p_patch: patch as Record<string, unknown>,
        p_type: update.type,
        p_content: update.content,
        p_old_date: update.old_expected_end_date ?? null,
        p_new_date: update.new_expected_end_date ?? null,
        p_created_by: update.created_by ?? 'admin',
      })
      if (error) throw new Error(error.message)
      return data as Task
    },

    async deleteTask(id) {
      const { error } = await client.from(TASKS).delete().eq('id', id)
      if (error) throw new Error(error.message)
    },

    async applyCreate(input, note, createdBy) {
      const { data, error } = await client.rpc('create_task_with_note', {
        p_title: input.title,
        p_patch: input as unknown as Record<string, unknown>,
        p_content: note ?? '任务创建。',
        p_created_by: createdBy ?? 'admin',
      })
      if (error) throw new Error(error.message)
      return data as Task
    },

    // ---- 反馈线程（任务一） ----

    async listFeedbackThreads(taskId) {
      const { data, error } = await client
        .from('task_feedback_threads')
        .select('*, task_feedback_messages(count)')
        .eq('task_id', taskId)
        .order('updated_at', { ascending: false })
      if (error) throw new Error(error.message)
      return (data ?? []).map((t) => ({
        ...t,
        message_count: t.task_feedback_messages?.[0]?.count ?? 0,
      })) as FeedbackThread[]
    },

    async listAllFeedbackThreads() {
      const { data, error } = await client
        .from('task_feedback_threads')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(200)
      if (error) throw new Error(error.message)
      return (data ?? []) as FeedbackThread[]
    },

    async listFeedbackMessages(threadId) {
      const { data, error } = await client
        .from('task_feedback_messages')
        .select('*')
        .eq('thread_id', threadId)
        .order('created_at', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []) as FeedbackMessage[]
    },

    async createFeedbackThread(taskId, body, authorName, authorRole) {
      const { data, error } = await client.rpc('create_feedback_thread', {
        p_task_id: taskId,
        p_body: body,
        p_author_name: authorName,
        p_author_role: authorRole,
      })
      if (error) throw new Error(error.message)
      return data as FeedbackThread
    },

    async addFeedbackMessage(threadId, body, authorName, authorRole) {
      const { data, error } = await client.rpc('add_feedback_reply', {
        p_thread_id: threadId,
        p_body: body,
        p_author_name: authorName,
        p_author_role: authorRole,
      })
      if (error) throw new Error(error.message)
      return data as FeedbackMessage
    },

    async setFeedbackStatus(threadId, status, byName) {
      const { data, error } = await client.rpc('set_feedback_status', {
        p_thread_id: threadId,
        p_status: status,
        p_by_name: byName,
      })
      if (error) throw new Error(error.message)
      return data as FeedbackThread
    },

    // ---- 日粒度计划（任务三） ----

    async listPlanBlocks(opts) {
      let query = client.from('task_plan_blocks').select('*')
      if (opts?.taskId) query = query.eq('task_id', opts.taskId)
      if (opts?.from) query = query.gte('end_date', opts.from)
      if (opts?.to) query = query.lte('start_date', opts.to)
      const { data, error } = await query.order('start_date', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []) as PlanBlock[]
    },

    async listPlanBlockChanges(blockId) {
      const { data, error } = await client
        .from('task_plan_block_changes')
        .select('*')
        .eq('block_id', blockId)
        .order('changed_at', { ascending: true })
      if (error) throw new Error(error.message)
      return (data ?? []) as PlanBlockChange[]
    },

    async createPlanBlock(input) {
      const { data, error } = await client.rpc('create_plan_block', {
        p_task_id: input.task_id,
        p_start_date: input.start_date,
        p_end_date: input.end_date,
        p_summary: input.summary ?? '',
        p_status: input.status ?? 'planned',
        p_created_by: input.created_by ?? '',
      })
      if (error) throw new Error(error.message)
      return data as PlanBlock
    },

    async ensurePlanForDay(input) {
      const { data, error } = await client.rpc('ensure_plan_for_day', {
        p_task_id: input.task_id,
        p_date: input.date,
        p_created_by: input.created_by ?? '',
      })
      if (error) throw new Error(error.message)
      return data as PlanBlock
    },

    async movePlanBlock(blockId, patch, note, by) {
      const { data, error } = await client.rpc('move_plan_block', {
        p_block_id: blockId,
        p_start_date: patch.start_date ?? null,
        p_end_date: patch.end_date ?? null,
        p_note: note,
        p_by: by,
      })
      if (error) throw new Error(error.message)
      return data as PlanBlock
    },

    async donePlanBlock(blockId, note, by) {
      const { data, error } = await client.rpc('done_plan_block', {
        p_block_id: blockId,
        p_note: note,
        p_by: by,
      })
      if (error) throw new Error(error.message)
      return data as PlanBlock
    },

    // ---- 决策中心（Decision Hub） ----

    async listDecisionForms() {
      const { data: forms, error: formsErr } = await client
        .from('decision_forms')
        .select('*, decision_questions(count), decision_responses(count)')
        .order('created_at', { ascending: false })

      if (formsErr) throw new Error(formsErr.message)

      return (forms ?? []).map((f: any) => ({
        id: f.id,
        slug: f.slug,
        title: f.title,
        summary: f.summary,
        source_document: f.source_document,
        status: f.status,
        created_by: f.created_by,
        created_at: f.created_at,
        closed_at: f.closed_at,
        updated_at: f.updated_at,
        question_count: f.decision_questions?.[0]?.count ?? 0,
        response_count: f.decision_responses?.[0]?.count ?? 0,
      })) as DecisionForm[]
    },

    async getDecisionFormBySlug(slug: string) {
      const cleanSlug = slug.trim()
      const { data: form, error: formErr } = await client
        .from('decision_forms')
        .select('*')
        .eq('slug', cleanSlug)
        .maybeSingle()

      if (formErr) throw new Error(formErr.message)
      if (!form) return null

      // 查询全部题目
      const { data: questions, error: qErr } = await client
        .from('decision_questions')
        .select('*')
        .eq('form_id', form.id)
        .order('sort_order', { ascending: true })

      if (qErr) throw new Error(qErr.message)

      const qIds = (questions ?? []).map((q: any) => q.id)

      // 查询全部选项
      let options: DecisionOption[] = []
      if (qIds.length > 0) {
        const { data: opts, error: optErr } = await client
          .from('decision_options')
          .select('*')
          .in('question_id', qIds)
          .order('sort_order', { ascending: true })
        if (optErr) throw new Error(optErr.message)
        options = (opts ?? []) as DecisionOption[]
      }

      const optionsByQId = new Map<string, DecisionOption[]>()
      const optionById = new Map<string, DecisionOption>()
      for (const opt of options) {
        if (!optionsByQId.has(opt.question_id)) {
          optionsByQId.set(opt.question_id, [])
        }
        optionsByQId.get(opt.question_id)!.push(opt)
        optionById.set(opt.id, opt)
      }

      const formattedQuestions: DecisionQuestion[] = (questions ?? []).map((q: any) => {
        const qOptions = optionsByQId.get(q.id) ?? []
        const recOpt = q.recommended_option_id ? optionById.get(q.recommended_option_id) : null
        return {
          id: q.id,
          form_id: q.form_id,
          code: q.code,
          sort_order: q.sort_order,
          title: q.title,
          context: q.context,
          type: q.type,
          required: q.required,
          allow_other: q.allow_other,
          recommended_option_id: q.recommended_option_id,
          recommended_reason: q.recommended_reason ?? '',
          recommended_option_code: recOpt ? recOpt.code : null,
          options: qOptions,
        }
      })

      // 查询答卷
      const { data: responses, error: rErr } = await client
        .from('decision_responses')
        .select('*')
        .eq('form_id', form.id)
        .order('submitted_at', { ascending: false })

      if (rErr) throw new Error(rErr.message)

      const rIds = (responses ?? []).map((r: any) => r.id)

      // 查询答案
      let answers: DecisionAnswer[] = []
      if (rIds.length > 0) {
        const { data: ansList, error: ansErr } = await client
          .from('decision_answers')
          .select('*')
          .in('response_id', rIds)
        if (ansErr) throw new Error(ansErr.message)
        answers = (ansList ?? []) as DecisionAnswer[]
      }

      const answersByRId = new Map<string, DecisionAnswer[]>()
      for (const ans of answers) {
        if (!answersByRId.has(ans.response_id)) {
          answersByRId.set(ans.response_id, [])
        }
        answersByRId.get(ans.response_id)!.push(ans)
      }

      const formattedResponses: DecisionResponse[] = (responses ?? []).map((r: any) => ({
        id: r.id,
        form_id: r.form_id,
        respondent_name: r.respondent_name,
        respondent_note: r.respondent_note,
        submitted_at: r.submitted_at,
        answers: answersByRId.get(r.id) ?? [],
      }))

      return {
        id: form.id,
        slug: form.slug,
        title: form.title,
        summary: form.summary,
        source_document: form.source_document,
        status: form.status,
        created_by: form.created_by,
        created_at: form.created_at,
        closed_at: form.closed_at,
        updated_at: form.updated_at,
        question_count: formattedQuestions.length,
        response_count: formattedResponses.length,
        questions: formattedQuestions,
        responses: formattedResponses,
      } as DecisionFormDetail
    },

    async createDecisionForm(payload: DecisionFormPayload) {
      const { data, error } = await client.rpc('create_decision_form', {
        p_payload: payload as unknown as Record<string, unknown>,
      })
      if (error) throw new Error(error.message)
      return data as { id: string; slug: string }
    },

    async submitDecisionResponse(slug, respondentName, answers, respondentNote) {
      const { data, error } = await client.rpc('submit_decision_response', {
        p_form_slug: slug,
        p_respondent_name: respondentName,
        p_answers: answers as unknown as Record<string, unknown>[],
        p_respondent_note: respondentNote ?? '',
      })
      if (error) throw new Error(error.message)
      return data as DecisionResponse
    },

    async closeDecisionForm(slug: string) {
      const { error } = await client.rpc('close_decision_form', {
        p_slug: slug,
      })
      if (error) throw new Error(error.message)
    },

    async openDecisionForm(slug: string) {
      const { error } = await client.rpc('open_decision_form', {
        p_slug: slug,
      })
      if (error) throw new Error(error.message)
    },
  }
}
