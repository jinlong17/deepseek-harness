import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLumxRuntimeProfile } from './profile.mjs'

test('desktop platform-stub profile stays product-owned and contains no BYOK adapter', async t => {
  const home = await mkdtemp(join(tmpdir(), 'lumx-platform-stub-'))
  t.after(() => rm(home, { force: true, recursive: true }))
  const profile = await createLumxRuntimeProfile({ consumer: 'platform-stub', dataHomeDirectory: home, profileName: 'stub', runtimeId: 'ignored', sourceRoot: '/source' })
  const patch = await readFile(profile.runtimePatch, 'utf8')
  assert.equal(profile.consumer, 'platform-stub')
  assert.match(patch, /id: hmr/)
  assert.doesNotMatch(patch, /lumx-byok/)
})
