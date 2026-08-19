#!/usr/bin/env node
// 只读查看最近一次 Workboard 准备快照的健康状态。
// 只读取 review-packet / analysis-state / last-changeset，不展开原始快照，也不写数据库。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKET_FILE = path.join(ROOT, 'workflow', 'review-packet.json')
const ANALYSIS_STATE_FILE = path.join(ROOT, 'workflow', '.analysis-state.json')
const CHANGESET_FILE = path.join(ROOT, 'workflow', 'last-changeset.json')
const STALE_AFTER_HOURS = 24

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function ageHours(iso, now) {
  if (!iso) return null
  const timestamp = new Date(iso).getTime()
  if (Number.isNaN(timestamp)) return null
  return Math.max(0, now.getTime() - timestamp) / 3_600_000
}

function nextAction({ packet, changeset, matched, ageHoursValue }) {
  if (!packet) return '先运行 npm run dashboard:prepare'
  if (packet.coverage?.complete === false) return '审查索引不完整：先重新运行 npm run dashboard:prepare，禁止对账或写入'
  if (packet.snapshot_health === 'degraded') return '来源不完整：先修复失败来源，再决定是否更新看板'
  if (ageHoursValue !== null && ageHoursValue >= STALE_AFTER_HOURS) return '当前快照已超过 24 小时；先运行 npm run dashboard:prepare 获取新数据'
  if (!packet.source_health || typeof packet.source_health !== 'object' || Object.keys(packet.source_health).length === 0) {
    return '来源健康未记录（旧版快照）；先运行 npm run dashboard:prepare 获取带来源状态的新快照'
  }
  if (!matched) return '当前快照尚未完成 apply + verify；先按更新流程审查并校验'
  return '当前快照已完成审查；等待下一次数据采集'
}

export function buildStatus({ packet, analysisState, changeset, now = new Date() }) {
  const matched = Boolean(packet?.snapshot_id && changeset?.snapshot_id === packet.snapshot_id && changeset.all_ok === true)
  const ageHoursValue = ageHours(packet?.captured_at, now)
  const sourceHealthRecorded = Boolean(packet?.source_health && typeof packet.source_health === 'object' && Object.keys(packet.source_health).length > 0)
  return {
    packet_available: Boolean(packet),
    snapshot_id: packet?.snapshot_id || null,
    captured_at: packet?.captured_at || null,
    age_hours: ageHoursValue,
    snapshot_stale: ageHoursValue !== null && ageHoursValue >= STALE_AFTER_HOURS,
    snapshot_health: packet?.snapshot_health || 'missing',
    source_health: packet?.source_health || null,
    source_health_recorded: sourceHealthRecorded,
    counts: packet?.counts || null,
    coverage: packet?.coverage || null,
    analysis_reviewed_at: analysisState?.reviewed_at || null,
    apply: {
      matched_snapshot: matched,
      changeset_id: matched ? changeset.changeset_id || null : null,
      reviewed_no_change: matched ? changeset.reviewed_no_change === true : false,
    },
    next_action: nextAction({ packet, changeset, matched, ageHoursValue }),
  }
}

function ageText(hours) {
  if (hours === null) return '未知时间'
  if (hours < 1) return '不到 1 小时前'
  if (hours < 24) return `${Math.floor(hours)} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export function formatStatus(status) {
  const lines = ['Workboard 状态']
  if (!status.packet_available) {
    lines.push('快照：未找到 review-packet.json', `下一步：${status.next_action}`)
    return lines.join('\n')
  }
  lines.push(`快照：${status.snapshot_health} · ${ageText(status.age_hours)} · ${status.snapshot_id}`)
  lines.push(`新鲜度：${status.snapshot_stale ? '已过期（超过 24 小时）' : '正常'}`)
  if (status.counts) lines.push(`证据：${status.counts.total} 条（高优先级 ${status.counts.high_priority} 条）`)
  if (status.coverage) {
    lines.push(`对账覆盖：${status.coverage.complete ? '✅ 完整' : `⚠️ 缺口：${status.coverage.gaps.join('、')}`}`)
  }
  if (!status.source_health_recorded) {
    lines.push('来源健康：⚠️ 未记录（旧版快照；建议重新运行 npm run dashboard:prepare）')
  } else {
    for (const [label, source] of Object.entries(status.source_health || {})) {
      const name = { feishu: '飞书', codex: 'Codex', dsh: 'DSH', local_files: '本地文件' }[label] || label
      const count = source.count === null || source.count === undefined ? '' : ` · ${source.count} 条`
      lines.push(`来源：${source.ok ? '✅' : '❌'} ${name}${count}${source.detail ? ` · ${source.detail}` : ''}`)
    }
  }
  lines.push(`审查游标：${status.analysis_reviewed_at || '未推进'}`)
  lines.push(`apply：${status.apply.matched_snapshot ? '已匹配当前快照' : '尚未匹配当前快照'}`)
  lines.push(`下一步：${status.next_action}`)
  return lines.join('\n')
}

export function main(argv = process.argv.slice(2)) {
  const packet = readJson(PACKET_FILE)
  const status = buildStatus({
    packet,
    analysisState: readJson(ANALYSIS_STATE_FILE),
    changeset: readJson(CHANGESET_FILE),
  })
  console.log(argv.includes('--json') ? JSON.stringify(status, null, 2) : formatStatus(status))
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
