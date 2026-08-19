// ============================================================
// feishu-notify 卡片构建测试（任务二）
// 运行: node --experimental-strip-types --test scripts/notify-cards.test.js
// 覆盖：任务事件 / 反馈创建 / 回复（含原反馈摘要）/ 解决 / progress 聚合 / 深链接
// 纯 JS 写法（node strip 不支持 as/! 表达式）
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCard, buildDailyCard, decisionExportLink, deepLink } from '../supabase/functions/feishu-notify/cards.ts'
import { audienceForEvent } from '../supabase/functions/feishu-notify/routing.ts'

const BASE = 'https://yizong2-cloud.github.io/work-dashboard/'
function localDateOffset(days) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const TASK = {
  id: 't-1', title: '宁静拼图主题系统', status: 'in_progress',
  progress: 65, expected_end_date: localDateOffset(1), block_reason: '',
}

function ev(event_type, payload) {
  return { id: 'ev-1', event_type, payload }
}

function headerOf(card) {
  return card.header
}

test('deepLink：任务详情与反馈线程深链接', () => {
  assert.equal(deepLink(BASE, 't-1'), 'https://yizong2-cloud.github.io/work-dashboard/#/task/t-1')
  assert.equal(deepLink(BASE, 't-1', 'ft-9'), 'https://yizong2-cloud.github.io/work-dashboard/#/task/t-1?thread=ft-9')
  assert.equal(deepLink('https://x.github.io/work-dashboard', 't-1'), 'https://x.github.io/work-dashboard/#/task/t-1')
})

test('通知分流：决策答卷只投递个人，其余协作事件投递群', () => {
  assert.equal(audienceForEvent('decision_response_submitted'), 'personal')
  assert.equal(audienceForEvent('task_nudged'), 'group')
  assert.equal(audienceForEvent('task_update'), 'group')
})

