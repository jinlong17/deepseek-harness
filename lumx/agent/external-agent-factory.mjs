import { randomUUID } from 'node:crypto'
import { interruptedTurnClosers } from '../../packages/core/session/lib/index.js'

import { ExternalQwenAgent } from './external-agent.mjs'

function bindingOf(events, expected) {
  const bindings = events.filter(event => event.type === 'agent/external-engine-bound')
  if (bindings.length !== 1) throw new Error('persisted external Agent must contain exactly one engine binding')
  const envelope = bindings[0]; const binding = envelope.data
  if (envelope.ignorable !== undefined || binding.version !== 1 || binding.engineId !== expected.engineId || binding.artifactIdentity !== expected.artifactIdentity
    || typeof binding.nativeSessionId !== 'string' || binding.nativeSessionId.length < 1) throw new Error('persisted external Agent binding does not match the selected engine artifact')
  return binding
}
function refuseBoundSeed(seed) {
  if (seed?.some(event => event.type === 'agent/external-engine-bound')) {
    throw new Error('external engine fork from a bound session is unsupported')
  }
}

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
export function createExternalQwenFactory(ctx, { artifactIdentity, eligibility, engine, engineId, model, provider, router }) {
  if (![artifactIdentity, engineId, model, provider].every(value => typeof value === 'string' && value.length > 0)) throw new Error('external Agent factory identity is incomplete')
  if (eligibility?.prepareBirth === undefined || eligibility?.verifyCommitted === undefined) throw new Error('external Agent factory requires recovery eligibility')
  const live = new Set(); const pending = new Set(); const factoryAbort = new AbortController(); const factoryDisposal = new Error('external Agent factory disposed'); let accepting = true; let closing

  async function transact(ownerCtx, options, mode) {
    if (!accepting) throw new Error('external Agent factory is disposed')
    if (mode === 'create') refuseBoundSeed(options.seed)
    const ownerAbort = new AbortController(); let disposeOwned
    const releaseOwner = ownerCtx.effect(() => async () => { ownerAbort.abort(new Error('external Agent owner disposed')); await disposeOwned?.(true) }, 'externalAgent.transaction')
    const signal = AbortSignal.any([factoryAbort.signal, ownerAbort.signal, options.signal ?? new AbortController().signal])
    const assertTransaction = () => { signal.throwIfAborted(); if (!accepting) throw new Error('external Agent factory is disposed') }
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('external Agent factory requires session persistence')
    assertTransaction()
    const sessionId = mode === 'create' ? options.sessionId : options.resumeSessionId
    let session = mode === 'create' ? ctx.sessions.prepare(sessionId, { ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta }, ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount } }) : undefined
    let storage; let handleId; let agent; let birth; let detachSession; let detachAgent; let detachRoute; let persistedCount = 0; let published = false
    try {
      storage = mode === 'create' ? await persistence.create(session.header, { signal }) : await persistence.open(sessionId, 'write', { signal })
      assertTransaction()
      if (mode === 'create') {
        // The exact object whose header acquired storage is retained through publication.
      } else {
        const read = await storage.read(0, undefined, { signal }); assertTransaction()
        bindingOf(read.events, { artifactIdentity, engineId })
        eligibility.verifyCommitted({ ownedWriteHandle: storage, events: read.events })
        const closers = interruptedTurnClosers(read.events)
        if (closers.length > 0) await storage.append(closers, { signal })
        persistedCount = read.events.length + closers.length
        session = ctx.sessions.prepare(sessionId, { seed: [...read.events, ...closers], meta: storage.header,
          inheritedEventCount: storage.inheritedEventCount, eventState: read.eventState })
      }
      handleId = randomUUID(); const engineSession = mode === 'create'
        ? await engine.create({}, { handleId, signal: signal ?? new AbortController().signal })
        : await engine.load({ nativeSessionId: bindingOf(session.snapshotEvents(), { artifactIdentity, engineId }).nativeSessionId },
          { handleId, signal: signal ?? new AbortController().signal })
      assertTransaction()
      if (mode === 'resume' && engineSession.nativeSessionId !== bindingOf(session.snapshotEvents(), { artifactIdentity, engineId }).nativeSessionId) throw new Error('external engine loaded a different native session identity')
      agent = new ExternalQwenAgent({ ctx, engine, handleId, id: session.id, model, nativeSessionId: engineSession.nativeSessionId,
        flush: () => persistence.flush(), options: options.agentOptions ?? {}, parentAgent: options.parentAgent, provider, session })
      detachRoute = router.attach(handleId, agent)
      const setupCommit = await options.setup?.(agent.ctx, agent); assertTransaction()
      if (mode === 'create') session.append('agent/external-engine-bound', { version: 1, engineId, nativeSessionId: engineSession.nativeSessionId, artifactIdentity })
      const suffix = session.snapshotEvents(persistedCount)
      if (suffix.length > 0) await storage.append(suffix, { signal })
      await storage.flush({ signal }); assertTransaction()
      if (mode === 'create') {
        const stored = await storage.read(0, undefined, { signal }); assertTransaction()
        birth = await eligibility.prepareBirth({ ownedCreateHandle: storage, events: stored.events }); assertTransaction()
      }

      let disposeCore
      const dispose = () => (disposeCore ??= (async () => {
        const failures = []
        if (birth !== undefined && birth.state() !== 'accepted') try { birth.rejectSync('owner-disposal') } catch (error) { failures.push(error) }
        try { await agent.dispose() } catch (error) { failures.push(error) }
        detachRoute?.(); detachAgent?.(); detachSession?.()
        try { await storage.close() } catch (error) { failures.push(error) }
        try { await agent.scope.dispose() } catch (error) { failures.push(error) }
        live.delete(disposeOwned)
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'external Agent teardown failed')
      })())
      disposeOwned = async ownerTriggered => { if (!ownerTriggered) await Promise.resolve(releaseOwner()); await dispose() }
      setupCommit?.commit(); assertTransaction()
      birth?.commitSync(); assertTransaction()
      detachSession = ctx.sessions.enter(session); detachAgent = ctx.agents.enter(agent, options.parentAgent)
      ctx.sessions.announce(session); await ctx.agents.announce(agent, mode === 'create' ? 'startup' : 'resume', signal)
      assertTransaction(); birth?.accept(); published = true; live.add(disposeOwned); agent.activate()
      return Object.freeze({ agent, dispose: disposeOwned })
    } catch (error) {
      if (!published) {
        const cleanup = []
        try { birth?.rejectSync('transaction-rejected') } catch (cleanupError) { cleanup.push(cleanupError) }
        try { await disposeOwned?.() } catch (cleanupError) { cleanup.push(cleanupError) }; detachRoute?.(); detachAgent?.(); detachSession?.()
        if (disposeOwned === undefined && handleId !== undefined) try { await engine.dispose({ handleId }) } catch (cleanupError) { cleanup.push(cleanupError) }
        if (disposeOwned === undefined) try { await storage?.close() } catch (cleanupError) { cleanup.push(cleanupError) }
        if (disposeOwned === undefined) try { await agent?.scope.dispose() } catch (cleanupError) { cleanup.push(cleanupError) }
        try { await Promise.resolve(releaseOwner()) } catch (cleanupError) { cleanup.push(cleanupError) }
        if (cleanup.length > 0) throw new AggregateError([error, ...cleanup], `external Agent transaction failed and cleanup was incomplete: ${error instanceof Error ? error.message : String(error)}`)
      }
      throw error
    }
  }

  const factory = Object.freeze({
    createAgent(ownerCtx, options) { const task = transact(ownerCtx, options, 'create'); pending.add(task); task.finally(() => pending.delete(task)).catch(() => {}); return task },
    resume(ownerCtx, options) { const task = transact(ownerCtx, options, 'resume'); pending.add(task); task.finally(() => pending.delete(task)).catch(() => {}); return task },
  })
  const release = ctx.agents.setFactory(factory)
  async function close() {
    return (closing ??= (async () => {
      accepting = false; factoryAbort.abort(factoryDisposal); await Promise.resolve(release())
      const pendingResults = await Promise.allSettled([...pending]); const liveResults = await Promise.allSettled([...live].map(dispose => dispose()))
      const failures = liveResults.filter(result => result.status === 'rejected').map(result => result.reason)
      for (const result of pendingResults) if (result.status === 'rejected' && result.reason !== factoryDisposal) failures.push(result.reason)
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'external Agent factory shutdown failed')
    })())
  }
  return Object.freeze({ close, factory, stats: () => Object.freeze({ accepting, live: live.size, pending: pending.size }) })
}
