import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCoverage, buildReviewPacket, compactExcerpt, getEvidence, mergeSessionRows, summarizeReconciliation, validateReconciliation, validateReviewSpec } from './review-packet.mjs'
import { formatReviewBrief } from './review-brief.mjs'
import { redactSensitiveText } from './redaction.mjs'
import { feishuFailureDetail, feishuOutputIncomplete, feishuSnapshot } from './source-safety.mjs'

const context = {
  snapshot_id: 'snapshot-1',
  captured_at: '2026-08-19T10:00:00.000Z',
  snapshot_health: 'ok',
  candidates: {
    codex: [{ cwd: '/repo/a', tasks: ['task-a'], hint: 'A' }],
    dsh: [],
    feishu: [{ group: '项目群（2 条）', tasks: ['task-b'], hint: 'B' }],
  },
  codex_detail: [{ cwd: '/repo/a', lastTs: '2026-08-19T09:00:00Z', userReqs: ['完成联调，准备测试'] }],
  dsh_detail: [{ cwd: '/repo/b', userMsgs: ['请排查阻塞原因'] }],
  feishu: { content: '# 飞书聊天记录汇总\n\n## 项目群（2 条）\n\n- **甲** (09:00): 请今天完成测试\n\n## 闲聊（1 条）\n\n- **乙** (10:00): 收到' },
  sources: { local_files: [{ name: 'deliverable.md', path: '/tmp/deliverable.md', mtime: '2026-08-19T09:00:00Z', size: 12, ext: 'md' }] },
  board: [{ id: 'task-a-id', title: '任务 A', status: 'in_progress', progress: 50, expected_end_date: null, current_status: '进行中' }],
}

test('review packet inventories every source while keeping excerpts compact', () => {
  const packet = buildReviewPacket(context)
  assert.equal(packet.counts.total, 5)
  assert.deepEqual(packet.review_items.map((item) => item.source_id), ['codex:0', 'dsh:0', 'feishu:0', 'feishu:1', 'local:0'])
  assert.equal(packet.source_health.feishu.ok, true)
  assert.equal(packet.source_health.codex.count, 1)
  assert.equal(packet.source_health.feishu.count, 2)
  assert.equal(packet.coverage.complete, true)
  assert.equal(packet.review_items[0].candidate_tasks[0], 'task-a')
  assert.equal(packet.review_items[0].review_reason, 'single_candidate')
  assert.equal(packet.review_items[0].candidate_count, 1)
  assert.match(packet.review_contract.review_priority_semantics, /不是任务 priority/)
  assert.ok(packet.review_items.every((item) => item.excerpt.length <= 420))
})

test('review packet exposes failed board and knowledge-base dependencies in source health', () => {
  const packet = buildReviewPacket({
    ...context,
    snapshot_health: 'degraded',
    sources: {
      ...context.sources,
      board: { ok: false, count: 0 },
      knowledge_base: { ok: false },
    },
    steps: [
      { name: '当前看板', ok: false, detail: '看板输出解析失败' },
      { name: '知识库', ok: false, detail: '文件读取失败' },
    ],
  })
  assert.equal(packet.source_health.board.ok, false)
  assert.equal(packet.source_health.board.count, 0)
  assert.match(packet.source_health.board.detail, /看板输出解析失败/)
  assert.equal(packet.source_health.knowledge_base.ok, false)
  assert.match(packet.source_health.knowledge_base.detail, /文件读取失败/)
})

test('review packet preserves recovered collector diagnostics separately from health detail', () => {
  const packet = buildReviewPacket({
    ...context,
    steps: [{
      name: '飞书增量导出', ok: true,
      detail: '完成：2 个会话、3 条消息 → /tmp/export.json',
      warning: '项目群：重新加载飞书 Messenger 后再试',
    }],
  })
  assert.equal(packet.source_health.feishu.ok, true)
  assert.match(packet.source_health.feishu.detail, /完成：2 个会话/)
  assert.match(packet.source_health.feishu.warning, /重新加载飞书 Messenger/)
})

