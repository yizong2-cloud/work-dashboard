export type NotificationAudience = 'group' | 'personal'

/**
 * 默认投递分层：只有决策答卷涉及 Leader 不必看到的个人收件信息。
 * 加急/催办等协作事件仍留在群里，确保触发者能看到操作回执。
 */
export function audienceForEvent(eventType: string): NotificationAudience {
  return eventType === 'decision_response_submitted' ? 'personal' : 'group'
}
