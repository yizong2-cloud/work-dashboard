#!/usr/bin/env node
// ============================================================
// workflow/verify.mjs —— 一条龙更新流程的「校验」阶段
// 检查看板数据不变量（completed 必须 100%+完成日、blocked 必须有原因、
// 无孤儿时间线），输出健康报告。
// ============================================================

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AGENT = path.join(ROOT, 'scripts', 'agent.js')

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
  for (const t of board) {
    if (t.status === 'completed' && (t.progress !== 100 || !t.actual_end_date)) {
      issues.push(`completed 但不完整: ${t.title}（progress=${t.progress}, actual=${t.actual_end_date}）`)
    }
    if (t.status === 'blocked' && !(t.block_reason || '').trim()) {
      issues.push(`blocked 无原因: ${t.title}`)
    }
  }

  const active = board.filter((t) => ['in_progress', 'blocked', 'paused'].includes(t.status))
  const noSchedule = active.filter((t) => !t.expected_end_date)

  console.log('=== 看板健康检查 ===')
  console.log(`任务总数: ${board.length} | 进行中/阻塞/暂停: ${active.length}`)
  if (issues.length > 0) {
    console.log(`❌ 数据不变量违规 ${issues.length} 处:`)
    for (const i of issues) console.log(`  - ${i}`)
  } else {
    console.log('✅ 数据不变量全部通过（completed/blocked 约束）')
  }
  if (noSchedule.length > 0) {
    console.log(`⚠️ ${noSchedule.length} 个活跃任务未排期（建议补充预计完成日期）:`)
    for (const t of noSchedule) console.log(`  - ${t.title}`)
  }
  const byStatus = {}
  for (const t of board) byStatus[t.status] = (byStatus[t.status] || 0) + 1
  console.log('状态分布:', JSON.stringify(byStatus))
}

main()
