// ============================================================
// 决策中心领域服务：与 TaskService 解耦，独立维护决策表单与答卷
// ============================================================

import type { DB } from './db'
import type {
  DecisionForm,
  DecisionFormDetail,
  DecisionFormPayload,
  DecisionClarification,
  DecisionClarificationKind,
  DecisionResponse,
  DecisionSubmissionInput,
} from '../types'

export interface DecisionService {
  /** 获取表单列表（包含题目与答卷计数） */
  listForms(includeClosed?: boolean): Promise<DecisionForm[]>

  /** 获取单个表单详情（含全部题目、选项与答卷） */
  getForm(slug: string): Promise<DecisionFormDetail | null>

  /** 创建新决策表单（原子创建） */
  createForm(payload: DecisionFormPayload): Promise<{ id: string; slug: string }>

  /** 提交答卷（原子写入） */
  submitResponse(slug: string, submission: DecisionSubmissionInput): Promise<DecisionResponse>

  /** 同步来自飞书等外部沟通渠道的正式澄清，不承载站内聊天 */
  appendClarification(input: {
    slug: string
    questionCode: string
    kind: DecisionClarificationKind
    content: string
    sourceChannel?: string
    sourceUrl?: string
    createdBy?: string
  }): Promise<DecisionClarification>

  /** 关闭决策表单（停止收集新答卷） */
  closeForm(slug: string): Promise<void>

  /** 重新开放决策表单 */
  openForm(slug: string): Promise<void>
}

export function createDecisionService(db: DB): DecisionService {
  return {
    async listForms(includeClosed = true) {
      const forms = await db.listDecisionForms()
      if (includeClosed) return forms
      return forms.filter((f) => f.status !== 'closed')
    },

    async getForm(slug: string) {
      if (!slug || !slug.trim()) return null
      return db.getDecisionFormBySlug(slug.trim())
    },

    async createForm(payload: DecisionFormPayload) {
      return db.createDecisionForm(payload)
    },

    async submitResponse(slug: string, submission: DecisionSubmissionInput) {
      return db.submitDecisionResponse(slug, submission.respondent_name, submission.answers, submission.respondent_note)
    },

    async appendClarification(input) {
      return db.appendDecisionClarification(input)
    },

    async closeForm(slug: string) {
      return db.closeDecisionForm(slug)
    },

    async openForm(slug: string) {
      return db.openDecisionForm(slug)
    },
  }
}
