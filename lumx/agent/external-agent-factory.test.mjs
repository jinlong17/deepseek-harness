import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '../../vendor/cordis/lib/index.js'
import AgentRegistry from '../../packages/core/agent/lib/index.js'
import SessionStore from '../../packages/core/session/lib/index.js'
import { createUserMessage } from '../../packages/llm/llm/lib/index.js'
import JsonlSessionPersistence from '../../packages/session/session-persistence-jsonl/lib/index.js'
import { createExternalEngineRouter, createExternalQwenFactory } from './external-agent-factory.mjs'

async function runtime(t, engine, root, approval) {
  const ctx = new Context(); await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry)
  if (approval !== undefined) ctx.provide('approval', approval)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const router = createExternalEngineRouter(); engine.router = router
  const owner = createExternalQwenFactory(ctx, { artifactIdentity: 'artifact-sha256', engine, engineId: 'qwen-code-0.24.0', model: 'qwen3.7-max', provider: 'external-qwen', router })
  t.after(async () => { await owner.close().catch(() => {}); await ctx.fiber.dispose().catch(() => {}) })
  return { ctx, owner, router }
}
function fakeEngine() {
  const calls = { create: 0, dispose: 0, load: 0, prompt: 0 }; const nativeByHandle = new Map(); let serial = 0
  return {
    calls,
    async create(_input, { handleId }) { calls.create += 1; const nativeSessionId = `native-${++serial}`; nativeByHandle.set(handleId, nativeSessionId); return { nativeSessionId, handleId } },
    async load({ nativeSessionId }, { handleId }) { calls.load += 1; nativeByHandle.set(handleId, nativeSessionId); return { nativeSessionId } },
    async prompt(_input, { handleId, promptId }) {
      calls.prompt += 1
      await this.router.onUpdate({ handleId, promptId, params: { sessionId: nativeByHandle.get(handleId), update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'external answer' } } } })
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

test('creation listeners can queue work but rejection causes zero prompt before rollback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-unpublished-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = fakeEngine(); const { ctx } = await runtime(t, engine, root)
  ctx.on('agent/created', async ({ agent }) => { agent.followup(user()); await new Promise(resolve => setImmediate(resolve)); throw new Error('creation listener refused') })
  await assert.rejects(ctx.agents.create({ sessionId: 'listener-refused' }), /creation listener refused/)
  assert.equal(engine.calls.prompt, 0); assert.equal(ctx.agents.get('listener-refused'), undefined)
})

test('factory close aborts and drains a pending transaction without late publication', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-pending-close-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = fakeEngine(); const entered = Promise.withResolvers(); const release = Promise.withResolvers()
  engine.create = async (_input, { handleId }) => { engine.calls.create += 1; entered.resolve(); await release.promise; return { handleId, nativeSessionId: 'native-late' } }
  const { ctx, owner } = await runtime(t, engine, root)
  let published = false; ctx.on('agent/created', () => { published = true })
  const creating = ctx.agents.create({ sessionId: 'late-publication' }); await entered.promise
  let closed = false; const closing = owner.close().then(() => { closed = true }); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false)
  release.resolve(); await assert.rejects(creating, /disposed/); await closing
  assert.equal(published, false); assert.equal(ctx.agents.get('late-publication'), undefined); assert.deepEqual(owner.stats(), { accepting: false, live: 0, pending: 0 })
})

test('rejects an external-binding seed before persistence or native engine IO', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-bound-seed-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = fakeEngine(); const { ctx } = await runtime(t, engine, root)
  const parent = await ctx.agents.create({ sessionId: 'bound-parent' }); const seed = [...parent.agent.session.snapshotEvents()]
  await parent.dispose(); const before = { ...engine.calls }
  await assert.rejects(ctx.agents.create({ sessionId: 'bound-child', seed }), /fork from a bound session is unsupported/)
  assert.deepEqual(engine.calls, before); assert.equal(ctx.agents.get('bound-child'), undefined)
  await assert.rejects(ctx.sessionPersistence.open('bound-child', 'read'), /not found/i)
})

