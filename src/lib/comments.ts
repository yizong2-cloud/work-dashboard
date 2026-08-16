import type { TaskUpdate } from '../types'

/**
 * Leader 留言复用 task_updates：它天然具备任务归属、作者、时间和通知触发能力。
 * 使用稳定前缀区分普通进展，避免为轻量留言额外引入一张表和一套同步逻辑。
 */
export const COMMENT_PREFIX = '💬 '

export function encodeComment(content: string): string {
  return `${COMMENT_PREFIX}${content.trim()}`
}

export function isComment(update: TaskUpdate): boolean {
  return update.type === 'note' && update.content.startsWith(COMMENT_PREFIX)
}

export function commentBody(update: TaskUpdate): string {
  return isComment(update) ? update.content.slice(COMMENT_PREFIX.length) : update.content
}
