import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const script = path.resolve(import.meta.dirname, 'dsh-summary.js')

test('DSH summary filters file mtime before decompressing', () => {
  const result = spawnSync(process.execPath, [script, '--since-time', '2099-01-01T00:00:00.000Z', '--json'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout), [])
  assert.match(result.stderr, /扫描 0 个文件/)
})
