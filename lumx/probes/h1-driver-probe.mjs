import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createH1GovernedAgent, launchH1DriverRuntime } from '../runtime/h1-driver-runtime.mjs'

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

function jsonBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.once('error', reject)
    request.once('end', () => {
      try { resolveBody(JSON.parse(body)) } catch (error) { reject(error) }
    })
  })
}

function listenLoopback(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    })
  })
  return new Promise((resolveReady, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('loopback server did not expose a TCP address'))
        return
      }
      let closed
      resolveReady({
        endpoint: `http://127.0.0.1:${String(address.port)}`,
        close: () => closed ??= new Promise((resolveClose, rejectClose) => {
          server.closeIdleConnections?.()
          server.close(error => error === undefined ? resolveClose() : rejectClose(error))
        }),
      })
    })
  })
}

async function createH1LoopbackStubs(nativeCanaryPath) {
  const wire = { broker: [], model: [] }
  let brokerScenarioOrdinal = 0
  let nativeScenarioOrdinal = 0
  const model = await listenLoopback(async (request, response) => {
    const body = await jsonBody(request)
    const messages = JSON.stringify(body.messages)
    const gatewayRefusal = messages.includes('gateway-refusal')
    const nativeToolNegative = messages.includes('native-tool-negative')
    const scenario = gatewayRefusal ? 'gateway-refusal'
      : nativeToolNegative ? 'native-tool-negative' : 'broker-refusal'
    const record = {
      body,
      method: request.method,
      path: request.url,
      responseStatus: gatewayRefusal ? 403 : 200,
      scenario,
    }
    wire.model.push(record)
    if (gatewayRefusal) {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'controlled model gateway refusal' }))
      return
    }
    if (nativeToolNegative) {
      nativeScenarioOrdinal += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(nativeScenarioOrdinal === 1 ? {
        type: 'tool-call', id: 'h1-native-bash-call-1', name: 'bash',
        arguments: {
          command: `printf native-executed > ${JSON.stringify(nativeCanaryPath)}`,
          description: 'Mutate synthetic native tool canary',
        },
      } : {
        type: 'text', text: 'Native tool refusal observed; stop.',
      }))
      return
    }
    brokerScenarioOrdinal += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(brokerScenarioOrdinal === 1 ? {
      type: 'tool-call', id: 'h1-broker-call-1', name: 'lumx_broker',
      arguments: { action: 'physical-network' },
    } : {
      type: 'text', text: 'Broker refusal observed; stop.',
    }))
  })
  let broker
  try {
    broker = await listenLoopback(async (request, response) => {
      const body = await jsonBody(request)
      wire.broker.push({ body, method: request.method, path: request.url, responseStatus: 403 })
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'controlled Broker policy refusal' }))
    })
  } catch (error) {
    await model.close()
    throw error
  }
  return {
    brokerEndpoint: `${broker.endpoint}/broker`,
    close: async () => {
      const results = await Promise.allSettled([broker.close(), model.close()])
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'failed to close an H1 loopback server')
    },
    modelEndpoint: `${model.endpoint}/model`,
    wire,
  }
}

function deniedPhysicalNetworkAttempt() {
  return new Promise(resolveAttempt => {
    const socket = connect({ host: '198.51.100.1', port: 9 })
    const timeout = setTimeout(() => {
      socket.destroy()
      resolveAttempt({ code: 'timeout', denied: false })
    }, 2_000)
    socket.once('connect', () => {
      clearTimeout(timeout)
      socket.destroy()
      resolveAttempt({ code: 'connected', denied: false })
    })
    socket.once('error', error => {
      clearTimeout(timeout)
      resolveAttempt({ code: error.code ?? error.name, denied: error.code === 'EPERM' })
    })
  })
}

