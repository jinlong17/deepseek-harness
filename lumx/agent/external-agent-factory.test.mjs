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

async function runtime(t, engine, root) {
  const ctx = new Context(); await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root })
  const router = createExternalEngineRouter(); engine.router = router
  const owner = createExternalQwenFactory(ctx, { artifactIdentity: 'artifact-sha256', engine, engineId: 'qwen-code-0.24.0', model: 'qwen3.7-max', provider: 'external-qwen', router })
  t.after(async () => { await owner.close().catch(() => {}); await ctx.fiber.dispose().catch(() => {}) })
  return { ctx, owner, router }
}
function fakeEngine() {
  const calls = { create: 0, dispose: 0, load: 0, prompt: 0 }; let serial = 0
  return {
    calls,
    async create(_input, { handleId }) { calls.create += 1; return { nativeSessionId: `native-${++serial}`, handleId } },
    async load({ nativeSessionId }) { calls.load += 1; return { nativeSessionId } },
    async prompt(_input, { handleId, promptId }) {
      calls.prompt += 1
      await this.router.onUpdate({ handleId, promptId, params: { sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'external answer' } } } })
      return { result: { stopReason: 'end_turn' } }
    },
    async cancel() {}, async dispose() { calls.dispose += 1 },
  }
}
const user = () => createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })

test('publishes only after required engine binding is durable and drives the public Agent surface', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-factory-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = fakeEngine(); const { ctx, owner, router } = await runtime(t, engine, root)
  let observed
  ctx.on('agent/created', ({ agent }) => { observed = agent.session.snapshotEvents().map(event => event.type) })
  const handle = await ctx.agents.create({ sessionId: 'external-session', setup: () => ({ commit() { assert.equal(ctx.agents.get('external-session'), undefined) } }) })
  handle.agent.followup(user()); await handle.agent.whenIdle(); await ctx.sessionPersistence.flush()
  assert.deepEqual(observed, ['agent/external-engine-bound'])
  assert.equal(handle.agent.status, 'idle'); assert.equal(engine.calls.prompt, 1); assert.equal(router.size(), 1)
  assert.deepEqual(handle.agent.session.snapshotEvents().map(event => event.type), [
    'agent/external-engine-bound', 'agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced', 'step/start', 'user/message',
    'assistant/message', 'step/end', 'turn/end',
  ])
  await handle.dispose(); assert.equal(router.size(), 0); assert.equal(owner.stats().live, 0)
})

test('resumes the exact durable native ID and never falls back to create when load rejects', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-resume-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const firstEngine = fakeEngine(); const first = await runtime(t, firstEngine, root)
  const made = await first.ctx.agents.create({ sessionId: 'resume-session' }); const native = made.agent.nativeSessionId
  await made.dispose(); await first.owner.close(); await first.ctx.fiber.dispose()

  const secondEngine = fakeEngine(); const second = await runtime(t, secondEngine, root)
  const loaded = await second.ctx.agents.resume({ resumeSessionId: 'resume-session' })
  assert.equal(loaded.agent.nativeSessionId, native); assert.equal(secondEngine.calls.load, 1); assert.equal(secondEngine.calls.create, 0)
  await loaded.dispose(); await second.owner.close(); await second.ctx.fiber.dispose()

  const refused = fakeEngine(); refused.load = async () => { refused.calls.load += 1; throw new Error('native load refused') }
  const third = await runtime(t, refused, root)
  await assert.rejects(third.ctx.agents.resume({ resumeSessionId: 'resume-session' }), /native load refused/)
  assert.equal(refused.calls.create, 0); assert.equal(third.ctx.agents.get('resume-session'), undefined)
})
