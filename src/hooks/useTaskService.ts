import { useMemo } from 'react'
import type { DB } from '../lib/db'
import { createTaskService } from '../lib/taskService'
import type { TaskService } from '../lib/taskService'

/**
 * 构造 TaskService。无登录体系，所有更新者固定记为「本人」。
 */
export function useTaskService(db: DB): TaskService {
  return useMemo(() => createTaskService(db, { createdBy: '本人' }), [db])
}
