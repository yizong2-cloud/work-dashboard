#!/usr/bin/env node
// 只读查看最近一次 Workboard 准备快照的健康状态。
// 只读取 review-packet / analysis-state / last-changeset，不展开原始快照，也不写数据库。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_PENDING_FILE, loadPendingPlan, pendingForSnapshot } from './pending.mjs'
import { DEFAULT_PREVIEW_FILE } from './publish.mjs'
import { validateReconciliation } from './review-packet.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKET_FILE = path.join(ROOT, 'workflow', 'review-packet.json')
const LAST_HEALTHY_CONTEXT_FILE = path.join(ROOT, 'workflow', 'last-healthy-context.json')
const LAST_HEALTHY_PACKET_FILE = path.join(ROOT, 'workflow', 'last-healthy-review-packet.json')
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

function hasCompleteReconciliation(packet, changeset, matched) {
  if (!matched || !Array.isArray(packet?.review_items) || !Array.isArray(changeset?.reconciliation)) return false
  return validateReconciliation(packet.review_items, changeset.reconciliation).length === 0
}

function nextAction({ packet, changeset, matched, reconciliationComplete, ageHoursValue, lastHealthy, pending, publish }) {
  if (!packet) return '先运行 npm run dashboard:prepare'
  if (pending?.active) return `当前快照有 ${pending.count} 项待确认；运行 npm run dashboard:pending -- show，向用户逐项确认后 resolve；不要重新 prepare`
  if (publish?.awaiting_confirmation) return '当前快照已有更新预览；把 dashboard:publish -- show 的完整内容发给用户，等待其明确回复“确认推送”'
  if (packet.coverage?.complete === false) return '审查索引不完整：先重新运行 npm run dashboard:prepare，禁止对账或写入'
  if (packet.snapshot_health === 'degraded') {
    const reference = lastHealthy?.available ? `；最近健康快照 ${lastHealthy.snapshot_id} 仅供诊断，不能替代当前快照 apply` : ''
    return `来源不完整：先修复失败来源，再决定是否更新看板${reference}`
  }
  if (ageHoursValue !== null && ageHoursValue >= STALE_AFTER_HOURS) return '当前快照已超过 24 小时；先运行 npm run dashboard:prepare 获取新数据'
  if (!packet.source_health || typeof packet.source_health !== 'object' || Object.keys(packet.source_health).length === 0) {
    return '来源健康未记录（旧版快照）；先运行 npm run dashboard:prepare 获取带来源状态的新快照'
  }
  if (!matched) return '当前快照尚未完成 apply + verify；先按更新流程审查并校验'
  if (!reconciliationComplete) return '当前快照虽有 changeset，但缺少可核验的全量对账记录；不要把采集线索当作已结案，先重新采集并按完整流程审查'
  return '当前快照已完成审查；等待下一次数据采集'
}

