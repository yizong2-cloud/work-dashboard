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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LOCAL_FILE = process.env.LOCAL_DB_FILE || path.join(ROOT, 'data', 'local.json')

const now = () => new Date().toISOString()

export function createStore(env) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return createSupabaseStore(env)
  }
  return createLocalStore()
}

// ---------------- 本地 JSON 存储 ----------------

function loadLocal() {
  if (!fs.existsSync(LOCAL_FILE)) return { tasks: [], updates: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'))
    if (parsed && Array.isArray(parsed.tasks) && Array.isArray(parsed.updates)) return parsed
  } catch {
    // 损坏则重建
  }
  return { tasks: [], updates: [] }
}

function saveLocal(db) {
  fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true })
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(db, null, 2))
}

function createLocalStore() {
  return {
    mode: 'local',
    localFile: LOCAL_FILE,
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
      const update = {
        id: crypto.randomUUID(),
        task_id: input.task_id,
        type: input.type,
        content: input.content,
        old_expected_end_date: input.old_expected_end_date ?? null,
        new_expected_end_date: input.new_expected_end_date ?? null,
        created_at: now(),
        created_by: input.created_by ?? 'agent',
      }
      db.updates.push(update)
      saveLocal(db)
      return update
    },
    async deleteTask(id) {
      const db = loadLocal()
      db.tasks = db.tasks.filter((t) => t.id !== id)
      db.updates = db.updates.filter((u) => u.task_id !== id)
      saveLocal(db)
    },
    async seed(tasks, updates, force) {
      const db = loadLocal()
      if (db.tasks.length > 0 && !force) {
        throw new Error('本地数据非空；如需覆盖请加 --force')
      }
      saveLocal({ tasks, updates })
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
      const { data, error } = await client.from('task_updates').insert(input).select().single()
      if (error) throw new Error(error.message)
      return data
    },
    async deleteTask(id) {
      const { error } = await client.from('tasks').delete().eq('id', id)
      if (error) throw new Error(error.message)
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
  }
}
