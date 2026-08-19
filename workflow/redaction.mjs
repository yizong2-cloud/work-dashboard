// Redact credentials before source material enters a Workboard snapshot.
// The original source export remains untouched; this only protects derived artifacts.

export function redactSensitiveText(text) {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(?:sk|rk|ghp|gho|xox[baprs])-[-A-Za-z0-9_]{16,}\b/g, '[REDACTED_TOKEN]')
}

export function redactSensitiveValue(value) {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (Array.isArray(value)) return value.map(redactSensitiveValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactSensitiveValue(child)]))
  }
  return value
}
