import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { installLumxByokRuntime } from '../runtime/byok-plugin.mjs'
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
})
