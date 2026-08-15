import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { appConfig } from '../config'

/**
 * 本看板仅本人与 Leader 使用，无敏感数据，不做登录与权限控制：
 * 打开网站即可查看，也即可编辑。
 */
export function Layout({ children }: { children: ReactNode }) {
  const isLocalMode = appConfig.dataMode === 'local'

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
            <Link to="/" className="nav-link">
              看板
            </Link>
          </nav>
        </div>
      </header>
      <main className="main">{children}</main>
      <footer className="footer muted">个人工作进度看板 · 数据由本人/Agent 维护</footer>
    </div>
  )
}