test('failed current turn drains a queued turn and disposal still releases the engine', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-failed-turn-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = fakeEngine(); let attempt = 0
  engine.prompt = async (_input, { handleId, promptId }) => {
    engine.calls.prompt += 1; attempt += 1
    if (attempt === 1) throw new Error('first turn failed')
    await engine.router.onUpdate({ handleId, promptId, params: { sessionId: 'native-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered' } } } })
    return { result: { stopReason: 'end_turn' } }
  }
  const { ctx } = await runtime(t, engine, root); const handle = await ctx.agents.create({ sessionId: 'failed-then-queued' })
  handle.agent.followup(user()); handle.agent.followup(user())
  await assert.rejects(handle.agent.whenIdle(), /first turn failed/)
  assert.equal(engine.calls.prompt, 2); assert.equal(handle.agent.status, 'idle')
  await handle.dispose(); assert.equal(engine.calls.dispose, 1)
})

test('refuses an ignorable external binding envelope and a wrong loaded native identity', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-binding-contract-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const firstEngine = fakeEngine(); const first = await runtime(t, firstEngine, root)
  const made = await first.ctx.agents.create({ sessionId: 'binding-contract' }); await made.dispose(); await first.owner.close(); await first.ctx.fiber.dispose()
  const log = join(root, '_no-cwd', 'binding-contract', 'session.v4.jsonl')
  const bytes = readFileSync(log, 'utf8'); writeFileSync(log, bytes.replace('"type":"agent/external-engine-bound"', '"ignorable":true,"type":"agent/external-engine-bound"'))
  const refused = fakeEngine(); const second = await runtime(t, refused, root)
  await assert.rejects(second.ctx.agents.resume({ resumeSessionId: 'binding-contract' }), /binding does not match/)
  assert.equal(refused.calls.load, 0)

  writeFileSync(log, bytes); const wrong = fakeEngine(); wrong.load = async () => { wrong.calls.load += 1; return { nativeSessionId: 'different-native' } }
  const third = await runtime(t, wrong, root)
  await assert.rejects(third.ctx.agents.resume({ resumeSessionId: 'binding-contract' }), /different native session identity/)
  assert.equal(wrong.calls.create, 0); assert.equal(third.ctx.agents.get('binding-contract'), undefined)
})

test('resume durably repairs an interrupted external turn before native load', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-interrupted-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const firstEngine = fakeEngine(); const first = await runtime(t, firstEngine, root)
  const made = await first.ctx.agents.create({ sessionId: 'interrupted-external' })
  made.agent.session.append('turn/start', { turn: 1 }); await first.ctx.sessionPersistence.flush()
  await made.dispose(); await first.owner.close(); await first.ctx.fiber.dispose()

  const secondEngine = fakeEngine(); const second = await runtime(t, secondEngine, root)
  const loaded = await second.ctx.agents.resume({ resumeSessionId: 'interrupted-external' })
  assert.deepEqual(loaded.agent.session.snapshotEvents().map(event => event.type), [
    'agent/external-engine-bound', 'turn/start', 'turn/end', 'session/end-seed',
  ])
  assert.deepEqual(loaded.agent.session.snapshotEvents()[2].data.reason, { kind: 'interrupted' })
  loaded.agent.followup(user()); await loaded.agent.whenIdle(); await second.ctx.sessionPersistence.flush()
  await loaded.dispose(); await second.owner.close(); await second.ctx.fiber.dispose()

  const verify = await runtime(t, fakeEngine(), root); const storage = await verify.ctx.sessionPersistence.open('interrupted-external', 'read')
  const stored = await storage.read(); await storage.close()
  assert.deepEqual(stored.events.map(event => event.type), [
    'agent/external-engine-bound', 'turn/start', 'turn/end', 'session/end-seed',
    'agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced', 'step/start', 'user/message',
    'assistant/message', 'step/end', 'turn/end',
  ])
  assert.deepEqual(stored.events.map(event => event.seq), stored.events.map((_, index) => index))
})

