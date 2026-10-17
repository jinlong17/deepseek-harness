import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createLumxLaunchEnvironment, resolveLumxLaunchEnvironment } from './launch-environment.mjs'
import { createLumxElectronBuilderOverlay } from './release-config.mjs'

test('consumer launch uses a synthetic home and external workspace without writing either', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-launch-'))
  try {
    const osHome = join(root, 'synthetic-home')
    const workspaceDirectory = join(root, 'workspace')
    const launch = createLumxLaunchEnvironment({ mode: 'consumer', osHome, workspaceDirectory })
    assert.equal(launch.homeDirectory, join(osHome, '.lumx'))
    assert.equal(launch.dataHomeDirectory, join(osHome, '.lumx'))
    assert.equal(launch.profile, 'consumer')
    assert.equal(launch.workspaceDirectory, workspaceDirectory)
    assert.deepEqual(launch.agentPriority, ['codex', 'claude-agent'])
    assert.equal(launch.telemetry.enabled, true)
    assert.equal(existsSync(launch.homeDirectory), false)
    assert.equal(existsSync(workspaceDirectory), false)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('developer launch owns a distinct data home and permits the telemetry switch', () => {
  const launch = createLumxLaunchEnvironment({
    environment: { LUMX_TELEMETRY_ENABLED: 'off' },
    mode: 'developer',
    osHome: '/synthetic/developer-home',
    workspaceDirectory: '/synthetic/project',
  })
  assert.equal(launch.homeDirectory, '/synthetic/developer-home/.lumx-developer')
  assert.equal(launch.dataHomeDirectory, '/synthetic/developer-home/.lumx-developer')
  assert.equal(launch.profile, 'developer')
  assert.equal(launch.workspaceDirectory, '/synthetic/project')
  assert.deepEqual(launch.telemetry, { enabled: false, implementation: 'configuration-only' })
})

test('launch rejects either protected data home, including a child named ..cache', () => {
  assert.throws(() => createLumxLaunchEnvironment({
    mode: 'consumer', osHome: '/synthetic', workspaceDirectory: '/synthetic/.lumx-developer/workspace',
  }), /outside every LUMX data home/)
  assert.throws(() => createLumxLaunchEnvironment({
    mode: 'developer', osHome: '/synthetic', workspaceDirectory: '/synthetic/.lumx/workspace',
  }), /outside every LUMX data home/)
  assert.throws(() => resolveLumxLaunchEnvironment({
    homeDirectory: '/synthetic/.lumx', mode: 'consumer', workspaceDirectory: '/synthetic/.lumx/..cache',
  }), /outside every LUMX data home/)
})

test('launch rejects invalid telemetry text', () => {
  assert.throws(() => createLumxLaunchEnvironment({
    environment: { LUMX_TELEMETRY_ENABLED: 'maybe' }, mode: 'consumer', osHome: '/synthetic', workspaceDirectory: '/workspace',
  }), /LUMX_TELEMETRY_ENABLED/)
})

test('electron builder overlay is consumable and does not mutate a downstream config', () => {
  const base = { artifactName: 'downstream-${version}', protocols: [{ name: 'Other', schemes: ['other'] }] }
  const overlay = createLumxElectronBuilderOverlay(base)
  assert.equal(base.protocols[0].name, 'Other')
  assert.deepEqual(overlay.protocols, [{ name: 'LUMX Desktop', schemes: ['lumx'] }])
  assert.equal(overlay.appId, 'com.lumxai.desktop')
})
