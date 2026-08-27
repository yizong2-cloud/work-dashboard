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

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildReviewPacket, splitFeishuGroups } from './review-packet.mjs'
import { loadPendingPlan } from './pending.mjs'
import { redactSensitiveValue } from './redaction.mjs'
import { feishuFailureDetail, feishuOutputIncomplete, feishuSnapshot } from './source-safety.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()
function expandHome(value, home) {
  return String(value || '').replace(/^~(?=\/|$)/, home)
}

export function resolveFeishuPaths(home = os.homedir(), env = process.env) {
  const base = path.join(home, 'Workspace', 'feishu_export')
  const defaultBin = path.join(home, 'Workspace', 'feishu-export-public', 'bin', 'feishu-export')
  return {
    // Workboard has one canonical chat collector. The private feishu_export
    // directory stores local data and table tooling, not a fallback collector.
    bin: expandHome(env.WORKBOARD_FEISHU_BIN || defaultBin, home),
    cookies: expandHome(env.WORKBOARD_FEISHU_COOKIES || path.join(base, 'cookies.json'), home),
    output: expandHome(env.WORKBOARD_FEISHU_OUTPUT_DIR || path.join(base, 'daily'), home),
  }
}

const FEISHU_PATHS = resolveFeishuPaths(HOME)
const FEISHU_BIN = FEISHU_PATHS.bin
const FEISHU_COOKIES = FEISHU_PATHS.cookies
const DAILY_DIR = FEISHU_PATHS.output
const DAYS = 3
// A normal full refresh may cover a dozen active chats; the exporter also
// enforces a per-chat budget, so the outer budget can safely allow the batch
// to finish without turning one stuck chat into an unbounded wait.
const DEFAULT_FEISHU_TIMEOUT_MS = 600000
const configuredFeishuTimeout = Number(process.env.WORKBOARD_FEISHU_TIMEOUT_MS || DEFAULT_FEISHU_TIMEOUT_MS)
const FEISHU_TIMEOUT_MS = Number.isFinite(configuredFeishuTimeout) && configuredFeishuTimeout > 0 ? configuredFeishuTimeout : DEFAULT_FEISHU_TIMEOUT_MS
const CONTEXT_FILE = path.join(ROOT, 'workflow', 'update-context.json')
const REVIEW_PACKET_FILE = path.join(ROOT, 'workflow', 'review-packet.json')
const PENDING_PLAN_FILE = path.join(ROOT, 'workflow', 'pending-plan.json')
const LAST_HEALTHY_CONTEXT_FILE = path.join(ROOT, 'workflow', 'last-healthy-context.json')
const LAST_HEALTHY_PACKET_FILE = path.join(ROOT, 'workflow', 'last-healthy-review-packet.json')
const ANALYSIS_STATE = path.join(ROOT, 'workflow', '.analysis-state.json')

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch { /* best effort cleanup */ }
  }
}

export function persistSnapshotFiles({ ctx, reviewPacket, files }) {
  writeJsonAtomic(files.context, ctx)
  writeJsonAtomic(files.packet, reviewPacket)
  if (ctx.snapshot_health === 'ok') {
    writeJsonAtomic(files.lastHealthyContext, ctx)
    writeJsonAtomic(files.lastHealthyPacket, reviewPacket)
    return { last_healthy_updated: true, snapshot_id: ctx.snapshot_id }
  }
  return { last_healthy_updated: false, snapshot_id: null }
}

export function hasMatchingHealthySnapshot(contextFile, packetFile) {
  try {
    const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'))
    const packet = JSON.parse(fs.readFileSync(packetFile, 'utf8'))
    return context.snapshot_health === 'ok'
      && packet.snapshot_health === 'ok'
      && Boolean(context.snapshot_id)
      && context.snapshot_id === packet.snapshot_id
  } catch {
    return false
  }
}

export function snapshotNotification({ snapshotHealth, failedCount, noScheduleCount, lastHealthyAvailable }) {
  if (snapshotHealth !== 'ok') {
    return {
      title: '看板采集未完成',
      body: `${failedCount || 1} 个数据源步骤失败；${lastHealthyAvailable ? '最近健康快照已保留，仅供诊断，' : ''}请修复后重试`,
    }
  }
  return {
    title: '看板数据已就绪',
    body: noScheduleCount > 0
      ? `${noScheduleCount} 个活跃任务未排期；数据源已拉取，可说"开始更新"`
      : '数据源已拉取，可说"开始更新"',
  }
}

