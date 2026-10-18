import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildLumxNativeBootstrap, buildLumxNativeFdHarness } from './native/build.mjs'

const NODE = '/Users/jinlong/.local/opt/node-v24.20.0/bin/node'

function run(executable, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { ...options, stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout?.setEncoding('utf8'); child.stdout?.on('data', value => { stdout += value })
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', value => { stderr += value })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stderr, stdout }))
    options.input === undefined ? child.stdin?.end() : child.stdin?.end(options.input)
  })
}

test('native bootstrap rejects truncated control input before sandbox or Node execution', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-bootstrap-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const marker = join(root, 'must-not-exist')
  const fakeSandbox = join(root, 'sandbox-exec')
  writeFileSync(fakeSandbox, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 })
  const bootstrap = buildLumxNativeBootstrap(join(root, 'bootstrap'))
  const result = await run(bootstrap, [fakeSandbox, '/tmp/profile', NODE, '/tmp/entry', '/tmp/config'], { input: 'LUMX_BOOT' })
  assert.equal(result.code, 70)
  assert.match(result.stderr, /control-frame/)
  assert.throws(() => readFileSync(marker))
})

test('native adversarial descriptors are closed by the supported Host chain', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-native-boundary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const canary = join(root, 'protected-canary')
  const nativeReceipt = join(root, 'native-receipt.json')
  const output = join(root, 'probe.json')
  writeFileSync(canary, 'native-host-canary\n', { mode: 0o600 })
  const harness = buildLumxNativeFdHarness(join(root, 'fd-harness'))
  const probe = fileURLToPath(new URL('../probes/native-host-boundary-probe.mjs', import.meta.url))
  const result = await run(harness, [NODE, probe, output, nativeReceipt, canary], { stdio: 'ignore' })
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null })
  const native = JSON.parse(readFileSync(nativeReceipt, 'utf8'))
  const evidence = JSON.parse(readFileSync(output, 'utf8'))
  assert.deepEqual({ nativeVerified: native.nativeVerified, bytes: native.bytes, contentMatched: native.contentMatched }, {
    nativeVerified: true, bytes: 19, contentMatched: true,
  })
  assert.deepEqual(evidence.attackerObservation.map(value => [value.fd, value.canaryRecovered]), [
    [0, true], [1, true], [2, true], [3, true], [10, true], [11, true], [512, true],
  ])
  assert.equal(evidence.hostObservation.some(value => value.canaryRecovered), false)
  assert.equal(evidence.childObservation.observations.some(value => value.canaryRecovered), false)
  assert.equal(evidence.oldDirect.observations[0].canaryRecovered, true)
  assert.deepEqual(Object.values(evidence.protectedPathErrors), ['EPERM', 'EPERM', 'EPERM'])
  assert.equal(evidence.readyStatus, 303)
  assert.equal(evidence.positive.status, 'pass')
  assert.equal(evidence.denied.status, 'fail')
  assert.equal(evidence.unauthorizedProviderIo, 0)
  assert.equal(evidence.repeatedShutdownSamePromise, true)
  assert.deepEqual(evidence.shutdown, { code: 0, signal: null, control: { stopping: true } })
})
