import { createServer } from 'node:http'
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { ClientSideConnection, PROTOCOL_VERSION } from '../../apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'
import WebSocket from '../../apps/cli/node_modules/ws/index.js'
import { Context } from '../../vendor/cordis/lib/index.js'
import JsonlSessionPersistence from '../../packages/session/session-persistence-jsonl/lib/index.js'
import { launchLumxHost } from './host-supervisor.mjs'
import { prepareLumxHostLaunch } from './host-launch-materials.mjs'

const timeout = (promise, label, ms = 30_000) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })])
    .finally(() => clearTimeout(timer))
}
const deferred = () => Promise.withResolvers()
function args(argv) { const values = new Map(); for (let i = 0; i < argv.length; i += 2) values.set(argv[i], argv[i + 1]); const get = key => { const value = values.get(key); if (!value) throw new Error(`missing ${key}`); return value }; return { forkRoot: get('--fork'), nodePath: get('--node'), nodeSha256: get('--node-sha256'), osHome: get('--home'), qwenCliPath: get('--qwen-cli'), qwenCliSha256: get('--qwen-cli-sha256'), qwenRoot: get('--qwen-root'), qwenTreeSha256: get('--qwen-tree-sha256'), runtimeParent: get('--runtime'), sourceRoot: get('--source'), workspaceDirectory: get('--workspace') } }
async function listen(server) { await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) }); return server.address().port }
async function freePort() { const server = createServer(); const port = await listen(server); await new Promise(ok => server.close(ok)); return port }
function sse(response, payload, finish = true) {
  const base = { id: 'b4-six', object: 'chat.completion.chunk', created: 0, model: payload.model }
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: payload.text }, finish_reason: null }] })}\n\n`)
  if (finish) { response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`); response.end('data: [DONE]\n\n') }
}
function toolSse(response, payload, command) {
  const base = { id: 'b4-tool', object: 'chat.completion.chunk', created: 0, model: payload.model }
  const tool = payload.tools.find(value => value.function?.name === 'run_shell_command')
  if (tool === undefined) throw new Error('Qwen request did not advertise run_shell_command')
  const args = JSON.stringify({ command, description: 'create the synthetic B4 qualification marker' })
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'b4-world-effect', type: 'function', function: { name: tool.function.name, arguments: args } }] }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
  response.end('data: [DONE]\n\n')
}
async function body(request) { let bytes = Buffer.alloc(0); for await (const chunk of request) { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 1024 * 1024) throw new Error('provider request exceeds qualification limit') } return JSON.parse(bytes) }
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'` }
function client(host, policy = async params => { const option = params.options.find(value => value.kind === 'allow_once'); return option === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: option.optionId } } }) {
  const updates = []; const permissions = []
  const connection = new ClientSideConnection(() => ({
    requestPermission: async params => { permissions.push(params); return policy(params) },
    sessionUpdate: async params => { updates.push({ at: Date.now(), params }) },
    readTextFile: async () => { throw new Error('front ACP filesystem read disabled') },
    writeTextFile: async () => { throw new Error('front ACP filesystem write disabled') },
  }), host.acp)
  return { connection, permissions, updates }
}
async function authenticate(readyUrl) { const response = await fetch(readyUrl, { redirect: 'manual' }); const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]; const location = response.headers.get('location'); if (response.status !== 303 || cookie === undefined || location === null) throw new Error(`Web authentication failed: ${response.status}`); const origin = new URL(readyUrl).origin; return { cookie, origin, page: new URL(location, origin).href } }
async function follow(auth, sessionId) {
  const socket = new WebSocket(`${auth.origin.replace(/^http/u, 'ws')}/api/remote.mux`, { headers: { cookie: auth.cookie } })
  await timeout(new Promise((ok, fail) => { socket.once('open', ok); socket.once('error', fail) }), 'Web journal open')
  const streamId = `b4-${crypto.randomUUID()}`; const frames = []; const waiters = []
  socket.on('message', bytes => { const frame = JSON.parse(bytes.toString()); if (frame.streamId !== streamId) return; frames.push(frame); for (const waiter of [...waiters]) if (waiter.predicate(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame) } })
  const wait = predicate => { const present = frames.find(predicate); if (present !== undefined) return Promise.resolve(present); return new Promise(resolveFrame => waiters.push({ predicate, resolve: resolveFrame })) }
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } } } }))
  await timeout(wait(frame => frame.type === 'item' && frame.value?.type === 'snapshot'), 'Web journal snapshot')
  return { close: () => socket.close(), frames, wait }
}
async function events(root, sessionId) {
  const ctx = new Context(); await ctx.plugin(JsonlSessionPersistence, { root })
  try { const handle = await ctx.sessionPersistence.open(sessionId, 'read'); try { return (await handle.read()).events } finally { await handle.close() } }
  finally { await ctx.fiber.dispose() }
}

