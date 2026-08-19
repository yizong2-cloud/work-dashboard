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
import { buildReviewPacket } from './review-packet.mjs'
import { redactSensitiveValue } from './redaction.mjs'
import { feishuFailureDetail, feishuOutputIncomplete, feishuSnapshot } from './source-safety.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()
const FEISHU_BIN = path.join(HOME, 'feishu_export', 'bin', 'feishu-export')
const FEISHU_COOKIES = path.join(HOME, 'feishu_export', 'cookies.json')
const DAILY_DIR = path.join(HOME, 'feishu_export', 'daily')
const DAYS = 3
const configuredFeishuTimeout = Number(process.env.WORKBOARD_FEISHU_TIMEOUT_MS || 120000)
const FEISHU_TIMEOUT_MS = Number.isFinite(configuredFeishuTimeout) && configuredFeishuTimeout > 0 ? configuredFeishuTimeout : 120000
const CONTEXT_FILE = path.join(ROOT, 'workflow', 'update-context.json')
const REVIEW_PACKET_FILE = path.join(ROOT, 'workflow', 'review-packet.json')
const ANALYSIS_STATE = path.join(ROOT, 'workflow', '.analysis-state.json')

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
// 增量窗口起点：分析游标（无则退化最近 3 天由 codex/dsh 的 --days 兜底）
const LAST_AT = readAnalysisState().reviewed_at || null
const REPORT_FILE = path.join(ROOT, 'workflow', 'latest-report.md')

// 第四数据源：本地常见放文档/素材/产物的目录（白名单，只收集元数据不含内容）
const LOCAL_DIRS = [path.join(HOME, 'Downloads'), path.join(HOME, 'Desktop'), path.join(HOME, 'Documents')]
const LOCAL_EXT = /\.(apk|pdf|md|docx?|xlsx?|pptx?|zip|html?|png|jpe?g|webp|gif|mp4|txt|jsx?|tsx?|json|svg)$/i

// 扫描白名单目录里「自分析游标以来」修改过的文件，输出候选清单（path/mtime/size/ext）。
// 只收集元数据，不把文件内容直接送入模型，避免无关/隐私文件泄漏。
function scanLocalFiles(sinceMs) {
  const out = []
  if (!sinceMs) return out
  const minMtime = sinceMs - 6 * 3600 * 1000 // 缓冲 6h，防止跨午夜/边界漏
  for (const dir of LOCAL_DIRS) {
    if (!fs.existsSync(dir)) continue
    let entries
    try { entries = fs.readdirSync(dir) } catch { continue }
    for (const fn of entries) {
      if (fn.startsWith('.')) continue
      if (!LOCAL_EXT.test(fn)) continue
      const fp = path.join(dir, fn)
      let st
      try { st = fs.statSync(fp) } catch { continue }
      if (st.isFile() && st.mtimeMs >= minMtime) {
        out.push({ path: fp, name: fn, mtime: new Date(st.mtimeMs).toISOString(), size: st.size, ext: fn.split('.').pop().toLowerCase() })
      }
    }
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime))
}

// ============ 候选提示（LLM 职责收缩：先用规则化映射给 Agent 线索，而非从零提炼）============

function loadSourceMap() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow', 'source-map.json'), 'utf8'))
  } catch {
    return { ignored_cwd: [], codex_cwd: [], feishu_chat: [] }
  }
}

function matchPattern(list, str) {
  const low = String(str || '').toLowerCase()
  for (const rule of list) {
    if (rule.pattern && low.includes(rule.pattern.toLowerCase())) return rule
  }
  return null
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 从 codex_detail / dsh_detail 会话（含 cwd）生成候选；unmapped 收集未映射目录提醒
function buildSessionCandidates(sessions, map, key) {
  const hits = []
  const unmapped = []
  for (const s of sessions) {
    const cwd = s.cwd || ''
    if (cwd.includes('Documents/Codex')) continue // 临时/测试会话
    if (cwd === HOME || cwd === `${HOME}/`) continue // DSH 根目录会话（工具维护等）
    if (matchPattern(map.ignored_cwd || [], cwd)) continue // source-map 明确标注的工具维护目录
    const rule = matchPattern(map.codex_cwd, cwd)
    if (rule) {
      hits.push({ source: key, cwd, hint: rule.hint, tasks: rule.tasks || [], last: s.lastTs || s.lastTsMs || null, start: s.start || null })
    } else if (cwd) {
      unmapped.push(cwd)
    }
  }
  return { hits, unmapped: [...new Set(unmapped)] }
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
    const rule = matchPattern(map.feishu_chat, t)
    if (rule) hits.push({ group: t, hint: rule.hint, tasks: rule.tasks || [] })
    else unmappedGroups.add(t)
  }
  return { hits, unmappedGroups: [...unmappedGroups] }
}

