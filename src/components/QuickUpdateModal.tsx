import { useEffect, useState } from 'react'
import type { Task, TaskStatus, UpdateType } from '../types'
import type { TaskService } from '../lib/taskService'

export type QuickUpdateMode = 'note' | 'progress' | 'schedule' | 'block' | 'complete' | 'status'

interface QuickUpdateModalProps {
  task: Task
  service: TaskService
  onClose: () => void
  onDone: (message: string) => void
  /** Used by an intentional deep link such as “补日期”; defaults to progress note. */
  initialMode?: QuickUpdateMode
}

export function QuickUpdateModal({ task, service, onClose, onDone, initialMode = 'note' }: QuickUpdateModalProps) {
  const [mode, setMode] = useState<QuickUpdateMode>(initialMode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 表单状态
  const [noteType, setNoteType] = useState<UpdateType>('progress')
  const [noteContent, setNoteContent] = useState('')
  const [progress, setProgress] = useState(task.progress)
  const [progressNote, setProgressNote] = useState('')
  const [newDate, setNewDate] = useState(task.expected_end_date ?? '')
  const [scheduleNote, setScheduleNote] = useState('')
  const [blockReason, setBlockReason] = useState(task.block_reason)
  const [completeNote, setCompleteNote] = useState('')
  const [status, setStatus] = useState<TaskStatus>(task.status)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit() {
    setBusy(true)
    setError('')
    try {
      switch (mode) {
        case 'note':
          if (!noteContent.trim()) throw new Error('请填写内容')
          await service.addNote(task.id, noteType, noteContent)
          onDone('进展已记录')
          break
        case 'progress':
          if (progress === task.progress && !progressNote.trim()) {
            // 仅填说明也允许
          }
          await service.setProgress(task.id, progress, progressNote || undefined)
          onDone('进度已更新')
          break
        case 'schedule':
          if (!newDate) throw new Error('请选择预计完成日期')
          await service.setSchedule(task.id, newDate, scheduleNote || undefined)
          onDone('排期已调整')
          break
        case 'block':
          if (blocked) {
            await service.setUnblocked(task.id, blockReason || undefined)
            onDone('已解除阻塞')
          } else {
            await service.setBlocked(task.id, blockReason)
            onDone('已标记阻塞')
          }
          break
        case 'complete':
          await service.completeTask(task.id, completeNote || undefined)
          onDone('任务已完成')
          break
        case 'status':
          await service.setStatus(task.id, status, `状态变更为 ${status}`)
          onDone('状态已更新')
          break
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const blocked = task.status === 'blocked'
  const modes: { key: QuickUpdateMode; label: string }[] = [
    { key: 'note', label: '添加进展' },
    { key: 'progress', label: '修改进度' },
    { key: 'schedule', label: '调整排期' },
    { key: 'block', label: blocked ? '解除阻塞' : '标记阻塞' },
    { key: 'complete', label: '标记完成' },
    { key: 'status', label: '改状态' },
  ]

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>更新：{task.title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="modal-tabs">
          {modes.map((m) => (
            <button
              key={m.key}
              className={`tab ${mode === m.key ? 'tab-active' : ''}`}
              onClick={() => {
                setMode(m.key)
                setError('')
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {mode === 'note' && (
            <>
              <label className="field">
                <span>类型</span>
                <select value={noteType} onChange={(e) => setNoteType(e.target.value as UpdateType)}>
                  <option value="progress">进展</option>
                  <option value="interrupt">临时插入</option>
                  <option value="note">说明</option>
                </select>
              </label>
              <label className="field">
                <span>内容（今天做了什么 / 发生了什么）</span>
                <textarea
                  rows={3}
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  placeholder="例如：完成主题解锁逻辑，准备联调接口…"
                />
              </label>
            </>
          )}

          {mode === 'progress' && (
            <>
              <label className="field">
                <span>进度：{progress}%</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={progress}
                  onChange={(e) => setProgress(Number(e.target.value))}
                />
              </label>
              <label className="field">
                <span>说明（可选，会记入时间线）</span>
                <textarea
                  rows={2}
                  value={progressNote}
                  onChange={(e) => setProgressNote(e.target.value)}
                  placeholder="例如：完成 XX 模块…"
                />
              </label>
            </>
          )}

          {mode === 'schedule' && (
            <>
              <label className="field">
                <span>预计完成日期（原为 {task.expected_end_date || '—'}）</span>
                <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
              </label>
              <label className="field">
                <span>调整原因（会记入时间线）</span>
                <textarea
                  rows={2}
                  value={scheduleNote}
                  onChange={(e) => setScheduleNote(e.target.value)}
                  placeholder="例如：接口方案调整，需要增加联调时间…"
                />
              </label>
            </>
          )}

          {mode === 'block' &&
            (blocked ? (
              <>
                <p>当前阻塞原因：{task.block_reason}</p>
                <label className="field">
                  <span>解除说明（可选）</span>
                  <textarea rows={2} value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="例如：依赖已就绪，恢复开发…" />
                </label>
              </>
            ) : (
              <label className="field">
                <span>阻塞原因（必填）</span>
                <textarea rows={3} value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="例如：等待美术资源 / 依赖方接口未就绪…" />
              </label>
            ))}

          {mode === 'complete' && (
            <label className="field">
              <span>完成说明（可选）</span>
              <textarea rows={2} value={completeNote} onChange={(e) => setCompleteNote(e.target.value)} placeholder="例如：已上线，观察无异常…" />
            </label>
          )}

          {mode === 'status' && (
            <label className="field">
              <span>状态</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                <option value="planned">待开始</option>
                <option value="in_progress">进行中</option>
                <option value="blocked">阻塞</option>
                <option value="paused">暂停</option>
                <option value="completed">已完成</option>
                <option value="cancelled">已取消</option>
              </select>
            </label>
          )}

          {error && <p className="form-error">{error}</p>}
        </div>

        <div className="modal-foot">
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
