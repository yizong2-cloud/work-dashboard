#!/usr/bin/env node
// Print exactly one raw evidence item from the current snapshot, or from the
// preserved last healthy snapshot for diagnosis only.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getEvidence } from './review-packet.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTEXT_FILE = path.join(ROOT, 'workflow', 'update-context.json')
const LAST_HEALTHY_CONTEXT_FILE = path.join(ROOT, 'workflow', 'last-healthy-context.json')
const LAST_HEALTHY_PACKET_FILE = path.join(ROOT, 'workflow', 'last-healthy-review-packet.json')
const id = process.argv[process.argv.indexOf('--id') + 1]
const useLastHealthy = process.argv.includes('--last-healthy')

if (!id || !process.argv.includes('--id')) {
  console.error('用法: node workflow/evidence.mjs --id <source_id> [--last-healthy]')
  process.exit(1)
}

let context
let lastHealthyPacket
try {
  context = JSON.parse(fs.readFileSync(useLastHealthy ? LAST_HEALTHY_CONTEXT_FILE : CONTEXT_FILE, 'utf8'))
  if (useLastHealthy) lastHealthyPacket = JSON.parse(fs.readFileSync(LAST_HEALTHY_PACKET_FILE, 'utf8'))
} catch (error) {
  console.error(`无法读取${useLastHealthy ? '最近健康' : '当前'}快照: ${error.message}`)
  process.exit(1)
}
if (useLastHealthy && (
  context.snapshot_health !== 'ok'
  || lastHealthyPacket?.snapshot_health !== 'ok'
  || !context.snapshot_id
  || context.snapshot_id !== lastHealthyPacket?.snapshot_id
)) {
  console.error('最近健康快照文件无效：上下文与审查包必须属于同一个健康快照')
  process.exit(1)
}
const evidence = getEvidence(context, id)
if (!evidence) {
  console.error(`找不到证据项: ${id}`)
  process.exit(1)
}
console.log(JSON.stringify({
  source_id: id,
  snapshot_scope: useLastHealthy ? 'last_healthy' : 'latest',
  snapshot_id: context.snapshot_id || null,
  reference_only: useLastHealthy,
  evidence,
}, null, 2))
