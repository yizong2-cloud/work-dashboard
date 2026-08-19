import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const schema = fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8')
const migration = fs.readFileSync(new URL('../supabase/migrations/0008_notification_delivery_cron.sql', import.meta.url), 'utf8')

test('通知 outbox 的总 schema 与增量迁移都声明自动维护调度', () => {
  for (const source of [schema, migration]) {
    assert.match(source, /workboard-notification-pending/)
    assert.match(source, /workboard-notification-retry/)
    assert.match(source, /deliver_pending_notifications\(\)/)
    assert.match(source, /retry_failed_notifications\(5\)/)
    assert.match(source, /cron\.unschedule/)
  }
})
