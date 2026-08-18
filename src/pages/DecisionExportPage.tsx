import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getDB } from '../lib/dbFactory'
import { createDecisionService } from '../lib/decisionService'
import type { DecisionFormDetail } from '../types'
import { DecisionExportContent } from '../components/DecisionExportContent'
import { ChevronLeft, AlertCircle, RefreshCw } from 'lucide-react'

export function DecisionExportPage() {
  const { slug } = useParams<{ slug: string }>()
  const [form, setForm] = useState<DecisionFormDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const db = getDB()
  const service = createDecisionService(db)

  const loadForm = useCallback(async () => {
    if (!slug) return
    setLoading(true)
    setError(null)
    try {
      const data = await service.getForm(slug)
      if (!data) {
        setError(`未找到决策表单: ${slug}`)
      } else {
        setForm(data)
      }
    } catch (err: any) {
      setError(err.message || '加载表单失败')
    } finally {
      setLoading(false)
    }
  }, [slug])

  useEffect(() => {
    loadForm()
  }, [loadForm])

  if (loading) {
    return (
      <div className="decision-loading">
        <RefreshCw size={24} className="spin text-muted" />
        <p>正在载入导出数据...</p>
      </div>
    )
  }

  if (error || !form) {
    return (
      <div className="decision-error-container">
        <AlertCircle size={36} className="text-danger" />
        <h2>无法加载决策表单导出</h2>
        <p>{error || '表单不存在'}</p>
        <Link to="/decisions" className="btn btn-secondary">
          <ChevronLeft size={16} /> 返回决策中心
        </Link>
      </div>
    )
  }

  return (
    <div className="decision-export-page-container">
      {/* 顶部面包屑 */}
      <div className="decision-breadcrumb">
        <Link to="/decisions" className="decision-back-link">
          <ChevronLeft size={16} /> 决策中心
        </Link>
        <span className="decision-breadcrumb-sep">/</span>
        <Link to={`/decisions/${form.slug}`} className="decision-back-link">
          {form.slug}
        </Link>
        <span className="decision-breadcrumb-sep">/</span>
        <span>导出</span>
      </div>

      <div className="decision-form-header-card">
        <div className="decision-form-header-top">
          <div>
            <h1 className="decision-form-title">导出答卷结论给 Agent</h1>
            <p className="decision-form-summary">
              表单：<strong>{form.title}</strong>（<code>{form.slug}</code>）
            </p>
          </div>
          <Link to={`/decisions/${form.slug}`} className="btn btn-secondary btn-sm">
            返回填答页
          </Link>
        </div>

        <DecisionExportContent form={form} />
      </div>
    </div>
  )
}
