#!/usr/bin/env node
// ============================================================
// Agent 更新接口 —— 个人工作进度看板
//
// 用途：让「Agent」以结构化命令维护看板数据（也是未来
//       用自然语言更新网站时的落地执行层）。
//
// 运行模式：
//   - 本地模式：默认，读写 data/local.json（无需网络）
//   - Supabase 模式：配置 .env 中的 SUPABASE_URL 与
//     SUPABASE_SERVICE_ROLE_KEY（service_role 仅存在于本地，
//     严禁进入前端代码或提交到仓库）
//
// 用法示例见 docs/AGENT_GUIDE.md；所有命令支持 --dry-run 预演。
// ============================================================

import { loadEnv } from './lib/env.js'
import { parseArgs } from './lib/args.js'
import { createStore } from './lib/store.js'

const env = loadEnv()
const store = createStore(env)

const args = parseArgs(process.argv.slice(2))
const [command, ...positional] = args._
const dryRun = !!args['dry-run']
const jsonOut = !!args['json']
// 无登录体系：所有 Agent 更新都记为「agent」（网页端记「本人」）
const who = 'agent'

// ---------------- 常量与校验 ----------------

const STATUSES = ['planned', 'in_progress', 'blocked', 'paused', 'completed', 'cancelled']
const PRIORITIES = ['high', 'normal', 'low']
const UPDATE_TYPES = ['progress', 'status_change', 'schedule_change', 'blocked', 'unblocked', 'interrupt', 'note', 'completed']

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function fail(msg) {
  throw new Error(msg)
}

function requireOp(op, key, label) {
  const v = op[key] ?? op._?.[0]
  if (v === undefined || v === true || v === '') fail(`缺少参数 --${key}${label ? `（${label}）` : ''}`)
  return String(v)
}

function assertStatus(v) {
  if (!STATUSES.includes(v)) fail(`非法状态: ${v}，可选: ${STATUSES.join(' / ')}`)
  return v
}

function assertPriority(v) {
  if (!PRIORITIES.includes(v)) fail(`非法优先级: ${v}，可选: ${PRIORITIES.join(' / ')}`)
  return v
}

function assertProgress(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 100) fail(`非法进度: ${v}，必须是 0-100 的数字`)
  return Math.round(n)
}

function assertDate(v, label = '日期') {
  if (v !== undefined && v !== null && v !== '' && !DATE_RE.test(v)) fail(`非法${label}: ${v}，格式 YYYY-MM-DD`)
  return v ?? null
}

// ---------------- 输出 ----------------

function renderTask(t) {
  const parts = [
    `[${t.id}]`,
    t.title,
    `(${t.status}`,
    `${t.priority}`,
    `${t.progress}%)`,
  ]
  if (t.start_date) parts.push(`开始:${t.start_date}`)
  if (t.expected_end_date) parts.push(`预计完成:${t.expected_end_date}`)
  if (t.actual_end_date) parts.push(`实际完成:${t.actual_end_date}`)
  if (t.is_interrupt_task) parts.push('[临时]')
  if (t.status === 'blocked' && t.block_reason) parts.push(`阻塞:${t.block_reason}`)
  if (t.current_status) parts.push(`现状:${t.current_status}`)
  return parts.join(' ')
}

function renderUpdate(u) {
  const s = u.old_expected_end_date && u.new_expected_end_date
    ? ` 排期:${u.old_expected_end_date} → ${u.new_expected_end_date}`
    : ''
  return `${u.created_at} [${u.type}] ${u.content}${s} (by ${u.created_by || '?'})`
}

function human(msg) {
  if (!jsonOut) console.log(msg)
}

// ---------------- 各操作（语义与 src/lib/taskService.ts 保持一致） ----------------