function buildCandidates({ codexDetail, dshDetail, feishuText, localFiles, board }) {
  const map = loadSourceMap()
  const codexCand = buildSessionCandidates(codexDetail, map, 'codex')
  const dshCand = buildSessionCandidates(dshDetail, map, 'dsh')
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
    codex: codexCand.hits,
    dsh: dshCand.hits,
    feishu: feishuCand.hits,
    unmapped_cwd: [...codexCand.unmapped, ...dshCand.unmapped].filter((v, i, a) => a.indexOf(v) === i),
    unmapped_feishu_groups: feishuCand.unmappedGroups,
    unscheduled,
    overdue,
    all_sessions_accounted: !unmappedCwdRequired(codexCand.unmapped.concat(dshCand.unmapped)),
  }
}

function unmappedCwdRequired(unmapped) {
  // 有未映射的工作目录（且非 Downloads 素材）才需要提示
  return unmapped.some((c) => !c.includes('Downloads') && !c.includes('Documents') && !c.includes('StudioProjects') && !c.includes('IdeaProjects'))
}
function run(cmd, args, timeoutMs = 120000) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs })
    return { ok: true, stdout: String(stdout), stderr: '' }
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || ''),
      stderr: String(e.stderr || e.message || ''),
      code: e.code || null,
      timed_out: e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM',
    }
  }
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

