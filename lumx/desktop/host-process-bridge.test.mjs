import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'

import { createHostProcessBridge } from './host-process-bridge.mjs'

const GENERATION = 'bridge-test-generation'
const ready = seq => `${JSON.stringify({ v: 1, direction: 'host-to-supervisor', channel: 'control', generation: GENERATION,
  seq, type: 'ready', payload: { consumer: 'desktop-byok' } })}\n`
const engineRequest = seq => `${JSON.stringify({ v: 1, direction: 'host-to-supervisor', channel: 'engine', generation: GENERATION,
  seq, type: 'request', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', payload: { operation: 'create', input: {} } })}\n`
const engine = overrides => ({ bind() {}, create: async () => ({}), load: async () => ({}), prompt: async () => ({}), cancel: async () => {}, dispose: async () => {}, ...overrides })

function failingBridge({ holdEngine = false } = {}) {
  const stdout = new PassThrough(); const transportError = new Error('synthetic fresh transport finish failure')
  const stdin = new Writable({ write(_chunk, _encoding, callback) { callback() }, final(callback) { callback(transportError) } })
  const bridge = createHostProcessBridge({ child: { stdin, stdout }, generation: GENERATION,
    admitOtherProvider: async () => {}, engine: engine(holdEngine ? { create: () => new Promise(() => {}) } : {}) })
  return { bridge, stdout, transportError }
}

test('bridge close retains one fresh typed-pipe finish failure after ready', async () => {
  const value = failingBridge(); value.stdout.write(ready(1)); await value.bridge.ready
  const closing = value.bridge.close(); assert.strictEqual(value.bridge.close(), closing)
  let failure; try { await closing } catch (error) { failure = error }
  assert(failure instanceof AggregateError); assert.equal(failure.errors.length, 1)
  assert.strictEqual(failure.errors[0], value.transportError)
})

test('bridge close retains distinct RPC drain and transport failures without duplicating either', { timeout: 5_000 }, async () => {
  const value = failingBridge({ holdEngine: true }); value.stdout.write(ready(1)); await value.bridge.ready
  value.stdout.write(engineRequest(2)); await new Promise(resolve => setImmediate(resolve))
  let failure; try { await value.bridge.close() } catch (error) { failure = error }
  assert(failure instanceof AggregateError); assert.equal(failure.errors.filter(error => error === value.transportError).length, 1)
  assert.equal(failure.errors.filter(error => /engine RPC handler drain timed out/u.test(error.message)).length, 1)
  assert.equal(failure.errors.length, 2)
})
