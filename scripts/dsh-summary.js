#!/usr/bin/env node
// ============================================================
// DSH 工作摘要读取器
// 读取 ~/.dsh/sessions/ 下的会话记录（zstd 压缩 jsonl），
// 提取每个会话的工作目录、时间、用户真实请求，
// 输出为喂给 AI 的 Markdown 摘要或结构化 JSON。
//
// 用途：DSH 也是用户的日常办公 Agent（如排查 BI 平台问题），
//       它的会话记录同样是「真实工作进度」来源。
//
// 依赖：本机 zstd 命令（brew install zstd）
// 用法:
//   node scripts/dsh-summary.js --days 3
//   node scripts/dsh-summary.js --since 2026-08-14
//   node scripts/dsh-summary.js --days 3 --json
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')
const MAX_COMPRESSED_MB = 15 // 跳过超大压缩文件
const MAX_MSGS = 6 // 每会话最多提取的用户消息数

function parseArgs(argv) {
  const args = { days: 2, all: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--days') args.days = Number(argv[++i]) || 2
    else if (a === '--since') args.since = argv[++i]
    else if (a === '--since-time') args.sinceTime = argv[++i]
    else if (a === '--detail') args.detail = true
    else if (a === '--json') args.json = true
    else if (a === '--all') args.all = true
  }
  return args
}

function dayStamp(offsetDays) {
  const d = new Date()
  d.setDate(d.getDate() - offsetDays)
  return d.toISOString().slice(0, 10)
}

function collectFiles(minMtime = 0) {
  const files = []
  if (!fs.existsSync(SESSIONS_ROOT)) return files
  for (const grp of fs.readdirSync(SESSIONS_ROOT)) {
    const gp = path.join(SESSIONS_ROOT, grp)
    if (!fs.statSync(gp).isDirectory()) continue
    for (const sid of fs.readdirSync(gp)) {
      const sp = path.join(gp, sid)
      if (!fs.statSync(sp).isDirectory()) continue
      const f = path.join(sp, 'session.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      try {
        if (fs.statSync(f).mtimeMs >= minMtime) files.push(f)
      } catch {
        // 文件可能在扫描期间被清理，忽略
      }
    }
  }
  return files
}

// 过滤系统注入/工具通知，保留用户真实请求
function isSystemText(text) {
  const t = String(text).trim()
  if (!t) return true
  if (t.startsWith('Current runtime context')) return true
  if (t.startsWith('background job ') || t.startsWith('Background subagent')) return true
  if (t.startsWith('Subagent ') || t.startsWith('subagent_fork')) return true
  if (t.startsWith('Interrupted by user') || t.startsWith('Timed out')) return true
  if (/^<[a-z_]+>/.test(t)) return true
  if (t.startsWith('Reply with exactly OK')) return true
  return false
}

function summarizeSession(file) {
  let size = 0
  let fileMtime = 0
  try {
    size = fs.statSync(file).size
    fileMtime = fs.statSync(file).mtimeMs
  } catch {
    return null
  }
  if (size > MAX_COMPRESSED_MB * 1024 * 1024) return null

  let buf
  try {
    buf = execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' })
  } catch (e) {
    console.error(`[dsh-summary] ⚠️ 解压失败，跳过: ${file}（${e.message}）`)
    return null
  }

  const meta = { cwd: '', start: 0, id: '' }
  const userMsgs = []
  let lastTsMs = 0
  for (const raw of buf.split('\n')) {
    if (!raw.trim()) continue
    let e
    try {
      e = JSON.parse(raw)
    } catch {
      continue
    }
    const type = e.type
    const ts = e.createdAt || e.data?.createdAt || 0
    if (typeof ts === 'number' && ts > lastTsMs) lastTsMs = ts
    if (type === 'session' && !meta.cwd) {
      meta.cwd = e.cwd || ''
      meta.start = e.createdAt || 0
      meta.id = e.id || ''
    } else if (type === 'user/message' && userMsgs.length < MAX_MSGS) {
      for (const c of e.data?.content || []) {
        if (c.type !== 'text') continue
        const text = c.text || ''
        if (!isSystemText(text)) {
          userMsgs.push(text.trim().slice(0, 4000))
          break
        }
      }
    }
  }
  if (!meta.cwd) return null
  return {
    file,
    start: meta.start ? new Date(meta.start + 8 * 3600 * 1000).toISOString() : '',
    lastTsMs,           // 最后一条事件时间（UTC ms）——增量判断用
    fileMtime,          // 压缩文件最后写入（ms）——跨窗口长会话仍被写入时兜底
    cwd: meta.cwd,
    sessionId: meta.id,
    userMsgs,
  }
}

