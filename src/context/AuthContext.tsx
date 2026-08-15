// ============================================================
// 认证上下文
// - supabase 模式：使用 Supabase Auth（邮箱+密码 / 魔法链接）
// - local 模式：演示登录，任何人可当管理员
// 是否为管理员：邮箱 === VITE_ADMIN_EMAIL（真正的写权限由 RLS 把关）
// ============================================================

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { appConfig } from '../config'
import { getSupabaseClient } from '../lib/supabaseClient'

export interface CurrentUser {
  email: string
  isAdmin: boolean
}

interface AuthContextValue {
  user: CurrentUser | null
  status: 'loading' | 'ready'
  isLocalMode: boolean
  login(email: string, password: string): Promise<void>
  /** 发送魔法链接（无密码登录），supabase 模式可用 */
  sendMagicLink(email: string): Promise<void>
  logout(): Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready'>('loading')

  const isLocalMode = appConfig.dataMode === 'local'

  useEffect(() => {
    if (isLocalMode) {
      setStatus('ready')
      return
    }
    const client = getSupabaseClient()
    if (!client) {
      setStatus('ready')
      return
    }
    client.auth.getSession().then(({ data }) => {
      const session = data.session
      if (session?.user?.email) {
        setUser({
          email: session.user.email,
          isAdmin: session.user.email === appConfig.adminEmail,
        })
      }
      setStatus('ready')
    })
    const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user?.email) {
        setUser({
          email: session.user.email,
          isAdmin: session.user.email === appConfig.adminEmail,
        })
      } else {
        setUser(null)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [isLocalMode])

  const value = useMemo<AuthContextValue>(() => {
    const supabase = () => getSupabaseClient()

    return {
      user,
      status,
      isLocalMode,
      async login(email, password) {
        if (isLocalMode) {
          setUser({ email: email || 'admin@local', isAdmin: true })
          return
        }
        const client = supabase()
        if (!client) throw new Error('Supabase 未配置')
        const { error } = await client.auth.signInWithPassword({ email, password })
        if (error) throw new Error(error.message)
      },
      async sendMagicLink(email) {
        const client = supabase()
        if (!client) throw new Error('Supabase 未配置')
        const { error } = await client.auth.signInWithOtp({ email })
        if (error) throw new Error(error.message)
      },
      async logout() {
        if (isLocalMode) {
          setUser(null)
          return
        }
        const client = supabase()
        if (client) await client.auth.signOut()
        setUser(null)
      },
    }
  }, [user, status, isLocalMode])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
