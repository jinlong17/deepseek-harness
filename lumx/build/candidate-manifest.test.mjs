import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { sha256File, treeSha256, validateCandidateManifest } from './candidate-manifest.mjs'

function git(root, ...args) {
  return execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function writeManifest(fixture, mutate = () => {}) {
  mutate(fixture.manifest)
  writeFileSync(fixture.expected.manifestPath, JSON.stringify(fixture.manifest))
  fixture.expected.expectedManifestSha256 = sha256File(fixture.expected.manifestPath)
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lumx-candidate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidate')
  mkdirSync(candidate)
  git(candidate, 'init', '-q')
  git(candidate, 'config', 'user.email', 'test@example.test')
  git(candidate, 'config', 'user.name', 'test')
  writeFileSync(join(candidate, 'src.js'), 'base source')
  writeFileSync(join(candidate, 'pnpm-lock.yaml'), 'lock')
  writeFileSync(join(candidate, 'reused.js'), 'baseline reused')
  git(candidate, 'add', 'src.js', 'pnpm-lock.yaml', 'reused.js')
  git(candidate, 'commit', '-qm', 'base')
  const base = git(candidate, 'rev-parse', 'HEAD')
  const baseTree = git(candidate, 'rev-parse', 'HEAD^{tree}')
  const reference = join(root, 'reference')
  execFileSync('/usr/bin/git', ['clone', '-q', candidate, reference])
  writeFileSync(join(candidate, 'src.js'), 'candidate source')
  git(candidate, 'commit', '-am', 'candidate', '-q')
  const head = git(candidate, 'rev-parse', 'HEAD')
  const build = join(candidate, 'build')
  mkdirSync(build)
  writeFileSync(join(candidate, '.git/info/exclude'), 'build/\n')
  const runtime = join(build, 'runtime.js')
  writeFileSync(runtime, 'candidate artifact')

  const qwen = join(root, 'qwen')
  mkdirSync(join(qwen, 'chunks'), { recursive: true })
  const cli = join(qwen, 'cli.js')
  writeFileSync(cli, 'qwen cli')
  writeFileSync(join(qwen, 'chunks/acp.js'), 'acp chunk')
  const profilesRoot = join(root, 'profiles')
  mkdirSync(profilesRoot)
  const hostProfile = join(profilesRoot, 'host.sb')
  const engineProfile = join(profilesRoot, 'engine.sb')
  writeFileSync(hostProfile, 'host profile')
  writeFileSync(engineProfile, 'engine profile')
  const loadedClosure = [
    { id: 'changed-runtime', path: runtime, sourcePath: join(candidate, 'src.js'), status: 'changed', sha256: sha256File(runtime), sourceSha256: sha256File(join(candidate, 'src.js')) },
    { id: 'reused-runtime', path: join(reference, 'reused.js'), sourcePath: join(reference, 'reused.js'), status: 'reused', sha256: sha256File(join(reference, 'reused.js')), sourceSha256: sha256File(join(reference, 'reused.js')) },
  ]
  const profiles = [
    { unit: 'mixed-unit', name: 'host', path: hostProfile, hash: sha256File(hostProfile), role: 'host' },
    { unit: 'mixed-unit', name: 'engine', path: engineProfile, hash: sha256File(engineProfile), role: 'engine-qualification' },
  ]
  const claims = [
    { id: 'host-boundary', unit: 'mixed-unit', profileHash: profiles[0].hash, role: 'host', kind: 'host-boundary' },
    { id: 'engine-admission', unit: 'mixed-unit', profileHash: profiles[1].hash, role: 'engine-qualification', kind: 'engine-admission' },
  ]
  const manifestPath = join(root, 'candidate.json')
  const manifest = {
    manifestVersion: 2,
    qualification: { eligibility: 'canonical', inputsComplete: true },
    candidate: { forkCommit: head, forkTree: git(candidate, 'rev-parse', 'HEAD^{tree}'), patchRange: { base, head, paths: ['src.js'] } },
    node: { path: process.execPath, sha256: sha256File(process.execPath), version: process.version },
    lock: { path: join(candidate, 'pnpm-lock.yaml'), sha256: sha256File(join(candidate, 'pnpm-lock.yaml')) },
    runtimeModules: loadedClosure,
    profiles,
    claims,
    qwen: { root: qwen, treeSha256: treeSha256(qwen), cliPath: cli, cliSha256: sha256File(cli) },
  }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const expected = {
    allowedPatchPaths: ['src.js'], baselineCommit: base, candidateRoot: candidate, expectedBaselineTree: baseTree,
    expectedLockSha256: sha256File(join(candidate, 'pnpm-lock.yaml')), expectedManifestSha256: sha256File(manifestPath),
    expectedNodeSha256: sha256File(process.execPath), expectedQwenCliSha256: sha256File(cli), expectedQwenTreeSha256: treeSha256(qwen),
    loadedClosure, lockPath: join(candidate, 'pnpm-lock.yaml'), manifestPath, nodePath: process.execPath,
    profiles, claims, qwenCliPath: cli, qwenRoot: qwen, referenceRoot: reference,
  }
  return { root, candidate, reference, qwen, cli, runtime, hostProfile, engineProfile, manifest, expected }
}

test('accepts a canonical manifest backed by real Git and actual file bytes', (t) => {
  const f = fixture(t)
  assert.doesNotThrow(() => validateCandidateManifest(f.expected))
})

test('rejects a fake Node before executing even a version probe', (t) => {
  const f = fixture(t)
  const marker = join(f.root, 'node-executed')
  const fakeNode = join(f.root, 'fake-node')
  writeFileSync(fakeNode, `#!/bin/sh\nprintf x > '${marker}'\nprintf 'v24.fake\\n'\n`)
  chmodSync(fakeNode, 0o755)
  writeManifest(f, (manifest) => { manifest.node = { path: fakeNode, sha256: sha256File(fakeNode), version: 'v24.fake' } })
  f.expected.nodePath = fakeNode
  assert.throws(() => validateCandidateManifest(f.expected), /caller anchor/)
  assert.equal(existsSync(marker), false)
})

test('rejects changed reviewed manifest bytes', (t) => {
  const f = fixture(t)
  writeFileSync(f.expected.manifestPath, '{}')
  assert.throws(() => validateCandidateManifest(f.expected), /manifest digest/)
})

test('rejects missing and changed built artifacts through the loaded closure', (t) => {
  const missing = fixture(t)
  rmSync(missing.runtime)
  assert.throws(() => validateCandidateManifest(missing.expected), /missing or link-shaped/)
  const changed = fixture(t)
  writeFileSync(changed.runtime, 'tampered artifact')
  assert.throws(() => validateCandidateManifest(changed.expected), /runtime module digest/)
})

test('rejects source digest drift even when the manifest and caller list agree', (t) => {
  const f = fixture(t)
  const wrong = '0'.repeat(64)
  f.manifest.runtimeModules[0].sourceSha256 = wrong
  f.expected.loadedClosure = structuredClone(f.manifest.runtimeModules)
  writeManifest(f)
  assert.throws(() => validateCandidateManifest(f.expected), /runtime module digest/)
})

test('rejects false baseline, incomplete diff, changed lock, and a dirty checkout', (t) => {
  const falseBase = fixture(t)
  writeManifest(falseBase, (manifest) => { manifest.candidate.patchRange.base = '0'.repeat(40) })
  assert.throws(() => validateCandidateManifest(falseBase.expected), /baseline\/head/)
  const incomplete = fixture(t)
  incomplete.expected.allowedPatchPaths = []
  assert.throws(() => validateCandidateManifest(incomplete.expected), /Git diff/)
  const changedLock = fixture(t)
  writeFileSync(changedLock.expected.lockPath, 'changed lock')
  assert.throws(() => validateCandidateManifest(changedLock.expected), /dirty|lockfile/)
  const dirty = fixture(t)
  writeFileSync(join(dirty.candidate, 'unexpected.js'), 'unexpected')
  assert.throws(() => validateCandidateManifest(dirty.expected), /dirty/)
})

test('rejects Qwen tree symlink escapes and an external cliPath', (t) => {
  const escapedTree = fixture(t)
  const outside = join(escapedTree.root, 'outside.js')
  writeFileSync(outside, 'outside')
  symlinkSync(outside, join(escapedTree.qwen, 'chunks/escape.js'))
  assert.throws(() => validateCandidateManifest(escapedTree.expected), /symlink escapes root/)
  const escapedCli = fixture(t)
  writeManifest(escapedCli, (manifest) => { manifest.qwen.cliPath = outside; manifest.qwen.cliSha256 = sha256File(outside) })
  assert.throws(() => validateCandidateManifest(escapedCli.expected), /cli\.js escapes|differs from caller/)
})

test('binds actual profile bytes and rejects mixed-unit role misattribution', (t) => {
  const bytes = fixture(t)
  writeFileSync(bytes.engineProfile, 'tampered profile')
  assert.throws(() => validateCandidateManifest(bytes.expected), /profile bytes/)
  const role = fixture(t)
  role.manifest.claims[0].profileHash = role.manifest.profiles[1].hash
  role.manifest.claims[0].role = 'engine-qualification'
  role.expected.claims = structuredClone(role.manifest.claims)
  writeManifest(role)
  assert.throws(() => validateCandidateManifest(role.expected), /host-boundary claim must cite a host profile/)
})

test('rejects duplicate identities and unrecognized claim kinds', (t) => {
  const duplicate = fixture(t)
  duplicate.manifest.claims.push(structuredClone(duplicate.manifest.claims[0]))
  duplicate.expected.claims = structuredClone(duplicate.manifest.claims)
  writeManifest(duplicate)
  assert.throws(() => validateCandidateManifest(duplicate.expected), /duplicate identities/)
  const unknown = fixture(t)
  unknown.manifest.claims[0].kind = 'host-boundary-looking'
  unknown.expected.claims = structuredClone(unknown.manifest.claims)
  writeManifest(unknown)
  assert.throws(() => validateCandidateManifest(unknown.expected), /unknown claim kind/)
})

test('rejects draft and incomplete canonical inputs', (t) => {
  const draft = fixture(t)
  writeManifest(draft, (manifest) => { manifest.qualification = { eligibility: 'draft', inputsComplete: false } })
  assert.throws(() => validateCandidateManifest(draft.expected), /draft manifest/)
  const incomplete = fixture(t)
  incomplete.manifest.runtimeModules = []
  incomplete.expected.loadedClosure = []
  writeManifest(incomplete)
  assert.throws(() => validateCandidateManifest(incomplete.expected), /loaded closure/)
})

test('rejects changed runtime resolution through the immutable reference tree', (t) => {
  const f = fixture(t)
  const changed = f.manifest.runtimeModules[0]
  changed.path = join(f.reference, 'reused.js')
  changed.sourcePath = join(f.reference, 'reused.js')
  changed.sha256 = sha256File(changed.path)
  changed.sourceSha256 = sha256File(changed.sourcePath)
  f.expected.loadedClosure = structuredClone(f.manifest.runtimeModules)
  writeManifest(f)
  assert.throws(() => validateCandidateManifest(f.expected), /escapes its trusted tree|reference tree/)
})
