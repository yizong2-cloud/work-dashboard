// ============================================================
// 存储层（Node 侧，供 Agent CLI 使用）
//   - Supabase 模式：使用 service_role key（仅本地 .env，绝不进前端）
//   - 本地模式：JSON 文件（data/local.json），便于无网络开发测试
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { validateDecisionPayload, validateDecisionSubmission } from '../../src/lib/decisionRules.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const getLocalFile = () => process.env.LOCAL_DB_FILE || path.join(ROOT, 'data', 'local.json')

const now = () => new Date().toISOString()

export function createStore(env) {
  // 兼容两种写法：SUPABASE_URL（专用）或 VITE_SUPABASE_URL（与前端共用一份 .env）
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  if (url && env.SUPABASE_SERVICE_ROLE_KEY) {
    return createSupabaseStore({ ...env, SUPABASE_URL: url })
  }
  return createLocalStore()
}

// ---------------- 本地 JSON 存储 ----------------

function loadLocal() {
  const file = getLocalFile()
  if (!fs.existsSync(file)) {
    return {
      tasks: [],
      updates: [],
      feedbackThreads: [],
      feedbackMessages: [],
      planBlocks: [],
      planBlockChanges: [],
      decisionForms: [],
      decisionQuestions: [],
      decisionOptions: [],
      decisionResponses: [],
      decisionAnswers: [],
    }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && Array.isArray(parsed.tasks) && Array.isArray(parsed.updates)) {
      return {
        ...parsed,
        feedbackThreads: parsed.feedbackThreads ?? [],
        feedbackMessages: parsed.feedbackMessages ?? [],
        planBlocks: parsed.planBlocks ?? [],
        planBlockChanges: parsed.planBlockChanges ?? [],
        decisionForms: parsed.decisionForms ?? [],
        decisionQuestions: parsed.decisionQuestions ?? [],
        decisionOptions: parsed.decisionOptions ?? [],
        decisionResponses: parsed.decisionResponses ?? [],
        decisionAnswers: parsed.decisionAnswers ?? [],
      }
    }
  } catch {
    // 损坏则重建
  }
  return {
    tasks: [],
    updates: [],
    feedbackThreads: [],
    feedbackMessages: [],
    planBlocks: [],
    planBlockChanges: [],
    decisionForms: [],
    decisionQuestions: [],
    decisionOptions: [],
    decisionResponses: [],
    decisionAnswers: [],
  }
}

function saveLocal(db) {
  const file = getLocalFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(db, null, 2))
}

