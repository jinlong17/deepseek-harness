import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { launchLumxRuntimeInProcess } from '../runtime/internal-launch.mjs'
import { qualifyPrivacyLifecycle } from './b5-host-privacy-qualification.mjs'

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

test('privacy qualification keeps seven protected rows while exercising same-package child alias lifecycle', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'lumx-b5-protected-lifecycle-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const runtime = await launchLumxRuntimeInProcess(await input(directory))
  t.after(runtime.shutdown)
  const facts = await qualifyPrivacyLifecycle(runtime.ctx)
  const ids = facts.privacyIds
  assert.equal(ids.length, 7)
  assert.equal(new Set(ids).size, 7)
  assert.equal(facts.protectedActions.length, ids.length)
  assert.equal(facts.aliasActions.length, ids.length)
  for (const id of ids) {
    const protectedRow = facts.protectedActions.find(row => row.id === id)
    const alias = facts.aliasActions.find(row => row.originalId === id)
    assert.deepEqual(
      {
        id: protectedRow.id, executed: protectedRow.executed, updateDisabled: protectedRow.updateDisabled,
        removeRejected: protectedRow.removeRejected, retainedSameEntry: protectedRow.retainedSameEntry,
        retainedSameOptions: protectedRow.retainedSameOptions, retainedSameIdentity: protectedRow.retainedSameIdentity, retainedInactive: protectedRow.retainedInactive,
      },
      { id, executed: true, updateDisabled: true, removeRejected: true, retainedSameEntry: true, retainedSameOptions: true, retainedSameIdentity: true, retainedInactive: true },
    )
    assert.match(protectedRow.removalError.message, new RegExp(`governance denied include:${id}: protected row cannot be removed`, 'u'))
    assert.deepEqual(
      {
        originalId: alias.originalId, executed: alias.executed, createdSameIdentity: alias.createdSameIdentity, createdInactive: alias.createdInactive,
        enableRejected: alias.enableRejected, afterEnableInactive: alias.afterEnableInactive, absentAfterRemove: alias.absentAfterRemove,
        reinstallSameIdentity: alias.reinstallSameIdentity, reinstallInactive: alias.reinstallInactive,
      },
      { originalId: id, executed: true, createdSameIdentity: true, createdInactive: true, enableRejected: true, afterEnableInactive: true, absentAfterRemove: true, reinstallSameIdentity: true, reinstallInactive: true },
    )
  }
  assert.equal(facts.aliasCleanup.groupAbsent, true)
  assert.ok(facts.aliasCleanup.aliases.every(row => row.absent === true))
  assert.ok(facts.final.every(row => row.resolved && row.disabled && !row.fiberPresent))
})
