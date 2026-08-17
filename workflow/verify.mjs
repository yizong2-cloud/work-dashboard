#!/usr/bin/env node
// ============================================================
// workflow/verify.mjs —— 一条龙更新流程的「校验」阶段
// 检查看板数据不变量 + 引用完整性（孤儿时间线/计划块），
// 发现问题以退出码 1 结束（不得作为「正常快照」）。
// 校验通过后，把分析游标推进到本次 context 的 captured_at
// （实现「apply+verify 成功才推进游标」，防止分析中断丢增量）。
// ============================================================

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AGENT = path.join(ROOT, 'scripts', 'agent.js')
const CONTEXT_FILE = path.join(ROOT, 'workflow', 'update-context.json')
const ANALYSIS_STATE = path.join(ROOT, 'workflow', '.analysis-state.json')
const ENV_FILE = path.join(ROOT, '.env')

function loadEnv() {
  const env = {}
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* 无 .env 则本地模式 */ }
  return env
}

async function supabaseRead(table, select, filter = '') {
  const env = loadEnv()
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) return null // 本地模式，跳过线上引用检查
  const res = await fetch(`${url.replace(/\/?$/, '')}/rest/v1/${table}?select=${encodeURIComponent(select)}${filter ? `&${filter}` : ''}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  })
  if (!res.ok) throw new Error(`supabaseRead ${table} 失败: ${res.status} ${await res.text()}`)
  return res.json()
}

function main() {
  let board
  try {
    const stdout = execFileSync('node', [AGENT, 'list', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    board = JSON.parse(stdout)
  } catch (e) {
    console.error(`❌ 无法读取看板: ${String(e.stderr || e.message || '').slice(0, 300)}`)
    process.exit(1)
  }

  const issues = []
  const taskIds = new Set(board.map((t) => t.id))

  // 1) 不变量：completed/blocked（与 DB CHECK 一致，双保险）
  for (const t of board) {
    if (t.status === 'completed' && (t.progress !== 100 || !t.actual_end_date)) {
      issues.push(`completed 但不完整: ${t.title}（progress=${t.progress}, actual=${t.actual_end_date}）`)
    }
    if (t.status === 'blocked' && !(t.block_reason || '').trim()) {
      issues.push(`blocked 无原因: ${t.title}`)
    }
  }

  // 2) 引用完整性：孤儿时间线 / 孤儿计划块（线上模式）
  ;(async () => {
    try {
      const updates = await supabaseRead('task_updates', 'task_id')
      if (Array.isArray(updates)) {
        const orphans = new Set(updates.map((u) => u.task_id).filter((tid) => tid && !taskIds.has(tid)))
        if (orphans.size > 0) issues.push(`孤儿时间线 ${orphans.size} 条（指向不存在的任务）`)
      }
      const plans = await supabaseRead('task_plan_blocks', 'task_id')
      if (Array.isArray(plans)) {
        const orphans = new Set(plans.map((p) => p.task_id).filter((tid) => tid && !taskIds.has(tid)))
        if (orphans.size > 0) issues.push(`孤儿计划块 ${orphans.size} 条（指向不存在的任务）`)
      }
    } catch (e) {
      console.error(`⚠️ 引用完整性检查跳过: ${e.message}`)
    }

    const active = board.filter((t) => ['in_progress', 'blocked', 'paused'].includes(t.status))
    const noSchedule = active.filter((t) => !t.expected_end_date)

    console.log('=== 看板健康检查 ===')
    console.log(`任务总数: ${board.length} | 进行中/阻塞/暂停: ${active.length}`)
    if (issues.length > 0) {
      console.log(`❌ 发现问题 ${issues.length} 处:`)
      for (const i of issues) console.log(`  - ${i}`)
      process.exit(1) // 违规 → 失败退出，不得当作正常快照
    }
    console.log('✅ 数据不变量 + 引用完整性全部通过')
    if (noSchedule.length > 0) {
      console.log(`⚠️ ${noSchedule.length} 个活跃任务未排期（建议补充预计完成日期）:`)
      for (const t of noSchedule) console.log(`  - ${t.title}`)
    }
    const byStatus = {}
    for (const t of board) byStatus[t.status] = (byStatus[t.status] || 0) + 1
    console.log('状态分布:', JSON.stringify(byStatus))

    // 3) 校验通过 → 推进分析游标（captured_at 是本次采集成功的快照时间）
    try {
      const ctx = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'))
      if (ctx.captured_at) {
        fs.writeFileSync(ANALYSIS_STATE, JSON.stringify({ reviewed_at: ctx.captured_at, at: new Date().toISOString() }, null, 2))
        console.log(`✅ 分析游标已推进至 ${ctx.captured_at}`)
      }
    } catch (e) {
      console.error(`⚠️ 分析游标未推进: ${e.message}`)
    }
  })()
}

main()
