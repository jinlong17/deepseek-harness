import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { sha256File, treeSha256 } from '../../build/candidate-manifest.mjs'
import { buildLumxNativeGuardian } from '../../desktop/native/build.mjs'
import { QWEN_SETTINGS, qwenSandboxProfile } from './qwen-feasibility.mjs'

function inside(path, root) {
  const value = relative(root, path)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`))
}
function exactPort(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error('Qwen relay port is invalid')
  return value
}
function file(path, expected, label) {
  const actual = sha256File(path)
  if (actual !== expected) throw new Error(`${label} differs from frozen launch material`)
}
function directoryIdentity(path) {
  const link = lstatSync(path); if (link.isSymbolicLink() || !link.isDirectory()) throw new Error('Qwen mutable launch path is not a direct directory')
  const value = statSync(path)
  return Object.freeze({ dev: value.dev, ino: value.ino, path: realpathSync(path) })
}

/** Prepare and freeze every file consumed by a later Qwen launch. */
export function prepareQwenLaunch(input) {
  const runtime = realpathSync(input.runtime)
  const workspace = realpathSync(input.workspace)
  const nodePath = realpathSync(input.nodePath)
  const qwenRoot = realpathSync(input.qwenRoot)
  const qwenCliPath = realpathSync(input.qwenCliPath)
  if (!inside(qwenCliPath, qwenRoot)) throw new Error('Qwen CLI escapes caller-anchored root')
  if (sha256File(nodePath) !== input.nodeSha256) throw new Error('Node differs from caller anchor')
  if (sha256File(qwenCliPath) !== input.qwenCliSha256) throw new Error('Qwen CLI differs from caller anchor')
  if (treeSha256(qwenRoot) !== input.qwenTreeSha256) throw new Error('Qwen tree differs from caller anchor')
  const launchId = input.launchId ?? randomUUID()
  const frozen = join(runtime, 'frozen-engine')
  const state = join(runtime, 'engine-state')
  const paths = { frozen, state, home: join(state, 'home'), qwenHome: join(state, 'qwen-home'), tmp: join(state, 'tmp'), workspace }
  let acquiredFrozen = false; let acquiredState = false
  try {
    mkdirSync(frozen, { mode: 0o700 }); acquiredFrozen = true
    mkdirSync(state, { mode: 0o700 }); acquiredState = true
    for (const path of [paths.home, paths.qwenHome, paths.tmp]) mkdirSync(path, { mode: 0o700 })
    const settingsTemplate = join(frozen, 'settings.json'); const settings = join(paths.qwenHome, 'settings.json')
    writeFileSync(settingsTemplate, QWEN_SETTINGS, { mode: 0o400 }); writeFileSync(settings, QWEN_SETTINGS, { mode: 0o600 })
    const guardian = buildLumxNativeGuardian(join(frozen, 'lumx-engine-guardian'))
    const profilePath = join(frozen, 'engine.sb')
    const profile = qwenSandboxProfile({ nodePath, qwenRoot, relayPort: exactPort(input.relayPort), runtime, workspace,
      writable: [state, workspace], frozen: [frozen] })
    writeFileSync(profilePath, profile, { mode: 0o400 }); chmodSync(frozen, 0o500)
    const mutablePaths = Object.freeze(Object.fromEntries(['state', 'home', 'qwenHome', 'tmp'].map(name => [name, directoryIdentity(paths[name])])))
    const anchors = Object.freeze({ nodeSha256: input.nodeSha256, qwenCliSha256: input.qwenCliSha256, qwenTreeSha256: input.qwenTreeSha256,
      guardianSha256: sha256File(guardian), profileSha256: sha256File(profilePath), settingsSha256: sha256File(settingsTemplate), mutablePaths })
    return Object.freeze({ anchors, launchId, nodePath, paths: Object.freeze({ ...paths, guardian, profilePath, settings, settingsTemplate }), qwenCliPath, qwenRoot,
      relayPort: input.relayPort })
  } catch (error) {
    if (acquiredFrozen) { try { chmodSync(frozen, 0o700) } catch {}; rmSync(frozen, { recursive: true, force: true }) }
    if (acquiredState) rmSync(state, { recursive: true, force: true })
    throw error
  }
}

/** Revalidate immutable launch inputs immediately before any executable runs. */
export function verifyQwenLaunch(materials, { requireInitialState = false } = {}) {
  file(materials.nodePath, materials.anchors.nodeSha256, 'Node')
  file(materials.qwenCliPath, materials.anchors.qwenCliSha256, 'Qwen CLI')
  file(materials.paths.guardian, materials.anchors.guardianSha256, 'Qwen guardian')
  file(materials.paths.profilePath, materials.anchors.profileSha256, 'Qwen profile')
  file(materials.paths.settingsTemplate, materials.anchors.settingsSha256, 'Qwen settings template')
  const state = materials.anchors.mutablePaths.state.path
  for (const name of ['state', 'home', 'qwenHome', 'tmp']) {
    const current = directoryIdentity(materials.paths[name]); const expected = materials.anchors.mutablePaths[name]
    if (current.path !== expected.path || current.dev !== expected.dev || current.ino !== expected.ino) throw new Error(`Qwen ${name} differs from frozen mutable path identity`)
    if (name !== 'state' && !inside(current.path, state)) throw new Error(`Qwen ${name} escapes mutable state root`)
  }
  if (lstatSync(materials.paths.settings).isSymbolicLink() || !inside(realpathSync(materials.paths.settings), realpathSync(materials.paths.qwenHome))) {
    throw new Error('Qwen settings escapes mutable state root')
  }
  if (requireInitialState) file(materials.paths.settings, materials.anchors.settingsSha256, 'Qwen initial mutable settings')
  if (treeSha256(materials.qwenRoot) !== materials.anchors.qwenTreeSha256) throw new Error('Qwen tree differs from frozen launch material')
  if (!inside(realpathSync(materials.qwenCliPath), realpathSync(materials.qwenRoot))) throw new Error('Qwen CLI escapes frozen root')
  return materials
}

/** Release immutable directory permissions only after every owned child is reaped. */
export function releaseQwenLaunch(materials) {
  verifyQwenLaunch(materials)
  chmodSync(materials.paths.frozen, 0o700)
}
