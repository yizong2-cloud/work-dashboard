import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const schema = fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8')
const migration = fs.readFileSync(new URL('../supabase/migrations/0008_notification_delivery_cron.sql', import.meta.url), 'utf8')
const backoffMigration = fs.readFileSync(new URL('../supabase/migrations/0009_notification_retry_backoff.sql', import.meta.url), 'utf8')
const decisionNotificationMigration = fs.readFileSync(new URL('../supabase/migrations/0010_decision_response_personal_notification.sql', import.meta.url), 'utf8')
const dailyReportMigration = fs.readFileSync(new URL('../supabase/migrations/0012_daily_report_excludes_agent_instructions.sql', import.meta.url), 'utf8')

test('通知 outbox 的总 schema 与增量迁移都声明自动维护调度', () => {
  for (const source of [schema, migration]) {
    assert.match(source, /workboard-notification-pending/)
    assert.match(source, /workboard-notification-retry/)
    assert.match(source, /deliver_pending_notifications\(\)/)
    assert.match(source, /retry_failed_notifications\(5\)/)
    assert.match(source, /cron\.unschedule/)
  }
})

test('失败通知重试契约包含按 attempts 递增的退避条件', () => {
  for (const source of [schema, backoffMigration]) {
    assert.match(source, /status = 'failed'/)
    assert.match(source, /attempts < max_attempts/)
    assert.match(source, /15 minutes.*greatest\(1, attempts\)/s)
  }
})

test('决策答卷通知：写入专用事件且不依赖群机器人路由', () => {
  assert.match(decisionNotificationMigration, /decision_response_submitted/)
  assert.match(decisionNotificationMigration, /notify_decision_response_trigger/)
  assert.match(schema, /decision_response_submitted/)
})

test('Leader 日报只统计 Leader 留言，不泄露 Agent 处理箱的待处理数量', () => {
  for (const source of [schema, dailyReportMigration]) {
    assert.match(source, /from public\.task_feedback_threads\s+where status <> 'resolved'\s+and kind = 'leader_feedback';/s)
  }
})