export function pendingPrepareBlock(plan) {
  if (plan?.state !== 'awaiting_confirmation' || !Array.isArray(plan.questions) || plan.questions.length === 0) return null
  return {
    snapshot_id: plan.snapshot_id || null,
    count: plan.questions.length,
    message: `快照 ${plan.snapshot_id || '未知'} 仍有 ${plan.questions.length} 个待确认问题`,
  }
}

// 分析游标 = 上次「apply + verify 都成功」的时间（由 verify 在通过后推进）。
// 与「采集生成」分离：prepare 只管采集/打包，不推进分析游标——
// 否则手动 prepare 即使分析中断也会把下批增量起点前移，导致永久漏数据。
function readAnalysisState() {
  try {
    return JSON.parse(fs.readFileSync(ANALYSIS_STATE, 'utf8')) || {}
  } catch {
    return {}
  }
}

export function buildFeishuArgs(lastAt, cookiesPath, outputDir) {
  const reviewedDate = lastAt ? lastAt.slice(0, 10) : null
  const args = reviewedDate
    ? ['--since', `${reviewedDate}T00:00`, '--refresh-chats', '--markdown', '--no-update-state']
    : ['--today', '--refresh-chats', '--markdown', '--no-update-state']
  if (cookiesPath) args.push('--cookies', cookiesPath)
  if (outputDir) args.push('--out', outputDir)
  return args
}

export function buildSummaryArgs(root, scriptName, days, lastAt) {
  const args = [path.join(root, 'scripts', scriptName), '--days', String(days), '--json']
  if (lastAt) args.push('--since-time', lastAt)
  return args
}

// 子进程 exit 0 只证明命令运行结束；更新流程还必须确认输出确实是
// 可消费的数组。否则空数组会伪装成“没有新增”，进而让不完整快照通过。
export function parseJsonArrayOutput(output) {
  try {
    const value = JSON.parse(output)
    if (!Array.isArray(value)) return { ok: false, value: [], detail: '输出不是数组' }
    return { ok: true, value, detail: null }
  } catch {
    return { ok: false, value: [], detail: '输出解析失败' }
  }
}

export function isSnapshotHealthy({ feishuOk, codexOk, dshOk, boardOk, knowledgeBaseOk }) {
  return Boolean(feishuOk && codexOk && dshOk && boardOk && knowledgeBaseOk)
}

// 增量窗口起点：分析游标（无则退化最近 3 天由 codex/dsh 的 --days 兜底）
const LAST_AT = readAnalysisState().reviewed_at || null
const REPORT_FILE = path.join(ROOT, 'workflow', 'latest-report.md')

// 第四数据源：本地常见放文档/素材/产物的目录（白名单，只收集元数据不含内容）
const LOCAL_DIRS = [path.join(HOME, 'Downloads'), path.join(HOME, 'Desktop'), path.join(HOME, 'Documents')]
const LOCAL_EXT = /\.(apk|pdf|md|docx?|xlsx?|pptx?|zip|html?|png|jpe?g|webp|gif|mp4|txt|jsx?|tsx?|json|svg)$/i

const LOCAL_SCAN_MAX_DEPTH = 2
const LOCAL_BASELINE_WINDOW_MS = 30 * 24 * 3600 * 1000
const LOCAL_SCAN_IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'coverage', '.cache', '.Trash'])