test('decision_response_submitted：个人卡片直达决策结果页', () => {
  const card = buildCard(ev('decision_response_submitted', {
    form_slug: 'puzzle-decisions', form_title: '拼图产品决策', respondent_name: 'PM',
    submitted_at: '2026-08-20T01:02:00Z',
  }), null, BASE)
  const json = JSON.stringify(card)
  assert.equal(decisionExportLink(BASE, 'puzzle-decisions'), 'https://yizong2-cloud.github.io/work-dashboard/#/decisions/puzzle-decisions/export')
  assert.match(json, /收到新的决策答卷/)
  assert.match(json, /拼图产品决策/)
  assert.match(json, /提交人：PM/)
  assert.match(json, /#\/decisions\/puzzle-decisions\/export/)
  assert.match(json, /仅发送给 Leader/)
})

test('task_update：阻塞事件 → 红色卡片 + 任务详情按钮', () => {
  const card = buildCard(ev('task_update', { task_id: 't-1', type: 'blocked', content: '等待美术资源', created_by: 'Agent' }), TASK, BASE)
  assert.ok(card)
  assert.equal(headerOf(card).template, 'red')
  assert.equal(headerOf(card).subtitle.content, '任务出现阻塞')
  assert.match(JSON.stringify(card), /查看任务详情/)
  assert.match(JSON.stringify(card), /等待美术资源/)
})

test('feedback_created：Leader 反馈 → 深链接带 thread 参数', () => {
  const card = buildCard(
    ev('feedback_created', { thread_id: 'ft-9', body: '这个需求排期要确认', author_name: 'Leader', author_role: 'leader' }),
    TASK, BASE,
  )
  assert.match(JSON.stringify(card), /发起了新反馈/)
  assert.match(JSON.stringify(card), /#\/task\/t-1\?thread=ft-9/)
  assert.match(JSON.stringify(card), /查看反馈并回复/)
})

test('feedback_replied：回复卡片带原反馈摘要', () => {
  const card = buildCard(
    ev('feedback_replied', { thread_id: 'ft-9', body: '收到，明天给结论', author_name: '本人', author_role: 'owner' }),
    TASK, BASE,
    { body: '这个需求排期要确认', author_name: 'Leader', created_at: '2026-08-16T00:00:00Z' },
  )
  const json = JSON.stringify(card)
  assert.match(json, /回复了反馈/)
  assert.match(json, /收到，明天给结论/)
  assert.match(json, /原反馈（Leader）：这个需求排期要确认/)
  assert.match(json, /#\/task\/t-1\?thread=ft-9/)
})

test('feedback_resolved：解决 → 绿色低噪音；重新打开 → 橙色', () => {
  const done = buildCard(ev('feedback_resolved', { thread_id: 'ft-9', new_status: 'resolved', resolved_by: '本人' }), TASK, BASE)
  assert.equal(headerOf(done).template, 'green')
  assert.match(JSON.stringify(done), /反馈已解决/)
  const reopened = buildCard(ev('feedback_resolved', { thread_id: 'ft-9', new_status: 'open' }), TASK, BASE)
  assert.equal(headerOf(reopened).template, 'orange')
  assert.match(JSON.stringify(reopened), /重新打开/)
})

test('task_update_progress：聚合摘要卡显示条数', () => {
  const card = buildCard(
    ev('task_update_progress', { task_id: 't-1', type: 'progress', count: 3, latest: '完成联调', content: '旧内容' }),
    TASK, BASE,
  )
  assert.match(JSON.stringify(card), /任务进度更新（3 条）/)
  assert.match(JSON.stringify(card), /完成联调/)
})

test('task_update：加急事件 → 红色卡片 + 加急标题', () => {
  const card = buildCard(
    ev('task_update', { task_id: 't-1', type: 'urgent', content: 'Leader 要求本周内完成', created_by: 'Leader' }),
    TASK, BASE,
  )
  assert.ok(card)
  assert.equal(headerOf(card).template, 'red')
  assert.equal(headerOf(card).subtitle.content, '任务加急')
  assert.match(JSON.stringify(card), /Leader 要求本周内完成/)
})

test('task_update：逾期任务按钮变「去更新进度」并带 action 参数', () => {
  const overdueTask = { ...TASK, expected_end_date: '2020-01-01' }
  const card = buildCard(
    ev('task_update', { task_id: 't-1', type: 'note', content: '还在弄', created_by: 'Agent' }),
    overdueTask, BASE,
  )
  const json = JSON.stringify(card)
  assert.match(json, /去更新进度/)
  assert.match(json, /action=progress/)
  assert.doesNotMatch(json, /查看任务详情/)
})

test('task_update：取消加急 → 蓝色「任务取消加急」卡片（不与加急混淆）', () => {
  const card = buildCard(
    ev('task_update', { task_id: 't-1', type: 'deurgent', content: '优先级恢复', created_by: 'Leader' }),
    TASK, BASE,
  )
  assert.ok(card)
  assert.equal(headerOf(card).template, 'blue')
  assert.equal(headerOf(card).subtitle.content, '任务取消加急')
  assert.match(JSON.stringify(card), /优先级恢复/)
})

test('task_nudged：催进度 → 橙色卡片 + 深链接', () => {
  const card = buildCard(
    ev('task_nudged', { task_id: 't-1', type: 'nudge', content: '这个周五前能完成吗？', created_by: 'Leader' }),
    TASK, BASE,
  )
  assert.ok(card)
  assert.equal(headerOf(card).template, 'orange')
  assert.equal(headerOf(card).subtitle.content, '⏰ 有人催进度了')
  const json = JSON.stringify(card)
  assert.match(json, /这个周五前能完成吗？/)
  assert.match(json, /#\/task\/t-1/)
  assert.match(json, /Leader 催办/)
})

test('buildCard：未知事件返回 null', () => {
  assert.equal(buildCard(ev('unknown_event', {}), TASK, BASE), null)
})

test('卡片深链接不泄露 webhook/密钥（URL 仅为看板站点）', () => {
  const card = buildCard(ev('feedback_created', { thread_id: 'ft-9', body: 'x', author_name: 'Leader' }), TASK, BASE)
  const json = JSON.stringify(card)
  assert.doesNotMatch(json, /hook|secret|token|service_role|eyJ/i)
})

test('buildDailyCard：各风险区块 + 每条深链可点', () => {
  const card = buildDailyCard(ev('daily_report', {
    date: '2026-08-17',
    overdue: [{ task_id: 't-1', title: '过期任务A', progress: 40, expected_end_date: '2026-08-15' }],
    week: [{ task_id: 't-2', title: '本周任务B', progress: 70, expected_end_date: '2026-08-20' }],
    urgent: [{ task_id: 't-3', title: '加急任务C', progress: 30 }],
    blocked: [{ task_id: 't-4', title: '阻塞任务D', progress: 10, block_reason: '等美术资源' }],
    unscheduled: [{ task_id: 't-5', title: '未排期任务E', progress: 0, current_status: '等设计稿' }],
    feedback_open: 2, updates_today: 9, active_count: 10, planned_count: 1,
  }), BASE)
  const json = JSON.stringify(card)
  assert.ok(card)
  assert.equal(headerOf(card).template, 'orange')
  assert.match(json, /日报 8\/17/)
  assert.match(json, /已逾期（1）/)
  assert.match(json, /逾期 \d+ 天/)
  assert.match(json, /本周到期（1）/)
  assert.match(json, /加急中（1）/)
  assert.match(json, /阻塞（1）/)
  assert.match(json, /未排期（1）/)
  assert.match(json, /等设计稿/)
  assert.match(json, /进行中\*\* 10 · \*\*待开始\*\* 1 · \*\*今日更新\*\* 9 · \*\*待回应反馈\*\* 2/)
  // 每条风险可点击深链到任务
  assert.match(json, /#\/task\/t-1/)
  assert.match(json, /#\/task\/t-5/)
  assert.match(json, /查看完整看板/)
})

test('buildDailyCard：无风险 → 蓝色 + 平安描述', () => {
  const card = buildDailyCard(ev('daily_report', {
    date: '2026-08-17',
    overdue: [], week: [], urgent: [], blocked: [], unscheduled: [],
    feedback_open: 0, updates_today: 0, active_count: 0, planned_count: 0,
  }), BASE)
  assert.equal(headerOf(card).template, 'blue')
  assert.match(JSON.stringify(card), /无逾期 · 无加急 · 无阻塞/)
})
