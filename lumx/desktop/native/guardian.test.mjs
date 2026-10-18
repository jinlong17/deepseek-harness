import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildLumxNativeGuardian } from './build.mjs'

function outcome(child) { return new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))) }
function alive(pid, group = false) {
  try { process.kill(group ? -pid : pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error(`${label} timed out`)
}
function firstLine(readable) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0)
    readable.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]); const newline = bytes.indexOf(0x0a)
      if (newline >= 0) resolve(bytes.subarray(0, newline).toString('utf8'))
    })
    readable.once('error', reject)
  })
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lumx-guardian-')); const marker = join(root, 'started')
  const program = join(root, 'program.sh'); const guardian = buildLumxNativeGuardian(join(root, 'guardian'))
  writeFileSync(program, `#!/bin/sh\n/bin/sleep 30 &\nprintf '%s %s' "$$" "$!" > ${JSON.stringify(marker)}\nwait\n`); chmodSync(program, 0o700)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { guardian, marker, program }
}
function launch({ guardian, program }) {
  return spawn(guardian, [program], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] })
}

test('owner EOF before the start barrier cannot execute the engine', async t => {
  const value = fixture(t); const child = launch(value); const exited = outcome(child)
  child.stdin.end()
  assert.deepEqual(await exited, { code: 0, signal: null })
  assert.equal(existsSync(value.marker), false)
})

test('owner EOF during startup reaps the complete spawned process group', async t => {
  const value = fixture(t); const child = launch(value); const exited = outcome(child)
  child.stdin.write('S')
  const match = /^pid:([1-9][0-9]*)$/u.exec(await firstLine(child.stdout)); assert.ok(match)
  const pid = Number(match[1]); await waitFor(() => existsSync(value.marker), 'engine startup marker')
  const [direct, descendant] = readFileSync(value.marker, 'utf8').split(' ').map(Number)
  assert.equal(direct, pid); assert.equal(alive(descendant), true)
  child.stdin.end()
  assert.deepEqual(await exited, { code: 0, signal: null })
  await waitFor(() => !alive(pid) && !alive(descendant) && !alive(pid, true), 'complete engine process group reap')
})
