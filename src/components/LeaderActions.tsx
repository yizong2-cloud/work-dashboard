import { useState } from 'react'
import type { Task } from '../types'
import type { TaskService } from '../lib/taskService'
import { todayISO } from '../lib/format'

// ============================================================
// LeaderActions —— 协作操作区（Leader 专属操作，免登录谁都能点）
// 加急 / 取消加急 / 催进度 / 调整排期
// 所有操作：写入任务时间线 + 触发飞书通知，全程留痕。
// ============================================================

type ActionKind = 'urgent' | 'deurgent' | 'nudge' | 'schedule' | null

const ACTION_META: Record<Exclude<ActionKind, null>, { title: string; noteLabel: string; confirm: string; done: string }> = {
  urgent: { title: '标记为加急', noteLabel: '为什么加急？（可选，会同步给负责人）', confirm: '确认加急', done: '已标记为加急，负责人会收到飞书提醒' },
  deurgent: { title: '取消加急', noteLabel: '取消原因？（可选）', confirm: '确认取消加急', done: '已取消加急' },
  nudge: { title: '提醒负责人更新进度', noteLabel: '想提醒什么？（可选）', confirm: '发送提醒', done: '已发送进度提醒，负责人会收到飞书通知' },
  schedule: { title: '调整预计完成日期', noteLabel: '调整原因？（可选，留痕用）', confirm: '确认调整', done: '已调整预计完成日期' },
}

export function LeaderActions({ task, service, onNotify }: {
  task: Task
  service: TaskService
  onNotify: (message: string) => void
}) {
  const [action, setAction] = useState<ActionKind>(null)
  const [note, setNote] = useState('')
  const [date, setDate] = useState(task.expected_end_date ?? todayISO())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isUrgent = task.priority === 'urgent'
  const terminal = task.status === 'completed' || task.status === 'cancelled'
  if (terminal) return null

  function open(kind: Exclude<ActionKind, null>) {
    setAction(kind)
    setNote('')
    setError('')
    if (kind === 'schedule') setDate(task.expected_end_date ?? todayISO())
  }

  async function submit() {
    if (!action || busy) return
    setBusy(true)
    setError('')
    try {
      const trimmed = note.trim()
      if (action === 'urgent') await service.setUrgent(task.id, true, trimmed || undefined, 'Leader')
      else if (action === 'deurgent') await service.setUrgent(task.id, false, trimmed || undefined, 'Leader')
      else if (action === 'nudge') await service.nudge(task.id, trimmed || undefined, 'Leader')
      else if (action === 'schedule') {
        if (!date) throw new Error('请选择日期')
        await service.setSchedule(task.id, date, trimmed || undefined, 'Leader')
      }
      onNotify(ACTION_META[action].done)
      setAction(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const meta = action ? ACTION_META[action] : null

  return (
    <section className="leader-actions card">
      <div className="panel-heading">
        <div><span className="eyebrow">Leader actions</span><h2>协作操作</h2></div>
      </div>
      <p className="section-intro">Leader 可直接操作：加急、催进度、调整排期，全部会通知负责人并留痕。</p>
      <div className="leader-actions-row">
        {isUrgent ? (
          <button className="btn btn-danger btn-sm" onClick={() => open('deurgent')}>取消加急</button>
        ) : (
          <button className="btn btn-danger btn-sm" onClick={() => open('urgent')}>🔥 加急</button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={() => open('nudge')}>⏰ 催进度</button>
        <button className="btn btn-ghost btn-sm" onClick={() => open('schedule')}>📅 调整排期</button>
      </div>

      {action && meta && (
        <div className="modal-mask" onClick={() => !busy && setAction(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>{meta.title}</h3></div>
            <div className="modal-body">
              {action === 'schedule' && (
                <label className="field">
                  <span>预计完成日期</span>
                  <input type="date" value={date} min={todayISO()} onChange={(e) => setDate(e.target.value)} />
                </label>
              )}
              <label className="field">
                <span>{meta.noteLabel}</span>
                <textarea rows={3} value={note} placeholder={action === 'nudge' ? '例如：这个周五前能完成吗？' : ''} onChange={(e) => setNote(e.target.value)} />
              </label>
              {error && <p className="banner banner-error">{error}</p>}
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setAction(null)}>取消</button>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>{meta.confirm}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
