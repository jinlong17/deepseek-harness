import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, readSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createLoopbackIdentityGateway } from '../identity/loopback-gateway.mjs'
import { launchLumxRuntime } from '../runtime/launch.mjs'

const PRIVACY_IDS = Object.freeze([
  'session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
  'deepseek-account', 'llm-deepseek-account', 'desktop-product-telemetry', 'product-analytics',
])
const PROMPT = 'durable UI probe prompt'
const RESPONSE = `LUMX synthetic response: ${PROMPT}`
const CANCEL_PROMPT = 'browser control cancel probe'

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
  return { actions, final, finalEntries, initial, scopedCandidates }
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
      responsePresent: JSON.stringify(value.records).includes(RESPONSE),
      promptPresent: JSON.stringify(value.records).includes(PROMPT),
    }
  } finally {
    abort.abort()
    await iterator.return?.()
  }
}

async function playwrightFrom(sourceRoot) {
  const require = createRequire(join(sourceRoot, 'apps/web/package.json'))
  const module = await import(pathToFileURL(require.resolve('playwright')).href)
  return module.chromium ?? module.default?.chromium
}

async function connectWorkspace(page, workspace) {
  const picker = page.getByRole('textbox', { name: 'Choose workspace' })
  if (await picker.count() === 0) return { needed: false }
  await picker.click()
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
  await pathInput.fill(workspace)
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  return { needed: true }
}

async function locateDurableSession(page) {
  if (await page.getByText(RESPONSE, { exact: true }).count() > 0) return true
  const rows = page.locator('[role="treeitem"]')
  const count = await rows.count()
  for (let index = 0; index < count; index += 1) {
    try {
      await rows.nth(index).click({ timeout: 2_000 })
      await page.waitForTimeout(150)
      if (await page.getByText(RESPONSE, { exact: true }).count() > 0) return true
    } catch {}
  }
  return false
}

async function createBrowserState(options, runtime) {
  const chromium = await playwrightFrom(options.sourceRoot)
  if (chromium === undefined) throw new Error('pinned Playwright Chromium export is unavailable')
  const userDataDir = join(dirname(options.output), 'chrome-profile')
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: options.browser, headless: true, locale: 'en-US',
    args: [
      '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-component-update',
      '--disable-default-apps', '--disable-sync', '--metrics-recording-only', '--no-first-run',
      '--disable-breakpad', '--disable-crash-reporter', '--disable-crashpad',
    ],
  })
  const page = context.pages()[0] ?? await context.newPage()
  const pageErrors = []
  const consoleErrors = []
  const apiRequests = []
  page.on('pageerror', error => { pageErrors.push(String(error)) })
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname)
  })
  await page.goto(runtime.readyUrl, { waitUntil: 'load', timeout: 30_000 })
  await page.locator('[data-slot="root"]').waitFor({ state: 'attached', timeout: 20_000 })
  const workspace = await connectWorkspace(page, options.workspace)
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await input.waitFor({ timeout: 20_000 })
  await input.fill(PROMPT)
  await input.press('Enter')
  await page.getByText(RESPONSE, { exact: true }).waitFor({ timeout: 20_000 })
  const listed = await runtime.ctx.sessionController.list({}, AbortSignal.timeout(10_000))
  const durable = listed.items.find(item => !item.blank && item.cwd === options.workspace)
    ?? listed.items.find(item => !item.blank)
  if (durable === undefined) throw new Error('rendered prompt produced no nonblank Session Controller row')
  await input.fill(CANCEL_PROMPT)
  await input.press('Enter')
  const stop = page.getByRole('button', { name: 'Stop generating' })
  await stop.waitFor({ timeout: 10_000 })
  await stop.click()
  await stop.waitFor({ state: 'detached', timeout: 15_000 })
  return {
    apiRequests, consoleErrors, context, durable, page, pageErrors, workspace,
    initialRender: { prompt: await page.getByText(PROMPT, { exact: true }).count(), response: await page.getByText(RESPONSE, { exact: true }).count() },
  }
}

function check(id, pass, evidence, required = true) {
  return { id, result: pass ? 'pass' : 'fail', required, evidence }
}

