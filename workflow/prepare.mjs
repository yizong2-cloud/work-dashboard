#!/usr/bin/env node
// ============================================================
// workflow/prepare.mjs —— 一条龙更新流程的「准备」阶段
// 机械地完成：导出飞书增量 + Codex 摘要 + DSH 摘要 + 当前看板
// + 知识库，统一打包为 workflow/update-context.json，
// 并生成 workflow/latest-report.md（含规则化提示，无需 LLM）。
//
// 适用：`npm run dashboard:prepare`；也作为定时任务每天下班前跑，
// 无人值守（不交互；失败会记录到报告与 stderr）。
// ============================================================

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()
const FEISHU_BIN = path.join(HOME, 'feishu_export', 'bin', 'feishu-export')
const DAILY_DIR = path.join(HOME, 'feishu_export', 'daily')
const DAYS = 3
const CONTEXT_FILE = path.join(ROOT, 'workflow', 'update-context.json')

// 增量窗口：上次 context 的生成时间（UTC）；无则退化为最近 3 天
function lastGeneratedAt() {
  try {
    const old = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'))
    return old.generated_at || null
  } catch {
    return null
  }
}
const LAST_AT = lastGeneratedAt()
const REPORT_FILE = path.join(ROOT, 'workflow', 'latest-report.md')

function run(cmd, args, timeoutMs = 120000) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs })
    return { ok: true, stdout: String(stdout), stderr: '' }
  } catch (e) {
    return { ok: false, stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message || '') }
  }
}

function latestFile(dir, re) {
  if (!fs.existsSync(dir)) return null
  return fs.readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0]?.f ?? null
}