test('a late permission approval after turn cancellation cannot authorize work', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-late-permission-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = fakeEngine(); const entered = Promise.withResolvers(); const release = Promise.withResolvers(); let permission
  engine.prompt = async (_input, { handleId, promptId }) => {
    engine.calls.prompt += 1; entered.resolve()
    permission = await engine.router.onPermission({ handleId, promptId, params: { sessionId: 'native-1',
      toolCall: { toolCallId: 'tool-1', title: 'synthetic write' }, options: [{ kind: 'allow_once', optionId: 'allow' }] } })
    return { result: { stopReason: 'cancelled' } }
  }
  const { ctx } = await runtime(t, engine, root, { request: async () => release.promise })
  const handle = await ctx.agents.create({ sessionId: 'late-permission' }); handle.agent.followup(user()); await entered.promise
  handle.agent.cancel({ kind: 'caller' }); release.resolve('allowed-once')
  await handle.agent.whenIdle()
  assert.deepEqual(permission, { outcome: { outcome: 'cancelled' } })
  const before = handle.agent.session.snapshotEvents().length
  assert.doesNotThrow(() => engine.router.onUpdate({ handleId: handle.agent.handleId, promptId: 'late-permission:1:1', params: { sessionId: 'native-1',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'failed' } } }))
  assert.equal(handle.agent.session.snapshotEvents().length, before)
  assert.throws(() => engine.router.onUpdate({ handleId: handle.agent.handleId, promptId: 'unknown-prompt', params: { sessionId: 'native-1',
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'failed' } } }), /active prompt/)
  await handle.dispose(); assert.equal(engine.calls.dispose, 1)
})

test('factory close propagates live native cleanup failure after draining ownership', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-close-failure-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = fakeEngine(); engine.dispose = async () => { engine.calls.dispose += 1; throw new Error('synthetic native cleanup failure') }
  const { ctx, owner } = await runtime(t, engine, root); await ctx.agents.create({ sessionId: 'close-failure' })
  await assert.rejects(owner.close(), /synthetic native cleanup failure/)
  assert.deepEqual(owner.stats(), { accepting: false, live: 0, pending: 0 }); assert.equal(engine.calls.dispose, 1)
})

test('disposing an Agent parks queued inbox work before the active turn settles', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-dispose-park-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = fakeEngine(); const entered = Promise.withResolvers()
  engine.prompt = async (_input, { signal }) => { engine.calls.prompt += 1; entered.resolve(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }
  const { ctx } = await runtime(t, engine, root); const handle = await ctx.agents.create({ sessionId: 'dispose-park' })
  handle.agent.followup(user()); await entered.promise; handle.agent.followup(user()); await handle.dispose()
  assert.equal(engine.calls.prompt, 1); assert.equal(engine.calls.dispose, 1); assert.equal(ctx.agents.get('dispose-park'), undefined)
})

test('cancel quiescence waits for remote prompt drain while another Agent remains usable', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-cancel-drain-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = fakeEngine(); const entered = Promise.withResolvers(); const cancelEntered = Promise.withResolvers(); const cancelRelease = Promise.withResolvers()
  engine.prompt = async (_input, { handleId, promptId, signal }) => {
    engine.calls.prompt += 1
    if (engine.calls.prompt === 1) {
      entered.resolve()
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      return
    }
    await engine.router.onUpdate({ handleId, promptId, params: { sessionId: 'native-2', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'other handle remains usable' } } } })
    return { result: { stopReason: 'end_turn' } }
  }
  engine.cancel = async () => { cancelEntered.resolve(); await cancelRelease.promise }
  const { ctx } = await runtime(t, engine, root)
  const first = await ctx.agents.create({ sessionId: 'first-handle' }); const second = await ctx.agents.create({ sessionId: 'second-handle' })
  first.agent.followup(user()); await entered.promise; first.agent.cancel({ kind: 'caller' }); await cancelEntered.promise
  let idle = false; const waiting = first.agent.whenIdle().finally(() => { idle = true }); await new Promise(resolve => setImmediate(resolve)); assert.equal(idle, false)
  second.agent.followup(user()); await second.agent.whenIdle(); assert.equal(second.agent.status, 'idle')
  cancelRelease.resolve(); await waiting; assert.equal(idle, true)
  await first.dispose(); await second.dispose(); assert.equal(engine.calls.dispose, 2)
})

