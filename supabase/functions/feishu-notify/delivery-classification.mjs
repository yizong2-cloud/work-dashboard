// Edge Function 与本地只读诊断共用的投递失败分类，避免两套规则漂移。

export function classifyDeliveryFailure(message) {
  const text = String(message || '').toLowerCase()
  if (
    text.includes('task not found')
    || text.includes('thread not found')
    || text.includes('event has no task_id')
    || text.includes('unsupported event type')
  ) return 'skip'
  return 'retry'
}
