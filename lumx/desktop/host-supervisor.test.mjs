import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
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
  const prepare = async (overrides = {}) => {
    const port = await freePort()
    return prepareLumxHostLaunch({
      auth: {
        byokKey: `${name}-provider-key`, endpoint: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
        gateway: { validate: async value => ({ active: true, expiresAt: identity.expiresAt, subject: value.subject }) },
        getIdentity: () => identity,
      },
      forkRoot: FORK, launchId: randomUUID(), mode: 'developer', nodePath: NODE, nodeSha256: NODE_SHA256,
      osHome, port, sourceRoot: SOURCE, workspaceDirectory, ...overrides,
    })
  }
  return { close: () => new Promise(resolveClose => { provider.closeAllConnections?.(); provider.close(resolveClose) }),
    launch: async (overrides = {}) => launchLumxHost(await prepare(overrides)), osHome, prepare, requests: () => requests, workspaceDirectory }
}
function assertProcessGone(pid) {
  for (const target of [pid, -pid]) assert.throws(() => process.kill(target, 0), error => error?.code === 'ESRCH')
}
function exactStop() { return { code: 0, signal: null, control: { stopping: true } } }
function processAlive(target) {
  try { process.kill(target, 0); return true } catch (error) { if (error?.code === 'ESRCH') return false; return true }
}
async function emergencyHostCleanup(host) {
  if (!processAlive(host.pid) && !processAlive(-host.pid)) return
  const settling = host.shutdown().catch(() => {})
  try { process.kill(-host.pid, 'SIGKILL') } catch (error) { if (error?.code !== 'ESRCH') throw error }
  const deadline = performance.now() + 3_000
  while ((processAlive(host.pid) || processAlive(-host.pid)) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  await Promise.race([settling, new Promise((_, reject) => setTimeout(() => reject(new Error('emergency Host cleanup did not settle')), 8_000))])
  assertProcessGone(host.pid)
}
async function emergencyHostsCleanup(hosts) {
  const failures = []
  for (const host of hosts) try { await emergencyHostCleanup(host) } catch (error) { failures.push(error) }
  if (failures.length > 0) throw new AggregateError(failures, 'emergency Host cleanup failed')
}
function testResourceLedger(t, root) {
  const pending = []; const providers = []; const hosts = []
  let complete = false; let drained
  const observe = promise => {
    const tracked = Promise.resolve(promise)
    pending.push(tracked); void tracked.catch(() => {})
    return tracked
  }
  const fixture = promise => observe(Promise.resolve(promise).then(value => {
    providers.push(value); return value
  }))
  const host = promise => observe(Promise.resolve(promise).then(value => {
    hosts.push(value); return value
  }))
  const close = async () => {
    if (drained) return drained
    drained = (async () => {
      const failures = []
      await Promise.allSettled(pending)
      if (!complete) try { await emergencyHostsCleanup(hosts) } catch (error) { failures.push(error) }
      for (const provider of providers) try { await provider.close() } catch (error) { failures.push(error) }
      try { rmSync(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
      if (failures.length > 0) throw new AggregateError(failures, 'Host test resource cleanup failed')
    })()
    return drained
  }
  t.after(close)
  return { fixture, host, close, complete: () => { complete = true } }
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
  const resources = testResourceLedger(t, root)
  const runtimeParent = join(root, 'runtime'); mkdirSync(runtimeParent)
  const value = await resources.fixture(fixture(root, 'startup'))
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
  resources.complete()
})

test('stubborn stopped Host is killed, reaped, and cleaned after bounded shutdown', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-stubborn-'))
  const resources = testResourceLedger(t, root)
  const value = await resources.fixture(fixture(root, 'stubborn'))
  const runtimeParent = join(root, 'runtime'); mkdirSync(runtimeParent)
  const host = await resources.host(value.launch({ runtimeParent })); const paths = [host.bootstrap.path, host.hostProfile.path]
  let shutdown
  assert.equal(host.governance.rows.length, 7)
  assert(host.governance.rows.every(row => row.generation === 1 && row.format === 'module' && row.url.endsWith('/lib/index.js')))
  process.kill(host.pid, 'SIGSTOP')
  const started = performance.now(); shutdown = host.shutdown(); assert.strictEqual(host.shutdown(), shutdown)
  let failure
  try { await shutdown; assert.fail('stopped Host shutdown unexpectedly fulfilled') } catch (error) { failure = error }
  assert(failure instanceof AggregateError); assert.match(failure.errors[0]?.message ?? '', /Host shutdown timed out/u)
  assert.deepEqual(failure.outcome, { code: null, signal: 'SIGKILL' })
  assert.ok(performance.now() - started < 20_000)
  assertProcessGone(host.pid); assert.deepEqual(readdirSync(runtimeParent), [])
  for (const path of paths) assert.equal(existsSync(path), false)
  resources.complete()
})

test('two native Hosts isolate controls and persisted sessions survive a real process restart', { timeout: 90_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-lifecycle-'))
  const resources = testResourceLedger(t, root)
  const fixtureA = resources.fixture(fixture(root, 'alpha'))
  const fixtureB = resources.fixture(fixture(root, 'beta'))
  const [a, b] = await Promise.all([fixtureA, fixtureB])
  const runtimeA = join(root, 'runtime-alpha'); const runtimeB = join(root, 'runtime-beta'); mkdirSync(runtimeA); mkdirSync(runtimeB)
  const launches = [resources.host(a.launch({ runtimeParent: runtimeA })), resources.host(b.launch({ runtimeParent: runtimeB }))]
  let first; let second
  try { [first, second] = await Promise.all(launches) } catch (error) { await Promise.allSettled(launches); throw error }
  assert.equal('ctx' in first, false)
  assert.deepEqual(Object.keys(first.process), ['pid'])
  const [alpha, beta] = await Promise.all([first.control.healthCheck(), second.control.healthCheck()])
  assert.equal(alpha.status, 'pass'); assert.equal(beta.status, 'pass')
  assert.notEqual(alpha.assistantTextSha256, beta.assistantTextSha256)
  const alphaUrl = new URL(first.readyUrl)
  const crossed = await fetch(new URL(`${alphaUrl.pathname}${alphaUrl.search}`, second.baseUrl), { redirect: 'manual' })
  assert.notEqual(crossed.status, 303)
  const [disconnected, stopped] = await Promise.all([first.control.disconnect(), second.shutdown()])
  assert.deepEqual(disconnected, { code: 0, signal: null }); assert.deepEqual(stopped, exactStop())
  assertProcessGone(first.pid); assertProcessGone(second.pid)

  const restarted = await resources.host(a.launch({ runtimeParent: runtimeA }))
  const persisted = await restarted.control.inspectSession(alpha.sessionId)
  assert.equal(persisted.status, 'pass')
  assert.equal(persisted.sessionId, alpha.sessionId)
  assert.ok(persisted.eventCount > 0)
  assert.deepEqual(await restarted.shutdown(), exactStop())
  assertProcessGone(restarted.pid); assert.deepEqual(readdirSync(runtimeA), []); assert.deepEqual(readdirSync(runtimeB), [])
  assert.equal(a.requests(), 1); assert.equal(b.requests(), 1)
  resources.complete()
})

test('control failure remains primary when material cleanup also fails', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-cleanup-failure-'))
  const resources = testResourceLedger(t, root)
  const value = await resources.fixture(fixture(root, 'cleanup-failure'))
  const runtimeParent = join(root, 'runtime'); mkdirSync(runtimeParent)
  const prepared = await value.prepare({ runtimeParent }); let cleanupAttempts = 0
  const host = await resources.host(launchLumxHost({ ...prepared, async cleanup() {
    cleanupAttempts += 1; await prepared.cleanup(); throw new Error('synthetic material cleanup failure')
  } }))
  let shutdown
  process.kill(host.pid, 'SIGSTOP'); shutdown = host.shutdown()
  let failure
  try { await shutdown; assert.fail('injected cleanup failure unexpectedly fulfilled') } catch (error) { failure = error }
  assert(failure instanceof AggregateError); assert.match(failure.errors[0]?.message ?? '', /Host shutdown timed out/u)
  assert.match(failure.errors[1]?.message ?? '', /synthetic material cleanup failure/u)
  assert.equal(cleanupAttempts, 1); assert.deepEqual(failure.outcome, { code: null, signal: 'SIGKILL' })
  assertProcessGone(host.pid); assert.deepEqual(readdirSync(runtimeParent), [])
  resources.complete()
})

