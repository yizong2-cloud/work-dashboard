// ============================================================
// 本地模式数据层（浏览器 localStorage）
// 用途：Supabase 未配置时演示看板；不依赖网络。
// ============================================================

import type { DB } from './db'
import { newId } from './db'
import type { FeedbackMessage, FeedbackThread, Task, TaskUpdate } from '../types'
import { buildSeed } from './seedData'
const STORE_KEY = 'work-dashboard:db:v1'

interface LocalStore {
  tasks: Task[]
  updates: TaskUpdate[]
  feedbackThreads: FeedbackThread[]
  feedbackMessages: FeedbackMessage[]
}

function load(): LocalStore {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as LocalStore
      if (parsed && Array.isArray(parsed.tasks) && Array.isArray(parsed.updates)) {
        // 兼容旧结构（无反馈字段时初始化）
        return {
          ...parsed,
          feedbackThreads: parsed.feedbackThreads ?? [],
          feedbackMessages: parsed.feedbackMessages ?? [],
        }
      }
    }
  } catch {
    // 数据损坏则重建
  }
  const seed = buildSeed()
  const fresh: LocalStore = { ...seed, feedbackThreads: [], feedbackMessages: [] }
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

    async listFeedbackThreads(taskId) {
      const store = load()
      return store.feedbackThreads
        .filter((t) => t.task_id === taskId)
        .map((t) => enrichThread(t, store))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    },

    async listAllFeedbackThreads() {
      const store = load()
      return store.feedbackThreads
        .map((t) => enrichThread(t, store))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    },

    async listFeedbackMessages(threadId) {
      return load()
        .feedbackMessages.filter((m) => m.thread_id === threadId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
    },

    async createFeedbackThread(taskId, body, authorName, authorRole) {
      if (!body || !body.trim()) throw new Error('反馈内容不能为空')
      const store = load()
      if (!store.tasks.some((t) => t.id === taskId)) throw new Error(`任务不存在: ${taskId}`)
      const thread: FeedbackThread = {
        id: newId('ft'),
        task_id: taskId,
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
