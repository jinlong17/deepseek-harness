import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { launchLumxHost } from './host-supervisor.mjs'
import { prepareLumxHostLaunch } from './host-launch-materials.mjs'

const NODE = '/Users/jinlong/.local/opt/node-v24.20.0/bin/node'
const NODE_SHA256 = '9d050fd455b56426e25d4d603c7c501cbb2630348e836cf221dcce748e90588a'
const SOURCE = '/Users/jinlong/.codex/worktrees/a2k-desktop-p1a-gate1/.local/g9-1/deepseek-harness'
const FORK = '/Users/jinlong/.codex/worktrees/a2k-desktop-p1a-gate1/.local/g9-1/deepseek-harness'

async function listen(handler) {
  const server = createServer(handler)
  await new Promise((resolveReady, rejectReady) => {
    server.once('error', rejectReady); server.listen(0, '127.0.0.1', resolveReady)
  })
  return server
}
async function freePort() {
  const server = await listen((_, response) => response.end())
  const port = server.address().port
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}
async function fixture(root, name) {
  const osHome = join(root, `${name}-home`); const workspaceDirectory = join(root, `${name}-workspace`)
  mkdirSync(osHome, { mode: 0o700 }); mkdirSync(workspaceDirectory, { mode: 0o700 })
  let requests = 0
  const provider = await listen(async (request, response) => {
    requests += 1
    for await (const _ of request) { /* consume */ }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ text: `${name}-response` }))
  })
  const identity = { credential: `${name}-identity`, expiresAt: '2099-01-01T00:00:00.000Z', subject: name, type: 'lumx.local-auth.v1' }
  return { close: () => new Promise(resolveClose => { provider.closeAllConnections?.(); provider.close(resolveClose) }), launch: async (overrides = {}) => {
    const port = await freePort()
    return launchLumxHost(await prepareLumxHostLaunch({
      auth: {
        byokKey: `${name}-provider-key`, endpoint: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
        gateway: { validate: async value => ({ active: true, expiresAt: identity.expiresAt, subject: value.subject }) },
        getIdentity: () => identity,
      },
      forkRoot: FORK, launchId: randomUUID(), mode: 'developer', nodePath: NODE, nodeSha256: NODE_SHA256,
      osHome, port, sourceRoot: SOURCE, workspaceDirectory, ...overrides,
    }))
  }, osHome, requests: () => requests, workspaceDirectory }
}

test('caller anchors and pre-cancel reject before native process creation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-preflight-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const osHome = join(root, 'home'); const workspaceDirectory = join(root, 'workspace')
  mkdirSync(osHome); mkdirSync(workspaceDirectory)
  const base = { forkRoot: FORK, launchId: randomUUID(), mode: 'developer', nodePath: NODE, osHome, port: 12345, sourceRoot: SOURCE, workspaceDirectory }
  await assert.rejects(prepareLumxHostLaunch({ ...base, nodeSha256: '0'.repeat(64) }), /caller anchor/)
  const controller = new AbortController(); controller.abort(new Error('cancel-before-launch'))
  await assert.rejects(prepareLumxHostLaunch({ ...base, nodeSha256: NODE_SHA256, signal: controller.signal }), /cancel-before-launch/)
  assert.deepEqual(readdirSync(root).sort(), ['home', 'workspace'])
})

test('developer data home cannot alias the sibling consumer home', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-home-alias-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const osHome = join(root, 'home'); const workspaceDirectory = join(root, 'workspace')
  mkdirSync(osHome); mkdirSync(workspaceDirectory); mkdirSync(join(osHome, '.lumx'))
  symlinkSync('.lumx', join(osHome, '.lumx-developer'))
  await assert.rejects(prepareLumxHostLaunch({
    forkRoot: FORK, launchId: randomUUID(), mode: 'developer', nodePath: NODE, nodeSha256: NODE_SHA256,
    osHome, port: 12345, sourceRoot: SOURCE, workspaceDirectory,
  }), /must be a direct directory/)
  assert.deepEqual(readdirSync(osHome).sort(), ['.lumx', '.lumx-developer'])
})

test('startup failure, timeout, and cancellation reap the native process and runtime', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-startup-'))
  const runtimeParent = join(root, 'runtime'); mkdirSync(runtimeParent)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const value = await fixture(root, 'startup')
  t.after(value.close)
  const missingBuild = join(root, 'missing-build'); mkdirSync(missingBuild)
  await assert.rejects(value.launch({ runtimeParent, sourceRoot: missingBuild }), /Host exited before readiness|Host exited/)
  assert.deepEqual(readdirSync(runtimeParent), [])
  await assert.rejects(value.launch({ runtimeParent, startupTimeoutMs: 1 }), /Host startup timed out/)
  assert.deepEqual(readdirSync(runtimeParent), [])
  const controller = new AbortController()
  const pending = value.launch({ runtimeParent, signal: controller.signal })
  setTimeout(() => controller.abort(new Error('cancel-during-boot')), 25)
  await assert.rejects(pending, /cancel-during-boot/)
  assert.deepEqual(readdirSync(runtimeParent), [])
})

