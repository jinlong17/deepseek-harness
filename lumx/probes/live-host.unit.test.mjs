import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { apply as applyLumxByok, installLumxByokRuntime, readLumxByokAdmissionObservations } from '../runtime/byok-plugin.mjs'
import { createLumxRuntimeProfile, LUMX_RUNTIME_BUNDLES } from '../runtime/profile.mjs'

test('runtime profile fixes the official bundles and exact privacy rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lumx-profile-'))
  try {
    const profile = await createLumxRuntimeProfile({
      dataHomeDirectory: root,
      profileName: 'lumx',
      runtimeId: 'unit-runtime',
      sourceRoot: '/synthetic/pinned-source',
    })
    assert.deepEqual(LUMX_RUNTIME_BUNDLES, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const privacy = await readFile(join(profile.profileDirectory, 'cordis.patch.yml'), 'utf8')
    assert.deepEqual([...privacy.matchAll(/^- id: (.+)$/gm)].map(match => match[1]), [
      'session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
      'deepseek-account', 'llm-deepseek-account', 'desktop-product-telemetry', 'product-analytics',
    ])
    const runtime = await readFile(profile.runtimePatch, 'utf8')
    assert.match(runtime, /id: lumx-byok/)
    assert.match(runtime, /provider: lumx-byok/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime state accepts literal loopback only and releases its id', () => {
  const input = {
    runtimeId: 'unit', byokKey: 'synthetic', endpoint: 'http://127.0.0.1:19402/model',
    gateway: {}, getIdentity: () => undefined,
  }
  const release = installLumxByokRuntime(input)
  assert.throws(() => installLumxByokRuntime(input), /already installed/)
  release()
  assert.doesNotThrow(() => installLumxByokRuntime(input)())
  assert.throws(() => installLumxByokRuntime({ ...input, runtimeId: 'bad', endpoint: 'http://localhost/model' }), /literal IPv4/)
  assert.throws(() => installLumxByokRuntime({ runtimeId: 'relay-missing', byokKey: 'capability', endpoint: 'http://127.0.0.1:19402/model', relayOnly: true }), /requires supervisor admission/)
})

test('relay-only alternate calls revalidate while the main provider remains relay-gated', async () => {
  let admissions = 0; let adapterEffects = 0; let allowed = true; let hook
  const root = {}; const runtimeId = 'relay-fresh-unit'
  const release = installLumxByokRuntime({ runtimeId, byokKey: 'capability', endpoint: 'http://127.0.0.1:19402/model', relayOnly: true,
    async admitOtherProvider() { admissions += 1; if (!allowed) { const error = new Error('denied'); error.code = 'identity_required'; throw error } } })
  const ctx = { root, llm: { registerAdapter() { return () => {} } }, on(name, value) { if (name === 'llm/stream') hook = value } }
  try {
    await applyLumxByok(ctx, { runtimeId, sourceRoot: resolve(import.meta.dirname, '../..') })
    const invoke = async provider => {
      const next = async function * () { adapterEffects += 1; yield { type: 'finish', reason: { kind: 'stop' } } }
      for await (const _chunk of hook({ messages: [], model: 'unit', provider }, next)) { /* drain */ }
    }
    await invoke('alternate-one'); await invoke('alternate-two')
    assert.equal(admissions, 2); assert.equal(adapterEffects, 2)
    allowed = false
    await assert.rejects(async () => invoke('alternate-three'), error => error?.code === 'identity_required')
    assert.equal(admissions, 3); assert.equal(adapterEffects, 2)
    await invoke('lumx-byok')
    assert.equal(admissions, 3); assert.equal(adapterEffects, 3)
    assert.deepEqual(readLumxByokAdmissionObservations(ctx).map(row => row.result), ['admitted', 'admitted', 'denied', 'deferred'])
  } finally { release() }
})
