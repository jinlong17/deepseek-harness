import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { errorRecord, subcheck, unit, withDeadline } from './h1-driver-common.mjs'
import { createH1GovernedAgent, launchH1DriverRuntime } from '../runtime/h1-driver-runtime.mjs'

/** Product-path H1 observation extracted from the legacy aggregate probe. */

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
  let retryScenarioOrdinal = 0
  const model = await listenLoopback(async (request, response) => {
    const body = await jsonBody(request)
    const messages = JSON.stringify(body.messages)
    const gatewayRefusal = messages.includes('gateway-refusal')
    const nativeToolNegative = messages.includes('native-tool-negative')
    const retryPositive = messages.includes('retry-positive')
    const scenario = gatewayRefusal ? 'gateway-refusal'
      : nativeToolNegative ? 'native-tool-negative'
        : retryPositive ? 'retry-positive' : 'broker-refusal'
    if (retryPositive) retryScenarioOrdinal += 1
    const responseStatus = gatewayRefusal ? 403
      : retryPositive && retryScenarioOrdinal === 1 ? 503 : 200
    const record = {
      body,
      method: request.method,
      path: request.url,
      responseStatus,
      scenario,
    }
    wire.model.push(record)
    if (gatewayRefusal) {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'controlled model gateway refusal' }))
      return
    }
    if (retryPositive && retryScenarioOrdinal === 1) {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'controlled transient model gateway outage' }))
      return
    }
    if (retryPositive) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'text', text: 'Retry detector positive control recovered.' }))
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

export async function runH1(options) {
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
    const createAgent = async sessionId => {
      const handle = await createH1GovernedAgent(runtime.ctx, {
        sessionId,
        workspaceDirectory: options.workspace,
      })
      runtime.assertAgent(handle.agent)
      return handle
    }
    const brokerHandle = await createAgent('lumx-h1-broker-refusal')
    handles.push(brokerHandle)
    observation.phase = 'broker-agent-created'
    const childHandle = await runtime.ctx.agents.create({
      sessionId: 'lumx-h1-child-create', parentAgent: brokerHandle.agent,
      agentOptions: { provider: 'lumx-h1', model: 'h1-controlled' },
      meta: { cwd: options.workspace },
    })
    runtime.assertAgent(childHandle.agent)
    handles.push(childHandle)
    const resumeSessionId = 'lumx-h1-resume'
    const resumeSeed = await createAgent(resumeSessionId)
    runtime.assertAgent(resumeSeed.agent)
    await resumeSeed.dispose()
    const resumeHandle = await runtime.ctx.agents.resume({
      resumeSessionId,
      agentOptions: { provider: 'lumx-h1', model: 'h1-controlled' },
    })
    runtime.assertAgent(resumeHandle.agent)
    handles.push(resumeHandle)
    const inventory = runtime.ctx.tools.schemas(brokerHandle.agent)
    const childInventory = runtime.ctx.tools.schemas(childHandle.agent)
    const resumeInventory = runtime.ctx.tools.schemas(resumeHandle.agent)
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
    const retryHandle = await createAgent('lumx-h1-retry-positive')
    handles.push(retryHandle)
    retryHandle.agent.followup(llm.createUserMessage({
      content: [{ type: 'text', text: 'retry-positive: recover from one controlled transient Gateway failure.' }],
      source: { kind: 'user' },
    }))
    await withDeadline('H1 retry-positive turn', retryHandle.agent.whenIdle())
    observation.phase = 'retry-positive-turn-complete'
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
    const retryEvents = retryHandle.agent.session.snapshotEvents()
    const nativeEvents = nativeHandle.agent.session.snapshotEvents()
    const state = runtime.snapshot()
    const brokerRetryEvents = brokerEvents.filter(event => event.type === 'llm/retry' || event.type === 'llm/retry-started')
    const gatewayRetryEvents = gatewayEvents.filter(event => event.type === 'llm/retry' || event.type === 'llm/retry-started')
    const retryScheduledEvents = retryEvents.filter(event => event.type === 'llm/retry')
    const retryStartedEvents = retryEvents.filter(event => event.type === 'llm/retry-started')
    const nativeRetryEvents = nativeEvents.filter(event => event.type === 'llm/retry' || event.type === 'llm/retry-started')
    const brokerRefusalEvents = brokerEvents.filter(event => event.type === 'tool/result' && event.data.message.isError === true)
    const brokerTurnEnds = brokerEvents.filter(event => event.type === 'turn/end')
    const gatewayTurnEnds = gatewayEvents.filter(event => event.type === 'turn/end')
    const retryTurnEnds = retryEvents.filter(event => event.type === 'turn/end')
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
    const retryModelWire = stubs.wire.model.filter(request => request.scenario === 'retry-positive')
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
      subcheck('runProfile-composition', runtime.profile.bundles.join(',') === '@deepseek-ai/dsh-base,@deepseek-ai/dsh-web-app', runtime.profile,
        'the actual governed H1 product composition did not compose the required base and web bundles'),
      subcheck('preparation-failure-recovery', preparationFailure.message.includes('literal IPv4 loopback'),
        preparationFailure, 'a preparation failure poisoned the process-global launch lifecycle'),
      subcheck('privacy-rows-inert', privacyRows.every(row => !row.resolved
        || (row.disabled === true && row.fiberPresent === false)),
      privacyRows, 'a resolved privacy row was enabled or owned a live fiber'),
      subcheck('physical-network-denied', physicalNetwork.denied === true, physicalNetwork,
        'the OS sandbox did not deny the physical-network negative control'),
      subcheck('actual-agent-inventory', JSON.stringify(inventoryNames) === JSON.stringify(['lumx_broker']),
        { inventory, names: inventoryNames }, 'ctx.tools.schemas(actual root Agent) exposed a non-Broker tool'),
      subcheck('child-agent-pre-first-turn-policy', JSON.stringify(childInventory.map(row => row.name)) === JSON.stringify(['lumx_broker']),
        childInventory, 'a product child Agent exposed a native tool before its first turn'),
      subcheck('resumed-agent-pre-first-turn-policy', JSON.stringify(resumeInventory.map(row => row.name)) === JSON.stringify(['lumx_broker']),
        resumeInventory, 'a product resumed Agent exposed a native tool before its first turn'),
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
      subcheck('retry-detector-positive-control', retryScheduledEvents.length === 1
        && retryStartedEvents.length === 1,
      { scheduled: retryScheduledEvents, started: retryStartedEvents },
      'the real llm-retry composition did not schedule and start exactly one retry'),
      subcheck('retry-positive-model-io', retryModelWire.length === 2
        && retryModelWire[0].responseStatus === 503
        && retryModelWire[1].responseStatus === 200,
      retryModelWire, 'the retry positive control did not preserve the actual 503 then success wire attempts'),
      subcheck('retry-positive-turn-completed', retryTurnEnds.length === 1,
        retryTurnEnds, 'the retry positive control did not reach a durable turn/end'),
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
        childInventory,
        resumeInventory,
        nativeCanary: { after: nativeCanaryAfter, expected: nativeCanaryOriginal, path: nativeCanaryPath },
        nativeEventTypes: nativeEvents.map(event => event.type),
        nativeRetryCount: nativeRetryEvents.length,
        physicalNetwork,
        preparationFailure,
        privacyRows,
        retryEventTypes: retryEvents.map(event => event.type),
        retryPositiveCount: retryScheduledEvents.length,
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
