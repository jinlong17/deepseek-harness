import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { installLumxActivationGuards, installLumxGovernance } from './governance.mjs'
import { launchLumxRuntimeInProcess } from './internal-launch.mjs'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const BASELINE = '/Users/jinlong/.codex/worktrees/a2k-desktop-p1a-gate1/.local/g9-1/deps-source'

async function freePort() {
  const server = createServer((_, response) => response.end())
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function input(root, sourceRoot, t) {
  const osHome = join(root, 'home'); const workspaceDirectory = join(root, 'workspace')
  mkdirSync(osHome); mkdirSync(workspaceDirectory)
  let admissionCalls = 0
  t.after(() => assert.equal(admissionCalls, 0, 'governance fixture must not request alternate-provider admission'))
  return {
    mode: 'developer', osHome, workspaceDirectory, sourceRoot, port: await freePort(),
    auth: {
      byokKey: 'synthetic-relay-capability', endpoint: 'http://127.0.0.1:9/v1/chat/completions', relayOnly: true,
      async admitOtherProvider() {
        admissionCalls += 1
        const error = new Error('governance fixture does not admit alternate providers')
        error.code = 'identity_required'
        throw error
      },
    },
    environment: {},
  }
}

test('actual candidate composition denies late mutations and shuts down cleanly', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-governance-actual-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtime = await launchLumxRuntimeInProcess(await input(root, ROOT, t))
  t.after(runtime.shutdown)
  assert.equal(runtime.governance.rows.length, 7)
  assert(runtime.governance.rows.every(row => row.generation === 1 && row.format === 'module' && row.url.endsWith('/lib/index.js')))
  const target = runtime.governance.rows[0]
  const entry = [...runtime.ctx.loader.entries()].find(value => value.options.id === target.id)
  assert(entry)
  const group = entry.parent
  await group.update(group.data.map(row => row.id === target.id
    ? { ...row, config: { governanceRevision: 1 } }
    : row))
  const original = entry.options
  assert.equal(group.data.find(row => row.id === target.id), original)
  await group.update(group.data.map(row => row.id === target.id ? { ...row, disabled: false } : row))
  assert.equal(entry.disabled, true)
  assert.equal(entry.options, original)
  assert.equal(group.data.find(row => row.id === target.id), original)
  assert.throws(() => group.remove(target.id), /cannot be removed/)
  await assert.rejects(group.create({ name: target.url }), /aliases protected identity/)
  await group.update(group.data.map(row => row.id === target.id ? { ...row, name: 'cordis:timer' } : row))
  assert.equal(entry.options, original)
  await group.update([
    ...group.data.filter(row => row.id !== target.id),
    { id: `${target.id}-renamed`, name: target.specifier },
  ])
  assert.equal(entry.options, original)
  assert.equal(group.data.some(row => row.id === `${target.id}-renamed`), false)

  const containerId = await runtime.ctx.loader.create({ name: 'cordis:group', group: true, config: [] })
  await runtime.ctx.loader.await()
  const childGroup = runtime.ctx.loader.resolve(containerId).subgroup
  assert(childGroup)
  await childGroup.update([{ id: 'child-protected-alias', name: target.specifier, disabled: true }])
  const child = runtime.ctx.loader.store['child-protected-alias']
  assert(child)
  assert.equal(Object.getPrototypeOf(child.ctx), child.parent.ctx)
  const childOptions = child.options
  await childGroup.update([{ ...childOptions, disabled: false }])
  assert.equal(child.options, childOptions)
  assert.equal(childGroup.data[0], childOptions)
  assert.equal(child.disabled, true)
  assert.equal(child.fiber, undefined)
  childGroup.remove('child-protected-alias')
  assert.equal(childGroup.data.length, 0)
  await childGroup.update([{ id: 'child-protected-alias', name: target.specifier, disabled: true }])
  assert.equal(childGroup.data[0], runtime.ctx.loader.store['child-protected-alias'].options)
  assert.deepEqual(await runtime.shutdown(), {})
})

