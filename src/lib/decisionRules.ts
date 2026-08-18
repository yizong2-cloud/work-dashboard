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
