import { randomUUID } from 'node:crypto'

const ADMISSION_TIMEOUT_MS = 10_000
const MAX_COMPLETED = 4096
const MAX_PENDING = 64
const DENIAL_CODES = new Set(['identity_expired', 'identity_rejected', 'identity_required'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

function exact(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...fields].sort().join(',')
}
function requestId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('BYOK admission request identity is invalid')
  return value
}
function noRoutingOperands(frame) {
  if (frame.handleId !== undefined || frame.promptId !== undefined) throw new Error('BYOK admission frame carries forbidden routing operands')
}
function localError(code) {
  const messages = {
    admission_cancelled: 'LUMX BYOK admission cancelled',
    admission_closed: 'LUMX BYOK admission peer is closed',
    admission_timeout: 'LUMX BYOK admission timed out',
    admission_unavailable: 'LUMX BYOK admission transport is unavailable',
  }
  const error = new Error(messages[code] ?? messages.admission_unavailable)
  error.code = code
  return error
}
function denial(code) {
  if (!DENIAL_CODES.has(code)) throw new Error('BYOK admission denial code is invalid')
  const error = new Error(`LUMX BYOK admission denied: ${code}`)
  error.name = 'LumxByokAdmissionError'; error.code = code
  return error
}

/** Host-side, bounded client for fresh supervisor-owned BYOK admission. */
export function createByokAdmissionClient({ pipe }) {
  const pending = new Map(); const tombstones = new Set(); const cancellationWrites = new Set()
  let accepting = true; let closing

  function sendCancel(id) {
    const task = pipe.send({ channel: 'admission', type: 'cancel', requestId: id, payload: {} }, { priority: true })
    cancellationWrites.add(task); void task.catch(() => {}).finally(() => cancellationWrites.delete(task))
  }
  function settle(id, error) {
    const active = pending.get(id)
    if (active === undefined) return false
    pending.delete(id); clearTimeout(active.timer); active.signal?.removeEventListener('abort', active.abort)
    if (error === undefined) active.result.resolve()
    else active.result.reject(error)
    return true
  }
  function abandon(id, error) {
    if (!settle(id, error)) return
    tombstones.add(id); sendCancel(id)
  }
  function admitOtherProvider({ signal } = {}) {
    if (!accepting) return Promise.reject(localError('admission_closed'))
    if (signal?.aborted) return Promise.reject(signal.reason ?? localError('admission_cancelled'))
    if (pending.size >= MAX_PENDING || tombstones.size >= MAX_COMPLETED) return Promise.reject(localError('admission_unavailable'))
    const id = randomUUID(); const result = Promise.withResolvers()
    const abort = () => abandon(id, signal?.reason ?? localError('admission_cancelled'))
    const timer = setTimeout(() => abandon(id, localError('admission_timeout')), ADMISSION_TIMEOUT_MS)
    pending.set(id, { abort, result, signal, timer }); signal?.addEventListener('abort', abort, { once: true })
    void pipe.send({ channel: 'admission', type: 'request', requestId: id, payload: {} }, { priority: true })
      .catch(() => { settle(id, localError('admission_unavailable')) })
    return result.promise
  }
  function onFrame(frame) {
    if (frame.channel !== 'admission') return false
    if (frame.type !== 'response') throw new Error('Host admission peer received an unsupported frame')
    noRoutingOperands(frame)
    const id = requestId(frame.requestId)
    if (tombstones.delete(id)) return true
    if (!pending.has(id)) throw new Error('Host admission response has no pending request')
    if (exact(frame.payload, ['ok']) && frame.payload.ok === true) settle(id)
    else if (exact(frame.payload, ['code', 'ok']) && frame.payload.ok === false) settle(id, denial(frame.payload.code))
    else throw new Error('Host admission response payload is invalid')
    return true
  }
  function seal(reason = localError('admission_closed')) {
    if (!accepting) return
    accepting = false
    for (const id of [...pending.keys()]) abandon(id, reason)
  }
  function close(reason) {
    seal(reason)
    return (closing ??= (async () => { await Promise.allSettled([...cancellationWrites]); tombstones.clear() })())
  }
  return Object.freeze({ admitOtherProvider, close, onFrame, seal,
    stats: () => Object.freeze({ accepting, pending: pending.size, tombstones: tombstones.size, cancellationWrites: cancellationWrites.size }) })
}

/** Supervisor-side peer; identity and gateway remain inside the supplied fixed callback. */
export function createByokAdmissionServer({ pipe, admitOtherProvider, onFailure = () => {} }) {
  const pending = new Map(); const completed = new Set()
  let accepting = true; let closing

  function fail(error) {
    const safe = error instanceof Error ? error : localError('admission_unavailable')
    try { onFailure(safe) } catch {}
  }
  function track(id) {
    const controller = new AbortController()
    const source = Promise.resolve().then(async () => {
      if (!accepting || controller.signal.aborted) throw controller.signal.reason ?? localError('admission_closed')
      if (typeof admitOtherProvider !== 'function') throw localError('admission_unavailable')
      await admitOtherProvider({ signal: controller.signal })
    })
    source.catch(() => {})
    const task = Promise.resolve().then(async () => {
      let abort; let timer
      const stopped = new Promise((_, reject) => {
        abort = () => reject(controller.signal.reason ?? localError('admission_cancelled'))
        if (controller.signal.aborted) abort()
        else controller.signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => controller.abort(localError('admission_timeout')), ADMISSION_TIMEOUT_MS)
      })
      try { await Promise.race([source, stopped]) }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort) }
      controller.signal.throwIfAborted()
      if (!accepting) throw localError('admission_closed')
      await pipe.send({ channel: 'admission', type: 'response', requestId: id, payload: { ok: true } }, { priority: true })
    }).catch(async error => {
      if (controller.signal.aborted || !accepting) return
      if (!DENIAL_CODES.has(error?.code)) throw localError('admission_unavailable')
      await pipe.send({ channel: 'admission', type: 'response', requestId: id, payload: { ok: false, code: error.code } }, { priority: true })
    }).catch(fail).finally(() => {
      pending.delete(id); completed.add(id)
    })
    pending.set(id, { controller, task })
  }
  function onFrame(frame) {
    if (frame.channel !== 'admission') return false
    noRoutingOperands(frame)
    const id = requestId(frame.requestId)
    if (!exact(frame.payload, [])) throw new Error('Supervisor admission request payload is invalid')
    if (frame.type === 'request') {
      if (!accepting) throw new Error('Supervisor admission peer is closed')
      if (pending.has(id) || completed.has(id)) throw new Error('Supervisor admission request is duplicated')
      if (pending.size >= MAX_PENDING || completed.size >= MAX_COMPLETED) throw new Error('Supervisor admission peer capacity exceeded')
      track(id); return true
    }
    if (frame.type === 'cancel') {
      const active = pending.get(id)
      if (active !== undefined) active.controller.abort(localError('admission_cancelled'))
      else if (!completed.has(id)) throw new Error('Supervisor admission cancellation is unknown')
      return true
    }
    throw new Error('Supervisor admission peer received an unsupported frame')
  }
  function seal(reason = localError('admission_closed')) {
    if (!accepting) return
    accepting = false
    for (const active of pending.values()) active.controller.abort(reason)
  }
  function close(reason) {
    seal(reason)
    return (closing ??= (async () => {
      await Promise.allSettled([...pending.values()].map(active => active.task))
      pending.clear(); completed.clear()
    })())
  }
  return Object.freeze({ close, onFrame, seal,
    stats: () => Object.freeze({ accepting, completed: completed.size, pending: pending.size }) })
}
