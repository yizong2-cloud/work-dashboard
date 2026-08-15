import { useState } from 'react'
import type { TaskPriority, TaskStatus } from '../types'
import type { TaskService } from '../lib/taskService'
import { todayISO } from '../lib/format'

interface CreateTaskModalProps {
  service: TaskService
  onClose: () => void
  onDone: (message: string) => void
}

const empty = {
  title: '',
  description: '',
  status: 'planned' as TaskStatus,
  priority: 'normal' as TaskPriority,
  progress: 0,
  start_date: todayISO(),
  expected_end_date: '',
  interrupt: false,
}

export function CreateTaskModal({ service, onClose, onDone }: CreateTaskModalProps) {
  const [form, setForm] = useState(empty)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function set<K extends keyof typeof empty>(key: K, value: (typeof empty)[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function submit() {
    if (!form.title.trim()) {
      setError('请填写任务名称')
      return
    }
    setBusy(true)
    setError('')
    try {
      await service.createTask({
        title: form.title.trim(),
        description: form.description.trim(),
        status: form.status,
        priority: form.priority,
        progress: form.progress,
        start_date: form.start_date || null,
        expected_end_date: form.expected_end_date || null,
        is_interrupt_task: form.interrupt,
      })
      onDone('任务已创建')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>新建任务</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span>任务名称 *</span>
            <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="例如：宁静拼图主题系统" />
          </label>
          <label className="field">
            <span>描述</span>
            <textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
          </label>
          <div className="field-row">
            <label className="field">
              <span>状态</span>
              <select value={form.status} onChange={(e) => set('status', e.target.value as TaskStatus)}>
                <option value="planned">待开始</option>
                <option value="in_progress">进行中</option>
                <option value="paused">暂停</option>
              </select>
            </label>
            <label className="field">
              <span>优先级</span>
              <select value={form.priority} onChange={(e) => set('priority', e.target.value as TaskPriority)}>
                <option value="high">高</option>
                <option value="normal">普通</option>
                <option value="low">低</option>
              </select>
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>开始日期</span>
              <input type="date" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} />
            </label>
            <label className="field">
              <span>预计完成</span>
              <input type="date" value={form.expected_end_date} onChange={(e) => set('expected_end_date', e.target.value)} />
            </label>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={form.interrupt} onChange={(e) => set('interrupt', e.target.checked)} />
            <span>这是临时插入任务</span>
          </label>
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
