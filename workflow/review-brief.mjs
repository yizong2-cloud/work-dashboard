#!/usr/bin/env node
// Compact, complete review inventory for Agent context. It deliberately reads
// only review-packet.json (never raw update-context evidence) and keeps every
// source_id visible, so using a brief cannot silently weaken reconciliation.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateReconciliation } from './review-packet.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_REVIEW_FILE = path.join(ROOT, 'workflow', 'review-packet.json')
export const DEFAULT_CHANGESET_FILE = path.join(ROOT, 'workflow', 'last-changeset.json')
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
  if (item.knowledge_hints?.length) lines.push(`  已确认边界：${item.knowledge_hints.join(' / ')}`)
  if (item.suggested_decision) lines.push(`  建议结论：${item.suggested_decision}（显式规则，不是自动写入）`)
  lines.push(`  摘录：${shortExcerpt(item.excerpt)}`)
  return lines
}

function completeReconciliation(packet, changeset) {
  if (!packet?.snapshot_id || changeset?.snapshot_id !== packet.snapshot_id || changeset?.all_ok !== true) return null
  if (!Array.isArray(packet.review_items) || !Array.isArray(changeset.reconciliation)) return null
  if (validateReconciliation(packet.review_items, changeset.reconciliation).length > 0) return null
  return { count: packet.review_items.length, changesetId: changeset.changeset_id || null }
}

export function formatReviewBrief(packet, { changeset = null, forceFull = false } = {}) {
  if (!packet || !Array.isArray(packet.review_items)) return '❌ 找不到有效 review-packet.json；请先运行 npm run dashboard:prepare。'
  const tasks = taskIndex(packet.board)
  const items = packet.review_items
  const high = items.filter((item) => item.review_priority === 'high')
  const settled = completeReconciliation(packet, changeset)
  if (settled && !forceFull) {
    return [
      '✅ 审查简报：当前快照已结案（只读）',
      `快照：${packet.snapshot_id} · 已完成全量对账 ${settled.count}/${settled.count}${settled.changesetId ? ` · changeset ${settled.changesetId}` : ''}`,
      high.length ? `采集时有 ${high.length} 条需要人工归属，结论已写入 changeset；无需重新生成 ops.json 或推送。` : '采集线索均已结案；无需重新生成 ops.json 或推送。',
      '下一步：等待下一次 npm run dashboard:prepare。若只为审计本批原始摘录，运行 npm run dashboard:review-brief -- --full。',
    ].join('\n')
  }
  const suggestedIrrelevant = items.filter((item) => item.suggested_decision === 'irrelevant')
  const low = items.filter((item) => item.review_priority !== 'high' && item.suggested_decision !== 'irrelevant')
  const lines = [
    settled
      ? '🧭 审查简报（只读审计；本快照已结案，不得重新写入或推送）'
      : '🧭 审查简报（只读；尚未写入看板或发送飞书）',
    `快照：${packet.snapshot_id || '未知'} · 审查组 ${items.length} 个 · 覆盖原始证据 ${packet.counts?.raw_evidence_members ?? items.length} 条 · 需判断 ${high.length} 个`,
    settled
      ? '这是历史审计展开。以 changeset 中已有结论为准；不得重新生成 ops.json、apply 或推送。'
      : '使用此简报时，仍必须在 ops.json 为每一个 source_id 写唯一 reconciliation；不清楚的单项才用 dashboard:evidence 展开。',
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
  const args = { file: DEFAULT_REVIEW_FILE, changeset: DEFAULT_CHANGESET_FILE, forceFull: false }
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--file') args.file = argv[++index]
    if (argv[index] === '--changeset') args.changeset = argv[++index]
    if (argv[index] === '--full') args.forceFull = true
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  const { file, changeset: changesetFile, forceFull } = parseArgs(argv)
  try {
    const changeset = (() => {
      try { return JSON.parse(fs.readFileSync(changesetFile, 'utf8')) } catch { return null }
    })()
    console.log(formatReviewBrief(JSON.parse(fs.readFileSync(file, 'utf8')), { changeset, forceFull }))
  } catch {
    console.error('❌ 找不到有效 review-packet.json；请先运行 npm run dashboard:prepare。')
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
