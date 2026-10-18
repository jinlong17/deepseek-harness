import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createEngineRpcPeer } from '../drivers/acp/engine-rpc.mjs'
import { launchLumxRuntimeInProcess } from '../runtime/internal-launch.mjs'
import { createAcpByteTransport } from './acp-byte-transport.mjs'
import { observeFileDescriptors } from './fd-observer.mjs'
import { createTypedPipe } from './typed-pipe.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function assistantText(events) { return events.flatMap(event => event.type === 'assistant/message'
  ? event.data.message.content.filter(block => block.type === 'text').map(block => block.text) : []).join('') }
function childObservation(nodePath, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [fileURLToPath(new URL('./fd-observer.mjs', import.meta.url)), '--child', JSON.stringify(input)], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { stdout += value }); child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value })
    child.once('error', reject); child.once('close', (code, signal) => code === 0 ? resolve({ code, signal, observations: JSON.parse(stdout) }) : reject(new Error(`FD child failed (${code ?? signal}): ${stderr}`)))
  })
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('missing fixed Host configuration path')
const configBytes = readFileSync(configPath); const config = JSON.parse(configBytes)
if (config.version !== 2 || config.configSha256 !== sha256(Buffer.from(JSON.stringify(config.payload)))) throw new Error('Host configuration digest mismatch')
const input = config.payload
if (!['desktop-byok', 'external-qwen', 'governed-h1', 'platform-stub'].includes(input.consumer)) throw new Error('Host configuration consumer is invalid')
// Raw stdout is the authenticated private multiplex. Product startup notices
// are represented by the typed ready frame and must never enter that channel.
console.log = () => {}; console.info = () => {}
let runtime; let stopping; let rpc
const pipe = createTypedPipe({ readable: process.stdin, writable: process.stdout, generation: input.generation, incomingDirection: 'supervisor-to-host', outgoingDirection: 'host-to-supervisor', onFrame,
  endWritableOnClose: false })
const acp = createAcpByteTransport(pipe)
const remoteEngine = Object.freeze({
  create: (value, options) => rpc.request('create', value, options),
  load: (value, options) => rpc.request('load', value, options), prompt: (value, options) => rpc.request('prompt', value, options),
  cancel: value => rpc.request('cancel', {}, { handleId: value.handleId, promptId: value.promptId }),
  dispose: value => rpc.request('dispose', {}, { handleId: value.handleId }),
})
rpc = createEngineRpcPeer({ pipe, handlers: { permission: (params, ids) => runtime.external.router.onPermission({ handleId: ids.handleId, promptId: ids.promptId, params }) },
  onEvent(frame) { if (frame.payload.type !== 'update') throw new Error('Host received an unsupported engine event'); return runtime.external.router.onUpdate({ handleId: frame.handleId, promptId: frame.promptId, params: frame.payload.value }) } })

async function healthCheck() {
  const sessionId = randomUUID(); const created = await runtime.ctx.sessionController.create({ sessionId, cwd: input.workspaceDirectory })
  await runtime.ctx.sessionController.prompt({ requestId: `health-${sessionId}`, sessionId: created.sessionId, mode: 'queue', content: [{ type: 'text', text: 'LUMX Host launch-scoped relay health check' }] }, new AbortController().signal)
  const agent = runtime.ctx.agents.get(created.sessionId); if (agent === undefined) throw new Error('Host health session has no Agent')
  await agent.whenIdle(); const events = agent.session.snapshotEvents(); const text = assistantText(events); if (text.length === 0) throw new Error('Host health model returned no assistant text')
  return { assistantTextSha256: sha256(text), eventTypes: events.map(event => event.type), sessionId: created.sessionId }
}
async function command(frame) {
  const value = frame.payload
  if (value?.command === 'health') return healthCheck()
  if (value?.command === 'inspect-session' && typeof value.sessionId === 'string' && /^[0-9a-f-]{36}$/u.test(value.sessionId)) { const result = await runtime.ctx.sessionController.inspect(value.sessionId, new AbortController().signal); return { eventCount: result.events.length, sessionId: value.sessionId } }
  if (value?.command === 'qualify' && runtime.qualification !== undefined) return runtime.qualification.execute(value.request)
  if (value?.command === 'shutdown') return { stopping: true, ...await runtime.shutdown() }
  throw new Error('Host control command is invalid')
}
function onFrame(frame) {
  if (acp.accept(frame) || rpc.onFrame(frame)) return
  if (frame.channel !== 'control' || frame.type !== 'command') throw new Error('Host received an unsupported frame')
  const stoppingCommand = frame.payload?.command === 'shutdown'
  void command(frame).then(value => pipe.send({ channel: 'control', type: 'response', requestId: frame.requestId, payload: { ok: true, value } }), error => pipe.send({ channel: 'control', type: 'response', requestId: frame.requestId, payload: { ok: false, error: error instanceof Error ? error.message : String(error) } }))
    .finally(() => { if (stoppingCommand) setImmediate(() => void shutdown().then(() => process.exit(0), () => process.exit(1))) })
}
const shutdown = () => (stopping ??= (async () => { await runtime?.shutdown(); await rpc.close(); await pipe.close().catch(() => {}) })())
pipe.closed.then(() => shutdown().then(() => process.exit(0), () => process.exit(1)), () => shutdown().then(() => process.exit(1), () => process.exit(1)))
process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0), () => process.exit(1)) })

try {
  const fdQualified = input.fdQualified === true && input.canary !== undefined
  const fdObservation = fdQualified ? observeFileDescriptors(input.fdTargets, input.canary) : []
  const childFdObservation = fdQualified ? await childObservation(input.nodePath, { targets: input.fdTargets, canary: input.canary }) : { qualified: false, observations: [] }
  let pathError; if (fdQualified) try { readFileSync(input.canary.path) } catch (error) { pathError = error.code ?? error.name }
  const protectedPathErrors = {}; for (const path of input.protectedPaths) { try { readFileSync(path); protectedPathErrors[path] = 'READABLE' } catch (error) { protectedPathErrors[path] = error.code ?? error.name } }
  runtime = await launchLumxRuntimeInProcess({ consumer: input.consumer, qualification: input.qualification, mode: input.mode, osHome: input.osHome, workspaceDirectory: input.workspaceDirectory, sourceRoot: input.sourceRoot, port: input.port, environment: input.environment,
    ...input.consumer === 'desktop-byok' ? { auth: { byokKey: input.relayCapability, endpoint: input.modelEndpoint, relayOnly: true } } : {},
    ...input.consumer === 'external-qwen' ? { external: { acp, ...input.external, engine: remoteEngine } } : {},
    ...input.consumer === 'governed-h1' ? { h1: input.h1 } : {} })
  await pipe.send({ channel: 'control', type: 'ready', payload: { pid: process.pid, baseUrl: runtime.baseUrl, readyUrl: runtime.readyUrl, consumer: runtime.consumer, surface: runtime.surface, governance: runtime.governance, fdQualification: { qualified: fdQualified, targets: input.fdTargets }, fdObservation, childFdObservation, canaryPathError: pathError, protectedPathErrors, configSha256: sha256(configBytes) } })
} catch (error) { process.stderr.write(`lumx-host-entry:${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); await shutdown().catch(() => {}); process.exit(1) }
