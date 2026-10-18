import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '../../vendor/cordis/lib/index.js'
import AgentRegistry from '../../packages/core/agent/lib/index.js'
import SessionStore from '../../packages/core/session/lib/index.js'
import JsonlSessionPersistence from '../../packages/session/session-persistence-jsonl/lib/index.js'
import { createExternalEngineRouter, createExternalQwenFactory } from './external-agent-factory.mjs'
import { createExternalSessionEligibilityStore } from './external-session-eligibility.mjs'

const CHILD = new URL('./external-session-eligibility-crash-child.mjs', import.meta.url)
async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`${label} timed out`); await new Promise(resolve => setTimeout(resolve, 10)) }
}
function withDeadline(promise, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000) })]).finally(() => clearTimeout(timer))
}
async function crashAt(mode, root) {
  const persistenceRoot = join(root, 'sessions'); const eligibilityRoot = join(root, 'receipts'); const phase = join(root, `${mode}.phase`)
  const child = spawn(process.execPath, [CHILD.pathname, mode, persistenceRoot, eligibilityRoot, phase], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value })
  await waitFor(() => existsSync(phase), `${mode} child barrier`); child.kill('SIGKILL')
  const outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  assert.deepEqual(outcome, { code: null, signal: 'SIGKILL' }, stderr)
  return { eligibilityRoot, persistenceRoot }
}
async function recovery(t, roots) {
  const ctx = new Context(); await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(JsonlSessionPersistence, { root: roots.persistenceRoot, compression: 'none' })
  const calls = { create: 0, load: 0 }; const router = createExternalEngineRouter(); const engine = { router, async create() { calls.create += 1; throw new Error('recovery must not create') },
    async load({ nativeSessionId }) { calls.load += 1; return { nativeSessionId } }, async prompt() {}, async cancel() {}, async dispose() {} }
  const eligibility = createExternalSessionEligibilityStore({ eligibilityRoot: roots.eligibilityRoot, mode: 'developer', persistenceRoot: roots.persistenceRoot, persistenceScope: roots.persistenceRoot })
  const owner = createExternalQwenFactory(ctx, { artifactIdentity: 'artifact-sha256', eligibility, engine, engineId: 'qwen-code-0.24.0', model: 'qwen3.7-max', provider: 'external-qwen', router })
  t.after(async () => { await owner.close().catch(() => {}); await ctx.fiber.dispose().catch(() => {}) })
  return { calls, ctx, owner }
}

test('process death before eligibility commit leaves an inspectable log that cannot load native state', async t => {
  const root = mkdtempSync(join(tmpdir(), 'eligibility-precommit-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const roots = await crashAt('precommit', root); const next = await recovery(t, roots)
  const inspect = await next.ctx.sessionPersistence.open('crash-precommit', 'read'); assert.equal((await inspect.read()).events[0].type, 'agent/external-engine-bound'); await inspect.close()
  await assert.rejects(next.ctx.agents.resume({ resumeSessionId: 'crash-precommit' }), /not committed/)
  assert.deepEqual(next.calls, { create: 0, load: 0 })
})

test('process death after durable commit resumes the exact persisted native identity', async t => {
  const root = mkdtempSync(join(tmpdir(), 'eligibility-postcommit-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const roots = await crashAt('postcommit', root); const next = await recovery(t, roots)
  const resumed = await next.ctx.agents.resume({ resumeSessionId: 'crash-postcommit' })
  assert.equal(resumed.agent.nativeSessionId, 'native-postcommit'); assert.deepEqual(next.calls, { create: 0, load: 1 }); await resumed.dispose()
})

test('a same-ID competing process cannot replace or revoke the owned committed receipt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'eligibility-competing-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const persistenceRoot = join(root, 'sessions'); const eligibilityRoot = join(root, 'receipts'); const winnerPhase = join(root, 'winner.phase')
  const winner = spawn(process.execPath, [CHILD.pathname, 'postcommit', persistenceRoot, eligibilityRoot, winnerPhase], { stdio: ['ignore', 'pipe', 'pipe'] })
  await waitFor(() => existsSync(winnerPhase), 'winner commit barrier')
  const receipt = join(eligibilityRoot, readdirSync(eligibilityRoot).find(name => name.endsWith('.receipt'))); const committedBytes = readFileSync(receipt)
  const loserPhase = join(root, 'loser.phase'); const loser = spawn(process.execPath, [CHILD.pathname, 'postcommit', persistenceRoot, eligibilityRoot, loserPhase], { stdio: ['ignore', 'pipe', 'pipe'] })
  let loserError = ''; loser.stderr.setEncoding('utf8'); loser.stderr.on('data', value => { loserError += value })
  const lost = await withDeadline(new Promise((resolve, reject) => { loser.once('error', reject); loser.once('close', (code, signal) => resolve({ code, signal })) }), 'same-ID contender')
  assert.notEqual(lost.code, 0, loserError); assert.equal(existsSync(loserPhase), false); assert.deepEqual(readFileSync(receipt), committedBytes)
  winner.kill('SIGKILL'); await new Promise((resolve, reject) => { winner.once('error', reject); winner.once('close', resolve) })
  const next = await recovery(t, { eligibilityRoot, persistenceRoot }); const resumed = await next.ctx.agents.resume({ resumeSessionId: 'crash-postcommit' })
  assert.equal(resumed.agent.nativeSessionId, 'native-postcommit'); assert.deepEqual(next.calls, { create: 0, load: 1 }); await resumed.dispose()
})