async function execute(options, capture) {
  let identityRequests = 0
  let modelRequests = 0
  let cancelledModelConnections = 0
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
    const prompt = body.messages.at(-1)?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    if (prompt.includes(CANCEL_PROMPT)) {
      await new Promise(resolvePending => {
        let settled = false
        const finish = closed => {
          if (settled) return
          settled = true
          if (closed) cancelledModelConnections += 1
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
  let browser
  try {
    runtime = await launchLumxRuntime({
      mode: 'developer', osHome: options.osHome, workspaceDirectory: options.workspace,
      sourceRoot: options.sourceRoot, port: options.hostPort, auth, environment: {},
    })
    const privacy = await exercisePrivacyLifecycle(runtime)
    capture.observations.privacy = { ...privacy, finalEntries: undefined }
    browser = await createBrowserState(options, runtime)
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
    const renderedAfterRestart = await locateDurableSession(browser.page)
    const screenshotPath = join(dirname(options.output), 'live-cordis-ui.png')
    await browser.page.screenshot({ path: screenshotPath, fullPage: true })
    const body = await browser.page.locator('body').innerText()
    const initialRows = rowMap(privacy.initial)
    const finalRows = rowMap(privacy.final)
    const presentIds = PRIVACY_IDS.filter(id => initialRows.get(id)?.resolved)
    const missingIds = PRIVACY_IDS.filter(id => !initialRows.get(id)?.resolved)
    const lifecyclePass = privacy.actions.every(action => action.executed && action.updateDisabled === true
      && action.updateFiberPresent === false && action.absentAfterRemove === true
      && action.reinstallDisabled === true && action.reinstallFiberPresent === false)
    const disabledPass = PRIVACY_IDS.every(id => initialRows.get(id)?.resolved === true
      && initialRows.get(id)?.disabled === true && initialRows.get(id)?.fiberPresent === false
      && finalRows.get(id)?.disabled === true && finalRows.get(id)?.fiberPresent === false)
    const shutdownPass = afterShutdown.length === PRIVACY_IDS.length
      && afterShutdown.every(row => row.fiberPresent === false)
    const durablePass = beforeRestart.cursor === afterRestart.cursor
      && beforeRestart.recordsSha256 === afterRestart.recordsSha256
      && beforeRestart.promptPresent && beforeRestart.responsePresent
      && afterRestart.promptPresent && afterRestart.responsePresent
    const uiCancelPass = browser.apiRequests.includes('/api/session/cancel') && cancelledModelConnections >= 1
    const uiRenderPass = browser.initialRender.prompt > 0 && browser.initialRender.response > 0 && renderedAfterRestart
    const checks = [
      check('physical-network-denied', network.denied === true, network),
      check('main-profile-path-denied', isolation.pathDenied === true, isolation),
      check('inherited-fd-read-denied', isolation.fdDenied === true, isolation),
      check('privacy-seven-resolved-disabled-no-fiber', disabledPass, { presentIds, missingIds, initial: privacy.initial, final: privacy.final }),
      check('privacy-safe-update-remove-reinstall', lifecyclePass, privacy.actions),
      check('privacy-late-reenable-rejected', false, { executed: false, reason: 'forbidden rows were never re-enabled; no product guard rejects an attempted re-enable' }),
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
      check('desktop-platform-privacy-consumer', false, { executed: false, reason: 'this runtime is the official shared Web Host, not the Electron DesktopHost wrapper' }),
      check('governed-h1-privacy-consumer', false, { executed: false, reason: 'Batch C owns the governed H1 composition result' }),
      check('durable-external-acp-identity-join', false, { executed: false, reason: 'no external ACP durable identity adapter is composed in this profile' }),
    ]
    const byId = new Map(checks.map(value => [value.id, value]))
    const result = (id, subcheckIds, reasonPass, reasonFail, coverage) => {
      const subchecks = subcheckIds.map(key => byId.get(key))
      const passed = subchecks.every(value => value?.required !== true || value.result === 'pass')
      return { id, status: passed ? 'pass' : 'fail', reason: passed ? reasonPass : reasonFail, coverage, subchecks }
    }
    capture.observations = {
      browser: {
        bodyBytes: Buffer.byteLength(body), bodySha256: sha256(body), consoleErrors: browser.consoleErrors,
        pageErrors: browser.pageErrors, apiRequests: browser.apiRequests,
      },
      identityRequests, isolation, modelRequests, network, privacy: { ...privacy, finalEntries: undefined },
      session: { beforeRestart, afterRestart, id: browser.durable.sessionId },
    }
    capture.checks = checks
    capture.counted_results = [
      result('real/Cordis-shutdown', [
        'privacy-seven-resolved-disabled-no-fiber', 'privacy-safe-update-remove-reinstall',
        'privacy-late-reenable-rejected', 'privacy-renamed-absent-uncomposed-inventory',
        'privacy-shutdown-no-fiber', 'desktop-platform-privacy-consumer', 'governed-h1-privacy-consumer',
      ], 'all three privacy consumers and lifecycle cases passed',
      'actual shared Web lifecycle ran, but the complete seven rows/late rejection/three-consumer contract was not met',
      'actual-developer-byok-shared-web-host-plus-explicit-cross-consumer-gaps'),
      result('real/developer-Host-control', [
        'official-ui-created-and-rendered-session', 'official-ui-cancel-reached-host',
        'official-ui-reconnected-after-host-restart', 'browser-page-errors-empty',
      ], 'official UI created, cancelled, and reopened a Session across Host restart',
      'one or more official UI to shared Host create/cancel/restart behaviors failed', 'actual-official-web-ui-shared-host'),
      result('real/durable-UI-mapping', [
        'durable-session-controller-restart', 'official-ui-created-and-rendered-session',
        'official-ui-reconnected-after-host-restart', 'durable-external-acp-identity-join',
      ], 'the UI and external ACP adapter joined the same durable Session identity',
      'DSH UI durability was exercised, but an external ACP durable identity join is absent', 'actual-dsh-session-ui-plus-explicit-acp-gap'),
    ]
    capture.status = checks.every(value => !value.required || value.result === 'pass') ? 'pass' : 'fail'
  } finally {
    for (const timer of pendingTimers) clearTimeout(timer)
    await browser?.context.close().catch(() => {})
    await runtime?.shutdown().catch(() => {})
    await restarted?.shutdown().catch(() => {})
    await Promise.allSettled([identityStub.close(), modelStub.close()])
  }
}

async function main() {
  const options = argumentsOf(process.argv.slice(2))
  const capture = { checks: [], counted_results: [], schemaVersion: 1, status: 'fail' }
  try {
    await execute(options, capture)
  } catch (error) {
    capture.error = { code: error?.code, message: String(error?.message ?? error), name: error?.name ?? 'Error' }
  } finally {
    await writeFile(options.output, `${JSON.stringify(capture, null, 2)}\n`)
  }
  return capture.status === 'pass' ? 0 : 1
}

process.exitCode = await main()
