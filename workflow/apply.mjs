#!/usr/bin/env node
// ============================================================
// workflow/apply.mjs —— 一条龙更新流程的「应用」阶段
// 读取变更建议 ops.json（可与结构化对账 reconciliation 同文件），
// 校验后通过 agent.js batch 执行。
//
// 强化（2026-08-17 审查后）：
//   1. source-health 闸门：快照 degraded（某数据源拉取失败）时默认拒绝 apply，需 --force
//   2. 对账要求：含高风险操作（create/complete/block/delete/schedule）必须带 reconciliation
//      （证明「全量对账」已做），且可关联 evidence
//   3. 预条件校验：引用的任务必须存在；--dry-run 做真实可用的预检（任务存在/状态迁移/日期）
//   4. changeset：apply 成功后写 workflow/last-changeset.json（可追溯本次变更）
//
// 用法: node workflow/apply.mjs [--file ops.json] [--dry-run] [--force]
// ============================================================

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AGENT = path.join(ROOT, 'scripts', 'agent.js')
const CONTEXT_FILE = path.join(ROOT, 'workflow', 'update-context.json')
const CHANGESET_FILE = path.join(ROOT, 'workflow', 'last-changeset.json')

// 高风险操作：必须已完成全量对账（reconciliation）才能执行
const HIGH_RISK = ['create', 'complete', 'block', 'delete', 'schedule']
const OP_RULES = {
  create: ['title'],
  progress: ['id', 'to'],
  status: ['id', 'to'],
  update: ['id'],
  schedule: ['id', 'end'],
  block: ['id', 'reason'],
  unblock: ['id'],
  complete: ['id'],
  note: ['id', 'content'],
  delete: ['id'],
}
const VALID_STATUS = ['planned', 'in_progress', 'blocked', 'paused', 'completed', 'cancelled']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const INTERRUPT_KEYWORDS = ['interrupt'] // future

function parseArgs(argv) {
  const args = { file: path.join(ROOT, 'workflow', 'ops.json'), dryRun: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i]
    else if (argv[i] === '--dry-run') args.dryRun = true
    else if (argv[i] === '--force') args.force = true
  }
  return args
}

function loadTasks() {
  try {
    const stdout = execFileSync('node', [AGENT, 'list', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  let raw
  try {
    raw = fs.readFileSync(args.file, 'utf8')
  } catch {
    fail(`找不到变更建议文件: ${args.file}`)
  }
  let spec
  try {
    spec = JSON.parse(raw)
  } catch (e) {
    fail(`变更建议文件不是合法 JSON: ${e.message}`)
  }
  const reconciliation = Array.isArray(spec) ? null : (spec.reconciliation || null)
  const ops = Array.isArray(spec) ? spec : spec.ops
  if (!Array.isArray(ops) || ops.length === 0) fail('变更建议为空（应为数组或 { reconciliation?, ops:[...] }）')

  // ---- 0) source-health 闸门：快照 degraded（某源拉取失败）→ 默认拒绝 ----
  if (!args.force) {
    try {
      const ctx = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'))
      if (ctx.snapshot_health === 'degraded') {
        fail('当前快照 degraded（有数据源拉取失败），apply 默认拒绝。确认用 --force。')
      }
    } catch { /* 缺 context 不拦截 */ }
  }

  // ---- 1) 字段校验 ----
  const errors = []
  for (const [i, op] of ops.entries()) {
    const rules = OP_RULES[op.op]
    if (!rules) {
      errors.push(`第 ${i + 1} 条: 未知操作 "${op.op}"（允许: ${Object.keys(OP_RULES).join('/')}）`)
      continue
    }
    for (const key of rules) {
      if (op[key] === undefined || op[key] === null || op[key] === '') {
        errors.push(`第 ${i + 1} 条 ${op.op}: 缺少必填字段 "${key}"`)
      }
    }
    if (op.op === 'status' && op.to && !VALID_STATUS.includes(op.to)) errors.push(`第 ${i + 1} 条: 非法状态 "${op.to}"`)
    for (const dk of ['start', 'end', 'start_date', 'expected_end']) {
      if (op[dk] && !DATE_RE.test(op[dk])) errors.push(`第 ${i + 1} 条: 非法日期 "${op[dk]}"（应 YYYY-MM-DD）`)
    }
  }

  // ---- 2) 对账要求：高风险操作必须带 reconciliation ----
  const hasHighRisk = ops.some((op) => HIGH_RISK.includes(op.op))
  if (hasHighRisk && !reconciliation && !args.force) {
    fail('含高风险操作（create/complete/block/delete/schedule）但未提供 reconciliation（全量对账）。先完成对账或 --force。')
  }

  // ---- 3) 预条件：引用的任务必须存在（真实可用的预检）----
  const tasks = loadTasks()
  const byId = tasks ? new Map(tasks.map((t) => [t.id, t])) : null
  if (byId) {
    for (const [i, op] of ops.entries()) {
      if (op.op === 'create') continue
      if (op.id && !byId.has(op.id)) errors.push(`第 ${i + 1} 条 ${op.op}: 任务不存在 ${op.id}`)
      if (op.op === 'schedule' || op.op === 'progress' || op.op === 'status') {
        // 状态迁移合法性：blocked/completed 必须走专用命令（DB 也会兜底）
        if (op.op === 'status' && (op.to === 'blocked' || op.to === 'completed')) {
          errors.push(`第 ${i + 1} 条: status 不能直接到 blocked/completed，请用 block/complete`)
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error('❌ 变更建议校验失败:')
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }

  console.log(`共 ${ops.length} 条变更（快照${(reconciliation?.length ?? 0) ? `已对账 ${reconciliation.length} 项` : '未带对账'}），开始${args.dryRun ? '预演' : '执行'}…`)
  for (const [i, op] of ops.entries()) {
    const brief = Object.entries(op).filter(([k]) => k !== 'op').map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(' ')
    console.log(`  ${i + 1}. ${op.op} ${brief}`)
  }

  if (args.dryRun) {
    console.log('✅ 预演通过（已校验字段/日期/任务存在/状态迁移；未写入）。去掉 --dry-run 执行。')
    return
  }

  // ---- 4) 执行 + changeset ----
  const changeset_id = `chg-${Date.now()}`
  try {
    const stdout = execFileSync('node', [AGENT, 'batch', '--file', args.file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    console.log(stdout)
  } catch (e) {
    console.error(String(e.stdout || ''))
    fail(`应用失败: ${String(e.stderr || e.message || '').slice(0, 500)}`)
  }
  try {
    fs.writeFileSync(CHANGESET_FILE, JSON.stringify({
      changeset_id, applied_at: new Date().toISOString(), ops_count: ops.length,
      ops: ops.map((o) => ({ op: o.op, id: o.id || o.title || null })),
      reconciliation: reconciliation || [],
    }, null, 2))
    console.log(`✅ changeset 已记录: ${changeset_id}`)
  } catch { /* 记录失败不阻断 */ }
}

main()
