#!/usr/bin/env node
// 只读核验本地迁移与线上 Supabase 部署状态；不执行 db push 或 functions deploy。

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function runSupabase(args) {
  try {
    const stdout = execFileSync('npx', ['supabase', ...args, '--output-format', 'json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return parseCommandJson(stdout)
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    throw new Error(`Supabase 只读检查失败：${detail}`)
  }
}

// Supabase CLI 可能把登录/连接提示写到 stdout；不能让这些提示污染本命令的 --json 输出。
// 从完整输出中提取唯一可解析的 JSON 值，同时保留 CLI 失败时的原始错误摘要。
export function parseCommandJson(output) {
  const raw = String(output || '').trim()
  try {
    return JSON.parse(raw)
  } catch {
    for (let index = 0; index < raw.length; index += 1) {
      if (raw[index] !== '{' && raw[index] !== '[') continue
      try { return JSON.parse(raw.slice(index)) } catch { /* 继续寻找 JSON 起点 */ }
    }
  }
  throw new Error('Supabase 返回内容中未找到合法 JSON')
}

export function compareMigrations(entries) {
  const rows = Array.isArray(entries) ? entries : []
  return {
    local: rows.map((row) => row.local).filter(Boolean),
    remote: rows.map((row) => row.remote).filter(Boolean),
    pending: rows.filter((row) => row.local && !row.remote).map((row) => row.local),
    remote_only: rows.filter((row) => row.remote && !row.local).map((row) => row.remote),
  }
}

export function buildReleaseStatus({ migrations, functions }) {
  const migrationStatus = compareMigrations(migrations)
  const deployed = (functions || []).map((item) => ({
    slug: item.slug || item.name || null,
    status: item.status || 'unknown',
    version: item.version ?? null,
    updated_at: item.updated_at || null,
  }))
  const functionStatus = deployed.find((item) => item.slug === 'feishu-notify') || null
  return {
    migrations: migrationStatus,
    functions: deployed,
    feishu_notify: functionStatus,
    healthy: migrationStatus.pending.length === 0 && functionStatus?.status === 'ACTIVE',
    next_action: migrationStatus.pending.length
      ? `先部署待应用迁移：${migrationStatus.pending.join(', ')}`
      : functionStatus?.status !== 'ACTIVE'
        ? '检查 feishu-notify 的线上状态，再决定是否重新部署'
        : '迁移均已应用；Edge Function 版本仍需按发布记录核对',
  }
}

export function formatReleaseStatus(status) {
  const lines = [
    'Workboard 发布状态',
    `健康：${status.healthy ? 'ok' : 'attention'}`,
    `迁移：本地 ${status.migrations.local.length} · 线上 ${status.migrations.remote.length} · 待应用 ${status.migrations.pending.join(', ') || '无'}`,
  ]
  if (status.feishu_notify) {
    lines.push(`feishu-notify：${status.feishu_notify.status} · version ${status.feishu_notify.version ?? '未知'} · 更新时间 ${status.feishu_notify.updated_at || '未知'}`)
  } else {
    lines.push('feishu-notify：线上未找到')
  }
  lines.push(`下一步：${status.next_action}`)
  return lines.join('\n')
}

export function main(argv = process.argv.slice(2)) {
  try {
    const migrationResult = runSupabase(['migration', 'list', '--linked'])
    const functionResult = runSupabase(['functions', 'list'])
    const status = buildReleaseStatus({ migrations: migrationResult.migrations, functions: functionResult.functions })
    console.log(argv.includes('--json') ? JSON.stringify(status, null, 2) : formatReleaseStatus(status))
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
