// Small pure decisions used by prepare so source failure semantics are testable.

export function feishuSnapshot({ ok, file = null, content = '' }) {
  if (!ok) return { file: null, content: '（飞书采集失败；本次不使用旧导出内容）' }
  if (!file) return { file: null, content: '（本次无飞书增量）' }
  return { file, content: content || '（飞书增量文件为空）' }
}
