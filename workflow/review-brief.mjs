#!/usr/bin/env node
// Compact, complete review inventory for Agent context. It deliberately reads
// only review-packet.json (never raw update-context evidence) and keeps every
// source_id visible, so using a brief cannot silently weaken reconciliation.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_REVIEW_FILE = path.join(ROOT, 'workflow', 'review-packet.json')
const EXCERPT_LIMIT = 220

function taskIndex(board) {
  return new Map((board || []).map((task) => [task.title, task.id]))
}

function shortExcerpt(value) {
  const text = String(value || '（无短摘录；按 source_id 展开证据）').replace(/\s+/g, ' ').trim()
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text
}

function candidateText(item, tasks) {
  const candidates = Array.isArray(item?.candidate_tasks) ? item.candidate_tasks : []
  if (!candidates.length) return null
  return candidates.map((title) => `${title}${tasks.get(title) ? `（${tasks.get(title)}）` : ''}`).join(' / ')
}

function itemLines(item, tasks) {
  const lines = [`- ${item.source_id} · ${item.review_reason || '未知原因'} · ${item.label || '未命名来源'}`]
  const candidates = candidateText(item, tasks)
  if (candidates) lines.push(`  候选（仍需核对）：${candidates}`)
  if (item.suggested_decision) lines.push(`  建议结论：${item.suggested_decision}（显式规则，不是自动写入）`)
  lines.push(`  摘录：${shortExcerpt(item.excerpt)}`)
  return lines
}

export function formatReviewBrief(packet) {
  if (!packet || !Array.isArray(packet.review_items)) return '❌ 找不到有效 review-packet.json；请先运行 npm run dashboard:prepare。'
  const tasks = taskIndex(packet.board)
  const items = packet.review_items
  const high = items.filter((item) => item.review_priority === 'high')
  const suggestedIrrelevant = items.filter((item) => item.suggested_decision === 'irrelevant')
  const low = items.filter((item) => item.review_priority !== 'high' && item.suggested_decision !== 'irrelevant')
  const lines = [
    '🧭 审查简报（只读；尚未写入看板或发送飞书）',
    `快照：${packet.snapshot_id || '未知'} · 证据 ${items.length} 条 · 需判断 ${high.length} 条`,
    '使用此简报时，仍必须在 ops.json 为每一个 source_id 写唯一 reconciliation；不清楚的单项才用 dashboard:evidence 展开。',
  ]
  if (suggestedIrrelevant.length) {
    lines.push('', `## 明确无关（${suggestedIrrelevant.length} 条，保留审计后可按建议快速结案）`)
    for (const item of suggestedIrrelevant) lines.push(...itemLines(item, tasks))
  }
  if (low.length) {
    lines.push('', `## 低歧义线索（${low.length} 条，候选仅供参考，仍须核对）`)
    for (const item of low) lines.push(...itemLines(item, tasks))
  }
  if (high.length) {
    lines.push('', `## 需要判断（${high.length} 条）`)
    for (const item of high) lines.push(...itemLines(item, tasks))
  }
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = { file: DEFAULT_REVIEW_FILE }
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--file') args.file = argv[++index]
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  const { file } = parseArgs(argv)
  try {
    console.log(formatReviewBrief(JSON.parse(fs.readFileSync(file, 'utf8'))))
  } catch {
    console.error('❌ 找不到有效 review-packet.json；请先运行 npm run dashboard:prepare。')
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
