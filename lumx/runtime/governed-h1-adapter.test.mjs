import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGovernedH1Profile, GOVERNED_H1_PRIVACY_ROWS } from '../profiles/governed-h1-profile.mjs'
import { installGovernedH1Runtime } from './governed-h1-adapter.mjs'

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
  assert.deepEqual(installed.snapshot(), { brokerInvocations: [], modelRequests: [] })
  installed.release()
  assert.doesNotThrow(() => installGovernedH1Runtime({ runtimeId: 'good', brokerEndpoint: 'http://127.0.0.1:1', modelEndpoint: 'http://127.0.0.1:2' }).release())
})
