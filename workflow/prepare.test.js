import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDetailArgs, buildFeishuArgs, buildSessionCandidates, resolveFeishuPaths, unmappedCwdRequired } from './prepare.mjs'

test('source-map can explicitly exclude the Workboard maintenance repository', () => {
  const result = buildSessionCandidates([
    { cwd: '/Users/zongyi/work-dashboard', lastTs: '2026-08-20T08:00:00Z' },
    { cwd: '/Users/zongyi/Unified_API_Playground/packages/jigsawcard', lastTs: '2026-08-20T09:00:00Z' },
  ], {
    ignored_cwd: [{ pattern: '/work-dashboard', hint: 'tooling' }],
    codex_cwd: [],
  }, 'codex')

  assert.deepEqual(result.hits, [])
  assert.deepEqual(result.unmapped, ['/Users/zongyi/Unified_API_Playground/packages/jigsawcard'])
  assert.equal(unmappedCwdRequired(result.unmapped), true)
})

test('ignored cwd matching remains case-insensitive and substring based', () => {
  const result = buildSessionCandidates([
    { cwd: '/tmp/WORK-DASHBOARD/.worktree', lastTs: '2026-08-20T08:00:00Z' },
  ], {
    ignored_cwd: [{ pattern: '/work-dashboard', hint: 'tooling' }],
    codex_cwd: [],
  }, 'dsh')

  assert.deepEqual(result.unmapped, [])
})

test('unmapped project directories always require explicit review', () => {
  assert.equal(unmappedCwdRequired(['/Users/zongyi/StudioProjects/new-project']), true)
  assert.equal(unmappedCwdRequired([]), false)
})

test('confirmed JigsawCard reverse-engineering directory maps to the leaderboard research task', () => {
  const result = buildSessionCandidates([
    { cwd: '/Users/zongyi/Unified_API_Playground/packages/jigsawcard', lastTs: '2026-08-20T08:00:00Z' },
  ], {
    ignored_cwd: [],
    codex_cwd: [{
      pattern: 'Unified_API_Playground/packages/jigsawcard',
      hint: 'JigsawCard 竞品触觉/震动反馈逆向',
      tasks: ['华容道排行榜功能（九月初预定）'],
    }],
  }, 'dsh')
  assert.deepEqual(result.unmapped, [])
  assert.deepEqual(result.hits[0].tasks, ['华容道排行榜功能（九月初预定）'])
})

test('Codex temporary sessions are excluded through source-map rules', () => {
  const result = buildSessionCandidates([
    { cwd: '/Users/zongyi/Documents/Codex/temporary-thread' },
  ], {
    ignored_cwd: [{ pattern: 'Documents/Codex', hint: 'temporary' }],
    codex_cwd: [],
  }, 'codex')

  assert.deepEqual(result.hits, [])
  assert.deepEqual(result.unmapped, [])
})

test('Feishu paths can be overridden without changing the default layout', () => {
  assert.deepEqual(resolveFeishuPaths('/tmp/workboard-home', {}), {
    bin: '/tmp/workboard-home/feishu_export/bin/feishu-export',
    cookies: '/tmp/workboard-home/feishu_export/cookies.json',
    output: '/tmp/workboard-home/feishu_export/daily',
  })
  assert.deepEqual(resolveFeishuPaths('/tmp/workboard-home', {
    WORKBOARD_FEISHU_BIN: '~/public/bin/feishu-export',
    WORKBOARD_FEISHU_COOKIES: '~/private/cookies.json',
    WORKBOARD_FEISHU_OUTPUT_DIR: '~/exports',
  }), {
    bin: '/tmp/workboard-home/public/bin/feishu-export',
    cookies: '/tmp/workboard-home/private/cookies.json',
    output: '/tmp/workboard-home/exports',
  })
})

test('installed maintained exporter wins over the legacy copy', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-feishu-'))
  const maintainedBin = path.join(home, 'feishu-export-public', 'bin')
  fs.mkdirSync(maintainedBin, { recursive: true })
  fs.writeFileSync(path.join(maintainedBin, 'feishu-export'), '#!/bin/sh\n')
  assert.equal(resolveFeishuPaths(home, {}).bin, path.join(home, 'feishu-export-public', 'bin', 'feishu-export'))
  fs.rmSync(home, { recursive: true, force: true })
})

test('prepare passes overridden Cookie and output paths to any exporter', () => {
  assert.deepEqual(buildFeishuArgs('2026-08-19T10:00:00.000Z', '/tmp/private cookies.json', '/tmp/feishu out'), [
    '--since', '2026-08-19T00:00', '--refresh-chats', '--markdown', '--no-update-state',
    '--cookies', '/tmp/private cookies.json', '--out', '/tmp/feishu out',
  ])
})

test('detail summaries share the analysis cursor instead of rereading stale sessions', () => {
  assert.deepEqual(buildDetailArgs('/tmp/workboard', 'codex-summary.js', 3, '2026-08-19T10:00:00.000Z'), [
    '/tmp/workboard/scripts/codex-summary.js', '--days', '3', '--detail', '--json', '--since-time', '2026-08-19T10:00:00.000Z',
  ])
  assert.deepEqual(buildDetailArgs('/tmp/workboard', 'dsh-summary.js', 3, null), [
    '/tmp/workboard/scripts/dsh-summary.js', '--days', '3', '--detail', '--json',
  ])
})
