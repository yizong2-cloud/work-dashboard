#!/usr/bin/env node
// ============================================================
// workflow/apply.mjs —— 一条龙更新流程的「应用」阶段
// 读取变更建议 ops.json（可与结构化对账 reconciliation 同文件），
// 校验后通过 agent.js batch 执行。
//
// 强化（2026-08-17 审查后）：
//   1. source-health 闸门：快照 degraded（某数据源拉取失败）时拒绝 apply
//   2. 对账要求：当前审查包中的每个 source_id 都必须有且仅有一个 reconciliation
//      （机器证明「全量对账」已做），且可关联 evidence
//   3. 预条件校验：引用的任务必须存在；--dry-run 做真实可用的预检（任务存在/状态迁移/日期）
//   4. changeset：apply 成功后写 workflow/last-changeset.json（可追溯本次变更）
//
// 用法: node workflow/apply.mjs [--file ops.json] [--dry-run]
// ============================================================

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { approvalMatchesSpec, consumeApproval, DEFAULT_APPROVAL_FILE, markPreviewApplied } from './publish.mjs'
import { reconciliationTaskIds, summarizeReconciliation, validateReviewSpec } from './review-packet.mjs'
import { notificationIntentFor, summarizeNotificationIntents } from './operation-intent.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AGENT = path.join(ROOT, 'scripts', 'agent.js')
const CONTEXT_FILE = path.join(ROOT, 'workflow', 'update-context.json')
const REVIEW_PACKET_FILE = path.join(ROOT, 'workflow', 'review-packet.json')
const CHANGESET_FILE = path.join(ROOT, 'workflow', 'last-changeset.json')

const OP_RULES = {
  create: ['title'],
  progress: ['id', 'to'],
  status: ['id', 'to'],
  update: ['id'],
  schedule: ['id', 'end'],
  block: ['id', 'reason'],
  unblock: ['id'],
  complete: ['id'],
  reopen: ['id', 'to'],
  note: ['id', 'content'],
}
const VALID_STATUS = ['planned', 'in_progress', 'blocked', 'paused', 'completed', 'cancelled']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const INTERRUPT_KEYWORDS = ['interrupt'] // future
const PROGRESS_PERCENT_CLAIM = /(?:进度|完成度)\s*(?:(?:更新|提升|降低|升高)(?:至|到)?|降(?:至|到)|变为|为|到)?\s*[:：]?\s*(\d{1,3})\s*%/
const PROGRESS_BASES = ['user_explicit', 'milestone_ratio', 'agent_estimate']
const AGENT_ESTIMATE_ANCHORS = new Set([0, 10, 25, 50, 70, 85, 95])
const NOTIFY_MODES = ['immediate', 'merge', 'silent']

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

