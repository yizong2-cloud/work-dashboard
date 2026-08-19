import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const script = path.resolve(import.meta.dirname, 'dsh-summary.js')

test('DSH summary filters file mtime before decompressing', () => {
  const result = spawnSync(process.execPath, [script, '--since-time', '2099-01-01T00:00:00.000Z', '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout), [])
  assert.match(result.stderr, /扫描 0 个文件/)
})

test('DSH summary strips system skill blocks appended to user messages', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workboard-dsh-'))
  const sessionDir = path.join(home, '.dsh', 'sessions', 'group', 'session')
  fs.mkdirSync(sessionDir, { recursive: true })
  const fixture = [
    { type: 'session', createdAt: Date.now(), cwd: '/tmp/project', id: 'fixture-session' },
    { type: 'user/message', createdAt: Date.now() + 1, data: { content: [{ type: 'text', text: '请整理震动反馈\n<system-reminder>\n- `ad-model-bundle-converter`\n- `apk-reverse-engineering`\n</system-reminder>' }] } },
    { type: 'user/message', createdAt: Date.now() + 2, data: { content: [{ type: 'text', text: '<system-reminder>只有系统说明</system-reminder>' }] } },
    { type: 'user/message', createdAt: Date.now() + 3, data: { content: [{ type: 'text', text: '继续' }] } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n'
  const raw = path.join(home, 'fixture.jsonl')
  const compressed = path.join(sessionDir, 'session.jsonl.zstd')
  fs.writeFileSync(raw, fixture)
  const zipped = spawnSync('zstd', ['-q', '-f', raw, '-o', compressed], { encoding: 'utf8' })
  assert.equal(zipped.status, 0, zipped.stderr)
  const result = spawnSync(process.execPath, [script, '--days', '1', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
  try {
    assert.equal(result.status, 0, result.stderr)
    const sessions = JSON.parse(result.stdout)
    assert.equal(sessions.length, 1)
    assert.deepEqual(sessions[0].userMsgs, ['请整理震动反馈', '继续'])
    assert.doesNotMatch(result.stdout, /ad-model-bundle-converter/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
