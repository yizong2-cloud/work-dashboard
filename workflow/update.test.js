import test from 'node:test'
import assert from 'node:assert/strict'
import { runUpdate, updateCommandPlan } from './update.mjs'

test('start hides prepare/status/brief ordering behind one interface', () => {
  assert.deepEqual(updateCommandPlan('start').map(([file, ...args]) => [file.split('/').at(-1), ...args]), [
    ['status.mjs', '--guard-prepare', '--quiet'],
    ['prepare.mjs'],
    ['status.mjs', '--strict-review'],
    ['review-brief.mjs'],
  ])
})

test('preview preserves dry-run before the human confirmation preview', () => {
  const plan = updateCommandPlan('preview')
  assert.deepEqual(plan.map(([file, ...args]) => [file.split('/').at(-1), ...args]), [
    ['apply.mjs', '--dry-run'],
    ['publish.mjs', 'preview'],
  ])
})

test('confirm requires the exact phrase and stops on the first failed gate', () => {
  assert.throws(() => updateCommandPlan('confirm', '可以'), /确认推送/)
  const calls = []
  const exit = runUpdate('confirm', '确认推送', (_node, args) => {
    calls.push(args[0].split('/').at(-1))
    return { status: calls.length === 2 ? 1 : 0 }
  })
  assert.equal(exit, 1)
  assert.deepEqual(calls, ['publish.mjs', 'apply.mjs'])
})
