import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReleaseStatus, compareMigrations, formatReleaseStatus, parseCommandJson } from '../workflow/release-status.mjs'

test('发布状态 JSON 提取会丢弃 Supabase CLI 的 stdout 提示', () => {
  const output = 'Initialising login role!\nConnecting to remote database...\n{"migrations":[{"local":"0001","remote":"0001"}]}\n'
  assert.deepEqual(parseCommandJson(output), { migrations: [{ local: '0001', remote: '0001' }] })
})

test('发布状态识别本地待应用迁移', () => {
  const result = compareMigrations([
    { local: '0001', remote: '0001' },
    { local: '0008', remote: '' },
    { local: '0009', remote: '' },
  ])
  assert.deepEqual(result.pending, ['0008', '0009'])
  assert.deepEqual(result.remote_only, [])
})

test('发布状态不把旧版 Edge Function 当成当前代码已部署', () => {
  const status = buildReleaseStatus({
    migrations: [{ local: '0008', remote: '' }],
    functions: [{ slug: 'feishu-notify', status: 'ACTIVE', version: 12, updated_at: '2026-08-19T00:00:00Z' }],
  })
  assert.equal(status.healthy, false)
  assert.match(status.next_action, /待应用迁移/)
  assert.match(formatReleaseStatus(status), /version 12/)
})

test('缺少线上函数时明确报告，而不是假装已发布', () => {
  const status = buildReleaseStatus({ migrations: [], functions: [] })
  assert.equal(status.feishu_notify, null)
  assert.equal(status.healthy, false)
  assert.match(formatReleaseStatus(status), /线上未找到/)
})
