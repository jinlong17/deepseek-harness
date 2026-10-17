import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, relative, sep } from 'node:path'

const ROLE_HOST = 'host'
const ROLE_ENGINE = 'engine-qualification'
const BOUNDARY_KINDS = new Set(['fd-closure', 'host-boundary', 'host-isolation'])

/** @param {string} path @returns {string} */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** @param {string} root @returns {string} */
export function treeSha256(root) {
  const entries = execFileSync('/usr/bin/find', [root, '-type', 'f', '-print'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort()
  const hash = createHash('sha256')
  for (const path of entries) hash.update(`${relative(root, path)}\0${sha256File(path)}\n`)
  return hash.digest('hex')
}

/** @param {string} root @param {...string} args @returns {string} */
function git(root, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim()
}

/** @param {string} child @param {string} parent @returns {boolean} */
function isWithin(child, parent) {
  const normalizedParent = existsSync(parent) ? realpathSync(parent) : resolve(parent)
  const normalizedChild = existsSync(child) ? realpathSync(child) : resolve(child)
  const difference = relative(normalizedParent, normalizedChild)
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..')
}

/** @param {unknown} value @param {string} name @returns {object} */
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

/** @param {unknown} value @param {string} name @returns {unknown[]} */
function array(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

/** @param {unknown} value @param {string} name @returns {string} */
function text(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

/**
 * Validates a caller-anchored candidate manifest before a qualification run.
 * @param {object} manifest
 * @param {{ allowedPatchPaths: readonly string[], candidateRoot: string, expectedManifestSha256: string, manifestPath: string, referenceRoot: string }} expected
 * @returns {void}
 */
export function validateCandidateManifest(expected) {
  const bytes = readFileSync(expected.manifestPath)
  if (createHash('sha256').update(bytes).digest('hex') !== expected.expectedManifestSha256) {
    throw new Error('candidate manifest digest differs from the caller-supplied anchor')
  }
  const manifest = JSON.parse(bytes)
  const root = object(manifest, 'manifest')
  if (root.manifestVersion !== 1) throw new Error('unsupported candidate manifest version')
  const candidate = object(root.candidate, 'candidate')
  if (candidate.forkCommit !== git(expected.candidateRoot, 'rev-parse', 'HEAD')) throw new Error('candidate fork commit differs from checkout')
  if (candidate.forkTree !== git(expected.candidateRoot, 'rev-parse', 'HEAD^{tree}')) throw new Error('candidate fork tree differs from checkout')
  if (git(expected.candidateRoot, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('candidate checkout is dirty')
  const patch = object(candidate.patchRange, 'candidate.patchRange')
  if (patch.head !== candidate.forkCommit || !/^[0-9a-f]{40}$/.test(patch.base)) throw new Error('candidate patch range is invalid')
  const paths = array(patch.paths, 'candidate.patchRange.paths').map((entry, index) => text(entry, `candidate.patchRange.paths[${index}]`))
  const allowed = new Set(expected.allowedPatchPaths)
  for (const path of paths) if (!allowed.has(path)) throw new Error(`candidate patch path is outside the reviewed allowlist: ${path}`)
  const actualPaths = git(expected.candidateRoot, 'diff', '--name-only', `${patch.base}..${patch.head}`).split('\n').filter(Boolean).sort()
  if (actualPaths.join('\n') !== [...paths].sort().join('\n')) throw new Error('candidate patch paths omit or misstate the Git diff')
  const node = object(root.node, 'node')
  for (const field of ['path', 'sha256', 'version']) text(node[field], `node.${field}`)
  const realNode = realpathSync(expected.nodePath)
  if (realpathSync(node.path) !== realNode || sha256File(realNode) !== node.sha256 || execFileSync(realNode, ['--version'], { encoding: 'utf8' }).trim() !== node.version) throw new Error('Node executable differs from manifest')
  if (sha256File(realNode) !== expected.expectedNodeSha256) throw new Error('Node executable differs from caller anchor')
  if (sha256File(expected.lockPath) !== expected.expectedLockSha256) throw new Error('lockfile differs from caller anchor')
  const inventory = array(root.runtimeModules, 'runtimeModules')
  if (inventory.length === 0) throw new Error('runtimeModules must not be empty')
  for (const [index, entry] of inventory.entries()) {
    const item = object(entry, `runtimeModules[${index}]`)
    const status = text(item.status, `runtimeModules[${index}].status`)
    const runtimePath = text(item.path, `runtimeModules[${index}].path`)
    const sourcePath = text(item.sourcePath, `runtimeModules[${index}].sourcePath`)
    if (!existsSync(runtimePath) || !existsSync(sourcePath) || !lstatSync(runtimePath).isFile() || !lstatSync(sourcePath).isFile()) throw new Error(`runtime module is missing: ${runtimePath}`)
    const runtimeReal = realpathSync(runtimePath)
    const sourceReal = realpathSync(sourcePath)
    if (sha256File(runtimeReal) !== text(item.sha256, `runtimeModules[${index}].sha256`) || sha256File(sourceReal) !== text(item.sourceSha256, `runtimeModules[${index}].sourceSha256`)) throw new Error(`runtime module digest differs: ${runtimePath}`)
    if (!['changed', 'reused'].includes(status)) throw new Error(`runtimeModules[${index}].status is invalid`)
    if (status === 'changed' && (!isWithin(runtimeReal, expected.candidateRoot) || (existsSync(expected.referenceRoot) && isWithin(runtimeReal, expected.referenceRoot)) || !isWithin(sourceReal, expected.candidateRoot))) {
      throw new Error(`changed runtime module escapes the candidate tree: ${runtimePath}`)
    }
    if (status === 'reused' && expected.baselineArtifacts?.[runtimeReal] !== item.sha256) throw new Error(`reused runtime module lacks immutable baseline identity: ${runtimePath}`)
  }
  const profiles = array(root.profiles, 'profiles')
  const claims = array(root.claims, 'claims')
  if (profiles.length === 0 || claims.length === 0) throw new Error('profiles and claims must not be empty')
  const profileRoles = new Map()
  for (const [index, entry] of profiles.entries()) {
    const item = object(entry, `profiles[${index}]`)
    const role = text(item.role, `profiles[${index}].role`)
    if (role !== ROLE_HOST && role !== ROLE_ENGINE) throw new Error(`unknown profile role: ${role}`)
    const key = `${text(item.unit, `profiles[${index}].unit`)}:${text(item.hash, `profiles[${index}].hash`)}`
    if (profileRoles.has(key)) throw new Error(`duplicate profile identity: ${key}`)
    profileRoles.set(key, role)
  }
  for (const [index, entry] of claims.entries()) {
    const item = object(entry, `claims[${index}]`)
    const key = `${text(item.unit, `claims[${index}].unit`)}:${text(item.profileHash, `claims[${index}].profileHash`)}`
    const role = profileRoles.get(key)
    if (!role) throw new Error(`claim lacks a declared profile role: ${key}`)
    if (BOUNDARY_KINDS.has(text(item.kind, `claims[${index}].kind`)) && role !== ROLE_HOST) {
      throw new Error(`boundary claim must cite a host profile: ${item.kind}`)
    }
  }
  const qwen = object(root.qwen, 'qwen')
  if (realpathSync(text(qwen.root, 'qwen.root')) !== realpathSync(expected.qwenRoot) || treeSha256(expected.qwenRoot) !== text(qwen.treeSha256, 'qwen.treeSha256') || sha256File(text(qwen.cliPath, 'qwen.cliPath')) !== text(qwen.cliSha256, 'qwen.cliSha256')) throw new Error('Qwen input closure differs from manifest')
  if (text(qwen.treeSha256, 'qwen.treeSha256') !== expected.expectedQwenTreeSha256) throw new Error('Qwen tree differs from caller anchor')
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [manifestPath, expectedManifestSha256, candidateRoot, referenceRoot, ...allowedPatchPaths] = process.argv.slice(2)
  if (!manifestPath || !expectedManifestSha256 || !candidateRoot || !referenceRoot) {
    throw new Error('usage: candidate-manifest.mjs <manifest> <expected-sha256> <candidate-root> <reference-root> [allowed-path...]')
  }
  throw new Error('the CLI is intentionally disabled: the caller must supply Node, lock, baseline, and Qwen anchors to validateCandidateManifest')
}
