import type { DecisionAnswer, DecisionFormDetail, DecisionQuestion, DecisionResponse } from '../types'

/** 格式化为 Asia/Shanghai 时区的时间字符串 */
export function formatShanghaiTime(isoString: string): string {
  try {
    const dt = new Date(isoString)
    if (isNaN(dt.getTime())) return isoString
    return (
      new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .format(dt)
        .replace(/\//g, '-') + ' (Asia/Shanghai)'
    )
  } catch {
    return isoString
  }
}

export interface DecisionExportOptions {
  /** 仅导出指定 ID 的反馈 */
  responseId?: string
  /** 仅导出指定提交身份的反馈 */
  respondentName?: string
}

export interface DecisionConsensusItem {
  question_id: string
  question_code: string
  question_title: string
  /** unanimous = 全部答卷同一结论；partial = 已答部分一致；split = 存在不同结论。 */
  status: 'unanimous' | 'partial' | 'split' | 'text' | 'unanswered'
  answered_count: number
  response_count: number
  groups: Array<{ label: string; count: number }>
}

/**
 * A deterministic orientation layer for Agents. It never declares a winner:
 * it only surfaces agreement, disagreement and missing answers before the
 * complete, traceable responses that remain below it.
 */
export function buildDecisionConsensus(
  form: Pick<DecisionFormDetail, 'questions'>,
  responses: DecisionResponse[],
): DecisionConsensusItem[] {
  const optionsById = optionLookup(form.questions || [])
  return (form.questions || []).map((question) => {
    const answers = responses
      .map((response) => (response.answers || []).find((answer) => answer.question_id === question.id))
      .filter((answer): answer is DecisionAnswer => Boolean(answer))

    if (question.type === 'free_text') {
      return {
        question_id: question.id,
        question_code: question.code,
        question_title: question.title,
        status: answers.length ? 'text' : 'unanswered',
        answered_count: answers.length,
        response_count: responses.length,
        groups: [],
      }
    }

    const grouped = new Map<string, number>()
    for (const answer of answers) {
      const label = decisionAnswerLabel(question, answer, optionsById)
      grouped.set(label, (grouped.get(label) ?? 0) + 1)
    }
    const groups = [...grouped.entries()].map(([label, count]) => ({ label, count }))
    const status = answers.length === 0
      ? 'unanswered'
      : groups.length > 1
        ? 'split'
        : answers.length === responses.length
          ? 'unanimous'
          : 'partial'
    return {
      question_id: question.id,
      question_code: question.code,
      question_title: question.title,
      status,
      answered_count: answers.length,
      response_count: responses.length,
      groups,
    }
  })
}

/**
 * 格式化为 Agent 消费的 Markdown
 */
export function formatDecisionMarkdown(
  form: DecisionFormDetail,
  options: DecisionExportOptions = {},
): string {
  let responses = [...(form.responses || [])].sort((a, b) =>
    b.submitted_at.localeCompare(a.submitted_at),
  )

  if (options.responseId) {
    responses = responses.filter((r) => r.id === options.responseId)
  } else if (options.respondentName) {
    responses = responses.filter(
      (r) => r.respondent_name.trim() === options.respondentName!.trim(),
    )
  }

  const lines: string[] = []

  lines.push(`# ${form.title} — 决策结果\n`)
  lines.push(`- 表单短名：${form.slug}`)
  lines.push(
    `- 表单状态：${form.status === 'open' ? '收集中 (open)' : form.status === 'closed' ? '已关闭 (closed)' : '草稿 (draft)'}`,
  )
  if (form.created_by) {
    lines.push(`- 发起人：${form.created_by}`)
  }
  lines.push(`- 已收反馈：${form.responses?.length ?? 0} 份（本次导出 ${responses.length} 份）`)

  if (responses.length === 0) {
    lines.push('\n> 尚未收到任何决策反馈。')
    const clarifications = form.clarifications || []
    if (clarifications.length > 0) {
      lines.push('\n## 已同步的澄清与拍板')
      for (const entry of clarifications) {
        const question = form.questions.find((q) => q.id === entry.question_id)
        lines.push(`- ${question ? `${question.code}：` : ''}${entry.kind === 'decision' ? '拍板' : entry.kind === 'change' ? '变更' : '澄清'} ${entry.content}`)
        lines.push(`  来源：${entry.source_channel || '外部讨论'} · ${formatShanghaiTime(entry.created_at)}`)
      }
    }
    return lines.join('\n')
  }

  const optionsById = optionLookup(form.questions || [])

  if (responses.length > 1) {
    lines.push('\n## Agent 速览（非自动拍板）')
    lines.push('> 此区只标出反馈的一致、分歧和缺答，不代替 PM / Leader 的最终拍板；完整原答卷见下方。')
    for (const item of buildDecisionConsensus(form, responses)) {
      const prefix = `- ${item.question_code}. ${item.question_title}`
      if (item.status === 'text') {
        lines.push(`${prefix}：收到 ${item.answered_count}/${item.response_count} 条文本结论，请阅读原答卷。`)
      } else if (item.status === 'unanswered') {
        lines.push(`${prefix}：本次导出尚无人作答。`)
      } else {
        const choices = item.groups.map((group) => `${group.label} ×${group.count}`).join('；')
        const state = item.status === 'unanimous'
          ? '反馈一致'
          : item.status === 'partial'
            ? '已答部分一致，仍有缺答'
            : '存在分歧'
        lines.push(`${prefix}：${state}（${item.answered_count}/${item.response_count} 份作答）— ${choices}`)
      }
    }
  }

  for (let i = 0; i < responses.length; i++) {
    const resp = responses[i]
    lines.push('\n---\n')
    lines.push(`- 提交身份：${resp.respondent_name.trim() || '未填写'}`)
    lines.push(`- 提交时间：${formatShanghaiTime(resp.submitted_at)}`)
    if (resp.respondent_note?.trim()) {
      lines.push(`- 整体说明：${resp.respondent_note.trim()}`)
    }

    const answersByQId = new Map(
      (resp.answers || []).map((a) => [a.question_id, a]),
    )

    for (const q of form.questions || []) {
      lines.push(`\n## ${q.code}. ${q.title}`)

      if (q.context) lines.push(`- 决策背景：${q.context}`)
      if (q.source_excerpt) lines.push(`- 原文依据：${q.source_excerpt}`)
      const latestClarification = (form.clarifications || [])
        .filter((entry) => entry.question_id === q.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
      if (latestClarification) {
        lines.push(`- 最新${latestClarification.kind === 'decision' ? '拍板' : latestClarification.kind === 'change' ? '变更' : '澄清'}：${latestClarification.content}`)
        lines.push(`- 澄清来源：${latestClarification.source_channel || '外部讨论'} · ${formatShanghaiTime(latestClarification.created_at)}`)
      }

      const ans = answersByQId.get(q.id)
      if (!ans) {
        lines.push('- 选择：未作答')
        lines.push('- 补充：无')
        continue
      }

      if (q.type === 'single_choice' || q.type === 'multiple_choice') {
        lines.push(`- 选择：${decisionAnswerLabel(q, ans, optionsById)}`)
        lines.push(`- 补充：${ans.text_answer?.trim() || '无'}`)
      } else if (q.type === 'confirmation') {
        lines.push(`- 选择：${decisionAnswerLabel(q, ans, optionsById)}`)
        lines.push(`- 补充：${ans.other_text?.trim() || '无'}`)
      } else if (q.type === 'free_text') {
        lines.push(`- 结论：${ans.text_answer?.trim() || '无'}`)
        if (ans.other_text?.trim()) {
          lines.push(`- 补充：${ans.other_text.trim()}`)
        }
      }
    }
  }

  return lines.join('\n')
}

/**
 * 格式化为结构化 JSON
 */
export function formatDecisionJson(
  form: DecisionFormDetail,
  options: DecisionExportOptions = {},
): string {
  let responses = [...(form.responses || [])].sort((a, b) =>
    b.submitted_at.localeCompare(a.submitted_at),
  )

  if (options.responseId) {
    responses = responses.filter((r) => r.id === options.responseId)
  } else if (options.respondentName) {
    responses = responses.filter(
      (r) => r.respondent_name.trim() === options.respondentName!.trim(),
    )
  }

  const optionsById = optionLookup(form.questions || [])

  const structured = {
    form: {
      id: form.id,
      slug: form.slug,
      title: form.title,
      summary: form.summary,
      status: form.status,
      created_by: form.created_by,
      created_at: form.created_at,
      closed_at: form.closed_at,
      total_responses: form.responses?.length ?? 0,
      exported_responses_count: responses.length,
    },
    questions: (form.questions || []).map((q) => ({
      id: q.id,
      code: q.code,
      title: q.title,
      type: q.type,
      group_name: q.group_name ?? '待确认事项',
      required: q.required,
      context: q.context,
      source_excerpt: q.source_excerpt ?? '',
      conversion_note: q.conversion_note ?? '',
      resolution_status: q.resolution_status ?? 'pending',
      recommended_option_code: q.recommended_option_code ?? null,
      recommended_reason: q.recommended_reason ?? '',
      options: (q.options || []).map((o) => ({
        id: o.id,
        code: o.code,
        label: o.label,
        detail: o.detail,
      })),
    })),
    responses: responses.map((resp) => {
      const answersByQId = new Map(
        (resp.answers || []).map((a) => [a.question_id, a]),
      )

      return {
        id: resp.id,
        submitter_identity: resp.respondent_name.trim() || null,
        respondent_name: resp.respondent_name,
        respondent_note: resp.respondent_note,
        submitted_at: resp.submitted_at,
        submitted_at_shanghai: formatShanghaiTime(resp.submitted_at),
        answers: (form.questions || []).map((q) => {
          const ans = answersByQId.get(q.id)
          const selectedOpts = (ans?.selected_option_ids || [])
            .map((optId) => {
              const opt = optionsById.get(optId)
              return opt ? { id: optId, code: opt.code, label: opt.label } : null
            })
            .filter(Boolean)

          return {
            question_id: q.id,
            question_code: q.code,
            question_title: q.title,
            question_type: q.type,
            selected_options: selectedOpts,
            text_answer: ans?.text_answer ?? '',
            other_text: ans?.other_text ?? '',
          }
        }),
      }
    }),
    consensus: buildDecisionConsensus(form, responses),
    clarifications: (form.clarifications || []).map((entry) => ({
      question_id: entry.question_id,
      kind: entry.kind,
      content: entry.content,
      source_channel: entry.source_channel,
      source_url: entry.source_url || null,
      created_by: entry.created_by,
      created_at: entry.created_at,
      created_at_shanghai: formatShanghaiTime(entry.created_at),
    })),
  }

  return JSON.stringify(structured, null, 2)
}

type OptionLookup = Map<string, { code: string; label: string; detail?: string }>

function optionLookup(questions: DecisionQuestion[]): OptionLookup {
  const optionsById: OptionLookup = new Map()
  for (const question of questions) {
    for (const option of question.options || []) {
      optionsById.set(option.id, { code: option.code, label: option.label, detail: option.detail })
    }
  }
  return optionsById
}

function decisionAnswerLabel(question: DecisionQuestion, answer: DecisionAnswer, optionsById: OptionLookup): string {
  if (question.type === 'confirmation') {
    return answer.text_answer === 'confirmed' ? '确认（同意并按方案执行）' : '不确认（有异议/需调整）'
  }
  if (question.type === 'free_text') return answer.text_answer?.trim() || '无'
  const selectedTexts = (answer.selected_option_ids || [])
    .map((optionId) => {
      const option = optionsById.get(optionId)
      return option ? `${option.code}（${option.label}）` : `未知选项(${optionId})`
    })
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
  if (answer.other_text?.trim()) selectedTexts.push(`其他（${answer.other_text.trim()}）`)
  return selectedTexts.length ? selectedTexts.join('；') : '未选择'
}
