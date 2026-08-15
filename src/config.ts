// ============================================================
// 全局配置：从环境变量读取，集中在单点，避免散落各处。
// ============================================================

export interface AppConfig {
  dataMode: 'local' | 'supabase'
  supabaseUrl: string
  supabaseAnonKey: string
}

function readConfig(): AppConfig {
  const mode = (import.meta.env.VITE_DATA_MODE as string | undefined) || 'local'
  return {
    dataMode: mode === 'supabase' ? 'supabase' : 'local',
    supabaseUrl: (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '',
    supabaseAnonKey: (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || '',
  }
}

export const appConfig = readConfig()
