import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createTypedPipe } from '../../desktop/typed-pipe.mjs'
import { createEngineRpcPeer } from './engine-rpc.mjs'

function peers(handlers) {
  const h2s = new PassThrough(); const s2h = new PassThrough()
  const hostRouter = { onFrame() {} }; const supervisorRouter = { onFrame() {} }
  const hostPipe = createTypedPipe({ readable: s2h, writable: h2s, incomingDirection: 'supervisor-to-host', outgoingDirection: 'host-to-supervisor', generation: 'engine-generation', onFrame: frame => hostRouter.onFrame(frame) })
  const supervisorPipe = createTypedPipe({ readable: h2s, writable: s2h, incomingDirection: 'host-to-supervisor', outgoingDirection: 'supervisor-to-host', generation: 'engine-generation', onFrame: frame => supervisorRouter.onFrame(frame) })
  const host = createEngineRpcPeer({ pipe: hostPipe, handlers: handlers.host })
  const supervisor = createEngineRpcPeer({ pipe: supervisorPipe, handlers: handlers.supervisor })
  hostRouter.onFrame = host.onFrame; supervisorRouter.onFrame = supervisor.onFrame
  return { host, supervisor, close: async () => { await Promise.allSettled([host.close(), supervisor.close(), hostPipe.close(), supervisorPipe.close()]) } }
}

function deferred() { return Promise.withResolvers() }
async function until(predicate) {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('condition did not settle')
}
function fakePipe() {
  const sent = []
  return { sent, send: async (frame, options) => { sent.push({ frame, options }) } }
}

test('a blocked prompt does not block permission roundtrip or cancellation', async t => {
  let supervisor
  let promptStartedResolve
  const promptStarted = new Promise(resolve => { promptStartedResolve = resolve })
  const p = peers({
    host: { permission: async input => ({ decision: input.tool === 'safe' ? 'allow-once' : 'reject' }) },
    supervisor: { prompt: async (_input, context) => {
      promptStartedResolve()
      const permission = await supervisor.request('permission', { tool: 'safe' }, { handleId: context.handleId, promptId: context.promptId })
      assert.deepEqual(permission, { decision: 'allow-once' })
      context.signal.throwIfAborted()
      await new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
      })
    }, cancel: () => {} },
  })
  supervisor = p.supervisor
  t.after(p.close)
  const pending = p.host.request('prompt', { text: 'wait' }, { handleId: 'handle-1', promptId: 'prompt-1' })
  await Promise.race([promptStarted, pending.then(
    () => { throw new Error('prompt settled before handler start') },
    error => { throw error },
  )])
  await p.host.cancel('handle-1', 'prompt-1')
  await assert.rejects(pending, /cancelled/)
  assert.deepEqual(p.host.stats(), { completed: 1, controls: 0, events: 0, incoming: 0, outgoing: 0 })
})

test('rejects unknown responses and bounds operation names', async t => {
  const p = peers({ host: {}, supervisor: { create: async () => ({ nativeSessionId: 'n1' }) } })
  t.after(p.close)
  assert.deepEqual(await p.host.request('create', {}), { nativeSessionId: 'n1' })
  await assert.rejects(p.host.request('unknown', {}), /operation is invalid/)
  assert.throws(() => p.host.onFrame({ channel: 'engine', type: 'response', requestId: 'missing', payload: { operation: 'create', ok: true } }), /no pending request/)
})

