import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { launchH1DriverRuntime } from '../runtime/h1-driver-runtime.mjs'

/** Lab-only executable: collect dynamic qualification evidence from real DSH composition paths. */

function argsOf(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1])
  const required = name => {
    const value = args.get(name)
    if (value === undefined) throw new Error(`missing ${name}`)
    return resolve(value)
  }
  return {
    osHome: required('--os-home'),
    output: required('--output'),
    sourceRoot: required('--source-root'),
    workspace: required('--workspace'),
  }
}

function errorRecord(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    ...error !== null && typeof error === 'object' && 'code' in error ? { code: error.code } : {},
    ...error !== null && typeof error === 'object' && 'data' in error ? { data: error.data } : {},
  }
}

function subcheck(id, passed, observed, reason) {
  return { id, status: passed ? 'pass' : 'fail', observed, ...passed ? {} : { reason } }
}

function unit(id, subchecks, reason) {
  const status = subchecks.every(row => row.status === 'pass') ? 'pass' : 'fail'
  return {
    id,
    status,
    reason: status === 'pass' ? 'all dynamic subchecks passed' : reason,
    subchecks,
  }
}

async function withDeadline(label, operation, timeoutMs = 60_000) {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function runH1(options) {
  let runtime
  let handle
  const observation = { phase: 'starting' }
  try {
    const dataHomeDirectory = join(options.osHome, '.lumx', 'h1-driver')
    runtime = await launchH1DriverRuntime({
      dataHomeDirectory,
      sourceRoot: options.sourceRoot,
      workspaceDirectory: options.workspace,
      environment: { DSH_TELEMETRY_DISABLED: '1' },
    })
    observation.phase = 'profile-started'
    handle = await runtime.ctx.agents.create({
      sessionId: 'lumx-h1-driver-session',
      agentOptions: { provider: 'lumx-h1', model: 'h1-controlled' },
      meta: { cwd: options.workspace },
      setup(agentCtx) {
        agentCtx.tools.restrict({ allow: ['lumx_broker'] })
      },
    })
    observation.phase = 'agent-created'
    const loaderEntries = [...runtime.ctx.loader.entries()]
    const privacyRows = runtime.profile.privacyRows.map(id => {
      const entry = loaderEntries.find(candidate => candidate.options.id === id)
      return {
        id,
        resolved: entry !== undefined,
        disabled: entry?.disabled ?? null,
        fiberState: entry?.fiber?.state ?? null,
        fiberPresent: entry?.fiber !== undefined,
      }
    })
    const inventory = runtime.ctx.tools.schemas(handle.agent)
    handle.agent.followup((await import(pathToFileURL(join(
      options.sourceRoot, 'packages/llm/llm/lib/index.js',
    )).href)).createUserMessage({
      content: [{ type: 'text', text: 'Attempt the governed Broker request, observe its refusal, then stop.' }],
      source: { kind: 'user' },
    }))
    await withDeadline('H1 agent turn', handle.agent.whenIdle())
    observation.phase = 'turn-complete'
    const events = handle.agent.session.snapshotEvents()
    const state = runtime.snapshot()
    const retryEvents = events.filter(event => event.type === 'llm/retry' || event.type === 'llm/retry-started')
    const refusalEvents = events.filter(event => event.type === 'tool/result' && event.data.message.isError === true)
    const turnEnds = events.filter(event => event.type === 'turn/end')
    const inventoryNames = inventory.map(row => row.name)
    const requestToolNames = state.modelRequests.map(request => request.tools.map(row => row.name))
    const subchecks = [
      subcheck('runProfile-composition', runtime.profile.bundles.join(',') === '@deepseek-ai/dsh-base', runtime.profile,
        'the actual base profile did not compose'),
      subcheck('privacy-rows-inert', privacyRows.every(row => !row.resolved
        || (row.disabled === true && row.fiberPresent === false)),
      privacyRows, 'a resolved privacy row was enabled or owned a live fiber'),
      subcheck('actual-agent-inventory', JSON.stringify(inventoryNames) === JSON.stringify(['lumx_broker']),
        { inventory, names: inventoryNames }, 'ctx.tools.schemas(actualAgent) exposed a non-Broker tool'),
      subcheck('actual-model-request-tools', requestToolNames.length >= 2
        && requestToolNames.every(names => JSON.stringify(names) === JSON.stringify(['lumx_broker'])),
      { requestCount: requestToolNames.length, requestToolNames }, 'an actual model request exposed a non-Broker tool'),
      subcheck('actual-broker-invocation', state.brokerInvocations.length === 1,
        state.brokerInvocations, 'the controlled model did not invoke the actual Broker tool exactly once'),
      subcheck('broker-refusal-observed', refusalEvents.length === 1,
        refusalEvents, 'the actual turn did not persist the Broker refusal as an error result'),
      subcheck('full-turn-completed', turnEnds.length === 1,
        turnEnds, 'the refusal path did not reach a durable turn/end'),
      subcheck('dynamic-retry-count', Number.isSafeInteger(retryEvents.length),
        { count: retryEvents.length, events: retryEvents }, 'retry count was not derived from the complete session log'),
    ]
    return {
      observation: {
        ...observation,
        eventTypes: events.map(event => event.type),
        inventory,
        privacyRows,
        modelRequests: state.modelRequests,
        brokerInvocations: state.brokerInvocations,
        brokerRefusalCount: refusalEvents.length,
        retryCount: retryEvents.length,
      },
      counted: unit('real/H1-inventory', subchecks, 'the governed H1 profile did not satisfy the actual inventory/Broker path'),
    }
  } catch (error) {
    return {
      observation: { ...observation, error: errorRecord(error) },
      counted: unit('real/H1-inventory', [
        subcheck('environment-execution', false, observation, errorRecord(error).message),
      ], 'environment failure prevented the actual H1 capability observation'),
    }
  } finally {
    if (handle !== undefined) {
      try { await handle.dispose() } catch (error) { observation.handleDisposeError = errorRecord(error) }
    }
    if (runtime !== undefined) {
      try { await runtime.shutdown() } catch (error) { observation.runtimeShutdownError = errorRecord(error) }
    }
  }
}

async function closeAcp(launched, observation) {
  if (launched === undefined) return
  try { await launched.close() } catch (error) { observation.closeError = errorRecord(error) }
  observation.stdout = launched.rawStdout()
  observation.stderr = launched.stderr()
  observation.exitCode = launched.child.exitCode
  observation.signalCode = launched.child.signalCode
}

async function runDshNonAgentLoop(options, runtimeRoot) {
  const positive = { phase: 'starting' }
  const negative = { phase: 'not-started' }
  let positiveLaunch
  let negativeLaunch
  try {
    const snapshot = await import(pathToFileURL(join(
      options.sourceRoot, 'packages/test-support/session-snapshot/lib/index.js',
    )).href)
    const protocol = await import(pathToFileURL(join(
      options.sourceRoot,
      'node_modules/.pnpm/node_modules/@agentclientprotocol/sdk/dist/acp.js',
    )).href)
    const noOpPatch = join(runtimeRoot, 'acp-positive.patch.yml')
    const disabledPatch = join(runtimeRoot, 'acp-agent-loop-disabled.patch.yml')
    await writeFile(noOpPatch, '[]\n', { mode: 0o600 })
    await writeFile(disabledPatch, [
      '- id: agent-loop',
      '  disabled: true',
      '- id: agent-loop-invariant',
      '  disabled: true',
      '',
    ].join('\n'), { mode: 0o600 })
    const agent = {
      binScript: join(options.sourceRoot, 'apps/cli/src/bin.ts'),
      libBinScript: join(options.sourceRoot, 'apps/cli/lib/bin.js'),
      configPath: noOpPatch,
      profile: 'acp',
      tsconfigPath: join(options.sourceRoot, 'tsconfig.json'),
    }
    const env = {
      DEEPSEEK_API_KEY: 'sk-synthetic-never-used',
      DSH_EXAMPLE_MODE: 'lib',
      DSH_TELEMETRY_DISABLED: '1',
    }

    positiveLaunch = snapshot.launchAcpTestAgent({ agent, cwd: options.workspace, env })
    await withDeadline('ACP positive spawn', positiveLaunch.spawned)
    positive.phase = 'spawned'
    const initialized = await withDeadline('ACP positive initialize', positiveLaunch.client.initialize({
      protocolVersion: protocol.PROTOCOL_VERSION,
      clientCapabilities: {},
    }))
    positive.phase = 'initialized'
    const created = await withDeadline('ACP positive session/new', positiveLaunch.client.newSession({
      cwd: options.workspace,
      mcpServers: [],
    }))
    positive.phase = 'session-created'
    positive.initialize = initialized
    positive.sessionId = created.sessionId
    await closeAcp(positiveLaunch, positive)
    positiveLaunch = undefined

    negative.phase = 'starting'
    negativeLaunch = snapshot.launchAcpTestAgent({
      agent,
      configPath: disabledPatch,
      cwd: options.workspace,
      env,
    })
    await withDeadline('ACP negative spawn', negativeLaunch.spawned)
    negative.phase = 'spawned'
    negative.initialize = await withDeadline('ACP negative initialize', negativeLaunch.client.initialize({
      protocolVersion: protocol.PROTOCOL_VERSION,
      clientCapabilities: {},
    }))
    negative.phase = 'initialized'
    negative.list = await withDeadline('ACP non-AgentLoop session/list', negativeLaunch.client.listSessions({
      cwd: options.workspace,
    }))
    negative.phase = 'persisted-session-listed'
    try {
      negative.newSession = await withDeadline('ACP non-AgentLoop session/new', negativeLaunch.client.newSession({
        cwd: options.workspace,
        mcpServers: [],
      }))
    } catch (error) {
      negative.newSessionError = errorRecord(error)
    }
    try {
      negative.resumeSession = await withDeadline('ACP non-AgentLoop session/resume', negativeLaunch.client.resumeSession({
        sessionId: created.sessionId,
        cwd: options.workspace,
        mcpServers: [],
      }))
    } catch (error) {
      negative.resumeSessionError = errorRecord(error)
    }
    negative.phase = 'negative-calls-complete'
    const listed = negative.list.sessions.some(row => row.sessionId === created.sessionId)
    const newErrorText = JSON.stringify(negative.newSessionError ?? {})
    const resumeErrorText = JSON.stringify(negative.resumeSessionError ?? {})
    const newMissingFactory = negative.newSessionError !== undefined && negative.newSession === undefined
      && newErrorText.includes('no agent factory registered')
    const resumeMissingFactory = negative.resumeSessionError !== undefined && negative.resumeSession === undefined
      && resumeErrorText.includes('no agent factory registered')
    const newSupported = negative.newSession !== undefined && negative.newSessionError === undefined
    const resumeSupported = negative.resumeSession !== undefined && negative.resumeSessionError === undefined
    const subchecks = [
      subcheck('agent-loop-positive-session-new', typeof created.sessionId === 'string' && created.sessionId.length > 0,
        { sessionId: created.sessionId }, 'normal AgentLoop profile did not create a session'),
      subcheck('persisted-session-load-visible', listed, negative.list,
        'the AgentLoop-disabled composition could not list the positive persisted session'),
      subcheck('non-agent-loop-session-new-capability', newSupported,
        { rejected: newMissingFactory, error: negative.newSessionError, unexpected: negative.newSession },
        newMissingFactory
          ? 'actual session/new rejected because the Agent factory is absent with AgentLoop disabled'
          : 'session/new did not produce the expected missing-factory capability refusal'),
      subcheck('non-agent-loop-session-resume-capability', resumeSupported,
        { rejected: resumeMissingFactory, error: negative.resumeSessionError, unexpected: negative.resumeSession },
        resumeMissingFactory
          ? 'actual session/resume loaded persistence but rejected because the Agent factory is absent'
          : 'session/resume did not produce the expected missing-factory capability refusal'),
    ]
    return {
      observation: { positive, negative, overlay: disabledPatch },
      counted: unit('real/DSH-non-AgentLoop-driver', subchecks,
        'DSH ACP has no non-AgentLoop Agent factory; actual session/new and session/resume reject'),
    }
  } catch (error) {
    return {
      observation: { positive, negative, environmentError: errorRecord(error) },
      counted: unit('real/DSH-non-AgentLoop-driver', [
        subcheck('environment-execution', false, { positive, negative }, errorRecord(error).message),
      ], 'environment failure prevented the real ACP non-AgentLoop capability observation'),
    }
  } finally {
    await closeAcp(positiveLaunch, positive)
    await closeAcp(negativeLaunch, negative)
  }
}

async function main() {
  const options = argsOf(process.argv.slice(2))
  const runtimeRoot = join(options.osHome, 'h1-driver-runtime')
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
  const capture = {
    generatedAt: new Date().toISOString(),
    scope: 'actual runProfile H1 inventory and actual ACP non-AgentLoop driver capability',
    counted_results: [],
    observations: {},
  }
  try {
    const h1 = await runH1(options)
    capture.counted_results.push(h1.counted)
    capture.observations.h1 = h1.observation
    const dsh = await runDshNonAgentLoop(options, runtimeRoot)
    capture.counted_results.push(dsh.counted)
    capture.observations.dshNonAgentLoop = dsh.observation
  } catch (error) {
    capture.fatal = errorRecord(error)
  } finally {
    await writeFile(options.output, `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 })
  }
  return capture.counted_results.length === 2
    && capture.counted_results.every(row => row.status === 'pass') ? 0 : 1
}

process.exitCode = await main()
