#!/usr/bin/env node
// A read-only stewardship pass for the Agent-maintained Workboard.
// It deliberately diagnoses data hygiene; it never guesses a progress update
// or writes task fields. Semantic changes must still pass through the update
// evidence + owner confirmation workflow.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEnv } from '../scripts/lib/env.js'
import { createStore } from '../scripts/lib/store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ACTIVE_STATUSES = new Set(['planned', 'in_progress', 'blocked', 'paused'])
const STALE_AFTER_DAYS = 7

function dayStart(iso) {
  const value = new Date(iso || 0)
  if (Number.isNaN(value.getTime())) return null
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())
}

function daysBetween(from, to) {
  const start = dayStart(from)
  const end = dayStart(to)
  if (start === null || end === null) return null
  return Math.floor((end - start) / 86_400_000)
}

function localDate(now) {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function normaliseTitle(title) {
  return String(title || '').normalize('NFKC').toLowerCase().replace(/[\s\-_—–：:（）()【】\[\]]/g, '')
}

function taskRef(task) {
  return { id: task.id, title: task.title, status: task.status, priority: task.priority }
}

function byTitle(left, right) {
  return String(left.title || '').localeCompare(String(right.title || ''), 'zh-CN')
}

/**
 * Turn raw board data into an actionable, non-mutating maintenance queue.
 * Exported separately so the policy has a small, deterministic test surface.
 */
export function buildStewardshipReport({ tasks = [], updates = [], planBlocks = [], instructions = [], now = new Date() }) {
  const today = localDate(now)
  const active = tasks.filter((task) => ACTIVE_STATUSES.has(task.status))
  const taskIds = new Set(tasks.map((task) => task.id))
  const activeBlocks = planBlocks.filter((block) => block.status !== 'done')
  const upcomingLimit = new Date(now)
  upcomingLimit.setDate(upcomingLimit.getDate() + 7)
  const upcomingEnd = localDate(upcomingLimit)

  const stale = active
    .map((task) => ({ ...taskRef(task), days_since_update: daysBetween(task.updated_at, now) }))
    .filter((task) => task.days_since_update === null || task.days_since_update >= STALE_AFTER_DAYS)
    .sort((a, b) => (b.days_since_update ?? Infinity) - (a.days_since_update ?? Infinity) || byTitle(a, b))
  const missingCurrentStatus = active
    .filter((task) => !String(task.current_status || '').trim())
    .map(taskRef)
    .sort(byTitle)
  const missingSchedule = active
    .filter((task) => !task.expected_end_date)
    .map(taskRef)
    .sort(byTitle)
  const overdue = active
    .filter((task) => task.expected_end_date && task.expected_end_date < today)
    .map((task) => ({ ...taskRef(task), expected_end_date: task.expected_end_date }))
    .sort((a, b) => a.expected_end_date.localeCompare(b.expected_end_date) || byTitle(a, b))
  const upcomingWithoutPlan = active
    .filter((task) => task.expected_end_date && task.expected_end_date >= today && task.expected_end_date <= upcomingEnd)
    .filter((task) => !activeBlocks.some((block) => block.task_id === task.id && block.start_date <= task.expected_end_date && block.end_date >= today))
    .map((task) => ({ ...taskRef(task), expected_end_date: task.expected_end_date }))
    .sort((a, b) => a.expected_end_date.localeCompare(b.expected_end_date) || byTitle(a, b))
  const completedInconsistent = tasks
    .filter((task) => task.status === 'completed' && (Number(task.progress) !== 100 || !task.actual_end_date))
    .map((task) => ({ ...taskRef(task), progress: task.progress, actual_end_date: task.actual_end_date || null }))
    .sort(byTitle)
  const orphanUpdates = updates
    .filter((update) => !taskIds.has(update.task_id))
    .map((update) => ({ id: update.id, task_id: update.task_id, type: update.type, created_at: update.created_at }))
  const duplicateGroups = [...tasks
    .filter((task) => task.status !== 'cancelled')
    .reduce((groups, task) => {
      const key = normaliseTitle(task.title)
      if (!key) return groups
      const list = groups.get(key) || []
      list.push(taskRef(task))
      groups.set(key, list)
      return groups
    }, new Map())
    .values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort(byTitle))

  const openInstructions = instructions
    .filter((thread) => thread.status !== 'resolved')
    .map((thread) => ({ id: thread.id, task_id: thread.task_id, status: thread.status, updated_at: thread.updated_at, message: thread.latest_message || '' }))

  const queues = {
    agent_inbox: openInstructions,
    overdue,
    stale,
    missing_current_status: missingCurrentStatus,
    missing_schedule: missingSchedule,
    upcoming_without_plan: upcomingWithoutPlan,
    completed_inconsistent: completedInconsistent,
    duplicate_candidates: duplicateGroups,
    orphan_updates: orphanUpdates,
  }
  const counts = Object.fromEntries(Object.entries(queues).map(([key, value]) => [key, value.length]))
  const recommendations = [
    openInstructions.length && { kind: 'handle_inbox', count: openInstructions.length, action: '先逐条读取并回写处理状态；原文是 Agent 的工作单，不可静默忽略。' },
    overdue.length && { kind: 'verify_overdue', count: overdue.length, action: '从最新证据核实真实进度或重排期；不要仅因日期过期自动延期。' },
    stale.length && { kind: 'refresh_stale', count: stale.length, action: '寻找最近工作证据；没有证据时询问负责人，而不是编造进度。' },
    missingCurrentStatus.length && { kind: 'enrich_status', count: missingCurrentStatus.length, action: '可根据已核验证据补一句话现状；无证据则保留为空并标为待确认。' },
    missingSchedule.length && { kind: 'schedule_gap', count: missingSchedule.length, action: '优先补完成预期，不得自行捏造日期。' },
    upcomingWithoutPlan.length && { kind: 'plan_week', count: upcomingWithoutPlan.length, action: '提示安排具体日计划；由用户或已确认的任务意图触发写入。' },
    completedInconsistent.length && { kind: 'repair_invariant', count: completedInconsistent.length, action: '这是数据不变量异常：先查历史，再按事实用专用完成命令修复。' },
    duplicateGroups.length && { kind: 'confirm_duplicate', count: duplicateGroups.length, action: '只提示精确标题重复；合并或删除必须先确认，绝不自动执行。' },
    orphanUpdates.length && { kind: 'repair_orphan', count: orphanUpdates.length, action: '检查历史数据或数据库完整性；禁止通过删除记录来掩盖问题。' },
  ].filter(Boolean)

  return {
    generated_at: new Date(now).toISOString(),
    mode: 'read_only',
    policy: '报告只发现治理工作，不会改写任务、合并任务、删除记录或发送通知。',
    summary: {
      tasks: tasks.length,
      active_tasks: active.length,
      open_governance_items: Object.values(counts).reduce((total, count) => total + count, 0),
    },
    counts,
    queues,
    recommendations,
  }
}

export function formatStewardshipReport(report) {
  const labels = {
    agent_inbox: '处理箱', overdue: '逾期需核实', stale: '长期未更新',
    missing_current_status: '缺一句话现状', missing_schedule: '未设完成预期',
    upcoming_without_plan: '近期到期但未拆日计划', completed_inconsistent: '完成状态不一致',
    duplicate_candidates: '精确重复候选', orphan_updates: '孤儿时间线',
  }
  const lines = ['Workboard Agent 治理体检（只读）', `任务：${report.summary.tasks} · 活跃：${report.summary.active_tasks}`]
  for (const [key, count] of Object.entries(report.counts)) lines.push(`${labels[key]}：${count}`)
  if (report.recommendations.length === 0) lines.push('结论：当前没有需要 Agent 主动整理的治理信号。')
  else {
    lines.push('建议顺序：')
    for (const recommendation of report.recommendations) lines.push(`- ${recommendation.action}`)
  }
  lines.push('安全边界：先用证据确认事实；任何写入仍走结构化命令和用户确认。')
  return lines.join('\n')
}

export async function collectStewardship(store) {
  const [tasks, updates, instructions, planBlocks] = await Promise.all([
    store.listTasks(),
    store.listAllUpdates(),
    store.listAllFeedbackThreads('agent_instruction'),
    store.listPlanBlocks({}),
  ])
  return buildStewardshipReport({ tasks, updates, instructions, planBlocks })
}

export async function main(argv = process.argv.slice(2), store = createStore(loadEnv())) {
  const report = await collectStewardship(store)
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : formatStewardshipReport(report))
  return report
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(`治理体检失败：${error.message}`)
    process.exitCode = 1
  })
}
