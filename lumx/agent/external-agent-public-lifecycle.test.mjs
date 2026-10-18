import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '../../vendor/cordis/lib/index.js'
import AgentRegistry from '../../packages/core/agent/lib/index.js'
import SessionStore from '../../packages/core/session/lib/index.js'
import { createUserMessage } from '../../packages/llm/llm/lib/index.js'
import JsonlSessionPersistence from '../../packages/session/session-persistence-jsonl/lib/index.js'
import { createExternalEngineRouter, createExternalQwenFactory } from './external-agent-factory.mjs'
import { createEligibilityFiles } from './external-session-eligibility-files.mjs'
import { createExternalSessionEligibilityStore } from './external-session-eligibility.mjs'

function engine() {
  const calls = { create: 0, dispose: 0, load: 0, prompt: 0 }; let serial = 0
  return { calls,
    async create() { calls.create += 1; return { nativeSessionId: `native-${++serial}` } },
    async load({ nativeSessionId }) { calls.load += 1; return { nativeSessionId } },
    async prompt() { calls.prompt += 1; return { result: { stopReason: 'end_turn' } } },
    async cancel() {}, async dispose() { calls.dispose += 1 },
  }
}
async function runtime(t, native, root, eligibilityOverride) {
  const ctx = new Context(); await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const router = createExternalEngineRouter(); native.router = router
  const eligibility = eligibilityOverride ?? createExternalSessionEligibilityStore({ eligibilityRoot: `${root}-eligibility`, mode: 'developer', persistenceRoot: root, persistenceScope: root })
  const owner = createExternalQwenFactory(ctx, { artifactIdentity: 'artifact-sha256', eligibility, engine: native,
    engineId: 'qwen-code-0.24.0', model: 'qwen3.7-max', provider: 'external-qwen', router })
  t.after(async () => { await owner.close().catch(() => {}); await ctx.fiber.dispose().catch(() => {}) })
  return { ctx, owner }
}
const user = () => createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })

test('resume guard cannot append an unpersisted suffix while an unchanged resume stays contiguous', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-resume-guard-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = await runtime(t, engine(), root); const made = await first.ctx.agents.create({ sessionId: 'resume-guard' })
  await made.dispose(); await first.owner.close(); await first.ctx.fiber.dispose()

  const mutating = engine(); const second = await runtime(t, mutating, root)
  await assert.rejects(second.ctx.agents.resume({ resumeSessionId: 'resume-guard', setup: (_ctx, agent) => ({ commit() { agent.followup(user()) } }) }), /changed after its durable publication prefix/)
  assert.equal(second.ctx.agents.get('resume-guard'), undefined); await second.owner.close(); await second.ctx.fiber.dispose()

  const clean = await runtime(t, engine(), root); const resumed = await clean.ctx.agents.resume({ resumeSessionId: 'resume-guard', setup: () => ({ commit() {} }) })
  resumed.agent.followup(user()); await resumed.agent.whenIdle(); await clean.ctx.sessionPersistence.flush(); await resumed.dispose()
  const stored = await clean.ctx.sessionPersistence.open('resume-guard', 'read'); const events = (await stored.read()).events; await stored.close()
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index))
})

test('direct disposed cancellation parks queued work without disposing the public Agent', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-cancel-park-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const native = engine(); const entered = Promise.withResolvers()
  native.prompt = async (_input, { signal }) => { native.calls.prompt += 1; entered.resolve(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }
  const { ctx } = await runtime(t, native, root); const handle = await ctx.agents.create({ sessionId: 'cancel-park' })
  handle.agent.followup(user()); await entered.promise; handle.agent.followup(user())
  handle.agent.cancel({ kind: 'disposed' }, { keepInbox: true }); await handle.agent.whenIdle()
  assert.equal(native.calls.prompt, 1); assert.equal(handle.agent.status, 'idle'); assert.equal(handle.agent.inbox.hasPending, true)
  await handle.dispose(); assert.equal(native.calls.dispose, 1)
})

test('failed revocation after listener rejection latches the factory before recovery IO', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-listener-revoke-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const eligibilityRoot = `${root}-eligibility`; const real = createEligibilityFiles({ eligibilityRoot, persistenceRoot: root })
  const files = { ...real, replaceOwned(...args) { if (args[2] !== undefined) throw new Error('synthetic listener revoke failure'); return real.replaceOwned(...args) } }
  const eligibility = createExternalSessionEligibilityStore({ eligibilityRoot, mode: 'developer', persistenceRoot: root, persistenceScope: root }, files)
  const native = engine(); const active = await runtime(t, native, root, eligibility)
  active.ctx.on('agent/created', () => { throw new Error('synthetic listener refusal') })
  await assert.rejects(active.ctx.agents.create({ sessionId: 'listener-revoke' }), error => error instanceof AggregateError && /cleanup was incomplete/.test(error.message))
  assert.equal(active.owner.stats().accepting, false); assert.equal(native.calls.load, 0)
  await assert.rejects(active.ctx.agents.resume({ resumeSessionId: 'listener-revoke' }), /factory|available|disposed/i); assert.equal(native.calls.load, 0)
})
