import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGovernedH1Profile, GOVERNED_H1_PRIVACY_ROWS } from '../profiles/governed-h1-profile.mjs'
import { apply, installGovernedH1Runtime } from './governed-h1-adapter.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

async function adapterFixture(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  }))
  const endpoint = `http://127.0.0.1:${String(server.address().port)}`
  const runtimeId = `adapter-${Math.random()}`
  const installed = installGovernedH1Runtime({ runtimeId, brokerEndpoint: endpoint, modelEndpoint: endpoint })
  t.after(installed.release)
  let adapter
  await apply({
    llm: { registerAdapter(_names, value) { adapter = value } },
    tools: { register() {} },
  }, { runtimeId, sourceRoot: ROOT })
  return adapter
}

async function consume(stream) {
  for await (const _chunk of stream) { /* consume */ }
}

test('product H1 profile fixes the seven privacy rows and product adapter', async t => {
  const home = await mkdtemp(join(tmpdir(), 'lumx-governed-h1-'))
  t.after(() => rm(home, { force: true, recursive: true }))
  const profile = await createGovernedH1Profile({ dataHomeDirectory: home, runtimeId: 'h1-test', sourceRoot: '/source' })
  const patch = await readFile(profile.runtimePatch, 'utf8')
  assert.deepEqual(profile.privacyRows, GOVERNED_H1_PRIVACY_ROWS)
  assert.deepEqual(profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.equal(profile.disabledRows.includes('tool-bash'), true)
  assert.match(patch, /lumx-governed-h1-adapter/)
  assert.doesNotMatch(patch, /h1-driver-plugin/)
})

test('product H1 runtime accepts only literal loopback ports and releases its scope', () => {
  assert.throws(() => installGovernedH1Runtime({ runtimeId: 'bad-host', brokerEndpoint: 'http://localhost:1', modelEndpoint: 'http://127.0.0.1:2' }), /literal IPv4 loopback/)
  assert.throws(() => installGovernedH1Runtime({ runtimeId: 'bad-userinfo', brokerEndpoint: 'http://u@127.0.0.1:1', modelEndpoint: 'http://127.0.0.1:2' }), /userinfo/)
  const installed = installGovernedH1Runtime({ runtimeId: 'good', brokerEndpoint: 'http://127.0.0.1:1', modelEndpoint: 'http://127.0.0.1:2' })
  installed.release()
  assert.doesNotThrow(() => installGovernedH1Runtime({ runtimeId: 'good', brokerEndpoint: 'http://127.0.0.1:1', modelEndpoint: 'http://127.0.0.1:2' }).release())
})

test('product H1 model rejects a chunked response before retaining more than the bound', async t => {
  const adapter = await adapterFixture(t, async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write(Buffer.alloc(40 * 1024, 0x20))
    response.end(Buffer.alloc(40 * 1024, 0x20))
  })
  await assert.rejects(consume(adapter.stream({
    messages: [], model: 'h1-controlled', provider: 'lumx-h1', signal: new AbortController().signal, tools: [],
  })), /response exceeds local bound/)
})

test('product H1 model propagates abort and closes a pending response read', async t => {
  let entered
  let closed
  const requestEntered = new Promise(resolve => { entered = resolve })
  const responseClosed = new Promise(resolve => { closed = resolve })
  const adapter = await adapterFixture(t, async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    entered()
    response.once('close', closed)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{')
  })
  const abort = new AbortController()
  const pending = consume(adapter.stream({
    messages: [], model: 'h1-controlled', provider: 'lumx-h1', signal: abort.signal, tools: [],
  }))
  await requestEntered
  abort.abort(new Error('test cancellation'))
  await assert.rejects(pending, /test cancellation|aborted/)
  await Promise.race([
    responseClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('aborted response was not closed')), 1_000)),
  ])
})
