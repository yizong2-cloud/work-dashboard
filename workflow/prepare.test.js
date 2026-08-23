import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFeishuArgs, buildFeishuCandidates, buildSessionCandidates, buildSummaryArgs, hasMatchingHealthySnapshot, isSnapshotHealthy, normalizeMappingText, parseJsonArrayOutput, persistSnapshotFiles, resolveFeishuPaths, run, snapshotNotification, summarizeFeishuStep, unmappedCwdRequired } from './prepare.mjs'

test('source-map can explicitly exclude the Workboard maintenance repository', () => {
  const result = buildSessionCandidates([
    { cwd: '/Users/zongyi/Workspace/work-dashboard', lastTs: '2026-08-20T08:00:00Z' },
    { cwd: '/Users/zongyi/Workspace/Unified_API_Playground/packages/jigsawcard', lastTs: '2026-08-20T09:00:00Z' },
  ], {
    ignored_cwd: [{ pattern: '/work-dashboard', hint: 'tooling' }],
    codex_cwd: [],
  }, 'codex')

  assert.deepEqual(result.hits, [])
  assert.equal(result.ignored.length, 1)
  assert.equal(result.ignored[0].suggested_decision, 'irrelevant')
  assert.deepEqual(result.unmapped, ['/Users/zongyi/Workspace/Unified_API_Playground/packages/jigsawcard'])
  assert.equal(unmappedCwdRequired(result.unmapped), true)
})

test('ignored cwd matching remains case-insensitive and substring based', () => {
  const result = buildSessionCandidates([
    { cwd: '/tmp/WORK-DASHBOARD/.worktree', lastTs: '2026-08-20T08:00:00Z' },
  ], {
    ignored_cwd: [{ pattern: '/work-dashboard', hint: 'tooling' }],
    codex_cwd: [],
  }, 'dsh')

  assert.deepEqual(result.unmapped, [])
  assert.equal(result.ignored.length, 1)
})

test('unmapped project directories always require explicit review', () => {
  assert.equal(unmappedCwdRequired(['/Users/zongyi/StudioProjects/new-project']), true)
  assert.equal(unmappedCwdRequired([]), false)
})

test('confirmed JigsawCard reverse-engineering directory maps to the leaderboard research task', () => {
  const result = buildSessionCandidates([
    { cwd: '/Users/zongyi/Workspace/Unified_API_Playground/packages/jigsawcard', lastTs: '2026-08-20T08:00:00Z' },
  ], {
    ignored_cwd: [],
    codex_cwd: [{
      pattern: 'Unified_API_Playground/packages/jigsawcard',
      hint: 'JigsawCard 竞品触觉/震动反馈逆向',
      tasks: ['华容道排行榜功能（九月初预定）'],
      task_keywords: { '华容道排行榜功能（九月初预定）': ['震动反馈'] },
    }],
  }, 'dsh')
  assert.deepEqual(result.unmapped, [])
  assert.deepEqual(result.hits[0].tasks, ['华容道排行榜功能（九月初预定）'])
  assert.deepEqual(result.hits[0].task_keywords, { '华容道排行榜功能（九月初预定）': ['震动反馈'] })
})

test('Codex temporary sessions are excluded through source-map rules', () => {
  const result = buildSessionCandidates([
    { cwd: '/Users/zongyi/Documents/Codex/temporary-thread' },
  ], {
    ignored_cwd: [{ pattern: 'Documents/Codex', hint: 'temporary' }],
    codex_cwd: [],
  }, 'codex')

  assert.deepEqual(result.hits, [])
  assert.equal(result.ignored.length, 1)
  assert.deepEqual(result.unmapped, [])
})

test('Feishu paths can be overridden without changing the default layout', () => {
  assert.deepEqual(resolveFeishuPaths('/tmp/workboard-home', {}), {
    bin: '/tmp/workboard-home/Workspace/feishu-export-public/bin/feishu-export',
    cookies: '/tmp/workboard-home/Workspace/feishu_export/cookies.json',
    output: '/tmp/workboard-home/Workspace/feishu_export/daily',
  })
  assert.deepEqual(resolveFeishuPaths('/tmp/workboard-home', {
    WORKBOARD_FEISHU_BIN: '~/public/bin/feishu-export',
    WORKBOARD_FEISHU_COOKIES: '~/private/cookies.json',
    WORKBOARD_FEISHU_OUTPUT_DIR: '~/exports',
  }), {
    bin: '/tmp/workboard-home/public/bin/feishu-export',
    cookies: '/tmp/workboard-home/private/cookies.json',
    output: '/tmp/workboard-home/exports',
  })
})

