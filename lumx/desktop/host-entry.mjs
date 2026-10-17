import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { launchLumxRuntimeInProcess } from '../runtime/internal-launch.mjs'
import { observeFileDescriptors } from './fd-observer.mjs'

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function assistantText(events) {
  return events.flatMap(event => event.type === 'assistant/message'
    ? event.data.message.content.filter(block => block.type === 'text').map(block => block.text)
    : []).join('')
}
async function healthCheck() {
  const sessionId = randomUUID()
  const created = await runtime.ctx.sessionController.create({ sessionId, cwd: input.workspaceDirectory })
  await runtime.ctx.sessionController.prompt({
    requestId: `health-${sessionId}`, sessionId: created.sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'LUMX Host launch-scoped relay health check' }],
  }, new AbortController().signal)
  const agent = runtime.ctx.agents.get(created.sessionId)
  if (agent === undefined) throw new Error('Host health session has no Agent')
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const text = assistantText(events)
  if (text.length === 0) throw new Error('Host health model returned no assistant text')
  return { assistantTextSha256: sha256(text), eventTypes: events.map(event => event.type), sessionId: created.sessionId }
}
function childObservation(nodePath, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [fileURLToPath(new URL('./fd-observer.mjs', import.meta.url)), '--child', JSON.stringify(input)], {
      env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''; let stderr = ''
    child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { stdout += value })
    child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value })
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0
      ? resolve({ code, signal, observations: JSON.parse(stdout) })
      : reject(new Error(`FD child failed (${code ?? signal}): ${stderr}`)))
  })
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('missing fixed Host configuration path')
const configBytes = readFileSync(configPath)
const config = JSON.parse(configBytes)
if (config.version !== 1 || config.configSha256 !== sha256(Buffer.from(JSON.stringify(config.payload)))) throw new Error('Host configuration digest mismatch')
const input = config.payload
let runtime
let stopping
const shutdown = () => (stopping ??= (async () => {
  await runtime?.shutdown()
  process.stdout.write(`${JSON.stringify({ type: 'stopped' })}\n`)
})())
const control = createInterface({ input: process.stdin, crlfDelay: Infinity })
control.on('line', line => {
  if (line === '{"command":"shutdown"}') void shutdown().then(() => process.exit(0), () => process.exit(1))
  else {
    let command
    try { command = JSON.parse(line) } catch { return }
    if (command?.command === 'health' && typeof command.id === 'string') {
      void healthCheck().then(
        value => process.stdout.write(`${JSON.stringify({ type: 'health', id: command.id, status: 'pass', ...value })}\n`),
        error => process.stdout.write(`${JSON.stringify({ type: 'health', id: command.id, status: 'fail', error: error instanceof Error ? error.message : String(error) })}\n`),
      )
    } else if (command?.command === 'inspect-session' && typeof command.id === 'string'
      && typeof command.sessionId === 'string' && /^[0-9a-f-]{36}$/u.test(command.sessionId)) {
      void runtime.ctx.sessionController.inspect(command.sessionId, new AbortController().signal).then(
        value => process.stdout.write(`${JSON.stringify({ type: 'inspect-session', id: command.id, status: 'pass', eventCount: value.events.length, sessionId: command.sessionId })}\n`),
        error => process.stdout.write(`${JSON.stringify({ type: 'inspect-session', id: command.id, status: 'fail', error: error instanceof Error ? error.message : String(error) })}\n`),
      )
    }
  }
})
control.on('close', () => { void shutdown().then(() => process.exit(0), () => process.exit(1)) })
process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0), () => process.exit(1)) })
try {
  const fdObservation = observeFileDescriptors(input.fdTargets, input.canary)
  const childFdObservation = await childObservation(input.nodePath, { targets: input.fdTargets, canary: input.canary })
  let pathError
  try { readFileSync(input.canary.path) } catch (error) { pathError = error.code ?? error.name }
  const protectedPathErrors = {}
  for (const path of input.protectedPaths) {
    try { readFileSync(path); protectedPathErrors[path] = 'READABLE' } catch (error) { protectedPathErrors[path] = error.code ?? error.name }
  }
  runtime = await launchLumxRuntimeInProcess({
    mode: input.mode, osHome: input.osHome, workspaceDirectory: input.workspaceDirectory,
    sourceRoot: input.sourceRoot, port: input.port, environment: input.environment,
    auth: { byokKey: input.relayCapability, endpoint: input.modelEndpoint, relayOnly: true },
  })
  process.stdout.write(`${JSON.stringify({
    type: 'ready', pid: process.pid, baseUrl: runtime.baseUrl, readyUrl: runtime.readyUrl,
    governance: runtime.governance,
    fdObservation, childFdObservation, canaryPathError: pathError, protectedPathErrors, configSha256: sha256(configBytes),
  })}\n`)
} catch (error) {
  await shutdown().catch(() => {})
  process.stderr.write(`lumx-host-entry:${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
