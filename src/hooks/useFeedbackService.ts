import { useMemo } from 'react'
import type { DB } from '../lib/db'
import { createFeedbackService } from '../lib/feedbackService'
import type { FeedbackService } from '../lib/feedbackService'

/**
 * 构造反馈线程服务（任务一）。
 * 免登录：displayName 为空，由 feedbackRules.feedbackDisplayName 按角色给默认展示名
 * （leader → "Leader"，owner → "本人"），署名仅展示，不做身份校验。
 */
export function useFeedbackService(db: DB): FeedbackService {
  return useMemo(() => createFeedbackService(db, { displayName: '' }), [db])
}
