import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { appConfig } from '../config'

/**
 * 前端只使用「公开 anon key」。
 * 权限由 Supabase Auth + RLS 控制，禁止把 service_role key 放到前端。
 * 若未配置（local 模式），返回 null，数据层会自动切换到本地数据。
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (!appConfig.supabaseUrl || !appConfig.supabaseAnonKey) return null
  return createClient(appConfig.supabaseUrl, appConfig.supabaseAnonKey)
}
