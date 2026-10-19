import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { createByokAdmissionClient, createByokAdmissionServer } from './byok-admission-peer.mjs'
import { createTypedPipe } from './typed-pipe.mjs'

function peerPair(admitOtherProvider) {
  const h2s = new PassThrough(); const s2h = new PassThrough()
  let client; let server
  const hostPipe = createTypedPipe({ readable: s2h, writable: h2s, incomingDirection: 'supervisor-to-host', outgoingDirection: 'host-to-supervisor', generation: 'admission-generation', onFrame: frame => client.onFrame(frame) })
  const supervisorPipe = createTypedPipe({ readable: h2s, writable: s2h, incomingDirection: 'host-to-supervisor', outgoingDirection: 'supervisor-to-host', generation: 'admission-generation', onFrame: frame => server.onFrame(frame) })
  client = createByokAdmissionClient({ pipe: hostPipe })
  server = createByokAdmissionServer({ pipe: supervisorPipe, admitOtherProvider, onFailure(error) { void supervisorPipe.close().catch(() => {}); throw error } })
  return { client, server, async close() { client.seal(); server.seal(); await Promise.allSettled([client.close(), server.close(), hostPipe.close(), supervisorPipe.close()]) } }
}

test('fresh admission returns only success or a whitelisted denial before adapter effects', async t => {
  let calls = 0; let code
  const peers = peerPair(async () => { calls += 1; if (code !== undefined) { const error = new Error('private detail'); error.code = code; throw error } })
  t.after(() => peers.close())
  await peers.client.admitOtherProvider()
  code = 'identity_required'
  await assert.rejects(peers.client.admitOtherProvider(), error => error?.code === 'identity_required' && !error.message.includes('private detail'))
  assert.equal(calls, 2)
  assert.deepEqual(peers.client.stats(), { accepting: true, pending: 0, tombstones: 0, cancellationWrites: 0 })
})

test('caller abort cancels exactly one held admission and late settlement has no effect', async t => {
  let entered; let aborted = false
  const started = new Promise(resolve => { entered = resolve })
  const peers = peerPair(({ signal }) => new Promise((resolve, reject) => {
    entered(); signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true })
  }))
  t.after(() => peers.close())
  const controller = new AbortController(); const pending = peers.client.admitOtherProvider({ signal: controller.signal })
  await started; controller.abort(new Error('caller stopped'))
  await assert.rejects(pending, /caller stopped/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(aborted, true); assert.equal(peers.server.stats().pending, 0)
})

test('close drains the owned wrapper even when an underlying validation ignores abort', async () => {
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const peers = peerPair(() => { entered(); return new Promise(() => {}) })
  const controller = new AbortController(); const pending = peers.client.admitOtherProvider({ signal: controller.signal })
  await started; controller.abort(new Error('caller stopped'))
  await assert.rejects(pending, /caller stopped/)
  await new Promise(resolve => setImmediate(resolve))
  const serverClose = peers.server.close(); const clientClose = peers.client.close()
  assert.equal(peers.server.close(), serverClose); assert.equal(peers.client.close(), clientClose)
  await Promise.race([
    Promise.all([serverClose, clientClose]),
    new Promise((_, reject) => setTimeout(() => reject(new Error('admission wrapper drain hung')), 1_000)),
  ])
  await Promise.allSettled([peers.close()])
})

test('same-turn seal or cancel suppresses callback dispatch and drains promptly', async () => {
  for (const action of ['seal', 'cancel']) {
    const frames = []; let calls = 0
    const server = createByokAdmissionServer({
      admitOtherProvider() { calls += 1; return new Promise(() => {}) },
      pipe: { send(frame) { frames.push(frame); return Promise.resolve() } },
    })
    const id = action === 'seal' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    server.onFrame({ channel: 'admission', type: 'request', requestId: id, payload: {} })
    if (action === 'seal') server.seal()
    else server.onFrame({ channel: 'admission', type: 'cancel', requestId: id, payload: {} })
    const closing = server.close()
    assert.strictEqual(server.close(), closing)
    await Promise.race([closing, new Promise((_, reject) => setTimeout(() => reject(new Error(`${action} drain hung`)), 250))])
    assert.equal(calls, 0); assert.deepEqual(frames, [])
    assert.deepEqual(server.stats(), { accepting: false, completed: 0, pending: 0 })
  }
})

test('client enforces pending capacity and expires an unanswered request', { timeout: 12_000 }, async () => {
  const sent = []
  const client = createByokAdmissionClient({ pipe: { send(frame) { sent.push(frame); return Promise.resolve() } } })
  const pending = Array.from({ length: 64 }, () => client.admitOtherProvider().catch(error => error))
  await assert.rejects(client.admitOtherProvider(), error => error?.code === 'admission_unavailable')
  client.seal(); await Promise.all(pending); await client.close()
  assert.equal(sent.filter(frame => frame.type === 'request').length, 64)

  const expiringFrames = []
  const expiring = createByokAdmissionClient({ pipe: { send(frame) { expiringFrames.push(frame); return Promise.resolve() } } })
  await assert.rejects(expiring.admitOtherProvider(), error => error?.code === 'admission_timeout')
  assert.deepEqual(expiringFrames.map(frame => frame.type), ['request', 'cancel'])
  assert.deepEqual(expiring.stats(), { accepting: true, pending: 0, tombstones: 1, cancellationWrites: 0 })
  await expiring.close()
})

test('client tombstones one late response and rejects duplicate or unsolicited grants', async () => {
  const frames = []
  const client = createByokAdmissionClient({ pipe: { send(frame) { frames.push(frame); return Promise.resolve() } } })
  const controller = new AbortController(); const pending = client.admitOtherProvider({ signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve)); const id = frames[0].requestId
  controller.abort(new Error('cancelled locally')); await assert.rejects(pending, /cancelled locally/)
  assert.equal(client.onFrame({ channel: 'admission', type: 'response', requestId: id, payload: { ok: true } }), true)
  assert.throws(() => client.onFrame({ channel: 'admission', type: 'response', requestId: id, payload: { ok: true } }), /no pending request/)
  assert.throws(() => client.onFrame({ channel: 'admission', type: 'response', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', payload: { ok: true, subject: 'forbidden' } }), /no pending request|payload/)
  await client.close()
})

test('server rejects operands, duplicate requests, and unknown cancellation', async t => {
  const peers = peerPair(async () => {})
  t.after(() => peers.close())
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  assert.throws(() => peers.server.onFrame({ channel: 'admission', type: 'request', requestId: id, payload: { provider: 'forbidden' } }), /payload/)
  assert.throws(() => peers.server.onFrame({ channel: 'admission', type: 'request', requestId: id, handleId: 'forbidden', payload: {} }), /routing operands/)
  assert.throws(() => peers.client.onFrame({ channel: 'admission', type: 'response', requestId: id, promptId: 'forbidden', payload: { ok: true } }), /routing operands/)
  assert.throws(() => peers.server.onFrame({ channel: 'admission', type: 'cancel', requestId: id, payload: {} }), /unknown/)
})
