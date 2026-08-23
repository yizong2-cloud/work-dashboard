import type { DecisionForm } from '../types'

export type DecisionActionState = 'awaiting_response' | 'needs_agent_review' | 'closed'

/**
 * The list view intentionally uses only facts it actually has. “待整理给 Agent”
 * means feedback exists and is ready to export; it does not pretend to know
 * whether someone has already copied it into an external Agent conversation.
 */
export function decisionActionState(form: DecisionForm): {
  state: DecisionActionState
  label: string
  detail: string
} {
  const responseCount = form.response_count ?? 0
  if (form.status === 'closed') {
    return { state: 'closed', label: '已收口', detail: responseCount > 0 ? '已关闭，可随时回看或导出结果' : '已关闭，未收到反馈' }
  }
  if (responseCount === 0) {
    return { state: 'awaiting_response', label: '待回复', detail: '分享链接后，等待首份反馈' }
  }
  return { state: 'needs_agent_review', label: '待整理给 Agent', detail: `已收到 ${responseCount} 份反馈，可导出后继续执行` }
}
