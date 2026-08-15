// ============================================================
// 演示种子数据（local 模式首次打开时载入）
// 内容与 scripts/seed.json 保持一致，仅用于演示，
// 接入 Supabase 后可通过 `npm run agent:seed` 写入线上库。
// ============================================================

import type { Task, TaskUpdate } from '../types'

function iso(daysFromToday: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromToday)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export const seedTasks: Task[] = [
  {
    id: 't-theme',
    title: '宁静拼图主题系统',
    description: '为主题玩法新增可切换的拼图主题：主题选择页、主题解锁逻辑、主题素材接入。',
    status: 'in_progress',
    priority: 'high',
    progress: 65,
    start_date: iso(-1),
    expected_end_date: iso(2),
    actual_end_date: null,
    current_status: '主题选择页面已完成，正在接入主题解锁逻辑。',
    block_reason: '',
    is_interrupt_task: false,
    created_at: new Date(Date.now() - 4 * 864e5).toISOString(),
    updated_at: new Date(Date.now() - 5 * 36e5).toISOString(),
  },
  {
    id: 't-crash',
    title: '线上 Android Crash 修复',
    description: '线上反馈 Android 端偶发崩溃，定位崩溃点并发布修复包。',
    status: 'completed',
    priority: 'high',
    progress: 100,
    start_date: iso(-1),
    expected_end_date: iso(-1),
    actual_end_date: iso(-1),
    current_status: '崩溃已定位并修复，修复包已发布。',
    block_reason: '',
    is_interrupt_task: true,
    created_at: new Date(Date.now() - 26 * 36e5).toISOString(),
    updated_at: new Date(Date.now() - 21 * 36e5).toISOString(),
  },
  {
    id: 't-finish',
    title: '拼图完成页面改版',
    description: '优化拼图完成页的动效与分享引导，提升完成率与分享率。',
    status: 'planned',
    priority: 'normal',
    progress: 0,
    start_date: iso(2),
    expected_end_date: iso(3),
    actual_end_date: null,
    current_status: '',
    block_reason: '',
    is_interrupt_task: false,
    created_at: new Date(Date.now() - 3 * 864e5).toISOString(),
    updated_at: new Date(Date.now() - 3 * 864e5).toISOString(),
  },
  {
    id: 't-bgm',
    title: 'BGM 切换功能',
    description: '设置页新增背景音乐开关与曲目切换。',
    status: 'planned',
    priority: 'low',
    progress: 0,
    start_date: iso(3),
    expected_end_date: iso(4),
    actual_end_date: null,
    current_status: '',
    block_reason: '',
    is_interrupt_task: false,
    created_at: new Date(Date.now() - 2 * 864e5).toISOString(),
    updated_at: new Date(Date.now() - 2 * 864e5).toISOString(),
  },
  {
    id: 't-guide',
    title: '新用户引导优化',
    description: '优化新手引导流程，缩短首次上手路径。',
    status: 'planned',
    priority: 'normal',
    progress: 0,
    start_date: iso(4),
    expected_end_date: iso(5),
    actual_end_date: null,
    current_status: '',
    block_reason: '',
    is_interrupt_task: false,
    created_at: new Date(Date.now() - 864e5).toISOString(),
    updated_at: new Date(Date.now() - 864e5).toISOString(),
  },
]

export const seedUpdates: TaskUpdate[] = [
  // 主题系统时间线
  {
    id: 'u-theme-1',
    task_id: 't-theme',
    type: 'note',
    content: '任务创建并开始开发。',
    old_expected_end_date: null,
    new_expected_end_date: null,
    created_at: new Date(Date.now() - 4 * 864e5).toISOString(),
    created_by: 'admin',
  },
  {
    id: 'u-theme-2',
    task_id: 't-theme',
    type: 'progress',
    content: '完成主题选择页面 UI。',
    old_expected_end_date: null,
    new_expected_end_date: null,
    created_at: new Date(Date.now() - 2 * 864e5 + 10 * 36e5).toISOString(),
    created_by: 'admin',
  },
  {
    id: 'u-theme-3',
    task_id: 't-theme',
    type: 'interrupt',
    content: '临时收到线上 Crash 修复任务，原任务暂时暂停。',
    old_expected_end_date: null,
    new_expected_end_date: null,
    created_at: new Date(Date.now() - 864e5 + 14 * 36e5).toISOString(),
    created_by: 'admin',
  },
  {
    id: 'u-theme-4',
    task_id: 't-theme',
    type: 'progress',
    content: 'Crash 修复完成，恢复原任务。',
    old_expected_end_date: null,
    new_expected_end_date: null,
    created_at: new Date(Date.now() - 864e5 + 17 * 36e5).toISOString(),
    created_by: 'admin',
  },
  {
    id: 'u-theme-5',
    task_id: 't-theme',
    type: 'schedule_change',
    content: '接口方案发生调整，预计完成时间由 8/18 调整为 8/19。',
    old_expected_end_date: iso(1),
    new_expected_end_date: iso(2),
    created_at: new Date(Date.now() - 5 * 36e5).toISOString(),
    created_by: 'admin',
  },
  // Crash 修复时间线
  {
    id: 'u-crash-1',
    task_id: 't-crash',
    type: 'interrupt',
    content: '线上反馈 Android 端偶发崩溃，临时插入处理。',
    old_expected_end_date: null,
    new_expected_end_date: null,
    created_at: new Date(Date.now() - 26 * 36e5).toISOString(),
    created_by: 'admin',
  },
  {
    id: 'u-crash-2',
    task_id: 't-crash',
    type: 'progress',
    content: '定位崩溃原因并完成修复。',
    old_expected_end_date: null,
    new_expected_end_date: null,
    created_at: new Date(Date.now() - 22 * 36e5).toISOString(),
    created_by: 'admin',
  },
  {
    id: 'u-crash-3',
    task_id: 't-crash',
    type: 'completed',
    content: '修复包已发布，观察无异常。',
    old_expected_end_date: null,
    new_expected_end_date: null,
    created_at: new Date(Date.now() - 21 * 36e5).toISOString(),
    created_by: 'admin',
  },
]

export function buildSeed(): { tasks: Task[]; updates: TaskUpdate[] } {
  return { tasks: seedTasks, updates: seedUpdates }
}