test('stubborn stopped Host is killed, reaped, and cleaned after bounded shutdown', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-stubborn-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const value = await fixture(root, 'stubborn')
  t.after(value.close)
  const host = await value.launch()
  assert.equal(host.governance.rows.length, 7)
  assert(host.governance.rows.every(row => row.generation === 1 && row.format === 'module' && row.url.endsWith('/lib/index.js')))
  process.kill(host.pid, 'SIGSTOP')
  assert.deepEqual(await host.shutdown(), { code: null, signal: 'SIGKILL' })
})

test('two native Hosts isolate controls and persisted sessions survive a real process restart', { timeout: 90_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-lifecycle-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const [a, b] = await Promise.all([fixture(root, 'alpha'), fixture(root, 'beta')])
  t.after(async () => { await Promise.all([a.close(), b.close()]) })
  const [first, second] = await Promise.all([a.launch(), b.launch()])
  assert.equal('ctx' in first, false)
  assert.deepEqual(Object.keys(first.process), ['pid'])
  const [alpha, beta] = await Promise.all([first.control.healthCheck(), second.control.healthCheck()])
  assert.equal(alpha.status, 'pass'); assert.equal(beta.status, 'pass')
  assert.notEqual(alpha.assistantTextSha256, beta.assistantTextSha256)
  const alphaUrl = new URL(first.readyUrl)
  const crossed = await fetch(new URL(`${alphaUrl.pathname}${alphaUrl.search}`, second.baseUrl), { redirect: 'manual' })
  assert.notEqual(crossed.status, 303)
  const [disconnected, stopped] = await Promise.all([first.control.disconnect(), second.shutdown()])
  assert.deepEqual(disconnected, { code: 0, signal: null }); assert.deepEqual(stopped, { code: 0, signal: null })

  const restarted = await a.launch()
  const persisted = await restarted.control.inspectSession(alpha.sessionId)
  assert.equal(persisted.status, 'pass')
  assert.equal(persisted.sessionId, alpha.sessionId)
  assert.ok(persisted.eventCount > 0)
  assert.deepEqual(await restarted.shutdown(), { code: 0, signal: null })
  assert.equal(a.requests(), 1); assert.equal(b.requests(), 1)
})

test('supported native Host selects the product platform-stub without opening a BYOK relay', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-platform-stub-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const value = await fixture(root, 'platform-stub')
  t.after(value.close)
  const host = await value.launch({ consumer: 'platform-stub', auth: undefined })
  t.after(host.shutdown)
  assert.equal(host.consumer, 'platform-stub')
  assert.equal(host.surface, 'local-platform-stub')
  assert.equal(value.requests(), 0)
  await host.shutdown()
})

test('supported native Host selects the isolated governed-H1 product composition', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-governed-h1-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const osHome = join(root, 'home'); const workspaceDirectory = join(root, 'workspace'); mkdirSync(osHome); mkdirSync(workspaceDirectory)
  let modelRequests = 0; let brokerRequests = 0
  const model = await listen(async (request, response) => { modelRequests += 1; for await (const _ of request) {};
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'text', text: 'H1_HOST_OK' })) })
  const broker = await listen(async (request, response) => { brokerRequests += 1; for await (const _ of request) {};
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true })) })
  t.after(async () => { for (const server of [model, broker]) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)) } })
  const host = await launchLumxHost(await prepareLumxHostLaunch({ consumer: 'governed-h1', forkRoot: FORK, launchId: randomUUID(), mode: 'developer', nodePath: NODE,
    nodeSha256: NODE_SHA256, osHome, port: await freePort(), sourceRoot: SOURCE, workspaceDirectory,
    h1: { brokerEndpoint: `http://127.0.0.1:${broker.address().port}/broker`, modelEndpoint: `http://127.0.0.1:${model.address().port}/model` } }))
  t.after(host.shutdown)
  assert.equal(host.consumer, 'governed-h1'); assert.equal(host.surface, 'official-dsh-web-profile-shared-host')
  const health = await host.control.healthCheck(); assert.equal(health.status, 'pass', JSON.stringify(health)); assert.equal(modelRequests, 1); assert.equal(brokerRequests, 0)
  await host.shutdown()
})