export async function runExternalQwenSixCaseProbe(input) {
  const streamFirst = deferred(); const streamRelease = deferred(); const cancelStarted = deferred(); const cancelObserved = deferred()
  const requests = []; const effect = join(input.workspaceDirectory, 'b4-world-effect.txt'); let providerFinalAt; let requestNumber = 0
  const provider = createServer(async (request, response) => {
    const payload = await body(request); requests.push(payload); requestNumber += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requestNumber === 2) { sse(response, { ...payload, text: 'STREAM_FIRST' }, false); streamFirst.resolve(); await streamRelease.promise; sse(response, { ...payload, text: '_FINAL' }); providerFinalAt = Date.now(); return }
    if (requestNumber === 3) { cancelStarted.resolve(); response.once('close', () => cancelObserved.resolve()); return }
    if (requestNumber === 5) { toolSse(response, payload, `/usr/bin/printf %s B4_TOOL_OK > ${shellQuote(effect)}`); return }
    sse(response, { ...payload, text: requestNumber === 6 ? 'TOOL_COMPLETE' : 'B4_CASE_OK' })
  })
  const providerPort = await listen(provider); const identity = { credential: 'local-b4-six', expiresAt: '2099-01-01T00:00:00.000Z', subject: 'b4-six-user', type: 'lumx.local-auth.v1' }
  const launches = []; const launch = async () => launchLumxHost(await prepareLumxHostLaunch({ ...input, consumer: 'external-qwen', launchId: crypto.randomUUID(), mode: 'developer', port: await freePort(),
    auth: { byokKey: 'local-provider-key', endpoint: `http://127.0.0.1:${providerPort}/v1/chat/completions`, gateway: { validate: async value => ({ active: true, expiresAt: identity.expiresAt, subject: value.subject }) }, getIdentity: () => identity },
    external: { engineId: 'qwen-code-0.24.0', model: 'qwen3.7-max', qwenCliPath: input.qwenCliPath, qwenCliSha256: input.qwenCliSha256, qwenRoot: input.qwenRoot, qwenTreeSha256: input.qwenTreeSha256 },
  }))
  const phase = value => process.stderr.write(`[six-case] ${value}\n`)
  try {
    phase('launch-first')
    const first = await launch(); launches.push(first); const health = await first.control.healthCheck(); if (health.status !== 'pass') throw new Error(`Host health failed: ${health.error}`)
    const auth = await authenticate(first.readyUrl)
    const front = client(first); await front.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const streamed = await front.connection.newSession({ cwd: input.workspaceDirectory, mcpServers: [] }); const journal = await follow(auth, streamed.sessionId); phase('stream-start')
    let streamSettled = false; const streamPrompt = front.connection.prompt({ sessionId: streamed.sessionId, prompt: [{ type: 'text', text: 'B4 STREAM CASE' }] }).finally(() => { streamSettled = true }); streamPrompt.catch(() => {})
    await timeout(streamFirst.promise, 'provider first chunk'); const live = await timeout(journal.wait(frame => frame.type === 'item' && frame.value?.type === 'assistant-stream' && frame.value.frame?.type === 'chunk'), 'Web first assistant chunk')
    if (streamSettled || providerFinalAt !== undefined) throw new Error('stream settled before provider final barrier')
    streamRelease.resolve(); await streamPrompt; journal.close(); phase('stream-complete')
    const cancelled = await front.connection.newSession({ cwd: input.workspaceDirectory, mcpServers: [] }); const cancelPrompt = front.connection.prompt({ sessionId: cancelled.sessionId, prompt: [{ type: 'text', text: 'B4 CANCEL CASE' }] })
    await timeout(cancelStarted.promise, 'cancel provider barrier'); await front.connection.cancel({ sessionId: cancelled.sessionId }); phase('cancel-complete')
    const other = await front.connection.newSession({ cwd: input.workspaceDirectory, mcpServers: [] }); const otherPrompt = await front.connection.prompt({ sessionId: other.sessionId, prompt: [{ type: 'text', text: 'B4 OTHER SESSION' }] })
    await timeout(cancelObserved.promise, 'provider abort observation'); const cancelledResult = await cancelPrompt; phase('other-complete')
    const tool = await front.connection.newSession({ cwd: input.workspaceDirectory, mcpServers: [] }); phase('tool-start'); const toolResult = await front.connection.prompt({ sessionId: tool.sessionId, prompt: [{ type: 'text', text: 'B4 TOOL CASE' }] }); phase('tool-complete')
    const sessionRoot = join(realpathSync(input.osHome), '.lumx-developer', 'sessions')
    const firstExit = await first.shutdown(); phase('first-shutdown'); const firstEvents = await events(sessionRoot, streamed.sessionId); const toolEvents = await events(sessionRoot, tool.sessionId)
    const binding = firstEvents.find(value => value.type === 'agent/external-engine-bound')?.data
    const second = await launch(); launches.push(second); const resumedFront = client(second); await resumedFront.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }); await resumedFront.connection.resumeSession({ sessionId: streamed.sessionId, cwd: input.workspaceDirectory, mcpServers: [] }); phase('resume-complete')
    const reopened = await resumedFront.connection.prompt({ sessionId: streamed.sessionId, prompt: [{ type: 'text', text: 'B4 REOPEN CASE' }] }); const secondExit = await second.shutdown(); phase('second-shutdown'); const resumedEvents = await events(sessionRoot, streamed.sessionId)
    return { canonical: false, classification: 'B4 six-case supported Host qualification', health, webAuthenticated: true, liveFrame: live.value.frame.type,
      streamBeforeProviderFinal: true, cancelledResult, otherPrompt, toolResult, reopened, requests: requests.length, permissions: front.permissions.length,
      updateTypes: front.updates.map(value => value.params.update.sessionUpdate), worldEffect: readFileSync(effect, 'utf8'),
      toolCalls: toolEvents.filter(value => value.type === 'tool/call').length, toolResults: toolEvents.filter(value => value.type === 'tool/result').length,
      sessionId: streamed.sessionId, nativeSessionId: binding?.nativeSessionId, bindingCount: resumedEvents.filter(value => value.type === 'agent/external-engine-bound').length,
      contiguous: resumedEvents.every((value, index) => value.seq === index), firstExit, secondExit }
  } catch (error) { process.stderr.write(`${launches.map(host => host.stderr()).join('\n')}\n`); throw error }
  finally { streamRelease.resolve(); for (const host of launches) await host.shutdown().catch(() => {}); provider.closeAllConnections?.(); await new Promise(ok => provider.close(ok)) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const input = args(process.argv.slice(2)); for (const path of [input.osHome, input.runtimeParent, input.workspaceDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 })
  try { process.stdout.write(`${JSON.stringify(await runExternalQwenSixCaseProbe(input), null, 2)}\n`) } finally { rmSync(input.runtimeParent, { recursive: true, force: true }) }
}