test('supported native Host selects the product platform-stub without opening a BYOK relay', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-platform-stub-'))
  const resources = testResourceLedger(t, root)
  const value = await resources.fixture(fixture(root, 'platform-stub'))
  const host = await resources.host(value.launch({ consumer: 'platform-stub', auth: undefined }))
  assert.equal(host.consumer, 'platform-stub')
  assert.equal(host.surface, 'local-platform-stub')
  assert.equal(value.requests(), 0)
  await host.shutdown()
  resources.complete()
})

test('test resource ledger settles parallel acquisition failures before draining acquired providers', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-ledger-acquire-'))
  const resources = testResourceLedger(t, root)
  const acquired = resources.fixture(fixture(root, 'ledger-acquired'))
  const rejected = resources.fixture(Promise.reject(new Error('synthetic peer fixture acquisition failure')))
  await assert.rejects(Promise.all([acquired, rejected]), /synthetic peer fixture acquisition failure/)
  await resources.close()
  assert.equal(existsSync(root), false)
})

test('test resource ledger closes an acquired provider after preparation rejects', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-ledger-prepare-'))
  const resources = testResourceLedger(t, root)
  const value = await resources.fixture(fixture(root, 'ledger-prepare'))
  await assert.rejects(value.prepare({ nodeSha256: '0'.repeat(64) }), /caller anchor/)
  await resources.close()
  assert.equal(existsSync(root), false)
})

test('test resource ledger reaps a resolved Host when a peer launch rejects', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-ledger-launch-'))
  const resources = testResourceLedger(t, root)
  const alpha = await resources.fixture(fixture(root, 'ledger-alpha'))
  const beta = await resources.fixture(fixture(root, 'ledger-beta'))
  const runtimeAlpha = join(root, 'runtime-alpha'); const runtimeBeta = join(root, 'runtime-beta')
  mkdirSync(runtimeAlpha); mkdirSync(runtimeBeta)
  const host = await resources.host(alpha.launch({ runtimeParent: runtimeAlpha }))
  const missing = join(root, 'missing-build'); mkdirSync(missing)
  await assert.rejects(resources.host(beta.launch({ runtimeParent: runtimeBeta, sourceRoot: missing })), /Host exited before readiness|Host exited/)
  assert.deepEqual(await host.shutdown(), exactStop())
  assertProcessGone(host.pid)
  resources.complete()
  await resources.close()
  assert.equal(existsSync(root), false)
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
