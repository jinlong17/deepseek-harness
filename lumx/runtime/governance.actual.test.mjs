import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { launchLumxRuntimeInProcess } from './internal-launch.mjs'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const BASELINE = '/Users/jinlong/.codex/worktrees/a2k-desktop-p1a-gate1/.local/g9-1/deps-source'

async function freePort() {
  const server = createServer((_, response) => response.end())
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function input(root, sourceRoot) {
  const osHome = join(root, 'home'); const workspaceDirectory = join(root, 'workspace')
  mkdirSync(osHome); mkdirSync(workspaceDirectory)
  return {
    mode: 'developer', osHome, workspaceDirectory, sourceRoot, port: await freePort(),
    auth: { byokKey: 'synthetic-relay-capability', endpoint: 'http://127.0.0.1:9/v1/chat/completions', relayOnly: true },
    environment: {},
  }
}

test('actual candidate composition denies late mutations and shuts down cleanly', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-governance-actual-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtime = await launchLumxRuntimeInProcess(await input(root, ROOT))
  t.after(runtime.shutdown)
  assert.equal(runtime.governance.rows.length, 7)
  assert(runtime.governance.rows.every(row => row.generation === 1 && row.format === 'module' && row.url.endsWith('/lib/index.js')))
  const target = runtime.governance.rows[0]
  const entry = [...runtime.ctx.loader.entries()].find(value => value.options.id === target.id)
  assert(entry)
  const group = entry.parent
  const original = entry.options
  await group.update(group.data.map(row => row.id === target.id ? { ...row, disabled: false } : row))
  assert.equal(entry.disabled, true)
  assert.equal(entry.options, original)
  assert.throws(() => group.remove(target.id), /cannot be removed/)
  await assert.rejects(group.create({ name: target.url }), /aliases protected identity/)
  await group.update(group.data.map(row => row.id === target.id ? { ...row, name: 'cordis:timer' } : row))
  assert.equal(entry.options, original)
  await group.update([
    ...group.data.filter(row => row.id !== target.id),
    { id: `${target.id}-renamed`, name: target.specifier },
  ])
  assert.equal(entry.options, original)
  assert.equal(group.data.some(row => row.id === `${target.id}-renamed`), false)
  assert.deepEqual(await runtime.shutdown(), undefined)
})

test('baseline launcher without required setup seam refuses readiness', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lumx-governance-old-loader-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const priorExitCode = process.exitCode
  try {
    await assert.rejects(launchLumxRuntimeInProcess(await input(root, BASELINE)), /setup was not invoked/)
  } finally {
    process.exitCode = priorExitCode
  }
})