test('external native tools persist one advertised call/result lifecycle', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-tool-lifecycle-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = fakeEngine(); const { ctx } = await runtime(t, engine, root)
  engine.prompt = async (_input, { handleId, promptId }) => {
    const sessionId = 'native-1'; const base = { handleId, promptId, params: { sessionId } }
    await engine.router.onUpdate({ ...base, params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'native-shell', rawInput: { command: 'true' }, status: 'in_progress' } } })
    await engine.router.onUpdate({ ...base, params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: { exitCode: 0 } } } })
    await engine.router.onUpdate({ ...base, params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } })
    return { result: { stopReason: 'end_turn' } }
  }
  const handle = await ctx.agents.create({ sessionId: 'external-tool-session' }); handle.agent.followup(user()); await handle.agent.whenIdle(); await ctx.sessionPersistence.flush(); await handle.dispose()
  const stored = await ctx.sessionPersistence.open('external-tool-session', 'read'); const types = (await stored.read()).events.map(event => event.type); await stored.close()
  assert.deepEqual(types.filter(type => type === 'assistant/message' || type === 'tool/call' || type === 'tool/result'), ['assistant/message', 'tool/call', 'tool/result', 'assistant/message'])
})

test('a native tool without a terminal update persists an unknown-outcome result before step closure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'external-tool-unknown-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = fakeEngine(); const { ctx } = await runtime(t, engine, root)
  engine.prompt = async (_input, { handleId, promptId }) => {
    await engine.router.onUpdate({ handleId, promptId, params: { sessionId: 'native-1', update: { sessionUpdate: 'tool_call', toolCallId: 'tool-unknown', title: 'native-shell', rawInput: { command: 'true' }, status: 'in_progress' } } })
    throw new Error('native engine died after tool start')
  }
  const handle = await ctx.agents.create({ sessionId: 'external-tool-unknown' }); handle.agent.followup(user())
  await assert.rejects(handle.agent.whenIdle(), /native engine died/); await ctx.sessionPersistence.flush(); await handle.dispose().catch(() => {})
  assert.deepEqual(handle.agent.session.snapshotEvents().map(event => [event.type, event.type === 'tool/result' ? event.data.error?.code : undefined]), [
    ['agent/external-engine-bound', undefined], ['agent/inbox/spliced', undefined], ['turn/start', undefined], ['agent/inbox/spliced', undefined],
    ['step/start', undefined], ['user/message', undefined], ['assistant/message', undefined], ['tool/call', undefined], ['assistant/attempt', undefined],
    ['tool/result', 'TOOL_OUTCOME_UNKNOWN'], ['step/end', undefined], ['turn/end', undefined],
  ])
  const stored = await ctx.sessionPersistence.open('external-tool-unknown', 'read'); const events = (await stored.read()).events; await stored.close()
  const result = events.find(event => event.type === 'tool/result')
  assert.equal(result?.data.error?.code, 'TOOL_OUTCOME_UNKNOWN'); assert.equal(result?.surfaceOp, 'append')
  assert.ok(events.findIndex(event => event.type === 'tool/result') < events.findIndex(event => event.type === 'step/end'))
})
