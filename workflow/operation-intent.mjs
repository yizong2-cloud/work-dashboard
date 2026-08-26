// Shared notification-intent rules for the review preview and the write phase.
// "immediate" means an outbox event will be created, never that Feishu has
// already delivered it.

export function notificationIntentFor(op) {
  if (op.at) return 'historical'
  if (['immediate', 'merge', 'silent'].includes(op.notify_mode)) return op.notify_mode
  if (op.op === 'note') return (op.type ?? 'progress') === 'note' && !op.notify ? 'silent' : 'immediate'
  if (op.op === 'update') {
    return op.notify || op.current_status !== undefined || op.priority !== undefined ? 'immediate' : 'silent'
  }
  return 'immediate'
}

export function summarizeNotificationIntents(ops) {
  const summary = { immediate: 0, merge: 0, silent: 0, historical: 0 }
  for (const op of ops || []) summary[notificationIntentFor(op)] += 1
  return summary
}
