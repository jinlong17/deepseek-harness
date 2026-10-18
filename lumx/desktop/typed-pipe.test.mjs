import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createTypedPipe } from './typed-pipe.mjs'

function pair(onHost = () => {}, onSupervisor = () => {}) {
  const h2s = new PassThrough(); const s2h = new PassThrough()
  const host = createTypedPipe({ readable: s2h, writable: h2s, incomingDirection: 'supervisor-to-host', outgoingDirection: 'host-to-supervisor', generation: 'generation-123456', onFrame: onHost })
  const supervisor = createTypedPipe({ readable: h2s, writable: s2h, incomingDirection: 'host-to-supervisor', outgoingDirection: 'supervisor-to-host', generation: 'generation-123456', onFrame: onSupervisor })
  return { host, supervisor }
}

test('correlates bounded frames with monotonic direction-local sequence', async t => {
  const seen = []
  const pipes = pair(frame => seen.push(frame))
  t.after(async () => Promise.all([pipes.host.close(), pipes.supervisor.close()]))
  await pipes.supervisor.send({ channel: 'engine', type: 'response', requestId: 'r1', handleId: 'h1', payload: { ok: true } })
  await pipes.supervisor.send({ channel: 'control', type: 'ready', payload: {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(seen.map(frame => [frame.seq, frame.channel, frame.type]), [[1, 'engine', 'response'], [2, 'control', 'ready']])
})

test('fails closed on wrong generation, direction, sequence, and oversized frame', async t => {
  for (const mutation of [
    { generation: 'generation-wrong!' }, { direction: 'host-to-supervisor' }, { seq: 2 },
  ]) {
    const input = new PassThrough(); const output = new PassThrough()
    const pipe = createTypedPipe({ readable: input, writable: output, incomingDirection: 'supervisor-to-host', outgoingDirection: 'host-to-supervisor', generation: 'generation-123456', onFrame() {} })
    input.write(`${JSON.stringify({ v: 1, direction: 'supervisor-to-host', channel: 'control', generation: 'generation-123456', seq: 1, type: 'ready', ...mutation })}\n`)
    await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(pipe.send({ channel: 'control', type: 'command' }), /contract rejected/)
  }
  const input = new PassThrough(); const output = new PassThrough()
  const pipe = createTypedPipe({ readable: input, writable: output, incomingDirection: 'supervisor-to-host', outgoingDirection: 'host-to-supervisor', generation: 'generation-123456', onFrame() {} })
  const base64 = Buffer.alloc(800 * 1024).toString('base64')
  await assert.rejects(async () => pipe.send({ channel: 'acp', type: 'bytes', payload: { base64 } }), /byte limit/)
  t.after(() => pipe.close())
})
