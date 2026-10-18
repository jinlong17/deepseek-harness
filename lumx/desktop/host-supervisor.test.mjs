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
async function cleanupTestResources({ close, complete, hosts, root }) {
  const failures = []
  if (!complete) try { await emergencyHostsCleanup(hosts) } catch (error) { failures.push(error) }
  try { await close() } catch (error) { failures.push(error) }
  try { rmSync(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  if (failures.length > 0) throw new AggregateError(failures, 'Host test resource cleanup failed')
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
  const value = await fixture(root, 'stubborn')
  const runtimeParent = join(root, 'runtime'); mkdirSync(runtimeParent)
  const host = await value.launch({ runtimeParent }); const paths = [host.bootstrap.path, host.hostProfile.path]
  let shutdown; let complete = false
  t.after(() => cleanupTestResources({ close: value.close, complete, hosts: [host], root }))
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
  complete = true
})

test('two native Hosts isolate controls and persisted sessions survive a real process restart', { timeout: 90_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-lifecycle-'))
  const [a, b] = await Promise.all([fixture(root, 'alpha'), fixture(root, 'beta')])
  const runtimeA = join(root, 'runtime-alpha'); const runtimeB = join(root, 'runtime-beta'); mkdirSync(runtimeA); mkdirSync(runtimeB)
  const live = []; let complete = false
  t.after(async () => {
    const failures = []
    if (!complete) try { await emergencyHostsCleanup(live) } catch (error) { failures.push(error) }
    for (const close of [a.close, b.close]) try { await close() } catch (error) { failures.push(error) }
    try { rmSync(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'two-Host test resource cleanup failed')
  })
  const tracked = promise => promise.then(host => { live.push(host); return host })
  const launches = [tracked(a.launch({ runtimeParent: runtimeA })), tracked(b.launch({ runtimeParent: runtimeB }))]
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

  const restarted = await a.launch({ runtimeParent: runtimeA }); live.push(restarted)
  const persisted = await restarted.control.inspectSession(alpha.sessionId)
  assert.equal(persisted.status, 'pass')
  assert.equal(persisted.sessionId, alpha.sessionId)
  assert.ok(persisted.eventCount > 0)
  assert.deepEqual(await restarted.shutdown(), exactStop())
  assertProcessGone(restarted.pid); assert.deepEqual(readdirSync(runtimeA), []); assert.deepEqual(readdirSync(runtimeB), [])
  assert.equal(a.requests(), 1); assert.equal(b.requests(), 1)
  complete = true
})

test('control failure remains primary when material cleanup also fails', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-host-cleanup-failure-'))
  const value = await fixture(root, 'cleanup-failure')
  const runtimeParent = join(root, 'runtime'); mkdirSync(runtimeParent)
  const prepared = await value.prepare({ runtimeParent }); let cleanupAttempts = 0
  const host = await launchLumxHost({ ...prepared, async cleanup() {
    cleanupAttempts += 1; await prepared.cleanup(); throw new Error('synthetic material cleanup failure')
  } })
  let shutdown; let complete = false
  t.after(() => cleanupTestResources({ close: value.close, complete, hosts: [host], root }))
  process.kill(host.pid, 'SIGSTOP'); shutdown = host.shutdown()
  let failure
  try { await shutdown; assert.fail('injected cleanup failure unexpectedly fulfilled') } catch (error) { failure = error }
  assert(failure instanceof AggregateError); assert.match(failure.errors[0]?.message ?? '', /Host shutdown timed out/u)
  assert.match(failure.errors[1]?.message ?? '', /synthetic material cleanup failure/u)
  assert.equal(cleanupAttempts, 1); assert.deepEqual(failure.outcome, { code: null, signal: 'SIGKILL' })
  assertProcessGone(host.pid); assert.deepEqual(readdirSync(runtimeParent), [])
  complete = true
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
