import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { acquireQwenStateLease } from './state-lease.mjs'

test('one live supervisor owns a Qwen mutable state root', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lumx-state-lease-')), 'owner')
  const lease = acquireQwenStateLease(path, 'first')
  assert.throws(() => acquireQwenStateLease(path, 'second'), /live owner/)
  lease.release(); const next = acquireQwenStateLease(path, 'second'); next.release()
})

test('recovers only a direct stale lease and rejects an alias', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-state-lease-')); const path = join(root, 'owner')
  writeFileSync(path, `${JSON.stringify({ version: 1, pid: 2147483647, nonce: 'stale' })}\n`)
  const lease = acquireQwenStateLease(path, 'replacement')
  assert.match(readFileSync(path, 'utf8'), /replacement/); lease.release()
  const target = join(root, 'target'); writeFileSync(target, '{}'); symlinkSync(target, path)
  assert.throws(() => acquireQwenStateLease(path, 'alias'), /direct file/)
})
