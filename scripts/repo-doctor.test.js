import test from 'node:test'
import assert from 'node:assert/strict'
import { expandHome, inspectRegistry } from './repo-doctor.js'

test('expandHome only rewrites a leading home marker', () => {
  assert.equal(expandHome('~/repo', '/tmp/home'), '/tmp/home/repo')
  assert.equal(expandHome('/tmp/~/repo', '/tmp/home'), '/tmp/~/repo')
})

test('doctor reports missing instructions and commands through its interface', () => {
  const existing = new Set(['/home/me/repo', '/home/me/repo/.git'])
  const report = inspectRegistry({
    repositories: [{id: 'repo', path: '~/repo', kind: 'git', products: [], agentsRequired: true}],
    commands: {tool: {sourceRepo: 'repo'}},
  }, {
    home: '/home/me',
    exists: (target) => existing.has(target),
    commandExists: () => false,
  })

  assert.deepEqual(report.repositories[0].issues, ['缺少 AGENTS.md'])
  assert.equal(report.commands[0].installed, false)
})

test('critical collector worktree drift is visible without being misreported as a missing repository', () => {
  const existing = new Set(['/home/me/exporter', '/home/me/exporter/.git', '/home/me/exporter/AGENTS.md'])
  const report = inspectRegistry({
    repositories: [{id: 'exporter', path: '~/exporter', kind: 'git', products: [], agentsRequired: true, trackWorktree: true}],
    commands: {},
  }, {
    home: '/home/me',
    exists: (target) => existing.has(target),
    gitStatus: () => ' M feishu-cli.mjs',
  })

  assert.deepEqual(report.repositories[0].issues, [])
  assert.deepEqual(report.repositories[0].advisories, ['有未提交改动（当前采集代码版本不可追溯）'])
})
