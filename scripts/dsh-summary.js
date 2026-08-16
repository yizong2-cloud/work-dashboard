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

function collectFiles() {
  const files = []
  if (!fs.existsSync(SESSIONS_ROOT)) return files
  for (const grp of fs.readdirSync(SESSIONS_ROOT)) {
    const gp = path.join(SESSIONS_ROOT, grp)
    if (!fs.statSync(gp).isDirectory()) continue
    for (const sid of fs.readdirSync(gp)) {
      const sp = path.join(gp, sid)
      if (!fs.statSync(sp).isDirectory()) continue
      const f = path.join(sp, 'session.jsonl.zstd')
      if (fs.existsSync(f)) files.push(f)
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
  try {
    size = fs.statSync(file).size
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
  for (const raw of buf.split('\n')) {
    if (!raw.trim()) continue
    let e
    try {
      e = JSON.parse(raw)
    } catch {
      continue
    }
    const type = e.type
    if (type === 'session' && !meta.cwd) {
      meta.cwd = e.cwd || ''
      meta.start = e.createdAt || 0
      meta.id = e.id || ''
    } else if (type === 'user/message' && userMsgs.length < MAX_MSGS) {
      for (const c of e.data?.content || []) {
        if (c.type !== 'text') continue
        const text = c.text || ''
        if (!isSystemText(text)) {
          userMsgs.push(text.trim().slice(0, 500))
          break
        }
      }
    }
  }
  if (!meta.cwd) return null
  return {
    file,
    start: meta.start ? new Date(meta.start + 8 * 3600 * 1000).toISOString() : '',
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
      lines.push(`用户: ${s.userMsgs[0].slice(0, 300).replace(/\n/g, ' ')}`, '')
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
const since = args.all ? '0000-01-01' : args.since ? args.since : dayStamp(args.days)
console.error(`[dsh-summary] 扫描 ${since} 之后的 DSH 会话…`)

const files = collectFiles()
const sessions = files
  .map(summarizeSession)
  .filter(Boolean)
  .filter((s) => !since || (s.start && s.start.slice(0, 10) >= since))
  .sort((a, b) => (b.start || '').localeCompare(a.start || ''))
  .slice(0, 20)

if (args.json) {
  console.log(JSON.stringify(sessions, null, 2))
} else {
  console.log(renderMarkdown(sessions, home))
}
console.error(`[dsh-summary] 共 ${sessions.length} 个会话（扫描 ${files.length} 个文件）`)
