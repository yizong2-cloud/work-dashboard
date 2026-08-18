#!/usr/bin/env node
// ============================================================
// 决策中心（Decision Hub）CLI —— 供 Agent 自动化流转与人工操作
//
// 命令列表（见 docs/DECISION_CENTER_PRD.md）：
//   npm run decision:validate -- --file decision.json
//   npm run decision:create -- --file decision.json
//   npm run decision:export -- --slug <slug> [--format markdown|json] [--respondent <name>]
//   npm run decision:close -- --slug <slug>
//   npm run decision:open -- --slug <slug>
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { loadEnv } from './lib/env.js'
import { parseArgs } from './lib/args.js'
import { createStore } from './lib/store.js'
import { validateDecisionPayload } from '../src/lib/decisionRules.ts'
import { formatDecisionMarkdown, formatDecisionJson } from '../src/lib/decisionFormat.ts'

const env = loadEnv()
const store = createStore(env)

const args = parseArgs(process.argv.slice(2))
const [command] = args._
const jsonOut = !!args['json']

const BASE_URL = process.env.VITE_SITE_URL || 'https://yizong2-cloud.github.io/work-dashboard'

function fail(msg) {
  if (jsonOut) {
    console.error(JSON.stringify({ error: msg }))
  } else {
    console.error(`❌ ${msg}`)
  }
  process.exit(1)
}

function getShareUrl(slug) {
  return `${BASE_URL.replace(/\/$/, '')}/#/decisions/${slug}`
}

function loadPayloadFromFile(filePath) {
  if (!filePath || filePath === true) {
    fail('缺少参数 --file（JSON 文件路径）')
  }
  const resolved = path.resolve(process.cwd(), String(filePath))
  if (!fs.existsSync(resolved)) {
    fail(`文件不存在: ${resolved}`)
  }
  try {
    const content = fs.readFileSync(resolved, 'utf8')
    return JSON.parse(content)
  } catch (err) {
    fail(`无法解析 JSON 文件: ${err.message}`)
  }
}

async function handleValidate() {
  const payload = loadPayloadFromFile(args.file)
  const result = validateDecisionPayload(payload)
  if (!result.valid) {
    if (jsonOut) {
      console.log(JSON.stringify({ valid: false, errors: result.errors }, null, 2))
    } else {
      console.error('❌ 表单 Payload 校验失败：')
      for (const err of result.errors) {
        console.error(`  - ${err}`)
      }
    }
    process.exit(1)
  }

  if (jsonOut) {
    console.log(JSON.stringify({ valid: true, question_count: payload.questions.length }, null, 2))
  } else {
    console.log(`✔ 校验通过：表单 "${payload.title}"（slug: ${payload.slug}），共 ${payload.questions.length} 道题`)
  }
}

async function handleCreate() {
  const payload = loadPayloadFromFile(args.file)
  const result = validateDecisionPayload(payload)
  if (!result.valid) {
    console.error('❌ 表单 Payload 校验失败：')
    for (const err of result.errors) {
      console.error(`  - ${err}`)
    }
    process.exit(1)
  }

  try {
    const created = await store.createDecisionForm(payload)
    const shareUrl = getShareUrl(created.slug)

    if (jsonOut) {
      console.log(JSON.stringify({ id: created.id, slug: created.slug, url: shareUrl }))
    } else {
      // PRD 契约：成功后 stdout 只输出分享 URL 与 form id
      console.log(shareUrl)
      console.log(created.id)
    }
  } catch (err) {
    fail(`创建表单失败: ${err.message}`)
  }
}

async function handleExport() {
  const slug = args.slug
  if (!slug || slug === true) {
    fail('缺少参数 --slug')
  }

  const form = await store.getDecisionFormBySlug(String(slug))
  if (!form) {
    fail(`未找到决策表单: ${slug}`)
  }

  const format = (args.format || 'markdown').toLowerCase()
  const respondentName = typeof args.respondent === 'string' ? args.respondent : undefined

  let output = ''
  if (format === 'json') {
    output = formatDecisionJson(form, { respondentName })
  } else {
    output = formatDecisionMarkdown(form, { respondentName })
  }

  if (args.file && typeof args.file === 'string') {
    const outFile = path.resolve(process.cwd(), args.file)
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, output, 'utf8')
    console.error(`✔ 已导出到文件: ${outFile}`)
  }

  console.log(output)
}

async function handleClose() {
  const slug = args.slug
  if (!slug || slug === true) {
    fail('缺少参数 --slug')
  }

  try {
    await store.closeDecisionForm(String(slug))
    if (jsonOut) {
      console.log(JSON.stringify({ success: true, slug, status: 'closed' }))
    } else {
      console.log(`✔ 决策表单已关闭: ${slug}`)
    }
  } catch (err) {
    fail(`关闭表单失败: ${err.message}`)
  }
}

async function handleOpen() {
  const slug = args.slug
  if (!slug || slug === true) {
    fail('缺少参数 --slug')
  }

  try {
    await store.openDecisionForm(String(slug))
    if (jsonOut) {
      console.log(JSON.stringify({ success: true, slug, status: 'open' }))
    } else {
      console.log(`✔ 决策表单已开放: ${slug}`)
    }
  } catch (err) {
    fail(`开放表单失败: ${err.message}`)
  }
}

async function handleList() {
  const forms = await store.listDecisionForms()
  if (jsonOut) {
    console.log(JSON.stringify(forms, null, 2))
    return
  }

  if (forms.length === 0) {
    console.log('暂无决策表单。')
    return
  }

  console.log(`共 ${forms.length} 个决策表单：\n`)
  for (const f of forms) {
    const statusTag = f.status === 'open' ? '收集中' : f.status === 'closed' ? '已关闭' : '草稿'
    console.log(`- [${statusTag}] ${f.title} (${f.slug})`)
    console.log(`  题目: ${f.question_count ?? 0} 道 | 答卷: ${f.response_count ?? 0} 份 | 链接: ${getShareUrl(f.slug)}`)
  }
}

async function main() {
  switch (command) {
    case 'validate':
      await handleValidate()
      break
    case 'create':
      await handleCreate()
      break
    case 'export':
      await handleExport()
      break
    case 'close':
      await handleClose()
      break
    case 'open':
      await handleOpen()
      break
    case 'list':
      await handleList()
      break
    default:
      console.log(`
决策中心 CLI 用法：
  npm run decision:validate -- --file <decision.json>
  npm run decision:create -- --file <decision.json>
  npm run decision:export -- --slug <slug> [--format markdown|json] [--respondent <name>]
  npm run decision:close -- --slug <slug>
  npm run decision:open -- --slug <slug>
  npm run decision:list
`)
      break
  }
}

main().catch((err) => {
  fail(err.message || String(err))
})