function main() {
  const steps = []
  // 说明：prepare 全程无状态重叠窗口（Codex/DSH 用 --since-time=分析游标、飞书用 --since=分析游标、
  // 本地文件自分析游标起）——不推进任何游标；分析游标仅由 verify 在「本快照已成功 apply」后推进。
  // (install-cron 仍可传 --no-advance，向后兼容、无副作用。)

  // ---- 1. 飞书导出（无状态重叠窗口）----
  // 用「自分析游标起」的无状态窗口（--since .reviewed_at 日期 + --no-update-state），
  // 不从/不推进飞书 .state.lastSync —— 消除「飞书游标过早推进导致增量丢失」的缺口。
  // --refresh-chats：强制重扫会话列表，避免缓存快照陈旧漏会话（如高琦）。
  // cron(--no-advance) 与手动 prepare 走同一无状态逻辑。
  const reviewedDate = LAST_AT ? LAST_AT.slice(0, 10) : null
  const feishuArgs = reviewedDate
    ? ['--since', `${reviewedDate}T00:00`, '--refresh-chats', '--markdown', '--no-update-state']
    : ['--today', '--refresh-chats', '--markdown', '--no-update-state']
  const feishuStartedAt = Date.now()
  const feishuRes = fs.existsSync(FEISHU_COOKIES)
    ? run(FEISHU_BIN, feishuArgs, FEISHU_TIMEOUT_MS)
    : { ok: false, stdout: '', stderr: 'cookies.json 不存在', code: 'MISSING_COOKIES', timed_out: false }
  const feishuIncomplete = feishuRes.ok && feishuOutputIncomplete(feishuRes.stdout)
  const feishuOk = feishuRes.ok && !feishuIncomplete
  // A successful command that produced no new file is still an empty source;
  // never reuse the previous range export as if it were current evidence.
  const freshFeishuFile = feishuOk ? latestFile(DAILY_DIR, /^range_.*\.md$/, feishuStartedAt - 2000) : null
  let feishuFile = freshFeishuFile
  let feishuText = ''
  if (feishuOk && feishuFile) {
    try {
      feishuText = fs.readFileSync(path.join(DAILY_DIR, feishuFile), 'utf8').slice(0, 30000)
    } catch {
      feishuText = '（飞书增量文件读取失败）'
    }
  }
  ;({ file: feishuFile, content: feishuText } = feishuSnapshot({ ok: feishuOk, file: feishuFile, content: feishuText }))
  steps.push({
    name: '飞书增量导出',
    ok: feishuOk,
    detail: feishuOk ? summarizeStep(feishuRes.stdout) || `文件 ${feishuFile}` : feishuFailureDetail({ ...feishuRes, incomplete: feishuIncomplete }, FEISHU_COOKIES),
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

  // ---- 5.5 第四数据源：本地新文件（Downloads/Desktop/Documents 白名单，仅元数据）----
  const localFiles = scanLocalFiles(LAST_AT ? new Date(LAST_AT).getTime() : 0)
  steps.push({ name: '本地新文件', ok: true, detail: `${localFiles.length} 个候选（自分析游标以来，元数据）` })

  // ---- 快照健康：任一关键源失败即 degraded（apply 默认拒绝对接快照）----
  const codexOk = !codexRes || codexRes.ok
  const dshOk = !dshRes || dshRes.ok
  const snapshot_health = feishuOk && codexOk && dshOk ? 'ok' : 'degraded'

  // ---- 详情：增量窗口内会话的完整对话内容（分析者第一步就能看到具体说了什么）----
  const detailArgs = (extra) => [path.join(ROOT, 'scripts', extra), '--days', String(DAYS), '--detail', '--json']
  const codexDetailRes = run('node', detailArgs('codex-summary.js'), 240000)
  const dshDetailRes = run('node', detailArgs('dsh-summary.js'), 240000)
  let codexDetail = []
  let dshDetail = []
  try { codexDetail = JSON.parse(codexDetailRes.stdout) } catch { codexDetail = [] }
  try { dshDetail = JSON.parse(dshDetailRes.stdout) } catch { dshDetail = [] }

  // ---- 候选提示（规则化线索，供 Agent 分析优先参考，降低从零提炼的漏/错）----
  const candidates = buildCandidates({ codexDetail, dshDetail, feishuText, localFiles, board })
  steps.push({ name: '候选提示', ok: true, detail: `codex命中${candidates.codex.length} dsh命中${candidates.dsh.length} 飞书群命中${candidates.feishu.length} 未映射目录${candidates.unmapped_cwd.length} 未排期${candidates.unscheduled.length} 逾期${candidates.overdue.length}` })

  // 摘要步骤报告（增量数 + 三日窗口 detail 数；增量可能为 0 但窗口内仍有长会话内容）
  if (!steps.some((s) => s.name === 'Codex 摘要')) {
    steps.push({ name: 'Codex 摘要', ok: true, detail: `${codex.length} 个增量（三日窗口共 ${codexDetail.length} 个，含跨窗口长会话）` })
  }
  if (!steps.some((s) => s.name === 'DSH 摘要')) {
    steps.push({ name: 'DSH 摘要', ok: true, detail: `${dsh.length} 个增量（三日窗口共 ${dshDetail.length} 个，含跨窗口长会话）` })
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
      feishu: { ok: feishuOk, file: feishuFile },
      codex: { ok: codexOk, count: codex.length },
      dsh: { ok: dshOk, count: dsh.length },
      local_files: localFiles,
    },
    steps,
    feishu: { latest_file: feishuFile, content: redactSensitiveValue(feishuText) },
    codex: redactSensitiveValue(codex),
    dsh: redactSensitiveValue(dsh),
    codex_detail: redactSensitiveValue(codexDetail),
    dsh_detail: redactSensitiveValue(dshDetail),
    candidates,
    board,
    knowledge_base: knowledgeBase.slice(0, 40000),
  }
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2))
  const reviewPacket = buildReviewPacket(ctx)
  fs.writeFileSync(REVIEW_PACKET_FILE, JSON.stringify(reviewPacket, null, 2))

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
  lines.push(`- Codex/DSH 会话映射命中: ${candidates.codex.length + candidates.dsh.length}`)
  for (const x of [...candidates.codex, ...candidates.dsh].slice(0, 8)) {
    lines.push(`  - ${x.cwd} → ${(x.tasks || ['(无候选)']).slice(0, 2).join(' / ') || '(按内容判断)'}`)
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
  lines.push('3. 执行 `npm run dashboard:apply`（可先 `--dry-run`）')
  lines.push('4. 执行 `npm run dashboard:verify` 校验', '')
  fs.writeFileSync(REPORT_FILE, lines.join('\n'))

  const failed = steps.filter((s) => !s.ok)
  if (failed.length > 0) {
    console.error(`[prepare] ⚠️ ${failed.length} 个步骤失败: ${failed.map((s) => `${s.name}（${s.detail}）`).join('、')}`)
  }
  console.log(`[prepare] ✅ 完成: ${CONTEXT_FILE}`)
  console.log(`[prepare] 审查包: ${REVIEW_PACKET_FILE}（${reviewPacket.counts.total} 条证据）`)
  console.log(`[prepare] 报告: ${REPORT_FILE}`)
  if (noSchedule.length > 0) {
    notify('看板数据已就绪', `${noSchedule.length} 个活跃任务未排期；数据源已拉取，可说"开始更新"`)
  } else {
    notify('看板数据已就绪', '数据源已拉取，可说"开始更新"')
  }
}

export { buildSessionCandidates, unmappedCwdRequired }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
