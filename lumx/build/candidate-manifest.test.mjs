import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validateCandidateManifest } from './candidate-manifest.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lumx-candidate-manifest-'))
  const manifestPath = join(root, 'candidate.json')
  const manifest = { manifestVersion: 1, candidate: { forkCommit: 'a', forkTree: 'b', patchRange: { base: 'a', head: 'b', paths: ['lumx/build/candidate-manifest.mjs'] } }, node: { path: '/node', sha256: 'node', version: 'v24' }, runtimeModules: [{ path: join(root, 'candidate/lib.js'), sourcePath: join(root, 'candidate/src.js'), status: 'changed' }, { path: join(root, 'reference/ui.js'), sourcePath: join(root, 'reference/ui.js'), status: 'reused' }], profiles: [{ unit: 'host', hash: 'host-hash', role: 'host' }, { unit: 'driver', hash: 'engine-hash', role: 'engine-qualification' }], claims: [{ unit: 'host', profileHash: 'host-hash', kind: 'host-boundary' }, { unit: 'driver', profileHash: 'engine-hash', kind: 'engine-admission' }] }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  return { expectedManifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), manifest, manifestPath, root }
}

test('accepts a caller-anchored manifest with role-correct runtime closure', () => {
  const value = fixture()
  assert.doesNotThrow(() => validateCandidateManifest(value.manifest, { ...value, allowedPatchPaths: ['lumx/build/candidate-manifest.mjs'], candidateRoot: join(value.root, 'candidate'), referenceRoot: join(value.root, 'reference') }))
})

test('rejects a self-modified manifest and engine-profile boundary attribution', () => {
  const value = fixture()
  assert.throws(() => validateCandidateManifest(value.manifest, { ...value, allowedPatchPaths: [], candidateRoot: join(value.root, 'candidate'), referenceRoot: join(value.root, 'reference') }), /allowlist/)
  value.manifest.claims[0] = { unit: 'driver', profileHash: 'engine-hash', kind: 'host-boundary' }
  assert.throws(() => validateCandidateManifest(value.manifest, { ...value, allowedPatchPaths: ['lumx/build/candidate-manifest.mjs'], candidateRoot: join(value.root, 'candidate'), referenceRoot: join(value.root, 'reference') }), /host profile/)
})
