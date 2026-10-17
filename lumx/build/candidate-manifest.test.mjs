import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { sha256File, treeSha256, validateCandidateManifest } from './candidate-manifest.mjs'

function git(root, ...args) { return execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim() }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lumx-candidate-'))
  const candidate = join(root, 'candidate'); mkdirSync(candidate); git(candidate, 'init', '-q'); git(candidate, 'config', 'user.email', 'test@example.test'); git(candidate, 'config', 'user.name', 'test')
  const runtime = join(candidate, 'runtime.js'); writeFileSync(runtime, 'base'); git(candidate, 'add', 'runtime.js'); git(candidate, 'commit', '-qm', 'base'); const base = git(candidate, 'rev-parse', 'HEAD')
  writeFileSync(runtime, 'candidate'); git(candidate, 'commit', '-am', 'candidate', '-q'); const head = git(candidate, 'rev-parse', 'HEAD')
  const lock = join(root, 'lock'); writeFileSync(lock, 'lock'); const qwen = join(root, 'qwen'); mkdirSync(qwen); const cli = join(qwen, 'cli.js'); writeFileSync(cli, 'cli'); const manifestPath = join(root, 'candidate.json')
  const manifest = { manifestVersion: 1, candidate: { forkCommit: head, forkTree: git(candidate, 'rev-parse', 'HEAD^{tree}'), patchRange: { base, head, paths: ['runtime.js'] } }, node: { path: process.execPath, sha256: sha256File(process.execPath), version: process.version }, runtimeModules: [{ path: runtime, sourcePath: runtime, status: 'changed', sha256: sha256File(runtime), sourceSha256: sha256File(runtime) }], profiles: [{ unit: 'host', hash: 'host', role: 'host' }], claims: [{ unit: 'host', profileHash: 'host', kind: 'host-boundary' }], qwen: { root: qwen, treeSha256: treeSha256(qwen), cliPath: cli, cliSha256: sha256File(cli) } }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return { allowedPatchPaths: ['runtime.js'], candidateRoot: candidate, expectedLockSha256: sha256File(lock), expectedManifestSha256: sha256File(manifestPath), expectedNodeSha256: sha256File(process.execPath), expectedQwenTreeSha256: treeSha256(qwen), lockPath: lock, manifestPath, nodePath: process.execPath, qwenRoot: qwen, referenceRoot: join(root, 'reference') }
}

test('validates real Git, file, Node, lock, Qwen, and host-role inputs', () => assert.doesNotThrow(() => validateCandidateManifest(fixture())))
test('rejects tampered bytes and engine-profile Host attribution', () => {
  const tampered = fixture(); writeFileSync(tampered.manifestPath, '{}'); assert.throws(() => validateCandidateManifest(tampered), /caller-supplied anchor/)
  const wrongRole = fixture(); const manifest = JSON.parse(readFileSync(wrongRole.manifestPath, 'utf8')); manifest.profiles[0].role = 'engine-qualification'; writeFileSync(wrongRole.manifestPath, JSON.stringify(manifest)); wrongRole.expectedManifestSha256 = sha256File(wrongRole.manifestPath); assert.throws(() => validateCandidateManifest(wrongRole), /host profile/)
})
