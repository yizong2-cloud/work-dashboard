import test from 'node:test'
import assert from 'node:assert/strict'
import { TEST_FILES, buildTestArgs } from './run-tests.mjs'

test('default test runner is compact, while verbose mode retains the same complete inventory', () => {
  const compact = buildTestArgs()
  const verbose = buildTestArgs({ verbose: true })
  assert.ok(compact.includes('--test-reporter=dot'))
  assert.ok(!verbose.includes('--test-reporter=dot'))
  assert.deepEqual(compact.filter((arg) => arg.endsWith('.test.js')), TEST_FILES)
  assert.deepEqual(verbose.filter((arg) => arg.endsWith('.test.js')), TEST_FILES)
  for (const required of ['scripts/agent.test.js', 'scripts/decision.test.js', 'workflow/prepare.test.js', 'workflow/apply-safety.test.js']) {
    assert.ok(TEST_FILES.includes(required), `测试清单不能漏掉 ${required}`)
  }
})
