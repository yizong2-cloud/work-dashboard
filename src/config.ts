// ============================================================
// 全局配置：从环境变量读取，集中在单点，避免散落各处。
// ============================================================

export interface AppConfig {
  dataMode: 'local' | 'supabase'
  supabaseUrl: string
  supabaseAnonKey: string
  /** 管理员邮箱（本人）。仅用于前端 UI 显示编辑按钮；真正的权限由 RLS 控制 */
  adminEmail: string
}

function readConfig(): AppConfig {
  const mode = (import.meta.env.VITE_DATA_MODE as string | undefined) || 'local'
  return {
    dataMode: mode === 'supabase' ? 'supabase' : 'local',
    supabaseUrl: (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '',
    supabaseAnonKey: (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || '',
    adminEmail: (import.meta.env.VITE_ADMIN_EMAIL as string | undefined) || '',
  }
}

export const appConfig = readConfig()
