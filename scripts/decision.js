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
//   npm run decision:clarify -- --slug <slug> --question <code> --content <text>
//   npm run decision:enrich -- --slug <slug> --file <decision.json> --source-file <original.md>
//   npm run decision:publish -- --file <decision.json> --source-file <original.md> --json
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { loadEnv } from './lib/env.js'
import { parseArgs } from './lib/args.js'
import { createStore } from './lib/store.js'
import { getDecisionQualityWarnings, validateDecisionPayload } from '../src/lib/decisionRules.ts'
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

function loadTextFromFile(filePath, label) {
  if (!filePath || filePath === true) {
    fail(`缺少参数 --${label}`)
  }
  const resolved = path.resolve(process.cwd(), String(filePath))
  if (!fs.existsSync(resolved)) {
    fail(`文件不存在: ${resolved}`)
  }
  return fs.readFileSync(resolved, 'utf8')
}

const normalizedText = (value) => String(value ?? '').trim()

function reportQualityWarnings(payload) {
  const warnings = getDecisionQualityWarnings(payload)
  for (const warning of warnings) {
    // stderr 保持 publish --json 的 stdout 契约稳定，且质量提示不应阻断发布。
    console.error(`⚠️ 质量提示：${warning}`)
  }
  return warnings
}

function sameDecisionDefinition(existing, payload) {
  if (normalizedText(existing.title) !== normalizedText(payload.title)) return false
  if (normalizedText(existing.summary) !== normalizedText(payload.summary)) return false
  if (existing.questions.length !== payload.questions.length) return false

  return payload.questions.every((candidate, index) => {
    const stored = existing.questions[index]
    if (!stored) return false
    const sameFields = [
      ['code', stored.code, candidate.code],
      ['title', stored.title, candidate.title],
      ['context', stored.context, candidate.context],
      ['group_name', stored.group_name, candidate.group_name || '待确认事项'],
      ['source_excerpt', stored.source_excerpt, candidate.source_excerpt],
      ['conversion_note', stored.conversion_note, candidate.conversion_note],
      ['type', stored.type, candidate.type],
      ['recommended_option_code', stored.recommended_option_code, candidate.recommended_option_code],
      ['recommended_reason', stored.recommended_reason, candidate.recommended_reason],
    ]
    if (stored.required !== (candidate.required ?? true) || stored.allow_other !== (candidate.allow_other ?? false)) return false
    if (sameFields.some(([, left, right]) => normalizedText(left) !== normalizedText(right))) return false
    const storedOptions = stored.options ?? []
    const candidateOptions = candidate.options ?? []
    if (storedOptions.length !== candidateOptions.length) return false
    return candidateOptions.every((option, optionIndex) => {
      const storedOption = storedOptions[optionIndex]
      return storedOption
        && normalizedText(storedOption.code) === normalizedText(option.code)
        && normalizedText(storedOption.label) === normalizedText(option.label)
        && normalizedText(storedOption.detail) === normalizedText(option.detail)
    })
  })
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

  const warnings = getDecisionQualityWarnings(payload)

  if (jsonOut) {
    console.log(JSON.stringify({ valid: true, question_count: payload.questions.length, warnings }, null, 2))
  } else {
    console.log(`✔ 校验通过：表单 "${payload.title}"（slug: ${payload.slug}），共 ${payload.questions.length} 道题`)
    for (const warning of warnings) {
      console.warn(`⚠️ 质量提示：${warning}`)
    }
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

  reportQualityWarnings(payload)

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

async function handlePublish() {
  const payload = loadPayloadFromFile(args.file)
  const sourceDocument = loadTextFromFile(args['source-file'], 'source-file（原始 Markdown/文本路径）')
  payload.source_document = sourceDocument

  const result = validateDecisionPayload(payload)
  if (!result.valid) {
    if (jsonOut) {
      console.log(JSON.stringify({ error: '表单 Payload 校验失败', errors: result.errors }))
    } else {
      console.error('❌ 表单 Payload 校验失败：')
      for (const err of result.errors) console.error(`  - ${err}`)
    }
    process.exit(1)
  }

  reportQualityWarnings(payload)

  const slug = payload.slug.trim()
  try {
    const existing = await store.getDecisionFormBySlug(slug)
    if (existing) {
      if (existing.source_document === sourceDocument && sameDecisionDefinition(existing, payload)) {
        const outcome = { id: existing.id, slug, url: getShareUrl(slug), created: false }
        console.log(jsonOut ? JSON.stringify(outcome) : `${outcome.url}\n${outcome.id}`)
        return
      }
      fail(`slug 已存在但表单定义或原始文档不同: ${slug}。请指定新 slug，避免覆盖既有决策。`)
    }

    const created = await store.createDecisionForm(payload)
    const outcome = { id: created.id, slug: created.slug, url: getShareUrl(created.slug), created: true }
    console.log(jsonOut ? JSON.stringify(outcome) : `${outcome.url}\n${outcome.id}`)
  } catch (err) {
    fail(`发布表单失败: ${err.message}`)
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

async function handleClarify() {
  const slug = args.slug
  const questionCode = args.question
  const content = args.content
  if (!slug || slug === true) fail('缺少参数 --slug')
  if (!questionCode || questionCode === true) fail('缺少参数 --question（题目编号，如 H3）')
  if (!content || content === true) fail('缺少参数 --content（飞书中的正式澄清/拍板结论）')
  const kind = String(args.kind || 'clarification')
  if (!['clarification', 'decision', 'change'].includes(kind)) {
    fail('非法 --kind，可选 clarification / decision / change')
  }
  try {
    const entry = await store.appendDecisionClarification({
      slug: String(slug),
      questionCode: String(questionCode),
      content: String(content),
      kind,
      sourceChannel: typeof args.source === 'string' ? args.source : 'feishu',
      sourceUrl: typeof args['source-url'] === 'string' ? args['source-url'] : '',
      createdBy: typeof args.by === 'string' ? args.by : 'agent',
    })
    if (jsonOut) console.log(JSON.stringify(entry))
    else console.log(`✔ 已同步 ${questionCode} 的${kind === 'decision' ? '拍板' : kind === 'change' ? '变更' : '澄清'}`)
  } catch (err) {
    fail(`同步澄清失败: ${err.message}`)
  }
}

async function handleEnrich() {
  const slug = args.slug
  if (!slug || slug === true) fail('缺少参数 --slug')
  const payload = loadPayloadFromFile(args.file)
  if (typeof args['source-file'] === 'string') {
    const sourcePath = path.resolve(process.cwd(), args['source-file'])
    if (!fs.existsSync(sourcePath)) fail(`原始文档不存在: ${sourcePath}`)
    payload.source_document = fs.readFileSync(sourcePath, 'utf8')
  }
  try {
    await store.enrichDecisionForm(String(slug), payload)
    console.log(`✔ 已补齐 ${slug} 的完整原文与按题依据`)
  } catch (err) {
    fail(`补齐表单依据失败: ${err.message}`)
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
    case 'publish':
      await handlePublish()
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
    case 'clarify':
      await handleClarify()
      break
    case 'enrich':
      await handleEnrich()
      break
    case 'list':
      await handleList()
      break
    default:
      console.log(`
决策中心 CLI 用法：
  npm run decision:validate -- --file <decision.json>
  npm run decision:create -- --file <decision.json>
  npm run decision:publish -- --file <decision.json> --source-file <original.md> [--json]
  npm run decision:export -- --slug <slug> [--format markdown|json] [--respondent <name>]
  npm run decision:close -- --slug <slug>
  npm run decision:open -- --slug <slug>
  npm run decision:clarify -- --slug <slug> --question <code> --content <text> [--kind clarification|decision|change] [--source-url <feishu-url>]
  npm run decision:enrich -- --slug <slug> --file <decision.json> --source-file <original.md>
  npm run decision:list
`)
      break
  }
}

main().catch((err) => {
  fail(err.message || String(err))
})
