// ============================================================
// 任务稳定颜色：同一任务在任何视图（周视图/月历/就地卡）永远同色，
// 用于「识别任务身份」；状态（阻塞/逾期/加急）用边框/图标表达，不覆盖任务色。
// 按 taskId 稳定哈希到调色板，无需存库、刷新不变。
// ============================================================

// 12 个高区分度色（色相拉开）；CSS 用 .task-color-<key> 定义底色/边框
export const TASK_COLOR_KEYS = [
  'sunset', 'ocean', 'forest', 'grape', 'gold', 'coral',
  'sky', 'lime', 'rose', 'slate', 'teal', 'amber',
]

/** 任一 26 字符 uuid → 稳定 0..keys.length-1 */
export function taskColorIndex(taskId: string): number {
  let h = 0
  const str = String(taskId || '')
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return h % TASK_COLOR_KEYS.length
}

export function taskColorKey(taskId: string): string {
  return TASK_COLOR_KEYS[taskColorIndex(taskId)]
}

/** 给 CSS className 用：'task-color-ocean' */
export function taskColorClass(taskId: string | null | undefined): string {
  return taskColorKey(taskId || '')
}