// 扫描受控白名单目录里「自分析游标以来」修改过的文件，输出候选清单（path/mtime/size/ext）。
// 只收集元数据，不把文件内容直接送入模型，避免无关/隐私文件泄漏。首次没有游标时
// 做最近 30 天的显式基线，而不是静默把本地来源报成空；递归深度也被限制，避免扫入项目依赖或系统缓存。
export function scanLocalFiles(sinceMs, directories = LOCAL_DIRS, nowMs = Date.now()) {
  const out = []
  const minMtime = sinceMs ? sinceMs - 6 * 3600 * 1000 : nowMs - LOCAL_BASELINE_WINDOW_MS // 缓冲 6h，防止跨午夜/边界漏
  const visit = (dir, depth) => {
    if (!fs.existsSync(dir)) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fp = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < LOCAL_SCAN_MAX_DEPTH && !LOCAL_SCAN_IGNORED_DIRS.has(entry.name)) visit(fp, depth + 1)
        continue
      }
      if (!entry.isFile() || !LOCAL_EXT.test(entry.name)) continue
      let st
      try { st = fs.statSync(fp) } catch { continue }
      if (st.isFile() && st.mtimeMs >= minMtime) {
        out.push({ path: fp, name: entry.name, mtime: new Date(st.mtimeMs).toISOString(), size: st.size, ext: entry.name.split('.').pop().toLowerCase() })
      }
    }
  }
  for (const dir of directories) {
    visit(dir, 0)
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime))
}

// ============ 候选提示（LLM 职责收缩：先用规则化映射给 Agent 线索，而非从零提炼）============

function loadSourceMap() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow', 'source-map.json'), 'utf8'))
  } catch {
    return { ignored_cwd: [], codex_cwd: [], ignored_feishu_chat: [], feishu_chat: [] }
  }
}

// Chat titles are often formatted by the exporter as "Fantasy 成就…" while
// the curated map uses "fantasy成就". Normalising only whitespace/full-width
// variants preserves explicit substring semantics without broad fuzzy matching.
export function normalizeMappingText(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
}

export function matchPattern(list, str) {
  const low = String(str || '').toLowerCase()
  const normalized = normalizeMappingText(str)
  for (const rule of list) {
    if (!rule.pattern) continue
    const pattern = String(rule.pattern)
    if (low.includes(pattern.toLowerCase()) || normalized.includes(normalizeMappingText(pattern))) return rule
  }
  return null
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 从一次扫描得到的 Codex / DSH 会话（含 cwd）生成候选；unmapped 收集未映射目录提醒
function buildSessionCandidates(sessions, map, key) {
  const hits = []
  const ignored = []
  const unmapped = []
  for (const s of sessions) {
    const cwd = s.cwd || ''
    if (cwd === HOME || cwd === `${HOME}/`) continue // DSH 根目录会话（工具维护等）
    const ignoredRule = matchPattern(map.ignored_cwd || [], cwd)
    if (ignoredRule) {
      // Review packets inventory every session. Preserve an explicit candidate
      // so this known tooling/temporary source is auditable as irrelevant,
      // rather than being reintroduced downstream as an unmapped risk.
      ignored.push({
        source: key,
        cwd,
        hint: ignoredRule.hint,
        tasks: [],
        ignored: true,
        suggested_decision: 'irrelevant',
        last: s.lastTs || s.lastTsMs || null,
        start: s.start || null,
      })
      continue
    }
    const rule = matchPattern(map.codex_cwd, cwd)
    if (rule) {
      hits.push({
        source: key,
        cwd,
        hint: rule.hint,
        tasks: rule.tasks || [],
        ...(rule.task_keywords ? { task_keywords: rule.task_keywords } : {}),
        last: s.lastTs || s.lastTsMs || null,
        start: s.start || null,
      })
    } else if (cwd) {
      unmapped.push(cwd)
    }
  }
  return { hits, ignored, unmapped: [...new Set(unmapped)] }
}

// 从飞书 markdown 提取群名并映射
function buildFeishuCandidates(feishuText, map) {
  const titles = []
  const re = /^##\s+(.+)$/gm
  let m
  while ((m = re.exec(feishuText))) titles.push(m[1].trim())
  const hits = []
  const unmappedGroups = new Set()
  for (const t of titles) {
    const ignored = matchPattern(map.ignored_feishu_chat || [], t)
    if (ignored) {
      // Keep the source row for full reconciliation/audit, but let the review
      // layer explain that this is a known non-business feed rather than an
      // apparent mapping failure.
      hits.push({ group: t, hint: ignored.hint, tasks: [], ignored: true, suggested_decision: 'irrelevant' })
      continue
    }
    const rule = matchPattern(map.feishu_chat, t)
    if (rule) hits.push({
      group: t,
      hint: rule.hint,
      tasks: rule.tasks || [],
      ...(rule.task_keywords ? { task_keywords: rule.task_keywords } : {}),
    })
    else unmappedGroups.add(t)
  }
  return { hits, unmappedGroups: [...unmappedGroups] }
}

function buildCandidates({ codexSessions, dshSessions, feishuText, board }) {
  const map = loadSourceMap()
  const codexCand = buildSessionCandidates(codexSessions, map, 'codex')
  const dshCand = buildSessionCandidates(dshSessions, map, 'dsh')
  const feishuCand = buildFeishuCandidates(feishuText, map)
  // 未排期 / 已逾期（Leader 核心痛点提示）
  const today = todayStr()
  const unscheduled = []
  const overdue = []
  for (const t of board || []) {
    if (['in_progress', 'blocked', 'paused'].includes(t.status)) {
      if (!t.expected_end_date) unscheduled.push(t.title)
      else if (t.expected_end_date < today) overdue.push({ title: t.title, due: t.expected_end_date })
    }
  }
  return {
    codex: [...codexCand.hits, ...codexCand.ignored],
    dsh: [...dshCand.hits, ...dshCand.ignored],
    feishu: feishuCand.hits,
    unmapped_cwd: [...codexCand.unmapped, ...dshCand.unmapped].filter((v, i, a) => a.indexOf(v) === i),
    unmapped_feishu_groups: feishuCand.unmappedGroups,
    unscheduled,
    overdue,
    all_sessions_accounted: !unmappedCwdRequired(codexCand.unmapped.concat(dshCand.unmapped)),
  }
}

function unmappedCwdRequired(unmapped) {
  // 任何未映射目录都需要显式确认；忽略策略统一放在 source-map.json，
  // 不在这里维护按目录名猜测的隐式白名单，避免漏掉新项目。
  return Array.isArray(unmapped) && unmapped.length > 0
}
export function run(cmd, args, timeoutMs = 120000, { stream = false } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let forceKillTimer = null
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
    }, timeoutMs)
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      resolve(result)
    }
    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      stdout += text
      if (stream) process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      if (stream) process.stderr.write(text)
    })
    child.once('error', (error) => finish({
      ok: false,
      stdout,
      stderr: stderr || error.message,
      code: error.code || null,
      timed_out: timedOut,
    }))
    child.once('close', (code, signal) => finish({
      ok: code === 0 && !timedOut,
      stdout,
      stderr,
      code: code ?? signal ?? null,
      timed_out: timedOut,
    }))
  })
}

