// ============================================================
// 日期 / 展示工具
// ============================================================

/** 今天，YYYY-MM-DD（本地时区） */
export function todayISO(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** YYYY-MM-DD → 如 8/15 */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}`
}

/** YYYY-MM-DD → 如 8月15日 */
export function zhDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [, m, d] = iso.split('-')
  return `${Number(m)}月${Number(d)}日`
}

/** ISO 时间 → 如 8/16 14:30 */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const m = d.getMonth() + 1
  const day = d.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${m}/${day} ${hh}:${mm}`
}

/** 今天 / 昨天 / 具体日期 */
export function relativeDay(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = todayISO()
  if (iso === t) return '今天'
  const y = new Date()
  y.setDate(y.getDate() - 1)
  const yISO = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
  if (iso === yISO) return '昨天'
  return shortDate(iso)
}
