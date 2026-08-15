// ============================================================
// Supabase 数据层
// 使用前端 anon key 访问；数据库已配置「全开放」策略
// （无登录、无权限控制，见 supabase/schema.sql）。
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { DB } from './db'
import type { Task, TaskUpdate } from '../types'

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

    async deleteTask(id) {
      const { error } = await client.from(TASKS).delete().eq('id', id)
      if (error) throw new Error(error.message)
    },
  }
}
