#!/usr/bin/env node
// ============================================================
// Codex 工作摘要读取器
// 读取 ~/.codex/sessions/ 下的会话记录，提取每个会话的
// 工作目录、用户请求、关键动作（git commit/文件写入/命令），
// 输出为喂给 AI 的 Markdown 摘要或结构化 JSON。
//
// 用途：作为「DSH 看 Codex」的桥梁——把用户实际在 Codex 里
//       干的活（真实工作进度）暴露给看板分析流程。
//
// 用法:
//   node scripts/codex-summary.js --days 3         最近 3 天（默认 2）
//   node scripts/codex-summary.js --since 2026-08-15 从某天起
//   node scripts/codex-summary.js --days 3 --json  结构化输出
//   node scripts/codex-summary.js --all            不限制时间（可能很慢）
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions')
const MAX_LINES = 6000 // 单会话最多读取行数（超大文件保护）
const MAX_FILE_MB = 60 // 超过此大小只读头部

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

function collectSessionFiles(sinceISO) {
  const files = []
  if (!fs.existsSync(SESSIONS_ROOT)) return files
  for (const y of fs.readdirSync(SESSIONS_ROOT)) {
    if (!/^\d{4}$/.test(y)) continue
    const yp = path.join(SESSIONS_ROOT, y)
    if (!fs.statSync(yp).isDirectory()) continue
    for (const m of fs.readdirSync(yp)) {
      if (!/^\d{2}$/.test(m)) continue
      const mp = path.join(yp, m)
      if (!fs.statSync(mp).isDirectory()) continue
      for (const d of fs.readdirSync(mp)) {
        if (!/^\d{2}$/.test(d)) continue
        const dp = path.join(mp, d)
        if (!fs.statSync(dp).isDirectory()) continue
        for (const fn of fs.readdirSync(dp)) {
          if (!fn.startsWith('rollout-') || !fn.endsWith('.jsonl')) continue
          // rollout-2026-08-13T20-04-21-xxx.jsonl
          const m2 = fn.match(/^rollout-(\d{4}-\d{2}-\d{2})T/)
          if (!m2) continue
          const stamp = m2[1]
          if (stamp >= sinceISO) files.push(path.join(dp, fn))
        }
      }
    }
  }
  return files.sort()
}

function stripSystemText(text) {
  // 去掉 Codex 注入的系统上下文（<app-context> <recommended_plugins> <environment_context> 等）
  // 规则：独立成行的 <tag> 进入跳过块，直到 </tag>；行内 <tag> 前缀也跳过
  const lines = String(text).split('\n')
  const out = []
  let skip = false
  for (const ln of lines) {
    const t = ln.trim()
    if (/^<\/[a-z_]+>$/.test(t)) {
      skip = false
      continue
    }
    if (/^<[a-z_]+>$/.test(t)) {
      skip = true
      continue
    }
    if (skip) continue
    if (/^<[a-z_]+>/.test(t)) continue
    if (t === '' && out.length === 0) continue
    out.push(ln)
  }
  return out.join('\n').trim()
}

