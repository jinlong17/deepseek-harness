const ALLOWED_TOOL = 'lumx_broker'

/**
 * Apply the product H1 tool boundary to every newly published agent.
 * Agent creation and resume both publish `agent/created` only after setup and
 * before queued input can reach the first model request.
 */
export function installGovernedH1SessionPolicy(ctx) {
  const guarded = new WeakSet()
  let activeGuards = 0
  ctx.on('agent/created', ({ agent }) => {
    if (guarded.has(agent)) return
    if (!ctx.tools.schemas().some(tool => tool.name === ALLOWED_TOOL)) {
      throw new Error('governed H1 Broker capability is unavailable')
    }
    guarded.add(agent)
    agent.ctx.tools.restrict({ allow: [ALLOWED_TOOL] })
  }, { global: true, prepend: true })
  ctx.inject(['tools'], toolCtx => {
    activeGuards += 1
    toolCtx.effect(() => () => { activeGuards -= 1 })
    toolCtx.tools.guard(execution => execution.name === ALLOWED_TOOL
      ? undefined : `LUMX governed H1 denied native tool execution: ${execution.name}`)
  })
  return Object.freeze({
    assertReady() {
      if (activeGuards < 1) throw new Error('governed H1 native execution guard is unavailable')
    },
    assertAgent(agent) {
      if (!guarded.has(agent)) throw new Error('governed H1 policy was absent before agent publication')
      const names = ctx.tools.schemas(agent).map(tool => tool.name)
      if (names.length !== 1 || names[0] !== ALLOWED_TOOL) throw new Error('governed H1 agent exposes a non-Broker tool')
    },
  })
}