async function opList(op) {
  const tasks = await store.listTasks()
  let list = tasks
  if (op.status) list = list.filter((t) => t.status === op.status)
  if (op.interrupt === 'true' || op.interrupt === '1') list = list.filter((t) => t.is_interrupt_task)
  list = [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  if (jsonOut) return list
  human(`[数据模式] ${store.mode}${store.localFile ? `（文件: ${store.localFile}）` : ''}`)
  if (list.length === 0) human(`（无任务${op.status ? `，状态=${op.status}` : ''}）`)
  for (const t of list) human(renderTask(t))
  human(`共 ${list.length} 条`)
  return null
}

async function opGet(op) {
  const id = requireOp(op, 'id', '任务 id')
  const task = await store.getTask(id)
  if (!task) fail(`任务不存在: ${id}（可用 list 查看全部任务 id）`)
  const updates = await store.listUpdates(id)
  if (jsonOut) return { task, updates }
  human(renderTask(task))
  human('--- 时间线 ---')
  if (updates.length === 0) human('（无时间线记录）')
  for (const u of [...updates].sort((a, b) => a.created_at.localeCompare(b.created_at))) human(renderUpdate(u))
  return null
}

async function opCreate(op) {
  const title = requireOp(op, 'title', '任务名称')
  const input = {
    title,
    description: op.description ?? '',
    status: op.status ? assertStatus(op.status) : 'planned',
    priority: op.priority ? assertPriority(op.priority) : 'normal',
    progress: op.progress !== undefined ? assertProgress(op.progress) : 0,
    start_date: assertDate(op.start ?? op.start_date, '开始日期'),
    expected_end_date: assertDate(op.end ?? op.expected_end_date ?? op.expected_end, '预计完成日期'),
    is_interrupt_task: op.interrupt === 'true' || op.interrupt === '1' || op.interrupt === true,
    current_status: op.current_status ?? '',
    block_reason: op.block_reason ?? '',
  }
  if (dryRun) {
    human(`[dry-run] 将创建任务: ${input.title}`)
    return null
  }
  const task = await store.createTask(input)
  await store.addUpdate({ task_id: task.id, type: 'note', content: op.note ?? '任务创建。', created_by: who })
  human(`✅ 已创建任务 id=${task.id}`)
  human(renderTask(task))
  return task
}

async function opProgress(op) {
  const id = requireOp(op, 'id', '任务 id')
  const to = assertProgress(op.to ?? op.progress)
  const note = op.note ?? op.content ?? `进度更新为 ${to}%。`
  if (dryRun) {
    human(`[dry-run] 任务 ${id} 进度 → ${to}%，时间线: ${note}`)
    return null
  }
  const task = await store.updateTask(id, { progress: to })
  await store.addUpdate({ task_id: id, type: 'progress', content: note, created_by: who })
  human(`✅ 任务 ${id} 进度已更新为 ${to}%`)
  human(renderTask(task))
  return task
}

async function opStatus(op) {
  const id = requireOp(op, 'id', '任务 id')
  const to = assertStatus(op.to ?? op.status)
  const note = op.note ?? op.content ?? `状态变更为 ${to}。`
  if (dryRun) {
    human(`[dry-run] 任务 ${id} 状态 → ${to}`)
    return null
  }
  const task = await store.updateTask(id, { status: to })
  await store.addUpdate({ task_id: id, type: 'status_change', content: note, created_by: who })
  human(`✅ 任务 ${id} 状态已更新为 ${to}`)
  human(renderTask(task))
  return task
}

async function opSchedule(op) {
  const id = requireOp(op, 'id', '任务 id')
  const end = assertDate(requireOp(op, 'end', '新的预计完成日期 YYYY-MM-DD'), '预计完成日期')
  const before = await store.getTask(id)
  if (!before) fail(`任务不存在: ${id}`)
  const note = op.note ?? op.content ?? (before.expected_end_date
    ? `预计完成日期由 ${before.expected_end_date} 调整为 ${end}。`
    : `预计完成日期调整为 ${end}。`)
  if (dryRun) {
    human(`[dry-run] 任务 ${id} 预计完成 ${before.expected_end_date ?? '—'} → ${end}`)
    return null
  }
  const task = await store.updateTask(id, { expected_end_date: end })
  await store.addUpdate({
    task_id: id,
    type: 'schedule_change',
    content: note,
    old_expected_end_date: before.expected_end_date,
    new_expected_end_date: end,
    created_by: who,
  })
  human(`✅ 任务 ${id} 预计完成日期: ${before.expected_end_date ?? '—'} → ${end}`)
  human(renderTask(task))
  return task
}

async function opUpdate(op) {
  const id = requireOp(op, 'id', '任务 id')
  const patch = {}
  if (op.title !== undefined) patch.title = String(op.title)
  if (op.description !== undefined) patch.description = String(op.description)
  if (op.current_status !== undefined) patch.current_status = String(op.current_status)
  if (op.priority !== undefined) patch.priority = assertPriority(op.priority)
  if (op.status !== undefined) patch.status = assertStatus(op.status)
  if (op.start_date !== undefined || op.start !== undefined) {
    patch.start_date = assertDate(op.start_date ?? op.start, '开始日期')
  }
  if (op.block_reason !== undefined) patch.block_reason = String(op.block_reason)
  if (op.interrupt !== undefined) {
    patch.is_interrupt_task = op.interrupt === 'true' || op.interrupt === '1' || op.interrupt === true
  }
  if (Object.keys(patch).length === 0) {
    fail('没有要更新的字段（支持 --title / --description / --current_status / --priority / --start_date / --status / --block_reason / --interrupt）')
  }
  if (dryRun) {
    human(`[dry-run] 更新任务 ${id}: ${JSON.stringify(patch)}`)
    return null
  }
  const task = await store.updateTask(id, patch)
  if (op.note) {
    await store.addUpdate({ task_id: id, type: 'note', content: String(op.note), created_by: who })
  }
  human(`✅ 任务 ${id} 已更新${op.note ? '（并记录说明）' : ''}`)
  human(renderTask(task))
  return task
}

async function opBlock(op) {
  const id = requireOp(op, 'id', '任务 id')
  const reason = requireOp(op, 'reason', '阻塞原因')
  if (dryRun) {
    human(`[dry-run] 任务 ${id} 标记阻塞: ${reason}`)
    return null
  }
  const task = await store.updateTask(id, { status: 'blocked', block_reason: reason })
  await store.addUpdate({ task_id: id, type: 'blocked', content: `标记阻塞：${reason}`, created_by: who })
  human(`✅ 任务 ${id} 已标记阻塞`)
  human(renderTask(task))
  return task
}

async function opUnblock(op) {
  const id = requireOp(op, 'id', '任务 id')
  const note = op.note ?? op.content ?? '阻塞解除，恢复进行。'
  if (dryRun) {
    human(`[dry-run] 任务 ${id} 解除阻塞`)
    return null
  }
  const task = await store.updateTask(id, { status: 'in_progress', block_reason: '' })
  await store.addUpdate({ task_id: id, type: 'unblocked', content: note, created_by: who })
  human(`✅ 任务 ${id} 已解除阻塞`)
  human(renderTask(task))
  return task
}

async function opComplete(op) {
  const id = requireOp(op, 'id', '任务 id')
  const note = op.note ?? op.content ?? '任务完成。'
  if (dryRun) {
    human(`[dry-run] 任务 ${id} 标记完成`)
    return null
  }
  const today = new Date().toISOString().slice(0, 10)
  const task = await store.updateTask(id, { status: 'completed', progress: 100, actual_end_date: today })
  await store.addUpdate({ task_id: id, type: 'completed', content: note, created_by: who })
  human(`✅ 任务 ${id} 已完成（${today}）`)
  human(renderTask(task))
  return task
}

async function opNote(op) {
  const id = requireOp(op, 'id', '任务 id')
  const content = requireOp(op, 'content', '进展内容')
  const type = op.type ?? 'progress'
  if (!UPDATE_TYPES.includes(type)) fail(`非法更新类型: ${type}`)
  if (dryRun) {
    human(`[dry-run] 任务 ${id} 追加[${type}]记录: ${content}`)
    return null
  }
  const update = await store.addUpdate({ task_id: id, type, content, created_by: who })
  human(`✅ 已记录 [${type}]`)
  human(renderUpdate(update))
  return update
}

async function opDelete(op) {
  const id = requireOp(op, 'id', '任务 id')
  if (dryRun) {
    human(`[dry-run] 删除任务 ${id}`)
    return null
  }
  await store.deleteTask(id)
  human(`✅ 已删除任务 ${id}`)
  return null
}

async function opBatch(op) {
  const file = requireOp(op, 'file', '批处理 JSON 文件路径')
  let spec
  try {
    spec = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(file, 'utf8')))
  } catch (e) {
    fail(`读取批处理文件失败: ${e.message}`)
  }
  const items = Array.isArray(spec) ? spec : spec.ops
  if (!Array.isArray(items)) fail('批处理文件须为数组或 { ops: [...] }')
  const results = []
  for (const item of items) {
    const opName = item.op
    if (!ops[opName]) {
      results.push({ op: opName ?? '?', ok: false, message: `未知操作: ${opName}` })
      continue
    }
    try {
      const r = await ops[opName](item)
      results.push({ op: opName, ok: true, id: r?.id ?? item.id ?? null })
    } catch (e) {
      results.push({ op: opName, ok: false, message: e.message })
    }
  }
  const failed = results.filter((r) => !r.ok)
  if (jsonOut) return results
  for (const r of results) human(`${r.ok ? '✅' : '❌'} ${r.op}${r.id ? ` (${r.id})` : ''}${r.message ? ' — ' + r.message : ''}`)
  human(`批处理完成：${results.length - failed.length}/${results.length} 成功`)
  return results
}

