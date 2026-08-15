// ============================================================
// 本地模式数据层（浏览器 localStorage）
// 用途：Supabase 未配置时演示看板；不依赖网络。
// ============================================================

import type { DB } from './db'
import { newId } from './db'
import type { Task, TaskUpdate } from '../types'
import { buildSeed } from './seedData'

const STORE_KEY = 'work-dashboard:db:v1'

interface LocalStore {
  tasks: Task[]
  updates: TaskUpdate[]
}

function load(): LocalStore {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as LocalStore
      if (parsed && Array.isArray(parsed.tasks) && Array.isArray(parsed.updates)) return parsed
    }
  } catch {
    // 数据损坏则重建
  }
  const seed = buildSeed()
  save(seed)
  return seed
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

    async deleteTask(id) {
      const store = load()
      store.tasks = store.tasks.filter((t) => t.id !== id)
      store.updates = store.updates.filter((u) => u.task_id !== id)
      save(store)
    },
  }
}
