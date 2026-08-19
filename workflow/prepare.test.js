import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionCandidates, resolveFeishuPaths, unmappedCwdRequired } from './prepare.mjs'

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
