import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createAcpModelRelay } from './model-relay.mjs'

const future = '2099-01-01T00:00:00.000Z'
const identity = { credential: 'identity-token', expiresAt: future, subject: 'user-42', type: 'lumx.local-auth.v1' }

async function provider(t) {
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ authorization: request.headers.authorization, body: JSON.parse(body), url: request.url })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: 'relay-ok', role: 'assistant' }, finish_reason: 'stop', index: 0 }], id: 'synthetic', model: 'synthetic-model', object: 'chat.completion' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))))
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, requests }
}

async function fixture(t) {
  const upstream = await provider(t)
  let active = true
  const relay = await createAcpModelRelay({
    engineId: 'qwen-0.24.0', getIdentity: () => identity, launchId: 'launch-1', model: 'synthetic-model',
    providerEndpoint: upstream.endpoint, providerKey: 'provider-only-key', sessionId: 'session-1',
    gateway: { validate: async input => ({ active, expiresAt: future, subject: input.subject }) },
  })
  t.after(() => relay.dispose())
  return { relay, revoke: () => { active = false }, upstream }
}

test('forwards only the fixed model after per-request identity admission', async (t) => {
  const { relay, upstream } = await fixture(t)
  const response = await fetch(`${relay.endpoint}/chat/completions`, {
    body: JSON.stringify({ messages: [{ content: 'hello', role: 'user' }], model: 'synthetic-model' }),
    headers: { authorization: `Bearer ${relay.capability}`, 'content-type': 'application/json', 'x-host-control': 'must-not-forward' },
    method: 'POST',
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, 'relay-ok')
  assert.equal(upstream.requests.length, 1)
  assert.equal(upstream.requests[0].authorization, 'Bearer provider-only-key')
  assert.equal(relay.stats.forwarded, 1)
})

test('revalidates revocation before each actual forward', async (t) => {
  const { relay, revoke, upstream } = await fixture(t)
  const request = () => fetch(`${relay.endpoint}/chat/completions`, { body: JSON.stringify({ model: 'synthetic-model' }), headers: { authorization: `Bearer ${relay.capability}`, 'content-type': 'application/json' }, method: 'POST' })
  assert.equal((await request()).status, 200)
  revoke()
  assert.equal((await request()).status, 403)
  assert.equal(upstream.requests.length, 1)
  assert.equal(relay.stats.deniedOperations, 1)
})

test('rejects identity expiry or replacement while async validation is in flight', async (t) => {
  const upstream = await provider(t)
  let resolveValidation
  let current = identity
  const validationStarted = new Promise(resolve => { resolveValidation = resolve })
  let releaseValidation
  const validationReleased = new Promise(resolve => { releaseValidation = resolve })
  const relay = await createAcpModelRelay({
    engineId: 'qwen-0.24.0', getIdentity: () => current, launchId: 'launch-race', model: 'synthetic-model',
    providerEndpoint: upstream.endpoint, providerKey: 'provider-only-key', sessionId: 'session-race',
    gateway: { validate: async input => {
      resolveValidation()
      await validationReleased
      return { active: true, expiresAt: future, subject: input.subject }
    } },
  })
  t.after(() => relay.dispose())
  const pending = fetch(`${relay.endpoint}/chat/completions`, {
    body: JSON.stringify({ model: 'synthetic-model' }),
    headers: { authorization: `Bearer ${relay.capability}`, 'content-type': 'application/json' }, method: 'POST',
  })
  await validationStarted
  current = { ...identity, credential: 'replacement-token' }
  releaseValidation()
  const response = await pending
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, 'identity_rejected')
  assert.equal(upstream.requests.length, 0)
})

test('rejects in-place identity mutation while async validation is in flight', async (t) => {
  const upstream = await provider(t)
  const current = { ...identity }
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const relay = await createAcpModelRelay({
    engineId: 'qwen-0.24.0', getIdentity: () => current, launchId: 'launch-in-place', model: 'synthetic-model',
    providerEndpoint: upstream.endpoint, providerKey: 'provider-only-key', sessionId: 'session-in-place',
    gateway: { validate: async input => { startedResolve(); await blocked; return { active: true, expiresAt: future, subject: input.subject } } },
  })
  t.after(() => relay.dispose())
  const pending = relay.admit('prompt')
  await started
  current.credential = 'mutated-in-place'
  release()
  await assert.rejects(pending, error => error.code === 'identity_rejected')
  assert.equal(upstream.requests.length, 0)
})