function createLocalStore() {
  return {
    mode: 'local',
    get localFile() {
      return getLocalFile()
    },
    async listTasks() {
      return loadLocal().tasks
    },
    async getTask(id) {
      return loadLocal().tasks.find((t) => t.id === id) ?? null
    },
    async listUpdates(taskId) {
      return loadLocal()
        .updates.filter((u) => u.task_id === taskId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    },
    async listAllUpdates() {
      return loadLocal().updates.sort((a, b) => b.created_at.localeCompare(a.created_at))
    },
    async createTask(input) {
      const db = loadLocal()
      const task = {
        id: crypto.randomUUID(),
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
      db.tasks.push(task)
      saveLocal(db)
      return task
    },
    async updateTask(id, patch) {
      const db = loadLocal()
      const task = db.tasks.find((t) => t.id === id)
      if (!task) throw new Error(`任务不存在: ${id}`)
      Object.assign(task, patch, { updated_at: now() })
      saveLocal(db)
      return task
    },
    async addUpdate(input) {
      const db = loadLocal()
      const exists = db.tasks.some((t) => t.id === input.task_id)
      if (!exists) throw new Error(`任务不存在: ${input.task_id}（拒绝写入孤儿时间线）`)
      const update = {
        id: crypto.randomUUID(),
        task_id: input.task_id,
        type: input.type,
        content: input.content,
        old_expected_end_date: input.old_expected_end_date ?? null,
        new_expected_end_date: input.new_expected_end_date ?? null,
        created_at: input.created_at ?? now(),
        created_by: input.created_by ?? 'agent',
        notify_mode: input.notify_mode ?? 'immediate',
        merge_key: input.merge_key ?? null,
      }
      db.updates.push(update)
      saveLocal(db)
      return update
    },

    /**
     * 原子更新：任务字段修改 + 时间线追加 一次完成（local 模式单次写盘）。
     * 保证「任何变化都写时间线」且不会出现改了一半的中间态。
     */
    async applyTaskUpdate(taskId, patch, update) {
      const db = loadLocal()
      const task = db.tasks.find((t) => t.id === taskId)
      if (!task) throw new Error(`任务不存在: ${taskId}`)
      Object.assign(task, patch, { updated_at: now() })
      db.updates.push({
        id: crypto.randomUUID(),
        task_id: taskId,
        type: update.type,
        content: update.content,
        old_expected_end_date: update.old_expected_end_date ?? null,
        new_expected_end_date: update.new_expected_end_date ?? null,
        created_at: update.created_at ?? now(),
        created_by: update.created_by ?? 'agent',
        notify_mode: update.notify_mode ?? 'immediate',
        merge_key: update.merge_key ?? null,
      })
      saveLocal(db)
      return task
    },
    async flushMerge() {
      return 0 // 本地模式无推送
    },
    async deleteTask(id) {
      const db = loadLocal()
      db.tasks = db.tasks.filter((t) => t.id !== id)
      db.updates = db.updates.filter((u) => u.task_id !== id)
      saveLocal(db)
    },
    /**
     * 原子创建：任务 + 初始时间线 一次完成。
     */

    // ---- 日粒度计划（任务三）----
    async listPlanBlocks(opts) {
      const db = loadLocal()
      return db.planBlocks
        .filter((b) => {
          if (opts?.taskId && b.task_id !== opts.taskId) return false
          if (opts?.from && b.end_date < opts.from) return false
          if (opts?.to && b.start_date > opts.to) return false
          return true
        })
        .sort((a, b) => a.start_date.localeCompare(b.start_date))
    },
    async listPlanBlockChanges(blockId) {
      return loadLocal().planBlockChanges
        .filter((c) => c.block_id === blockId)
        .sort((a, b) => a.changed_at.localeCompare(b.changed_at))
    },
    async createPlanBlock(input) {
      const db = loadLocal()
      if (!db.tasks.some((t) => t.id === input.task_id)) throw new Error(`任务不存在: ${input.task_id}`)
      if (input.end_date < input.start_date) throw new Error('结束日期不得早于开始日期')
      const block = {
        id: crypto.randomUUID(),
        task_id: input.task_id,
        start_date: input.start_date,
        end_date: input.end_date,
        summary: input.summary ?? '',
        status: input.status ?? 'planned',
        created_at: now(),
        updated_at: now(),
        created_by: input.created_by ?? '',
      }
      db.planBlocks.push(block)
      saveLocal(db)
      return block
    },
    async movePlanBlock(blockId, patch, note, by) {
      const db = loadLocal()
      const block = db.planBlocks.find((b) => b.id === blockId)
      if (!block) throw new Error(`计划块不存在: ${blockId}`)
      const newStart = patch.start_date ?? block.start_date
      const newEnd = patch.end_date ?? block.end_date
      if (newEnd < newStart) throw new Error('结束日期不得早于开始日期')
      db.planBlockChanges.push({
        id: crypto.randomUUID(), block_id: blockId,
        old_start_date: block.start_date, old_end_date: block.end_date, old_status: block.status,
        new_start_date: newStart, new_end_date: newEnd, new_status: 'changed',
        note, changed_at: now(), changed_by: by,
      })
      Object.assign(block, { start_date: newStart, end_date: newEnd, status: 'changed', updated_at: now() })
      saveLocal(db)
      return block
    },
    async donePlanBlock(blockId, note, by) {
      const db = loadLocal()
      const block = db.planBlocks.find((b) => b.id === blockId)
      if (!block) throw new Error(`计划块不存在: ${blockId}`)
      db.planBlockChanges.push({
        id: crypto.randomUUID(), block_id: blockId,
        old_start_date: block.start_date, old_end_date: block.end_date, old_status: block.status,
        new_start_date: block.start_date, new_end_date: block.end_date, new_status: 'done',
        note, changed_at: now(), changed_by: by,
      })
      block.status = 'done'; block.updated_at = now()
      saveLocal(db)
      return block
    },
    async applyCreate(input, note, createdBy = 'agent') {
      const db = loadLocal()
      const task = {
        id: crypto.randomUUID(),
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
      db.tasks.push(task)
      db.updates.push({
        id: crypto.randomUUID(),
        task_id: task.id,
        type: 'note',
        content: note ?? '任务创建。',
        old_expected_end_date: null,
        new_expected_end_date: null,
        created_at: now(),
        created_by: createdBy,
      })
      saveLocal(db)
      return task
    },
    async seed(tasks, updates, force) {
      const db = loadLocal()
      if (db.tasks.length > 0 && !force) {
        throw new Error('本地数据非空；如需覆盖请加 --force')
      }
      saveLocal({ tasks, updates })
    },

    // ---- 决策中心 ----
    async listDecisionForms() {
      const db = loadLocal()
      return (db.decisionForms || [])
        .map((f) => ({
          ...f,
          question_count: (db.decisionQuestions || []).filter((q) => q.form_id === f.id).length,
          response_count: (db.decisionResponses || []).filter((r) => r.form_id === f.id).length,
        }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
    },

    async getDecisionFormBySlug(slug) {
      const db = loadLocal()
      const cleanSlug = slug.trim()
      const form = (db.decisionForms || []).find((f) => f.slug === cleanSlug)
      if (!form) return null

      const questions = (db.decisionQuestions || [])
        .filter((q) => q.form_id === form.id)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((q) => {
          const options = (db.decisionOptions || [])
            .filter((o) => o.question_id === q.id)
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          const recOpt = q.recommended_option_id
            ? options.find((o) => o.id === q.recommended_option_id)
            : null
          return {
            ...q,
            options,
            recommended_option_code: recOpt ? recOpt.code : null,
          }
        })

      const responses = (db.decisionResponses || [])
        .filter((r) => r.form_id === form.id)
        .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))
        .map((r) => {
          const answers = (db.decisionAnswers || []).filter((a) => a.response_id === r.id)
          return {
            ...r,
            answers,
          }
        })

      return {
        ...form,
        question_count: questions.length,
        response_count: responses.length,
        questions,
        responses,
      }
    },

    async createDecisionForm(payload) {
      const validation = validateDecisionPayload(payload)
      if (!validation.valid) {
        throw new Error(`创建表单校验失败: ${validation.errors.join('; ')}`)
      }

      const db = loadLocal()
      const cleanSlug = payload.slug.trim()
      if ((db.decisionForms || []).some((f) => f.slug === cleanSlug)) {
        throw new Error(`slug 已存在: ${cleanSlug}`)
      }

      const formId = crypto.randomUUID()
      const newForm = {
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

      const newQuestions = []
      const newOptions = []

      payload.questions.forEach((qp, qIdx) => {
        const qId = crypto.randomUUID()
        let recOptId = null

        const qOpts = (qp.options || []).map((op, oIdx) => {
          const oId = crypto.randomUUID()
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
          type: qp.type,
          required: qp.required ?? true,
          allow_other: qp.allow_other ?? false,
          recommended_option_id: recOptId,
          recommended_option_code: qp.recommended_option_code?.trim() ?? null,
          options: qOpts,
        })
      })

      db.decisionForms = db.decisionForms || []
      db.decisionQuestions = db.decisionQuestions || []
      db.decisionOptions = db.decisionOptions || []
      db.decisionResponses = db.decisionResponses || []
      db.decisionAnswers = db.decisionAnswers || []

      db.decisionForms.push(newForm)
      db.decisionQuestions.push(...newQuestions)
      db.decisionOptions.push(...newOptions)
      saveLocal(db)

      return { id: formId, slug: cleanSlug }
    },

    async submitDecisionResponse(slug, respondentName, answers, respondentNote) {
      const db = loadLocal()
      const cleanSlug = slug.trim()
      const form = (db.decisionForms || []).find((f) => f.slug === cleanSlug)
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

      const responseId = crypto.randomUUID()
      const newResponse = {
        id: responseId,
        form_id: form.id,
        respondent_name: respondentName.trim(),
        respondent_note: respondentNote?.trim() ?? '',
        submitted_at: now(),
      }

      const newAnswers = (answers || []).map((ans) => ({
        id: crypto.randomUUID(),
        response_id: responseId,
        question_id: ans.question_id,
        selected_option_ids: ans.selected_option_ids ?? [],
        text_answer: ans.text_answer?.trim() ?? '',
        other_text: ans.other_text?.trim() ?? '',
      }))

      db.decisionResponses = db.decisionResponses || []
      db.decisionAnswers = db.decisionAnswers || []
      db.decisionResponses.push(newResponse)
      db.decisionAnswers.push(...newAnswers)
      saveLocal(db)

      return {
        ...newResponse,
        answers: newAnswers,
      }
    },

    async closeDecisionForm(slug) {
      const db = loadLocal()
      const cleanSlug = slug.trim()
      const form = (db.decisionForms || []).find((f) => f.slug === cleanSlug)
      if (!form) throw new Error(`表单不存在: ${cleanSlug}`)
      form.status = 'closed'
      form.closed_at = now()
      form.updated_at = now()
      saveLocal(db)
    },

    async openDecisionForm(slug) {
      const db = loadLocal()
      const cleanSlug = slug.trim()
      const form = (db.decisionForms || []).find((f) => f.slug === cleanSlug)
      if (!form) throw new Error(`表单不存在: ${cleanSlug}`)
      form.status = 'open'
      form.closed_at = null
      form.updated_at = now()
      saveLocal(db)
    },
  }
}

// ---------------- Supabase 存储（service role） ----------------

function createSupabaseStore(env) {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  return {
    mode: 'supabase',
    async listTasks() {
      const { data, error } = await client.from('tasks').select('*').order('created_at', { ascending: false })
      if (error) throw new Error(error.message)
      return data ?? []
    },
    async getTask(id) {
      const { data, error } = await client.from('tasks').select('*').eq('id', id).maybeSingle()
      if (error) throw new Error(error.message)
      return data ?? null
    },
    async listUpdates(taskId) {
      const { data, error } = await client
        .from('task_updates')
        .select('*')
        .eq('task_id', taskId)
        .order('created_at', { ascending: true })
      if (error) throw new Error(error.message)
      return data ?? []
    },
    async listAllUpdates() {
      const { data, error } = await client
        .from('task_updates')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) throw new Error(error.message)
      return data ?? []
    },
    async createTask(input) {
      const { data, error } = await client.from('tasks').insert(input).select().single()
      if (error) throw new Error(error.message)
      return data
    },
    async updateTask(id, patch) {
      const { data, error } = await client
        .from('tasks')
        .update({ ...patch, updated_at: now() })
        .eq('id', id)
        .select()
        .single()
      if (error) throw new Error(error.message)
      return data
    },
    async addUpdate(input) {
      const payload = {
        task_id: input.task_id,
        type: input.type,
        content: input.content,
        old_expected_end_date: input.old_expected_end_date ?? null,
        new_expected_end_date: input.new_expected_end_date ?? null,
        created_by: input.created_by ?? 'agent',
        notify_mode: input.notify_mode ?? 'immediate',
      }
      if (input.merge_key) payload.merge_key = input.merge_key
      if (input.created_at) payload.created_at = input.created_at
      const { data, error } = await client.from('task_updates').insert(payload).select().single()
      if (error) throw new Error(error.message)
      return data
    },

    /**
     * 原子更新：通过数据库 RPC（apply_task_update，事务内 UPDATE + INSERT 时间线）。
     */
    async applyTaskUpdate(taskId, patch, update) {
      const { data, error } = await client.rpc('apply_task_update', {
        p_task_id: taskId,
        p_patch: patch,
        p_type: update.type,
        p_content: update.content,
        p_old_date: update.old_expected_end_date ?? null,
        p_new_date: update.new_expected_end_date ?? null,
        p_created_by: update.created_by ?? 'agent',
        p_notify_mode: update.notify_mode ?? 'immediate',
        p_merge_key: update.merge_key ?? null,
      })
      if (error) throw new Error(error.message)
      return data
    },
    async flushMerge(mergeKey) {
      if (!mergeKey) return 0
      const { data, error } = await client.rpc('flush_merge', { p_merge_key: mergeKey })
      if (error) throw new Error(error.message)
      return data ?? 0
    },
    async deleteTask(id) {
      const { error } = await client.from('tasks').delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
    /**
     * 原子创建：通过 RPC create_task_with_note（任务 + 初始时间线 同事务）。
     */

    // ---- 日粒度计划（任务三）----
    async listPlanBlocks(opts) {
      const db = loadLocal()
      return db.planBlocks
        .filter((b) => {
          if (opts?.taskId && b.task_id !== opts.taskId) return false
          if (opts?.from && b.end_date < opts.from) return false
          if (opts?.to && b.start_date > opts.to) return false
          return true
        })
        .sort((a, b) => a.start_date.localeCompare(b.start_date))
    },
    async listPlanBlockChanges(blockId) {
      return loadLocal().planBlockChanges
        .filter((c) => c.block_id === blockId)
        .sort((a, b) => a.changed_at.localeCompare(b.changed_at))
    },
    async createPlanBlock(input) {
      const db = loadLocal()
      if (!db.tasks.some((t) => t.id === input.task_id)) throw new Error(`任务不存在: ${input.task_id}`)
      if (input.end_date < input.start_date) throw new Error('结束日期不得早于开始日期')
      const block = {
        id: crypto.randomUUID(),
        task_id: input.task_id,
        start_date: input.start_date,
        end_date: input.end_date,
        summary: input.summary ?? '',
        status: input.status ?? 'planned',
        created_at: now(),
        updated_at: now(),
        created_by: input.created_by ?? '',
      }
      db.planBlocks.push(block)
      saveLocal(db)
      return block
    },
    async movePlanBlock(blockId, patch, note, by) {
      const db = loadLocal()
      const block = db.planBlocks.find((b) => b.id === blockId)
      if (!block) throw new Error(`计划块不存在: ${blockId}`)
      const newStart = patch.start_date ?? block.start_date
      const newEnd = patch.end_date ?? block.end_date
      if (newEnd < newStart) throw new Error('结束日期不得早于开始日期')
      db.planBlockChanges.push({
        id: crypto.randomUUID(), block_id: blockId,
        old_start_date: block.start_date, old_end_date: block.end_date, old_status: block.status,
        new_start_date: newStart, new_end_date: newEnd, new_status: 'changed',
        note, changed_at: now(), changed_by: by,
      })
      Object.assign(block, { start_date: newStart, end_date: newEnd, status: 'changed', updated_at: now() })
      saveLocal(db)
      return block
    },
    async donePlanBlock(blockId, note, by) {
      const db = loadLocal()
      const block = db.planBlocks.find((b) => b.id === blockId)
      if (!block) throw new Error(`计划块不存在: ${blockId}`)
      db.planBlockChanges.push({
        id: crypto.randomUUID(), block_id: blockId,
        old_start_date: block.start_date, old_end_date: block.end_date, old_status: block.status,
        new_start_date: block.start_date, new_end_date: block.end_date, new_status: 'done',
        note, changed_at: now(), changed_by: by,
      })
      block.status = 'done'; block.updated_at = now()
      saveLocal(db)
      return block
    },
    // ---- 日粒度计划（任务三，RPC）----
    async listPlanBlocks(opts) {
      let query = client.from('task_plan_blocks').select('*')
      if (opts?.taskId) query = query.eq('task_id', opts.taskId)
      if (opts?.from) query = query.gte('end_date', opts.from)
      if (opts?.to) query = query.lte('start_date', opts.to)
      const { data, error } = await query.order('start_date', { ascending: true })
      if (error) throw new Error(error.message)
      return data ?? []
    },
    async listPlanBlockChanges(blockId) {
      const { data, error } = await client.from('task_plan_block_changes').select('*').eq('block_id', blockId).order('changed_at', { ascending: true })
      if (error) throw new Error(error.message)
      return data ?? []
    },
    async createPlanBlock(input) {
      const { data, error } = await client.rpc('create_plan_block', {
        p_task_id: input.task_id, p_start_date: input.start_date, p_end_date: input.end_date,
        p_summary: input.summary ?? '', p_status: input.status ?? 'planned', p_created_by: input.created_by ?? '',
      })
      if (error) throw new Error(error.message)
      return data
    },
    async movePlanBlock(blockId, patch, note, by) {
      const { data, error } = await client.rpc('move_plan_block', {
        p_block_id: blockId, p_start_date: patch.start_date ?? null, p_end_date: patch.end_date ?? null,
        p_note: note, p_by: by,
      })
      if (error) throw new Error(error.message)
      return data
    },
    async donePlanBlock(blockId, note, by) {
      const { data, error } = await client.rpc('done_plan_block', {
        p_block_id: blockId, p_note: note, p_by: by,
      })
      if (error) throw new Error(error.message)
      return data
    },
    async applyCreate(input, note, createdBy = 'agent') {
      const { data, error } = await client.rpc('create_task_with_note', {
        p_title: input.title,
        p_patch: input,
        p_content: note ?? '任务创建。',
        p_created_by: createdBy,
      })
      if (error) throw new Error(error.message)
      return data
    },
    async seed(tasks, updates, force) {
      const { count } = await client.from('tasks').select('*', { count: 'exact', head: true })
      if ((count ?? 0) > 0 && !force) {
        throw new Error('线上库已有任务；如需覆盖请加 --force（会按 id upsert）')
      }
      if (force) {
        for (const t of tasks) {
          const { error } = await client.from('tasks').upsert(t, { onConflict: 'id' })
          if (error) throw new Error(error.message)
        }
      } else {
        const { error } = await client.from('tasks').insert(tasks)
        if (error) throw new Error(error.message)
      }
      for (const u of updates) {
        const { error } = await client.from('task_updates').upsert(u, { onConflict: 'id' })
        if (error) throw new Error(error.message)
      }
    },

    // ---- 决策中心 ----
    async listDecisionForms() {
      const { data: forms, error: formsErr } = await client
        .from('decision_forms')
        .select('*, decision_questions(count), decision_responses(count)')
        .order('created_at', { ascending: false })

      if (formsErr) throw new Error(formsErr.message)

      return (forms ?? []).map((f) => ({
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
      }))
    },

    async getDecisionFormBySlug(slug) {
      const cleanSlug = slug.trim()
      const { data: form, error: formErr } = await client
        .from('decision_forms')
        .select('*')
        .eq('slug', cleanSlug)
        .maybeSingle()

      if (formErr) throw new Error(formErr.message)
      if (!form) return null

      const { data: questions, error: qErr } = await client
        .from('decision_questions')
        .select('*')
        .eq('form_id', form.id)
        .order('sort_order', { ascending: true })

      if (qErr) throw new Error(qErr.message)

      const qIds = (questions ?? []).map((q) => q.id)
      let options = []
      if (qIds.length > 0) {
        const { data: opts, error: optErr } = await client
          .from('decision_options')
          .select('*')
          .in('question_id', qIds)
          .order('sort_order', { ascending: true })
        if (optErr) throw new Error(optErr.message)
        options = opts ?? []
      }

      const optionsByQId = new Map()
      const optionById = new Map()
      for (const opt of options) {
        if (!optionsByQId.has(opt.question_id)) {
          optionsByQId.set(opt.question_id, [])
        }
        optionsByQId.get(opt.question_id).push(opt)
        optionById.set(opt.id, opt)
      }

      const formattedQuestions = (questions ?? []).map((q) => {
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

      const { data: responses, error: rErr } = await client
        .from('decision_responses')
        .select('*')
        .eq('form_id', form.id)
        .order('submitted_at', { ascending: false })

      if (rErr) throw new Error(rErr.message)

      const rIds = (responses ?? []).map((r) => r.id)
      let answers = []
      if (rIds.length > 0) {
        const { data: ansList, error: ansErr } = await client
          .from('decision_answers')
          .select('*')
          .in('response_id', rIds)
        if (ansErr) throw new Error(ansErr.message)
        answers = ansList ?? []
      }

      const answersByRId = new Map()
      for (const ans of answers) {
        if (!answersByRId.has(ans.response_id)) {
          answersByRId.set(ans.response_id, [])
        }
        answersByRId.get(ans.response_id).push(ans)
      }

      const formattedResponses = (responses ?? []).map((r) => ({
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
      }
    },

    async createDecisionForm(payload) {
      const { data, error } = await client.rpc('create_decision_form', {
        p_payload: payload,
      })
      if (error) throw new Error(error.message)
      return data
    },

    async submitDecisionResponse(slug, respondentName, answers, respondentNote) {
      const { data, error } = await client.rpc('submit_decision_response', {
        p_form_slug: slug,
        p_respondent_name: respondentName,
        p_answers: answers,
        p_respondent_note: respondentNote ?? '',
      })
      if (error) throw new Error(error.message)
      return data
    },

    async closeDecisionForm(slug) {
      const { error } = await client.rpc('close_decision_form', {
        p_slug: slug,
      })
      if (error) throw new Error(error.message)
    },

    async openDecisionForm(slug) {
      const { error } = await client.rpc('open_decision_form', {
        p_slug: slug,
      })
      if (error) throw new Error(error.message)
    },
  }
}
