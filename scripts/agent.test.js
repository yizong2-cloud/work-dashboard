// ============================================================
// Agent CLI 最小测试集（node:test，无外部依赖）
// 运行: node --test scripts/agent.test.js
// 每个用例用独立临时本地数据文件，互不影响，绝不触碰线上库。
// ============================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'agent.js')

// 每个用例一个共享的隔离数据文件（create/get 等命令在同一用例内共享状态）
function makeRunner() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'))
  const dbFile = path.join(dir, 'local.json')
  // 强制本地模式：清空线上连接相关环境变量，防止测试触碰线上库
  const env = {
    ...process.env,
    LOCAL_DB_FILE: dbFile,
    VITE_SUPABASE_URL: '',
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
  }
  function run(...args) {
    try {
      const stdout = execFileSync('node', [AGENT, ...args], { env, encoding: 'utf8' })
      return { ok: true, stdout, dbFile }
    } catch (e) {
      return {
        ok: false,
        stdout: String(e.stdout || ''),
        stderr: String(e.stderr || e.message || ''),
        dbFile,
      }
    }
  }
  return run
}

function extractId(stdout) {
  const m = stdout.match(/id=([0-9a-f-]{36})/)
  assert.ok(m, `输出中应有任务 id: ${stdout.slice(0, 200)}`)
  return m[1]
}

test('create 创建任务并写入初始时间线', () => {
  const run = makeRunner()
  const r = run('create', '--title', '测试任务A', '--end', '2026-08-30')
  assert.ok(r.ok, r.stderr)
  const id = extractId(r.stdout)
  const g = run('get', id)
  assert.ok(g.ok)
  assert.match(g.stdout, /任务创建/)
})

test('progress 原子更新：进度变更 + 时间线各一条', () => {
  const run = makeRunner()
  const c = run('create', '--title', '测试任务B')
  const id = extractId(c.stdout)
  const p = run('progress', id, '--to', '70', '--note', '完成一半')
  assert.ok(p.ok, p.stderr)
  const g = run('get', id)
  assert.match(g.stdout, /70%/)
  assert.match(g.stdout, /完成一半/)
  // 时间线应有：任务创建 + 进度更新 两条
  const timelineCount = (g.stdout.match(/\[progress\]/g) || []).length
  assert.equal(timelineCount, 1)
})

test('block 不带原因必须报错', () => {
  const run = makeRunner()
  const c = run('create', '--title', '测试任务C')
  const id = extractId(c.stdout)
  const b = run('block', id)
  assert.ok(!b.ok, 'block 无原因应失败')
  assert.match(b.stderr, /阻塞原因/)
})

test('complete 满足不变量：progress=100 且 actual_end_date=本地今天', () => {
  const run = makeRunner()
  const c = run('create', '--title', '测试任务D')
  const id = extractId(c.stdout)
  const r = run('complete', id, '--note', '干完了')
  assert.ok(r.ok, r.stderr)
  assert.match(r.stdout, /已完成/)
  const g = run('get', id)
  assert.match(g.stdout, /100%/)
  // 本地今天的 YYYY-MM-DD
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  assert.match(g.stdout, new RegExp(`实际完成:${today}`))
})

test('update 禁止修改状态类字段', () => {
  const run = makeRunner()
  const c = run('create', '--title', '测试任务E')
  const id = extractId(c.stdout)
  const u = run('update', id, '--status', 'in_progress')
  assert.ok(!u.ok, 'update 改状态应被拒绝')
  assert.match(u.stderr, /不允许修改状态类字段/)
})

test('update 可改非状态字段（描述/现状）', () => {
  const run = makeRunner()
  const c = run('create', '--title', '测试任务F')
  const id = extractId(c.stdout)
  const u = run('update', id, '--current_status', '新现状说明', '--note', '补充说明')
  assert.ok(u.ok, u.stderr)
  const g = run('get', id)
  assert.match(g.stdout, /新现状说明/)
  assert.match(g.stdout, /补充说明/)
})