test('rechecks real-time expiry after barrier-controlled gateway validation', async (t) => {
  const upstream = await provider(t)
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const expiring = { ...identity, expiresAt: new Date(Date.now() + 40).toISOString() }
  const relay = await createAcpModelRelay({
    engineId: 'qwen-0.24.0', getIdentity: () => expiring, launchId: 'launch-expiry', model: 'synthetic-model',
    providerEndpoint: upstream.endpoint, providerKey: 'provider-only-key', sessionId: 'session-expiry',
    gateway: { validate: async input => { startedResolve(); await blocked; return { active: true, expiresAt: future, subject: input.subject } } },
  })
  t.after(() => relay.dispose())
  const pending = fetch(`${relay.endpoint}/chat/completions`, {
    body: JSON.stringify({ model: 'synthetic-model' }),
    headers: { authorization: `Bearer ${relay.capability}`, 'content-type': 'application/json' }, method: 'POST',
  })
  await started
  await new Promise(resolve => setTimeout(resolve, 60))
  release()
  const response = await pending
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, 'identity_expired')
  assert.equal(upstream.requests.length, 0)
})

test('rejects barrier-controlled gateway revocation with zero provider I/O', async (t) => {
  const upstream = await provider(t)
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let active = true
  const relay = await createAcpModelRelay({
    engineId: 'qwen-0.24.0', getIdentity: () => identity, launchId: 'launch-revoke', model: 'synthetic-model',
    providerEndpoint: upstream.endpoint, providerKey: 'provider-only-key', sessionId: 'session-revoke',
    gateway: { validate: async input => { await blocked; return { active, expiresAt: future, subject: input.subject } } },
  })
  t.after(() => relay.dispose())
  const pending = fetch(`${relay.endpoint}/chat/completions`, {
    body: JSON.stringify({ model: 'synthetic-model' }),
    headers: { authorization: `Bearer ${relay.capability}`, 'content-type': 'application/json' }, method: 'POST',
  })
  active = false
  release()
  assert.equal((await pending).status, 403)
  assert.equal(upstream.requests.length, 0)
})

test('keeps relay capability, Host control, model, and route boundaries separate', async (t) => {
  const { relay, upstream } = await fixture(t)
  const body = JSON.stringify({ model: 'synthetic-model' })
  assert.equal((await fetch(`${relay.endpoint}/chat/completions`, { body, headers: { authorization: 'Bearer host-control-token' }, method: 'POST' })).status, 401)
  assert.equal((await fetch(`${relay.endpoint}/other`, { body, headers: { authorization: `Bearer ${relay.capability}` }, method: 'POST' })).status, 404)
  assert.equal((await fetch(`${relay.endpoint}/chat/completions`, { body: JSON.stringify({ model: 'other-model' }), headers: { authorization: `Bearer ${relay.capability}` }, method: 'POST' })).status, 400)
  assert.equal(upstream.requests.length, 0)
})

test('unauthorized relay requests cause zero provider I/O', async (t) => {
  const { relay, upstream } = await fixture(t)
  const response = await fetch(`${relay.endpoint}/chat/completions`, {
    body: JSON.stringify({ model: 'synthetic-model' }),
    headers: { authorization: 'Bearer provider-only-key', 'content-type': 'application/json' }, method: 'POST',
  })
  assert.equal(response.status, 401)
  assert.equal(upstream.requests.length, 0)
  assert.equal(relay.stats.forwarded, 0)
})

test('streams the first provider chunk before provider completion', async (t) => {
  let firstSentResolve
  const firstSent = new Promise(resolve => { firstSentResolve = resolve })
  let releaseFinal
  const finalReleased = new Promise(resolve => { releaseFinal = resolve })
  const providerServer = createServer(async (request, response) => {
    for await (const _ of request) { /* consume */ }
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.write('{"delta":"first"}\n')
    firstSentResolve()
    await finalReleased
    response.end('{"delta":"final"}\n')
  })
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => providerServer.close(() => resolve())))
  const relay = await createAcpModelRelay({
    engineId: 'qwen-0.24.0', getIdentity: () => identity, launchId: 'launch-stream', model: 'synthetic-model',
    providerEndpoint: `http://127.0.0.1:${providerServer.address().port}/v1/chat/completions`, providerKey: 'provider-only-key', sessionId: 'session-stream',
    gateway: { validate: async input => ({ active: true, expiresAt: future, subject: input.subject }) },
  })
  t.after(() => relay.dispose())
  const response = await fetch(`${relay.endpoint}/chat/completions`, {
    body: JSON.stringify({ model: 'synthetic-model' }),
    headers: { authorization: `Bearer ${relay.capability}`, 'content-type': 'application/json' }, method: 'POST',
  })
  await firstSent
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.match(Buffer.from(first.value).toString('utf8'), /first/)
  releaseFinal()
  let remainder = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    remainder += Buffer.from(chunk.value).toString('utf8')
  }
  assert.match(remainder, /final/)
})