// Keep notification semantics visible at the workflow seam. This is an intent
// summary, not a claim that Feishu has already delivered the outbox event.
function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.force) fail('不再支持 --force 绕过来源健康或人工确认闸门')
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
  if (!Array.isArray(ops)) fail('ops 必须是数组（允许空数组：表示已全量审查、无需写入）')

  let snapshot = {}
  let reviewPacket = null
  try { snapshot = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8')) } catch { /* 下方按需拦截 */ }
  try { reviewPacket = JSON.parse(fs.readFileSync(REVIEW_PACKET_FILE, 'utf8')) } catch { /* 下方按需拦截 */ }

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
    if (op.op === 'progress' || op.op === 'reopen') {
      const progress = Number(op.to)
      if (!Number.isInteger(progress) || progress < 0 || progress > (op.op === 'reopen' ? 99 : 100)) {
        errors.push(`第 ${i + 1} 条 ${op.op}: to 必须是 0-${op.op === 'reopen' ? 99 : 100} 整数`)
      }
      if (!String(op.note ?? op.content ?? '').trim()) {
        errors.push(`第 ${i + 1} 条 ${op.op}: 必须提供 note 或 content 说明依据`)
      }
      if (!PROGRESS_BASES.includes(op.progress_basis)) {
        errors.push(`第 ${i + 1} 条 ${op.op}: 必须提供 progress_basis（${PROGRESS_BASES.join('/')}），不得把模糊描述伪装成精确百分比`)
      }
      if (op.progress_basis === 'agent_estimate' && !AGENT_ESTIMATE_ANCHORS.has(progress)) {
        errors.push(`第 ${i + 1} 条 ${op.op}: Agent 估算只能使用阶段锚点 ${[...AGENT_ESTIMATE_ANCHORS].join('/')}；不要制造 92%/96% 这类伪精度`)
      }
    }
    if (op.notify_mode !== undefined && !NOTIFY_MODES.includes(op.notify_mode)) {
      errors.push(`第 ${i + 1} 条: notify_mode 非法（允许 ${NOTIFY_MODES.join('/')}）`)
    }
    if (op.op !== 'create' && op.notify_mode === undefined) {
      errors.push(`第 ${i + 1} 条 ${op.op}: 必须显式提供 notify_mode，确保预览与实际飞书行为完全一致`)
    }
    if (op.notify_mode === 'merge' && op.op !== 'progress') {
      errors.push(`第 ${i + 1} 条: notify_mode=merge 仅用于 progress 批量进展；其他操作请选择 immediate 或 silent`)
    }
    if (op.op === 'note' && (op.type ?? 'progress') === 'progress' && PROGRESS_PERCENT_CLAIM.test(String(op.content || ''))) {
      errors.push(`第 ${i + 1} 条 note: 含任务百分比的进度声明必须改用 progress 操作，避免只写时间线却未更新 progress 字段`)
    }
    for (const dk of ['start', 'end', 'start_date', 'expected_end']) {
      if (op[dk] && !DATE_RE.test(op[dk])) errors.push(`第 ${i + 1} 条: 非法日期 "${op[dk]}"（应 YYYY-MM-DD）`)
    }
  }

  // ---- 2) 对账要求：每一个快照证据都必须有且仅有一个结论 ----
  // 这是「全量对账」的机器闸门；不再只检查“写过一些对账项”。
  errors.push(...validateReviewSpec(snapshot.snapshot_id, reviewPacket, spec))
  const pending = (reconciliation || []).filter((entry) => entry?.decision === 'needs_confirmation')
  if (pending.length > 0) {
    errors.push(`有 ${pending.length} 项待确认，必须先运行 npm run dashboard:pending -- hold 并向用户逐项确认；确认后用 dashboard:pending resolve 续办，不得 apply`)
  }
  if (errors.length > 0) {
    console.error('❌ 校验失败:')
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }

  // ---- 3) 人工发布确认：dry-run 可自由运行；真实写入必须消费与当前
  // 快照和全部 ops 精确匹配的确认记录。内容或快照有任何变化都会失效。 ----
  if (!args.dryRun) {
    const approval = (() => {
      try { return JSON.parse(fs.readFileSync(DEFAULT_APPROVAL_FILE, 'utf8')) } catch { return null }
    })()
    if (!approvalMatchesSpec(approval, spec)) {
      fail('尚未获得当前更新预览的用户“确认推送”。先运行 dashboard:publish -- preview 并发给用户；收到确认后运行 dashboard:publish -- confirm --phrase "确认推送"。')
    }
    try {
      if (snapshot.snapshot_health === 'degraded') {
        fail('当前快照 degraded（有数据源拉取失败），禁止 apply；先修复来源并重新 prepare。')
      }
    } catch { /* 缺 context 不拦截 */ }
  }

  // ---- 4) 预条件：引用的任务必须存在（真实可用的预检）----
  const tasks = loadTasks()
  const byId = tasks ? new Map(tasks.map((t) => [t.id, t])) : null
  if (byId) {
    for (const [i, op] of ops.entries()) {
      if (op.op === 'create') continue
      if (op.id && !byId.has(op.id)) errors.push(`第 ${i + 1} 条 ${op.op}: 任务不存在 ${op.id}`)
      if (op.op === 'schedule' || op.op === 'progress' || op.op === 'status' || op.op === 'reopen') {
        // 状态迁移合法性：blocked/completed 必须走专用命令（DB 也会兜底）
        if (op.op === 'status' && (op.to === 'blocked' || op.to === 'completed')) {
          errors.push(`第 ${i + 1} 条: status 不能直接到 blocked/completed，请用 block/complete`)
        }
        if (op.op === 'status' && byId.get(op.id)?.status === 'completed' && op.to !== 'completed') {
          errors.push(`第 ${i + 1} 条: completed 任务不能用 status 恢复，请用 reopen 原子清除实际完成日期`)
        }
        if (op.op === 'reopen' && byId.get(op.id)?.status !== 'completed') {
          errors.push(`第 ${i + 1} 条: reopen 只适用于 completed 任务`)
        }
      }
    }
    for (const [i, item] of (reconciliation || []).entries()) {
      for (const taskId of item?.decision === 'mapped' ? reconciliationTaskIds(item) : []) {
        if (!byId.has(taskId)) errors.push(`reconciliation[${i}]: mapped 的任务不存在 ${taskId}`)
      }
    }
  }

  if (errors.length > 0) {
    console.error('❌ 变更建议校验失败:')
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }

  const noChange = ops.length === 0
  const reconciliationSummary = summarizeReconciliation(reconciliation)
  const notificationIntent = summarizeNotificationIntents(ops)
  console.log(`对账摘要：共 ${reconciliationSummary.total} 项 · 已映射 ${reconciliationSummary.mapped} · 已审查无需改动 ${reconciliationSummary.reviewed_no_change} · 无关 ${reconciliationSummary.irrelevant} · 待确认 ${reconciliationSummary.needs_confirmation}`)
  if (reconciliationSummary.needs_confirmation_source_ids.length > 0) {
    const ids = reconciliationSummary.needs_confirmation_source_ids.slice(0, 8).join(', ')
    const suffix = reconciliationSummary.needs_confirmation_source_ids.length > 8 ? ' …' : ''
    console.log(`待确认 source_id（最多显示 8 项）：${ids}${suffix}`)
  }
  console.log(`通知意图：即时入队 ${notificationIntent.immediate} · 批内合并 ${notificationIntent.merge} · 静默 ${notificationIntent.silent} · 历史补记 ${notificationIntent.historical}`)
  console.log(`${noChange ? '无数据写入，确认审查结案' : `共 ${ops.length} 条变更`}（快照已对账 ${reconciliation.length} 项），开始${args.dryRun ? '预演' : '执行'}…`)
  for (const [i, op] of ops.entries()) {
    const brief = Object.entries(op).filter(([k]) => k !== 'op').map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(' ')
    console.log(`  ${i + 1}. ${op.op} ${brief}`)
  }

  if (args.dryRun) {
    console.log(`✅ 预演通过（已校验完整对账、字段/日期/任务存在/状态迁移；${noChange ? '不会写入看板' : '未写入'}）。去掉 --dry-run 执行。`)
    return
  }

  // ---- 5) 执行 + changeset ----
  const changeset_id = `chg-${Date.now()}`
  const applyStartedAt = new Date().toISOString()
  // Confirmation is single-use. If execution partially fails, a newly reviewed
  // preview and a fresh owner confirmation are required before any retry.
  consumeApproval(spec)
  let batchOut = ''
  if (!noChange) {
    try {
      batchOut = execFileSync('node', [AGENT, 'batch', '--file', args.file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      console.log(batchOut)
    } catch (e) {
      console.error(String(e.stdout || ''))
      fail(`应用失败: ${String(e.stderr || e.message || '').slice(0, 500)}`)
    }
  }
  // 解析 batch 结果「批处理完成：N/M 成功」——部分失败不得当作「已全面完成」。
  const m = batchOut.match(/批处理完成：(\d+)\/(\d+) 成功/)
  const okCount = m ? Number(m[1]) : ops.length // 无该行时保守：视作未知 → 全成功才记录
  const allOk = okCount === ops.length
  if (!allOk) {
    console.error(`❌ 批处理部分失败（成功 ${okCount}/${ops.length}），本次不标记为已 apply，分析游标不会推进。请修复失败项后重跑。`)
    process.exit(1)
  }
  try {
    fs.writeFileSync(CHANGESET_FILE, JSON.stringify({
      changeset_id, snapshot_id: snapshot.snapshot_id || null, all_ok: true,
      started_at: applyStartedAt, applied_at: new Date().toISOString(), ops_count: ops.length, reviewed_no_change: noChange,
      notification_intent: notificationIntent,
      ops: ops.map((o) => ({ op: o.op, id: o.id || o.title || null, notify_mode: notificationIntentFor(o) })),
      reconciliation: reconciliation || [],
    }, null, 2))
    markPreviewApplied(spec, changeset_id)
    console.log(`✅ changeset 已记录: ${changeset_id}`)
  } catch { /* 记录失败不阻断 */ }
}

export { main, notificationIntentFor, summarizeNotificationIntents }

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