async function runH1(options) {
  let runtime
  let stubs
  const handles = []
  const observation = { phase: 'starting' }
  try {
    const nativeCanaryPath = join(options.workspace, 'native-tool-canary.txt')
    const nativeCanaryOriginal = 'synthetic-native-tool-canary\n'
    await writeFile(nativeCanaryPath, nativeCanaryOriginal, { mode: 0o600 })
    stubs = await createH1LoopbackStubs(nativeCanaryPath)
    observation.phase = 'loopback-ready'
    const physicalNetwork = await deniedPhysicalNetworkAttempt()
    const dataHomeDirectory = join(options.osHome, '.lumx', 'h1-driver')
    let preparationFailure
    try {
      await launchH1DriverRuntime({
        brokerEndpoint: stubs.brokerEndpoint,
        dataHomeDirectory: join(options.osHome, '.lumx', 'h1-preparation-failure'),
        modelEndpoint: 'https://not-loopback.invalid/model',
        sourceRoot: options.sourceRoot,
        workspaceDirectory: options.workspace,
        environment: { DSH_TELEMETRY_DISABLED: '1' },
      })
      throw new Error('invalid H1 endpoint unexpectedly launched')
    } catch (error) {
      preparationFailure = errorRecord(error)
      if (!preparationFailure.message.includes('literal IPv4 loopback')) throw error
    }
    runtime = await launchH1DriverRuntime({
      brokerEndpoint: stubs.brokerEndpoint,
      dataHomeDirectory,
      modelEndpoint: stubs.modelEndpoint,
      sourceRoot: options.sourceRoot,
      workspaceDirectory: options.workspace,
      environment: { DSH_TELEMETRY_DISABLED: '1' },
    })
    observation.phase = 'profile-started'
    const createAgent = sessionId => createH1GovernedAgent(runtime.ctx, {
      sessionId,
      workspaceDirectory: options.workspace,
    })
    const brokerHandle = await createAgent('lumx-h1-broker-refusal')
    handles.push(brokerHandle)
    observation.phase = 'broker-agent-created'
    const inventory = runtime.ctx.tools.schemas(brokerHandle.agent)
    const llm = await import(pathToFileURL(join(
      options.sourceRoot, 'packages/llm/llm/lib/index.js',
    )).href)
    brokerHandle.agent.followup(llm.createUserMessage({
      content: [{ type: 'text', text: 'broker-refusal: attempt the governed Broker request, observe refusal, then stop.' }],
      source: { kind: 'user' },
    }))
    await withDeadline('H1 Broker-refusal turn', brokerHandle.agent.whenIdle())
    observation.phase = 'broker-turn-complete'
    const gatewayHandle = await createAgent('lumx-h1-gateway-refusal')
    handles.push(gatewayHandle)
    gatewayHandle.agent.followup(llm.createUserMessage({
      content: [{ type: 'text', text: 'gateway-refusal: trigger the controlled model gateway refusal.' }],
      source: { kind: 'user' },
    }))
    await withDeadline('H1 model-gateway-refusal turn', gatewayHandle.agent.whenIdle())
    observation.phase = 'gateway-turn-complete'
    const nativeHandle = await createAgent('lumx-h1-native-tool-negative')
    handles.push(nativeHandle)
    nativeHandle.agent.followup(llm.createUserMessage({
      content: [{ type: 'text', text: 'native-tool-negative: attempt the native bash tool, observe refusal, then stop.' }],
      source: { kind: 'user' },
    }))
    await withDeadline('H1 native-tool-negative turn', nativeHandle.agent.whenIdle())
    observation.phase = 'turns-complete'
    const brokerEvents = brokerHandle.agent.session.snapshotEvents()
    const gatewayEvents = gatewayHandle.agent.session.snapshotEvents()
    const nativeEvents = nativeHandle.agent.session.snapshotEvents()
    const state = runtime.snapshot()
    const brokerRetryEvents = brokerEvents.filter(event => event.type === 'llm/retry' || event.type === 'llm/retry-started')
    const gatewayRetryEvents = gatewayEvents.filter(event => event.type === 'llm/retry' || event.type === 'llm/retry-started')
    const nativeRetryEvents = nativeEvents.filter(event => event.type === 'llm/retry' || event.type === 'llm/retry-started')
    const brokerRefusalEvents = brokerEvents.filter(event => event.type === 'tool/result' && event.data.message.isError === true)
    const brokerTurnEnds = brokerEvents.filter(event => event.type === 'turn/end')
    const gatewayTurnEnds = gatewayEvents.filter(event => event.type === 'turn/end')
    const gatewayFailures = gatewayEvents.filter(event => event.type === 'assistant/attempt')
    const nativeCalls = nativeEvents.filter(event => event.type === 'tool/call' && event.data.name === 'bash')
    const nativeRefusals = nativeEvents.filter(event => event.type === 'tool/result'
      && event.data.message.isError === true
      && event.data.message.toolCallId === nativeCalls[0]?.data.callId)
    const nativeTurnEnds = nativeEvents.filter(event => event.type === 'turn/end')
    const inventoryNames = inventory.map(row => row.name)
    const adapterRequestToolNames = state.modelRequests.map(request => request.tools.map(row => row.name))
    const wireRequestToolNames = stubs.wire.model.map(request => request.body.tools.map(row => row.name))
    const brokerModelWire = stubs.wire.model.filter(request => request.scenario === 'broker-refusal')
    const gatewayModelWire = stubs.wire.model.filter(request => request.scenario === 'gateway-refusal')
    const nativeModelWire = stubs.wire.model.filter(request => request.scenario === 'native-tool-negative')
    const loaderEntries = [...runtime.ctx.loader.entries()]
    const nativeLoaderEntry = loaderEntries.find(candidate => candidate.options.id === 'tool-bash')
    const nativeCanaryAfter = await readFile(nativeCanaryPath, 'utf8')
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
    const subchecks = [
      subcheck('runProfile-composition', runtime.profile.bundles.join(',') === '@deepseek-ai/dsh-base', runtime.profile,
        'the actual base profile did not compose'),
      subcheck('preparation-failure-recovery', preparationFailure.message.includes('literal IPv4 loopback'),
        preparationFailure, 'a preparation failure poisoned the process-global launch lifecycle'),
      subcheck('privacy-rows-inert', privacyRows.every(row => !row.resolved
        || (row.disabled === true && row.fiberPresent === false)),
      privacyRows, 'a resolved privacy row was enabled or owned a live fiber'),
      subcheck('physical-network-denied', physicalNetwork.denied === true, physicalNetwork,
        'the OS sandbox did not deny the physical-network negative control'),
      subcheck('actual-agent-inventory', JSON.stringify(inventoryNames) === JSON.stringify(['lumx_broker']),
        { inventory, names: inventoryNames }, 'ctx.tools.schemas(actualAgent) exposed a non-Broker tool'),
      subcheck('actual-model-request-tools', wireRequestToolNames.length > 0
        && wireRequestToolNames.length === adapterRequestToolNames.length
        && wireRequestToolNames.every(names => JSON.stringify(names) === JSON.stringify(['lumx_broker']))
        && JSON.stringify(wireRequestToolNames) === JSON.stringify(adapterRequestToolNames),
      { adapterRequestToolNames, wireRequestToolNames },
      'the actual loopback model request exposed a non-Broker tool or differed from adapter input'),
      subcheck('actual-model-gateway-io', brokerModelWire.length === 2
        && brokerModelWire.every(row => row.method === 'POST' && row.responseStatus === 200),
      brokerModelWire, 'the Broker-refusal turn did not cross the model Gateway twice over loopback HTTP'),
      subcheck('actual-broker-io', stubs.wire.broker.length === 1
        && stubs.wire.broker[0].method === 'POST'
        && stubs.wire.broker[0].responseStatus === 403
        && stubs.wire.broker[0].body.action === 'physical-network',
      stubs.wire.broker, 'the actual Broker tool did not receive exactly one loopback HTTP 403'),
      subcheck('actual-broker-invocation', state.brokerInvocations.length === 1
        && state.brokerInvocations[0].responseStatus === 403,
      state.brokerInvocations, 'the governed consumer did not observe exactly one actual Broker HTTP refusal'),
      subcheck('broker-refusal-observed', brokerRefusalEvents.length === 1,
        brokerRefusalEvents, 'the actual turn did not persist the Broker refusal as an error result'),
      subcheck('broker-full-turn-completed', brokerTurnEnds.length === 1,
        brokerTurnEnds, 'the Broker refusal path did not reach a durable turn/end'),
      subcheck('broker-repeat-count', stubs.wire.broker.length === 1,
        { count: stubs.wire.broker.length }, 'the complete Broker-refusal turn repeated the Broker request'),
      subcheck('broker-retry-count', brokerRetryEvents.length === 0,
        { count: brokerRetryEvents.length, events: brokerRetryEvents },
        'the complete Broker-refusal turn emitted an unexpected retry'),
      subcheck('model-gateway-refusal-io', gatewayModelWire.length === 1
        && gatewayModelWire[0].method === 'POST' && gatewayModelWire[0].responseStatus === 403,
      gatewayModelWire, 'the controlled model Gateway refusal was not observed as one actual HTTP 403'),
      subcheck('model-gateway-failure-observed', gatewayFailures.length >= 1,
        gatewayFailures, 'the Agent did not record the controlled model Gateway failure'),
      subcheck('model-gateway-turn-completed', gatewayTurnEnds.length === 1,
        gatewayTurnEnds, 'the model Gateway refusal did not reach a durable turn/end'),
      subcheck('model-gateway-retry-count', gatewayRetryEvents.length === 0,
        { count: gatewayRetryEvents.length, events: gatewayRetryEvents },
        'the complete model Gateway refusal turn emitted an unexpected retry'),
      subcheck('native-tool-row-disabled', nativeLoaderEntry !== undefined
        && nativeLoaderEntry.disabled === true && nativeLoaderEntry.fiber === undefined,
      nativeLoaderEntry === undefined ? { id: 'tool-bash', resolved: false } : {
        id: nativeLoaderEntry.options.id,
        packageName: nativeLoaderEntry.options.name,
        disabled: nativeLoaderEntry.disabled,
        fiberPresent: nativeLoaderEntry.fiber !== undefined,
      }, 'the real tool-bash loader row was absent, enabled, or owned a live fiber'),
      subcheck('native-tool-runtime-refusal', nativeCalls.length === 1 && nativeRefusals.length === 1,
        { calls: nativeCalls, refusals: nativeRefusals },
        'the actual Agent/ToolRuntime did not refuse exactly one unadvertised native bash call'),
      subcheck('native-tool-canary-unchanged', nativeCanaryAfter === nativeCanaryOriginal,
        { after: nativeCanaryAfter, expected: nativeCanaryOriginal, path: nativeCanaryPath },
        'the disabled native bash path mutated the synthetic canary'),
      subcheck('native-tool-negative-model-io', nativeModelWire.length === 2
        && nativeModelWire.every(row => row.method === 'POST' && row.responseStatus === 200),
      nativeModelWire, 'the native-tool negative turn did not cross the model Gateway twice'),
      subcheck('native-tool-negative-turn-completed', nativeTurnEnds.length === 1,
        nativeTurnEnds, 'the native-tool refusal path did not reach a durable turn/end'),
      subcheck('native-tool-negative-retry-count', nativeRetryEvents.length === 0,
        { count: nativeRetryEvents.length, events: nativeRetryEvents },
        'the complete native-tool refusal turn emitted an unexpected retry'),
    ]
    return {
      observation: {
        ...observation,
        adapter: state,
        brokerEventTypes: brokerEvents.map(event => event.type),
        brokerRefusalCount: brokerRefusalEvents.length,
        brokerRetryCount: brokerRetryEvents.length,
        gatewayEventTypes: gatewayEvents.map(event => event.type),
        gatewayRetryCount: gatewayRetryEvents.length,
        inventory,
        nativeCanary: { after: nativeCanaryAfter, expected: nativeCanaryOriginal, path: nativeCanaryPath },
        nativeEventTypes: nativeEvents.map(event => event.type),
        nativeRetryCount: nativeRetryEvents.length,
        physicalNetwork,
        preparationFailure,
        privacyRows,
        wire: stubs.wire,
      },
      counted: unit('real/H1-inventory', subchecks,
        'the governed H1 profile did not satisfy actual inventory/model-Gateway/Broker behavior'),
    }
  } catch (error) {
    return {
      observation: { ...observation, error: errorRecord(error) },
      counted: unit('real/H1-inventory', [
        subcheck('environment-execution', false, observation, errorRecord(error).message),
      ], 'environment failure prevented the actual H1 capability observation'),
    }
  } finally {
    for (const handle of handles.reverse()) {
      try { await handle.dispose() } catch (error) {
        observation.handleDisposeErrors ??= []
        observation.handleDisposeErrors.push(errorRecord(error))
      }
    }
    if (runtime !== undefined) {
      try { await runtime.shutdown() } catch (error) { observation.runtimeShutdownError = errorRecord(error) }
    }
    if (stubs !== undefined) {
      observation.wire = stubs.wire
      try { await stubs.close() } catch (error) { observation.stubCloseError = errorRecord(error) }
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