test('actual candidate rejects later resolver generation changes before unrelated admission or direct activation', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-governance-generation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtime = await launchLumxRuntimeInProcess(await input(root, ROOT, t))
  t.after(runtime.shutdown)
  const internal = runtime.ctx.loader.internal
  runtime.ctx.loader.internal = new Proxy(internal, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  await assert.rejects(runtime.ctx.loader.create({ name: 'cordis:timer' }), /resolver identity change/)
  assert.equal(Object.values(runtime.ctx.loader.store).some(entry => entry.options.name === 'cordis:timer'), false)
  assert.throws(() => runtime.ctx.plugin(() => {}), /resolver identity change/)
  await runtime.shutdown()
})

test('baseline launcher without required setup seam refuses readiness', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-governance-old-loader-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const priorExitCode = process.exitCode
  try {
    await assert.rejects(launchLumxRuntimeInProcess(await input(root, BASELINE, t)), /setup was not invoked/)
  } finally {
    process.exitCode = priorExitCode
  }
})

test('actual forbidden package is cache-discovered by non-governed guards and governed preload refusal', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-governance-package-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtime = await launchLumxRuntimeInProcess(await input(root, ROOT, t))
  t.after(runtime.shutdown)
  const target = runtime.governance.rows.find(row => row.id === 'product-analytics')
  assert(target)
  let networkAttempts = 0
  const fetch = globalThis.fetch
  globalThis.fetch = () => {
    networkAttempts += 1
    throw new Error('test fixture denies network')
  }
  try {
    const preloadIdentity = runtime.ctx.loader.resolveEntry(target.specifier, runtime.ctx.loader.ctx.baseUrl)
    assert(preloadIdentity)
    await runtime.ctx.loader.internal.import(target.specifier, runtime.ctx.loader.ctx.baseUrl, {})
    const discovered = runtime.ctx.loader.loadedPlugin(preloadIdentity)
    assert.equal(typeof discovered, 'function')
    assert.deepEqual(runtime.ctx.loader.identitiesOf(discovered), [target.url])

    const [{ Context }, { default: Loader }] = await Promise.all([
      import('../../vendor/cordis/lib/index.js'),
      import('../../vendor/loader/lib/index.js'),
    ])
    const control = new Context()
    let unguardedActivations = 0
    let telemetryEmissions = 0
    control.provide('deepseekAccount', { getDeviceIdentity: async () => undefined })
    control.provide('webServer', {})
    control.provide('productTelemetry', { emit() { telemetryEmissions += 1 } })
    control.on('internal/plugin', (fiber) => {
      if (fiber.runtime?.callback === discovered) unguardedActivations += 1
    }, { global: true, prepend: true })
    await control.plugin(discovered, { enabled: false, appVersion: 'network-denied-fixture' }).await()
    assert.equal(unguardedActivations, 1)
    assert(control.get('productAnalytics'))
    assert.equal(telemetryEmissions, 0)
    assert.equal(networkAttempts, 0)
    await control.fiber.dispose()

    const nonGoverned = new Context()
    nonGoverned.baseUrl = runtime.ctx.loader.ctx.baseUrl
    await nonGoverned.plugin(Loader, { baseUrl: runtime.ctx.loader.ctx.baseUrl }).await()
    const identity = nonGoverned.loader.resolveEntry(target.specifier, nonGoverned.loader.ctx.baseUrl)
    assert(identity)
    const callback = nonGoverned.loader.loadedPlugin(identity)
    assert.equal(callback, discovered)
    installLumxActivationGuards(nonGoverned, { urls: [identity] })
    let allowed = 0
    await nonGoverned.plugin(() => { allowed += 1 }).await()
    assert.equal(allowed, 1)
    assert.throws(() => nonGoverned.plugin(callback), /direct protected callback activation/)
    assert.equal(networkAttempts, 0)

    const governed = new Context()
    governed.baseUrl = runtime.ctx.loader.ctx.baseUrl
    await governed.plugin(Loader, { baseUrl: runtime.ctx.loader.ctx.baseUrl }).await()
    assert.throws(() => installLumxGovernance(governed), /forbidden module already loaded: product-analytics/)
    await governed.fiber.dispose()
    await nonGoverned.fiber.dispose()
  } finally {
    globalThis.fetch = fetch
    await runtime.shutdown()
  }
})
