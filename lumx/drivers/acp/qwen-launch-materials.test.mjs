import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { sha256File, treeSha256 } from '../../build/candidate-manifest.mjs'
import { prepareQwenLaunch, verifyQwenLaunch } from './qwen-launch-materials.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lumx-qwen-launch-'))
  const nodePath = join(root, 'node'); const qwenRoot = join(root, 'qwen')
  const qwenCliPath = join(qwenRoot, 'cli.js'); const runtime = join(root, 'runtime'); const workspace = join(root, 'workspace')
  mkdirSync(qwenRoot); mkdirSync(runtime); mkdirSync(workspace)
  writeFileSync(nodePath, 'fixed-node-bytes\n'); writeFileSync(qwenCliPath, 'fixed-cli-bytes\n')
  t.after(() => { try { chmodSync(join(runtime, 'frozen-engine'), 0o700) } catch {}; rmSync(root, { recursive: true, force: true }) })
  return { nodePath, nodeSha256: sha256File(nodePath), qwenCliPath, qwenCliSha256: sha256File(qwenCliPath),
    qwenRoot, qwenTreeSha256: treeSha256(qwenRoot), relayPort: 43123, runtime, workspace }
}

test('prepares immutable launch inputs while allowing mutable Qwen state to evolve', t => {
  const input = fixture(t); const materials = prepareQwenLaunch(input)
  assert.equal(statSync(materials.paths.frozen).mode & 0o777, 0o500)
  assert.equal(verifyQwenLaunch(materials, { requireInitialState: true }), materials)
  writeFileSync(materials.paths.settings, '{"persisted":true}\n')
  assert.equal(verifyQwenLaunch(materials), materials)
  assert.throws(() => verifyQwenLaunch(materials, { requireInitialState: true }), /initial mutable settings/)
  chmodSync(materials.paths.frozen, 0o700)
  chmodSync(materials.paths.profilePath, 0o600)
  writeFileSync(materials.paths.profilePath, 'tampered profile\n')
  assert.throws(() => verifyQwenLaunch(materials), /profile differs/)
})

test('rejects a Qwen CLI outside the caller-anchored package tree', t => {
  const input = fixture(t); const outside = join(input.runtime, 'outside-cli.js')
  writeFileSync(outside, 'outside\n')
  assert.throws(() => prepareQwenLaunch({ ...input, qwenCliPath: outside, qwenCliSha256: sha256File(outside) }), /escapes caller-anchored root/)
})

test('a preparation failure removes only launch directories it acquired', t => {
  const input = fixture(t)
  assert.throws(() => prepareQwenLaunch({ ...input, relayPort: 0 }), /relay port is invalid/)
  assert.equal(existsSync(join(input.runtime, 'frozen-engine')), false)
  assert.equal(existsSync(join(input.runtime, 'engine-state')), false)
})
