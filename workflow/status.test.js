import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStatus, formatStatus } from './status.mjs'

test('status 在 degraded 快照时指出失败来源和恢复动作', () => {
  const status = buildStatus({
    packet: {
      snapshot_id: 'snap-1', captured_at: '2026-08-20T00:00:00Z', snapshot_health: 'degraded',
      source_health: { feishu: { ok: false, count: null, detail: '登录态可能已失效' } }, counts: { total: 2, high_priority: 1 },
    },
    analysisState: { reviewed_at: '2026-08-19T00:00:00Z' },
    changeset: null,
    now: new Date('2026-08-20T12:00:00Z'),
  })
  assert.equal(status.age_hours, 12)
  assert.equal(status.snapshot_stale, false)
  assert.equal(status.source_health_recorded, true)
  assert.equal(status.apply.matched_snapshot, false)
  assert.match(status.next_action, /修复失败来源/)
  assert.match(formatStatus(status), /飞书/)
})

test('status 显示最近健康快照但明确禁止替代当前 degraded 快照', () => {
  const status = buildStatus({
    packet: {
      snapshot_id: 'snap-degraded', captured_at: '2026-08-20T10:00:00Z', snapshot_health: 'degraded',
      source_health: { feishu: { ok: false, count: null, detail: '导出失败' } }, counts: { total: 3, high_priority: 1 },
    },
    lastHealthyContext: {
      snapshot_id: 'snap-healthy', captured_at: '2026-08-20T08:00:00Z', snapshot_health: 'ok',
    },
    lastHealthyPacket: {
      snapshot_id: 'snap-healthy', captured_at: '2026-08-20T08:00:00Z', snapshot_health: 'ok',
    },
    changeset: null,
    now: new Date('2026-08-20T12:00:00Z'),
  })
  assert.equal(status.last_healthy.available, true)
  assert.equal(status.last_healthy.snapshot_id, 'snap-healthy')
  assert.equal(status.last_healthy.reference_only, true)
  assert.match(status.next_action, /仅供诊断，不能替代当前快照 apply/)
  assert.match(formatStatus(status), /最近健康快照：4 小时前 · snap-healthy（仅供诊断，不可 apply）/)
})

test('status 不重复展示与当前快照相同的健康副本', () => {
  const packet = {
    snapshot_id: 'snap-current', captured_at: '2026-08-20T10:00:00Z', snapshot_health: 'ok',
    source_health: { feishu: { ok: true, count: 4 } }, counts: { total: 4, high_priority: 0 },
  }
  const status = buildStatus({
    packet,
    lastHealthyContext: packet,
    lastHealthyPacket: packet,
    changeset: null,
    now: new Date('2026-08-20T12:00:00Z'),
  })
  assert.equal(status.last_healthy.same_as_latest, true)
  assert.doesNotMatch(formatStatus(status), /最近健康快照/)
})

test('status separates recovered Feishu diagnostics from a healthy source result', () => {
  const status = buildStatus({
    packet: {
      snapshot_id: 'snap-recovered', captured_at: '2026-08-20T10:00:00Z', snapshot_health: 'ok',
      source_health: {
        feishu: {
          ok: true, count: 2,
          detail: '胡贺伟: 连续两次无法切换，重新加载飞书 Messenger 后再试 | 完成：2 个会话、3 条消息',
        },
      },
      counts: { total: 2, high_priority: 0 },
    },
    now: new Date('2026-08-20T12:00:00Z'),
  })
  const text = formatStatus(status)
  assert.match(text, /来源：✅ 飞书 · 2 条 · 完成：2 个会话、3 条消息/)
  assert.match(text, /过程告警（已恢复）：胡贺伟/)
})

test('status 忽略不成对或损坏的健康副本', () => {
  const status = buildStatus({
    packet: { snapshot_id: 'snap-degraded', captured_at: '2026-08-20T10:00:00Z', snapshot_health: 'degraded' },
    lastHealthyContext: { snapshot_id: 'healthy-context', snapshot_health: 'ok' },
    lastHealthyPacket: { snapshot_id: 'healthy-packet', snapshot_health: 'ok' },
  })
  assert.equal(status.last_healthy.available, false)
  assert.doesNotMatch(status.next_action, /最近健康快照/)
})