test('review attention explains ambiguity instead of pretending task urgency', () => {
  const packet = buildReviewPacket({
    ...context,
    candidates: { ...context.candidates, codex: [] },
  })
  const item = packet.review_items.find((row) => row.source_id === 'codex:0')
  assert.equal(item.review_priority, 'high')
  assert.equal(item.review_reason, 'no_candidate_mapping')
  assert.equal(packet.counts.review_attention, packet.counts.high_priority)
  assert.equal(
    packet.counts.by_review_reason.no_candidate_mapping,
    packet.review_items.filter((row) => row.review_reason === 'no_candidate_mapping').length,
  )
})

test('explicitly ignored source remains auditable but is not treated as an ambiguity', () => {
  const packet = buildReviewPacket({
    ...context,
    candidates: {
      ...context.candidates,
      feishu: [
        { group: '项目群（2 条）', tasks: ['task-b'], hint: 'B' },
        { group: '闲聊（1 条）', tasks: [], ignored: true, suggested_decision: 'irrelevant', hint: '看板回显' },
      ],
    },
  })
  const item = packet.review_items.find((row) => row.source_id === 'feishu:1')
  assert.equal(item.review_reason, 'intentionally_ignored')
  assert.equal(item.review_priority, 'normal')
  assert.equal(item.suggested_decision, 'irrelevant')
  assert.match(packet.review_contract.review_priority_semantics, /suggested_decision=irrelevant/)
})

test('审查简报保留每个 source_id，并按可快速结案、低歧义和真歧义分组', () => {
  const brief = formatReviewBrief({
    snapshot_id: 'snapshot-brief',
    board: [
      { id: 'task-a-id', title: '任务 A' },
      { id: 'task-b-id', title: '任务 B' },
    ],
    review_items: [
      { source_id: 'codex:0', label: '工具维护', review_reason: 'intentionally_ignored', review_priority: 'normal', suggested_decision: 'irrelevant', excerpt: '这是看板维护会话' },
      { source_id: 'feishu:1', label: '成就群', review_reason: 'single_candidate', review_priority: 'normal', candidate_tasks: ['任务 A'], excerpt: '请确认领奖逻辑' },
      { source_id: 'codex:2', label: '客户端', review_reason: 'multiple_candidate_tasks', review_priority: 'high', candidate_tasks: ['任务 A', '任务 B'], excerpt: '需要判断究竟在修哪个功能' },
    ],
  })
  assert.match(brief, /证据 3 条 · 需判断 1 条/)
  assert.match(brief, /明确无关（1 条/)
  assert.match(brief, /低歧义线索（1 条/)
  assert.match(brief, /需要判断（1 条/)
  for (const sourceId of ['codex:0', 'feishu:1', 'codex:2']) assert.ok(brief.includes(sourceId))
  assert.match(brief, /任务 A（task-a-id）/)
  assert.match(brief, /建议结论：irrelevant（显式规则，不是自动写入）/)
})

test('审查简报拒绝缺失或损坏的审查包', () => {
  assert.match(formatReviewBrief(null), /找不到有效 review-packet/)
  assert.match(formatReviewBrief({ review_items: null }), /找不到有效 review-packet/)
})

test('已完整对账的当前快照默认给出紧凑结案信息，但可显式展开审计摘录', () => {
  const packet = {
    snapshot_id: 'snapshot-settled',
    board: [],
    review_items: [
      { source_id: 'codex:0', review_priority: 'high', review_reason: 'no_candidate_mapping', label: '会话', excerpt: '已审查证据' },
      { source_id: 'feishu:0', review_priority: 'normal', review_reason: 'single_candidate', label: '群聊', excerpt: '已审查聊天' },
    ],
  }
  const changeset = {
    snapshot_id: 'snapshot-settled', all_ok: true, changeset_id: 'chg-settled',
    reconciliation: [
      { source_id: 'codex:0', decision: 'irrelevant' },
      { source_id: 'feishu:0', decision: 'mapped', task_id: 'task-a' },
    ],
  }
  const compact = formatReviewBrief(packet, { changeset })
  assert.match(compact, /当前快照已结案/)
  assert.match(compact, /已完成全量对账 2\/2/)
  assert.doesNotMatch(compact, /已审查证据/)
  const full = formatReviewBrief(packet, { changeset, forceFull: true })
  assert.match(full, /审查简报（只读审计；本快照已结案，不得重新写入或推送）/)
  assert.match(full, /codex:0/)
  assert.match(full, /已审查证据/)
})

