#!/usr/bin/env node
// Print exactly one raw evidence item from the current snapshot.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getEvidence } from './review-packet.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTEXT_FILE = path.join(ROOT, 'workflow', 'update-context.json')
const id = process.argv[process.argv.indexOf('--id') + 1]

if (!id || !process.argv.includes('--id')) {
  console.error('用法: node workflow/evidence.mjs --id <source_id>')
  process.exit(1)
}

let context
try {
  context = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'))
} catch (error) {
  console.error(`无法读取更新快照: ${error.message}`)
  process.exit(1)
}
const evidence = getEvidence(context, id)
if (!evidence) {
  console.error(`找不到证据项: ${id}`)
  process.exit(1)
}
console.log(JSON.stringify({ source_id: id, evidence }, null, 2))
