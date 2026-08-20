// ============================================================
// 决策中心校验规则（纯函数，CLI / 前端 / 测试共用）
// ============================================================

import type {
  DecisionFormDetail,
  DecisionFormPayload,
  DecisionQuestionPayload,
  DecisionQuestionType,
  DecisionSubmissionInput,
} from '../types'

export const VALID_QUESTION_TYPES: DecisionQuestionType[] = [
  'single_choice',
  'multiple_choice',
  'free_text',
  'confirmation',
]

export const SLUG_REGEX = /^[a-zA-Z0-9_-]+$/

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * 发布前的内容完整性提示。
 *
 * 这些不是数据契约错误：有些决策确实没有推荐项，或原文只给了极简选项。
 * 但对“把决策文档转成可填写表单”的场景，它们是很容易丢失判断依据的信号，
 * 因此由 CLI 以 warning 给发布 Agent，而不阻断人工发布。
 */
export function getDecisionQualityWarnings(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []

  const p = payload as Partial<DecisionFormPayload>
  if (!Array.isArray(p.questions)) return []

  const warnings: string[] = []
  const hasText = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0

  p.questions.forEach((q: DecisionQuestionPayload, index: number) => {
    if (!q || typeof q !== 'object') return

    const questionLabel = `第 ${index + 1} 题（${hasText(q.code) ? q.code.trim() : '无编号'}）`
    const isChoice = q.type === 'single_choice' || q.type === 'multiple_choice'
    const hasRecommendation = hasText(q.recommended_option_code)
    const hasReason = hasText(q.recommended_reason)

    if (isChoice && !hasRecommendation) {
      warnings.push(`${questionLabel} 未提供推荐项；若当前任务目标或已有证据足以支持倾向，请补充推荐与理由，否则可忽略此提示`)
    }

    if (isChoice && hasRecommendation && !hasReason) {
      warnings.push(`${questionLabel} 已标记推荐项，但缺少 recommended_reason（填写者无法判断推荐依据）`)
    }

    if (isChoice && !hasRecommendation && hasReason) {
      warnings.push(`${questionLabel} 写有 recommended_reason，但未指定 recommended_option_code`)
    }

    if (isChoice && Array.isArray(q.options)) {
      q.options.forEach((option, optionIndex) => {
        if (option && typeof option === 'object' && !hasText(option.detail)) {
          const optionCode = hasText(option.code) ? option.code.trim() : String(optionIndex + 1)
          warnings.push(`${questionLabel} 的选项 ${optionCode} 缺少 detail（建议说明该方案的影响或取舍）`)
        }
      })
    }

    if (!hasText(q.source_excerpt)) {
      warnings.push(`${questionLabel} 缺少 source_excerpt（无法回溯原始决策依据）`)
    }

    if (!hasText(q.conversion_note)) {
      warnings.push(`${questionLabel} 缺少 conversion_note（无法说明原文如何被转换为此题）`)
    }
  })

  return warnings
}

