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
    ['apply.mjs', '--dry-run', '--quiet'],
    ['publish.mjs', 'preview'],
  ])
})

test('retry reuses the still-valid fingerprint approval without asking for a magic phrase', () => {
  assert.deepEqual(updateCommandPlan('retry').map(([file, ...args]) => [file.split('/').at(-1), ...args]), [
    ['apply.mjs'],
    ['verify.mjs'],
    ['notification-status.mjs'],
  ])
})

test('confirm accepts explicit natural-language approval and stops on the first failed gate', () => {
  assert.doesNotThrow(() => updateCommandPlan('confirm', '确认'))
  assert.doesNotThrow(() => updateCommandPlan('confirm', '按这版推送'))
  assert.doesNotThrow(() => updateCommandPlan('confirm', '把我说的这些改了，你就可以更新了'))
  assert.throws(() => updateCommandPlan('confirm', '先不要推送'), /明确同意/)
  const calls = []
  const exit = runUpdate('confirm', '确认', (_node, args) => {
    calls.push(args[0].split('/').at(-1))
    return { status: calls.length === 2 ? 1 : 0 }
  })
  assert.equal(exit, 1)
  assert.deepEqual(calls, ['publish.mjs', 'apply.mjs'])
})