test('status blocks an incomplete review index even when source health is ok', () => {
  const status = buildStatus({
    packet: {
      snapshot_id: 'snap-gap', captured_at: '2026-08-20T00:00:00Z', snapshot_health: 'ok',
      coverage: { complete: false, gaps: ['codex'] }, counts: { total: 1, high_priority: 1 },
    },
    changeset: { snapshot_id: 'snap-gap', all_ok: true },
  })
  assert.match(status.next_action, /审查索引不完整/)
  assert.match(formatStatus(status), /缺口：codex/)
})

test('status 不虚构不存在的快照', () => {
  const status = buildStatus({ packet: null, analysisState: null, changeset: null })
  assert.equal(status.snapshot_health, 'missing')
  assert.match(formatStatus(status), /先运行 npm run dashboard:prepare/)
})

test('status 只有同一快照且 apply 成功才显示已匹配', () => {
  const packet = { snapshot_id: 'snap-2', captured_at: '2026-08-20T00:00:00Z', snapshot_health: 'ok', counts: { total: 0, high_priority: 0 } }
  const status = buildStatus({ packet, changeset: { snapshot_id: 'snap-2', all_ok: true, changeset_id: 'chg-2', reviewed_no_change: true } })
  assert.equal(status.apply.matched_snapshot, true)
  assert.equal(status.apply.reviewed_no_change, true)
})

test('status 不把旧版快照缺少来源健康误报为正常', () => {
  const status = buildStatus({
    packet: { snapshot_id: 'snap-legacy', captured_at: '2026-08-20T00:00:00Z', snapshot_health: 'ok', counts: { total: 1, high_priority: 1 } },
    changeset: { snapshot_id: 'snap-legacy', all_ok: true, changeset_id: 'chg-legacy' },
    now: new Date('2026-08-20T01:00:00Z'),
  })
  assert.equal(status.source_health_recorded, false)
  assert.match(status.next_action, /来源健康未记录/)
  assert.match(formatStatus(status), /旧版快照/)
})

test('status 对超过 24 小时的快照明确提示重新采集', () => {
  const status = buildStatus({
    packet: { snapshot_id: 'snap-old', captured_at: '2026-08-18T00:00:00Z', snapshot_health: 'ok', counts: { total: 1, high_priority: 1 } },
    changeset: { snapshot_id: 'snap-old', all_ok: true, changeset_id: 'chg-old' },
    now: new Date('2026-08-20T12:00:00Z'),
  })
  assert.equal(status.snapshot_stale, true)
  assert.match(status.next_action, /超过 24 小时/)
  assert.match(formatStatus(status), /已过期/)
})

test('status 将当前快照的待确认计划作为下一步，而非要求重新采集', () => {
  const status = buildStatus({
    packet: {
      snapshot_id: 'snap-pending', captured_at: '2026-08-20T10:00:00Z', snapshot_health: 'ok',
      source_health: { feishu: { ok: true, count: 1 } }, counts: { total: 1, high_priority: 1 },
    },
    pendingPlan: {
      state: 'awaiting_confirmation', snapshot_id: 'snap-pending', questions: [{ source_id: 'dsh:0' }],
    },
    now: new Date('2026-08-20T12:00:00Z'),
  })
  assert.equal(status.pending.active, true)
  assert.match(status.next_action, /不要重新 prepare/)
  assert.match(formatStatus(status), /待确认：⏸️ 1 项/)
})

test('status 将当前快照的推送预览作为下一步，等待用户确认', () => {
  const status = buildStatus({
    packet: {
      snapshot_id: 'snap-publish', captured_at: '2026-08-20T10:00:00Z', snapshot_health: 'ok',
      source_health: { feishu: { ok: true, count: 1 } }, counts: { total: 1, high_priority: 1 },
    },
    publishPreview: {
      state: 'awaiting_owner_confirmation', snapshot_id: 'snap-publish', operations: [{ index: 1 }],
    },
    now: new Date('2026-08-20T12:00:00Z'),
  })
  assert.equal(status.publish.awaiting_confirmation, true)
  assert.match(status.next_action, /确认推送/)
  assert.match(formatStatus(status), /待推送审核：⏸️ 1 项/)
})

