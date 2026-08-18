// ============================================================
// 决策中心规则、格式化与数据契约测试
// 运行: npm test
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateDecisionPayload,
  validateDecisionSubmission,
} from '../src/lib/decisionRules.ts'
import {
  formatDecisionMarkdown,
  formatDecisionJson,
  formatShanghaiTime,
} from '../src/lib/decisionFormat.ts'
import { createStore } from './lib/store.js'

const sampleValidPayload = {
  slug: 'test-puzzle-retention',
  title: '拼图积分与完成激励：请确认产品决策',
  summary: '请逐题确认；未覆盖的口径请写在补充说明。',
  source_document: '# PRD Background Document',
  status: 'open',
  created_by: 'decision-form-agent',
  questions: [
    {
      code: 'D1',
      title: '连击如何累计和中断',
      context: '策划案未定义一次操作如何计数。',
      type: 'single_choice',
      required: true,
      allow_other: true,
      recommended_option_code: 'A',
      recommended_reason: '按竞品 5.0.21 源码确认后的事件口径',
      options: [
        { code: 'A', label: '按竞品事件口径', detail: '按 5.0.21 源码确认后的事件口径' },
        { code: 'B', label: '按底层事件计数', detail: '每次放置即触发计数' },
      ],
    },
    {
      code: 'D2',
      title: 'Hint 道具是否清零连击',
      context: '使用道具时的分数策略。',
      type: 'single_choice',
      required: true,
      allow_other: false,
      recommended_option_code: 'B',
      recommended_reason: '清零连击防刷分',
      options: [
        { code: 'A', label: '不清零', detail: '继续累加' },
        { code: 'B', label: '清零连击', detail: '与竞品一致' },
      ],
    },
    {
      code: 'D3',
      title: '其余题按推荐方案执行',
      context: '包含重连与跨天策略。',
      type: 'confirmation',
      required: true,
      recommended_reason: '统一按推荐口径',
    },
  ],
}

test('validateDecisionPayload：合法 payload 校验通过', () => {
  const res = validateDecisionPayload(sampleValidPayload)
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validateDecisionPayload：slug 校验（缺失、非法字符、重复）', () => {
  assert.equal(validateDecisionPayload({ ...sampleValidPayload, slug: '' }).valid, false)
  assert.equal(validateDecisionPayload({ ...sampleValidPayload, slug: 'invalid slug with spaces' }).valid, false)
  assert.equal(validateDecisionPayload({ ...sampleValidPayload, slug: 'invalid/slash' }).valid, false)
})

test('validateDecisionPayload：题号与选项重复、题型非法被拒', () => {
  // 重复题号
  const duplicateQuestions = {
    ...sampleValidPayload,
    questions: [
      { code: 'D1', title: '题1', type: 'free_text' },
      { code: 'D1', title: '题2', type: 'free_text' },
    ],
  }
  const resDupQ = validateDecisionPayload(duplicateQuestions)
  assert.equal(resDupQ.valid, false)
  assert.match(resDupQ.errors.join(';'), /题目编号重复/)

  // 重复选项 code
  const duplicateOptions = {
    ...sampleValidPayload,
    questions: [
      {
        code: 'D1',
        title: '题1',
        type: 'single_choice',
        options: [
          { code: 'A', label: '选项1' },
          { code: 'A', label: '选项2' },
        ],
      },
    ],
  }
  const resDupOpt = validateDecisionPayload(duplicateOptions)
  assert.equal(resDupOpt.valid, false)
  assert.match(resDupOpt.errors.join(';'), /选项编号重复/)

  // 推荐项 code 不存在
  const badRec = {
    ...sampleValidPayload,
    questions: [
      {
        code: 'D1',
        title: '题1',
        type: 'single_choice',
        recommended_option_code: 'Z',
        options: [
          { code: 'A', label: '选项1' },
          { code: 'B', label: '选项2' },
        ],
      },
    ],
  }
  const resBadRec = validateDecisionPayload(badRec)
  assert.equal(resBadRec.valid, false)
  assert.match(resBadRec.errors.join(';'), /推荐项 code "Z" 不在已有选项中/)
})

