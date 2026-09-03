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
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  approvalMatchesSpec, consumeApproval, DEFAULT_APPROVAL_FILE,
  markPreviewApplied, markPreviewExecuting, markPreviewRetryable, specFingerprint,
} from './publish.mjs'
import { buildExecutionPlan, mergeOperationResults } from './apply-journal.mjs'
import { writeJsonAtomic } from './pending.mjs'
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
const CREATION_BASES = ['source_explicit', 'user_explicit', 'owner_confirmed']

function parseArgs(argv) {
  const args = { file: path.join(ROOT, 'workflow', 'ops.json'), dryRun: false, force: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i]
    else if (argv[i] === '--dry-run') args.dryRun = true
    else if (argv[i] === '--force') args.force = true
    else if (argv[i] === '--quiet') args.quiet = true
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

function runAgentOperations(operations, { dryRun = false } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-apply-'))
  const file = path.join(tempDir, 'ops.json')
  try {
    fs.writeFileSync(file, JSON.stringify({ ops: operations }, null, 2))
    const command = [AGENT, 'batch', '--file', file, '--json']
    if (dryRun) command.push('--dry-run')
    let output
    try {
      output = execFileSync('node', command, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    } catch (error) {
      throw new Error(String(error.stderr || error.stdout || error.message || '').trim())
    }
    let results
    try {
      results = JSON.parse(output)
    } catch {
      throw new Error(`执行器返回了无法解析的结果: ${String(output).slice(0, 300)}`)
    }
    if (!Array.isArray(results)) throw new Error('执行器未返回逐项结果')
    return results
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function batchFailures(results) {
  return results
    .map((result, index) => ({ ...result, index }))
    .filter((result) => !result.ok)
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
  const reviewSourceIds = new Set((reviewPacket?.review_items || []).map((item) => item.source_id))
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
    if (op.op === 'create') {
      if (!CREATION_BASES.includes(op.creation_basis)) {
        errors.push(`第 ${i + 1} 条 create: 必须提供 creation_basis（${CREATION_BASES.join('/')}）；无法确定是否是工作任务时必须走 needs_confirmation`)
      }
      if (!Array.isArray(op.source_ids) || op.source_ids.length === 0) {
        errors.push(`第 ${i + 1} 条 create: 必须提供 source_ids，说明新任务来自当前快照的哪些证据`)
      } else {
        for (const sourceId of op.source_ids) {
          if (!reviewSourceIds.has(sourceId)) errors.push(`第 ${i + 1} 条 create: source_ids 包含当前审查包不存在的来源 ${sourceId}`)
        }
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
      if (op.progress_basis === 'user_explicit') {
        const quote = String(op.evidence_quote ?? '').trim()
        const quotedPercent = new RegExp(`(^|\\D)${progress}\\s*%`).test(quote)
        if (!quotedPercent) {
          errors.push(`第 ${i + 1} 条 ${op.op}: progress_basis=user_explicit 时，用户原话必须明确包含 ${progress}%；只有阶段描述时请改用 agent_estimate 阶段锚点或只更新 current_status`)
        }
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
      fail('尚未获得用户对当前完整预览的明确同意。先运行 dashboard:publish -- preview 并把完整内容逐项发给用户；收到“确认”“可以更新”“按这版推送”等清晰授权后，把用户原话传给 dashboard:publish -- confirm --phrase。')
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

  const fingerprint = specFingerprint(spec)
  const previousChangeset = (() => {
    try {
      const previous = JSON.parse(fs.readFileSync(CHANGESET_FILE, 'utf8'))
      return previous?.all_ok === false && previous?.fingerprint === fingerprint ? previous : null
    } catch { return null }
  })()
  const fullPlan = ops.map((op, index) => ({ op, index }))
  const executionPlan = args.dryRun ? fullPlan : buildExecutionPlan(ops, previousChangeset, fingerprint)

  // ---- 4.5) 与真实执行器共用同一条逐项预检路径 ----
  // apply 自己负责更新流程政策；agent batch --dry-run 负责命令字段、日期格式、
  // 状态迁移等执行语义。两者都通过后才允许发生第一条真实写入。
  let executorPreflight = []
  if (executionPlan.length > 0) {
    try {
      executorPreflight = runAgentOperations(executionPlan.map((entry) => entry.op), { dryRun: true })
    } catch (error) {
      fail(`真实执行器预检失败: ${error.message}`)
    }
    const failures = batchFailures(executorPreflight)
    if (failures.length > 0) {
      const details = failures.map((result) => {
        const originalIndex = executionPlan[result.index]?.index ?? result.index
        return `第 ${originalIndex + 1} 条 ${result.op}: ${result.message}`
      }).join('；')
      fail(`真实执行器预检失败（尚未写入任何数据）：${details}`)
    }
  }

  const noChange = ops.length === 0
  const reconciliationSummary = summarizeReconciliation(reconciliation)
  const notificationIntent = summarizeNotificationIntents(ops)
  if (!args.quiet) {
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
  }

  if (args.dryRun) {
    if (!args.quiet) console.log(`✅ 预演通过（已由真实执行器校验完整对账、全部字段/日期/任务存在/状态迁移；${noChange ? '不会写入看板' : '未写入'}）。去掉 --dry-run 执行。`)
    return
  }

  // ---- 5) 执行 + changeset ----
  const changeset_id = previousChangeset?.changeset_id || `chg-${Date.now()}`
  const applyStartedAt = previousChangeset?.started_at || new Date().toISOString()
  markPreviewExecuting(spec)

  const initialResults = mergeOperationResults(ops, previousChangeset, [], [])
  const attempts = [...(previousChangeset?.attempts || []), {
    started_at: new Date().toISOString(),
    operation_indices: executionPlan.map((entry) => entry.index),
    status: 'executing',
  }]
  const baseChangeset = {
    changeset_id, snapshot_id: snapshot.snapshot_id || null, fingerprint, all_ok: false,
    state: 'executing', started_at: applyStartedAt, ops_count: ops.length,
    reviewed_no_change: noChange, notification_intent: notificationIntent,
    ops: ops.map((o) => ({ op: o.op, id: o.id || o.title || null, notify_mode: notificationIntentFor(o) })),
    operation_results: initialResults, reconciliation: reconciliation || [], attempts,
  }
  writeJsonAtomic(CHANGESET_FILE, baseChangeset)

  let attemptResults = []
  if (!noChange && executionPlan.length > 0) {
    try {
      attemptResults = runAgentOperations(executionPlan.map((entry) => entry.op))
    } catch (error) {
      attemptResults = executionPlan.map((entry) => ({ op: entry.op.op, ok: false, message: error.message }))
    }
  }
  const operationResults = mergeOperationResults(ops, previousChangeset, executionPlan, attemptResults)
  const failures = operationResults.filter((result) => result.ok !== true)
  const allOk = failures.length === 0
  const finishedAt = new Date().toISOString()
  attempts[attempts.length - 1] = {
    ...attempts[attempts.length - 1],
    finished_at: finishedAt,
    status: allOk ? 'succeeded' : 'failed',
  }
  const changeset = {
    ...baseChangeset,
    all_ok: allOk,
    state: allOk ? 'applied' : 'awaiting_retry',
    ...(allOk ? { applied_at: finishedAt } : { last_failed_at: finishedAt }),
    operation_results: operationResults,
    attempts,
  }
  writeJsonAtomic(CHANGESET_FILE, changeset)

  for (const result of operationResults) {
    const symbol = result.ok === true ? '✅' : result.ok === false ? '❌' : '⏭️'
    console.log(`${symbol} ${result.index + 1}. ${result.op}${result.result_id ? ` (${result.result_id})` : ''}${result.message ? ` — ${result.message}` : ''}`)
  }
  if (!allOk) {
    const message = `批处理部分失败（成功 ${operationResults.filter((result) => result.ok === true).length}/${ops.length}）；完整 changeset 已保留，同一预览授权仍有效。修复外部故障后运行 npm run dashboard:update -- retry，只会重试失败项。`
    markPreviewRetryable(spec, message)
    fail(message)
  }

  consumeApproval(spec)
  markPreviewApplied(spec, changeset_id)
  console.log(`✅ changeset 已记录: ${changeset_id}${previousChangeset ? '（失败项续跑完成）' : ''}`)
}

export { main, notificationIntentFor, summarizeNotificationIntents }

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