test('status 将需人工判断拆成可行动的审查原因', () => {
  const status = buildStatus({
    packet: {
      snapshot_id: 'snap-reasons', captured_at: '2026-08-20T10:00:00Z', snapshot_health: 'ok',
      source_health: { feishu: { ok: true, count: 1 } },
      counts: {
        total: 6,
        review_attention: 5,
        by_review_reason: { no_candidate_mapping: 3, multiple_candidate_tasks: 1, metadata_only: 1, single_candidate: 1 },
      },
    },
    now: new Date('2026-08-20T12:00:00Z'),
  })
  assert.match(formatStatus(status), /审查线索：未映射 3 · 多候选 1 · 仅元数据 1 · 单候选 1/)
})

test('status 区分采集时的归属线索与已完成的全量对账', () => {
  const packet = {
    snapshot_id: 'snap-settled', captured_at: '2026-08-20T10:00:00Z', snapshot_health: 'ok',
    source_health: { feishu: { ok: true, count: 2 } },
    coverage: { complete: true, gaps: [] },
    counts: { total: 2, review_attention: 2, by_review_reason: { no_candidate_mapping: 2 } },
    review_items: [{ source_id: 'feishu:0' }, { source_id: 'feishu:1' }],
  }
  const status = buildStatus({
    packet,
    changeset: {
      snapshot_id: 'snap-settled', all_ok: true, changeset_id: 'chg-settled',
      reconciliation: [
        { source_id: 'feishu:0', decision: 'mapped', task_id: 'task-a' },
        { source_id: 'feishu:1', decision: 'irrelevant' },
      ],
    },
    now: new Date('2026-08-20T12:00:00Z'),
  })
  assert.equal(status.review.fully_reconciled, true)
  assert.equal(status.review.reconciled_count, 2)
  assert.match(formatStatus(status), /已完成全量对账：2\/2/)
  assert.match(formatStatus(status), /当时 2 条需要人工归属，现已结案/)
  assert.doesNotMatch(formatStatus(status), /证据：2 条（需人工判断/)
})

test('status 不将缺少逐项对账的旧 changeset 误报为结案', () => {
  const status = buildStatus({
    packet: {
      snapshot_id: 'snap-incomplete', captured_at: '2026-08-20T10:00:00Z', snapshot_health: 'ok',
      source_health: { feishu: { ok: true, count: 2 } },
      coverage: { complete: true, gaps: [] },
      counts: { total: 2, review_attention: 2 },
      review_items: [{ source_id: 'feishu:0' }, { source_id: 'feishu:1' }],
    },
    changeset: {
      snapshot_id: 'snap-incomplete', all_ok: true, changeset_id: 'chg-incomplete',
      reconciliation: [{ source_id: 'feishu:0', decision: 'mapped' }],
    },
    now: new Date('2026-08-20T12:00:00Z'),
  })
  assert.equal(status.apply.matched_snapshot, true)
  assert.equal(status.review.fully_reconciled, false)
  assert.match(formatStatus(status), /对账记录：⚠️ 1\/2/)
  assert.match(status.next_action, /缺少可核验的全量对账记录/)
})

test('status 不会被条数相等但 source_id 重复的伪对账欺骗', () => {
  const status = buildStatus({
    packet: {
      snapshot_id: 'snap-duplicate', captured_at: '2026-08-20T10:00:00Z', snapshot_health: 'ok',
      source_health: { feishu: { ok: true, count: 2 } }, coverage: { complete: true, gaps: [] },
      counts: { total: 2, review_attention: 2 },
      review_items: [{ source_id: 'feishu:0' }, { source_id: 'feishu:1' }],
    },
    changeset: {
      snapshot_id: 'snap-duplicate', all_ok: true,
      reconciliation: [
        { source_id: 'feishu:0', decision: 'mapped', task_id: 'task-a' },
        { source_id: 'feishu:0', decision: 'irrelevant' },
      ],
    },
    now: new Date('2026-08-20T12:00:00Z'),
  })
  assert.equal(status.review.fully_reconciled, false)
  assert.match(formatStatus(status), /不能确认已完整结案/)
})