function notify(title, body) {
  // macOS 通知（无人值守时静默弹通知；失败不影响主流程）
  try {
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`
    execFileSync('osascript', ['-e', script], { timeout: 10000 })
  } catch {
    // 忽略通知失败
  }
}

function summarizeStep(line) {
  const keep = line
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('>') && !l.startsWith('#') && !l.startsWith('[') && l.length < 200)
    .slice(-3)
  return keep.join(' | ').slice(0, 400)
}

function main() {
  const steps = []

  // ---- 1. 飞书增量导出 ----
  // --refresh-chats：强制重扫会话列表。否则 --incremental 复用 .state.json 里缓存的
  // updateTime（快照陈旧），会漏掉期间收到新消息、但上次快照不活跃的会话（如高琦 8/17）。
  const feishuRes = run(FEISHU_BIN, ['--incremental', '--markdown', '--refresh-chats'], 300000)
  const feishuFile = latestFile(DAILY_DIR, /^range_.*\.md$/)
  let feishuText = '（无飞书增量文件）'
  if (feishuFile) {
    try {
      feishuText = fs.readFileSync(path.join(DAILY_DIR, feishuFile), 'utf8').slice(0, 30000)
    } catch {
      feishuText = '（飞书增量文件读取失败）'
    }
  }
  steps.push({
    name: '飞书增量导出',
    ok: feishuRes.ok,
    detail: feishuRes.ok ? summarizeStep(feishuRes.stdout) || `文件 ${feishuFile}` : feishuRes.stderr.slice(0, 200),
    file: feishuFile,
  })

  // ---- 2. Codex 摘要（增量窗口 + 详情，分析无需再翻原始文件）----
  const codexArgs = [path.join(ROOT, 'scripts', 'codex-summary.js'), '--days', String(DAYS), '--json']
  if (LAST_AT) codexArgs.push('--since-time', LAST_AT)
  const codexRes = run('node', codexArgs, 240000)
  let codex = []
  if (codexRes.ok) {
    try {
      codex = JSON.parse(codexRes.stdout)
    } catch {
      steps.push({ name: 'Codex 摘要', ok: false, detail: '摘要输出解析失败' })
    }
  } else {
    steps.push({ name: 'Codex 摘要', ok: false, detail: codexRes.stderr.slice(0, 200) })
  }
  if (!steps.some((s) => s.name === 'Codex 摘要')) {
    steps.push({ name: 'Codex 摘要', ok: true, detail: `${codex.length} 个会话` })
  }

  // ---- 3. DSH 摘要（增量窗口 + 详情）----
  const dshArgs = [path.join(ROOT, 'scripts', 'dsh-summary.js'), '--days', String(DAYS), '--json']
  if (LAST_AT) dshArgs.push('--since-time', LAST_AT)
  const dshRes = run('node', dshArgs, 240000)
  let dsh = []
  if (dshRes.ok) {
    try {
      dsh = JSON.parse(dshRes.stdout)
    } catch {
      steps.push({ name: 'DSH 摘要', ok: false, detail: '摘要输出解析失败' })
    }
  } else {
    steps.push({ name: 'DSH 摘要', ok: false, detail: dshRes.stderr.slice(0, 200) })
  }
  if (!steps.some((s) => s.name === 'DSH 摘要')) {
    steps.push({ name: 'DSH 摘要', ok: true, detail: `${dsh.length} 个会话` })
  }

  // ---- 4. 当前看板 ----
  const boardRes = run('node', [path.join(ROOT, 'scripts', 'agent.js'), 'list', '--json'], 60000)
  let board = []
  if (boardRes.ok) {
    try {
      board = JSON.parse(boardRes.stdout)
    } catch {
      board = []
    }
  }
  steps.push({ name: '当前看板', ok: boardRes.ok, detail: boardRes.ok ? `${board.length} 个任务` : boardRes.stderr.slice(0, 200) })

  // ---- 5. 知识库 ----
  let knowledgeBase = ''
  try {
    knowledgeBase = fs.readFileSync(path.join(ROOT, 'docs', 'KNOWLEDGE_BASE.md'), 'utf8')
  } catch {
    knowledgeBase = '（知识库读取失败）'
  }

  // ---- 详情：增量窗口内会话的完整对话内容（分析者第一步就能看到具体说了什么）----
  const detailArgs = (extra) => [path.join(ROOT, 'scripts', extra), '--days', String(DAYS), '--detail', '--json']
  const codexDetailRes = run('node', detailArgs('codex-summary.js'), 240000)
  const dshDetailRes = run('node', detailArgs('dsh-summary.js'), 240000)
  let codexDetail = []
  let dshDetail = []
  try { codexDetail = JSON.parse(codexDetailRes.stdout) } catch { codexDetail = [] }
  try { dshDetail = JSON.parse(dshDetailRes.stdout) } catch { dshDetail = [] }

  // ---- 打包 context ----
  const ctx = {
    generated_at: new Date().toISOString(),
    source_range_days: DAYS,
    incremental_since: LAST_AT,
    steps,
    feishu: { latest_file: feishuFile, content: feishuText },
    codex,
    dsh,
    codex_detail: codexDetail,
    dsh_detail: dshDetail,
    board,
    knowledge_base: knowledgeBase.slice(0, 40000),
  }
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2))

  // ---- 规则化报告（无需 LLM）----
  const unfinished = (t) => t.status !== 'completed' && t.status !== 'cancelled'
  const active = board.filter((t) => ['in_progress', 'blocked', 'paused'].includes(t.status))
  const noSchedule = active.filter((t) => !t.expected_end_date)
  const blocked = active.filter((t) => t.status === 'blocked')
  const lines = []
  lines.push('# 看板更新准备报告（自动生成）', '')
  lines.push(`> 生成时间: ${ctx.generated_at}`, '')
  lines.push('## 各数据源状态', '')
  for (const s of steps) lines.push(`- ${s.ok ? '✅' : '❌'} ${s.name}: ${s.detail}`)
  lines.push('', '## 当前看板概览', '')
  lines.push(`- 任务总数: ${board.length}；进行中/阻塞/暂停: ${active.length}；阻塞: ${blocked.length}`)
  lines.push(`- **活跃任务未排期（Leader 无法判断何时完成）: ${noSchedule.length} 个**`)
  for (const t of noSchedule) lines.push(`  - ${t.title}（${t.status} ${t.progress}%）`)
  lines.push('', '## 数据源最近活动', '')
  lines.push(`- Codex: ${codex.length} 个会话`)
  for (const s of codex.slice(0, 5)) {
    const req = (s.userReqs && s.userReqs[0] || '').replace(/\n/g, ' ').slice(0, 80)
    lines.push(`  - ${(s.start || '?').slice(0, 16).replace('T', ' ')} @ ${s.cwd} ${req ? `：${req}` : ''}`)
  }
  lines.push(`- DSH: ${dsh.length} 个会话`)
  for (const s of dsh.slice(0, 5)) {
    const req = (s.userMsgs && s.userMsgs[0] || '').replace(/\n/g, ' ').slice(0, 80)
    lines.push(`  - ${(s.start || '?').slice(0, 16).replace('T', ' ')} @ ${s.cwd} ${req ? `：${req}` : ''}`)
  }
  lines.push('', '## 下一步', '')
  lines.push('1. Agent 读取 `workflow/update-context.json`，结合知识库做增量分析')
  lines.push('2. 生成变更建议 `workflow/ops.json`')
  lines.push('3. 执行 `npm run dashboard:apply`（可先 `--dry-run`）')
  lines.push('4. 执行 `npm run dashboard:verify` 校验', '')
  fs.writeFileSync(REPORT_FILE, lines.join('\n'))

  const failed = steps.filter((s) => !s.ok)
  if (failed.length > 0) {
    console.error(`[prepare] ⚠️ ${failed.length} 个步骤失败: ${failed.map((s) => s.name).join('、')}`)
  }
  console.log(`[prepare] ✅ 完成: ${CONTEXT_FILE}`)
  console.log(`[prepare] 报告: ${REPORT_FILE}`)
  if (noSchedule.length > 0) {
    notify('看板数据已就绪', `${noSchedule.length} 个活跃任务未排期；数据源已拉取，可说"开始更新"`)
  } else {
    notify('看板数据已就绪', '数据源已拉取，可说"开始更新"')
  }
}

main()