test('note 默认进展应即时推送，普通备注保持静默', () => {
  const run = makeRunner()
  const c = run('create', '--title', '通知策略任务')
  const id = extractId(c.stdout)

  const progress = run('note', id, '--content', '完成接口联调')
  assert.ok(progress.ok, progress.stderr)
  const dbAfterProgress = JSON.parse(fs.readFileSync(progress.dbFile, 'utf8'))
  assert.equal(dbAfterProgress.updates.at(-1).type, 'progress')
  assert.equal(dbAfterProgress.updates.at(-1).notify_mode, 'immediate')

  const note = run('note', id, '--type', 'note', '--content', '补充一个背景说明')
  assert.ok(note.ok, note.stderr)
  const dbAfterNote = JSON.parse(fs.readFileSync(note.dbFile, 'utf8'))
  assert.equal(dbAfterNote.updates.at(-1).type, 'note')
  assert.equal(dbAfterNote.updates.at(-1).notify_mode, 'silent')
})

test('update current_status 视为进展即时推送，纯描述修改保持静默', () => {
  const run = makeRunner()
  const c = run('create', '--title', '现状通知任务')
  const id = extractId(c.stdout)

  const status = run('update', id, '--current_status', '已完成接口联调')
  assert.ok(status.ok, status.stderr)
  const dbAfterStatus = JSON.parse(fs.readFileSync(status.dbFile, 'utf8'))
  assert.equal(dbAfterStatus.updates.at(-1).notify_mode, 'immediate')

  const description = run('update', id, '--description', '补充任务背景')
  assert.ok(description.ok, description.stderr)
  const dbAfterDescription = JSON.parse(fs.readFileSync(description.dbFile, 'utf8'))
  assert.equal(dbAfterDescription.updates.at(-1).notify_mode, 'silent')
})

test('历史补记永不推送，即使显式要求通知', () => {
  const run = makeRunner()
  const c = run('create', '--title', '历史补记任务')
  const id = extractId(c.stdout)
  const r = run('note', id, '--type', 'progress', '--content', '补记昨天进展', '--at', '2026-08-17', '--notify')
  assert.ok(r.ok, r.stderr)
  const db = JSON.parse(fs.readFileSync(r.dbFile, 'utf8'))
  assert.equal(db.updates.at(-1).notify_mode, 'silent')
})

test('list --interrupt 裸参数可过滤临时任务', () => {
  const run = makeRunner()
  run('create', '--title', '普通任务')
  run('create', '--title', '临时任务X', '--interrupt')
  const r = run('list', '--interrupt')
  assert.ok(r.ok)
  assert.match(r.stdout, /临时任务X/)
  assert.doesNotMatch(r.stdout, /普通任务/)
})

test('note 到不存在的任务被拒绝（防孤儿时间线）', () => {
  const run = makeRunner()
  const r = run('note', '--id', '00000000-0000-0000-0000-000000000000', '--content', '孤儿记录')
  assert.ok(!r.ok, '孤儿时间线应被拒绝')
})

test('schedule 记录 old/new 日期', () => {
  const run = makeRunner()
  const c = run('create', '--title', '测试任务G', '--end', '2026-08-20')
  const id = extractId(c.stdout)
  const s = run('schedule', id, '--end', '2026-08-25', '--note', '排期顺延')
  assert.ok(s.ok, s.stderr)
  const g = run('get', id)
  assert.match(g.stdout, /排期:2026-08-20 → 2026-08-25/)
  assert.match(g.stdout, /预计完成:2026-08-25/)
})

test('update 普通字段变更自动生成时间线（无需 --note）', () => {
  const run = makeRunner()
  const c = run('create', '--title', '测试任务H')
  const id = extractId(c.stdout)
  const u = run('update', id, '--current_status', '自动记时间线验证')
  assert.ok(u.ok, u.stderr)
  const g = run('get', id)
  assert.match(g.stdout, /自动记时间线验证/)
  assert.match(g.stdout, /更新字段：current_status/)
})

test('status 禁止直接切换到 blocked/completed', () => {
  const run = makeRunner()
  const c = run('create', '--title', '测试任务I')
  const id = extractId(c.stdout)
  const b = run('status', id, '--to', 'blocked')
  assert.ok(!b.ok, 'status 到 blocked 应被拒绝')
  assert.match(b.stderr, /block 命令/)
  const co = run('status', id, '--to', 'completed')
  assert.ok(!co.ok, 'status 到 completed 应被拒绝')
  assert.match(co.stderr, /complete 命令/)
})