test('responses must match operation, handle, and prompt correlation', async () => {
  const pipe = fakePipe(); const peer = createEngineRpcPeer({ pipe })
  const pending = peer.request('prompt', { text: 'hello' }, { handleId: 'h1', promptId: 'p1' })
  await until(() => pipe.sent.length === 1)
  const requestId = pipe.sent[0].frame.requestId
  assert.throws(() => peer.onFrame({ channel: 'engine', type: 'response', requestId, handleId: 'wrong', promptId: 'p1',
    payload: { operation: 'prompt', ok: true, value: {} } }), /correlation mismatch/)
  assert.throws(() => peer.onFrame({ channel: 'engine', type: 'response', requestId, handleId: 'h1', promptId: 'p1',
    payload: { operation: 'create', ok: true, value: {} } }), /correlation mismatch/)
  peer.onFrame({ channel: 'engine', type: 'response', requestId, handleId: 'h1', promptId: 'p1',
    payload: { operation: 'prompt', ok: true, value: { stopReason: 'end_turn' } } })
  assert.deepEqual(await pending, { stopReason: 'end_turn' })
  await peer.close()
})

test('completed incoming request IDs cannot be replayed', async () => {
  const pipe = fakePipe(); const peer = createEngineRpcPeer({ pipe, handlers: { create: async () => ({ nativeSessionId: 'native-1' }) } })
  const frame = { channel: 'engine', type: 'request', requestId: 'request-1', handleId: 'handle-1', payload: { operation: 'create', input: {} } }
  assert.equal(peer.onFrame(frame), true)
  await until(() => pipe.sent.length === 1)
  assert.equal(pipe.sent[0].frame.payload.operation, 'create')
  assert.throws(() => peer.onFrame(frame), /incoming request rejected/)
  await peer.close()
})

test('an already aborted request is rejected before any frame is sent', async () => {
  const pipe = fakePipe(); const peer = createEngineRpcPeer({ pipe })
  const controller = new AbortController(); controller.abort(new Error('caller already left'))
  await assert.rejects(peer.request('create', {}, { handleId: 'handle-1', signal: controller.signal }), /caller already left/)
  assert.equal(pipe.sent.length, 0)
  await peer.close()
})

test('aborting create sends remote disposal and settles the blocked handler', async t => {
  const started = deferred(); let disposed = 0
  const p = peers({ host: {}, supervisor: {
    create: async (_input, context) => {
      started.resolve()
      await new Promise((resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }))
    },
    dispose: async () => { disposed += 1 },
  } })
  t.after(p.close)
  const controller = new AbortController()
  const pending = p.host.request('create', {}, { handleId: 'handle-create', signal: controller.signal })
  await started.promise
  controller.abort(new Error('caller aborted create'))
  await assert.rejects(pending, /caller aborted create/)
  await until(() => disposed === 1 && p.supervisor.stats().incoming === 0)
  assert.equal(disposed, 1)
})

test('close is bounded for a handler that ignores abort and rejects late frames', async () => {
  const pipe = fakePipe(); const never = new Promise(() => {})
  const peer = createEngineRpcPeer({ pipe, handlers: { create: () => never } })
  peer.onFrame({ channel: 'engine', type: 'request', requestId: 'blocked-1', handleId: 'handle-1', payload: { operation: 'create', input: {} } })
  await until(() => peer.stats().incoming === 1)
  const before = Date.now(); await peer.close(); const elapsed = Date.now() - before
  assert.ok(elapsed >= 900 && elapsed < 1_500, `unexpected close duration: ${elapsed}`)
  assert.equal(peer.stats().incoming, 0)
  assert.throws(() => peer.onFrame({ channel: 'engine', type: 'event', payload: { type: 'late', value: {} } }), /after close/)
})

test('events are bounded, ordered, and included in close draining', async () => {
  const first = deferred(); const order = []
  const pipe = fakePipe(); const peer = createEngineRpcPeer({ pipe, onEvent: async frame => {
    if (frame.payload.value === 1) await first.promise
    order.push(frame.payload.value)
  } })
  peer.onFrame({ channel: 'engine', type: 'event', payload: { type: 'update', value: 1 } })
  peer.onFrame({ channel: 'engine', type: 'event', payload: { type: 'update', value: 2 } })
  const closing = peer.close(); first.resolve(); await closing
  assert.deepEqual(order, [1, 2])
  assert.equal(peer.stats().events, 0)
})
