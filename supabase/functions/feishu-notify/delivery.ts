// Edge Function 投递失败的纯规则分类：永久性数据问题不应进入自动重试。

export type DeliveryDisposition = 'retry' | 'skip'

export function classifyDeliveryFailure(message: string): DeliveryDisposition {
  const text = String(message || '').toLowerCase()
  if (
    text.includes('task not found')
    || text.includes('thread not found')
    || text.includes('event has no task_id')
    || text.includes('unsupported event type')
  ) return 'skip'
  return 'retry'
}
