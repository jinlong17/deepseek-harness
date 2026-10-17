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
import { readLumxByokAdmissionObservations } from '../runtime/byok-plugin.mjs'

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
  const admissionStart = readLumxByokAdmissionObservations(runtime.ctx).length
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
    admission: readLumxByokAdmissionObservations(runtime.ctx).slice(admissionStart),
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
  const identityTransactions = []
  let modelRequests = 0
  const modelTransactions = []
  let now = new Date('2026-10-18T12:00:00.000Z')
  const network = await deniedNetworkAttempt()
  const isolation = isolationCanaries()
  const identityStub = await serverAt(options.identityPort, async (incoming, response) => {
    identityRequests += 1
    const body = await jsonBody(incoming)
    identityTransactions.push({
      ordinal: identityRequests, subjectSha256: sha256(String(body.subject)),
      credentialSha256: sha256(String(body.credential)),
    })
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
    const text = `LUMX synthetic response: ${prompt}`
    modelTransactions.push({
      ordinal: modelRequests, promptSha256: sha256(prompt), requestSha256: sha256(JSON.stringify(body)),
      responseBytes: Buffer.byteLength(text), responseSha256: sha256(text),
    })
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ text }))
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
    const profileDirectory = resolve(runtime.dataHomeDirectory, 'profiles', runtime.profileName)
    const profileFiles = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'lumx.runtime.patch.yml'].map(name => ({
      name, sha256: sha256(readFileSync(resolve(profileDirectory, name))),
    }))
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
      identityTransactions,
      isolation,
      modelRequests,
      modelTransactions,
      network,
      alternateAdapter,
      runtime: {
        baseUrl: restarted.baseUrl,
        dataHomeDirectory: restarted.dataHomeDirectory,
        pid: restarted.pid,
        profileFiles,
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
      ['byok-anonymous-zero-model', anonymousModelRequests === 0
        && anonymous.admission.at(-1)?.result === 'denied' && anonymous.admission.at(-1)?.code === 'identity_required',
      { admission: anonymous.admission, modelRequests: anonymousModelRequests }],
      ['byok-wrong-type-zero-model', wrongTypeModelRequests === 0
        && wrongType.admission.at(-1)?.result === 'denied' && wrongType.admission.at(-1)?.code === 'identity_required',
      { admission: wrongType.admission, modelRequests: wrongTypeModelRequests }],
      ['byok-invalid-expiry-zero-model', invalidExpiryModelRequests === 0
        && invalidExpiry.admission.at(-1)?.result === 'denied' && invalidExpiry.admission.at(-1)?.code === 'identity_expired',
      { admission: invalidExpiry.admission, modelRequests: invalidExpiryModelRequests }],
      ['byok-equal-expiry-zero-model', equalExpiryModelRequests === 0
        && equalExpiry.admission.at(-1)?.result === 'denied' && equalExpiry.admission.at(-1)?.code === 'identity_expired',
      { admission: equalExpiry.admission, modelRequests: equalExpiryModelRequests }],
      ['byok-subject-mismatch-zero-model', subjectMismatchModelRequests === 0
        && subjectMismatch.admission.at(-1)?.result === 'denied' && subjectMismatch.admission.at(-1)?.code === 'identity_rejected',
      { admission: subjectMismatch.admission, modelRequests: subjectMismatchModelRequests }],
      ['byok-expired-zero-model', expiredModelRequests === 0
        && expired.admission.at(-1)?.result === 'denied' && expired.admission.at(-1)?.code === 'identity_expired',
      { admission: expired.admission, modelRequests: expiredModelRequests }],
      ['byok-revoked-zero-model', revokedModelRequests === 0
        && revoked.admission.at(-1)?.result === 'denied' && revoked.admission.at(-1)?.code === 'identity_rejected',
      { admission: revoked.admission, modelRequests: revokedModelRequests }],
      ['byok-other-adapter-anonymous-blocked', alternateAdapter.anonymous.adapterCalls === 0
        && alternateAdapter.anonymous.error?.name === 'LumxByokAdmissionError', alternateAdapter.anonymous],
      ['byok-other-adapter-positive', alternateAdapter.admitted.adapterCalls === 1
        && alternateAdapter.admitted.chunks.at(-1)?.type === 'finish', alternateAdapter.admitted],
      ['byok-positive-model-response', positiveModelRequests === 1
        && positive.admission.at(-1)?.result === 'admitted'
        && positive.assistantText.startsWith('LUMX synthetic response: ') && positive.assistantText.length > 25,
      {
        admission: positive.admission, assistantTextBytes: positive.assistantText.length, modelRequests: positiveModelRequests,
        modelTransaction: modelTransactions[0], requestId: 'request-lumx-positive', sessionId: positive.sessionId,
      }],
      ['shutdown-restart-clean', restartedReady.status === 303 && staleToken.status === 401
        && capture.runtime.previousReadyTokenSha256 !== capture.runtime.readyTokenSha256,
      { restartedReady: restartedReady.status, staleToken: staleToken.status }],
    ].map(([id, pass, evidence, required = true]) => ({
      evidence, id, required, result: pass ? 'pass' : 'fail',
    }))
    capture.checks = checks
    const byId = new Map(checks.map(check => [check.id, check]))
    const countedResult = (id, subchecks, reasonPass, reasonFail, coverage) => {
      const passed = subchecks.every(subcheck => subcheck.required !== true || subcheck.result === 'pass')
      return { id, status: passed ? 'pass' : 'fail', reason: passed ? reasonPass : reasonFail, coverage, subchecks }
    }
    capture.counted_results = [
      countedResult('real/developer-Host-token-boundary', [
          byId.get('physical-network-denied'), byId.get('main-profile-path-denied'), byId.get('inherited-fd-read-denied'),
          byId.get('host-token-cookie-positive'), byId.get('wrong-token-rejected'),
          byId.get('wrong-origin-rejected'), byId.get('wrong-host-rejected'), byId.get('missing-origin-observed'),
        ], 'all shared Web Host fences rejected the adversarial cases',
      'one or more shared Web Host boundary checks failed', 'actual-shared-web-host'),
      countedResult('real/developer-Host-positive', [
          byId.get('byok-positive-model-response'), byId.get('byok-anonymous-zero-model'),
          byId.get('byok-wrong-type-zero-model'), byId.get('byok-invalid-expiry-zero-model'),
          byId.get('byok-equal-expiry-zero-model'), byId.get('byok-subject-mismatch-zero-model'),
          byId.get('byok-expired-zero-model'), byId.get('byok-revoked-zero-model'),
          byId.get('byok-other-adapter-anonymous-blocked'), byId.get('byok-other-adapter-positive'),
        ], 'official shared Web Host admitted valid BYOK calls and blocked every tested invalid state across adapters',
      'one or more actual shared Web Host BYOK positive or negative controls failed', 'actual-shared-web-host'),
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
    if (!Array.isArray(capture.counted_results)) {
      const failed = id => ({
        id, status: 'fail', failure_kind: 'probe_environment',
        reason: `actual Host probe stopped before qualification completed: ${capture.error.message}`,
        coverage: 'actual-partial-shared-web-host',
        subchecks: [{ id: 'actual-host-execution-complete', required: true, result: 'fail', evidence: capture.error }],
      })
      capture.counted_results = [
        failed('real/developer-Host-token-boundary'),
        failed('real/developer-Host-positive'),
      ]
    }
    throw error
  } finally {
    await writeFile(options.output, `${JSON.stringify(capture, null, 2)}\n`)
  }
}

await main()
