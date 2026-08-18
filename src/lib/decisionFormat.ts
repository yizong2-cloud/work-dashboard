import type { DecisionFormDetail } from '../types'

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
  /** 仅导出指定 ID 的答卷 */
  responseId?: string
  /** 仅导出指定答卷人 */
  respondentName?: string
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
  lines.push(`- 答卷总数：${form.responses?.length ?? 0} 份（本次导出 ${responses.length} 份）`)

  if (responses.length === 0) {
    lines.push('\n> 尚未收到任何答卷提交。')
    return lines.join('\n')
  }

  const optionsById = new Map<string, { code: string; label: string }>()
  for (const q of form.questions || []) {
    for (const opt of q.options || []) {
      optionsById.set(opt.id, { code: opt.code, label: opt.label })
    }
  }

  for (let i = 0; i < responses.length; i++) {
    const resp = responses[i]
    lines.push('\n---\n')
    lines.push(`- 答卷人：${resp.respondent_name}`)
    lines.push(`- 提交时间：${formatShanghaiTime(resp.submitted_at)}`)
    if (resp.respondent_note?.trim()) {
      lines.push(`- 整体说明：${resp.respondent_note.trim()}`)
    }

    const answersByQId = new Map(
      (resp.answers || []).map((a) => [a.question_id, a]),
    )

    for (const q of form.questions || []) {
      lines.push(`\n## ${q.code}. ${q.title}`)

      const ans = answersByQId.get(q.id)
      if (!ans) {
        lines.push('- 选择：未作答')
        lines.push('- 补充：无')
        continue
      }

      if (q.type === 'single_choice' || q.type === 'multiple_choice') {
        const selectedTexts: string[] = []
        if (ans.selected_option_ids && ans.selected_option_ids.length > 0) {
          for (const optId of ans.selected_option_ids) {
            const opt = optionsById.get(optId)
            if (opt) {
              selectedTexts.push(`${opt.code}（${opt.label}）`)
            } else {
              selectedTexts.push(`未知选项(${optId})`)
            }
          }
        }
        if (ans.other_text?.trim()) {
          selectedTexts.push(`其他（${ans.other_text.trim()}）`)
        }

        lines.push(
          `- 选择：${selectedTexts.length > 0 ? selectedTexts.join('；') : '未选择'}`,
        )
        lines.push(`- 补充：${ans.text_answer?.trim() || '无'}`)
      } else if (q.type === 'confirmation') {
        const isConfirmed = ans.text_answer === 'confirmed'
        lines.push(
          `- 选择：${isConfirmed ? '确认（同意并按方案执行）' : '不确认（有异议/需调整）'}`,
        )
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

  const optionsById = new Map<string, { code: string; label: string; detail: string }>()
  for (const q of form.questions || []) {
    for (const opt of q.options || []) {
      optionsById.set(opt.id, { code: opt.code, label: opt.label, detail: opt.detail })
    }
  }

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
      required: q.required,
      context: q.context,
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
  }

  return JSON.stringify(structured, null, 2)
}
