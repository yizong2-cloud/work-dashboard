import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('自动化 apply 拒绝 delete 操作，删除不进入普通更新通道', () => {
  const file = path.join(os.tmpdir(), `workboard-delete-${Date.now()}.json`)
  const context = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'update-context.json'), 'utf8'))
  const packet = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflow', 'review-packet.json'), 'utf8'))
  const reconciliation = packet.review_items.map((item) => ({ source_id: item.source_id, decision: 'irrelevant' }))
  fs.writeFileSync(file, JSON.stringify({ snapshot_id: context.snapshot_id, reconciliation, ops: [{ op: 'delete', id: 'task-1' }] }))
  try {
    assert.throws(
      () => execFileSync('node', ['workflow/apply.mjs', '--file', file, '--force'], { encoding: 'utf8', stdio: 'pipe' }),
      (error) => `${error.stdout || ''}${error.stderr || ''}`.includes('未知操作 "delete"'),
    )
  } finally {
    fs.rmSync(file, { force: true })
  }
})
