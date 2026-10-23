import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ClientSideConnection, PROTOCOL_VERSION } from '../../apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'
import { Context } from '../../vendor/cordis/lib/index.js'
import JsonlSessionPersistence from '../../packages/session/session-persistence-jsonl/lib/index.js'
import { authenticate, follow, timeout } from './b5-hook-common.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const ROOT_SELECTOR = '[data-slot="root"]'
const ERROR_SELECTOR = '[data-slot-error="root"]'
const UI_RECORD_LIMIT = 8192
function boundedDigest(value, limit) {
  if (typeof value !== 'string') return { sha256: null, truncated: false }
  const prefix = Buffer.from(value.slice(0, limit + 1)).subarray(0, limit)
  return { sha256: sha(prefix), truncated: Buffer.byteLength(value) > limit }
}
function diagnosticFd() {
  let selected
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--diagnostic-fd') selected = process.argv[index + 1]
  }
  if (selected === undefined) return 2
  if (selected !== '22') throw new Error('adversarial diagnostic FD is invalid')
  return 22
}
function ownString(value, key) {
  if (value === null || typeof value !== 'object') return undefined
  const entry = Object.getOwnPropertyDescriptor(value, key)
  return entry && Object.hasOwn(entry, 'value') && typeof entry.value === 'string' ? entry.value : undefined
}
function safeError(error) {
  const name = ownString(error, 'name')
  const safeName = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'TimeoutError'].includes(name) ? name : 'OtherError'
  const message = ownString(error, 'message')
  const classification = safeName === 'SyntaxError' ? 'syntax' : safeName === 'ReferenceError' ? 'reference'
    : safeName === 'TypeError' ? 'type' : message && /module|import/iu.test(message.slice(0, 4096)) ? 'module-load' : 'other'
  const digest = boundedDigest(message, 4096)
  return { name: safeName, classification, message_sha256: digest.sha256, message_truncated: digest.truncated }
}
function safePath(url, origin) {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== origin) return { category: 'cross-origin' }
    const pathname = parsed.pathname
    if (pathname === '/') return { category: 'static', pathname: '/' }
    if (/^\/assets\/[A-Za-z0-9._-]{1,230}\.(?:js|css)$/u.test(pathname)) return { category: 'static', extension: pathname.endsWith('.js') ? 'js' : 'css', pathname_sha256: sha(pathname) }
    const digest = boundedDigest(pathname, 256)
    return { category: 'redacted', pathname_sha256: digest.sha256, path_truncated: digest.truncated }
  } catch { return { category: 'unavailable' } }
}
function safeResource(value) { return ['document', 'script', 'stylesheet'].includes(value) ? value : 'other' }
function failureClass(value) {
  if (typeof value !== 'string') return 'unknown'
  if (/abort/iu.test(value)) return 'aborted'
  if (/cert|ssl|tls/iu.test(value)) return 'tls'
  if (/connection|refused|reset|timed.?out/iu.test(value)) return 'connection'
  if (/block/iu.test(value)) return 'blocked'
  return 'other'
}
function browserObserver(page, readyUrl) {
  const origin = new URL(readyUrl).origin
  const state = { navigation: [], assets: [], page_errors: [], request_failures: [], dropped: { navigation: 0, assets: 0, page_errors: 0, request_failures: 0, cross_origin: 0 }, observation_failed: false }
  const append = (array, limit, value, counter) => { if (array.length < limit) array.push(value); else state.dropped[counter] = Math.min(state.dropped[counter] + 1, 65535) }
  const response = value => {
    try {
      const request = value.request(); const resource = safeResource(request.resourceType()); const path = safePath(value.url(), origin)
      if (path.category === 'cross-origin') { state.dropped.cross_origin = Math.min(state.dropped.cross_origin + 1, 65535); return }
      if (resource === 'document') append(state.navigation, 4, { ...path, status: Number.isInteger(value.status()) ? value.status() : null }, 'navigation')
      if (path.category === 'static' && ['script', 'stylesheet'].includes(resource)) append(state.assets, 16, { ...path, resource, status: Number.isInteger(value.status()) ? value.status() : null }, 'assets')
    } catch { state.observation_failed = true }
  }
  const pageerror = value => { try { append(state.page_errors, 8, safeError(value), 'page_errors') } catch { state.observation_failed = true } }
  const requestfailed = value => {
    try {
      const resource = safeResource(value.resourceType()); const path = safePath(value.url(), origin)
      if (path.category !== 'static' || !['document', 'script', 'stylesheet'].includes(resource)) return
      const failure = value.failure(); const detail = ownString(failure, 'errorText')
      const digest = boundedDigest(detail, 4096)
      append(state.request_failures, 16, { ...path, resource, failure: failureClass(detail?.slice(0, 4096)), detail_sha256: digest.sha256, detail_truncated: digest.truncated }, 'request_failures')
    } catch { state.observation_failed = true }
  }
  const listeners = [['response', response], ['pageerror', pageerror], ['requestfailed', requestfailed]]
  try { for (const [event, handler] of listeners) page.on(event, handler) }
  catch (error) { for (const [event, handler] of listeners) { try { page.off(event, handler) } catch {} } throw error }
  return { state, detach: () => { page.off('response', response); page.off('pageerror', pageerror); page.off('requestfailed', requestfailed) } }
}
async function uiSnapshot(page, readyUrl) {
  const snapshot = { ready_state: 'unknown', path: { category: 'unavailable' }, root_attached_count: null,
    roots_truncated: false, root_visible: null, root_error_marker: null }
  const origin = new URL(readyUrl).origin
  let timer
  const work = (async () => {
    const dom = await page.evaluate(({ root, error }) => ({ readyState: document.readyState, pathname: location.href,
      roots: document.querySelectorAll(root).length, rootError: document.querySelector(error) !== null }), { root: ROOT_SELECTOR, error: ERROR_SELECTOR })
    snapshot.ready_state = ['loading', 'interactive', 'complete'].includes(dom?.readyState) ? dom.readyState : 'unknown'
    snapshot.path = safePath(dom?.pathname, origin)
    if (Number.isSafeInteger(dom?.roots) && dom.roots >= 0) {
      snapshot.root_attached_count = Math.min(dom.roots, 16); snapshot.roots_truncated = dom.roots > 16
      if (dom.roots > 0) {
        const roots = page.locator(ROOT_SELECTOR); let visible = false
        for (let index = 0; index < Math.min(dom.roots, 16); index += 1) visible ||= await roots.nth(index).isVisible()
        snapshot.root_visible = visible
      } else snapshot.root_visible = false
    }
    if (typeof dom?.rootError === 'boolean') snapshot.root_error_marker = dom.rootError
    return snapshot
  })()
  try { return await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve({ ...snapshot, observation_timeout: true }), 1000) })]) }
  finally { clearTimeout(timer); void work.catch(() => {}) }
}
export async function waitForB5UiRoot(page, readyUrl, phase, writer = (fd, line) => writeSync(fd, line)) {
  const observer = browserObserver(page, readyUrl)
  let navigation
  try {
    navigation = await page.goto(readyUrl, { waitUntil: 'load', timeout: 30_000 })
    await page.locator(ROOT_SELECTOR).waitFor({ timeout: 20_000 })
  } catch (primary) {
    let snapshot
    try { snapshot = await uiSnapshot(page, readyUrl) } catch { snapshot = { unavailable: true } }
    try {
      const record = { schema: 'g9-b5-ui-failure/v1', phase, navigation_status: navigation && Number.isInteger(navigation.status()) ? navigation.status() : null,
        ...observer.state, snapshot }
      let line = `B5_UI_FAILURE ${JSON.stringify(record)}\n`
      if (Buffer.byteLength(line) > UI_RECORD_LIMIT) line = `B5_UI_FAILURE ${JSON.stringify({ schema: 'g9-b5-ui-failure/v1', phase, truncated: true,
        navigation_status: record.navigation_status, observation_failed: observer.state.observation_failed,
        retained_counts: { navigation: observer.state.navigation.length, assets: observer.state.assets.length,
          page_errors: observer.state.page_errors.length, request_failures: observer.state.request_failures.length },
        dropped: observer.state.dropped, snapshot })}\n`
      writer(diagnosticFd(), line)
    } catch { /* diagnostics never replace the original browser error */ }
    throw primary
  } finally { observer.detach() }
}
export async function closeBrowserContext(context, failed, primary) {
  try { await context.close() }
  catch (cleanup) { if (failed) throw new AggregateError([primary, cleanup], 'UI scenario plus browser cleanup failed'); throw cleanup }
}
export function front(host, approval) {
  const updates = []; const permissions = []
  const connection = new ClientSideConnection(() => ({
    requestPermission: async params => { permissions.push(params); return approval(params, permissions.length) },
    sessionUpdate: async params => { updates.push(params) },
    readTextFile: async () => { throw new Error('front ACP filesystem read disabled') },
    writeTextFile: async () => { throw new Error('front ACP filesystem write disabled') },
  }), host.acp)
  return Object.freeze({ connection, permissions, updates })
}
export async function initialize(client) {
  const value = await client.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const sessions = value.agentCapabilities?.sessionCapabilities
  const supports = name => Object.hasOwn(sessions ?? {}, name) && sessions[name] !== null && typeof sessions[name] === 'object' && !Array.isArray(sessions[name])
  if (value.protocolVersion !== PROTOCOL_VERSION || !['resume', 'list', 'close'].every(supports)) throw new Error('official Host ACP session capabilities mismatch')
  return value
}
export async function readEvents(root, sessionId) {
  const ctx = new Context(); await ctx.plugin(JsonlSessionPersistence, { root })
  try { const handle = await ctx.sessionPersistence.open(sessionId, 'read'); try { return (await handle.read()).events } finally { await handle.close() } }
  finally { await ctx.fiber.dispose() }
}
export function binding(events) {
  const rows = events.filter(value => value.type === 'agent/external-engine-bound')
  if (rows.length !== 1) throw new Error(`expected one external binding, found ${rows.length}`)
  return rows[0].data
}
export function history(events) { return Object.freeze({ contiguous: events.every((value, index) => value.seq === index), count: events.length, sha256: sha(JSON.stringify(events)) }) }
async function chromium(sourceRoot) {
  const require = createRequire(join(sourceRoot, 'apps/web/package.json'))
  const module = await import(pathToFileURL(require.resolve('playwright')).href); return module.chromium ?? module.default?.chromium
}
async function workspace(page, cwd) {
  const picker = page.getByRole('textbox', { name: 'Choose workspace' }); if (await picker.count() === 0) return
  await picker.click(); const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' }); await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Edit path' }).click(); const input = dialog.getByRole('textbox', { name: 'Edit path' }); await input.fill(cwd); await input.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
}
export async function openById(page, sessionId, expected) {
  const tree = page.getByRole('tree', { name: 'Sessions', exact: true }); await tree.waitFor({ state: 'visible', timeout: 15_000 })
  const group = tree.locator('[role="treeitem"][aria-expanded]').filter({ hasText: 'workspace' }).first(); await group.waitFor({ state: 'visible', timeout: 15_000 })
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  const row = tree.locator(`[data-row-key=${JSON.stringify(`session:${sessionId}`)}]`); await row.waitFor({ state: 'visible', timeout: 15_000 }); await row.click()
  await page.getByText(expected, { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 })
  return { rendered: true, selected: await row.getAttribute('aria-selected') === 'true' }
}
export async function browserCreateCancel(config, host, barriers, durable) {
  const engine = await chromium(config.sourceRoot); if (engine === undefined) throw new Error('pinned Chromium API unavailable')
  const context = await engine.launchPersistentContext(config.browserUserData, { executablePath: config.browserPath, headless: true,
    env: { ...process.env, MAC_CHROMIUM_TMPDIR: config.browserTemporary, TMPDIR: config.browserTemporary }, args: ['--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--password-store=basic','--use-mock-keychain'] })
  let failed = false; let primary
  try {
    const page = context.pages()[0] ?? await context.newPage(); const pageErrors = []; const apiRequests = []
    page.on('pageerror', error => pageErrors.push(safeError(error))); page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname) })
    await waitForB5UiRoot(page, host.readyUrl, 'create')
    const cont = page.getByRole('button', { name: 'Continue', exact: true }); if (await cont.isVisible().catch(() => false)) await cont.click()
    await workspace(page, config.workspaceDirectory)
    const durableInitial = await openById(page, durable.sessionId, 'FIRST_FINAL')
    await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first(); await input.waitFor({ timeout: 20_000 }); await input.fill('B5 CANCEL UI'); await input.press('Enter')
    const stop = page.getByRole('button', { name: 'Stop generating' }); await stop.waitFor({ timeout: 10_000 }); await timeout(barriers.cancelStarted.promise, 'UI cancel provider'); await stop.click()
    await stop.waitFor({ state: 'detached', timeout: 15_000 }); const selected = page.getByRole('tree', { name: 'Sessions', exact: true }).locator('[role="treeitem"][aria-selected="true"][data-row-key^="session:"]').first()
    const sessionId = (await selected.getAttribute('data-row-key'))?.slice('session:'.length)
    return { apiRequests, pageErrors, durableInitial, sessionId, created: typeof sessionId === 'string', cancelled: apiRequests.includes('/api/session/cancel') }
  } catch (error) { failed = true; primary = error; throw error }
  finally { await closeBrowserContext(context, failed, primary) }
}
export async function browserResume(config, host, continuity) {
  const engine = await chromium(config.sourceRoot); const context = await engine.launchPersistentContext(config.browserUserData, { executablePath: config.browserPath, headless: true,
    env: { ...process.env, MAC_CHROMIUM_TMPDIR: config.browserTemporary, TMPDIR: config.browserTemporary }, args: ['--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--password-store=basic','--use-mock-keychain'] })
  let failed = false; let primary
  try {
    const page = context.pages()[0] ?? await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(safeError(error)))
    await waitForB5UiRoot(page, host.readyUrl, 'resume')
    const cont = page.getByRole('button', { name: 'Continue', exact: true }); if (await cont.isVisible().catch(() => false)) await cont.click()
    await workspace(page, config.workspaceDirectory)
    return { durable: await openById(page, continuity.sessionId, 'B5_OK_1'), control: await openById(page, continuity.controlSessionId, 'Stopped'), errors }
  } catch (error) { failed = true; primary = error; throw error }
  finally { await closeBrowserContext(context, failed, primary) }
}
export async function runCreate(config, host, stub, barriers) {
  const auth = await authenticate(host.readyUrl); const client = front(host, async params => { const option = params.options.find(value => value.kind === 'allow_once'); return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } } })
  await initialize(client); const created = await client.connection.newSession({ cwd: config.workspaceDirectory, mcpServers: [] }); const journal = await follow(auth, created.sessionId)
  let settled = false; const streaming = client.connection.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'B5 STREAM' }] }).finally(() => { settled = true })
  await timeout(barriers.streamFirst.promise, 'first provider chunk'); const first = await journal.wait(frame => frame.type === 'item' && frame.value?.type === 'assistant-stream' && frame.value.frame?.type === 'chunk')
  const streamedBeforeFinal = !settled; barriers.streamRelease.resolve(); await streaming; journal.close()
  const cancelled = await client.connection.newSession({ cwd: config.workspaceDirectory, mcpServers: [] }); const pending = client.connection.prompt({ sessionId: cancelled.sessionId, prompt: [{ type: 'text', text: 'B5 CANCEL' }] })
  await timeout(barriers.cancelStarted.promise, 'cancel provider'); await client.connection.cancel({ sessionId: cancelled.sessionId }); const cancelResult = await pending; await timeout(barriers.cancelObserved.promise, 'provider abort')
  const other = await client.connection.newSession({ cwd: config.workspaceDirectory, mcpServers: [] }); const otherResult = await client.connection.prompt({ sessionId: other.sessionId, prompt: [{ type: 'text', text: 'B5 OTHER' }] })
  const tool = await client.connection.newSession({ cwd: config.workspaceDirectory, mcpServers: [] }); const toolResult = await client.connection.prompt({ sessionId: tool.sessionId, prompt: [{ type: 'text', text: 'B5 TOOL' }] })
  const ui = await browserCreateCancel(config, host, barriers, created); return { auth: { page: auth.page }, cancelResult, client, created, first: first.value.frame.type, otherResult, streamedBeforeFinal, tool, toolResult, ui }
}
export async function runPermission(config, host, barriers) {
  const lateEntered = Promise.withResolvers(); const lateRelease = Promise.withResolvers()
  const client = front(host, async (params, ordinal) => { const kind = ordinal === 1 ? 'reject_once' : 'allow_once'; const option = params.options.find(value => value.kind === kind)
    if (ordinal === 2) { lateEntered.resolve(); await lateRelease.promise } return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } } })
  await initialize(client); const rejected = await client.connection.newSession({ cwd: config.workspaceDirectory, mcpServers: [] }); const rejectedResult = await client.connection.prompt({ sessionId: rejected.sessionId, prompt: [{ type: 'text', text: 'B5 REJECT' }] })
  const late = await client.connection.newSession({ cwd: config.workspaceDirectory, mcpServers: [] }); const pending = client.connection.prompt({ sessionId: late.sessionId, prompt: [{ type: 'text', text: 'B5 LATE' }] }); await timeout(lateEntered.promise, 'late permission')
  const cancelled = client.connection.cancel({ sessionId: late.sessionId }); await new Promise(resolveTick => setImmediate(resolveTick)); lateRelease.resolve(); await cancelled; const lateResult = await pending
  return { lateResult, permissionCount: client.permissions.length, rejectedResult }
}
export const effectFacts = (stub, config) => ({ ...stub.effects(), worldCount: existsSync(config.worldEffect) ? readFileSync(config.worldEffect, 'utf8').split('B5_TOOL_OK').length - 1 : 0 })