function summarizeSession(file) {
  const meta = { cwd: '', start: '', originator: '' }
  const userReqs = []
  const actions = [] // {type, detail}
  let lastTs = ''
  let linesRead = 0
  let truncated = false
  let fileBytes = 0
  try {
    fileBytes = fs.statSync(file).size
  } catch {
    return null
  }
  const limit = fileBytes > MAX_FILE_MB * 1024 * 1024 ? 2500 : MAX_LINES

  const raw = fs.readFileSync(file, 'utf8')
  for (const line of raw.split('\n')) {
    linesRead++
    if (linesRead > limit) {
      truncated = true
      break
    }
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const ts = e.timestamp || ''
    if (ts) lastTs = ts
    const type = e.type
    if (type === 'session_meta') {
      const p = e.payload || {}
      meta.cwd = p.cwd || ''
      meta.start = p.timestamp || ts
      meta.originator = p.originator || ''
    } else if (type === 'response_item') {
      const p = e.payload || {}
      if (p.type === 'message') {
        const role = p.role
        for (const c of p.content || []) {
          if (c.type === 'input_text' && role === 'user') {
            const text = stripSystemText(c.text || '')
            if (text) userReqs.push(text.slice(0, 400))
          }
        }
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const name = p.name || p.tool_name || ''
        let args = p.arguments || p.input || {}
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch {
            // 参数可能是 JS 文本而非 JSON：用正则提取关键字段
            const mCmd = args.match(/command["']?\s*[:=]\s*["']([^"']{0,140})/)
            const mPath = args.match(/file_path["']?\s*[:=]\s*["']([^"']{0,120})/)
            args = {
              ...(mCmd ? { command: mCmd[1] } : {}),
              ...(mPath ? { file_path: mPath[1] } : {}),
              _raw: args.slice(0, 200),
            }
          }
        }
        let detail = ''
        if (name.includes('shell') || args.command) {
          detail = `shell: ${String(args.command || '').slice(0, 140)}`
        } else if (name.includes('write') || args.file_path) {
          detail = `write: ${String(args.file_path || '').slice(0, 120)}`
        } else if (name.includes('git')) {
          detail = `git: ${String(args.command || args.description || '').slice(0, 140)}`
        } else {
          detail = `${name}: ${JSON.stringify(args).slice(0, 120)}`
        }
        if (detail && actions.length < 12) actions.push({ type: name, detail })
      }
    }
  }

  const startTs = meta.start || ''
  const durMin = startTs && lastTs
    ? Math.max(0, Math.round((new Date(lastTs) - new Date(startTs)) / 60000))
    : null

  // 提取 git commit 消息（shell 命令里的 git commit -m）
  const commits = []
  for (const a of actions) {
    const m = a.detail.match(/git commit[^"]*?-m ["']([^"']{0,120})/)
    if (m) commits.push(m[1])
  }

  return {
    file,
    start: startTs,
    durationMin: durMin,
    cwd: meta.cwd,
    originator: meta.originator,
    userReqs,
    commits: commits.slice(0, 5),
    actionCount: actions.length,
    linesRead,
    truncated,
  }
}

// ---------- 输出 ----------

function shortPath(p, home) {
  if (!p) return '?'
  if (p.startsWith(home)) return '~' + p.slice(home.length)
  return p
}

function renderMarkdown(sessions, home) {
  const lines = ['# Codex 工作摘要（自动生成）', '']
  if (sessions.length === 0) {
    lines.push('（该时间段内没有 Codex 会话）', '')
    return lines.join('\n')
  }
  for (const s of sessions) {
    const t = s.start ? s.start.slice(0, 16).replace('T', ' ') : '?'
    const dur = s.durationMin != null ? `${s.durationMin} 分钟` : '?'
    lines.push(`## ${t}（约 ${dur}）@ ${shortPath(s.cwd, home)}`, '')
    if (s.originator) lines.push(`> 来源: ${s.originator}`)
    if (s.userReqs.length > 0) {
      lines.push(`用户: ${s.userReqs[0].slice(0, 300).replace(/\n/g, ' ')}`, '')
      if (s.userReqs.length > 1) {
        const last = s.userReqs[s.userReqs.length - 1].slice(0, 220).replace(/\n/g, ' ')
        lines.push(`最新进展: ${last}`, '')
      }
    } else {
      lines.push('用户: （无文本请求，可能为工具调试会话）', '')
    }
    if (s.truncated) {
      lines.push('⚠️ 会话过大，仅读取了前段（可能遗漏最新内容）', '')
    }
    if (s.commits.length > 0) {
      lines.push('提交:')
      for (const c of s.commits) lines.push(`  - git commit "${c}"`)
      lines.push('')
    }
    if (s.actionCount > 0) {
      lines.push(`动作数: ${s.actionCount}（详见 JSON 模式）`, '')
    }
    lines.push('')
  }
  return lines.join('\n')
}

// ---------- 主流程 ----------

const args = parseArgs(process.argv.slice(2))
const home = os.homedir()
// --all 扫描全部历史；--since 从指定日期起；否则最近 N 天
const since = args.all ? '0000-01-01' : args.since ? `${args.since}T00:00:00` : dayStamp(args.days)
console.error(`[codex-summary] 扫描 ${since.slice(0, 10)} 之后的 Codex 会话…`)

const files = collectSessionFiles(since.slice(0, 10))
const sessions = files
  .map(summarizeSession)
  .filter(Boolean)
  .sort((a, b) => (b.start || '').localeCompare(a.start || ''))
  .slice(0, 20)

if (args.json) {
  console.log(JSON.stringify(sessions, null, 2))
} else {
  console.log(renderMarkdown(sessions, home))
}
console.error(`[codex-summary] 共 ${sessions.length} 个会话（扫描 ${files.length} 个文件）`)
