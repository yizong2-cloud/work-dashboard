export function buildExecutionPlan(ops, previous, fingerprint) {
  const completed = new Set()
  if (previous?.all_ok === false && previous?.fingerprint === fingerprint) {
    for (const result of previous.operation_results || []) {
      if (result?.ok === true && Number.isInteger(result.index)) completed.add(result.index)
    }
  }
  return (ops || [])
    .map((op, index) => ({ index, op }))
    .filter((entry) => !completed.has(entry.index))
}

export function mergeOperationResults(ops, previous, executionPlan, attemptResults) {
  const previousByIndex = new Map(
    (previous?.operation_results || [])
      .filter((result) => Number.isInteger(result?.index))
      .map((result) => [result.index, result]),
  )
  const attemptedByIndex = new Map(executionPlan.map((entry, offset) => [entry.index, attemptResults[offset]]))
  return (ops || []).map((op, index) => {
    const before = previousByIndex.get(index)
    const result = attemptedByIndex.get(index)
    if (!result) {
      return before || {
        index, op: op.op, target: op.id || op.title || null,
        ok: null, status: 'pending', attempts: 0,
      }
    }
    return {
      index,
      op: op.op,
      target: op.id || op.title || null,
      ok: result.ok === true,
      status: result.ok === true ? 'succeeded' : 'failed',
      result_id: result.id || before?.result_id || null,
      message: result.ok === true ? null : String(result.message || '未知执行失败'),
      attempts: Number(before?.attempts || 0) + 1,
    }
  })
}
