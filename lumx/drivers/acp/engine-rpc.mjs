import { randomUUID } from 'node:crypto'

const MAX_PENDING = 64
const REQUEST_TIMEOUT_MS = 60_000
const OPERATIONS = new Set(['create', 'load', 'permission', 'prompt'])

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}
function identifier(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new Error(`${label} is invalid`)
  return value
}
function requestPayload(value) {
  const input = record(value, 'engine request payload')
  if (!OPERATIONS.has(input.operation)) throw new Error('engine request operation is invalid')
  record(input.input, 'engine request input')
  return input
}
function responsePayload(value) {
  const input = record(value, 'engine response payload')
  if (input.ok !== true && input.ok !== false) throw new Error('engine response outcome is invalid')
  if (input.ok === false && typeof input.error !== 'string') throw new Error('engine response error is invalid')
  return input
}

/** Correlated, bounded engine RPC over one validated typed pipe. */
export function createEngineRpcPeer({ pipe, handlers = {}, onEvent = () => {} }) {
  const outgoing = new Map()
  const incoming = new Map()
  let accepting = true

  function request(operation, input, options = {}) {
    if (!accepting) return Promise.reject(new Error('engine RPC peer is closed'))
    if (!OPERATIONS.has(operation)) return Promise.reject(new Error('engine request operation is invalid'))
    if (outgoing.size >= MAX_PENDING) return Promise.reject(new Error('engine RPC outgoing limit reached'))
    const requestId = randomUUID()
    const result = Promise.withResolvers()
    const timeout = setTimeout(() => settleOutgoing(requestId, new Error(`engine ${operation} request timed out`)), REQUEST_TIMEOUT_MS)
    const abort = () => settleOutgoing(requestId, options.signal?.reason ?? new Error(`engine ${operation} request cancelled`))
    options.signal?.addEventListener('abort', abort, { once: true })
    outgoing.set(requestId, { abort, result, timeout, signal: options.signal })
    const frame = { channel: 'engine', type: 'request', requestId,
      ...options.handleId === undefined ? {} : { handleId: identifier(options.handleId, 'handleId') },
      ...options.promptId === undefined ? {} : { promptId: identifier(options.promptId, 'promptId') },
      payload: { operation, input: record(input, 'engine request input') } }
    void pipe.send(frame, { priority: operation === 'permission' }).catch(error => settleOutgoing(requestId, error))
    if (options.signal?.aborted === true) abort()
    return result.promise
  }

  function settleOutgoing(requestId, error, value) {
    const pending = outgoing.get(requestId)
    if (pending === undefined) return
    outgoing.delete(requestId); clearTimeout(pending.timeout)
    pending.signal?.removeEventListener('abort', pending.abort)
    if (error === undefined) pending.result.resolve(value)
    else pending.result.reject(error)
  }

  function onFrame(frame) {
    if (frame.channel !== 'engine') return false
    if (frame.type === 'response') {
      const payload = responsePayload(frame.payload)
      if (!outgoing.has(frame.requestId)) throw new Error('engine response has no pending request')
      if (payload.ok) settleOutgoing(frame.requestId, undefined, payload.value)
      else settleOutgoing(frame.requestId, new Error(payload.error))
      return true
    }
    if (frame.type === 'event') {
      void Promise.resolve(onEvent(frame)).catch(error => { void close(error) })
      return true
    }
    if (frame.type === 'cancel') {
      const promptId = identifier(frame.promptId, 'promptId')
      for (const active of incoming.values()) if (active.promptId === promptId) active.controller.abort(new Error('engine prompt cancelled'))
      void Promise.resolve(handlers.cancel?.({ handleId: frame.handleId, promptId })).catch(error => { void close(error) })
      return true
    }
    if (frame.type === 'dispose') {
      const handleId = identifier(frame.handleId, 'handleId')
      for (const active of incoming.values()) if (active.handleId === handleId) active.controller.abort(new Error('engine handle disposed'))
      void Promise.resolve(handlers.dispose?.({ handleId })).catch(error => { void close(error) })
      return true
    }
    if (frame.type !== 'request') throw new Error('engine RPC frame type is invalid')
    if (!accepting || incoming.size >= MAX_PENDING || incoming.has(frame.requestId)) throw new Error('engine RPC incoming request rejected')
    const payload = requestPayload(frame.payload)
    const handler = handlers[payload.operation]
    if (typeof handler !== 'function') throw new Error(`engine RPC operation is unavailable: ${payload.operation}`)
    const controller = new AbortController()
    incoming.set(frame.requestId, { controller, handleId: frame.handleId, promptId: frame.promptId })
    void Promise.resolve().then(() => handler(payload.input, {
      signal: controller.signal, requestId: frame.requestId, handleId: frame.handleId, promptId: frame.promptId,
    })).then(
      value => pipe.send({ channel: 'engine', type: 'response', requestId: frame.requestId,
        ...frame.handleId === undefined ? {} : { handleId: frame.handleId }, ...frame.promptId === undefined ? {} : { promptId: frame.promptId },
        payload: { ok: true, value } }),
      error => pipe.send({ channel: 'engine', type: 'response', requestId: frame.requestId,
        ...frame.handleId === undefined ? {} : { handleId: frame.handleId }, ...frame.promptId === undefined ? {} : { promptId: frame.promptId },
        payload: { ok: false, error: error instanceof Error ? error.message : String(error) } }, { priority: true }),
    ).catch(error => { void close(error) }).finally(() => incoming.delete(frame.requestId))
    return true
  }

  function cancel(handleId, promptId) {
    return pipe.send({ channel: 'engine', type: 'cancel', handleId: identifier(handleId, 'handleId'), promptId: identifier(promptId, 'promptId') }, { priority: true })
  }
  function dispose(handleId) {
    return pipe.send({ channel: 'engine', type: 'dispose', handleId: identifier(handleId, 'handleId') }, { priority: true })
  }
  async function event(type, payload, ids = {}) {
    await pipe.send({ channel: 'engine', type: 'event', payload: { type: identifier(type, 'event type'), value: payload }, ...ids }, { priority: type === 'permission' })
  }
  async function close(reason = new Error('engine RPC peer closed')) {
    if (!accepting) return
    accepting = false
    for (const pending of outgoing.keys()) settleOutgoing(pending, reason)
    for (const active of incoming.values()) active.controller.abort(reason)
    await Promise.allSettled([...incoming.values()].map(active => active.done).filter(Boolean))
  }

  return Object.freeze({ cancel, close, dispose, event, onFrame, request,
    stats: () => Object.freeze({ incoming: incoming.size, outgoing: outgoing.size }) })
}
