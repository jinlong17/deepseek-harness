import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { qwenSandboxProfile, runQwenAcpFeasibility } from './qwen-feasibility.mjs'

test('engine profile grants only the selected loopback relay port', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-qwen-profile-'))
  test.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of ['node/bin', 'qwen', 'runtime', 'workspace']) mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(root, 'node/bin/node'), '')
  const profile = qwenSandboxProfile({
    nodePath: join(root, 'node/bin/node'), qwenRoot: join(root, 'qwen'), relayPort: 43123,
    runtime: join(root, 'runtime'), workspace: join(root, 'workspace'),
  })
  assert.match(profile, /deny network\*/)
  assert.match(profile, /remote tcp4 "localhost:43123"/)
  assert.doesNotMatch(profile, /localhost:\*/)
  assert.doesNotMatch(profile, /network-bind|network-inbound/)
  assert.match(profile, /deny file-read\* file-write\* \(subpath "\/Users\/jinlong\/\.ssh"\)/)
  assert.match(profile, /deny file-read\* file-write\* \(literal "\/Users\/jinlong\/\.codex\/auth\.json"\)/)
})

test('a caller-anchor mismatch prevents an untrusted Node from executing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-qwen-anchor-'))
  test.after(() => rmSync(root, { recursive: true, force: true }))
  const qwenRoot = join(root, 'qwen')
  mkdirSync(qwenRoot)
  const marker = join(root, 'executed')
  const node = join(root, 'node')
  const cli = join(qwenRoot, 'cli.js')
  writeFileSync(node, `#!/bin/sh\nprintf bad > ${JSON.stringify(marker)}\n`)
  writeFileSync(cli, 'console.log("bad")\n')
  await assert.rejects(runQwenAcpFeasibility({
    nodePath: node, nodeSha256: '0'.repeat(64), qwenCliPath: cli,
    qwenCliSha256: '0'.repeat(64), qwenRoot, qwenTreeSha256: '0'.repeat(64), runtime: root,
  }), /Node differs from caller anchor/)
  assert.throws(() => readFileSync(marker), /ENOENT/)
})
