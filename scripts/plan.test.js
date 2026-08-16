// ============================================================
// 日粒度计划规则测试（任务三）
// 运行: node --experimental-strip-types --test scripts/plan.test.js
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlanDates, validatePlanStatus } from '../src/lib/planRules.ts'

test('validatePlanDates：格式/真实性/顺序', () => {
  assert.equal(validatePlanDates('2026-08-17', '2026-08-18'), null)
  assert.equal(validatePlanDates('2026-08-17', '2026-08-17'), null)
  assert.match(validatePlanDates('2026/08/17', '2026-08-18'), /格式/)
  assert.match(validatePlanDates('2026-08-17', '2026-99-99'), /真实日期/)
  assert.match(validatePlanDates('2026-08-20', '2026-08-19'), /不得早于/)
  assert.equal(validatePlanDates('2026-08-20', '2026-08-20'), null)
})

test('validatePlanStatus：四种状态', () => {
  assert.equal(validatePlanStatus('planned'), 'planned')
  assert.equal(validatePlanStatus('active'), 'active')
  assert.equal(validatePlanStatus('done'), 'done')
  assert.equal(validatePlanStatus('changed'), 'changed')
  assert.equal(validatePlanStatus('cancelled'), null)
})
