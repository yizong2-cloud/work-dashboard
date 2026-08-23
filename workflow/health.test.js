import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHealth, collectHealth, formatHealth } from './health.mjs'

const settledSnapshot = {
  packet_available: true, snapshot_health: 'ok', snapshot_stale: false, source_health_recorded: true,
  coverage: { complete: true }, apply: { matched_snapshot: true }, review: { fully_reconciled: true, reconciled_count: 3, expected_count: 3 },
  pending: { active: false }, publish: { awaiting_confirmation: false },
}
const healthyRelease = { healthy: true, migrations: { local: ['1'], remote: ['1'] } }
const healthyNotifications = { health: 'ok', counts: { pending: 0, sending: 0, failed: 0 } }
const healthyRepositories = { repositories: [{ id: 'dashboard', issues: [], advisories: [] }] }

test('health overview is normal only when every operational surface is healthy', () => {
  const health = buildHealth({
    snapshot: settledSnapshot, release: healthyRelease, notifications: healthyNotifications, repositories: healthyRepositories,
  })
  assert.equal(health.state, 'ok')
  assert.match(formatHealth(health), /采集与审查：正常 · 已结案 3\/3/)
  assert.match(formatHealth(health), /无需操作/)
})

test('health overview distinguishes ordinary review work from infrastructure attention', () => {
  const review = buildHealth({
    snapshot: { ...settledSnapshot, apply: { matched_snapshot: false }, review: { fully_reconciled: false } },
    release: healthyRelease, notifications: healthyNotifications, repositories: healthyRepositories,
  })
  assert.equal(review.state, 'review')
  assert.match(formatHealth(review), /采集与审查：待审查/)

  const attention = buildHealth({
    snapshot: settledSnapshot, release: { ...healthyRelease, healthy: false, next_action: '先部署迁移' },
    notifications: healthyNotifications, repositories: healthyRepositories,
  })
  assert.equal(attention.state, 'attention')
  assert.match(formatHealth(attention), /发布：需处理 · 先部署迁移/)
})

test('health overview reports a dirty tracked collector as watch, not a missing repository', () => {
  const health = buildHealth({
    snapshot: settledSnapshot, release: healthyRelease, notifications: healthyNotifications,
    repositories: { repositories: [{ id: 'feishu-export-public', issues: [], advisories: ['有未提交改动'] }] },
  })
  assert.equal(health.state, 'watch')
  assert.match(formatHealth(health), /工作区：关注 · 1 个提示：feishu-export-public/)
})

test('health overview retains a sanitized underlying check failure as the action clue', () => {
  const health = buildHealth({
    snapshot: settledSnapshot, release: healthyRelease, notifications: { __health_error: '缺少本机凭据' }, repositories: healthyRepositories,
  })
  assert.equal(health.state, 'attention')
  assert.match(formatHealth(health), /通知检查失败：缺少本机凭据/)
})

test('health collector calls JSON-only, read-only status interfaces', () => {
  const calls = []
  const health = collectHealth((script, timeout) => {
    calls.push({ script, timeout })
    if (script === 'workflow/status.mjs') return settledSnapshot
    if (script === 'workflow/release-status.mjs') return healthyRelease
    if (script === 'workflow/notification-status.mjs') return healthyNotifications
    return healthyRepositories
  })
  assert.deepEqual(calls.map((call) => call.script), [
    'workflow/status.mjs', 'workflow/release-status.mjs', 'workflow/notification-status.mjs', 'scripts/repo-doctor.js',
  ])
  assert.equal(health.state, 'ok')
})
