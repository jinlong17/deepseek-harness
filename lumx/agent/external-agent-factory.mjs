import { randomUUID } from 'node:crypto'

import { ExternalQwenAgent } from './external-agent.mjs'

function bindingOf(events, expected) {
  const bindings = events.filter(event => event.type === 'agent/external-engine-bound')
  if (bindings.length !== 1) throw new Error('persisted external Agent must contain exactly one engine binding')
  const binding = bindings[0].data
  if (binding.version !== 1 || binding.engineId !== expected.engineId || binding.artifactIdentity !== expected.artifactIdentity
    || typeof binding.nativeSessionId !== 'string' || binding.nativeSessionId.length < 1) throw new Error('persisted external Agent binding does not match the selected engine artifact')
  return binding
}
function throwIfStopped(signal) { signal?.throwIfAborted() }

/** Route supervisor engine updates and permissions to exact live Agent handles. */
export function createExternalEngineRouter() {
  const agents = new Map()
  return Object.freeze({
    attach(handleId, agent) { if (agents.has(handleId)) throw new Error('external engine handle is already routed'); agents.set(handleId, agent); return () => { if (agents.get(handleId) === agent) agents.delete(handleId) } },
    onUpdate({ handleId, promptId, params }) { const agent = agents.get(handleId); if (agent === undefined) throw new Error('external engine update has no live Agent'); return agent.onUpdate(promptId, params) },
    onPermission({ handleId, promptId, params }) { const agent = agents.get(handleId); return agent?.requestPermission(promptId, params) ?? { outcome: { outcome: 'cancelled' } } },
    size() { return agents.size },
  })
}

/** Durable external-engine Agent factory; it never imports or wraps AgentLoop. */
export function createExternalQwenFactory(ctx, { artifactIdentity, engine, engineId, model, provider, router }) {
  if (![artifactIdentity, engineId, model, provider].every(value => typeof value === 'string' && value.length > 0)) throw new Error('external Agent factory identity is incomplete')
  const live = new Set(); let accepting = true; let closing

  async function transact(ownerCtx, options, mode) {
    if (!accepting) throw new Error('external Agent factory is disposed')
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('external Agent factory requires session persistence')
    const signal = options.signal; throwIfStopped(signal)
    const sessionId = mode === 'create' ? options.sessionId : options.resumeSessionId
    let session = mode === 'create' ? ctx.sessions.prepare(sessionId, { ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta }, ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount } }) : undefined
    const storage = mode === 'create' ? await persistence.create(session.header, { signal }) : await persistence.open(sessionId, 'write', { signal })
    let handleId; let agent; let detachSession; let detachAgent; let detachRoute; let disposeOwned; let published = false
    try {
      if (mode === 'create') {
        // The exact object whose header acquired storage is retained through publication.
      } else {
        const read = await storage.read(0, undefined, { signal }); throwIfStopped(signal)
        bindingOf(read.events, { artifactIdentity, engineId })
        session = ctx.sessions.prepare(sessionId, { seed: read.events, meta: storage.header, inheritedEventCount: storage.inheritedEventCount, eventState: read.eventState })
      }
      handleId = randomUUID(); const engineSession = mode === 'create'
        ? await engine.create({}, { handleId, signal: signal ?? new AbortController().signal })
        : await engine.load({ nativeSessionId: bindingOf(session.snapshotEvents(), { artifactIdentity, engineId }).nativeSessionId },
          { handleId, signal: signal ?? new AbortController().signal })
      throwIfStopped(signal)
      agent = new ExternalQwenAgent({ ctx, engine, handleId, id: session.id, model, nativeSessionId: engineSession.nativeSessionId,
        options: options.agentOptions ?? {}, parentAgent: options.parentAgent, provider, session })
      detachRoute = router.attach(handleId, agent)
      const setupCommit = await options.setup?.(agent.ctx, agent); throwIfStopped(signal); setupCommit?.commit(); throwIfStopped(signal)
      if (mode === 'create') session.append('agent/external-engine-bound', { version: 1, engineId, nativeSessionId: engineSession.nativeSessionId, artifactIdentity })
      const storedCount = mode === 'create' ? 0 : session.firstLiveSeq
      const suffix = session.snapshotEvents(storedCount)
      if (suffix.length > 0) await storage.append(suffix, { signal })
      await storage.flush({ signal }); throwIfStopped(signal)

      let disposeCore
      const dispose = () => (disposeCore ??= (async () => {
        agent.cancel({ kind: 'disposed' }, { keepInbox: true }); await agent.whenIdle().catch(() => {}); await agent.dispose().catch(() => {})
        detachRoute?.(); detachAgent?.(); detachSession?.(); await storage.close(); await agent.scope.dispose(); live.delete(disposeOwned)
      })())
      const releaseOwner = ownerCtx.effect(() => () => dispose(), `externalAgent(${session.id})`)
      disposeOwned = async () => { await Promise.resolve(releaseOwner()); await dispose() }
      detachSession = ctx.sessions.enter(session); detachAgent = ctx.agents.enter(agent, options.parentAgent)
      ctx.sessions.announce(session); await ctx.agents.announce(agent, mode === 'create' ? 'startup' : 'resume', signal)
      published = true; live.add(disposeOwned)
      return Object.freeze({ agent, dispose: disposeOwned })
    } catch (error) {
      if (!published) {
        await disposeOwned?.().catch(() => {}); detachRoute?.(); detachAgent?.(); detachSession?.()
        if (handleId !== undefined) await engine.dispose({ handleId }).catch(() => {})
        await storage.close().catch(() => {}); await agent?.scope.dispose().catch(() => {})
      }
      throw error
    }
  }

  const factory = Object.freeze({
    createAgent(ownerCtx, options) { return transact(ownerCtx, options, 'create') },
    resume(ownerCtx, options) { return transact(ownerCtx, options, 'resume') },
  })
  const release = ctx.agents.setFactory(factory)
  async function close() {
    return (closing ??= (async () => { accepting = false; await Promise.resolve(release()); await Promise.allSettled([...live].map(dispose => dispose())) })())
  }
  return Object.freeze({ close, factory, stats: () => Object.freeze({ accepting, live: live.size }) })
}