test('审查简报不把缺 task_id 的 mapped 记录视作已经结案', () => {
  const packet = {
    snapshot_id: 'snapshot-bad-mapped', board: [],
    review_items: [{ source_id: 'codex:0', review_priority: 'high', label: '会话', excerpt: '待审查证据' }],
  }
  const brief = formatReviewBrief(packet, {
    changeset: {
      snapshot_id: 'snapshot-bad-mapped', all_ok: true,
      reconciliation: [{ source_id: 'codex:0', decision: 'mapped' }],
    },
  })
  assert.match(brief, /尚未写入看板或发送飞书/)
  assert.match(brief, /codex:0/)
})

test('multi-task candidates are keyword-ranked without lowering the ambiguity gate', () => {
  const packet = buildReviewPacket({
    ...context,
    codex: [{ cwd: '/repo/a', userReqs: ['成就弹窗和徽章需要联调'] }],
    codex_detail: [],
    candidates: {
      ...context.candidates,
      codex: [{
        cwd: '/repo/a',
        hint: 'Fantasy 客户端',
        tasks: ['Fantasy 试玩制作与多渠道适配', 'Fantasy 成就系统收尾'],
        task_keywords: {
          'Fantasy 试玩制作与多渠道适配': ['试玩', '可玩广告'],
          'Fantasy 成就系统收尾': ['成就', '徽章'],
        },
      }],
    },
  })
  const item = packet.review_items.find((row) => row.source_id === 'codex:0')
  assert.deepEqual(item.candidate_tasks, ['Fantasy 成就系统收尾', 'Fantasy 试玩制作与多渠道适配'])
  assert.equal(item.candidate_ranked_by, 'keyword_overlap')
  assert.equal(item.candidate_count, 2)
  assert.equal(item.review_reason, 'multiple_candidate_tasks')
  assert.equal(item.review_priority, 'high')
})

test('multi-task candidates keep source-map order when curated keywords are absent', () => {
  const packet = buildReviewPacket({
    ...context,
    codex: [{ cwd: '/repo/a', userReqs: ['成就弹窗需要联调'] }],
    codex_detail: [],
    candidates: {
      ...context.candidates,
      codex: [{ cwd: '/repo/a', tasks: ['试玩任务', '成就任务'], hint: '多线客户端' }],
    },
  })
  const item = packet.review_items.find((row) => row.source_id === 'codex:0')
  assert.deepEqual(item.candidate_tasks, ['试玩任务', '成就任务'])
  assert.equal(item.candidate_ranked_by, undefined)
  assert.equal(item.review_reason, 'multiple_candidate_tasks')
})

test('coverage reports a missing source row instead of silently passing', () => {
  const coverage = buildCoverage({
    codex: [{ file: '/repo/a' }],
    dsh: [],
    feishu: { content: '' },
    sources: { local_files: [] },
  }, [{ source: 'dsh', source_id: 'dsh:0' }])
  assert.equal(coverage.complete, false)
  assert.deepEqual(coverage.gaps.sort(), ['codex', 'dsh'])
})

