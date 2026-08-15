import { useMemo } from 'react'
import type { DB } from '../lib/db'
import { createTaskService } from '../lib/taskService'
import type { TaskService } from '../lib/taskService'
import { useAuth } from '../context/AuthContext'

/**
 * 构造当前用户视角的 TaskService。
 * created_by 会记录当前操作者邮箱，方便后续追溯是谁更新的。
 */
export function useTaskService(db: DB): TaskService {
  const { user, isLocalMode } = useAuth()
  const createdBy = useMemo(
    () => user?.email ?? (isLocalMode ? 'admin' : 'unknown'),
    [user, isLocalMode],
  )
  return useMemo(() => createTaskService(db, { createdBy }), [db, createdBy])
}