function latestFile(dir, re, minMtime = 0) {
  if (!fs.existsSync(dir)) return null
  return fs.readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter(({ t }) => t >= minMtime)
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

// The exporter can recover a Messenger page mid-run and still finish every
// selected chat. Keep that useful diagnostic, but do not merge it into the
// success detail: downstream status views must distinguish “recovered” from
// “partial export / source failure”.
export function summarizeFeishuStep(output, fallback = '') {
  const lines = String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('>') && !line.startsWith('#') && !line.startsWith('[') && line.length < 200)
  const warningLines = lines.filter((line) => /重新加载飞书 Messenger 后再试/.test(line))
  const completionLines = lines.filter((line) => /^(完成：|Markdown 汇总)/.test(line))
  return {
    detail: (completionLines.length ? completionLines : lines.filter((line) => !warningLines.includes(line)).slice(-3)).join(' | ').slice(0, 400) || fallback,
    warning: warningLines.join(' | ').slice(0, 400) || null,
  }
}

export function parseFeishuCompletion(output) {
  const match = String(output || '').match(/完成：\s*(\d+)\s*个会话、\s*(\d+)\s*条消息/)
  return match
    ? { chats: Number(match[1]), messages: Number(match[2]) }
    : { chats: null, messages: null }
}

function feishuMessageCount(text) {
  return String(text || '').split('\n').filter((line) => /^- \*\*.+\*\* \(\d{2}:\d{2}\):/.test(line)).length
}

