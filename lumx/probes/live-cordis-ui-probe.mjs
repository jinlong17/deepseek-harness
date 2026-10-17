import { createHash } from 'node:crypto'
import { readFileSync, readSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'

import { createLoopbackIdentityGateway } from '../identity/loopback-gateway.mjs'
import { launchLumxRuntime } from '../runtime/launch.mjs'
import {
  ACP_PROMPT, ACP_RESPONSE, createBrowserState, locateDurableSession, runAcpDurablePrompt,
} from './live-cordis-ui-support.mjs'

const PRIVACY_IDS = Object.freeze([
  'session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
  'deepseek-account', 'llm-deepseek-account', 'desktop-product-telemetry', 'product-analytics',
])
const CANCEL_PROMPT = 'browser control cancel probe'
const SAFE_LATE_ENABLE_ID = 'product-analytics'

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
    browser: required('--browser'), sourceRoot: required('--source-root'), output: required('--output'),
    osHome: required('--os-home'), workspace: required('--workspace'), hostPort: port('--host-port'),
    identityPort: port('--identity-port'), modelPort: port('--model-port'),
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeError(error) {
  const message = String(error?.message ?? error).replace(/token=[A-Za-z0-9_-]+/gu, 'token=<redacted>')
  return { code: error?.code, message, name: error?.name ?? 'Error' }
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

function serverAt(port, handler) {
  const server = createServer(handler)
  return new Promise((resolveReady, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolveReady({
      close: () => new Promise((resolveClose, rejectClose) => {
        server.closeAllConnections?.()
        server.close(error => error ? rejectClose(error) : resolveClose())
      }),
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

function privacySnapshot(ctx) {
  const entries = [...ctx.loader.entries()]
  return PRIVACY_IDS.map(id => {
    const entry = entries.find(candidate => candidate.options.id === id)
    return entry === undefined
      ? { id, resolved: false, disabled: undefined, fiberPresent: false, fiberState: undefined }
      : {
          id, resolved: true, disabled: entry.disabled, fiberPresent: entry.fiber !== undefined,
          fiberState: entry.fiber?.state, name: entry.options.name,
        }
  })
}

function rowMap(rows) {
  return new Map(rows.map(row => [row.id, row]))
}

async function exercisePrivacyLifecycle(runtime) {
  const initial = privacySnapshot(runtime.ctx)
  const actions = []
  for (const id of PRIVACY_IDS) {
    const entry = [...runtime.ctx.loader.entries()].find(candidate => candidate.options.id === id)
    if (entry === undefined) {
      actions.push({ id, action: 'update-remove-reinstall', executed: false, reason: 'row unresolved in actual composition' })
      continue
    }
    await entry.update({ disabled: true }, false, true)
    await runtime.ctx.loader.await()
    const afterUpdate = privacySnapshot(runtime.ctx).find(row => row.id === id)
    const parent = entry.parent
    const options = structuredClone(entry.options)
    const position = Math.max(0, parent.data.indexOf(entry.options))
    parent.remove(entry.options.id)
    await runtime.ctx.loader.await()
    const absentAfterRemove = !privacySnapshot(runtime.ctx).find(row => row.id === id)?.resolved
    parent.data.splice(position, 0, options)
    parent.tree.write()
    await parent.create(options)
    await runtime.ctx.loader.await()
    const afterReinstall = privacySnapshot(runtime.ctx).find(row => row.id === id)
    actions.push({
      id, action: 'update-remove-reinstall', executed: true, absentAfterRemove,
      updateDisabled: afterUpdate?.disabled, updateFiberPresent: afterUpdate?.fiberPresent,
      reinstallDisabled: afterReinstall?.disabled, reinstallFiberPresent: afterReinstall?.fiberPresent,
    })
  }
  const lateEntry = [...runtime.ctx.loader.entries()].find(candidate => candidate.options.id === SAFE_LATE_ENABLE_ID)
  let lateEnable
  if (lateEntry === undefined) {
    lateEnable = { id: SAFE_LATE_ENABLE_ID, executed: false, reason: 'safe qualification row unresolved' }
  } else {
    try {
      await lateEntry.update({ disabled: false }, false, true)
      await runtime.ctx.loader.await()
      const enabled = privacySnapshot(runtime.ctx).find(row => row.id === SAFE_LATE_ENABLE_ID)
      lateEnable = {
        id: SAFE_LATE_ENABLE_ID, executed: true, rejected: false,
        enabledDisabled: enabled?.disabled, enabledFiberPresent: enabled?.fiberPresent,
        enabledFiberState: enabled?.fiberState,
      }
    } catch (error) {
      lateEnable = { id: SAFE_LATE_ENABLE_ID, executed: true, rejected: true, error: safeError(error) }
    } finally {
      await lateEntry.update({ disabled: true }, false, true)
      await runtime.ctx.loader.await()
      const restored = privacySnapshot(runtime.ctx).find(row => row.id === SAFE_LATE_ENABLE_ID)
      lateEnable.restoredDisabled = restored?.disabled
      lateEnable.restoredFiberPresent = restored?.fiberPresent
      lateEnable.restoredFiberState = restored?.fiberState
    }
  }
  const final = privacySnapshot(runtime.ctx)
  const finalEntries = PRIVACY_IDS.flatMap(id => {
    const entry = [...runtime.ctx.loader.entries()].find(candidate => candidate.options.id === id)
    return entry === undefined ? [] : [{ entry, id }]
  })
  const scopedCandidates = [...runtime.ctx.loader.entries()].flatMap(entry => {
    const searchable = `${entry.options.id} ${entry.options.name}`.toLowerCase()
    return /(deepseek|telemetry|analytics|inventory|session-log)/u.test(searchable)
      ? [{ id: entry.options.id, name: entry.options.name, disabled: entry.disabled, fiberPresent: entry.fiber !== undefined }]
      : []
  })
  return { actions, final, finalEntries, initial, lateEnable, scopedCandidates }
}

async function openingSnapshot(ctx, sessionId) {
  const abort = new AbortController()
  const iterator = ctx.sessionController.follow({ address: { kind: 'session', sessionId } }, abort.signal)[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done || first.value.type !== 'snapshot') throw new Error('session follow returned no opening snapshot')
    const value = first.value
    return {
      cursor: value.cursor, header: value.header, recordCount: value.records.length,
      recordsSha256: sha256(JSON.stringify(value.records)),
      responsePresent: JSON.stringify(value.records).includes(ACP_RESPONSE),
      promptPresent: JSON.stringify(value.records).includes(ACP_PROMPT),
    }
  } finally {
    abort.abort()
    await iterator.return?.()
  }
}

function check(id, pass, evidence, required = true) {
  return { id, result: pass ? 'pass' : 'fail', required, evidence }
}

function failureResults(capture) {
  if (capture.counted_results.length > 0) return
  const error = capture.error ?? { message: 'probe did not reach qualification result construction' }
  const privacy = capture.observations?.privacy
  const cordisChecks = [
    check('actual-privacy-lifecycle-attempt', privacy !== undefined, privacy ?? error),
    check('actual-shutdown-restart-complete', false, error),
  ]
  const controlChecks = [
    check('actual-official-ui-control-attempt', capture.observations?.browser !== undefined, capture.observations?.browser ?? error),
    check('actual-ui-host-restart-complete', false, error),
  ]
  const durableChecks = [
    check('actual-acp-session-created', capture.observations?.acp?.phase === 'prompt-complete', capture.observations?.acp ?? error),
    check('actual-acp-controller-ui-join-complete', false, error),
  ]
  const unit = (id, coverage, subchecks) => ({
    id, status: subchecks.every(value => value.result === 'pass') ? 'pass' : 'fail',
    failure_kind: 'probe_environment',
    reason: `actual probe stopped before qualification completed: ${error.message}`,
    coverage, subchecks,
  })
  capture.checks = [...cordisChecks, ...controlChecks, ...durableChecks]
  capture.counted_results = [
    unit('real/Cordis-shutdown', 'actual-partial-cordis-lifecycle', cordisChecks),
    unit('real/developer-Host-control', 'actual-partial-official-web-ui-shared-host', controlChecks),
    unit('real/durable-UI-mapping', 'actual-partial-acp-controller-ui-chain', durableChecks),
  ]
}

function redactCapture(value) {
  if (typeof value === 'string') return value.replace(/token=[A-Za-z0-9_-]+/gu, 'token=<redacted>')
  if (Array.isArray(value)) return value.map(redactCapture)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCapture(item)]))
  }
  return value
}

async function execute(options, capture) {
  let identityRequests = 0
  let modelRequests = 0
  let cancelledModelConnections = 0
  let markCancelArrived
  let markCancelClosed
  const cancelBarrier = {
    arrived: new Promise(resolveBarrier => { markCancelArrived = resolveBarrier }),
    closed: new Promise(resolveBarrier => { markCancelClosed = resolveBarrier }),
  }
  const pendingTimers = new Set()
  const identity = {
    credential: 'synthetic-identity', expiresAt: '2026-10-18T12:01:00.000Z',
    subject: 'synthetic-user', type: 'lumx.local-auth.v1',
  }
  const network = await deniedNetworkAttempt()
  const isolation = isolationCanaries()
  capture.observations = { isolation, network }
  const identityStub = await serverAt(options.identityPort, async (incoming, response) => {
    identityRequests += 1
    const body = await jsonBody(incoming)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ active: true, expiresAt: identity.expiresAt, subject: body.subject }))
  })
  const modelStub = await serverAt(options.modelPort, async (incoming, response) => {
    modelRequests += 1
    const body = await jsonBody(incoming)
    const messageText = body.messages.flatMap(message => message.content ?? [])
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const prompt = messageText.includes(CANCEL_PROMPT) ? CANCEL_PROMPT
      : messageText.includes(ACP_PROMPT) ? ACP_PROMPT
        : body.messages.at(-1)?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    if (prompt.includes(CANCEL_PROMPT)) {
      markCancelArrived()
      await new Promise(resolvePending => {
        let settled = false
        const finish = closed => {
          if (settled) return
          settled = true
          if (closed) {
            cancelledModelConnections += 1
            markCancelClosed()
          }
          clearTimeout(timer)
          pendingTimers.delete(timer)
          resolvePending()
        }
        const timer = setTimeout(() => {
          if (!response.destroyed) {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ text: `LUMX synthetic response: ${prompt}` }))
          }
          finish(false)
        }, 30_000)
        pendingTimers.add(timer)
        response.once('close', () => finish(true))
      })
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ text: `LUMX synthetic response: ${prompt}` }))
  })
  const auth = {
    byokKey: 'synthetic-byok-only', endpoint: `http://127.0.0.1:${String(options.modelPort)}/model`,
    gateway: createLoopbackIdentityGateway({ endpoint: `http://127.0.0.1:${String(options.identityPort)}/validate` }),
    getIdentity: () => identity, now: () => new Date('2026-10-18T12:00:00.000Z'),
  }
  let runtime
  let restarted
  let consumer
  let browser
  try {
    const acp = await runAcpDurablePrompt(options)
    capture.observations.acp = acp.observation
    runtime = await launchLumxRuntime({
      mode: 'developer', osHome: options.osHome, workspaceDirectory: options.workspace,
      sourceRoot: options.sourceRoot, port: options.hostPort, auth, environment: {},
    })
    const privacy = await exercisePrivacyLifecycle(runtime)
    capture.observations.privacy = { ...privacy, finalEntries: undefined }
    browser = await createBrowserState(options, runtime, acp, cancelBarrier)
    const beforeRestart = await openingSnapshot(runtime.ctx, browser.durable.sessionId)
    await runtime.shutdown()
    runtime = undefined
    const afterShutdown = privacy.finalEntries.map(({ entry, id }) => ({
      id, fiberPresent: entry.fiber !== undefined, fiberState: entry.fiber?.state,
    }))
    restarted = await launchLumxRuntime({
      mode: 'developer', osHome: options.osHome, workspaceDirectory: options.workspace,
      sourceRoot: options.sourceRoot, port: options.hostPort, auth, environment: {},
    })
    const afterRestart = await openingSnapshot(restarted.ctx, browser.durable.sessionId)
    await browser.page.goto(restarted.readyUrl, { waitUntil: 'load', timeout: 30_000 })
    await browser.page.locator('[data-slot="root"]').waitFor({ state: 'attached', timeout: 20_000 })
    const renderedAfterRestart = await locateDurableSession(browser.page, ACP_RESPONSE)
    const screenshotPath = join(dirname(options.output), 'live-cordis-ui.png')
    await browser.page.screenshot({ path: screenshotPath, fullPage: true })
    const body = await browser.page.locator('body').innerText()
    await browser.context.close()
    browser.context = undefined
    await restarted.shutdown()
    restarted = undefined
    consumer = await launchLumxRuntime({
      mode: 'consumer', osHome: options.osHome, workspaceDirectory: options.workspace,
      sourceRoot: options.sourceRoot, port: options.hostPort, auth, environment: {},
    })
    const consumerRows = privacySnapshot(consumer.ctx)
    const governedAdapterEntries = [...consumer.ctx.loader.entries()].filter(entry =>
      /(^|[-_])h1($|[-_])|govern/iu.test(`${entry.options.id} ${entry.options.name}`))
      .map(entry => ({
        id: entry.options.id, name: entry.options.name, disabled: entry.disabled,
        fiberPresent: entry.fiber !== undefined,
      }))
    const initialRows = rowMap(privacy.initial)
    const finalRows = rowMap(privacy.final)
    const presentIds = PRIVACY_IDS.filter(id => initialRows.get(id)?.resolved)
    const missingIds = PRIVACY_IDS.filter(id => !initialRows.get(id)?.resolved)
    const lifecyclePass = privacy.actions.every(action => action.executed && action.updateDisabled === true
      && action.updateFiberPresent === false && action.absentAfterRemove === true
      && action.reinstallDisabled === true && action.reinstallFiberPresent === false)
    const disabledPass = PRIVACY_IDS.every(id => initialRows.get(id)?.resolved === true
      && initialRows.get(id)?.disabled === true && initialRows.get(id)?.fiberPresent === false
      && finalRows.get(id)?.disabled === true
      && (finalRows.get(id)?.fiberPresent === false || finalRows.get(id)?.fiberState === 4))
    const shutdownPass = afterShutdown.length === PRIVACY_IDS.length
      && afterShutdown.every(row => row.fiberPresent === false || row.fiberState === 4)
    const durablePass = beforeRestart.cursor === afterRestart.cursor
      && beforeRestart.recordsSha256 === afterRestart.recordsSha256
      && beforeRestart.promptPresent && beforeRestart.responsePresent
      && afterRestart.promptPresent && afterRestart.responsePresent
    const uiCancelPass = browser.apiRequests.includes('/api/session/cancel') && cancelledModelConnections >= 1
    const uiRenderPass = browser.durableRendered && browser.initialRender.acpResponse > 0 && renderedAfterRestart
    const lateReenableRejected = privacy.lateEnable.executed === true && privacy.lateEnable.rejected === true
      && privacy.lateEnable.restoredDisabled === true
      && (privacy.lateEnable.restoredFiberPresent === false || privacy.lateEnable.restoredFiberState === 4)
    const consumerPass = consumerRows.every(row => row.resolved && row.disabled === true
      && (row.fiberPresent === false || row.fiberState === 4))
    const acpJoinPass = acp.observation.phase === 'prompt-complete'
      && browser.durable.sessionId === acp.sessionId
      && beforeRestart.responsePresent && afterRestart.responsePresent && renderedAfterRestart
    const checks = [
      check('physical-network-denied', network.denied === true, network),
      check('main-profile-path-denied', isolation.pathDenied === true, isolation),
      check('inherited-fd-read-denied', isolation.fdDenied === true, isolation),
      check('privacy-seven-resolved-disabled-no-fiber', disabledPass, { presentIds, missingIds, initial: privacy.initial, final: privacy.final }),
      check('privacy-safe-update-remove-reinstall', lifecyclePass, privacy.actions),
      check('privacy-late-reenable-rejected', lateReenableRejected, privacy.lateEnable),
      check('privacy-renamed-absent-uncomposed-inventory', missingIds.length === 0, { missingIds, scopedCandidates: privacy.scopedCandidates }),
      check('privacy-shutdown-no-fiber', shutdownPass, afterShutdown),
      check('durable-session-controller-restart', durablePass, { beforeRestart, afterRestart }),
      check('official-ui-created-and-rendered-session', uiRenderPass, { initial: browser.initialRender, renderedAfterRestart }),
      check('official-ui-cancel-reached-host', uiCancelPass, {
        cancelRequests: browser.apiRequests.filter(path => path === '/api/session/cancel').length,
        cancelledModelConnections,
      }),
      check('official-ui-reconnected-after-host-restart', renderedAfterRestart, { renderedAfterRestart }),
      check('browser-page-errors-empty', browser.pageErrors.length === 0, browser.pageErrors),
      check('browser-console-errors-observed', true, { count: browser.consoleErrors.length, sha256: sha256(JSON.stringify(browser.consoleErrors)) }, false),
      check('consumer-profile-privacy-consumer', consumerPass, consumerRows),
      check('governed-desktop-h1-adapter-capability', governedAdapterEntries.length > 0, {
        entries: governedAdapterEntries,
        reason: governedAdapterEntries.length === 0
          ? 'actual consumer composition exposes no governed desktop/H1 adapter'
          : 'actual consumer composition exposes a governed adapter candidate',
      }),
      check('durable-external-acp-identity-join', acpJoinPass, {
        acp: acp.observation, controllerSessionId: browser.durable.sessionId,
        beforeRestart, afterRestart, renderedAfterRestart,
      }),
    ]
    const byId = new Map(checks.map(value => [value.id, value]))
    const result = (id, subcheckIds, reasonPass, reasonFail, coverage) => {
      const subchecks = subcheckIds.map(key => byId.get(key))
      const passed = subchecks.every(value => value?.required !== true || value.result === 'pass')
      return { id, status: passed ? 'pass' : 'fail', reason: passed ? reasonPass : reasonFail, coverage, subchecks }
    }
    capture.observations = {
      acp: acp.observation,
      browser: {
        bodyBytes: Buffer.byteLength(body), bodySha256: sha256(body), consoleErrors: browser.consoleErrors,
        pageErrors: browser.pageErrors, apiRequests: browser.apiRequests,
      },
      consumerPrivacyRows: consumerRows, governedAdapterEntries,
      identityRequests, isolation, modelRequests, network, privacy: { ...privacy, finalEntries: undefined },
      session: { beforeRestart, afterRestart, id: browser.durable.sessionId },
    }
    capture.checks = checks
    capture.counted_results = [
      result('real/Cordis-shutdown', [
        'privacy-seven-resolved-disabled-no-fiber', 'privacy-safe-update-remove-reinstall',
        'privacy-late-reenable-rejected', 'privacy-renamed-absent-uncomposed-inventory',
        'privacy-shutdown-no-fiber', 'consumer-profile-privacy-consumer',
        'governed-desktop-h1-adapter-capability',
      ], 'all three privacy consumers and lifecycle cases passed',
      'actual Web lifecycle ran, but late rejection or the three-consumer composition contract was not met',
      'actual-developer-and-consumer-shared-web-compositions-plus-governed-adapter-capability-check'),
      result('real/developer-Host-control', [
        'official-ui-created-and-rendered-session', 'official-ui-cancel-reached-host',
        'official-ui-reconnected-after-host-restart', 'browser-page-errors-empty',
      ], 'official UI created, cancelled, and reopened a Session across Host restart',
      'one or more official UI to shared Host create/cancel/restart behaviors failed', 'actual-official-web-ui-shared-host'),
      result('real/durable-UI-mapping', [
        'durable-session-controller-restart', 'official-ui-created-and-rendered-session',
        'official-ui-reconnected-after-host-restart', 'durable-external-acp-identity-join',
      ], 'the UI and external ACP adapter joined the same durable Session identity',
      'the actual ACP-created durable Session did not remain joined through SessionController and official UI',
      'actual-acp-child-session-controller-official-web-ui'),
    ]
    capture.status = checks.every(value => !value.required || value.result === 'pass') ? 'pass' : 'fail'
  } finally {
    await browser?.context?.close().catch(() => {})
    await runtime?.shutdown().catch(() => {})
    await restarted?.shutdown().catch(() => {})
    await consumer?.shutdown().catch(() => {})
    await Promise.allSettled([identityStub.close(), modelStub.close()])
    for (const timer of pendingTimers) clearTimeout(timer)
  }
}

async function main() {
  const options = argumentsOf(process.argv.slice(2))
  const capture = { checks: [], counted_results: [], schemaVersion: 1, status: 'fail' }
  try {
    await execute(options, capture)
  } catch (error) {
    capture.error = safeError(error)
  } finally {
    failureResults(capture)
    await writeFile(options.output, `${JSON.stringify(redactCapture(capture), null, 2)}\n`)
  }
  return capture.status === 'pass' ? 0 : 1
}

process.exitCode = await main()
