import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const deadline = (promise, label, ms = 60_000) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })])
    .finally(() => clearTimeout(timer))
}
function select(events, type, predicate = () => true) { return events.filter(event => event.type === type && predicate(event)) }
function summary(agent) {
  const events = agent.session.snapshotEvents(); const calls = select(events, 'tool/call'); const results = select(events, 'tool/result')
  return Object.freeze({
    eventCount: events.length, eventTypes: events.map(event => event.type),
    retries: select(events, 'llm/retry').length, retryStarted: select(events, 'llm/retry-started').length,
    assistantAttempts: select(events, 'assistant/attempt').length, turnEnds: select(events, 'turn/end').length,
    calls: calls.map(event => ({ callId: event.data.callId, name: event.data.name, arguments: event.data.arguments })),
    results: results.map(event => ({ callId: event.data.message?.toolCallId, isError: event.data.message?.isError === true })),
  })
}
async function turn(agent, llm, text, label) {
  agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await deadline(agent.whenIdle(), label)
  return summary(agent)
}
/** Execute the H1 model/tool/session matrix inside the actual supported Host. */
export async function qualifyH1Runtime(runtime, input, runId) {
  if (runtime.consumer !== 'governed-h1') throw new Error('H1 qualification requires governed-h1 Host')
  const handles = []; const create = async suffix => {
    const handle = await runtime.ctx.agents.create({ sessionId: `b5-h1-${runId}-${suffix}`,
      agentOptions: { provider: 'lumx-h1', model: 'h1-controlled' }, meta: { cwd: input.workspaceDirectory } })
    handles.push(handle); return handle
  }
  try {
    const root = await create('broker'); const child = await runtime.ctx.agents.create({ sessionId: `b5-h1-${runId}-child`, parentAgent: root.agent,
      agentOptions: { provider: 'lumx-h1', model: 'h1-controlled' }, meta: { cwd: input.workspaceDirectory } }); handles.push(child)
    const seed = await create('resume'); await seed.dispose(); handles.splice(handles.indexOf(seed), 1)
    const resumed = await runtime.ctx.agents.resume({ resumeSessionId: `b5-h1-${runId}-resume`, agentOptions: { provider: 'lumx-h1', model: 'h1-controlled' } }); handles.push(resumed)
    const inventories = Object.freeze({ root: runtime.ctx.tools.schemas(root.agent), child: runtime.ctx.tools.schemas(child.agent), resumed: runtime.ctx.tools.schemas(resumed.agent) })
    const llm = await import(pathToFileURL(join(input.sourceRoot, 'packages/llm/llm/lib/index.js')).href)
    const broker = await turn(root.agent, llm, 'broker-refusal: attempt the governed Broker request, observe refusal, then stop.', 'H1 broker turn')
    const gatewayHandle = await create('gateway'); const gateway = await turn(gatewayHandle.agent, llm, 'gateway-refusal: trigger the controlled model gateway refusal.', 'H1 gateway turn')
    const retryHandle = await create('retry'); const retry = await turn(retryHandle.agent, llm, 'retry-positive: recover from one controlled transient Gateway failure.', 'H1 retry turn')
    const nativeHandle = await create('native'); const native = await turn(nativeHandle.agent, llm, 'native-tool-negative: attempt the native bash tool, observe refusal, then stop.', 'H1 native turn')
    const loader = [...runtime.ctx.loader.entries()]
    const nativeEntry = loader.find(row => row.options.id === 'tool-bash')
    return Object.freeze({
      bundles: runtime.bundles, inventories, broker, gateway, retry, native,
      nativeRow: nativeEntry === undefined ? { resolved: false } : { resolved: true, disabled: nativeEntry.disabled, fiberPresent: nativeEntry.fiber !== undefined, state: nativeEntry.fiber?.state ?? null },
      loaderIds: loader.map(row => row.options.id), governance: runtime.governance,
    })
  } finally {
    const results = await Promise.allSettled(handles.reverse().map(handle => handle.dispose()))
    const failures = results.filter(value => value.status === 'rejected').map(value => value.reason)
    if (failures.length) throw new AggregateError(failures, 'H1 qualification cleanup failed')
  }
}
