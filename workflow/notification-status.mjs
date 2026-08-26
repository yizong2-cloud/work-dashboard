#!/usr/bin/env node
// 只读查看 Supabase notification_outbox 的投递健康。
// 仅从本机 .env 读取 service role key；不把密钥或完整 payload 输出到终端/前端。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { redactSensitiveText } from './redaction.mjs'
import { classifyDeliveryFailure } from '../supabase/functions/feishu-notify/delivery-classification.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = path.join(ROOT, '.env')
const CHANGESET_FILE = path.join(ROOT, 'workflow', 'last-changeset.json')

function loadEnv() {
  const env = {}
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/)
      if (match) env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
    }
  } catch { /* 没有 .env 时由调用方给出可操作错误 */ }
  return env
}

function ageHours(iso, now) {
  const timestamp = new Date(iso || '').getTime()
  if (Number.isNaN(timestamp)) return null
  return Math.max(0, now.getTime() - timestamp) / 3_600_000
}

function shortError(value) {
  return redactSensitiveText(String(value || '')).replace(/\s+/g, ' ').trim().slice(0, 180)
}

export function attentionAction(row) {
  if (row?.status === 'pending') return '等待自动投递'
  if (row?.status === 'sending') return '投递中；若持续超过 10 分钟需检查'
  if (row?.status !== 'failed') return null
  if (classifyDeliveryFailure(row.last_error) === 'skip') return '无需重试：永久性数据错误，建议标记 skipped'
  if (Number(row.attempts || 0) >= 5) return '已达重试上限，需人工处理'
  return '可重试：等待退避并检查外部限流/网络'
}

export function summarizeOutbox(rows, now = new Date(), scope = null) {
  const counts = { pending: 0, sending: 0, failed: 0, sent: 0, skipped: 0, unknown: 0 }
  for (const row of rows || []) {
    if (Object.prototype.hasOwnProperty.call(counts, row?.status)) counts[row.status] += 1
    else counts.unknown += 1
  }
  const attention = (rows || [])
    .filter((row) => ['pending', 'sending', 'failed'].includes(row?.status))
    .sort((a, b) => String(b?.updated_at || '').localeCompare(String(a?.updated_at || '')))
    .slice(0, 10)
    .map((row) => ({
      id: row.id || null,
      event_type: row.event_type || null,
      status: row.status || 'unknown',
      attempts: Number(row.attempts || 0),
      age_hours: ageHours(row.updated_at || row.created_at, now),
      last_error: shortError(row.last_error),
      action: attentionAction(row),
    }))
  return {
    health: counts.failed > 0 ? 'degraded' : counts.pending + counts.sending > 0 ? 'pending' : 'ok',
    sampled_rows: Array.isArray(rows) ? rows.length : 0,
    counts,
    attention,
    scope,
  }
}

function ageText(hours) {
  if (hours === null) return '未知时间'
  if (hours < 1) return '不到 1 小时'
  if (hours < 24) return `${Math.floor(hours)} 小时`
  return `${Math.floor(hours / 24)} 天`
}

export function formatNotificationStatus(summary) {
  const c = summary.counts
  const lines = [
    'Workboard 通知 outbox',
    ...(summary.scope?.changeset_id ? [`范围：本次 changeset ${summary.scope.changeset_id}（自 ${summary.scope.since}）`] : ['范围：最近 200 条（未找到可用 changeset 起点）']),
    `健康：${summary.health} · 采样 ${summary.sampled_rows} 条`,
    `数量：pending ${c.pending} · sending ${c.sending} · failed ${c.failed} · sent ${c.sent} · skipped ${c.skipped}`,
  ]
  if (!summary.attention.length) {
    lines.push('需关注：无')
    return lines.join('\n')
  }
  lines.push('需关注：')
  for (const row of summary.attention) {
    const error = row.last_error ? ` · ${row.last_error}` : ''
    lines.push(`- ${row.status} ${row.event_type || 'unknown'} · ${ageText(row.age_hours)} · 尝试 ${row.attempts} · ${row.action || '无需处理'}${error}`)
  }
  return lines.join('\n')
}

async function fetchOutbox(env, since = null) {
  const baseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!baseUrl || !key) throw new Error('缺少 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY（仅从本机 .env 读取）')
  const select = encodeURIComponent('id,event_type,status,attempts,last_error,created_at,updated_at,sent_at')
  const sinceFilter = since ? `&created_at=gte.${encodeURIComponent(since)}` : ''
  const endpoint = `${baseUrl.replace(/\/?$/, '')}/rest/v1/notification_outbox?select=${select}${sinceFilter}&order=updated_at.desc&limit=200`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(endpoint, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`读取 notification_outbox 失败：${response.status} ${shortError(await response.text())}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const changeset = (() => {
      if (argv.includes('--all')) return null
      try { return JSON.parse(fs.readFileSync(CHANGESET_FILE, 'utf8')) } catch { return null }
    })()
    const since = changeset?.started_at || null
    const scope = since ? { changeset_id: changeset.changeset_id || null, since } : null
    const summary = summarizeOutbox(await fetchOutbox(loadEnv(), since), new Date(), scope)
    console.log(argv.includes('--json') ? JSON.stringify(summary, null, 2) : formatNotificationStatus(summary))
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) void main()