export function buildStatus({ packet, lastHealthyContext, lastHealthyPacket, analysisState, changeset, pendingPlan = loadPendingPlan(DEFAULT_PENDING_FILE), publishPreview = readJson(DEFAULT_PREVIEW_FILE), now = new Date() }) {
  const matched = Boolean(packet?.snapshot_id && changeset?.snapshot_id === packet.snapshot_id && changeset.all_ok === true)
  const reviewItemCount = Array.isArray(packet?.review_items) ? packet.review_items.length : null
  const reconciliation = matched && Array.isArray(changeset?.reconciliation) ? changeset.reconciliation : []
  // 与 apply 共用逐 source_id 的完整性规则，避免旧版/手工 changeset 被状态页
  // 仅凭「条数相等」误显示成已完成全量对账。
  const reconciliationComplete = hasCompleteReconciliation(packet, changeset, matched)
  const ageHoursValue = ageHours(packet?.captured_at, now)
  const sourceHealthRecorded = Boolean(packet?.source_health && typeof packet.source_health === 'object' && Object.keys(packet.source_health).length > 0)
  // Early packets recorded the source result but omitted a count for Feishu.
  // The review inventory already has the authoritative per-source count, so
  // read-only status can backfill the display without rewriting history.
  const reviewSourceKey = { feishu: 'feishu', codex: 'codex', dsh: 'dsh', local_files: 'local' }
  const sourceHealth = Object.fromEntries(Object.entries(packet?.source_health || {}).map(([name, source]) => [name, {
    ...source,
    count: source?.count ?? (reviewSourceKey[name] ? packet?.counts?.by_source?.[reviewSourceKey[name]] ?? null : null),
  }]))
  const lastHealthyValid = lastHealthyContext?.snapshot_health === 'ok'
    && lastHealthyPacket?.snapshot_health === 'ok'
    && Boolean(lastHealthyContext?.snapshot_id)
    && lastHealthyContext.snapshot_id === lastHealthyPacket.snapshot_id
  const lastHealthy = {
    available: lastHealthyValid,
    snapshot_id: lastHealthyValid ? lastHealthyPacket.snapshot_id : null,
    captured_at: lastHealthyValid ? lastHealthyPacket.captured_at || null : null,
    age_hours: lastHealthyValid ? ageHours(lastHealthyPacket.captured_at, now) : null,
    same_as_latest: lastHealthyValid && lastHealthyPacket.snapshot_id === packet?.snapshot_id,
    reference_only: lastHealthyValid && packet?.snapshot_health === 'degraded',
  }
  const pending = {
    active: pendingForSnapshot(pendingPlan, packet?.snapshot_id),
    count: pendingForSnapshot(pendingPlan, packet?.snapshot_id) ? pendingPlan.questions.length : 0,
    snapshot_id: pendingPlan?.snapshot_id || null,
  }
  const publish = {
    awaiting_confirmation: publishPreview?.state === 'awaiting_owner_confirmation' && publishPreview.snapshot_id === packet?.snapshot_id,
    snapshot_id: publishPreview?.snapshot_id || null,
    operations: Array.isArray(publishPreview?.operations) ? publishPreview.operations.length : 0,
  }
  return {
    packet_available: Boolean(packet),
    snapshot_id: packet?.snapshot_id || null,
    captured_at: packet?.captured_at || null,
    age_hours: ageHoursValue,
    snapshot_stale: ageHoursValue !== null && ageHoursValue >= STALE_AFTER_HOURS,
    snapshot_health: packet?.snapshot_health || 'missing',
    source_health: sourceHealth,
    source_health_recorded: sourceHealthRecorded,
    counts: packet?.counts || null,
    review_reasons: packet?.counts?.by_review_reason || null,
    review: {
      raw_attention: packet?.counts?.review_attention ?? packet?.counts?.high_priority ?? 0,
      expected_count: reviewItemCount,
      reconciled_count: reconciliation.length,
      fully_reconciled: reconciliationComplete,
    },
    coverage: packet?.coverage || null,
    last_healthy: lastHealthy,
    analysis_reviewed_at: analysisState?.reviewed_at || null,
    apply: {
      matched_snapshot: matched,
      changeset_id: matched ? changeset.changeset_id || null : null,
      reviewed_no_change: matched ? changeset.reviewed_no_change === true : false,
    },
    pending,
    publish,
    next_action: nextAction({ packet, changeset, matched, reconciliationComplete, ageHoursValue, lastHealthy, pending, publish }),
  }
}

