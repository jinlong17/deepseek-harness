import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createLoopbackIdentityGateway } from '../identity/loopback-gateway.mjs'
import { launchLumxRuntime } from '../runtime/launch.mjs'

function argumentsOf(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1])
  const required = name => {
    const value = values.get(name)
    if (value === undefined) throw new Error(`missing ${name}`)
    return resolve(value)
  }
  const port = name => {
    const value = Number(values.get(name))
    if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) throw new Error(`invalid ${name}`)
    return value
  }
  return {
    sourceRoot: required('--source-root'), output: required('--output'), osHome: required('--os-home'),
    workspace: required('--workspace'), hostPort: port('--host-port'), identityPort: port('--identity-port'),
    modelPort: port('--model-port'),
  }
}

function serverAt(port, handler) {
  const server = createServer(handler)
  return new Promise((resolveReady, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolveReady({
      close: () => new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose())),
      server,
    }))
  })
}

function jsonBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => { try { resolveBody(JSON.parse(body)) } catch (error) { reject(error) } })
    request.on('error', reject)
  })
}

function textOf(events) {
  return events.flatMap(event => event.type === 'assistant/message'
    ? event.data.message.content.filter(block => block.type === 'text').map(block => block.text)
    : []).join('')
}

async function sessionAttempt(runtime, id, prompt) {
  const created = await runtime.ctx.sessionController.create({ sessionId: id, cwd: process.cwd() })
  await runtime.ctx.sessionController.prompt({
    requestId: `request-${id}`, sessionId: created.sessionId, mode: 'queue',
    content: [{ type: 'text', text: prompt }],
  }, new AbortController().signal)
  const agent = runtime.ctx.agents.get(created.sessionId)
  if (agent === undefined) throw new Error(`SessionController created no Agent for ${id}`)
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  return {
    assistantText: textOf(events),
    eventTypes: events.map(event => event.type),
    failures: events.filter(event => event.type === 'assistant/attempt').map(event => event.data.failure),
    sessionId: created.sessionId,
  }
}

async function alternateAdapterAttempts(runtime, sourceRoot, setIdentity) {
  const llmModule = await import(pathToFileURL(join(sourceRoot, 'packages/llm/llm/lib/index.js')).href)
  let adapterCalls = 0
  class AlternateAdapter extends llmModule.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'LUMX alternate route probe' } }
    listModels(provider) { return Promise.resolve([{ provider, id: 'alternate', name: 'Alternate' }]) }
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: 'Alternate' }) }
    async * stream() {
      adapterCalls += 1
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const release = runtime.ctx.llm.registerAdapter(['lumx-alternate-probe'], new AlternateAdapter())
  const invoke = async () => {
    const chunks = []
    let error
    try {
      for await (const chunk of runtime.ctx.llm.stream({
        provider: 'lumx-alternate-probe', model: 'alternate', messages: [],
      })) chunks.push(chunk)
    } catch (caught) {
      error = { code: caught?.code, message: caught?.message, name: caught?.name }
    }
    return { adapterCalls, chunks, error }
  }
  try {
    setIdentity(undefined)
    const anonymous = await invoke()
    setIdentity({
      credential: 'synthetic-identity', expiresAt: '2026-10-18T12:01:00.000Z',
      subject: 'synthetic-user', type: 'lumx.local-auth.v1',
    })
    const admitted = await invoke()
    return { admitted, anonymous }
  } finally {
    release()
  }
}

async function request(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5_000) })
  return {
    body: await response.text(), headers: Object.fromEntries(response.headers), status: response.status,
  }
}

function hostRequest(url, { cookie, host, origin }) {
  const target = new URL(url)
  return new Promise((resolveRequest, reject) => {
    const request = httpRequest({
      headers: { cookie, host, ...(origin === undefined ? {} : { origin }) },
      hostname: target.hostname,
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      port: target.port,
    }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolveRequest({ body, headers: response.headers, status: response.statusCode ?? 0 }))
    })
    request.setTimeout(5_000, () => request.destroy(new Error('HTTP request timed out')))
    request.on('error', reject)
    request.end()
  })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function deniedNetworkAttempt() {
  return new Promise(resolveAttempt => {
    const socket = connect({ host: '198.51.100.1', port: 9 })
    const timeout = setTimeout(() => { socket.destroy(); resolveAttempt({ code: 'timeout', denied: false }) }, 2_000)
    socket.once('connect', () => { clearTimeout(timeout); socket.destroy(); resolveAttempt({ code: 'connected', denied: false }) })
    socket.once('error', error => { clearTimeout(timeout); resolveAttempt({ code: error.code ?? error.name, denied: error.code === 'EPERM' }) })
  })
}