test('canonical public exporter stays selected when only the legacy copy exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-feishu-'))
  const legacyBin = path.join(home, 'Workspace', 'feishu_export', 'bin')
  fs.mkdirSync(legacyBin, { recursive: true })
  fs.writeFileSync(path.join(legacyBin, 'feishu-export'), '#!/bin/sh\n')
  assert.equal(resolveFeishuPaths(home, {}).bin, path.join(home, 'Workspace', 'feishu-export-public', 'bin', 'feishu-export'))
  fs.rmSync(home, { recursive: true, force: true })
})

test('prepare passes overridden Cookie and output paths to any exporter', () => {
  assert.deepEqual(buildFeishuArgs('2026-08-19T10:00:00.000Z', '/tmp/private cookies.json', '/tmp/feishu out'), [
    '--since', '2026-08-19T00:00', '--refresh-chats', '--markdown', '--no-update-state',
    '--cookies', '/tmp/private cookies.json', '--out', '/tmp/feishu out',
  ])
})

test('successful Feishu recovery is a warning, not a source failure detail', () => {
  const summary = summarizeFeishuStep([
    '胡贺伟: 连续两次无法切换，重新加载飞书 Messenger 后再试',
    '完成：17 个会话、802 条消息 → /tmp/export.json',
    'Markdown 汇总 → /tmp/export.md',
  ].join('\n'))
  assert.equal(summary.detail, '完成：17 个会话、802 条消息 → /tmp/export.json | Markdown 汇总 → /tmp/export.md')
  assert.equal(summary.warning, '胡贺伟: 连续两次无法切换，重新加载飞书 Messenger 后再试')
})

test('Codex and DSH each use one full JSON scan bound to the analysis cursor', () => {
  assert.deepEqual(buildSummaryArgs('/tmp/workboard', 'codex-summary.js', 3, '2026-08-19T10:00:00.000Z'), [
    '/tmp/workboard/scripts/codex-summary.js', '--days', '3', '--json', '--since-time', '2026-08-19T10:00:00.000Z',
  ])
  assert.doesNotMatch(buildSummaryArgs('/tmp/workboard', 'dsh-summary.js', 3, null).join(' '), /--detail/)
})

test('successful child process output still fails health checks when it is not a JSON array', () => {
  assert.deepEqual(parseJsonArrayOutput('[{"cwd":"/repo"}]'), { ok: true, value: [{ cwd: '/repo' }], detail: null })
  assert.deepEqual(parseJsonArrayOutput('{"cwd":"/repo"}'), { ok: false, value: [], detail: '输出不是数组' })
  assert.deepEqual(parseJsonArrayOutput('not json'), { ok: false, value: [], detail: '输出解析失败' })
})

test('snapshot health requires parseable summaries, current board, and knowledge base', () => {
  const allHealthy = { feishuOk: true, codexOk: true, dshOk: true, boardOk: true, knowledgeBaseOk: true }
  assert.equal(isSnapshotHealthy(allHealthy), true)
  for (const key of Object.keys(allHealthy)) {
    assert.equal(isSnapshotHealthy({ ...allHealthy, [key]: false }), false, `${key} 失败必须让快照降级`)
  }
})

test('source-map task keywords only reference declared candidate tasks', () => {
  const sourceMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'source-map.json'), 'utf8'))
  for (const section of ['codex_cwd', 'feishu_chat']) {
    for (const rule of sourceMap[section] || []) {
      for (const [task, keywords] of Object.entries(rule.task_keywords || {})) {
        assert.ok((rule.tasks || []).includes(task), `${section}:${rule.pattern} 的关键词引用了未声明任务 ${task}`)
        assert.ok(Array.isArray(keywords) && keywords.every((item) => typeof item === 'string' && item.trim()), `${section}:${rule.pattern}:${task} 关键词必须是非空字符串数组`)
      }
    }
  }
})

test('migrated active project directories retain explicit candidate mappings or ignore rules', () => {
  const sourceMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'source-map.json'), 'utf8'))
  const result = buildSessionCandidates([
    { cwd: '/Users/zongyi/Workspace/jigsaw-android' },
    { cwd: '/Users/zongyi/Workspace/bi-cli' },
    { cwd: '/Users/zongyi/Workspace/classic-jigsaw-android' },
    { cwd: '/Users/zongyi/Workspace/classic-cms' },
    { cwd: '/Users/zongyi/Workspace/feishu_export' },
    { cwd: '/Users/zongyi/Documents/Codex/2026-08-22/temporary-thread' },
  ], sourceMap, 'codex')
  assert.deepEqual(result.unmapped, [])
  assert.equal(result.hits.length, 4)
  assert.equal(result.ignored.length, 2)
  assert.deepEqual(result.hits[0].tasks, [
    'Fantasy 成就系统收尾（接手杨柯迪）',
    'Fantasy Jigsaw 试玩（可玩广告）制作与多渠道适配',
    'Jigsaw H5 Demo（拼接反馈动效多方案验证）',
    'Fantasy 积分制与完成页激励文案开发',
  ])
  assert.deepEqual(result.hits[1].tasks, ['拼图矩阵 BI 数据问题修复与口径治理'])
})

