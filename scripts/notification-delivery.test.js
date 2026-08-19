import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyDeliveryFailure } from '../supabase/functions/feishu-notify/delivery.ts'

test('永久性数据错误转为 skipped，不进入自动重试', () => {
  assert.equal(classifyDeliveryFailure('Task not found: abc'), 'skip')
  assert.equal(classifyDeliveryFailure('Thread not found: xyz'), 'skip')
  assert.equal(classifyDeliveryFailure('Event has no task_id'), 'skip')
})

test('频控和网络错误保留为 retry', () => {
  assert.equal(classifyDeliveryFailure('Feishu custom bot failed: 400 too many request'), 'retry')
  assert.equal(classifyDeliveryFailure('fetch failed'), 'retry')
})
