import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const ROLE_HOST = 'host'
const ROLE_ENGINE = 'engine-qualification'
const CLAIM_ROLES = new Map([
  ['fd-closure', ROLE_HOST],
  ['host-boundary', ROLE_HOST],
  ['host-isolation', ROLE_HOST],
  ['engine-qualification', ROLE_ENGINE],
  ['engine-admission', ROLE_ENGINE],
  ['operation-admission', ROLE_ENGINE],
  ['model-admission', ROLE_ENGINE],
  ['artifact-closure', ROLE_ENGINE],
])
const SHA256 = /^[0-9a-f]{64}$/
const GIT_OID = /^[0-9a-f]{40}$/

/** @param {string} path @returns {string} */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** @param {string} child @param {string} parent @returns {boolean} */
function isWithin(child, parent) {
  const difference = relative(parent, child)
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
}

/** Hash file bytes plus directory and symlink identities without following links during traversal. */
export function treeSha256(root) {
  const rootReal = realpathSync(root)
  if (!statSync(rootReal).isDirectory()) throw new Error('tree root must be a directory')
  const hash = createHash('sha256')
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name)
      const rel = relative(rootReal, path)
      const entry = lstatSync(path)
      if (entry.isSymbolicLink()) {
        const targetText = readlinkSync(path)
        const targetReal = realpathSync(path)
        if (!isWithin(targetReal, rootReal)) throw new Error(`tree symlink escapes root: ${rel}`)
        const target = statSync(targetReal)
        hash.update(`l\0${rel}\0${targetText}\0${relative(rootReal, targetReal)}\0`)
        if (target.isFile()) hash.update(`${sha256File(targetReal)}\n`)
        else if (target.isDirectory()) hash.update('directory\n')
        else throw new Error(`tree symlink has unsupported target: ${rel}`)
      } else if (entry.isDirectory()) {
        hash.update(`d\0${rel}\n`)
        visit(path)
      } else if (entry.isFile()) {
        hash.update(`f\0${rel}\0${entry.mode & 0o777}\0${sha256File(path)}\n`)
      } else {
        throw new Error(`tree contains unsupported entry: ${rel}`)
      }
    }
  }
  visit(rootReal)
  return hash.digest('hex')
}

