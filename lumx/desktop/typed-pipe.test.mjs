import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
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
  await pipes.host.send({ channel: 'control', type: 'ready', payload: {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(seen.map(frame => [frame.seq, frame.channel, frame.type]), [[1, 'engine', 'response']])
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
  t.after(() => pipe.close().catch(() => {}))
})

function inbound(seq, payload = {}) {
  return `${JSON.stringify({ v: 1, direction: 'supervisor-to-host', channel: 'control', generation: 'generation-123456', seq, type: 'command', requestId: `r${seq}`, payload })}\n`
}

test('rejects unterminated input and slow-handler floods within fixed bounds', async () => {
  const unterminated = new PassThrough(); const output = new PassThrough()
  const first = createTypedPipe({ readable: unterminated, writable: output, incomingDirection: 'supervisor-to-host', outgoingDirection: 'host-to-supervisor', generation: 'generation-123456', onFrame() {} })
  unterminated.write(Buffer.alloc(1024 * 1024 + 1, 0x78))
  await assert.rejects(first.closed, /unterminated frame exceeds byte limit/)

  const flooded = new PassThrough(); const sink = new PassThrough()
  const second = createTypedPipe({ readable: flooded, writable: sink, incomingDirection: 'supervisor-to-host', outgoingDirection: 'host-to-supervisor', generation: 'generation-123456', onFrame: () => new Promise(() => {}) })
  flooded.write(Array.from({ length: 258 }, (_, index) => inbound(index + 1)).join(''))
  await assert.rejects(second.closed, /incoming queue exceeds fixed limit/)
})

test('close aborts a blocked writer and EOF has an awaitable clean lifecycle', async () => {
  const input = new PassThrough()
  const blocked = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) {} })
  const pipe = createTypedPipe({ readable: input, writable: blocked, incomingDirection: 'supervisor-to-host', outgoingDirection: 'host-to-supervisor', generation: 'generation-123456', onFrame() {} })
  const pending = pipe.send({ channel: 'engine', type: 'request', requestId: 'r1', payload: {} }).catch(error => error)
  await assert.rejects(pipe.close(), /aborted|typed pipe closed/i)
  assert.match((await pending).message, /aborted|typed pipe closed/i)

  const cleanInput = new PassThrough(); const cleanOutput = new PassThrough()
  const seen = []
  const clean = createTypedPipe({ readable: cleanInput, writable: cleanOutput, incomingDirection: 'supervisor-to-host', outgoingDirection: 'host-to-supervisor', generation: 'generation-123456', onFrame: frame => { seen.push(frame.seq) } })
  cleanInput.end(inbound(1))
  await clean.closed
  assert.deepEqual(seen, [1])
})

test('send waits for writable completion before resolving a shutdown response', async t => {
  const input = new PassThrough(); let complete
  const output = new Writable({ write(_chunk, _encoding, callback) { complete = callback } })
  const pipe = createTypedPipe({ readable: input, writable: output, incomingDirection: 'supervisor-to-host', outgoingDirection: 'host-to-supervisor', generation: 'generation-123456', onFrame() {} })
  let resolved = false
  const sent = pipe.send({ channel: 'control', type: 'response', requestId: 'shutdown', payload: { ok: true } }).then(() => { resolved = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false)
  complete(); await sent
  input.end(); await pipe.closed
  t.after(() => output.destroy())
})


test('close waits for an in-flight write callback and writable finish barrier', async () => {
  const input = new PassThrough(); let releaseWrite; let releaseFinal; let finalStarted = false
  const output = new Writable({
    write(_chunk, _encoding, callback) { releaseWrite = callback },
    final(callback) { finalStarted = true; releaseFinal = callback },
  })
  const pipe = createTypedPipe({ readable: input, writable: output, incomingDirection: 'supervisor-to-host', outgoingDirection: 'host-to-supervisor', generation: 'generation-123456', onFrame() {} })
  const sent = pipe.send({ channel: 'control', type: 'response', requestId: 'shutdown', payload: { ok: true } })
  await new Promise(resolve => setImmediate(resolve))
  let closed = false
  const closing = pipe.close().then(() => { closed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, false)
  assert.equal(finalStarted, false)
  releaseWrite()
  await sent
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finalStarted, true)
  assert.equal(closed, false)
  releaseFinal()
  await closing
  assert.equal(closed, true)
})
