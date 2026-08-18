import type { DecisionFormDetail } from '../types'
import { DecisionExportContent } from './DecisionExportContent'
import { X } from 'lucide-react'

interface DecisionExportModalProps {
  form: DecisionFormDetail
  isOpen: boolean
  onClose: () => void
}

export function DecisionExportModal({ form, isOpen, onClose }: DecisionExportModalProps) {
  if (!isOpen) return null

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="modal modal-decision-export"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h3 className="modal-title">导出答卷给 Agent</h3>
            <p className="modal-subtitle">
              生成可直接供执行 Agent 引用的 Markdown 决策结论或结构化 JSON
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={20} />
          </button>
        </div>

        <DecisionExportContent form={form} />
      </div>
    </div>
  )
}
