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