async function opSeed(op) {
  const file = op.file ?? new URL('./seed.json', import.meta.url).pathname
  const seed = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(file, 'utf8')))
  const force = op.force === 'true' || op.force === '1' || op.force === true
  if (dryRun) {
    human(`[dry-run] 导入种子数据: ${seed.tasks.length} 任务, ${seed.updates.length} 时间线`)
    return null
  }
  await store.seed(seed.tasks, seed.updates, force)
  human(`✅ 种子数据已导入（${seed.tasks.length} 任务）`)
  return null
}

function opHelp() {
  console.log(`
个人工作进度看板 —— Agent 更新接口
用法: npm run agent -- <命令> [参数]   （或 node scripts/agent.js <命令>）

通用参数: --dry-run 预演不写入 | --json 输出 JSON

命令:
  list [--status 状态] [--interrupt]          列出任务（支持过滤）
  get <任务id>                                 查看任务详情 + 时间线
  create --title "任务名" [--description] [--status] [--priority]
        [--progress 0-100] [--start YYYY-MM-DD] [--end YYYY-MM-DD]
        [--interrupt] [--note "创建说明"]       新建任务（自动记录时间线）
  progress <id> --to 70 [--note "说明"]         更新进度（自动记录）
  status <id> --to in_progress [--note]         修改状态（自动记录）
  update <id> --title "新标题" --description "..." --current_status "..." 
        [--priority high] [--start_date YYYY-MM-DD] [--status planned] [--note "说明"]
                                               通用字段更新（描述/现状/标题等）
  schedule <id> --end YYYY-MM-DD [--note]       调整预计完成日期（记录 old/new）
  block <id> --reason "原因"                    标记阻塞（必填原因）
  unblock <id> [--note]                         解除阻塞
  complete <id> [--note]                        标记完成（进度=100，记录实际完成日）
  note <id> --content "内容" [--type 类型]      追加时间线（progress/interrupt/note/...）
  delete <id>                                   删除任务（含时间线）
  batch --file ops.json                         批量执行（数组或 {ops: [...]}）
  seed [--file seed.json] [--force]             导入种子演示数据

数据模式: 配置 .env 的 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 则写入线上库；
          否则读写本地 data/local.json。
详细说明见 docs/AGENT_GUIDE.md
`)
}

const ops = {
  list: opList,
  get: opGet,
  create: opCreate,
  progress: opProgress,
  status: opStatus,
  update: opUpdate,
  schedule: opSchedule,
  block: opBlock,
  unblock: opUnblock,
  complete: opComplete,
  note: opNote,
  delete: opDelete,
  batch: opBatch,
  seed: opSeed,
  help: opHelp,
}

// ---------------- 入口 ----------------

async function main() {
  if (!command || command === 'help' || command === '-h' || command === '--help') {
    opHelp()
    return
  }
  const fn = ops[command]
  if (!fn) fail(`未知命令: ${command}（运行 help 查看）`)
  // 位置参数：get/delete 等把第一个位置参数作为 id
  if (positional.length > 0 && args.id === undefined) args.id = positional[0]
  const result = await fn(args)
  if (jsonOut && result !== undefined) {
    console.log(JSON.stringify(result, null, 2))
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`❌ ${e.message}`)
    process.exit(1)
  })
