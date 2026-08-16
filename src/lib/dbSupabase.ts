// ============================================================
// Supabase 数据层
// 使用前端 anon key 访问；数据库已配置「全开放」策略
// （无登录、无权限控制，见 supabase/schema.sql）。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { DB } from './db'
import type { FeedbackMessage, FeedbackThread, PlanBlock, PlanBlockChange, Task, TaskUpdate } from '../types'

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
  }
}
