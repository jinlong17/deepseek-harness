import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ClientSideConnection, PROTOCOL_VERSION } from '../../apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'
import { Context } from '../../vendor/cordis/lib/index.js'
import JsonlSessionPersistence from '../../packages/session/session-persistence-jsonl/lib/index.js'
import { authenticate, follow, timeout } from './b5-hook-common.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
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
  if (value.protocolVersion !== PROTOCOL_VERSION || value.agentCapabilities?.loadSession !== true) throw new Error('official ACP capability mismatch')
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
  try {
    const page = context.pages()[0] ?? await context.newPage(); const pageErrors = []; const apiRequests = []
    page.on('pageerror', error => pageErrors.push(String(error))); page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname) })
    await page.goto(host.readyUrl, { waitUntil: 'load', timeout: 30_000 }); await page.locator('[data-slot="root"]').waitFor({ timeout: 20_000 })
    const cont = page.getByRole('button', { name: 'Continue', exact: true }); if (await cont.isVisible().catch(() => false)) await cont.click()
    await workspace(page, config.workspaceDirectory)
    const durableInitial = await openById(page, durable.sessionId, 'FIRST_FINAL')
    await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first(); await input.waitFor({ timeout: 20_000 }); await input.fill('B5 CANCEL UI'); await input.press('Enter')
    const stop = page.getByRole('button', { name: 'Stop generating' }); await stop.waitFor({ timeout: 10_000 }); await timeout(barriers.cancelStarted.promise, 'UI cancel provider'); await stop.click()
    await stop.waitFor({ state: 'detached', timeout: 15_000 }); const selected = page.getByRole('tree', { name: 'Sessions', exact: true }).locator('[role="treeitem"][aria-selected="true"][data-row-key^="session:"]').first()
    const sessionId = (await selected.getAttribute('data-row-key'))?.slice('session:'.length)
    return { apiRequests, pageErrors, durableInitial, sessionId, created: typeof sessionId === 'string', cancelled: apiRequests.includes('/api/session/cancel') }
  } finally { await context.close() }
}
export async function browserResume(config, host, continuity) {
  const engine = await chromium(config.sourceRoot); const context = await engine.launchPersistentContext(config.browserUserData, { executablePath: config.browserPath, headless: true,
    env: { ...process.env, MAC_CHROMIUM_TMPDIR: config.browserTemporary, TMPDIR: config.browserTemporary }, args: ['--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--password-store=basic','--use-mock-keychain'] })
  try {
    const page = context.pages()[0] ?? await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(String(error)))
    await page.goto(host.readyUrl, { waitUntil: 'load', timeout: 30_000 }); await page.locator('[data-slot="root"]').waitFor({ timeout: 20_000 })
    const cont = page.getByRole('button', { name: 'Continue', exact: true }); if (await cont.isVisible().catch(() => false)) await cont.click()
    await workspace(page, config.workspaceDirectory)
    return { durable: await openById(page, continuity.sessionId, 'B5_OK_1'), control: await openById(page, continuity.controlSessionId, 'Stopped'), errors }
  } finally { await context.close() }
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