test('disposal aborts active provider I/O and closes the relay listener', async (t) => {
  let abortedResolve
  const aborted = new Promise(resolve => { abortedResolve = resolve })
  let seenResolve
  const seen = new Promise(resolve => { seenResolve = resolve })
  const providerServer = createServer(async (request, response) => {
    for await (const _ of request) { /* consume */ }
    seenResolve()
    request.once('aborted', () => abortedResolve())
    request.once('close', () => abortedResolve())
    response.once('close', () => abortedResolve())
  })
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => providerServer.close(() => resolve())))
  const relay = await createAcpModelRelay({
    engineId: 'qwen-0.24.0', getIdentity: () => identity, launchId: 'launch-dispose', model: 'synthetic-model',
    providerEndpoint: `http://127.0.0.1:${providerServer.address().port}/v1/chat/completions`, providerKey: 'provider-only-key', sessionId: 'session-dispose',
    gateway: { validate: async input => ({ active: true, expiresAt: future, subject: input.subject }) },
  })
  const pending = fetch(`${relay.endpoint}/chat/completions`, {
    body: JSON.stringify({ model: 'synthetic-model' }),
    headers: { authorization: `Bearer ${relay.capability}`, 'content-type': 'application/json' }, method: 'POST',
  }).catch(error => error)
  await seen
  await relay.dispose()
  await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('provider request remained open')), 1_000))])
  assert.ok(await pending instanceof Error)
  await assert.rejects(fetch(`${relay.endpoint}/chat/completions`, { method: 'POST' }))
})

test('dispose during validation rejects pending admission and causes zero provider I/O', async (t) => {
  const upstream = await provider(t)
  let started = 0
  let allStartedResolve
  const allStarted = new Promise(resolve => { allStartedResolve = resolve })
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const relay = await createAcpModelRelay({
    engineId: 'qwen-0.24.0', getIdentity: () => identity, launchId: 'launch-dispose-validation', model: 'synthetic-model',
    providerEndpoint: upstream.endpoint, providerKey: 'provider-only-key', sessionId: 'session-dispose-validation',
    gateway: { validate: async input => {
      started += 1
      if (started === 2) allStartedResolve()
      await blocked
      return { active: true, expiresAt: future, subject: input.subject }
    } },
  })
  const direct = relay.admit('prompt').catch(error => error)
  const forwarded = fetch(`${relay.endpoint}/chat/completions`, {
    body: JSON.stringify({ model: 'synthetic-model' }),
    headers: { authorization: `Bearer ${relay.capability}`, 'content-type': 'application/json' }, method: 'POST',
  }).catch(error => error)
  await allStarted
  const disposal = relay.dispose()
  release()
  await disposal
  assert.match((await direct).message, /disposed/)
  assert.ok(await forwarded instanceof Error)
  assert.equal(upstream.requests.length, 0)
  assert.equal(relay.stats.forwarded, 0)
})

test('dispose settles validation that never resolves', async (t) => {
  const upstream = await provider(t)
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const relay = await createAcpModelRelay({
    engineId: 'qwen-0.24.0', getIdentity: () => identity, launchId: 'launch-never', model: 'synthetic-model',
    providerEndpoint: upstream.endpoint, providerKey: 'provider-only-key', sessionId: 'session-never',
    gateway: { validate: async () => { startedResolve(); return new Promise(() => {}) } },
  })
  const pending = relay.admit('prompt').catch(error => error)
  await started
  await relay.dispose()
  assert.match((await pending).message, /disposed/)
  assert.equal(upstream.requests.length, 0)
  assert.equal(relay.stats.forwarded, 0)
})

test('operation admission is explicit and disposal revokes the launch capability', async (t) => {
  const { relay } = await fixture(t)
  assert.deepEqual(await relay.admit('create'), { operation: 'create', subject: 'user-42' })
  assert.deepEqual(await relay.admit('resume'), { operation: 'resume', subject: 'user-42' })
  assert.deepEqual(await relay.admit('prompt'), { operation: 'prompt', subject: 'user-42' })
  await relay.dispose()
  await assert.rejects(relay.admit('prompt'), /disposed/)
  await assert.rejects(fetch(`${relay.endpoint}/chat/completions`, { method: 'POST' }))
})
