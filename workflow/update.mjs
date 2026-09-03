#!/usr/bin/env node
// Deep workflow seam for the frequent dashboard-update path. Callers choose a
// lifecycle action; the implementation owns command ordering and stops at the
// first failed safety gate.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isExplicitApproval } from './publish.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function updateCommandPlan(command, phrase = null) {
  const script = (name, ...args) => [path.join(ROOT, 'workflow', name), ...args]
  if (command === 'start') {
    return [
      script('status.mjs', '--guard-prepare', '--quiet'),
      script('prepare.mjs'),
      script('status.mjs', '--strict-review'),
      script('review-brief.mjs'),
    ]
  }
  if (command === 'preview') {
    return [script('apply.mjs', '--dry-run', '--quiet'), script('publish.mjs', 'preview')]
  }
  if (command === 'confirm') {
    if (!isExplicitApproval(phrase)) throw new Error('confirm 必须提供用户对当前完整预览的明确同意原话')
    return [
      script('publish.mjs', 'confirm', '--phrase', phrase),
      script('apply.mjs'),
      script('verify.mjs'),
      script('notification-status.mjs'),
    ]
  }
  if (command === 'retry') {
    return [script('apply.mjs'), script('verify.mjs'), script('notification-status.mjs')]
  }
  if (command === 'status') return [script('status.mjs')]
  throw new Error('用法: dashboard:update -- start|preview|status|retry|confirm --phrase "<用户明确同意原话>"')
}

function parseArgs(argv) {
  const command = argv.find((arg) => !arg.startsWith('--')) || 'status'
  const phraseIndex = argv.indexOf('--phrase')
  return { command, phrase: phraseIndex >= 0 ? argv[phraseIndex + 1] : null }
}

export function runUpdate(command, phrase = null, runner = spawnSync) {
  const plan = updateCommandPlan(command, phrase)
  for (const [file, ...args] of plan) {
    const result = runner(process.execPath, [file, ...args], { cwd: ROOT, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) return result.status ?? 1
  }
  return 0
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { command, phrase } = parseArgs(argv)
    process.exitCode = runUpdate(command, phrase)
  } catch (error) {
    console.error(`❌ ${error.message}`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