test('source-map matches chat title whitespace and keeps explicit non-business chats auditable', () => {
  const sourceMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'source-map.json'), 'utf8'))
  assert.equal(normalizeMappingText('Fantasy　成就测试沟通群'), 'fantasy成就测试沟通群')
  const result = buildFeishuCandidates('## Fantasy 成就测试沟通群（3 条）\n内容\n\n## Jigslide（2 条）\n联调\n\n## 工作进度简报（1 条）\n回显', sourceMap)
  assert.deepEqual(result.unmappedGroups, [])
  assert.deepEqual(result.hits[0].tasks, ['Fantasy 成就系统收尾（接手杨柯迪）'])
  assert.deepEqual(result.hits[1].tasks, ['Jigslide（宁静华容道）CMS 与 API 联调支持'])
  assert.equal(result.hits[2].ignored, true)
  assert.equal(result.hits[2].suggested_decision, 'irrelevant')
})

test('degraded prepare preserves the previous healthy snapshot while replacing latest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-snapshots-'))
  const files = {
    context: path.join(dir, 'update-context.json'),
    packet: path.join(dir, 'review-packet.json'),
    lastHealthyContext: path.join(dir, 'last-healthy-context.json'),
    lastHealthyPacket: path.join(dir, 'last-healthy-review-packet.json'),
  }
  try {
    const healthy = { snapshot_id: 'healthy-1', snapshot_health: 'ok' }
    assert.equal(persistSnapshotFiles({ ctx: healthy, reviewPacket: healthy, files }).last_healthy_updated, true)
    const degraded = { snapshot_id: 'degraded-2', snapshot_health: 'degraded' }
    assert.equal(persistSnapshotFiles({ ctx: degraded, reviewPacket: degraded, files }).last_healthy_updated, false)
    assert.equal(JSON.parse(fs.readFileSync(files.context, 'utf8')).snapshot_id, 'degraded-2')
    assert.equal(JSON.parse(fs.readFileSync(files.packet, 'utf8')).snapshot_id, 'degraded-2')
    assert.equal(JSON.parse(fs.readFileSync(files.lastHealthyContext, 'utf8')).snapshot_id, 'healthy-1')
    assert.equal(JSON.parse(fs.readFileSync(files.lastHealthyPacket, 'utf8')).snapshot_id, 'healthy-1')
    assert.equal(hasMatchingHealthySnapshot(files.lastHealthyContext, files.lastHealthyPacket), true)
    fs.writeFileSync(files.lastHealthyPacket, JSON.stringify({ snapshot_id: 'mismatch', snapshot_health: 'ok' }))
    assert.equal(hasMatchingHealthySnapshot(files.lastHealthyContext, files.lastHealthyPacket), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('degraded prepare notification never claims the dashboard is ready', () => {
  const failed = snapshotNotification({ snapshotHealth: 'degraded', failedCount: 1, noScheduleCount: 13, lastHealthyAvailable: true })
  assert.equal(failed.title, '看板采集未完成')
  assert.match(failed.body, /最近健康快照已保留，仅供诊断/)
  assert.doesNotMatch(failed.body, /开始更新|已就绪/)
  const healthy = snapshotNotification({ snapshotHealth: 'ok', failedCount: 0, noScheduleCount: 13, lastHealthyAvailable: true })
  assert.equal(healthy.title, '看板数据已就绪')
  assert.match(healthy.body, /13 个活跃任务未排期/)
})

test('async command runner captures output and reports nonzero exits', async () => {
  const ok = await run(process.execPath, ['-e', 'process.stdout.write("ready")'], 5000)
  assert.equal(ok.ok, true)
  assert.equal(ok.stdout, 'ready')
  const failed = await run(process.execPath, ['-e', 'process.stderr.write("broken"); process.exit(3)'], 5000)
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 3)
  assert.equal(failed.stderr, 'broken')
})

test('async command runner terminates commands that exceed their budget', async () => {
  const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 50)
  assert.equal(result.ok, false)
  assert.equal(result.timed_out, true)
})
