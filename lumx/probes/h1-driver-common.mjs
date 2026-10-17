/** Shared probe result and deadline helpers. */

export function errorRecord(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    ...error !== null && typeof error === 'object' && 'code' in error ? { code: error.code } : {},
    ...error !== null && typeof error === 'object' && 'data' in error ? { data: error.data } : {},
  }
}

export function subcheck(id, passed, observed, reason) {
  return { id, status: passed ? 'pass' : 'fail', observed, ...passed ? {} : { reason } }
}

export function unit(id, subchecks, reason) {
  const status = subchecks.every(row => row.status === 'pass') ? 'pass' : 'fail'
  return {
    id,
    status,
    reason: status === 'pass' ? 'all dynamic subchecks passed' : reason,
    subchecks,
  }
}

export async function withDeadline(label, operation, timeoutMs = 60_000) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