test('validateDecisionSubmission：草稿与关闭拦截、单选题多选/混选校验、禁止其他说明防绕过', () => {
  const formDetail = {
    id: 'f-1',
    slug: 'strict-validation-form',
    title: '严格校验表单',
    summary: '',
    source_document: null,
    status: 'open',
    created_by: 'agent',
    created_at: '2026-08-19T00:00:00.000Z',
    closed_at: null,
    updated_at: '2026-08-19T00:00:00.000Z',
    questions: [
      {
        id: 'q-single-no-other',
        form_id: 'f-1',
        code: 'D1',
        sort_order: 0,
        title: '单选不可其他',
        context: '',
        type: 'single_choice',
        required: true,
        allow_other: false,
        recommended_option_id: 'opt-1-a',
        options: [
          { id: 'opt-1-a', question_id: 'q-single-no-other', code: 'A', label: '选项A', detail: '', sort_order: 0 },
          { id: 'opt-1-b', question_id: 'q-single-no-other', code: 'B', label: '选项B', detail: '', sort_order: 1 },
        ],
      },
      {
        id: 'q-free-text',
        form_id: 'f-1',
        code: 'D2',
        sort_order: 1,
        title: '必填自由文本',
        context: '',
        type: 'free_text',
        required: true,
        allow_other: false,
        recommended_option_id: null,
        options: [],
      },
      {
        id: 'q-confirm',
        form_id: 'f-1',
        code: 'D3',
        sort_order: 2,
        title: '必填确认',
        context: '',
        type: 'confirmation',
        required: true,
        allow_other: false,
        recommended_option_id: null,
        options: [],
      },
    ],
    responses: [],
  }

  // 1. 草稿表单提交被拒绝
  const draftRes = validateDecisionSubmission(
    { ...formDetail, status: 'draft' },
    { respondent_name: '测试人', answers: [] },
  )
  assert.equal(draftRes.valid, false)
  assert.match(draftRes.errors.form, /草稿状态/)

  // 2. 关闭表单提交被拒绝
  const closedRes = validateDecisionSubmission(
    { ...formDetail, status: 'closed' },
    { respondent_name: '测试人', answers: [] },
  )
  assert.equal(closedRes.valid, false)
  assert.match(closedRes.errors.form, /已关闭/)

  // 3. 对 allow_other=false 提交 other_text 必须报错拦截（防绕过）
  const bypassOtherRes = validateDecisionSubmission(formDetail, {
    respondent_name: '测试人',
    answers: [
      { question_id: 'q-single-no-other', other_text: '绕过其他' },
      { question_id: 'q-free-text', text_answer: '正常文本' },
      { question_id: 'q-confirm', text_answer: 'confirmed' },
    ],
  })
  assert.equal(bypassOtherRes.valid, false)
  assert.match(bypassOtherRes.errors['q-single-no-other'], /未开启“其他”选项，禁止提交其他说明/)

  // 4. 单选题选择 > 1 个选项必须报错
  const multiSingleRes = validateDecisionSubmission(formDetail, {
    respondent_name: '测试人',
    answers: [
      { question_id: 'q-single-no-other', selected_option_ids: ['opt-1-a', 'opt-1-b'] },
      { question_id: 'q-free-text', text_answer: '正常文本' },
      { question_id: 'q-confirm', text_answer: 'confirmed' },
    ],
  })
  assert.equal(multiSingleRes.valid, false)
  assert.match(multiSingleRes.errors['q-single-no-other'], /只能选择一个选项/)

  // 5. 自由文本题传入 selected_option_ids 必须报错
  const optInFreeRes = validateDecisionSubmission(formDetail, {
    respondent_name: '测试人',
    answers: [
      { question_id: 'q-single-no-other', selected_option_ids: ['opt-1-a'] },
      { question_id: 'q-free-text', selected_option_ids: ['opt-1-a'], text_answer: '正常文本' },
      { question_id: 'q-confirm', text_answer: 'confirmed' },
    ],
  })
  assert.equal(optInFreeRes.valid, false)
  assert.match(optInFreeRes.errors['q-free-text'], /不得包含选项选择/)

  // 6. 确认题传入非法值（如 maybe）必须报错
  const badConfirmRes = validateDecisionSubmission(formDetail, {
    respondent_name: '测试人',
    answers: [
      { question_id: 'q-single-no-other', selected_option_ids: ['opt-1-a'] },
      { question_id: 'q-free-text', text_answer: '正常文本' },
      { question_id: 'q-confirm', text_answer: 'maybe' },
    ],
  })
  assert.equal(badConfirmRes.valid, false)
  assert.match(badConfirmRes.errors['q-confirm'], /只允许 confirmed 或 unconfirmed/)

  // 7. 合法提交通过
  const validRes = validateDecisionSubmission(formDetail, {
    respondent_name: '张三',
    respondent_note: '确认无误',
    answers: [
      { question_id: 'q-single-no-other', selected_option_ids: ['opt-1-a'] },
      { question_id: 'q-free-text', text_answer: '崩溃时清零连击计数器' },
      { question_id: 'q-confirm', text_answer: 'confirmed' },
    ],
  })
  assert.equal(validRes.valid, true)
  assert.equal(Object.keys(validRes.errors).length, 0)

  // 8. 提交身份是选填；匿名反馈仍须完整遵守题目规则
  const anonymousRes = validateDecisionSubmission(formDetail, {
    respondent_name: '',
    answers: [
      { question_id: 'q-single-no-other', selected_option_ids: ['opt-1-a'] },
      { question_id: 'q-free-text', text_answer: '匿名结论' },
      { question_id: 'q-confirm', text_answer: 'confirmed' },
    ],
  })
  assert.equal(anonymousRes.valid, true)
  assert.equal(anonymousRes.errors.respondent_name, undefined)
})

