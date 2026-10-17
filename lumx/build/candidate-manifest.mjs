import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

const ROLE_HOST = 'host'
const ROLE_ENGINE = 'engine-qualification'
const BOUNDARY_KINDS = new Set(['fd-closure', 'host-boundary', 'host-isolation'])

/** @param {string} path @returns {string} */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** @param {string} child @param {string} parent @returns {boolean} */
function isWithin(child, parent) {
  const difference = relative(resolve(parent), resolve(child))
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
export function validateCandidateManifest(manifest, expected) {
  if (sha256File(expected.manifestPath) !== expected.expectedManifestSha256) {
    throw new Error('candidate manifest digest differs from the caller-supplied anchor')
  }
  const root = object(manifest, 'manifest')
  if (root.manifestVersion !== 1) throw new Error('unsupported candidate manifest version')
  const candidate = object(root.candidate, 'candidate')
  text(candidate.forkCommit, 'candidate.forkCommit')
  text(candidate.forkTree, 'candidate.forkTree')
  const patch = object(candidate.patchRange, 'candidate.patchRange')
  text(patch.base, 'candidate.patchRange.base')
  text(patch.head, 'candidate.patchRange.head')
  const paths = array(patch.paths, 'candidate.patchRange.paths').map((entry, index) => text(entry, `candidate.patchRange.paths[${index}]`))
  const allowed = new Set(expected.allowedPatchPaths)
  for (const path of paths) if (!allowed.has(path)) throw new Error(`candidate patch path is outside the reviewed allowlist: ${path}`)
  const node = object(root.node, 'node')
  for (const field of ['path', 'sha256', 'version']) text(node[field], `node.${field}`)
  const inventory = array(root.runtimeModules, 'runtimeModules')
  for (const [index, entry] of inventory.entries()) {
    const item = object(entry, `runtimeModules[${index}]`)
    const status = text(item.status, `runtimeModules[${index}].status`)
    const runtimePath = text(item.path, `runtimeModules[${index}].path`)
    const sourcePath = text(item.sourcePath, `runtimeModules[${index}].sourcePath`)
    if (!['changed', 'reused'].includes(status)) throw new Error(`runtimeModules[${index}].status is invalid`)
    if (status === 'changed' && (!isWithin(runtimePath, expected.candidateRoot) || isWithin(runtimePath, expected.referenceRoot) || !isWithin(sourcePath, expected.candidateRoot))) {
      throw new Error(`changed runtime module escapes the candidate tree: ${runtimePath}`)
    }
  }
  const profiles = array(root.profiles, 'profiles')
  const claims = array(root.claims, 'claims')
  const profileRoles = new Map()
  for (const [index, entry] of profiles.entries()) {
    const item = object(entry, `profiles[${index}]`)
    const role = text(item.role, `profiles[${index}].role`)
    if (role !== ROLE_HOST && role !== ROLE_ENGINE) throw new Error(`unknown profile role: ${role}`)
    profileRoles.set(`${text(item.unit, `profiles[${index}].unit`)}:${text(item.hash, `profiles[${index}].hash`)}`, role)
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
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [manifestPath, expectedManifestSha256, candidateRoot, referenceRoot, ...allowedPatchPaths] = process.argv.slice(2)
  if (!manifestPath || !expectedManifestSha256 || !candidateRoot || !referenceRoot) {
    throw new Error('usage: candidate-manifest.mjs <manifest> <expected-sha256> <candidate-root> <reference-root> [allowed-path...]')
  }
  validateCandidateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), { allowedPatchPaths, candidateRoot, expectedManifestSha256, manifestPath, referenceRoot })
}
