const ALLOWED_TOOL = 'lumx_broker'

/**
 * Apply the product H1 tool boundary to every newly published agent.
 * Agent creation and resume both publish `agent/created` only after setup and
 * before queued input can reach the first model request.
 */
export function installGovernedH1SessionPolicy(ctx) {
  const guarded = new Set()
  const disposeCreated = ctx.on('agent/created', ({ agent }) => {
    if (guarded.has(agent)) return
    guarded.add(agent)
    agent.ctx.tools.restrict({ allow: [ALLOWED_TOOL] })
  }, { global: true, prepend: true })
  const disposeGuard = ctx.tools.guard(execution => execution.name === ALLOWED_TOOL
    ? undefined : `LUMX governed H1 denied native tool execution: ${execution.name}`)
  return Object.freeze({
    assertAgent(agent) {
      if (!guarded.has(agent)) throw new Error('governed H1 policy was absent before agent publication')
      const names = agent.ctx.tools.schemas().map(tool => tool.name)
      if (names.length !== 1 || names[0] !== ALLOWED_TOOL) throw new Error('governed H1 agent exposes a non-Broker tool')
    },
    dispose() { disposeCreated(); disposeGuard(); guarded.clear() },
  })
}
