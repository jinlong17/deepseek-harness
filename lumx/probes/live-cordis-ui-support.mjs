import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ACP_PROMPT = 'ACP durable join marker 7d2b67ec'
export const ACP_RESPONSE = `LUMX synthetic response: ${ACP_PROMPT}`
const CANCEL_PROMPT = 'browser control cancel probe'
const ACP_ADAPTER = new URL('./acp-loopback-adapter.mjs', import.meta.url)

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeError(error) {
  return {
    code: error?.code,
    message: String(error?.message ?? error).replace(/token=[A-Za-z0-9_-]+/gu, 'token=<redacted>'),
    name: error?.name ?? 'Error',
  }
}

function withDeadline(label, promise, milliseconds = 30_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds) }),
  ]).finally(() => clearTimeout(timer))
}

export async function runAcpDurablePrompt(options) {
  const snapshot = await import(pathToFileURL(join(
    options.sourceRoot, 'packages/test-support/session-snapshot/lib/index.js',
  )).href)
  const protocol = await import(pathToFileURL(join(
    options.sourceRoot, 'node_modules/.pnpm/node_modules/@agentclientprotocol/sdk/dist/acp.js',
  )).href)
  const sharedHome = join(options.osHome, '.lumx-developer')
  const helperHome = join(options.workspace, '.dsh')
  await mkdir(sharedHome, { recursive: true, mode: 0o700 })
  await symlink(sharedHome, helperHome, 'dir')
  const patch = join(dirname(options.output), 'acp-durable.patch.yml')
  await writeFile(patch, [
    '- id: llm-deepseek', '  disabled: true',
    '- id: llm-deepseek-account', '  disabled: true',
    '- id: deepseek-account', '  disabled: true',
    '- id: session-log-deepseek', '  disabled: true',
    '- id: plugin-package-inventory-deepseek', '  disabled: true',
    '- id: session-telemetry-otel', '  disabled: true',
    '- id: acp', '  config:', '    provider: lumx-acp-probe', '    model: lumx-loopback',
    '- id: agent-default-model', '  config:', '    provider: lumx-acp-probe', '    model: lumx-loopback',
    '- insert:', '    - id: lumx-acp-loopback',
    `      name: ${JSON.stringify(pathToFileURL(fileURLToPath(ACP_ADAPTER)).href)}`, '',
  ].join('\n'), { mode: 0o600 })
  const agent = {
    binScript: join(options.sourceRoot, 'apps/cli/src/bin.ts'),
    libBinScript: join(options.sourceRoot, 'apps/cli/lib/bin.js'),
    configPath: patch, profile: 'acp', tsconfigPath: join(options.sourceRoot, 'tsconfig.json'),
  }
  const observation = { phase: 'starting', patchSha256: sha256(readFileSync(patch)) }
  let launched
  try {
    launched = snapshot.launchAcpTestAgent({
      agent, cwd: options.workspace,
      env: {
        DSH_EXAMPLE_MODE: 'lib', DSH_TELEMETRY_DISABLED: '1',
        LUMX_ACP_MODEL_ENDPOINT: `http://127.0.0.1:${String(options.modelPort)}/model`,
        LUMX_PINNED_SOURCE_ROOT: options.sourceRoot,
      },
    })
    await withDeadline('ACP spawn', launched.spawned)
    observation.phase = 'spawned'
    const initialized = await withDeadline('ACP initialize', launched.client.initialize({
      protocolVersion: protocol.PROTOCOL_VERSION, clientCapabilities: {},
    }))
    observation.phase = 'initialized'
    const created = await withDeadline('ACP session/new', launched.client.newSession({
      cwd: options.workspace, mcpServers: [],
    }))
    observation.phase = 'session-created'
    const promptResult = await withDeadline('ACP session/prompt', launched.client.prompt({
      sessionId: created.sessionId, prompt: [{ type: 'text', text: ACP_PROMPT }],
    }), 45_000)
    observation.phase = 'prompt-complete'
    observation.initializeProtocolVersion = initialized.protocolVersion
    observation.promptStopReason = promptResult.stopReason
    observation.sessionId = created.sessionId
    observation.updateCount = launched.updates.length
    observation.updatesSha256 = sha256(JSON.stringify(launched.updates))
    observation.responseInUpdates = JSON.stringify(launched.updates).includes(ACP_RESPONSE)
    return { observation, sessionId: created.sessionId }
  } finally {
    if (launched !== undefined) {
      try { await launched.close() } catch (error) { observation.closeError = safeError(error) }
      observation.exitCode = launched.child.exitCode
      observation.signalCode = launched.child.signalCode
      observation.stdoutBytes = Buffer.byteLength(launched.rawStdout())
      observation.stdoutSha256 = sha256(launched.rawStdout())
      observation.stderrBytes = Buffer.byteLength(launched.stderr())
      observation.stderrSha256 = sha256(launched.stderr())
    }
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

export async function locateDurableSession(page, expected = ACP_RESPONSE) {
  if (await page.getByText(expected, { exact: true }).count() > 0) return true
  const rows = page.locator('[role="treeitem"]')
  for (let index = 0; index < await rows.count(); index += 1) {
    try {
      await rows.nth(index).click({ timeout: 2_000 })
      await page.waitForTimeout(150)
      if (await page.getByText(expected, { exact: true }).count() > 0) return true
    } catch {}
  }
  return false
}

export async function createBrowserState(options, runtime, acp, cancelBarrier) {
  const chromium = await playwrightFrom(options.sourceRoot)
  if (chromium === undefined) throw new Error('pinned Playwright Chromium export is unavailable')
  const userDataDir = join(dirname(options.output), 'chrome-profile')
  const browserTemp = join(dirname(options.output), 'chrome-tmp')
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
  mkdirSync(browserTemp, { recursive: true, mode: 0o700 })
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: options.browser, headless: true, locale: 'en-US',
    env: { ...process.env, MAC_CHROMIUM_TMPDIR: browserTemp, TMPDIR: browserTemp },
    args: [
      '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-component-update',
      '--disable-default-apps', '--disable-sync', '--metrics-recording-only', '--no-first-run',
      '--disable-breakpad', '--disable-crash-reporter', '--disable-crashpad',
      '--password-store=basic', '--use-mock-keychain',
    ],
  })
  try {
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
    const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
    const onboarding = {
      dismissed: false,
      present: await continueButton.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false),
    }
    if (onboarding.present) {
      onboarding.buttonNames = await page.getByRole('button').allTextContents()
      const body = await page.locator('body').innerText()
      onboarding.bodyBytes = Buffer.byteLength(body)
      onboarding.bodySha256 = sha256(body)
      await page.screenshot({ path: join(dirname(options.output), 'live-cordis-ui-onboarding.png'), fullPage: true })
      await continueButton.click({ timeout: 10_000 })
      onboarding.dismissed = true
    }
    const workspace = await connectWorkspace(page, options.workspace)
    const durableRendered = await locateDurableSession(page)
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await input.waitFor({ timeout: 20_000 })
    const listed = await runtime.ctx.sessionController.list({}, AbortSignal.timeout(10_000))
    const durable = listed.items.find(item => item.sessionId === acp.sessionId)
    if (durable === undefined) throw new Error('ACP Session identity is absent from shared Web Session Controller')
    await input.fill(CANCEL_PROMPT)
    await input.press('Enter')
    const stop = page.getByRole('button', { name: 'Stop generating' })
    await stop.waitFor({ timeout: 10_000 })
    await withDeadline('cancel model request arrival', cancelBarrier.arrived, 15_000)
    await stop.click()
    await withDeadline('cancel model connection close', cancelBarrier.closed, 15_000)
    await stop.waitFor({ state: 'detached', timeout: 15_000 })
    await page.screenshot({ path: join(dirname(options.output), 'live-cordis-ui-cancel.png'), fullPage: true })
    return {
      apiRequests, consoleErrors, context, durable, durableRendered, onboarding, page, pageErrors, workspace,
      initialRender: {
        acpPrompt: await page.getByText(ACP_PROMPT, { exact: true }).count(),
        acpResponse: await page.getByText(ACP_RESPONSE, { exact: true }).count(),
      },
    }
  } catch (error) {
    await context.close().catch(() => {})
    throw error
  }
}