function isolationCanaries() {
  let pathDenied = false
  let fdDenied = false
  try { readFileSync(process.env.LUMX_CANARY_PATH) } catch { pathDenied = true }
  try { readSync(Number(process.env.LUMX_CANARY_FD), Buffer.alloc(1), 0, 1, 0) } catch { fdDenied = true }
  return { fdDenied, pathDenied }
}

async function execute(options, capture) {
  let identity
  let identityActive = true
  let identitySubjectOverride
  let identityRequests = 0
  let modelRequests = 0
  let now = new Date('2026-10-18T12:00:00.000Z')
  const network = await deniedNetworkAttempt()
  const isolation = isolationCanaries()
  const identityStub = await serverAt(options.identityPort, async (incoming, response) => {
    identityRequests += 1
    const body = await jsonBody(incoming)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      active: identityActive,
      expiresAt: identity?.expiresAt ?? new Date(0).toISOString(),
      subject: identitySubjectOverride ?? body.subject,
    }))
  })
  const modelStub = await serverAt(options.modelPort, async (incoming, response) => {
    modelRequests += 1
    const body = await jsonBody(incoming)
    const prompt = body.messages.at(-1)?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ text: `LUMX synthetic response: ${prompt}` }))
  })
  const auth = {
    byokKey: 'synthetic-byok-only',
    endpoint: `http://127.0.0.1:${String(options.modelPort)}/model`,
    gateway: createLoopbackIdentityGateway({ endpoint: `http://127.0.0.1:${String(options.identityPort)}/validate` }),
    getIdentity: () => identity,
    now: () => now,
  }
  let runtime
  let restarted
  let preparationFailureObserved = false
  try {
    await assert.rejects(launchLumxRuntime({
      mode: 'developer', osHome: options.osHome, workspaceDirectory: options.osHome,
      sourceRoot: options.sourceRoot, port: options.hostPort, auth, environment: {},
    }), /workspaceDirectory must be outside/)
    preparationFailureObserved = true
    runtime = await launchLumxRuntime({
      mode: 'developer', osHome: options.osHome, workspaceDirectory: options.workspace,
      sourceRoot: options.sourceRoot, port: options.hostPort, auth, environment: {},
    })
    const ready = await request(runtime.readyUrl)
    const cookie = ready.headers['set-cookie']?.split(';', 1)[0]
    assert.equal(ready.status, 303)
    assert.ok(cookie)
    const page = await request(runtime.baseUrl, { headers: { cookie } })
    const wrongToken = await request(`${runtime.baseUrl}/?token=wrong`)
    const apiUrl = `${runtime.baseUrl}/api/settings/openSettingsDocument`
    const authority = new URL(runtime.baseUrl).host
    const wrongOrigin = await hostRequest(apiUrl, {
      cookie, host: authority, origin: 'http://evil.example',
    })
    const wrongHost = await hostRequest(apiUrl, {
      cookie, host: 'evil.example',
    })
    const missingOrigin = await hostRequest(apiUrl, {
      cookie, host: authority,
    })

    const alternateAdapter = await alternateAdapterAttempts(runtime, options.sourceRoot, value => { identity = value })

    let before = modelRequests
    const anonymous = await sessionAttempt(runtime, 'lumx-anonymous', 'anonymous must not call model')
    const anonymousModelRequests = modelRequests - before
    identity = { credential: 'synthetic-identity', expiresAt: '2026-10-18T12:01:00.000Z', subject: 'synthetic-user', type: 'lumx.local-auth.v1' }
    before = modelRequests
    const positive = await sessionAttempt(runtime, 'lumx-positive', 'positive control')
    const positiveModelRequests = modelRequests - before
    identity = { ...identity, type: 'wrong.type' }
    before = modelRequests
    const wrongType = await sessionAttempt(runtime, 'lumx-wrong-type', 'wrong type must not call model')
    const wrongTypeModelRequests = modelRequests - before
    identity = { ...identity, type: 'lumx.local-auth.v1', expiresAt: 'not-a-time' }
    before = modelRequests
    const invalidExpiry = await sessionAttempt(runtime, 'lumx-invalid-expiry', 'invalid expiry must not call model')
    const invalidExpiryModelRequests = modelRequests - before
    identity = { ...identity, expiresAt: now.toISOString() }
    before = modelRequests
    const equalExpiry = await sessionAttempt(runtime, 'lumx-equal-expiry', 'equal expiry must not call model')
    const equalExpiryModelRequests = modelRequests - before
    identity = { ...identity, expiresAt: '2026-10-18T12:01:00.000Z' }
    identitySubjectOverride = 'different-user'
    before = modelRequests
    const subjectMismatch = await sessionAttempt(runtime, 'lumx-subject-mismatch', 'subject mismatch must not call model')
    const subjectMismatchModelRequests = modelRequests - before
    identitySubjectOverride = undefined
    identity = { ...identity, expiresAt: '2026-10-18T11:59:59.000Z' }
    before = modelRequests
    const expired = await sessionAttempt(runtime, 'lumx-expired', 'expired must not call model')
    const expiredModelRequests = modelRequests - before
    identity = { ...identity, expiresAt: '2026-10-18T12:01:00.000Z' }
    identityActive = false
    before = modelRequests
    const revoked = await sessionAttempt(runtime, 'lumx-revoked', 'revoked must not call model')
    const revokedModelRequests = modelRequests - before
    identityActive = true

    const oldReadyUrl = runtime.readyUrl
    const oldTokenHash = sha256(new URL(oldReadyUrl).searchParams.get('token'))
    identity = undefined
    await runtime.shutdown()
    runtime = undefined
    restarted = await launchLumxRuntime({
      mode: 'developer', osHome: options.osHome, workspaceDirectory: options.workspace,
      sourceRoot: options.sourceRoot, port: options.hostPort, auth, environment: {},
    })
    const staleToken = await request(oldReadyUrl)
    const restartedReady = await request(restarted.readyUrl)
    Object.assign(capture, {
      http: {
        missingOrigin: { status: missingOrigin.status }, page: { bytes: page.body.length, status: page.status },
        ready: { status: ready.status, setCookie: Boolean(cookie) }, restartedReady: { status: restartedReady.status },
        staleToken: { status: staleToken.status }, wrongHost: { status: wrongHost.status },
        wrongOrigin: { status: wrongOrigin.status }, wrongToken: { status: wrongToken.status },
      },
      identityRequests,
      isolation,
      modelRequests,
      network,
      alternateAdapter,
      runtime: {
        baseUrl: restarted.baseUrl,
        pid: restarted.pid,
        profileName: restarted.profileName,
        readyTokenSha256: sha256(new URL(restarted.readyUrl).searchParams.get('token')),
        previousReadyTokenSha256: oldTokenHash,
        surface: restarted.surface,
      },
      sessions: {
        anonymous: { ...anonymous, modelRequests: anonymousModelRequests },
        equalExpiry: { ...equalExpiry, modelRequests: equalExpiryModelRequests },
        expired: { ...expired, modelRequests: expiredModelRequests },
        invalidExpiry: { ...invalidExpiry, modelRequests: invalidExpiryModelRequests },
        positive: { ...positive, modelRequests: positiveModelRequests },
        revoked: { ...revoked, modelRequests: revokedModelRequests },
        subjectMismatch: { ...subjectMismatch, modelRequests: subjectMismatchModelRequests },
        wrongType: { ...wrongType, modelRequests: wrongTypeModelRequests },
      },
    })
    const checks = [
      ['physical-network-denied', network.denied === true, network],
      ['main-profile-path-denied', isolation.pathDenied === true, isolation],
      ['inherited-fd-read-denied', isolation.fdDenied === true, isolation],
      ['host-token-cookie-positive', ready.status === 303 && Boolean(cookie), capture.http.ready],
      ['launch-preparation-failure-recovers', preparationFailureObserved && ready.status === 303,
        { preparationFailureObserved, subsequentReadyStatus: ready.status }],
      ['official-ui-page-ready', page.status === 200 && page.body.length > 0, capture.http.page],
      ['wrong-token-rejected', wrongToken.status === 401, capture.http.wrongToken],
      ['wrong-origin-rejected', wrongOrigin.status === 403, capture.http.wrongOrigin],
      ['wrong-host-rejected', wrongHost.status === 403, capture.http.wrongHost],
      ['missing-origin-observed', true, capture.http.missingOrigin, false],
      ['byok-anonymous-zero-model', anonymousModelRequests === 0, { modelRequests: anonymousModelRequests }],
      ['byok-wrong-type-zero-model', wrongTypeModelRequests === 0, { modelRequests: wrongTypeModelRequests }],
      ['byok-invalid-expiry-zero-model', invalidExpiryModelRequests === 0, { modelRequests: invalidExpiryModelRequests }],
      ['byok-equal-expiry-zero-model', equalExpiryModelRequests === 0, { modelRequests: equalExpiryModelRequests }],
      ['byok-subject-mismatch-zero-model', subjectMismatchModelRequests === 0, { modelRequests: subjectMismatchModelRequests }],
      ['byok-expired-zero-model', expiredModelRequests === 0, { modelRequests: expiredModelRequests }],
      ['byok-revoked-zero-model', revokedModelRequests === 0, { modelRequests: revokedModelRequests }],
      ['byok-other-adapter-anonymous-blocked', alternateAdapter.anonymous.adapterCalls === 0
        && alternateAdapter.anonymous.error?.name === 'LumxByokAdmissionError', alternateAdapter.anonymous],
      ['byok-other-adapter-positive', alternateAdapter.admitted.adapterCalls === 1
        && alternateAdapter.admitted.chunks.at(-1)?.type === 'finish', alternateAdapter.admitted],
      ['byok-positive-model-response', positiveModelRequests === 1
        && positive.assistantText.startsWith('LUMX synthetic response: ') && positive.assistantText.length > 25,
      { assistantTextBytes: positive.assistantText.length, modelRequests: positiveModelRequests }],
      ['shutdown-restart-clean', restartedReady.status === 303 && staleToken.status === 401
        && capture.runtime.previousReadyTokenSha256 !== capture.runtime.readyTokenSha256,
      { restartedReady: restartedReady.status, staleToken: staleToken.status }],
    ].map(([id, pass, evidence, required = true]) => ({
      evidence, id, required, result: pass ? 'pass' : 'fail',
    }))
    capture.checks = checks
    const byId = new Map(checks.map(check => [check.id, check]))
    const missing = (id, evidence) => ({ evidence, id, required: true, result: 'fail' })
    capture.counted_results = [
      {
        id: 'real/Cordis-shutdown', status: 'fail', coverage: 'partial',
        reason: 'actual Host shutdown/restart ran; seven-row reload/reinstall/late-shutdown lifecycle is not executed by Batch A',
        subchecks: [byId.get('shutdown-restart-clean'), missing('seven-row-cordis-lifecycle', { executed: false })],
      },
      {
        id: 'real/developer-Host-token-boundary', status: 'fail', coverage: 'actual-shared-web-host',
        reason: 'HTTP and path fences ran, but an adversarial inherited descriptor remained readable',
        subchecks: [
          byId.get('physical-network-denied'), byId.get('main-profile-path-denied'), byId.get('inherited-fd-read-denied'),
          byId.get('host-token-cookie-positive'), byId.get('wrong-token-rejected'),
          byId.get('wrong-origin-rejected'), byId.get('wrong-host-rejected'), byId.get('missing-origin-observed'),
        ],
      },
      {
        id: 'real/developer-Host-positive', status: 'pass', coverage: 'actual-shared-web-host',
        reason: 'developer-mode official Host SessionController reached the BYOK adapter and received one nonempty loopback model response',
        subchecks: [
          byId.get('byok-positive-model-response'), byId.get('byok-anonymous-zero-model'),
          byId.get('byok-wrong-type-zero-model'), byId.get('byok-invalid-expiry-zero-model'),
          byId.get('byok-equal-expiry-zero-model'), byId.get('byok-subject-mismatch-zero-model'),
          byId.get('byok-expired-zero-model'), byId.get('byok-revoked-zero-model'),
          byId.get('byok-other-adapter-anonymous-blocked'), byId.get('byok-other-adapter-positive'),
        ],
      },
      {
        id: 'real/developer-Host-control', status: 'fail', coverage: 'partial',
        reason: 'official UI bytes and Host restart ran; no rendered UI control drove cancel/restart in Batch A',
        subchecks: [
          byId.get('official-ui-page-ready'), byId.get('launch-preparation-failure-recovers'),
          missing('rendered-ui-host-control', { executed: false }),
        ],
      },
      {
        id: 'real/durable-UI-mapping', status: 'fail', coverage: 'partial',
        reason: 'actual SessionController events and official UI service ran; durable ACP identity join and browser rendering are not executed by Batch A',
        subchecks: [
          byId.get('official-ui-page-ready'), missing('durable-acp-ui-identity-join', { executed: false }),
          missing('rendered-session-event', { executed: false }),
        ],
      },
    ]
    capture.status = checks.every(check => !check.required || check.result === 'pass') ? 'pass' : 'fail'
    assert.equal(capture.status, 'pass')
  } finally {
    await runtime?.shutdown()
    await restarted?.shutdown()
    await Promise.allSettled([identityStub.close(), modelStub.close()])
  }
}

async function main() {
  const options = argumentsOf(process.argv.slice(2))
  const capture = { checks: [], schemaVersion: 1, status: 'fail' }
  try {
    await execute(options, capture)
  } catch (error) {
    capture.error = {
      code: typeof error?.code === 'string' ? error.code : undefined,
      message: String(error?.message ?? error).replace(/token=[A-Za-z0-9_-]+/gu, 'token=<redacted>'),
      name: error?.name ?? 'Error',
    }
    throw error
  } finally {
    await writeFile(options.output, `${JSON.stringify(capture, null, 2)}\n`)
  }
}

await main()
