// ============================================================
// 反馈线程规则测试（任务一）
// 运行: node --experimental-strip-types --test scripts/feedback.test.js
// 覆盖：正文校验 / 角色校验 / 状态迁移 / 展示名 / 历史留言兼容
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FEEDBACK_BODY_MAX,
  feedbackDisplayName,
  isValidFeedbackStatus,
  validateFeedbackBody,
  validateFeedbackRole,
} from '../src/lib/feedbackRules.ts'
import { COMMENT_PREFIX, commentBody, encodeComment, isComment } from '../src/lib/comments.ts'

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

test('feedbackDisplayName：无署名按角色给默认，有署名用署名', () => {
  assert.equal(feedbackDisplayName('leader', ''), 'Leader')
  assert.equal(feedbackDisplayName('owner', ''), '本人')
  assert.equal(feedbackDisplayName('leader', ' 张三 '), '张三')
  assert.equal(feedbackDisplayName('owner', '宗意'), '宗意')
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
