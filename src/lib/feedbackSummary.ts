import type { FeedbackMessage, FeedbackThread } from '../types'

export interface FeedbackThreadRow extends Partial<FeedbackThread> {
  id: string
  task_feedback_messages?: Array<{ count?: number }>
}

/**
 * 将线程行和消息行统一成列表展示模型。
 * Supabase 与本地存储共用这条规则，避免线上只显示线程元数据而丢失最新留言摘要。
 */
export function summarizeFeedbackThreads(
  rows: FeedbackThreadRow[],
  messages: FeedbackMessage[],
): FeedbackThread[] {
  const byThread = new Map<string, FeedbackMessage[]>()
  for (const message of messages) {
    const list = byThread.get(message.thread_id) ?? []
    list.push(message)
    byThread.set(message.thread_id, list)
  }
  return rows.map((row) => {
    const threadMessages = byThread.get(row.id) ?? []
    const latest = threadMessages[threadMessages.length - 1]
    const nestedCount = row.task_feedback_messages?.[0]?.count ?? 0
    return {
      ...row,
      message_count: nestedCount || threadMessages.length,
      latest_message: latest?.body ?? '',
      latest_message_at: latest?.created_at ?? row.created_at,
      latest_author: latest?.author_name ?? row.created_by,
    } as FeedbackThread
  })
}
