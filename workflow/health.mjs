#!/usr/bin/env node
// One compact, read-only operational health view. It deliberately does not
// call dashboard:prepare: checking health must never export chats, write data,
// advance a cursor, or enqueue a notification.

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { redactSensitiveText } from './redaction.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SEVERITY = { ok: 0, watch: 1, review: 2, attention: 3 }

function snapshotHealth(status) {
  if (status?.__health_error) return { state: 'attention', detail: `状态检查失败：${status.__health_error}` }
  if (!status?.packet_available) return { state: 'attention', detail: '未找到可用快照' }
  if (status.snapshot_health !== 'ok') return { state: 'attention', detail: '采集快照不完整' }
  if (status.coverage?.complete === false) return { state: 'attention', detail: '审查索引存在缺口' }
  if (status.snapshot_stale || !status.source_health_recorded) return { state: 'attention', detail: status.snapshot_stale ? '快照已过期' : '来源健康未记录' }
  if (status.pending?.active) return { state: 'review', detail: `${status.pending.count} 项待确认` }
  if (status.publish?.awaiting_retry) return { state: 'attention', detail: '上次写入部分失败，等待安全续跑' }
  if (status.publish?.awaiting_confirmation) return { state: 'review', detail: `${status.publish.operations} 项等待确认推送` }
  if (!status.apply?.matched_snapshot || !status.review?.fully_reconciled) return { state: 'review', detail: '快照待完成审查/验证' }
  return { state: 'ok', detail: `已结案 ${status.review.reconciled_count}/${status.review.expected_count}` }
}

function releaseHealth(status) {
  if (status?.__health_error) return { state: 'attention', detail: `发布检查失败：${status.__health_error}` }
  if (!status) return { state: 'attention', detail: '无法读取发布状态' }
  if (!status.healthy) return { state: 'attention', detail: status.next_action || '发布状态需处理' }
  return { state: 'ok', detail: `迁移 ${status.migrations.local.length}/${status.migrations.remote.length} · feishu-notify ACTIVE` }
}

function notificationHealth(status) {
  if (status?.__health_error) return { state: 'attention', detail: `通知检查失败：${status.__health_error}` }
  if (!status) return { state: 'attention', detail: '无法读取通知状态' }
  if (status.health === 'degraded') return { state: 'attention', detail: `失败 ${status.counts.failed} 条` }
  if (status.health === 'pending') return { state: 'watch', detail: `pending ${status.counts.pending} · sending ${status.counts.sending}` }
  return { state: 'ok', detail: `pending ${status.counts.pending} · failed ${status.counts.failed}` }
}

function repositoryHealth(report) {
  if (report?.__health_error) return { state: 'attention', detail: `工作区检查失败：${report.__health_error}` }
  if (!report?.repositories) return { state: 'attention', detail: '无法读取工作区状态' }
  const issues = report.repositories.filter((repo) => repo.issues?.length)
  const advisories = report.repositories.filter((repo) => repo.advisories?.length)
  if (issues.length) return { state: 'attention', detail: `${issues.length} 个仓库异常：${issues.map((repo) => repo.id).join('、')}` }
  if (advisories.length) return { state: 'watch', detail: `${advisories.length} 个提示：${advisories.map((repo) => repo.id).join('、')}` }
  return { state: 'ok', detail: `${report.repositories.length} 个受管目录正常` }
}

export function buildHealth({ snapshot, release, notifications, repositories }) {
  const checks = {
    snapshot: snapshotHealth(snapshot),
    release: releaseHealth(release),
    notifications: notificationHealth(notifications),
    repositories: repositoryHealth(repositories),
  }
  const state = Object.values(checks).sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state])[0]?.state || 'attention'
  const nextAction = state === 'ok'
    ? '无需操作；下次用户说“开始更新”时再进入采集与审批流程'
    : Object.entries(checks).find(([, check]) => check.state === state)?.[1].detail || '查看各项明细'
  return { state, checks, next_action: nextAction }
}

export function formatHealth(health) {
  const labels = { snapshot: '采集与审查', release: '发布', notifications: '通知', repositories: '工作区' }
  const stateLabels = { ok: '正常', watch: '关注', review: '待审查', attention: '需处理' }
  const lines = ['Workboard 健康总览', `总体：${stateLabels[health.state] || health.state}`]
  for (const [name, check] of Object.entries(health.checks)) {
    lines.push(`${labels[name]}：${stateLabels[check.state] || check.state} · ${check.detail}`)
  }
  lines.push(`下一步：${health.next_action}`)
  return lines.join('\n')
}

function runJson(script, timeout) {
  try {
    const stdout = execFileSync(process.execPath, [script, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(stdout)
  } catch (error) {
    const detail = redactSensitiveText(String(error?.stderr || error?.stdout || error?.message || '')).replace(/\s+/g, ' ').trim().slice(0, 240)
    return { __health_error: detail || '命令失败' }
  }
}

export function collectHealth(run = runJson) {
  const snapshot = run('workflow/status.mjs', 10_000)
  const release = run('workflow/release-status.mjs', 120_000)
  const notifications = run('workflow/notification-status.mjs', 15_000)
  const repositories = run('scripts/repo-doctor.js', 30_000)
  return buildHealth({
    snapshot,
    release,
    notifications,
    repositories,
  })
}

export function main(argv = process.argv.slice(2)) {
  const health = collectHealth()
  console.log(argv.includes('--json') ? JSON.stringify(health, null, 2) : formatHealth(health))
  if (health.state === 'attention') process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
