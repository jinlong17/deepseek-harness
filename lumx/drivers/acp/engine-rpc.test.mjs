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
  assert.deepEqual(p.host.stats(), { incoming: 0, outgoing: 0 })
})

test('rejects unknown responses and bounds operation names', async t => {
  const p = peers({ host: {}, supervisor: { create: async () => ({ nativeSessionId: 'n1' }) } })
  t.after(p.close)
  assert.deepEqual(await p.host.request('create', {}), { nativeSessionId: 'n1' })
  await assert.rejects(p.host.request('unknown', {}), /operation is invalid/)
  assert.throws(() => p.host.onFrame({ channel: 'engine', type: 'response', requestId: 'missing', payload: { ok: true } }), /no pending request/)
})