test('formatShanghaiTime：正确格式化北京时间', () => {
  const formatted = formatShanghaiTime('2026-08-19T06:32:00.000Z')
  assert.match(formatted, /2026-08-19 14:32 \(Asia\/Shanghai\)/)
})

test('formatDecisionMarkdown：0 份反馈时输出清晰空提示，不虚构答案', () => {
  const formDetail = {
    id: 'f-1',
    slug: 'empty-form',
    title: '空表单测试',
    summary: '暂无答卷',
    source_document: null,
    status: 'open',
    created_by: 'agent',
    created_at: '2026-08-19T00:00:00.000Z',
    closed_at: null,
    updated_at: '2026-08-19T00:00:00.000Z',
    questions: [],
    responses: [],
  }
  const md = formatDecisionMarkdown(formDetail)
  assert.match(md, /# 空表单测试 — 决策结果/)
  assert.match(md, /尚未收到任何决策反馈/)
})

test('formatDecisionMarkdown 与 formatDecisionJson：多答卷结构与答卷人筛选一致', () => {
  const formDetail = {
    id: 'f-1',
    slug: 'puzzle-incentives',
    title: '拼图积分与完成激励',
    summary: '决策测试',
    source_document: null,
    status: 'open',
    created_by: 'decision-form-agent',
    created_at: '2026-08-19T00:00:00.000Z',
    closed_at: null,
    updated_at: '2026-08-19T00:00:00.000Z',
    questions: [
      {
        id: 'q-1',
        form_id: 'f-1',
        code: 'D1',
        sort_order: 0,
        title: '连击如何累计和中断',
        context: '',
        type: 'single_choice',
        required: true,
        allow_other: true,
        recommended_option_id: 'opt-1',
        recommended_option_code: 'A',
        options: [
          { id: 'opt-1', question_id: 'q-1', code: 'A', label: '按竞品 5.0.21 源码口径', detail: '', sort_order: 0 },
          { id: 'opt-2', question_id: 'q-1', code: 'B', label: '按底层计数', detail: '', sort_order: 1 },
        ],
      },
    ],
    responses: [
      {
        id: 'r-1',
        form_id: 'f-1',
        respondent_name: '商雯祺',
        respondent_note: '与竞品一致',
        submitted_at: '2026-08-19T06:32:00.000Z',
        answers: [
          {
            id: 'a-1',
            response_id: 'r-1',
            question_id: 'q-1',
            selected_option_ids: ['opt-1'],
            text_answer: '',
            other_text: '',
          },
        ],
      },
      {
        id: 'r-2',
        form_id: 'f-1',
        respondent_name: '李四',
        respondent_note: '',
        submitted_at: '2026-08-19T07:00:00.000Z',
        answers: [
          {
            id: 'a-2',
            response_id: 'r-2',
            question_id: 'q-1',
            selected_option_ids: [],
            text_answer: '',
            other_text: '自定义方案',
          },
        ],
      },
    ],
  }

  // 全部导出
  const mdAll = formatDecisionMarkdown(formDetail)
  assert.match(mdAll, /已收反馈：2 份/)
  assert.match(mdAll, /提交身份：商雯祺/)
  assert.match(mdAll, /整体说明：与竞品一致/)
  assert.match(mdAll, /提交身份：李四/)
  assert.match(mdAll, /## D1\. 连击如何累计和中断/)
  assert.match(mdAll, /A（按竞品 5.0.21 源码口径）/)
  assert.match(mdAll, /其他（自定义方案）/)

  // 指定答卷人导出
  const mdFilter = formatDecisionMarkdown(formDetail, { respondentName: '商雯祺' })
  assert.match(mdFilter, /提交身份：商雯祺/)
  assert.doesNotMatch(mdFilter, /提交身份：李四/)

  // JSON 导出
  const jsonStr = formatDecisionJson(formDetail, { respondentName: '商雯祺' })
  const parsed = JSON.parse(jsonStr)
  assert.equal(parsed.form.slug, 'puzzle-incentives')
  assert.equal(parsed.responses.length, 1)
  assert.equal(parsed.responses[0].respondent_name, '商雯祺')
  assert.equal(parsed.responses[0].respondent_note, '与竞品一致')
  assert.equal(parsed.responses[0].answers[0].question_code, 'D1')
  assert.equal(parsed.responses[0].answers[0].selected_options[0].code, 'A')
})

test('存储层：创建表单、多答卷独立提交、关闭拦截全链路', async () => {
  const tempDbFile = `/tmp/test-decision-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  process.env.LOCAL_DB_FILE = tempDbFile
  const testStore = createStore({})

  // 1. 创建表单
  const createRes = await testStore.createDecisionForm({
    slug: 'retention-test-1',
    title: '留存策略决策',
    questions: [
      {
        code: 'D1',
        title: '奖励翻倍口径',
        type: 'single_choice',
        required: true,
        allow_other: true,
        recommended_option_code: 'A',
        options: [
          { code: 'A', label: '广告双倍' },
          { code: 'B', label: '直接发放' },
        ],
      },
      {
        code: 'D2',
        title: '补充意见',
        type: 'free_text',
        required: false,
      },
    ],
  })
  assert.equal(createRes.slug, 'retention-test-1')

  // 2. 查询表单
  const form = await testStore.getDecisionFormBySlug('retention-test-1')
  assert.ok(form)
  assert.equal(form.questions.length, 2)
  assert.equal(form.questions[0].recommended_option_code, 'A')
  const optAId = form.questions[0].options.find((o) => o.code === 'A').id
  const q1Id = form.questions[0].id
  const q2Id = form.questions[1].id

  // 3. 用户 A 提交答卷
  const resp1 = await testStore.submitDecisionResponse('retention-test-1', '商雯祺', [
    { question_id: q1Id, selected_option_ids: [optAId] },
    { question_id: q2Id, text_answer: '建议尽快上线' },
  ], '第一版确认')
  assert.ok(resp1.id)
  assert.equal(resp1.respondent_note, '第一版确认')

  // 4. 用户 B 提交答卷
  const resp2 = await testStore.submitDecisionResponse('retention-test-1', '张三', [
    { question_id: q1Id, selected_option_ids: [optAId] },
  ])
  assert.ok(resp2.id)

  // 5. 用户 A 再次提交答卷（不覆盖旧答卷，形成两份独立记录）
  const resp3 = await testStore.submitDecisionResponse('retention-test-1', '商雯祺', [
    { question_id: q1Id, other_text: '调整为三倍' },
  ], '补充修正')
  assert.ok(resp3.id)

  const updatedForm = await testStore.getDecisionFormBySlug('retention-test-1')
  assert.equal(updatedForm.responses.length, 3)

  // 6. 关闭表单后拒绝提交
  await testStore.closeDecisionForm('retention-test-1')
  const closedForm = await testStore.getDecisionFormBySlug('retention-test-1')
  assert.equal(closedForm.status, 'closed')

  await assert.rejects(
    async () => {
      await testStore.submitDecisionResponse('retention-test-1', '王五', [
        { question_id: q1Id, selected_option_ids: [optAId] },
      ])
    },
    /表单已关闭/,
  )

  // 7. 重新开放后可继续提交
  await testStore.openDecisionForm('retention-test-1')
  const resp4 = await testStore.submitDecisionResponse('retention-test-1', '王五', [
    { question_id: q1Id, selected_option_ids: [optAId] },
  ])
  assert.ok(resp4.id)

  const finalForm = await testStore.getDecisionFormBySlug('retention-test-1')
  assert.equal(finalForm.responses.length, 4)
})