test('review packet covers all summary sessions while enriching matching detail rows', () => {
  const packet = buildReviewPacket({
    ...context,
    codex: [
      { file: '/repo/a.jsonl', cwd: '/repo/a', lastTs: '2026-08-19T09:00:00Z', userReqs: ['摘要 A'] },
      { file: '/repo/b.jsonl', cwd: '/repo/b', lastTs: '2026-08-19T08:00:00Z', userReqs: ['摘要 B'] },
    ],
    codex_detail: [{ file: '/repo/a.jsonl', cwd: '/repo/a', lastTs: '2026-08-19T09:00:00Z', userReqs: ['完整 A：完成联调'] }],
  })
  const codexItems = packet.review_items.filter((item) => item.source === 'codex')
  assert.equal(codexItems.length, 2)
  assert.match(codexItems[0].excerpt, /完整 A/)
  assert.match(codexItems[1].excerpt, /摘要 B/)
  assert.equal(mergeSessionRows(
    [{ file: '/repo/a.jsonl' }, { file: '/repo/b.jsonl' }],
    [{ file: '/repo/a.jsonl', userReqs: ['完整 A'] }],
  ).length, 2)
  const evidence = getEvidence({
    ...context,
    codex: [{ file: '/repo/a.jsonl', cwd: '/repo/a', userReqs: ['Bearer abcdefghijklmnop'] }],
    codex_detail: [],
  }, 'codex:0')
  assert.equal(evidence.userReqs[0], 'Bearer [REDACTED]')
})

test('review packet exposes the failing source without opening raw snapshot', () => {
  const packet = buildReviewPacket({
    ...context,
    snapshot_health: 'degraded',
    sources: {
      ...context.sources,
      feishu: { ok: false, file: null },
      codex: { ok: true, count: 1 },
      dsh: { ok: true, count: 0 },
    },
    steps: [{ name: '飞书增量导出', ok: false, detail: '登录态可能已过期' }],
  })
  assert.equal(packet.source_health.feishu.ok, false)
  assert.equal(packet.source_health.feishu.detail, '登录态可能已过期')
  assert.equal(packet.source_health.codex.count, 1)
})

test('reconciliation rejects omissions, duplicates, unknown sources, and incomplete mappings', () => {
  const items = buildReviewPacket(context).review_items
  const complete = items.map((item) => ({ source_id: item.source_id, decision: item.source_id === 'codex:0' ? 'mapped' : 'irrelevant', ...(item.source_id === 'codex:0' ? { task_id: 'task-a-id' } : {}) }))
  assert.deepEqual(validateReconciliation(items, complete), [])
  assert.match(validateReconciliation(items, complete.slice(1)).join('\n'), /缺少对账结论: codex:0/)
  assert.match(validateReconciliation(items, [...complete, complete[0]]).join('\n'), /source_id 重复/)
  assert.match(validateReconciliation(items, [{ source_id: 'unknown:0', decision: 'irrelevant' }]).join('\n'), /不属于当前快照/)
  assert.match(validateReconciliation(items, items.map((item) => ({ source_id: item.source_id, decision: 'mapped' }))).join('\n'), /mapped 项缺 task_id/)
})

test('reconciliation summary keeps chat output compact without dropping full decisions', () => {
  const summary = summarizeReconciliation([
    { source_id: 'codex:0', decision: 'mapped', task_id: 'task-a-id' },
    { source_id: 'dsh:0', decision: 'irrelevant' },
    { source_id: 'feishu:0', decision: 'needs_confirmation' },
    { source_id: 'local:0', decision: 'unknown' },
  ])
  assert.deepEqual(summary, {
    total: 4,
    mapped: 1,
    irrelevant: 1,
    needs_confirmation: 1,
    invalid: 1,
    needs_confirmation_source_ids: ['feishu:0'],
  })
})

test('review spec binds reconciliation to one current snapshot', () => {
  const packet = buildReviewPacket(context)
  const spec = {
    snapshot_id: 'snapshot-1',
    reconciliation: packet.review_items.map((item) => ({ source_id: item.source_id, decision: 'irrelevant' })),
    ops: [],
  }
  assert.deepEqual(validateReviewSpec('snapshot-1', packet, spec), [])
  assert.match(validateReviewSpec('snapshot-2', packet, spec).join('\n'), /不属于同一次快照/)
  assert.match(validateReviewSpec('snapshot-1', packet, { ...spec, snapshot_id: 'old' }).join('\n'), /ops\.snapshot_id/)
})

