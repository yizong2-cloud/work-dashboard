// ============================================================
// 反馈线程规则测试（任务一）
// 运行: node --experimental-strip-types --test scripts/feedback.test.js
// 覆盖：正文校验 / 角色校验 / 状态迁移 / 展示名 / 历史留言兼容
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FEEDBACK_BODY_MAX,
  isValidFeedbackKind,
  feedbackDisplayName,
  isValidFeedbackStatus,
  validateFeedbackBody,
  validateFeedbackRole,
} from '../src/lib/feedbackRules.ts'
import { COMMENT_PREFIX, commentBody, encodeComment, isComment } from '../src/lib/comments.ts'
import { summarizeFeedbackThreads } from '../src/lib/feedbackSummary.ts'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('validateFeedbackBody：空/空白/超长被拒，合法通过', () => {
  assert.equal(validateFeedbackBody(''), '内容不能为空')
  assert.equal(validateFeedbackBody('   '), '内容不能为空')
  assert.equal(validateFeedbackBody(null), '内容不能为空')
  const long = 'x'.repeat(FEEDBACK_BODY_MAX + 1)
  assert.match(validateFeedbackBody(long), /最多/)
  assert.equal(validateFeedbackBody('正常反馈'), null)
  assert.equal(validateFeedbackBody('  正常反馈  '), null)
})

test('validateFeedbackRole：仅 leader/owner', () => {
  assert.equal(validateFeedbackRole('leader'), 'leader')
  assert.equal(validateFeedbackRole('owner'), 'owner')
  assert.equal(validateFeedbackRole('admin'), null)
  assert.equal(validateFeedbackRole(''), null)
})

test('isValidFeedbackStatus：open/in_progress/resolved', () => {
  assert.equal(isValidFeedbackStatus('open'), true)
  assert.equal(isValidFeedbackStatus('in_progress'), true)
  assert.equal(isValidFeedbackStatus('resolved'), true)
  assert.equal(isValidFeedbackStatus('done'), false)
  assert.equal(isValidFeedbackStatus(''), false)
})

test('isValidFeedbackKind：Leader 反馈与 Agent 指令是两种不同业务数据', () => {
  assert.equal(isValidFeedbackKind('leader_feedback'), true)
  assert.equal(isValidFeedbackKind('agent_instruction'), true)
  assert.equal(isValidFeedbackKind('anything_else'), false)
})

test('feedbackDisplayName：无署名按角色给默认，有署名用署名', () => {
  assert.equal(feedbackDisplayName('leader', ''), 'Leader')
  assert.equal(feedbackDisplayName('owner', ''), '本人')
  assert.equal(feedbackDisplayName('leader', ' 张三 '), '张三')
  assert.equal(feedbackDisplayName('owner', '宗意'), '宗意')
})

test('任务详情同时保留 Leader 反馈与 Agent 处理入口，不能用一个面板改名替代另一个', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/pages/TaskDetail.tsx'), 'utf8')
  assert.match(source, /<FeedbackPanel[\s\S]*?kind="leader_feedback"/)
  assert.match(source, /<FeedbackPanel[\s\S]*?kind="agent_instruction"/)
})

test('历史留言兼容：💬 前缀 note 识别与剥离（旧版本数据不丢失）', () => {
  const encoded = encodeComment('记得跟进这个需求')
  assert.ok(encoded.startsWith(COMMENT_PREFIX))
  const fakeUpdate = { type: 'note', content: encoded }
  assert.equal(isComment(fakeUpdate), true)
  assert.equal(commentBody(fakeUpdate), '记得跟进这个需求')
  // 非 note 类型不是留言
  assert.equal(isComment({ type: 'progress', content: '💬 x' }), false)
  // 普通 note 不带前缀不是留言
  assert.equal(isComment({ type: 'note', content: '普通进展' }), false)
})

test('反馈摘要：列表同时带最新正文、作者和消息数', () => {
  const rows = [{
    id: 'thread-1', task_id: 'task-1', status: 'open', created_at: '2026-08-20T01:00:00Z',
    created_by: 'Leader', updated_at: '2026-08-20T01:02:00Z', task_feedback_messages: [{ count: 2 }],
  }]
  const messages = [
    { id: 'm1', thread_id: 'thread-1', body: '第一条', author_name: 'Leader', author_role: 'leader', created_at: '2026-08-20T01:01:00Z' },
    { id: 'm2', thread_id: 'thread-1', body: '请改到周五', author_name: 'Leader', author_role: 'leader', created_at: '2026-08-20T01:02:00Z' },
  ]
  const [summary] = summarizeFeedbackThreads(rows, messages)
  assert.equal(summary.latest_message, '请改到周五')
  assert.equal(summary.latest_author, 'Leader')
  assert.equal(summary.message_count, 2)
})