function ageText(hours) {
  if (hours === null) return '未知时间'
  if (hours < 1) return '不到 1 小时前'
  if (hours < 24) return `${Math.floor(hours)} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

const REVIEW_REASON_LABEL = {
  no_candidate_mapping: '未映射',
  multiple_candidate_tasks: '多候选',
  metadata_only: '仅元数据',
  single_candidate: '单候选',
  intentionally_ignored: '明确无关',
}

function formatReviewReasons(reasons) {
  if (!reasons || typeof reasons !== 'object') return null
  const entries = Object.entries(reasons).filter(([, count]) => Number(count) > 0)
  if (entries.length === 0) return null
  return entries
    .map(([reason, count]) => `${REVIEW_REASON_LABEL[reason] || reason} ${count}`)
    .join(' · ')
}

function formatSourceDetail(source) {
  const detailLines = String(source?.detail || '').split('|').map((line) => line.trim()).filter(Boolean)
  const recoveredLines = String(source?.warning || '').split('|').map((line) => line.trim()).filter(Boolean)
  // Compatibility for snapshots captured before `warning` became structured.
  // A successful source with this exact exporter recovery line is complete;
  // the completion text remains the health detail and the recovery becomes a
  // secondary note instead of looking like a current failure.
  const legacyRecovery = source?.ok
    ? detailLines.filter((line) => /重新加载飞书 Messenger 后再试/.test(line))
    : []
  return {
    detail: detailLines.filter((line) => !legacyRecovery.includes(line)).join(' | ') || null,
    warning: [...recoveredLines, ...legacyRecovery].filter((line, index, all) => all.indexOf(line) === index).join(' | ') || null,
  }
}

export function formatStatus(status) {
  const lines = ['Workboard 状态']
  if (!status.packet_available) {
    lines.push('快照：未找到 review-packet.json', `下一步：${status.next_action}`)
    return lines.join('\n')
  }
  lines.push(`快照：${status.snapshot_health} · ${ageText(status.age_hours)} · ${status.snapshot_id}`)
  if (status.last_healthy?.available && !status.last_healthy.same_as_latest) {
    lines.push(`最近健康快照：${ageText(status.last_healthy.age_hours)} · ${status.last_healthy.snapshot_id}${status.last_healthy.reference_only ? '（仅供诊断，不可 apply）' : ''}`)
  }
  lines.push(`新鲜度：${status.snapshot_stale ? '已过期（超过 24 小时）' : '正常'}`)
  if (status.counts) {
    const attention = status.review?.raw_attention ?? status.counts.review_attention ?? status.counts.high_priority ?? 0
    const expected = status.review?.expected_count
    const reconciled = status.review?.reconciled_count ?? 0
    if (status.review?.fully_reconciled) {
      lines.push(`证据：${status.counts.total} 个审查组 / ${status.counts.raw_evidence_members ?? status.counts.total} 条原始证据（已完成全量对账：${reconciled}/${expected}）`)
      if (attention > 0) lines.push(`采集线索：当时 ${attention} 条需要人工归属，现已结案`)
    } else {
      lines.push(`证据：${status.counts.total} 个审查组 / ${status.counts.raw_evidence_members ?? status.counts.total} 条原始证据（需人工判断 ${attention} 个）`)
      if (status.apply?.matched_snapshot && expected !== null) {
        lines.push(`对账记录：⚠️ ${reconciled}/${expected}，不能确认已完整结案`)
      }
    }
    const reasons = formatReviewReasons(status.review_reasons)
    if (reasons) lines.push(`审查线索：${reasons}`)
  }
  if (status.coverage) {
    lines.push(`对账覆盖：${status.coverage.complete ? '✅ 完整' : `⚠️ 缺口：${status.coverage.gaps.join('、')}`}`)
  }
  if (!status.source_health_recorded) {
    lines.push('来源健康：⚠️ 未记录（旧版快照；建议重新运行 npm run dashboard:prepare）')
  } else {
    for (const [label, source] of Object.entries(status.source_health || {})) {
      const name = { feishu: '飞书', codex: 'Codex', dsh: 'DSH', local_files: '本地文件', board: '当前看板', knowledge_base: '知识库' }[label] || label
      const count = label === 'feishu' && source.exported_chat_count !== null && source.exported_chat_count !== undefined
        ? ` · 完整扫描 ${source.parsed_chat_count ?? source.exported_chat_count}/${source.exported_chat_count} 群、${source.exported_message_count ?? '?'} 条消息 · 本轮增量 ${source.delta_chat_count ?? source.count ?? 0} 群、${source.delta_message_count ?? '?'} 条消息`
        : source.count === null || source.count === undefined ? '' : ` · ${source.count} 条`
      const rendered = formatSourceDetail(source)
      lines.push(`来源：${source.ok ? '✅' : '❌'} ${name}${count}${rendered.detail ? ` · ${rendered.detail}` : ''}`)
      if (source.ok && rendered.warning) lines.push(`  过程告警（已恢复）：${rendered.warning}`)
    }
  }
  lines.push(`审查游标：${status.analysis_reviewed_at || '未推进'}`)
  if (status.pending?.active) lines.push(`待确认：⏸️ ${status.pending.count} 项（当前快照，已保存可续办计划）`)
  if (status.publish?.awaiting_confirmation) lines.push(`待推送审核：⏸️ ${status.publish.operations} 项（当前快照，尚未写入/通知）`)
  lines.push(`apply：${status.apply.matched_snapshot ? '已匹配当前快照' : '尚未匹配当前快照'}`)
  lines.push(`下一步：${status.next_action}`)
  return lines.join('\n')
}

export function statusIsReviewable(status) {
  return Boolean(status?.packet_available
    && status.snapshot_health === 'ok'
    && status.snapshot_stale === false
    && status.coverage?.complete === true
    && status.source_health_recorded
    && !status.pending?.active
    && !status.publish?.awaiting_confirmation)
}

export function statusAllowsPrepare(status) {
  return !status?.pending?.active && !status?.publish?.awaiting_confirmation
}

export function main(argv = process.argv.slice(2)) {
  const packet = readJson(PACKET_FILE)
  const status = buildStatus({
    packet,
    lastHealthyContext: readJson(LAST_HEALTHY_CONTEXT_FILE),
    lastHealthyPacket: readJson(LAST_HEALTHY_PACKET_FILE),
    analysisState: readJson(ANALYSIS_STATE_FILE),
    changeset: readJson(CHANGESET_FILE),
  })
  if (!argv.includes('--quiet')) console.log(argv.includes('--json') ? JSON.stringify(status, null, 2) : formatStatus(status))
  if (argv.includes('--strict-review') && !statusIsReviewable(status)) process.exitCode = 2
  if (argv.includes('--guard-prepare') && !statusAllowsPrepare(status)) process.exitCode = 2
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