export function validateDecisionPayload(payload: unknown): ValidationResult {
  const errors: string[] = []

  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Payload 必须是非空 JSON 对象'] }
  }

  const p = payload as Partial<DecisionFormPayload>

  // 1. Slug 校验
  if (!p.slug || typeof p.slug !== 'string' || !p.slug.trim()) {
    errors.push('缺少必填字段: slug（表单短名）')
  } else {
    const cleanSlug = p.slug.trim()
    if (!SLUG_REGEX.test(cleanSlug)) {
      errors.push(`非法 slug: "${cleanSlug}"，只允许英文字母、数字、下划线及连字符`)
    }
  }

  // 2. 标题校验
  if (!p.title || typeof p.title !== 'string' || !p.title.trim()) {
    errors.push('缺少必填字段: title（表单标题）')
  }

  // 3. 状态校验
  if (p.status && !['draft', 'open', 'closed'].includes(p.status)) {
    errors.push(`非法 status: "${p.status}"，可选: draft / open / closed`)
  }

  // 4. 题目列表校验
  if (!Array.isArray(p.questions) || p.questions.length === 0) {
    errors.push('questions 必须是非空数组（至少包含 1 道题）')
  } else {
    const questionCodes = new Set<string>()

    p.questions.forEach((q: DecisionQuestionPayload, idx: number) => {
      const qPrefix = `第 ${idx + 1} 题`

      if (!q || typeof q !== 'object') {
        errors.push(`${qPrefix} 格式非法，必须为对象`)
        return
      }

      // 编号 code
      if (!q.code || typeof q.code !== 'string' || !q.code.trim()) {
        errors.push(`${qPrefix} 缺少题目编号 code（如 D1）`)
      } else {
        const code = q.code.trim()
        if (questionCodes.has(code)) {
          errors.push(`题目编号重复: "${code}"`)
        }
        questionCodes.add(code)
      }

      // 题目标题
      if (!q.title || typeof q.title !== 'string' || !q.title.trim()) {
        errors.push(`${qPrefix} (${q.code || '无编号'}) 缺少题目标题 title`)
      }

      // 题目类型
      if (!q.type || !VALID_QUESTION_TYPES.includes(q.type)) {
        errors.push(
          `${qPrefix} (${q.code || '无编号'}) 题型非法: "${q.type}"，可选: ${VALID_QUESTION_TYPES.join(' / ')}`,
        )
      }

      // 选项校验（针对 single_choice 与 multiple_choice）
      if (q.type === 'single_choice' || q.type === 'multiple_choice') {
        if (!Array.isArray(q.options) || q.options.length < 1) {
          errors.push(`${qPrefix} (${q.code || '无编号'}) 选择题必须包含至少 1 个选项`)
        } else {
          const optionCodes = new Set<string>()
          q.options.forEach((opt, optIdx) => {
            if (!opt || typeof opt !== 'object') {
              errors.push(`${qPrefix} 选项 ${optIdx + 1} 格式非法`)
              return
            }
            if (!opt.code || typeof opt.code !== 'string' || !opt.code.trim()) {
              errors.push(`${qPrefix} 选项 ${optIdx + 1} 缺少选项 code（如 A/B）`)
            } else {
              const optCode = opt.code.trim()
              if (optionCodes.has(optCode)) {
                errors.push(`${qPrefix} 选项编号重复: "${optCode}"`)
              }
              optionCodes.add(optCode)
            }
            if (!opt.label || typeof opt.label !== 'string' || !opt.label.trim()) {
              errors.push(`${qPrefix} 选项 ${opt.code || optIdx + 1} 缺少文案 label`)
            }
          })

          // 推荐项校验
          if (q.recommended_option_code) {
            const recCode = q.recommended_option_code.trim()
            if (!optionCodes.has(recCode)) {
              errors.push(
                `${qPrefix} 推荐项 code "${recCode}" 不在已有选项中（可选: ${Array.from(optionCodes).join(', ')}）`,
              )
            }
          }
        }
      }
    })
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export interface SubmissionValidationResult {
  valid: boolean
  errors: Record<string, string>
}

export function validateDecisionSubmission(
  form: DecisionFormDetail,
  submission: DecisionSubmissionInput,
): SubmissionValidationResult {
  const errors: Record<string, string> = {}

  if (form.status === 'draft') {
    errors.form = '该决策表单当前为草稿状态，尚未开放提交'
    return { valid: false, errors }
  }

  if (form.status === 'closed') {
    errors.form = '该决策表单已关闭，不再接收新反馈'
    return { valid: false, errors }
  }

  const identity = submission.respondent_name?.trim()
  if (identity && identity.length > 50) {
    errors.respondent_name = '提交身份过长（最多 50 字）'
  }

  const answersByQuestionId = new Map<string, DecisionSubmissionInput['answers'][0]>()
  for (const ans of submission.answers || []) {
    if (ans?.question_id) {
      answersByQuestionId.set(ans.question_id, ans)
    }
  }

  for (const q of form.questions) {
    const ans = answersByQuestionId.get(q.id)
    const otherText = ans?.other_text?.trim() || ''
    const hasOther = !!otherText
    const selectedOptIds = ans?.selected_option_ids || []
    const selectedCount = selectedOptIds.length
    const textAns = ans?.text_answer?.trim() || ''
    const hasText = !!textAns

    // 1. allow_other 校验
    if (!q.allow_other && hasOther) {
      errors[q.id] = `题目 ${q.code}（${q.title}）未开启“其他”选项，禁止提交其他说明`
      continue
    }

    // 2. 校验选项归属
    if (selectedCount > 0) {
      const validOptIds = new Set(q.options.map((o) => o.id))
      for (const optId of selectedOptIds) {
        if (!validOptIds.has(optId)) {
          errors[q.id] = `选项不存在于题目 ${q.code}`
        }
      }
    }

    // 3. 按题型严格校验
    if (q.type === 'single_choice') {
      if (selectedCount > 1) {
        errors[q.id] = `单选题 ${q.code} 只能选择一个选项`
      } else if (selectedCount === 1 && hasOther) {
        errors[q.id] = `单选题 ${q.code} 已选择选项，不可同时填写其他说明`
      } else if (q.required && selectedCount === 0 && !hasOther) {
        errors[q.id] = `必答单选题 ${q.code} 未作答`
      }
    } else if (q.type === 'multiple_choice') {
      if (q.required && selectedCount === 0 && !hasOther) {
        errors[q.id] = `必答多选题 ${q.code} 未作答`
      }
    } else if (q.type === 'free_text') {
      if (selectedCount > 0) {
        errors[q.id] = `自由文本题 ${q.code} 不得包含选项选择`
      } else if (q.required && !hasText) {
        errors[q.id] = `必答自由文本题 ${q.code} 未填写内容`
      }
    } else if (q.type === 'confirmation') {
      if (selectedCount > 0) {
        errors[q.id] = `确认题 ${q.code} 不得包含选项选择`
      } else if (hasText && textAns !== 'confirmed' && textAns !== 'unconfirmed') {
        errors[q.id] = `确认题 ${q.code} 结果非法: "${textAns}"，只允许 confirmed 或 unconfirmed`
      } else if (q.required && !hasText) {
        errors[q.id] = `必答确认题 ${q.code} 未进行确认选择`
      }
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  }
}
