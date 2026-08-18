import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { getDB } from '../lib/dbFactory'
import { createDecisionService } from '../lib/decisionService'
import type {
  DecisionAnswerInput,
  DecisionFormDetail,
  DecisionQuestion,
  DecisionResponse,
} from '../types'
import { DecisionExportModal } from '../components/DecisionExportModal'
import { formatDecisionMarkdown, formatShanghaiTime } from '../lib/decisionFormat'
import {
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Download,
  AlertCircle,
  CheckCircle2,
  Lock,
  User,
  Clock,
  Sparkles,
  FileText,
  RotateCcw,
} from 'lucide-react'

export function DecisionFormPage() {
  const { slug } = useParams<{ slug: string }>()

  const [form, setForm] = useState<DecisionFormDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 展开完整背景
  const [showSourceDoc, setShowSourceDoc] = useState(false)

  // 答卷填写表单状态
  const [respondentName, setRespondentName] = useState('')
  const [respondentNote, setRespondentNote] = useState('')
  // 题目作答映射：questionId -> { selected_option_ids, text_answer, other_text, is_other_selected }
  const [answersState, setAnswersState] = useState<
    Record<
      string,
      {
        selected_option_ids: string[]
        text_answer: string
        other_text: string
        is_other_selected?: boolean
      }
    >
  >({})

  // 校验错误映射
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  // 提交成功结果
  const [submittedResponse, setSubmittedResponse] = useState<DecisionResponse | null>(null)

  // 导出弹窗
  const [isExportOpen, setIsExportOpen] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const [myAnswerCopied, setMyAnswerCopied] = useState(false)

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
        // 初始化答卷答案结构
        const initialAnswers: typeof answersState = {}
        for (const q of data.questions) {
          initialAnswers[q.id] = {
            selected_option_ids: [],
            text_answer: '',
            other_text: '',
            is_other_selected: false,
          }
        }
        setAnswersState(initialAnswers)
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

  // 计算完成进度
  const answeredCount = useMemo(() => {
    if (!form) return 0
    let count = 0
    for (const q of form.questions) {
      const a = answersState[q.id]
      if (!a) continue
      if (q.type === 'single_choice' || q.type === 'multiple_choice') {
        if (a.selected_option_ids.length > 0 || (a.is_other_selected && a.other_text.trim())) {
          count++
        }
      } else if (q.type === 'free_text') {
        if (a.text_answer.trim()) count++
      } else if (q.type === 'confirmation') {
        if (a.text_answer === 'confirmed' || a.text_answer === 'unconfirmed') count++
      }
    }
    return count
  }, [form, answersState])

  const handleCopyLink = async () => {
    const url = window.location.href
    try {
      await navigator.clipboard.writeText(url)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
    } catch {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
    }
  }

  // 单选选择
  const handleSingleSelect = (questionId: string, optionId: string) => {
    setAnswersState((prev) => ({
      ...prev,
      [questionId]: {
        ...prev[questionId],
        selected_option_ids: [optionId],
        is_other_selected: false,
      },
    }))
    if (validationErrors[questionId]) {
      setValidationErrors((prev) => {
        const next = { ...prev }
        delete next[questionId]
        return next
      })
    }
  }

  // 单选选择"其他"
  const handleSingleOtherSelect = (questionId: string) => {
    setAnswersState((prev) => ({
      ...prev,
      [questionId]: {
        ...prev[questionId],
        selected_option_ids: [],
        is_other_selected: true,
      },
    }))
  }

  // 多选选择
  const handleMultipleSelect = (questionId: string, optionId: string) => {
    setAnswersState((prev) => {
      const current = prev[questionId]?.selected_option_ids ?? []
      const next = current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId]
      return {
        ...prev,
        [questionId]: {
          ...prev[questionId],
          selected_option_ids: next,
        },
      }
    })
    if (validationErrors[questionId]) {
      setValidationErrors((prev) => {
        const next = { ...prev }
        delete next[questionId]
        return next
      })
    }
  }

  // 确认型选择
  const handleConfirmationSelect = (questionId: string, value: 'confirmed' | 'unconfirmed') => {
    setAnswersState((prev) => ({
      ...prev,
      [questionId]: {
        ...prev[questionId],
        text_answer: value,
      },
    }))
    if (validationErrors[questionId]) {
      setValidationErrors((prev) => {
        const next = { ...prev }
        delete next[questionId]
        return next
      })
    }
  }

  // 提交答卷
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form || form.status !== 'open') return

    const errors: Record<string, string> = {}

    const cleanName = respondentName.trim()
    if (!cleanName) {
      errors.respondent_name = '请填写您的姓名或角色（必填）'
    }

    const payloadAnswers: DecisionAnswerInput[] = []

    for (const q of form.questions) {
      const a = answersState[q.id]
      const hasOther = a?.is_other_selected && !!a.other_text.trim()
      const hasSelected = (a?.selected_option_ids.length ?? 0) > 0
      const hasText = !!a?.text_answer.trim()

      if (q.required) {
        if (q.type === 'single_choice') {
          if (!hasSelected && !hasOther) {
            errors[q.id] = '本题为必答题，请选择一个方案或填写其他'
          }
        } else if (q.type === 'multiple_choice') {
          if (!hasSelected && !hasOther) {
            errors[q.id] = '本题为必答题，请至少选择一项'
          }
        } else if (q.type === 'free_text') {
          if (!hasText) {
            errors[q.id] = '本题为必答题，请填写决策意见或说明'
          }
        } else if (q.type === 'confirmation') {
          if (a?.text_answer !== 'confirmed' && a?.text_answer !== 'unconfirmed') {
            errors[q.id] = '请确认是否采纳方案'
          }
        }
      }

      if (a?.is_other_selected && !a.other_text.trim()) {
        errors[q.id] = '您选择了“其他”，请在文本框中补充说明'
      }

      payloadAnswers.push({
        question_id: q.id,
        selected_option_ids: a?.selected_option_ids ?? [],
        text_answer: a?.text_answer ?? '',
        other_text: a?.is_other_selected ? a.other_text.trim() : (q.type === 'confirmation' ? a?.other_text.trim() : ''),
      })
    }

    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors)
      const firstKey = Object.keys(errors)[0]
      const el = document.getElementById(firstKey === 'respondent_name' ? 'input-respondent-name' : `question-${firstKey}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      return
    }

    setSubmitting(true)
    try {
      const resp = await service.submitResponse(form.slug, {
        respondent_name: cleanName,
        respondent_note: respondentNote.trim(),
        answers: payloadAnswers,
      })

      // 重新拉取最新表单数据（更新答卷数）
      const updated = await service.getForm(form.slug)
      if (updated) setForm(updated)

      setSubmittedResponse(resp)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err: any) {
      alert(`提交失败: ${err.message || '未知错误'}`)
    } finally {
      setSubmitting(false)
    }
  }

  // 复制自己的答卷 Markdown（复用统一导出纯函数，确保 100% 格式一致且保留整体说明）
  const handleCopyMyAnswer = async () => {
    if (!form || !submittedResponse) return
    const text = formatDecisionMarkdown(form, { responseId: submittedResponse.id })
    try {
      await navigator.clipboard.writeText(text)
      setMyAnswerCopied(true)
      setTimeout(() => setMyAnswerCopied(false), 2000)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setMyAnswerCopied(true)
      setTimeout(() => setMyAnswerCopied(false), 2000)
    }
  }

  const handleResetForNewResponse = () => {
    setSubmittedResponse(null)
    setRespondentName('')
    setRespondentNote('')
    const initialAnswers: typeof answersState = {}
    if (form) {
      for (const q of form.questions) {
        initialAnswers[q.id] = {
          selected_option_ids: [],
          text_answer: '',
          other_text: '',
          is_other_selected: false,
        }
      }
    }
    setAnswersState(initialAnswers)
    setValidationErrors({})
  }

  if (loading) {
    return (
      <div className="decision-loading">
        <div className="spinner" />
        <p>正在载入决策表单...</p>
      </div>
    )
  }

  if (error || !form) {
    return (
      <div className="decision-error-container">
        <AlertCircle size={36} className="text-danger" />
        <h2>无法加载决策表单</h2>
        <p>{error || '表单不存在'}</p>
        <Link to="/decisions" className="btn btn-secondary">
          <ChevronLeft size={16} /> 返回决策中心
        </Link>
      </div>
    )
  }

  const isClosed = form.status === 'closed'
  const isDraft = form.status === 'draft'
  const isOpen = form.status === 'open'
  const isReadOnly = isClosed || isDraft
  const hasResponses = (form.responses?.length ?? 0) > 0

  return (
    <div className="decision-form-container">
      {/* 顶部面包屑与返回 */}
      <div className="decision-breadcrumb">
        <Link to="/decisions" className="decision-back-link">
          <ChevronLeft size={16} /> 返回决策中心
        </Link>
        <span className="decision-breadcrumb-sep">/</span>
        <span className="decision-breadcrumb-slug">{form.slug}</span>
      </div>

      {/* 头部元信息卡片 */}
      <div className="decision-form-header-card">
        <div className="decision-form-header-top">
          <div className="decision-header-badges">
            <span
              className={`tag ${
                isOpen ? 'tag-in-progress' : isClosed ? 'tag-completed' : 'tag-planned'
              }`}
            >
              {isOpen ? '收集中' : isClosed ? '已关闭' : '草稿'}
            </span>
            <span className="tag tag-normal">共 {form.questions.length} 道决策题</span>
            <span className="tag tag-demo">已收到 {form.responses?.length ?? 0} 份答卷</span>
          </div>

          <div className="decision-header-btn-group">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setIsExportOpen(true)}
              disabled={!hasResponses}
              title={!hasResponses ? '尚未收到提交答卷，暂无法导出' : '导出答卷结论给 Agent'}
            >
              <Download size={15} /> 导出给 Agent
            </button>
          </div>
        </div>

        <h1 className="decision-form-title">{form.title}</h1>

        {form.summary && (
          <p className="decision-form-summary">{form.summary}</p>
        )}

        <div className="decision-form-meta-row">
          <span className="meta-item">
            <User size={14} /> 发起人：{form.created_by || 'agent'}
          </span>
          <span className="meta-item">
            <Clock size={14} /> 创建时间：{new Date(form.created_at).toLocaleString('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>

        {/* 内部协作链接提示与一键复制 */}
        <div className="decision-share-bar">
          <span className="share-hint">
            内部协作链接，请勿包含敏感信息
          </span>
          <button
            type="button"
            className={`btn btn-ghost btn-sm ${linkCopied ? 'text-success' : ''}`}
            onClick={handleCopyLink}
          >
            {linkCopied ? (
              <>
                <Check size={14} /> 已复制链接
              </>
            ) : (
              <>
                <Copy size={14} /> 复制表单链接
              </>
            )}
          </button>
        </div>

        {/* 可折叠背景材料 */}
        {form.source_document && (
          <div className="decision-source-doc-box">
            <button
              type="button"
              className="source-doc-toggle-btn"
              onClick={() => setShowSourceDoc(!showSourceDoc)}
            >
              <FileText size={15} />
              <span>查看完整需求背景文档</span>
              {showSourceDoc ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>

            {showSourceDoc && (
              <div className="source-doc-content">
                <pre>{form.source_document}</pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 草稿状态提示横幅 */}
      {isDraft && (
        <div className="decision-draft-banner">
          <AlertCircle size={18} />
          <div>
            <strong>表单当前为草稿状态</strong>
            <p>本决策表单尚未发布开放，当前为只读预览模式，暂不支持提交答卷。</p>
          </div>
        </div>
      )}

      {/* 已关闭提示横幅 */}
      {isClosed && (
        <div className="decision-closed-banner">
          <Lock size={18} />
          <div>
            <strong>表单已关闭</strong>
            <p>本决策表单已停止接收新答卷，当前为只读查阅与导出模式。</p>
          </div>
        </div>
      )}

      {/* 提交成功页面展示 */}
      {submittedResponse ? (
        <div className="decision-submitted-container">
          <div className="submitted-card">
            <div className="submitted-icon">
              <CheckCircle2 size={48} className="text-success" />
            </div>
            <h2>决策答卷已提交！</h2>
            <p className="submitted-meta">
              答卷人：<strong>{submittedResponse.respondent_name}</strong> · 提交时间：{formatShanghaiTime(submittedResponse.submitted_at)}
            </p>

            <div className="submitted-actions">
              <button
                type="button"
                className={`btn btn-primary ${myAnswerCopied ? 'btn-success' : ''}`}
                onClick={handleCopyMyAnswer}
              >
                {myAnswerCopied ? (
                  <>
                    <Check size={16} /> 已复制我的答卷 Markdown
                  </>
                ) : (
                  <>
                    <Copy size={16} /> 复制我的答卷 Markdown
                  </>
                )}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setIsExportOpen(true)}
              >
                <Download size={16} /> 导出全部答卷给 Agent
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleResetForNewResponse}
              >
                <RotateCcw size={15} /> 再提交一份新答卷
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* 填答表单主体 */
        <form onSubmit={handleSubmit} className="decision-form-body">
          {/* 答卷人信息卡片 */}
          <div
            className={`decision-question-card ${validationErrors.respondent_name ? 'card-error' : ''}`}
            id="input-respondent-name"
          >
            <div className="q-card-header">
              <label className="q-title-label">
                <span className="required-star">*</span> 答卷人姓名 / 角色
              </label>
            </div>
            <p className="q-context-desc">
              请填写您的真实姓名或产品角色（例如：商雯祺 / 拼图 PM），便于后续 Agent 与团队识别结论出处。
            </p>
            <div className="q-input-row">
              <input
                type="text"
                className="text-input"
                placeholder="请填写姓名或角色（必填）"
                value={respondentName}
                onChange={(e) => {
                  setRespondentName(e.target.value)
                  if (validationErrors.respondent_name) {
                    setValidationErrors((prev) => {
                      const next = { ...prev }
                      delete next.respondent_name
                      return next
                    })
                  }
                }}
                disabled={isReadOnly}
                maxLength={50}
              />
            </div>
            {validationErrors.respondent_name && (
              <p className="error-hint">{validationErrors.respondent_name}</p>
            )}

            <div className="q-note-row">
              <input
                type="text"
                className="text-input text-input-subtle"
                placeholder="整体补充说明（选填，如：口径与竞品 5.0.21 一致）"
                value={respondentNote}
                onChange={(e) => setRespondentNote(e.target.value)}
                disabled={isReadOnly}
                maxLength={200}
              />
            </div>
          </div>

          {/* 题目列表 */}
          {form.questions.map((q: DecisionQuestion) => {
            const hasError = !!validationErrors[q.id]
            const aState = answersState[q.id] || {
              selected_option_ids: [],
              text_answer: '',
              other_text: '',
              is_other_selected: false,
            }

            return (
              <div
                key={q.id}
                id={`question-${q.id}`}
                className={`decision-question-card ${hasError ? 'card-error' : ''}`}
              >
                <div className="q-card-header">
                  <div className="q-header-left">
                    <span className="q-code-badge">{q.code}</span>
                    <h3 className="q-title">
                      {q.title}
                      {q.required && <span className="required-star">*</span>}
                    </h3>
                  </div>
                  {q.required ? (
                    <span className="q-required-tag">必填</span>
                  ) : (
                    <span className="q-optional-tag">选填</span>
                  )}
                </div>

                {q.context && <p className="q-context-desc">{q.context}</p>}

                {/* 推荐理由说明 */}
                {q.recommended_reason && (
                  <div className="q-recommended-reason-callout">
                    <Sparkles size={14} className="text-amber" />
                    <span><strong>推荐理由：</strong>{q.recommended_reason}</span>
                  </div>
                )}

                {/* 单选题 */}
                {q.type === 'single_choice' && (
                  <div className="options-list">
                    {q.options.map((opt) => {
                      const isSelected = aState.selected_option_ids.includes(opt.id)
                      const isRecommended = q.recommended_option_id === opt.id

                      return (
                        <div
                          key={opt.id}
                          className={`option-card ${isSelected ? 'option-card-selected' : ''} ${
                            isRecommended ? 'option-card-recommended' : ''
                          } ${isReadOnly ? 'option-disabled' : ''}`}
                          onClick={() => !isReadOnly && handleSingleSelect(q.id, opt.id)}
                        >
                          <div className="option-radio-circle">
                            {isSelected && <div className="radio-inner" />}
                          </div>
                          <div className="option-content">
                            <div className="option-title-row">
                              <span className="option-code-pill">{opt.code}</span>
                              <span className="option-label">{opt.label}</span>
                              {isRecommended && (
                                <span className="recommended-badge">
                                  <Sparkles size={12} /> 推荐
                                </span>
                              )}
                            </div>
                            {opt.detail && (
                              <p className="option-detail-text">{opt.detail}</p>
                            )}
                          </div>
                        </div>
                      )
                    })}

                    {/* 允许“其他” */}
                    {q.allow_other && (
                      <div
                        className={`option-card ${
                          aState.is_other_selected ? 'option-card-selected' : ''
                        } ${isReadOnly ? 'option-disabled' : ''}`}
                        onClick={() => !isReadOnly && handleSingleOtherSelect(q.id)}
                      >
                        <div className="option-radio-circle">
                          {aState.is_other_selected && <div className="radio-inner" />}
                        </div>
                        <div className="option-content">
                          <span className="option-label">其他，请说明</span>
                          {aState.is_other_selected && (
                            <div
                              className="other-input-container"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="text"
                                className="text-input"
                                placeholder="请填写具体方案或口径说明（必填）"
                                value={aState.other_text}
                                onChange={(e) => {
                                  const val = e.target.value
                                  setAnswersState((prev) => ({
                                    ...prev,
                                    [q.id]: {
                                      ...prev[q.id],
                                      other_text: val,
                                    },
                                  }))
                                }}
                                disabled={isReadOnly}
                                autoFocus
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 补充说明 */}
                    <div className="q-note-row">
                      <input
                        type="text"
                        className="text-input text-input-subtle"
                        placeholder="补充说明或备注（选填）"
                        value={aState.text_answer}
                        onChange={(e) => {
                          const val = e.target.value
                          setAnswersState((prev) => ({
                            ...prev,
                            [q.id]: {
                              ...prev[q.id],
                              text_answer: val,
                            },
                          }))
                        }}
                        disabled={isReadOnly}
                      />
                    </div>
                  </div>
                )}

                {/* 多选题 */}
                {q.type === 'multiple_choice' && (
                  <div className="options-list">
                    {q.options.map((opt) => {
                      const isSelected = aState.selected_option_ids.includes(opt.id)
                      const isRecommended = q.recommended_option_id === opt.id

                      return (
                        <div
                          key={opt.id}
                          className={`option-card ${isSelected ? 'option-card-selected' : ''} ${
                            isRecommended ? 'option-card-recommended' : ''
                          } ${isReadOnly ? 'option-disabled' : ''}`}
                          onClick={() => !isReadOnly && handleMultipleSelect(q.id, opt.id)}
                        >
                          <div className="option-checkbox-box">
                            {isSelected && <Check size={14} className="checkbox-check" />}
                          </div>
                          <div className="option-content">
                            <div className="option-title-row">
                              <span className="option-code-pill">{opt.code}</span>
                              <span className="option-label">{opt.label}</span>
                              {isRecommended && (
                                <span className="recommended-badge">
                                  <Sparkles size={12} /> 推荐
                                </span>
                              )}
                            </div>
                            {opt.detail && (
                              <p className="option-detail-text">{opt.detail}</p>
                            )}
                          </div>
                        </div>
                      )
                    })}

                    {/* 允许“其他” */}
                    {q.allow_other && (
                      <div
                        className={`option-card ${
                          aState.is_other_selected ? 'option-card-selected' : ''
                        } ${isReadOnly ? 'option-disabled' : ''}`}
                        onClick={() => {
                          if (isReadOnly) return
                          setAnswersState((prev) => ({
                            ...prev,
                            [q.id]: {
                              ...prev[q.id],
                              is_other_selected: !prev[q.id]?.is_other_selected,
                            },
                          }))
                        }}
                      >
                        <div className="option-checkbox-box">
                          {aState.is_other_selected && (
                            <Check size={14} className="checkbox-check" />
                          )}
                        </div>
                        <div className="option-content">
                          <span className="option-label">其他，请说明</span>
                          {aState.is_other_selected && (
                            <div
                              className="other-input-container"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="text"
                                className="text-input"
                                placeholder="请填写具体补充说明（必填）"
                                value={aState.other_text}
                                onChange={(e) => {
                                  const val = e.target.value
                                  setAnswersState((prev) => ({
                                    ...prev,
                                    [q.id]: {
                                      ...prev[q.id],
                                      other_text: val,
                                    },
                                  }))
                                }}
                                disabled={isReadOnly}
                                autoFocus
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* 补充说明 */}
                    <div className="q-note-row">
                      <input
                        type="text"
                        className="text-input text-input-subtle"
                        placeholder="补充说明或备注（选填）"
                        value={aState.text_answer}
                        onChange={(e) => {
                          const val = e.target.value
                          setAnswersState((prev) => ({
                            ...prev,
                            [q.id]: {
                              ...prev[q.id],
                              text_answer: val,
                            },
                          }))
                        }}
                        disabled={isReadOnly}
                      />
                    </div>
                  </div>
                )}

                {/* 自由文本 */}
                {q.type === 'free_text' && (
                  <div className="free-text-container">
                    <textarea
                      className="textarea-input"
                      rows={4}
                      placeholder="请填写您的决策意见、口径定义或明确结论..."
                      value={aState.text_answer}
                      onChange={(e) => {
                        const val = e.target.value
                        setAnswersState((prev) => ({
                          ...prev,
                          [q.id]: {
                            ...prev[q.id],
                            text_answer: val,
                          },
                        }))
                        if (validationErrors[q.id]) {
                          setValidationErrors((prev) => {
                            const next = { ...prev }
                            delete next[q.id]
                            return next
                          })
                        }
                      }}
                      disabled={isReadOnly}
                    />
                  </div>
                )}

                {/* 确认型题目 */}
                {q.type === 'confirmation' && (
                  <div className="confirmation-container">
                    <div className="confirmation-toggle-row">
                      <button
                        type="button"
                        className={`confirm-btn ${
                          aState.text_answer === 'confirmed' ? 'confirm-btn-selected-yes' : ''
                        }`}
                        onClick={() => !isReadOnly && handleConfirmationSelect(q.id, 'confirmed')}
                        disabled={isReadOnly}
                      >
                        <Check size={16} /> 确认方案（按推荐口径执行）
                      </button>
                      <button
                        type="button"
                        className={`confirm-btn ${
                          aState.text_answer === 'unconfirmed' ? 'confirm-btn-selected-no' : ''
                        }`}
                        onClick={() => !isReadOnly && handleConfirmationSelect(q.id, 'unconfirmed')}
                        disabled={isReadOnly}
                      >
                        有异议 / 需单独调整
                      </button>
                    </div>

                    {q.allow_other && (
                      <div className="q-note-row">
                        <input
                          type="text"
                          className="text-input text-input-subtle"
                          placeholder="说明或异议点（选填）"
                          value={aState.other_text}
                          onChange={(e) => {
                            const val = e.target.value
                            setAnswersState((prev) => ({
                              ...prev,
                              [q.id]: {
                                ...prev[q.id],
                                other_text: val,
                              },
                            }))
                          }}
                          disabled={isReadOnly}
                        />
                      </div>
                    )}
                  </div>
                )}

                {hasError && <p className="error-hint">{validationErrors[q.id]}</p>}
              </div>
            )
          })}

          {/* 底部固定/悬浮提交栏（仅在开放收集中展示） */}
          {isOpen && (
            <div className="decision-bottom-bar">
              <div className="bottom-bar-inner">
                <div className="bottom-progress-info">
                  <span>
                    已回答 <strong>{answeredCount}</strong> / {form.questions.length} 题
                  </span>
                  <div className="progress-mini-bar">
                    <div
                      className="progress-mini-fill"
                      style={{
                        width: `${Math.min(
                          100,
                          (answeredCount / (form.questions.length || 1)) * 100,
                        )}%`,
                      }}
                    />
                  </div>
                </div>

                <div className="bottom-bar-actions">
                  <button
                    type="submit"
                    className="btn btn-primary btn-lg"
                    disabled={submitting}
                  >
                    {submitting ? '正在提交...' : '提交决策答卷'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </form>
      )}

      {/* 导出弹窗 */}
      <DecisionExportModal
        form={form}
        isOpen={isExportOpen}
        onClose={() => setIsExportOpen(false)}
      />
    </div>
  )
}
