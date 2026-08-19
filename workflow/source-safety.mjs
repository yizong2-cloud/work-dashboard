// Small pure decisions used by prepare so source failure semantics are testable.

export function feishuFailureDetail({ stderr = '', code = null, timed_out = false, incomplete = false } = {}, cookiesPath) {
  const text = String(stderr || '').replace(/\s+/g, ' ').trim()
  if (incomplete) {
    return '飞书导出出现会话打开/读取失败，本次不使用部分结果；请检查 Cookies 与飞书页面状态后重试'
  }
  if (/页面已完成加载.*会话列表没有出现|会话列表没有出现/i.test(text)) {
    return '飞书页面已加载但会话列表未出现；可能是登录态未被浏览器接受、租户页面未初始化或前端资源被拦截。请用 --no-headless 观察后重试'
  }
  if (/本次导出未完成|会话读取失败/i.test(text)) {
    return '飞书导出包含未完成会话，本次不使用部分结果且不推进游标；可提高 FEISHU_CHAT_TIMEOUT_MS 或用 --limit-chats 定位异常会话'
  }
  if (/连续 \d+ 个会话无法打开/i.test(text)) {
    return '飞书会话切换连续失败，本次不使用部分结果且不推进游标；可重试导出，或用 --limit-chats 缩小范围定位异常会话'
  }
  if (/未能进入飞书|登录态|cookies?/i.test(text)) {
    return `飞书登录态可能已失效，请重新导出浏览器 Cookies 到 ${cookiesPath}`
  }
  if (timed_out || code === 'ETIMEDOUT') {
    return '飞书导出超时，本次不使用旧数据；可刷新 Cookies 后重试，或适当提高 WORKBOARD_FEISHU_TIMEOUT_MS'
  }
  return text ? `飞书导出失败：${text.slice(0, 180)}` : '飞书导出失败；本次不使用旧数据'
}

// The external exporter can exit 0 after skipping individual chats. Treat
// those partial results as a failed source; a partial chat export must not
// silently become a complete-looking dashboard snapshot.
export function feishuOutputIncomplete(output) {
  return String(output || '').split('\n').some((line) =>
    /^\s*\[\d+\/\d+\].*(?:跳过\([^)]*\)|出错\b)/.test(line),
  )
}

export function feishuSnapshot({ ok, file = null, content = '' }) {
  if (!ok) return { file: null, content: '（飞书采集失败；本次不使用旧导出内容）' }
  if (!file) return { file: null, content: '（本次无飞书增量）' }
  return { file, content: content || '（飞书增量文件为空）' }
}