function filterFeishuGroupContent(content, cutoffMs) {
  const lines = String(content || '').split('\n')
  const keptByDate = new Map()
  let date = null
  let chunk = null
  const flush = () => {
    if (!chunk) return
    if (chunk.keep && chunk.date) {
      if (!keptByDate.has(chunk.date)) keptByDate.set(chunk.date, [])
      keptByDate.get(chunk.date).push(...chunk.lines)
    }
    chunk = null
  }
  for (const line of lines) {
    const dateMatch = line.match(/^###\s+(\d{4}-\d{2}-\d{2})\s*$/)
    if (dateMatch) {
      flush()
      date = dateMatch[1]
      continue
    }
    const messageMatch = line.match(/^- \*\*.+\*\* \((\d{2}:\d{2})\):/)
    if (messageMatch) {
      flush()
      const timestamp = date ? new Date(`${date}T${messageMatch[1]}:00+08:00`).getTime() : 0
      chunk = { date, keep: Number.isFinite(timestamp) && timestamp >= cutoffMs, lines: [line] }
      continue
    }
    if (chunk) chunk.lines.push(line)
  }
  flush()
  const out = []
  for (const [day, messages] of keptByDate) {
    out.push(`### ${day}`, '', ...messages)
  }
  return out.join('\n').trim()
}

// The exporter intentionally overlaps by calendar day so it cannot miss a
// message around midnight. Preserve that full scan for integrity checks, then
// expose only the minute-level delta to the review packet. Keeping the cursor
// minute inclusive avoids losing a message whose exporter timestamp has no
// seconds; at worst one boundary-minute message is reviewed twice.
export function filterFeishuMarkdownSince(text, sinceIso) {
  const groups = splitFeishuGroups(text)
  if (!sinceIso) {
    return {
      content: String(text || ''),
      raw_chat_count: groups.length,
      delta_chat_count: groups.length,
      delta_message_count: feishuMessageCount(text),
    }
  }
  const parsedCutoff = new Date(sinceIso).getTime()
  const cutoffMs = Number.isFinite(parsedCutoff) ? Math.floor(parsedCutoff / 60000) * 60000 : 0
  const kept = []
  let messageCount = 0
  for (const group of groups) {
    const content = filterFeishuGroupContent(group.content, cutoffMs)
    if (!content) continue
    messageCount += feishuMessageCount(content)
    kept.push(`## ${group.group}\n\n${content}`)
  }
  return {
    content: kept.join('\n\n'),
    raw_chat_count: groups.length,
    delta_chat_count: kept.length,
    delta_message_count: messageCount,
  }
}

async function main() {
  const pendingPlan = loadPendingPlan(PENDING_PLAN_FILE)
  const pendingBlock = pendingPrepareBlock(pendingPlan)
  if (pendingBlock) {
    throw new Error(`${pendingBlock.message}。为防止问题被新快照静默覆盖，本次 prepare 已停止；先运行 dashboard:pending -- show 续办，或在用户明确放弃后运行 dashboard:pending -- cancel --reason "原因"。`)
  }
  const steps = []
  // 说明：prepare 全程无状态重叠窗口（Codex/DSH 用 --since-time=分析游标、飞书用 --since=分析游标、
  // 本地文件自分析游标起）——不推进任何游标；分析游标仅由 verify 在「本快照已成功 apply」后推进。
  // (install-cron 仍可传 --no-advance，向后兼容、无副作用。)

  // ---- 1. 飞书导出（无状态重叠窗口）----
  // 用「自分析游标起」的无状态窗口（--since .reviewed_at 日期 + --no-update-state），
  // 不从/不推进飞书 .state.lastSync —— 消除「飞书游标过早推进导致增量丢失」的缺口。
  // --refresh-chats：强制重扫会话列表，避免缓存快照陈旧漏会话（如高琦）。
  // cron(--no-advance) 与手动 prepare 走同一无状态逻辑。
  const feishuArgs = buildFeishuArgs(LAST_AT, FEISHU_COOKIES, DAILY_DIR)
  const feishuStartedAt = Date.now()
  const feishuRes = fs.existsSync(FEISHU_COOKIES)
    ? await run(FEISHU_BIN, feishuArgs, FEISHU_TIMEOUT_MS, { stream: true })
    : { ok: false, stdout: '', stderr: 'cookies.json 不存在', code: 'MISSING_COOKIES', timed_out: false }
  const feishuIncomplete = feishuRes.ok && feishuOutputIncomplete(feishuRes.stdout)
  const feishuCompletion = parseFeishuCompletion(feishuRes.stdout)
  let feishuOk = feishuRes.ok && !feishuIncomplete
  // A successful command that produced no new file is still an empty source;
  // never reuse the previous range export as if it were current evidence.
  const freshFeishuFile = feishuOk ? latestFile(DAILY_DIR, /^range_.*\.md$/, feishuStartedAt - 2000) : null
  let feishuFile = freshFeishuFile
  let feishuText = ''
  let feishuRawChatCount = 0
  let feishuDeltaChatCount = 0
  let feishuDeltaMessageCount = 0
  if (feishuOk && feishuCompletion.chats > 0 && !feishuFile) {
    feishuOk = false
    feishuRes.stderr = `导出器报告 ${feishuCompletion.chats} 个会话，但没有生成新的 Markdown 文件；拒绝把缺失文件当作空增量`
  }
  if (feishuOk && feishuFile) {
    try {
      const rawFeishuText = fs.readFileSync(path.join(DAILY_DIR, feishuFile), 'utf8')
      const filtered = filterFeishuMarkdownSince(rawFeishuText, LAST_AT)
      feishuText = filtered.content
      feishuRawChatCount = filtered.raw_chat_count
      feishuDeltaChatCount = filtered.delta_chat_count
      feishuDeltaMessageCount = filtered.delta_message_count
      if (feishuCompletion.chats !== null && feishuCompletion.chats !== feishuRawChatCount) {
        feishuOk = false
        feishuRes.stderr = `导出器报告 ${feishuCompletion.chats} 个会话，但 Markdown 仅解析到 ${feishuRawChatCount} 个群；拒绝生成不完整快照`
      }
    } catch {
      feishuOk = false
      feishuRes.stderr = '飞书增量文件读取失败'
    }
  }
  ;({ file: feishuFile, content: feishuText } = feishuSnapshot({ ok: feishuOk, file: feishuFile, content: feishuText }))
  const feishuSummary = feishuOk ? summarizeFeishuStep(feishuRes.stdout, `文件 ${feishuFile}`) : null
  steps.push({
    name: '飞书增量导出',
    ok: feishuOk,
    detail: feishuOk ? feishuSummary.detail : feishuFailureDetail({ ...feishuRes, incomplete: feishuIncomplete }, FEISHU_COOKIES),
    ...(feishuSummary?.warning ? { warning: feishuSummary.warning } : {}),
    file: feishuFile,
  })

  // ---- 2. Codex 摘要（一次扫描即含完整审查字段）----
  const codexArgs = buildSummaryArgs(ROOT, 'codex-summary.js', DAYS, LAST_AT)
  const codexRes = await run('node', codexArgs, 240000)
  let codex = []
  let codexOk = false
  if (codexRes.ok) {
    const parsed = parseJsonArrayOutput(codexRes.stdout)
    codex = parsed.value
    codexOk = parsed.ok
    if (!parsed.ok) steps.push({ name: 'Codex 摘要', ok: false, detail: `摘要${parsed.detail}` })
  } else {
    steps.push({ name: 'Codex 摘要', ok: false, detail: codexRes.stderr.slice(0, 200) })
  }

  // ---- 3. DSH 摘要（一次扫描即含完整审查字段）----
  const dshArgs = buildSummaryArgs(ROOT, 'dsh-summary.js', DAYS, LAST_AT)
  const dshRes = await run('node', dshArgs, 240000)
  let dsh = []
  let dshOk = false
  if (dshRes.ok) {
    const parsed = parseJsonArrayOutput(dshRes.stdout)
    dsh = parsed.value
    dshOk = parsed.ok
    if (!parsed.ok) steps.push({ name: 'DSH 摘要', ok: false, detail: `摘要${parsed.detail}` })
  } else {
    steps.push({ name: 'DSH 摘要', ok: false, detail: dshRes.stderr.slice(0, 200) })
  }

  // ---- 4. 当前看板 ----
  const boardRes = await run('node', [path.join(ROOT, 'scripts', 'agent.js'), 'list', '--json'], 60000)
  let board = []
  let boardOk = false
  if (boardRes.ok) {
    const parsed = parseJsonArrayOutput(boardRes.stdout)
    board = parsed.value
    boardOk = parsed.ok
  }
  steps.push({ name: '当前看板', ok: boardOk, detail: boardOk ? `${board.length} 个任务` : (boardRes.ok ? `看板${parseJsonArrayOutput(boardRes.stdout).detail}` : boardRes.stderr.slice(0, 200)) })

  // ---- 5. 知识库 ----
  let knowledgeBase = ''
  let knowledgeBaseOk = false
  try {
    knowledgeBase = fs.readFileSync(path.join(ROOT, 'docs', 'KNOWLEDGE_BASE.md'), 'utf8')
    knowledgeBaseOk = true
  } catch {
    knowledgeBase = '（知识库读取失败）'
    steps.push({ name: '知识库', ok: false, detail: '文件读取失败' })
  }

  // ---- 5.5 第四数据源：本地新文件（Downloads/Desktop/Documents 白名单，仅元数据）----
  const localFiles = scanLocalFiles(LAST_AT ? new Date(LAST_AT).getTime() : 0)
  steps.push({ name: '本地新文件', ok: true, detail: `${localFiles.length} 个候选（自分析游标以来，元数据）` })

  // ---- 快照健康：任一关键源失败即 degraded（apply 默认拒绝对接快照）----
  const snapshot_health = isSnapshotHealthy({ feishuOk, codexOk, dshOk, boardOk, knowledgeBaseOk }) ? 'ok' : 'degraded'

  // ---- 候选提示（规则化线索，供 Agent 分析优先参考，降低从零提炼的漏/错）----
  const candidates = buildCandidates({ codexSessions: codex, dshSessions: dsh, feishuText, board })
  steps.push({ name: '候选提示', ok: true, detail: `codex命中${candidates.codex.length} dsh命中${candidates.dsh.length} 飞书群命中${candidates.feishu.length} 未映射目录${candidates.unmapped_cwd.length} 未排期${candidates.unscheduled.length} 逾期${candidates.overdue.length}` })

  // 摘要步骤报告：标准 JSON 已包含审查文本，并按最后活动时间纳入跨窗口长会话。
  if (!steps.some((s) => s.name === 'Codex 摘要')) {
    steps.push({ name: 'Codex 摘要', ok: true, detail: `${codex.length} 个增量（单次扫描，含跨窗口长会话）` })
  }
  if (!steps.some((s) => s.name === 'DSH 摘要')) {
    steps.push({ name: 'DSH 摘要', ok: true, detail: `${dsh.length} 个增量（单次扫描，含跨窗口长会话）` })
  }

  // ---- 打包 context ----
  // captured_at = 本次采集时间（仅记录快照，不再是增量游标）；
  // 分析游标在 .analysis-state.reviewed_at，由 verify 通过后推进。
  // incremental_since = 上次成功审查的时间点，保证分析/应用中断也不会丢增量。
  const capturedAt = new Date().toISOString()
  const ctx = {
    snapshot_id: capturedAt, // 本快照唯一标识；verify 用它校验「本快照是否已成功 apply」后才推游标
    captured_at: capturedAt,
    generated_at: capturedAt,
    incremental_since: LAST_AT,
    source_range_days: DAYS,
    snapshot_health,
    sources: {
      feishu: {
        ok: feishuOk,
        file: feishuFile,
        exported_chat_count: feishuCompletion.chats,
        exported_message_count: feishuCompletion.messages,
        parsed_chat_count: feishuRawChatCount,
        delta_chat_count: feishuDeltaChatCount,
        delta_message_count: feishuDeltaMessageCount,
      },
      codex: { ok: codexOk, count: codex.length },
      dsh: { ok: dshOk, count: dsh.length },
      board: { ok: boardOk, count: board.length },
      knowledge_base: { ok: knowledgeBaseOk },
      local_files: localFiles,
    },
    steps,
    feishu: { latest_file: feishuFile, content: redactSensitiveValue(feishuText) },
    codex: redactSensitiveValue(codex),
    dsh: redactSensitiveValue(dsh),
    candidates,
    board,
    knowledge_base: knowledgeBase.slice(0, 40000),
  }
  const reviewPacket = buildReviewPacket(ctx)
  const snapshotPersistence = persistSnapshotFiles({
    ctx,
    reviewPacket,
    files: {
      context: CONTEXT_FILE,
      packet: REVIEW_PACKET_FILE,
      lastHealthyContext: LAST_HEALTHY_CONTEXT_FILE,
      lastHealthyPacket: LAST_HEALTHY_PACKET_FILE,
    },
  })

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
  lines.push('', '## 候选提示（规则化线索，供分析优先参考）', '')
  const sessionCandidateRows = [...candidates.codex, ...candidates.dsh]
  const mappedSessionRows = sessionCandidateRows.filter((x) => !x.ignored)
  const ignoredSessionRows = sessionCandidateRows.filter((x) => x.ignored)
  lines.push(`- Codex/DSH 会话映射命中: ${mappedSessionRows.length}${ignoredSessionRows.length ? `；明确无关 ${ignoredSessionRows.length}` : ''}`)
  for (const x of sessionCandidateRows.slice(0, 8)) {
    lines.push(`  - ${x.cwd} → ${x.ignored ? '明确无关（保留审计）' : (x.tasks || ['(无候选)']).slice(0, 2).join(' / ') || '(按内容判断)'}`)
  }
  lines.push(`- 飞书群命中: ${candidates.feishu.length}`)
  for (const x of candidates.feishu.slice(0, 8)) {
    lines.push(`  - ${x.group} → ${(x.tasks || ['(按内容判断)']).slice(0, 2).join(' / ')}`)
  }
  if (candidates.unmapped_cwd.length) lines.push(`- ⚠️ 未映射工作目录（可能新任务/需确认）: ${candidates.unmapped_cwd.join(', ')}`)
  if (candidates.unscheduled.length) lines.push(`- 🟠 未排期活跃任务 ${candidates.unscheduled.length} 个（Leader 会问何时完成）`)
  if (candidates.overdue.length) lines.push(`- 🔴 已逾期 ${candidates.overdue.length} 个`)
  lines.push('', '## 下一步', '')
  lines.push('1. Agent 优先读取 `workflow/review-packet.json`，结合知识库做全量对账；不确定时按 source_id 展开原始证据')
  lines.push('2. 生成变更建议 `workflow/ops.json`（即使无变更也写完整 reconciliation + 空 ops）')
  lines.push('3. 执行 `npm run dashboard:apply -- --dry-run`，再运行 `npm run dashboard:publish -- preview` 并发给用户审核')
  lines.push('4. 仅用户明确回复“确认推送”后，运行 publish confirm → dashboard:apply')
  lines.push('5. 推送完成后执行 `npm run dashboard:verify` 校验', '')
  fs.writeFileSync(REPORT_FILE, lines.join('\n'))

  const failed = steps.filter((s) => !s.ok)
  if (failed.length > 0) {
    console.error(`[prepare] ⚠️ ${failed.length} 个步骤失败: ${failed.map((s) => `${s.name}（${s.detail}）`).join('、')}`)
  }
  console.log(`[prepare] ✅ 完成: ${CONTEXT_FILE}`)
  console.log(`[prepare] 审查包: ${REVIEW_PACKET_FILE}（${reviewPacket.counts.total} 条证据）`)
  console.log(snapshotPersistence.last_healthy_updated
    ? `[prepare] 最近健康快照已更新: ${LAST_HEALTHY_PACKET_FILE}`
    : `[prepare] 最近健康快照未改动（当前快照 ${snapshot_health}）`)
  console.log(`[prepare] 报告: ${REPORT_FILE}`)
  const notification = snapshotNotification({
    snapshotHealth: snapshot_health,
    failedCount: failed.length,
    noScheduleCount: noSchedule.length,
    lastHealthyAvailable: hasMatchingHealthySnapshot(LAST_HEALTHY_CONTEXT_FILE, LAST_HEALTHY_PACKET_FILE),
  })
  notify(notification.title, notification.body)
}

export { buildFeishuCandidates, buildSessionCandidates, unmappedCwdRequired }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[prepare] 未处理异常: ${error.message}`)
    process.exit(1)
  })
}
