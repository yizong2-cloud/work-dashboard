import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { appConfig } from '../config'

/**
 * 前端只使用「公开 anon key」。
 * 本看板无登录/权限控制（数据库已配置全开放策略）；
 * 但 service_role key 仍严禁进入前端 —— 它有数据库管理员权限。
 * 若未配置（local 模式），返回 null，数据层会自动切换到本地数据。
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (!appConfig.supabaseUrl || !appConfig.supabaseAnonKey) return null
  return createClient(appConfig.supabaseUrl, appConfig.supabaseAnonKey)
}
