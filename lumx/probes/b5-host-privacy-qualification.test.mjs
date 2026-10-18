import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { launchLumxRuntimeInProcess } from '../runtime/internal-launch.mjs'
import { PRIVACY_ALIAS_GROUP_ID, privacyLifecycleComplete, privacyOriginalRowsInert, qualifyPrivacyLifecycle } from './b5-host-privacy-qualification.mjs'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

async function freePort() {
  const server = createServer((_request, response) => response.end())
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function input(directory) {
  return {
    auth: { byokKey: 'synthetic-relay-capability', endpoint: 'http://127.0.0.1:9/v1/chat/completions', relayOnly: true },
    environment: {}, mode: 'consumer', osHome: join(directory, 'home'), port: await freePort(), sourceRoot: root, workspaceDirectory: join(directory, 'workspace'),
  }
}

async function runtime(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lumx-b5-protected-lifecycle-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const value = await launchLumxRuntimeInProcess(await input(directory))
  t.after(value.shutdown)
  return value
}

function copy(value) { return JSON.parse(JSON.stringify(value)) }
function protectedEntry(ctx, id) { return [...ctx.loader.entries()].find(entry => entry.options.id === id) }
function assertOriginalRowsIntact(ctx, ids) {
  for (const id of ids) {
    const entry = protectedEntry(ctx, id)
    assert.ok(entry, `missing protected row ${id}`)
    const resolution = entry.loader.resolveEntry(entry.options.name, entry.parent.tree.ctx.baseUrl)
    assert.ok(resolution?.url)
    assert.equal(entry.disabled, true)
    assert.equal(entry.fiber, undefined)
    assert.equal(entry.loader.loadedPlugin(resolution), undefined)
  }
}

function assertStrictPredicateRejects(facts, mutate) {
  const altered = copy(facts); mutate(altered)
  assert.equal(privacyLifecycleComplete(altered), false)
}

test('privacy qualification keeps seven protected rows while exercising same-package child alias lifecycle', { timeout: 30_000 }, async t => {
  const value = await runtime(t)
  const facts = await qualifyPrivacyLifecycle(value.ctx)
  const ids = facts.privacyIds
  assert.equal(ids.length, 7)
  assert.equal(new Set(ids).size, 7)
  assert.equal(privacyOriginalRowsInert(facts), true)
  assert.equal(privacyLifecycleComplete(facts), true)
  for (const id of ids) {
    const protectedRow = facts.protectedActions.find(row => row.id === id)
    const alias = facts.aliasActions.find(row => row.originalId === id)
    assert.equal(protectedRow.package, alias.package)
    assert.deepEqual(protectedRow.packageIdentity, alias.packageIdentity)
    assert.match(protectedRow.removalError.message, new RegExp(`governance denied include:${id}: protected row cannot be removed`, 'u'))
    for (const state of [protectedRow.before, protectedRow.updated, protectedRow.retained, alias.created, alias.updated, alias.afterEnable, alias.reinstalled]) {
      assert.equal(state.id === id || state.id === alias.id, true)
      assert.equal(state.disabled, true)
      assert.equal(state.fiberPresent, false)
      assert.equal(state.unevaluated, true)
      assert.equal(typeof state.identity.url, 'string')
      assert.ok(state.identity.url.length > 0)
      assert.equal(typeof state.identity.format, 'string')
      assert.ok(state.identity.format.length > 0)
      assert.equal(Number.isInteger(state.identity.generation), true)
    }
    assert.equal(alias.updatedSameEntry, true)
    assert.equal(alias.absentInLoader, true)
    assert.equal(alias.absentInGroupData, true)
    assert.equal(alias.enableOutcome, 'governance-error')
    assert.equal(alias.afterEnableSameEntry, true)
    assert.equal(alias.afterEnableSameOptions, true)
    assert.match(alias.enableError.message, /module aliases protected identity/u)
  }
  assert.deepEqual(facts.aliasCleanup.groupId, PRIVACY_ALIAS_GROUP_ID)
  assert.equal(facts.aliasCleanup.groupAbsent, true)
  assert.ok(facts.aliasCleanup.aliases.every(row => row.absent === true))
  assert.equal(facts.lateEnable.rejected, true)
  assert.match(facts.lateEnable.error.message, /include:product-analytics: protected row must remain disabled/u)
  assertOriginalRowsIntact(value.ctx, ids)

  assertStrictPredicateRejects(facts, value => { value.privacyIds = [] })
  assertStrictPredicateRejects(facts, value => { value.protectedActions[1].id = value.protectedActions[0].id })
  assertStrictPredicateRejects(facts, value => { value.protectedActions[0].retained.package = 'cordis:timer' })
  assertStrictPredicateRejects(facts, value => { value.aliasActions[0].package = 'cordis:timer' })
  assertStrictPredicateRejects(facts, value => {
    const wrong = 'cordis:timer'
    const id = value.protectedActions[0].id
    value.protectedActions[0].package = wrong
    for (const state of [value.protectedActions[0].before, value.protectedActions[0].updated, value.protectedActions[0].retained, value.initial.find(row => row.id === id), value.final.find(row => row.id === id)]) state.package = wrong
    const alias = value.aliasActions[0]; alias.package = wrong
    for (const state of [alias.created, alias.updated, alias.afterEnable, alias.reinstalled]) state.package = wrong
  })
  assertStrictPredicateRejects(facts, value => { value.aliasActions[0].updated.id = value.aliasActions[1].id })
  assertStrictPredicateRejects(facts, value => { value.protectedActions[0].updated.identity.url = 'file:///wrong.mjs' })
  assertStrictPredicateRejects(facts, value => { value.aliasActions[0].afterEnableSameOptions = false })
  assertStrictPredicateRejects(facts, value => { value.aliasActions[0].reinstalled.identity.url = '' })
  assertStrictPredicateRejects(facts, value => { value.aliasActions[0].updated.disabled = false })
  assertStrictPredicateRejects(facts, value => { value.aliasActions[0].absentInLoader = false })
  assertStrictPredicateRejects(facts, value => { value.aliasActions[0].reinstalled.present = false })
  assertStrictPredicateRejects(facts, value => { value.aliasCleanup.aliases[0].absent = false })
})

test('privacy qualification rejects a collision on its fixed group ID', { timeout: 30_000 }, async t => {
  const value = await runtime(t)
  const created = await value.ctx.loader.create({ id: PRIVACY_ALIAS_GROUP_ID, name: 'cordis:group', group: true, config: [] })
  await value.ctx.loader.await()
  assert.equal(created, PRIVACY_ALIAS_GROUP_ID)
  await assert.rejects(qualifyPrivacyLifecycle(value.ctx), /privacy qualification alias collision/)
  assert.equal(protectedEntry(value.ctx, PRIVACY_ALIAS_GROUP_ID)?.options.id, PRIVACY_ALIAS_GROUP_ID)
})

test('privacy qualification cleans owned aliases and group after a mid-alias failure', { timeout: 30_000 }, async t => {
  const value = await runtime(t)
  const resolve = value.ctx.loader.resolve.bind(value.ctx.loader)
  const failure = new Error('injected mid-alias failure')
  let updates = 0
  value.ctx.loader.resolve = id => {
    const result = resolve(id)
    if (id !== PRIVACY_ALIAS_GROUP_ID || result?.subgroup === undefined) return result
    const subgroup = result.subgroup
    return new Proxy(result, {
      get(target, property, receiver) {
        if (property !== 'subgroup') return Reflect.get(target, property, receiver)
        return new Proxy(subgroup, {
          get(group, member, groupReceiver) {
            const selected = Reflect.get(group, member, groupReceiver)
            if (member !== 'update') return typeof selected === 'function' ? selected.bind(group) : selected
            return async (...arguments_) => {
              updates += 1
              if (updates === 5) throw failure
              return await selected.apply(group, arguments_)
            }
          },
        })
      },
    })
  }
  t.after(() => {
    if (value.ctx?.loader !== undefined) value.ctx.loader.resolve = resolve
  })
  await assert.rejects(qualifyPrivacyLifecycle(value.ctx), cause => cause === failure)
  assert.equal(updates, 5)
  assert.equal(protectedEntry(value.ctx, PRIVACY_ALIAS_GROUP_ID), undefined)
  assert.equal([...value.ctx.loader.entries()].some(entry => entry.options.id.startsWith('lumx-b5-privacy-alias-')), false)
  assertOriginalRowsIntact(value.ctx, [
    'session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
    'deepseek-account', 'llm-deepseek-account', 'desktop-product-telemetry', 'product-analytics',
  ])
})

test('privacy qualification removes its fixed group when create rejects after allocation', { timeout: 30_000 }, async t => {
  const value = await runtime(t)
  const loader = value.ctx.loader
  const create = loader.create.bind(loader)
  const failure = new Error('injected create rejection after allocation')
  loader.create = async options => {
    const created = await create(options)
    if (options.id === PRIVACY_ALIAS_GROUP_ID) throw failure
    return created
  }
  t.after(() => { loader.create = create })
  await assert.rejects(qualifyPrivacyLifecycle(value.ctx), cause => cause === failure)
  assert.equal(protectedEntry(value.ctx, PRIVACY_ALIAS_GROUP_ID), undefined)
  assert.equal([...value.ctx.loader.entries()].some(entry => entry.options.id.startsWith('lumx-b5-privacy-alias-')), false)
  assertOriginalRowsIntact(value.ctx, [
    'session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
    'deepseek-account', 'llm-deepseek-account', 'desktop-product-telemetry', 'product-analytics',
  ])
})
