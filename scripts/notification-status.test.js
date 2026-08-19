import test from 'node:test'
import assert from 'node:assert/strict'
import { attentionAction, formatNotificationStatus, summarizeOutbox } from '../workflow/notification-status.mjs'

test('outbox 摘要识别 failed，并只暴露截断后的错误', () => {
  const summary = summarizeOutbox([
    { id: 'a', event_type: 'task_update', status: 'failed', attempts: 3, updated_at: '2026-08-20T11:00:00Z', last_error: 'Bearer secret-value 超时' },
    { id: 'b', event_type: 'feedback_created', status: 'pending', attempts: 0, updated_at: '2026-08-20T10:00:00Z', last_error: '' },
    { id: 'c', event_type: 'task_update', status: 'sent', attempts: 1, updated_at: '2026-08-20T09:00:00Z' },
  ], new Date('2026-08-20T12:00:00Z'))
  assert.equal(summary.health, 'degraded')
  assert.deepEqual(summary.counts, { pending: 1, sending: 0, failed: 1, sent: 1, skipped: 0, unknown: 0 })
  assert.equal(summary.attention[0].last_error, 'Bearer [REDACTED] 超时')
  assert.match(summary.attention[0].action, /可重试/)
  assert.match(formatNotificationStatus(summary), /failed task_update/)
})

test('outbox 诊断区分永久错误、可重试错误和重试上限', () => {
  assert.match(attentionAction({ status: 'failed', attempts: 2, last_error: 'Task not found: x' }), /无需重试/)
  assert.match(attentionAction({ status: 'failed', attempts: 2, last_error: 'too many request' }), /可重试/)
  assert.match(attentionAction({ status: 'failed', attempts: 5, last_error: 'network error' }), /重试上限/)
})

test('没有待处理事件时 outbox 状态为 ok', () => {
  const summary = summarizeOutbox([{ status: 'sent', event_type: 'task_update' }])
  assert.equal(summary.health, 'ok')
  assert.deepEqual(summary.attention, [])
})

test('sending 与 pending 会进入关注列表，但不伪装成 failed', () => {
  const summary = summarizeOutbox([{ status: 'sending', event_type: 'feedback_replied' }, { status: 'pending', event_type: 'task_update' }])
  assert.equal(summary.health, 'pending')
  assert.equal(summary.attention.length, 2)
  assert.ok(summary.attention.every((row) => row.status !== 'failed'))
})
