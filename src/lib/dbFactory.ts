// ============================================================
// 数据层工厂：根据配置选择 local / supabase
// ============================================================

import { appConfig } from '../config'
import { getSupabaseClient } from './supabaseClient'
import type { DB } from './db'
import { createLocalDB } from './dbLocal'
import { createSupabaseDB } from './dbSupabase'

let dbInstance: DB | null = null

export function getDB(): DB {
  if (dbInstance) return dbInstance
  if (appConfig.dataMode === 'supabase') {
    const client = getSupabaseClient()
    if (client) {
      dbInstance = createSupabaseDB(client)
      return dbInstance
    }
  }
  // 未配置 Supabase → 本地演示模式
  dbInstance = createLocalDB()
  return dbInstance
}

/** 重置单例（主要用于测试） */
export function resetDB(): void {
  dbInstance = null
}
