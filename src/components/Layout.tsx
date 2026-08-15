import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function Layout({ children }: { children: ReactNode }) {
  const { user, isLocalMode, logout } = useAuth()
  const location = useLocation()
  const onLoginPage = location.pathname.startsWith('/login')

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">📋</span>
            <span className="brand-name">工作进度看板</span>
            {isLocalMode && <span className="tag tag-demo">演示</span>}
          </Link>
          <nav className="nav">
            {!onLoginPage && (
              <Link to="/" className="nav-link">
                看板
              </Link>
            )}
            {user ? (
              <div className="user-box">
                <span className="user-email">{user.email}</span>
                {user.isAdmin && <span className="tag tag-admin">管理员</span>}
                <button className="btn btn-ghost btn-sm" onClick={() => void logout()}>
                  退出
                </button>
              </div>
            ) : (
              !isLocalMode && (
                <Link to="/login" className="btn btn-ghost btn-sm">
                  登录
                </Link>
              )
            )}
          </nav>
        </div>
      </header>
      <main className="main">{children}</main>
      <footer className="footer muted">个人工作进度看板 · 数据由本人/Agent 维护</footer>
    </div>
  )
}
