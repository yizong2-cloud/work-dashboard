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
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 28 28" fill="none">
                <rect x="3" y="3" width="22" height="22" rx="7" fill="currentColor" />
                <path d="M8.5 17.5 12 14l2.5 2.5L20 11" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="brand-copy">
              <span className="brand-name">Workboard</span>
              <small>个人工作进度看板</small>
            </span>
            {isLocalMode && <span className="tag tag-demo">演示</span>}
          </Link>
          <nav className="nav">
            <span className="nav-sync"><i /> 数据持续更新</span>
            <Link to="/" className="nav-link nav-link-active">总览</Link>
          </nav>
        </div>
      </header>
      <main className="main">{children}</main>
      <footer className="footer muted">
        <span>Workboard</span>
        <span>数据由本人 / Agent 维护</span>
      </footer>
    </div>
  )
}