function shortPath(p, home) {
  if (!p) return '?'
  if (p.startsWith(home)) return '~' + p.slice(home.length)
  return p
}

function renderMarkdown(sessions, home) {
  const lines = ['# DSH 工作摘要（自动生成）', '']
  if (sessions.length === 0) {
    lines.push('（该时间段内没有 DSH 会话）', '')
    return lines.join('\n')
  }
  for (const s of sessions) {
    const t = s.start ? s.start.slice(0, 16).replace('T', ' ') : '?'
    lines.push(`## ${t} @ ${shortPath(s.cwd, home)}`, '')
    if (s.userMsgs.length > 0) {
      if (args.detail) {
        for (const r of s.userMsgs) lines.push(`用户: ${r.slice(0, 3000).replace(/\n/g, '\n       ')}`, '')
      } else {
        lines.push(`用户: ${s.userMsgs[0].slice(0, 300).replace(/\n/g, ' ')}`, '')
      }
    } else {
      lines.push('用户: （无文本请求 / 工具调试会话）', '')
    }
    lines.push('')
  }
  return lines.join('\n')
}

const args = parseArgs(process.argv.slice(2))
const home = os.homedir()
// --all 扫描全部；--since 从指定日期起；否则最近 N 天
const since = args.all ? '0000-01-01' : args.sinceTime ? args.sinceTime.slice(0, 10) : args.since ? args.since : dayStamp(args.days)
const sinceMs = args.sinceTime ? new Date(args.sinceTime).getTime() : 0
console.error(`[dsh-summary] 扫描 ${since} 之后的 DSH 会话…`)

// 先按文件 mtime 缩小候选集，再解压 JSONL；保留一天缓冲以覆盖跨午夜续写的长会话。
const windowStartMs = args.all
  ? 0
  : new Date(`${since.slice(0, 10)}T00:00:00Z`).getTime() - 86400000
const files = collectFiles(windowStartMs)
let sessions = files
  .map(summarizeSession)
  .filter(Boolean)
  .filter((s) => !since || (s.start && s.start.slice(0, 10) >= since))
  // 增量模式：会话在窗口内有「任何」活动才算增量——开始时间、最后一条事件、
  // 或文件仍被写入（跨窗口长会话）。start 已是北京时间，比较前换算回 UTC。
  .filter((s) => {
    if (!sinceMs) return true
    const startMs = new Date(s.start).getTime() - 8 * 3600 * 1000
    return startMs > sinceMs || (s.lastTsMs && s.lastTsMs > sinceMs) || (s.fileMtime && s.fileMtime > sinceMs)
  })
    // 排序按「文件最后写入(mtime)」降序：DSH 会话的 createdAt/lastTs 可能不随续写更新（长会话会徽事件时间戳停在
  // 创建日），只有 mtime 反映真实活动。must按 start/lastTs 排序会漏掉近期仍在干的 long 会话（如 8/18 更新 8/14 开的会话）。
  .sort((a, b) => (b.fileMtime || 0) - (a.fileMtime || 0))

if (args.detail) {
  sessions = sessions.slice(0, 5)
} else {
  sessions = sessions.slice(0, 20)
}

if (args.json) {
  console.log(JSON.stringify(sessions, null, 2))
} else {
  console.log(renderMarkdown(sessions, home))
}
console.error(`[dsh-summary] 共 ${sessions.length} 个会话（扫描 ${files.length} 个文件）`)
