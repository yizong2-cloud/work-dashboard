import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getDB } from '../lib/dbFactory'
import { createDecisionService } from '../lib/decisionService'
import type { DecisionForm, DecisionFormDetail } from '../types'
import { DecisionExportModal } from '../components/DecisionExportModal'
import {
  FileQuestion,
  Share2,
  ExternalLink,
  Download,
  Check,
  RefreshCw,
  Clock,
  User,
  ShieldAlert,
} from 'lucide-react'

export function DecisionCenter() {
  const navigate = useNavigate()
  const [forms, setForms] = useState<DecisionForm[]>([])
  const [filter, setFilter] = useState<'open' | 'all' | 'closed'>('open')
  const [loading, setLoading] = useState(true)
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null)
  const [exportModalForm, setExportModalForm] = useState<DecisionFormDetail | null>(null)

  const db = getDB()
  const service = createDecisionService(db)

  const loadForms = useCallback(async () => {
    setLoading(true)
    try {
      const list = await service.listForms(true)
      setForms(list)
    } catch (err) {
      console.error('加载决策表单失败:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadForms()
  }, [loadForms])

  const filteredForms = forms.filter((f) => {
    if (filter === 'open') return f.status === 'open'
    if (filter === 'closed') return f.status === 'closed'
    return true
  })
  const formsWithResponses = forms.filter((f) => (f.response_count ?? 0) > 0)

  const handleCopyLink = async (slug: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const url = `${window.location.origin}${window.location.pathname}#/decisions/${slug}`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedSlug(slug)
      setTimeout(() => setCopiedSlug(null), 2000)
    } catch {
      setCopiedSlug(slug)
      setTimeout(() => setCopiedSlug(null), 2000)
    }
  }

  const handleOpenExport = async (slug: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      const detail = await service.getForm(slug)
      if (detail) {
        setExportModalForm(detail)
      }
    } catch (err) {
      console.error('获取表单详情失败:', err)
    }
  }

  return (
    <div className="decision-center-page">
      {/* 头部区 */}
      <div className="decision-header-section">
        <div className="decision-header-main">
          <div className="decision-title-group">
            <h1 className="decision-page-title">
              <span className="decision-title-icon">
                <FileQuestion size={26} />
              </span>
              决策中心
            </h1>
            <p className="decision-page-desc">
              面向 Agent 协作的结构化拍板入口：反馈提交后自动沉淀，一键查看与导出供 Agent 消费。
            </p>
          </div>
          <div className="decision-header-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={loadForms}
              disabled={loading}
              title="刷新数据"
            >
              <RefreshCw size={14} className={loading ? 'spin' : ''} /> 刷新
            </button>
          </div>
        </div>

        {/* 内部协作免责提醒 */}
        <div className="decision-notice-banner">
          <ShieldAlert size={16} className="text-amber" />
          <span>内部协作链接：持有链接即可查看和填写；提交结果会自动保存到决策中心，请勿填写敏感信息。</span>
        </div>
      </div>

      <section className="decision-inbox" aria-labelledby="decision-inbox-title">
        <div className="decision-inbox-heading">
          <div>
            <h2 id="decision-inbox-title">决策收件箱</h2>
            <p>他人提交的反馈会自动保存在这里；打开后即可查看、复制或导出给 Agent。</p>
          </div>
          <span className="tag tag-demo">{formsWithResponses.length} 个有反馈的表单</span>
        </div>
        {formsWithResponses.length === 0 ? (
          <p className="decision-inbox-empty">暂未收到反馈。分享表单后，对方提交即可在此查看。</p>
        ) : (
          <div className="decision-inbox-list">
            {formsWithResponses.map((form) => (
              <button
                type="button"
                key={form.id}
                className="decision-inbox-item"
                onClick={() => navigate(`/decisions/${form.slug}/export`)}
              >
                <span className="decision-inbox-item-title">{form.title}</span>
                <span className="decision-inbox-item-meta">已收到 {form.response_count} 份反馈 · 查看结果</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 筛选标签栏 */}
      <div className="decision-filter-bar">
        <div className="decision-filter-tabs">
          <button
            type="button"
            className={`decision-tab ${filter === 'open' ? 'decision-tab-active' : ''}`}
            onClick={() => setFilter('open')}
          >
            进行中 ({forms.filter((f) => f.status === 'open').length})
          </button>
          <button
            type="button"
            className={`decision-tab ${filter === 'all' ? 'decision-tab-active' : ''}`}
            onClick={() => setFilter('all')}
          >
            全部表单 ({forms.length})
          </button>
          <button
            type="button"
            className={`decision-tab ${filter === 'closed' ? 'decision-tab-active' : ''}`}
            onClick={() => setFilter('closed')}
          >
            已关闭 ({forms.filter((f) => f.status === 'closed').length})
          </button>
        </div>
      </div>

      {/* 决策表单卡片列表 */}
      {loading ? (
        <div className="decision-loading">
          <RefreshCw size={24} className="spin text-muted" />
          <p>正在载入决策表单...</p>
        </div>
      ) : filteredForms.length === 0 ? (
        <div className="decision-empty-state">
          <div className="decision-empty-icon">
            <FileQuestion size={40} />
          </div>
          <h3>暂无{filter === 'open' ? '进行中的' : filter === 'closed' ? '已关闭的' : ''}决策表单</h3>
          <p>可以通过 Agent CLI 执行 <code>npm run decision:create -- --file &lt;payload.json&gt;</code> 导入新决策单。</p>
        </div>
      ) : (
        <div className="decision-grid">
          {filteredForms.map((form) => {
            const isOpen = form.status === 'open'
            const isClosed = form.status === 'closed'
            const isCopied = copiedSlug === form.slug

            return (
              <div
                key={form.id}
                className={`decision-card ${isClosed ? 'decision-card-closed' : ''}`}
                onClick={() => navigate(`/decisions/${form.slug}`)}
              >
                <div className="decision-card-header">
                  <div className="decision-card-tags">
                    <span
                      className={`tag ${
                        isOpen ? 'tag-in-progress' : isClosed ? 'tag-completed' : 'tag-planned'
                      }`}
                    >
                      {isOpen ? '收集中' : isClosed ? '已关闭' : '草稿'}
                    </span>
                    <span className="tag tag-normal">
                      {form.question_count ?? 0} 题
                    </span>
                    <span className="tag tag-demo">
                      {form.response_count ?? 0} 份反馈
                    </span>
                  </div>
                  <button
                    type="button"
                    className={`btn-link-icon ${isCopied ? 'text-success' : ''}`}
                    onClick={(e) => handleCopyLink(form.slug, e)}
                    title="复制分享链接"
                  >
                    {isCopied ? <Check size={16} /> : <Share2 size={16} />}
                  </button>
                </div>

                <h3 className="decision-card-title">{form.title}</h3>
                {form.summary && (
                  <p className="decision-card-summary">{form.summary}</p>
                )}

                <div className="decision-card-meta">
                  <span className="decision-meta-item">
                    <User size={13} /> {form.created_by || 'agent'}
                  </span>
                  <span className="decision-meta-item">
                    <Clock size={13} />{' '}
                    {new Date(form.created_at).toLocaleDateString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                    })}
                  </span>
                  <span className="decision-meta-slug">
                    <code>{form.slug}</code>
                  </span>
                </div>

                <div className="decision-card-actions" onClick={(e) => e.stopPropagation()}>
                  <Link
                    to={`/decisions/${form.slug}`}
                    className="btn btn-primary btn-sm decision-action-fill"
                  >
                    <ExternalLink size={14} /> {isOpen ? '提交反馈' : isClosed ? '查看表单' : '查看草稿'}
                  </Link>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={(e) => handleOpenExport(form.slug, e)}
                    disabled={(form.response_count ?? 0) === 0}
                    title={(form.response_count ?? 0) === 0 ? '尚未收到反馈，暂无法导出' : '查看并导出反馈'}
                  >
                    <Download size={14} /> 导出结果
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 导出弹窗 */}
      {exportModalForm && (
        <DecisionExportModal
          form={exportModalForm}
          isOpen={!!exportModalForm}
          onClose={() => setExportModalForm(null)}
        />
      )}
    </div>
  )
}
