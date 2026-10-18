import { randomUUID } from 'node:crypto'

const MAX_PENDING = 64
const MAX_COMPLETED = 4096
const MAX_EVENTS = 256
const REQUEST_TIMEOUT_MS = 60_000
const CLOSE_TIMEOUT_MS = 1_000
const OPERATIONS = new Set(['create', 'load', 'permission', 'prompt'])

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}
function identifier(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new Error(`${label} is invalid`)
  return value
}
function optionalId(value, label) { return value === undefined ? undefined : identifier(value, label) }
function requestPayload(value) {
  const input = record(value, 'engine request payload')
  if (!OPERATIONS.has(input.operation)) throw new Error('engine request operation is invalid')
  record(input.input, 'engine request input')
  return input
}
function responsePayload(value) {
  const input = record(value, 'engine response payload')
  if (!OPERATIONS.has(input.operation)) throw new Error('engine response operation is invalid')
  if (input.ok !== true && input.ok !== false) throw new Error('engine response outcome is invalid')
  if (input.ok === false && typeof input.error !== 'string') throw new Error('engine response error is invalid')
  return input
}
function same(left, right) { return left === right }
function timeout(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })])
    .finally(() => clearTimeout(timer))
}

/** Correlated, bounded engine RPC over one validated typed pipe. */
export function createEngineRpcPeer({ pipe, handlers = {}, onEvent = () => {} }) {
  const outgoing = new Map(); const incoming = new Map(); const completed = new Set()
  const controls = new Set()
  let accepting = true; let incomingTotal = 0; let eventCount = 0; let eventTail = Promise.resolve()

  function request(operation, input, options = {}) {
    if (!accepting) return Promise.reject(new Error('engine RPC peer is closed'))
    if (!OPERATIONS.has(operation)) return Promise.reject(new Error('engine request operation is invalid'))
    let body; let handleId; let promptId
    try {
      body = record(input, 'engine request input'); handleId = optionalId(options.handleId, 'handleId'); promptId = optionalId(options.promptId, 'promptId')
      options.signal?.throwIfAborted()
    } catch (error) { return Promise.reject(error) }
    if (outgoing.size >= MAX_PENDING) return Promise.reject(new Error('engine RPC outgoing limit reached'))
    const requestId = randomUUID(); const result = Promise.withResolvers()
    const cancelRemote = () => {
      if (promptId !== undefined && handleId !== undefined) void pipe.send({ channel: 'engine', type: 'cancel', handleId, promptId }, { priority: true }).catch(() => {})
      else if (handleId !== undefined) void pipe.send({ channel: 'engine', type: 'dispose', handleId }, { priority: true }).catch(() => {})
    }
    const abort = () => { cancelRemote(); settleOutgoing(requestId, options.signal?.reason ?? new Error(`engine ${operation} request cancelled`)) }
    const expire = () => { cancelRemote(); settleOutgoing(requestId, new Error(`engine ${operation} request timed out`)) }
    const timer = setTimeout(expire, REQUEST_TIMEOUT_MS)
    options.signal?.addEventListener('abort', abort, { once: true })
    outgoing.set(requestId, { abort, operation, result, timer, signal: options.signal, handleId, promptId })
    void pipe.send({ channel: 'engine', type: 'request', requestId,
      ...handleId === undefined ? {} : { handleId }, ...promptId === undefined ? {} : { promptId },
      payload: { operation, input: body } }, { priority: operation === 'permission' }).catch(error => settleOutgoing(requestId, error))
    return result.promise
  }

  function settleOutgoing(requestId, error, value) {
    const pending = outgoing.get(requestId)
    if (pending === undefined) return
    outgoing.delete(requestId); clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.abort)
    if (error === undefined) pending.result.resolve(value)
    else pending.result.reject(error)
  }

  function onFrame(frame) {
    if (frame.channel !== 'engine') return false
    if (!accepting) throw new Error('engine RPC frame arrived after close')
    if (frame.type === 'response') {
      const payload = responsePayload(frame.payload); const pending = outgoing.get(frame.requestId)
      if (pending === undefined) throw new Error('engine response has no pending request')
      if (!same(frame.handleId, pending.handleId) || !same(frame.promptId, pending.promptId) || payload.operation !== pending.operation) throw new Error('engine response correlation mismatch')
      if (payload.ok) settleOutgoing(frame.requestId, undefined, payload.value)
      else settleOutgoing(frame.requestId, new Error(payload.error))
      return true
    }
    if (frame.type === 'event') {
      if (eventCount >= MAX_EVENTS) throw new Error('engine RPC event queue limit reached')
      eventCount += 1
      eventTail = eventTail.then(() => onEvent(frame)).finally(() => { eventCount -= 1 })
      eventTail.catch(error => { void close(error) })
      return true
    }
    if (frame.type === 'cancel') {
      const promptId = identifier(frame.promptId, 'promptId')
      for (const active of incoming.values()) if (active.promptId === promptId && active.handleId === frame.handleId) active.controller.abort(new Error('engine prompt cancelled'))
      trackControl(Promise.resolve(handlers.cancel?.({ handleId: frame.handleId, promptId })))
      return true
    }
    if (frame.type === 'dispose') {
      const handleId = identifier(frame.handleId, 'handleId')
      for (const active of incoming.values()) if (active.handleId === handleId) active.controller.abort(new Error('engine handle disposed'))
      trackControl(Promise.resolve(handlers.dispose?.({ handleId })))
      return true
    }
    if (frame.type !== 'request') throw new Error('engine RPC frame type is invalid')
    if (incomingTotal >= MAX_COMPLETED || incoming.size >= MAX_PENDING || incoming.has(frame.requestId) || completed.has(frame.requestId)) throw new Error('engine RPC incoming request rejected')
    const payload = requestPayload(frame.payload); const handler = handlers[payload.operation]
    if (typeof handler !== 'function') throw new Error(`engine RPC operation is unavailable: ${payload.operation}`)
    const controller = new AbortController(); const active = { controller, handleId: frame.handleId, promptId: frame.promptId }
    const done = Promise.resolve().then(() => handler(payload.input, { signal: controller.signal, requestId: frame.requestId, handleId: frame.handleId, promptId: frame.promptId }))
      .then(value => sendResponse(frame, { operation: payload.operation, ok: true, value }), error => sendResponse(frame, { operation: payload.operation, ok: false, error: error instanceof Error ? error.message : String(error) }))
      .catch(error => { if (accepting) void close(error) })
      .finally(() => { incoming.delete(frame.requestId); completed.add(frame.requestId); incomingTotal += 1 })
    active.done = done; incoming.set(frame.requestId, active)
    return true
  }

  function sendResponse(frame, payload) {
    if (!accepting) return
    return pipe.send({ channel: 'engine', type: 'response', requestId: frame.requestId,
      ...frame.handleId === undefined ? {} : { handleId: frame.handleId }, ...frame.promptId === undefined ? {} : { promptId: frame.promptId }, payload }, { priority: payload.ok === false })
  }
  function trackControl(task) {
    if (controls.size >= MAX_PENDING) throw new Error('engine RPC control task limit reached')
    controls.add(task)
    task.catch(error => { if (accepting) void close(error) }).finally(() => controls.delete(task))
  }
  function cancel(handleId, promptId) { return pipe.send({ channel: 'engine', type: 'cancel', handleId: identifier(handleId, 'handleId'), promptId: identifier(promptId, 'promptId') }, { priority: true }) }
  function dispose(handleId) { return pipe.send({ channel: 'engine', type: 'dispose', handleId: identifier(handleId, 'handleId') }, { priority: true }) }
  function event(type, payload, ids = {}) { return pipe.send({ channel: 'engine', type: 'event', payload: { type: identifier(type, 'event type'), value: payload }, ...ids }, { priority: type === 'permission' }) }

  async function close(reason = new Error('engine RPC peer closed')) {
    if (!accepting) return
    accepting = false
    for (const pending of [...outgoing.keys()]) settleOutgoing(pending, reason)
    const drains = [...incoming.values()].map(active => { active.controller.abort(reason); return active.done })
    await Promise.allSettled([timeout(Promise.allSettled(drains), CLOSE_TIMEOUT_MS, 'engine RPC handler drain'),
      timeout(Promise.allSettled([...controls]), CLOSE_TIMEOUT_MS, 'engine RPC control drain'), timeout(eventTail, CLOSE_TIMEOUT_MS, 'engine RPC event drain')])
    incoming.clear(); controls.clear(); eventCount = 0
  }

  return Object.freeze({ cancel, close, dispose, event, onFrame, request,
    stats: () => Object.freeze({ completed: completed.size, controls: controls.size, events: eventCount, incoming: incoming.size, outgoing: outgoing.size }) })
}