function git(root, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

function array(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function text(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

function sha(value, name) {
  const result = text(value, name)
  if (!SHA256.test(result)) throw new Error(`${name} must be a lowercase SHA-256`)
  return result
}

function uniqueStrings(values, name) {
  const result = values.map((value, index) => text(value, `${name}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(`${name} contains duplicate identities`)
  return result
}

function plainFile(path, name) {
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${name} is missing or link-shaped: ${path}`)
  return realpathSync(path)
}

function uniqueRows(rows, identity, name) {
  const ids = rows.map(identity)
  if (new Set(ids).size !== ids.length) throw new Error(`${name} contains duplicate identities`)
}

function exact(actual, expected, name) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name} differs from the caller-supplied trust input`)
}

/**
 * @typedef {object} CandidateManifestTrust
 * @property {readonly string[]} allowedPatchPaths Exact reviewed diff paths.
 * @property {string} baselineCommit Exact immutable fork baseline commit.
 * @property {string} candidateRoot Candidate Git checkout.
 * @property {string} expectedBaselineTree Caller-anchored baseline tree.
 * @property {string} expectedLockSha256 Caller-anchored lockfile digest.
 * @property {string} expectedManifestSha256 Digest of reviewed manifest bytes.
 * @property {string} expectedNodeSha256 Caller-anchored Node executable digest.
 * @property {string} expectedQwenCliSha256 Caller-anchored direct cli.js digest.
 * @property {string} expectedQwenTreeSha256 Caller-anchored extracted-tree digest.
 * @property {readonly object[]} loadedClosure Exact build/runtime/source rows.
 * @property {string} lockPath
 * @property {string} manifestPath
 * @property {string} nodePath
 * @property {readonly object[]} profiles Exact required profile rows.
 * @property {readonly object[]} claims Exact required claim rows.
 * @property {string} qwenCliPath
 * @property {string} qwenRoot
 * @property {string} referenceRoot Immutable baseline checkout.
 * @property {boolean} [requireCanonical=true]
 */

/**
 * Validate caller-anchored bytes and Git state without executing a manifest-selected
 * program. Node is executed for `--version` only after its caller anchor matches.
 * @param {CandidateManifestTrust} expected
 */
export function validateCandidateManifest(expected) {
  if (!GIT_OID.test(expected.baselineCommit)) throw new Error('baselineCommit must be an exact Git commit')
  for (const [value, name] of [
    [expected.expectedManifestSha256, 'expectedManifestSha256'],
    [expected.expectedNodeSha256, 'expectedNodeSha256'],
    [expected.expectedLockSha256, 'expectedLockSha256'],
    [expected.expectedQwenTreeSha256, 'expectedQwenTreeSha256'],
    [expected.expectedQwenCliSha256, 'expectedQwenCliSha256'],
  ]) sha(value, name)
  const allowedPatchPaths = uniqueStrings(array(expected.allowedPatchPaths, 'allowedPatchPaths'), 'allowedPatchPaths').sort()
  if (allowedPatchPaths.some((path) => isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))) throw new Error('allowedPatchPaths contains an escaping path')

  const manifestBytes = readFileSync(expected.manifestPath)
  if (createHash('sha256').update(manifestBytes).digest('hex') !== expected.expectedManifestSha256) throw new Error('candidate manifest digest differs from the caller-supplied anchor')
  const root = object(JSON.parse(manifestBytes), 'manifest')
  if (root.manifestVersion !== 2) throw new Error('unsupported candidate manifest version')
  const qualification = object(root.qualification, 'qualification')
  if (!['draft', 'canonical'].includes(qualification.eligibility)) throw new Error('qualification.eligibility is invalid')
  if (qualification.inputsComplete !== (qualification.eligibility === 'canonical')) throw new Error('qualification completeness is inconsistent')
  if (expected.requireCanonical !== false && qualification.eligibility !== 'canonical') throw new Error('draft manifest is not eligible for qualification')

  const candidateRoot = realpathSync(expected.candidateRoot)
  const referenceRoot = realpathSync(expected.referenceRoot)
  if (candidateRoot === referenceRoot) throw new Error('candidate and reference roots must be distinct')
  const candidate = object(root.candidate, 'candidate')
  const head = git(candidateRoot, 'rev-parse', 'HEAD')
  const tree = git(candidateRoot, 'rev-parse', 'HEAD^{tree}')
  if (candidate.forkCommit !== head || candidate.forkTree !== tree) throw new Error('candidate Git identity differs from checkout')
  if (git(candidateRoot, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('candidate checkout is dirty')
  if (git(referenceRoot, 'rev-parse', 'HEAD') !== expected.baselineCommit || git(referenceRoot, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('reference checkout differs from immutable baseline')
  if (git(candidateRoot, 'rev-parse', `${expected.baselineCommit}^{tree}`) !== expected.expectedBaselineTree) throw new Error('baseline tree differs from caller anchor')
  try { git(candidateRoot, 'merge-base', '--is-ancestor', expected.baselineCommit, head) } catch { throw new Error('candidate baseline is not an ancestor of HEAD') }
  const patch = object(candidate.patchRange, 'candidate.patchRange')
  if (patch.base !== expected.baselineCommit || patch.head !== head) throw new Error('candidate patch range differs from caller baseline/head')
  const manifestPaths = uniqueStrings(array(patch.paths, 'candidate.patchRange.paths'), 'candidate.patchRange.paths').sort()
  const actualPaths = git(candidateRoot, 'diff', '--name-only', `${expected.baselineCommit}..${head}`).split('\n').filter(Boolean).sort()
  exact(manifestPaths, actualPaths, 'candidate patch paths')
  exact(actualPaths, allowedPatchPaths, 'candidate Git diff')

  const node = object(root.node, 'node')
  const trustedNode = plainFile(expected.nodePath, 'caller Node executable')
  if (sha256File(trustedNode) !== expected.expectedNodeSha256) throw new Error('Node executable differs from caller anchor')
  if (plainFile(text(node.path, 'node.path'), 'manifest Node executable') !== trustedNode || sha(node.sha256, 'node.sha256') !== expected.expectedNodeSha256) throw new Error('Node executable differs from manifest')
  if (execFileSync(trustedNode, ['--version'], { encoding: 'utf8', env: {} }).trim() !== text(node.version, 'node.version')) throw new Error('Node version differs from manifest')

  const lock = object(root.lock, 'lock')
  const trustedLock = plainFile(expected.lockPath, 'caller lockfile')
  if (sha256File(trustedLock) !== expected.expectedLockSha256) throw new Error('lockfile differs from caller anchor')
  if (plainFile(text(lock.path, 'lock.path'), 'manifest lockfile') !== trustedLock || sha(lock.sha256, 'lock.sha256') !== expected.expectedLockSha256) throw new Error('lockfile differs from manifest')

  const expectedClosure = array(expected.loadedClosure, 'loadedClosure')
  const inventory = array(root.runtimeModules, 'runtimeModules')
  if (expectedClosure.length === 0 || inventory.length === 0) throw new Error('loaded closure must not be empty')
  uniqueRows(inventory, (entry, index) => text(object(entry, `runtimeModules[${index}]`).id, `runtimeModules[${index}].id`), 'runtimeModules')
  exact(inventory, expectedClosure, 'runtimeModules')
  for (const [index, entry] of inventory.entries()) {
    const item = object(entry, `runtimeModules[${index}]`)
    const status = text(item.status, `runtimeModules[${index}].status`)
    if (!['changed', 'reused'].includes(status)) throw new Error(`runtimeModules[${index}].status is invalid`)
    const runtimeReal = plainFile(text(item.path, `runtimeModules[${index}].path`), `runtimeModules[${index}].path`)
    const sourceReal = plainFile(text(item.sourcePath, `runtimeModules[${index}].sourcePath`), `runtimeModules[${index}].sourcePath`)
    if (sha256File(runtimeReal) !== sha(item.sha256, `runtimeModules[${index}].sha256`) || sha256File(sourceReal) !== sha(item.sourceSha256, `runtimeModules[${index}].sourceSha256`)) throw new Error(`runtime module digest differs: ${item.id}`)
    const ownerRoot = status === 'changed' ? candidateRoot : referenceRoot
    if (!isWithin(runtimeReal, ownerRoot) || !isWithin(sourceReal, ownerRoot)) throw new Error(`${status} runtime module escapes its trusted tree: ${item.id}`)
    if (status === 'changed' && (isWithin(runtimeReal, referenceRoot) || isWithin(sourceReal, referenceRoot))) throw new Error(`changed runtime module resolves through the reference tree: ${item.id}`)
  }

  const expectedProfiles = array(expected.profiles, 'profiles')
  const profiles = array(root.profiles, 'profiles')
  const expectedClaims = array(expected.claims, 'claims')
  const claims = array(root.claims, 'claims')
  if (expectedProfiles.length === 0 || expectedClaims.length === 0 || profiles.length === 0 || claims.length === 0) throw new Error('profiles and claims must not be empty')
  exact(profiles, expectedProfiles, 'profiles')
  exact(claims, expectedClaims, 'claims')
  uniqueRows(profiles, (entry, index) => {
    const item = object(entry, `profiles[${index}]`)
    return `${text(item.unit, `profiles[${index}].unit`)}:${text(item.name, `profiles[${index}].name`)}`
  }, 'profiles')
  const profileRoles = new Map()
  for (const [index, entry] of profiles.entries()) {
    const item = object(entry, `profiles[${index}]`)
    const role = text(item.role, `profiles[${index}].role`)
    if (role !== ROLE_HOST && role !== ROLE_ENGINE) throw new Error(`unknown profile role: ${role}`)
    const profilePath = plainFile(text(item.path, `profiles[${index}].path`), `profiles[${index}].path`)
    const profileHash = sha(item.hash, `profiles[${index}].hash`)
    if (sha256File(profilePath) !== profileHash) throw new Error(`profile bytes differ: ${item.name}`)
    const key = `${item.unit}:${profileHash}`
    if (profileRoles.has(key)) throw new Error(`duplicate profile identity: ${key}`)
    profileRoles.set(key, role)
  }
  uniqueRows(claims, (entry, index) => text(object(entry, `claims[${index}]`).id, `claims[${index}].id`), 'claims')
  for (const [index, entry] of claims.entries()) {
    const item = object(entry, `claims[${index}]`)
    const kind = text(item.kind, `claims[${index}].kind`)
    const requiredRole = CLAIM_ROLES.get(kind)
    if (!requiredRole) throw new Error(`unknown claim kind: ${kind}`)
    const profileHash = sha(item.profileHash, `claims[${index}].profileHash`)
    const key = `${text(item.unit, `claims[${index}].unit`)}:${profileHash}`
    const declaredRole = text(item.role, `claims[${index}].role`)
    if (!profileRoles.has(key) || profileRoles.get(key) !== declaredRole) throw new Error(`claim lacks its declared profile identity: ${key}`)
    if (declaredRole !== requiredRole) throw new Error(`${kind} claim must cite a ${requiredRole} profile`)
  }

  const qwen = object(root.qwen, 'qwen')
  const qwenRoot = realpathSync(expected.qwenRoot)
  if (realpathSync(text(qwen.root, 'qwen.root')) !== qwenRoot) throw new Error('Qwen root differs from caller anchor')
  const qwenTree = treeSha256(qwenRoot)
  if (qwenTree !== expected.expectedQwenTreeSha256 || sha(qwen.treeSha256, 'qwen.treeSha256') !== qwenTree) throw new Error('Qwen tree differs from caller anchor or manifest')
  const trustedCli = plainFile(expected.qwenCliPath, 'caller Qwen cli.js')
  if (!isWithin(trustedCli, qwenRoot)) throw new Error('caller Qwen cli.js escapes the Qwen tree')
  const manifestCli = plainFile(text(qwen.cliPath, 'qwen.cliPath'), 'manifest Qwen cli.js')
  if (manifestCli !== trustedCli || !isWithin(manifestCli, qwenRoot)) throw new Error('Qwen cli.js escapes the Qwen tree')
  if (sha256File(trustedCli) !== expected.expectedQwenCliSha256 || sha(qwen.cliSha256, 'qwen.cliSha256') !== expected.expectedQwenCliSha256) throw new Error('Qwen cli.js differs from caller anchor or manifest')
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  throw new Error('candidate-manifest.mjs is library-only: callers must supply all external trust anchors')
}
