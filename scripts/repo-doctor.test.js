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
