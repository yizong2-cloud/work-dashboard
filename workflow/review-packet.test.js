import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReviewPacket, compactExcerpt, getEvidence, summarizeReconciliation, validateReconciliation, validateReviewSpec } from './review-packet.mjs'
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
  assert.equal(packet.source_health.codex.count, null)
  assert.equal(packet.review_items[0].candidate_tasks[0], 'task-a')
  assert.ok(packet.review_items.every((item) => item.excerpt.length <= 420))
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
    feishuFailureDetail({ stderr: '未能进入飞书（登录态可能已过期，请重新导出浏览器 Cookies）' }, '/tmp/cookies.json'),
    /重新导出浏览器 Cookies.*\/tmp\/cookies\.json/,
  )
  assert.match(feishuFailureDetail({ code: 'ETIMEDOUT', timed_out: true }, '/tmp/cookies.json'), /导出超时/)
  assert.match(feishuFailureDetail({ stderr: 'network unavailable' }, '/tmp/cookies.json'), /network unavailable/)
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