test('非法日期被拒绝（2026-99-99）', () => {
  const run = makeRunner()
  const r = run('create', '--title', '非法日期任务', '--end', '2026-99-99')
  assert.ok(!r.ok, '非法日期应失败')
  assert.match(r.stderr, /非法/)
})

test('plan-add/move/done/list：计划块全链路（含历史与非法日期）', () => {
  const run = makeRunner()
  const c = run('create', '--title', '计划任务X', '--end', '2026-08-25')
  const tid = extractId(c.stdout)
  const a = run('plan-add', tid, '--from', '2026-08-17', '--to', '2026-08-18', '--summary', '接口联调')
  assert.ok(a.ok, a.stderr)
  const pid = extractId(a.stdout)
  const m = run('plan-move', pid, '--from', '2026-08-18', '--to', '2026-08-19', '--note', '临时需求插入')
  assert.ok(m.ok, m.stderr)
  const d = run('plan-done', pid, '--note', '完成')
  assert.ok(d.ok, d.stderr)
  const l = run('plan-list')
  assert.match(l.stdout, /2026-08-18 ~ 2026-08-19 \[done\]/)
  // 非法日期（结束早于开始）被拒
  const bad = run('plan-add', tid, '--from', '2026-08-20', '--to', '2026-08-19')
  assert.ok(!bad.ok, '结束早于开始应失败')
  assert.match(bad.stderr, /结束日期不得早于开始日期/)
  // 非真实日期被拒
  const bad2 = run('plan-add', tid, '--from', '2026-99-99', '--to', '2026-08-25')
  assert.ok(!bad2.ok, '非法日期应失败')
})

test('plan-move 不填原因必须报错', () => {
  const run = makeRunner()
  const c = run('create', '--title', '计划任务Y', '--end', '2026-08-25')
  const tid = extractId(c.stdout)
  const a = run('plan-add', tid, '--from', '2026-08-17', '--to', '2026-08-18')
  assert.ok(a.ok, a.stderr)
  const pid = extractId(a.stdout)
  const m = run('plan-move', pid, '--from', '2026-08-19')
  assert.ok(!m.ok, '不填原因应失败')
  assert.match(m.stderr, /原因/)
})

test('nudge 命令：催进度写入 nudge 时间线', () => {
  const run = makeRunner()
  const c = run('create', '--title', '催办任务X')
  const id = extractId(c.stdout)
  const n = run('nudge', id, '--note', '这个周五前能完成吗？')
  assert.ok(n.ok, n.stderr)
  assert.match(n.stdout, /已催进度/)
  const g = run('get', id)
  assert.match(g.stdout, /这个周五前能完成吗/)
  assert.match(g.stdout, /\[nudge\]/)
})

test('update --priority urgent：加急合法，非法优先级被拒', () => {
  const run = makeRunner()
  const c = run('create', '--title', '加急任务X')
  const id = extractId(c.stdout)
  const u = run('update', id, '--priority', 'urgent', '--note', 'Leader 要求加急')
  assert.ok(u.ok, u.stderr)
  const g = run('get', id)
  assert.match(g.stdout, /加急/)
  assert.match(g.stdout, /urgent/)
  // 加急走 [urgent] 时间线（与飞书红色卡片一致），非普通 note
  assert.match(g.stdout, /\[urgent\]/)
  const bad = run('update', id, '--priority', 'super')
  assert.ok(!bad.ok, '非法优先级应失败')
  assert.match(bad.stderr, /非法优先级/)
})

test('update 取消加急：urgent → high 走 [deurgent] 时间线', () => {
  const run = makeRunner()
  const c = run('create', '--title', '取消加急任务X')
  const id = extractId(c.stdout)
  run('update', id, '--priority', 'urgent')
  const d = run('update', id, '--priority', 'high', '--note', '已处理完')
  assert.ok(d.ok, d.stderr)
  const g = run('get', id)
  assert.match(g.stdout, /\[deurgent\]/)
  assert.match(g.stdout, /已处理完/)
  assert.match(g.stdout, /\(planned high/)
})

test('nudge 已完成任务被拒绝', () => {
  const run = makeRunner()
  const c = run('create', '--title', '已完成任务X')
  const id = extractId(c.stdout)
  run('complete', id)
  const n = run('nudge', id, '--note', '还在吗')
  assert.ok(!n.ok, '已完成任务不应被催进度')
  assert.match(n.stderr, /无需催进度/)
})
