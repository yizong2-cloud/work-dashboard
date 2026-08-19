import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

test('release-status --json 不把 Supabase CLI 的 stderr 进度日志混入结果', () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-release-status-'))
  const fakeNpx = path.join(binDir, 'npx')
  fs.writeFileSync(fakeNpx, `#!/usr/bin/env node
console.error('Initialising login role...')
console.error('Connecting to remote database...')
const isMigration = process.argv.includes('migration')
process.stdout.write(JSON.stringify(isMigration
  ? { migrations: [{ local: '0001', remote: '0001' }] }
  : { functions: [{ slug: 'feishu-notify', status: 'ACTIVE', version: 1 }] }))
`)
  fs.chmodSync(fakeNpx, 0o755)
  try {
    const result = spawnSync(process.execPath, ['workflow/release-status.mjs', '--json'], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    assert.equal(JSON.parse(result.stdout).feishu_notify.version, 1)
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true })
  }
})
