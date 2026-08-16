#!/usr/bin/env node
// ============================================================
// workflow/apply.mjs —— 一条龙更新流程的「应用」阶段
// 读取变更建议 ops.json，校验后通过 agent.js batch 执行。
//
// 用法:
//   node workflow/apply.mjs [--file ops.json] [--dry-run]
// 校验基于 operation.schema.json（op 类型白名单 + 必填字段）。
// ============================================================

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AGENT = path.join(ROOT, 'scripts', 'agent.js')

// 与 operation.schema.json 保持一致的校验规则
const OP_RULES = {
  create: ['title'],
  progress: ['id', 'to'],
  status: ['id', 'to'],
  update: ['id'],
  schedule: ['id', 'end'],
  block: ['id', 'reason'],
  unblock: ['id'],
  complete: ['id'],
  note: ['id', 'content'],
  delete: ['id'],
}

function parseArgs(argv) {
  const args = { file: path.join(ROOT, 'workflow', 'ops.json'), dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i]
    else if (argv[i] === '--dry-run') args.dryRun = true
  }
  return args
}

function validate(ops) {
  const errors = []
  for (const [i, op] of ops.entries()) {
    const rules = OP_RULES[op.op]
    if (!rules) {
      errors.push(`第 ${i + 1} 条: 未知操作 "${op.op}"（允许: ${Object.keys(OP_RULES).join('/')}）`)
      continue
    }
    for (const key of rules) {
      if (op[key] === undefined || op[key] === null || op[key] === '') {
        errors.push(`第 ${i + 1} 条 ${op.op}: 缺少必填字段 "${key}"`)
      }
    }
  }
  return errors
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  let raw
  try {
    raw = fs.readFileSync(args.file, 'utf8')
  } catch {
    console.error(`❌ 找不到变更建议文件: ${args.file}`)
    process.exit(1)
  }
  let spec
  try {
    spec = JSON.parse(raw)
  } catch (e) {
    console.error(`❌ 变更建议文件不是合法 JSON: ${e.message}`)
    process.exit(1)
  }
  const ops = Array.isArray(spec) ? spec : spec.ops
  if (!Array.isArray(ops) || ops.length === 0) {
    console.error('❌ 变更建议为空（应为数组或 { ops: [...] }）')
    process.exit(1)
  }

  const errors = validate(ops)
  if (errors.length > 0) {
    console.error('❌ 变更建议校验失败:')
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }

  console.log(`共 ${ops.length} 条变更，开始${args.dryRun ? '预演' : '执行'}…`)
  for (const [i, op] of ops.entries()) {
    const brief = Object.entries(op)
      .filter(([k]) => k !== 'op')
      .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
      .join(' ')
    console.log(`  ${i + 1}. ${op.op} ${brief}`)
  }

  if (args.dryRun) {
    console.log('✅ 预演完成（未写入）。去掉 --dry-run 执行。')
    return
  }

  // 用 agent.js batch 执行（batch 自带逐条失败隔离与报告）
  try {
    const stdout = execFileSync('node', [AGENT, 'batch', '--file', args.file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    console.log(stdout)
  } catch (e) {
    console.error(String(e.stdout || ''))
    console.error(`❌ 应用失败: ${String(e.stderr || e.message || '').slice(0, 500)}`)
    process.exit(1)
  }
}

main()