test('evidence lookup exposes one item and redacts bearer credentials', () => {
  const withSecret = { ...context, dsh_detail: [{ cwd: '/repo/b', userMsgs: ['Bearer eyJabc.def.ghi'] }] }
  const evidence = getEvidence(withSecret, 'dsh:0')
  assert.equal(evidence.userMsgs[0], 'Bearer [REDACTED]')
  assert.equal(getEvidence(context, 'missing:0'), null)
})

test('derived snapshot redaction covers common bearer, JWT, and token forms', () => {
  const redacted = redactSensitiveText('Bearer abcdefghijklmnop\neyJabcdefghijkl.abcdefghijkl.abcdefghijkl\nsk-test_abcdefghijklmnop')
  assert.doesNotMatch(redacted, /Bearer abcdef/)
  assert.doesNotMatch(redacted, /eyJabcdefghijkl/)
  assert.doesNotMatch(redacted, /sk-test_abcdef/)
  assert.match(redacted, /\[REDACTED\]/)
})

test('failed or empty Feishu collection never reuses a previous export', () => {
  assert.deepEqual(feishuSnapshot({ ok: false, file: 'old-range.md', content: '旧聊天' }), {
    file: null,
    content: '（飞书采集失败；本次不使用旧导出内容）',
  })
  assert.deepEqual(feishuSnapshot({ ok: true, file: null, content: '' }), {
    file: null,
    content: '（本次无飞书增量）',
  })
  assert.deepEqual(feishuSnapshot({ ok: true, file: 'new-range.md', content: '新聊天' }), {
    file: 'new-range.md',
    content: '新聊天',
  })
})

test('Feishu collection failures explain recovery without exposing raw command noise', () => {
  assert.match(
    feishuFailureDetail({ stderr: 'cookies.json 不存在', code: 'MISSING_COOKIES' }, '/tmp/cookies.json'),
    /Cookies 文件不存在：\/tmp\/cookies\.json.*WORKBOARD_FEISHU_COOKIES/,
  )
  assert.match(
    feishuFailureDetail({ stderr: '未能进入飞书（登录态可能已过期，请重新导出浏览器 Cookies）' }, '/tmp/cookies.json'),
    /重新导出浏览器 Cookies.*\/tmp\/cookies\.json/,
  )
  assert.match(feishuFailureDetail({ code: 'ETIMEDOUT', timed_out: true }, '/tmp/cookies.json'), /导出超时/)
  assert.match(feishuFailureDetail({ stderr: 'network unavailable' }, '/tmp/cookies.json'), /network unavailable/)
  assert.match(
    feishuFailureDetail({ stderr: '飞书页面已完成加载，但会话列表没有出现；这通常是登录态未被浏览器接受' }, '/tmp/cookies.json'),
    /会话列表未出现.*--no-headless/,
  )
  assert.match(
    feishuFailureDetail({ stderr: '本次导出未完成：1 个会话读取失败；输出仅供诊断' }, '/tmp/cookies.json'),
    /不使用部分结果.*failedChats.*--chat-id/,
  )
  assert.match(
    feishuFailureDetail({ stderr: '连续 3 个会话无法打开（A:openfail, B:openfail, C:openfail）' }, '/tmp/cookies.json'),
    /会话切换连续失败.*failedChats\[\]\.id.*--chat-id/,
  )
})

test('partial Feishu chat failures are not accepted as a complete source', () => {
  assert.equal(feishuOutputIncomplete('  [1/1] AI技术讨论: 跳过(openfail)'), true)
  assert.equal(feishuOutputIncomplete('完成：2 个会话、18 条消息'), false)
  assert.match(
    feishuFailureDetail({ incomplete: true }, '/tmp/cookies.json'),
    /不使用部分结果.*Cookies/,
  )
})

test('compact excerpts remove image-only noise and retain actionable text', () => {
  const excerpt = compactExcerpt('[图片](https://example.test/a.png)\n请今天完成测试\n[表情:ok]')
  assert.equal(excerpt, '请今天完成测试')
})
