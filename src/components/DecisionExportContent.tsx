import { useState, useMemo } from 'react'
import type { DecisionFormDetail } from '../types'
import { formatDecisionMarkdown, formatDecisionJson } from '../lib/decisionFormat'
import { Copy, Download, Check, FileText, Code2, AlertCircle } from 'lucide-react'

interface DecisionExportContentProps {
  form: DecisionFormDetail
  onAfterCopy?: () => void
}

export function DecisionExportContent({ form, onAfterCopy }: DecisionExportContentProps) {
  const [format, setFormat] = useState<'markdown' | 'json'>('markdown')
  const [selectedRespondent, setSelectedRespondent] = useState<string>('all')
  const [copied, setCopied] = useState(false)

  const respondents = useMemo(() => {
    const list = form.responses || []
    return list.map((r) => ({
      id: r.id,
      name: r.respondent_name,
      submittedAt: r.submitted_at,
    }))
  }, [form.responses])

  const exportText = useMemo(() => {
    const opts = selectedRespondent === 'all' ? {} : { responseId: selectedRespondent }
    if (format === 'json') {
      return formatDecisionJson(form, opts)
    }
    return formatDecisionMarkdown(form, opts)
  }, [form, format, selectedRespondent])

  const hasResponses = (form.responses?.length ?? 0) > 0

  const handleCopy = async () => {
    if (!hasResponses) return
    try {
      await navigator.clipboard.writeText(exportText)
      setCopied(true)
      onAfterCopy?.()
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = exportText
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      onAfterCopy?.()
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleDownload = () => {
    if (!hasResponses) return
    const filename = `${form.slug}-decision-results.${format === 'json' ? 'json' : 'md'}`
    const mime = format === 'json' ? 'application/json' : 'text/markdown'
    const blob = new Blob([exportText], { type: `${mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="decision-export-content-wrapper">
      <div className="decision-export-controls">
        <div className="export-control-group">
          <label className="export-label">导出范围：</label>
          <select
            className="select-input"
            value={selectedRespondent}
            onChange={(e) => setSelectedRespondent(e.target.value)}
            disabled={!hasResponses}
          >
            <option value="all">全部反馈 ({form.responses?.length ?? 0} 份)</option>
            {respondents.map((r, idx) => (
              <option key={r.id} value={r.id}>
                {r.name.trim() || '未填写身份'}（第 {idx + 1} 份 · {new Date(r.submittedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）
              </option>
            ))}
          </select>
        </div>

        <div className="export-control-group">
          <label className="export-label">导出格式：</label>
          <div className="format-toggle">
            <button
              type="button"
              className={`format-btn ${format === 'markdown' ? 'format-btn-active' : ''}`}
              onClick={() => setFormat('markdown')}
            >
              <FileText size={15} /> Markdown（推荐）
            </button>
            <button
              type="button"
              className={`format-btn ${format === 'json' ? 'format-btn-active' : ''}`}
              onClick={() => setFormat('json')}
            >
              <Code2 size={15} /> JSON
            </button>
          </div>
        </div>
      </div>

      {!hasResponses && (
        <div className="export-empty-banner">
          <AlertCircle size={18} />
          <span>尚未收到任何决策反馈。对方提交后，结果会自动保存并在这里呈现。</span>
        </div>
      )}

      <div className="decision-export-preview">
        <pre className="export-code-block">{exportText}</pre>
      </div>

      <div className="export-actions-bar">
        <div className="export-footer-hint">
          <span>内部协作导出 · 格式与 Agent CLI 保持严格一致</span>
        </div>
        <div className="export-footer-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleDownload}
            disabled={!hasResponses}
          >
            <Download size={16} /> 下载 .{format === 'json' ? 'json' : 'md'}
          </button>
          <button
            type="button"
            className={`btn btn-primary ${copied ? 'btn-success' : ''}`}
            onClick={handleCopy}
            disabled={!hasResponses}
          >
            {copied ? (
              <>
                <Check size={16} /> 已复制到剪贴板
              </>
            ) : (
              <>
                <Copy size={16} /> 复制 {format === 'json' ? 'JSON' : 'Markdown'}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
