import { createHash } from 'node:crypto'
import { readFileSync, readSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'

import { createLoopbackIdentityGateway } from '../identity/loopback-gateway.mjs'
import { launchLumxRuntime } from '../runtime/launch.mjs'
import {
  ACP_PROMPT, ACP_RESPONSE, createBrowserState, openSessionById, runAcpDurablePrompt,
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

async function openingSnapshot(ctx, sessionId, prompt = ACP_PROMPT, response = ACP_RESPONSE) {
  const abort = new AbortController()
  const iterator = ctx.sessionController.follow({ address: { kind: 'session', sessionId } }, abort.signal)[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    if (first.done || first.value.type !== 'snapshot') throw new Error('session follow returned no opening snapshot')
    const value = first.value
    const records = JSON.stringify(value.records)
    return {
      cursor: value.cursor, header: value.header, recordCount: value.records.length,
      recordsSha256: sha256(records), responsePresent: response === undefined || records.includes(response),
      promptPresent: records.includes(prompt),
    }
  } finally {
    abort.abort()
    await iterator.return?.()
  }
}

async function snapshotOrError(ctx, sessionId, prompt, response) {
  if (typeof sessionId !== 'string') return { error: { message: 'session identity was not observed' } }
  try {
    return await openingSnapshot(ctx, sessionId, prompt, response)
  } catch (error) {
    return { error: safeError(error) }
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
  const modelTransactions = []
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
    modelTransactions.push({
      ordinal: modelRequests, promptKind: prompt === CANCEL_PROMPT ? 'control' : prompt === ACP_PROMPT ? 'acp' : 'other',
      promptSha256: sha256(prompt),
    })
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
    const durableBefore = await snapshotOrError(runtime.ctx, browser.durable.sessionId, ACP_PROMPT, ACP_RESPONSE)
    const controlBefore = await snapshotOrError(runtime.ctx, browser.control.sessionId, CANCEL_PROMPT, undefined)
    await runtime.shutdown()
    runtime = undefined
    const afterShutdown = privacy.finalEntries.map(({ entry, id }) => ({
      id, fiberPresent: entry.fiber !== undefined, fiberState: entry.fiber?.state,
    }))
    restarted = await launchLumxRuntime({
      mode: 'developer', osHome: options.osHome, workspaceDirectory: options.workspace,
      sourceRoot: options.sourceRoot, port: options.hostPort, auth, environment: {},
    })
    const durableAfter = await snapshotOrError(restarted.ctx, browser.durable.sessionId, ACP_PROMPT, ACP_RESPONSE)
    const controlAfter = await snapshotOrError(restarted.ctx, browser.control.sessionId, CANCEL_PROMPT, undefined)
    const restartedList = await restarted.ctx.sessionController.list({}, AbortSignal.timeout(10_000))
    const durableRestartSummary = restartedList.items.find(item => item.sessionId === browser.durable.sessionId)
    const controlRestartSummary = restartedList.items.find(item => item.sessionId === browser.control.sessionId)
    await browser.page.goto(restarted.readyUrl, { waitUntil: 'load', timeout: 30_000 })
    await browser.page.locator('[data-slot="root"]').waitFor({ state: 'attached', timeout: 20_000 })
    const controlRestart = typeof browser.control.sessionId === 'string'
      ? await openSessionById(browser.page, browser.control.sessionId, CANCEL_PROMPT)
      : { error: { message: 'control session identity was not observed' }, rendered: false, selected: false }
    if (controlRestart.rendered) {
      try {
        await browser.page.getByText('Stopped', { exact: true }).first()
          .waitFor({ state: 'visible', timeout: 10_000 })
        controlRestart.visibleStopped = true
      } catch (error) {
        controlRestart.error = safeError(error)
        controlRestart.visibleStopped = false
      }
    }
    await browser.page.screenshot({
      path: join(dirname(options.output), 'live-cordis-ui-restart-control.png'), fullPage: true,
    })
    const durableRestart = await openSessionById(browser.page, browser.durable.sessionId, ACP_RESPONSE)
    await browser.page.screenshot({
      path: join(dirname(options.output), 'live-cordis-ui-restart-acp.png'), fullPage: true,
    })
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
    const durablePass = durableBefore.error === undefined && durableAfter.error === undefined
      && durableBefore.cursor === durableAfter.cursor
      && durableBefore.recordsSha256 === durableAfter.recordsSha256
      && durableBefore.promptPresent && durableBefore.responsePresent
      && durableAfter.promptPresent && durableAfter.responsePresent
    const controlCreatedPass = browser.control.completed === true
      && controlBefore.error === undefined && controlBefore.promptPresent === true
      && browser.control.summary?.sessionId === browser.control.sessionId
      && browser.apiRequests.includes('/api/session/create')
      && browser.apiRequests.includes('/api/session/prompt')
    const controlTransaction = modelTransactions.find(transaction => transaction.promptKind === 'control')
    const uiCancelPass = browser.apiRequests.includes('/api/session/cancel')
      && cancelledModelConnections >= 1 && browser.control.visibleStopped === true
      && controlTransaction?.promptSha256 === sha256(CANCEL_PROMPT)
    const controlRestartPass = controlBefore.error === undefined && controlAfter.error === undefined
      && controlBefore.cursor === controlAfter.cursor
      && controlBefore.recordsSha256 === controlAfter.recordsSha256
      && controlAfter.promptPresent === true && controlRestart.rendered === true
      && controlRestart.selected === true && controlRestart.visibleStopped === true
      && controlRestartSummary?.sessionId === browser.control.sessionId
      && browser.control.summary?.running === false
      && controlRestartSummary?.running === false
    const lateReenableRejected = privacy.lateEnable.executed === true && privacy.lateEnable.rejected === true
      && privacy.lateEnable.restoredDisabled === true
      && (privacy.lateEnable.restoredFiberPresent === false || privacy.lateEnable.restoredFiberState === 4)
    const consumerPass = consumerRows.every(row => row.resolved && row.disabled === true
      && (row.fiberPresent === false || row.fiberState === 4))
    const acpJoinPass = acp.observation.phase === 'prompt-complete'
      && browser.durable.sessionId === acp.sessionId
      && durableBefore.responsePresent && durableAfter.responsePresent
      && durableRestartSummary?.sessionId === acp.sessionId
      && durableRestart.rendered === true && durableRestart.selected === true
    const checks = [
      check('physical-network-denied', network.denied === true, network),
      check('main-profile-path-denied', isolation.pathDenied === true, isolation),
      check('inherited-fd-read-denied', isolation.fdDenied === true, isolation),
      check('privacy-seven-resolved-disabled-no-fiber', disabledPass, { presentIds, missingIds, initial: privacy.initial, final: privacy.final }),
      check('privacy-safe-update-remove-reinstall', lifecyclePass, privacy.actions),
      check('privacy-late-reenable-rejected', lateReenableRejected, privacy.lateEnable),
      check('privacy-renamed-absent-uncomposed-inventory', missingIds.length === 0, { missingIds, scopedCandidates: privacy.scopedCandidates }),
      check('privacy-shutdown-no-fiber', shutdownPass, afterShutdown),
      check('durable-session-controller-restart', durablePass, { beforeRestart: durableBefore, afterRestart: durableAfter }),
      check('durable-initial-ui-diagnostic', browser.durableInitial.rendered === true
        && browser.durableInitial.selected === true, {
        initialRender: browser.initialRender, openById: browser.durableInitial,
      }, false),
      check('official-ui-control-session-created', controlCreatedPass, {
        control: browser.control, beforeRestart: controlBefore,
      }),
      check('official-ui-cancel-reached-host', uiCancelPass, {
        cancelRequests: browser.apiRequests.filter(path => path === '/api/session/cancel').length,
        cancelledModelConnections, controlTransaction,
      }),
      check('official-ui-control-session-restarted', controlRestartPass, {
        afterRestart: controlAfter, beforeRestart: controlBefore, controlRestart,
        restartedSummary: controlRestartSummary,
      }),
      check('durable-restart-official-ui-same-id', durableRestart.rendered === true
        && durableRestart.selected === true
        && durableRestartSummary?.sessionId === browser.durable.sessionId, {
        controllerSessionId: browser.durable.sessionId, durableRestart, restartedSummary: durableRestartSummary,
      }),
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
        beforeRestart: durableBefore, afterRestart: durableAfter, durableRestart,
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
        pageErrors: browser.pageErrors, apiRequests: browser.apiRequests, control: browser.control,
        controlRestart, durableInitial: browser.durableInitial, durableRestart, durableSummary: browser.durable,
      },
      consumerPrivacyRows: consumerRows, governedAdapterEntries,
      identityRequests, isolation, modelRequests, modelTransactions, network,
      privacy: { ...privacy, finalEntries: undefined },
      session: {
        control: { beforeRestart: controlBefore, afterRestart: controlAfter, id: browser.control.sessionId },
        durable: { beforeRestart: durableBefore, afterRestart: durableAfter, id: browser.durable.sessionId },
      },
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
        'official-ui-control-session-created', 'official-ui-cancel-reached-host',
        'official-ui-control-session-restarted', 'browser-page-errors-empty',
      ], 'official UI created, cancelled, and reopened a Session across Host restart',
      'one or more official UI to shared Host create/cancel/restart behaviors failed', 'actual-official-web-ui-shared-host'),
      result('real/durable-UI-mapping', [
        'durable-session-controller-restart', 'durable-initial-ui-diagnostic',
        'durable-restart-official-ui-same-id', 'durable-external-acp-identity-join',
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
