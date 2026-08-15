import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function Login() {
  const { login, sendMagicLink, isLocalMode, user } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setMsg('')
    try {
      await login(email.trim(), password)
      navigate('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function magic(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) {
      setError('请先输入邮箱')
      return
    }
    setBusy(true)
    setError('')
    setMsg('')
    try {
      await sendMagicLink(email.trim())
      setMsg('登录链接已发送，请查收邮件。')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (user) {
    return (
      <div className="page card center-card">
        <h2>已登录：{user.email}</h2>
        <p className="muted">
          {user.isAdmin ? '你拥有管理员权限，可以更新看板。' : '当前账号为只读权限，仅可查看。'}
        </p>
        <div className="row-gap">
          <Link className="btn btn-primary" to="/">
            返回看板
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="card center-card">
        <h2 className="center">登录看板</h2>
        {isLocalMode ? (
          <>
            <p className="muted center">
              当前为本地演示模式（数据存在浏览器里），点击下方按钮即可作为管理员体验完整功能。
            </p>
            <button
              className="btn btn-primary"
              onClick={() => {
                setEmail('admin@local')
                void login('admin@local', '')
                navigate('/')
              }}
            >
              进入看板（演示模式）
            </button>
          </>
        ) : (
          <>
            <form onSubmit={submit} className="stack">
              <label className="field">
                <span>邮箱</span>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
              </label>
              <label className="field">
                <span>密码</span>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </label>
              {error && <p className="form-error">{error}</p>}
              <button className="btn btn-primary" disabled={busy}>
                {busy ? '登录中…' : '登录'}
              </button>
            </form>
            <div className="divider">或</div>
            <form onSubmit={magic}>
              <button className="btn btn-ghost" disabled={busy} type="submit">
                发送魔法链接到邮箱（免密码）
              </button>
            </form>
            {msg && <p className="form-ok">{msg}</p>}
          </>
        )}
      </div>
    </div>
  )
}
