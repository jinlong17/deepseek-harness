import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { ClientSideConnection, PROTOCOL_VERSION } from '../../apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'
import { launchLumxHost } from './host-supervisor.mjs'
import { prepareLumxHostLaunch } from './host-launch-materials.mjs'

const timeout = (promise, label, ms = 30_000) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })]).finally(() => clearTimeout(timer)) }
const deferred = () => Promise.withResolvers()
function args(argv) { const map = new Map(); for (let i = 0; i < argv.length; i += 2) map.set(argv[i], argv[i + 1]); const get = key => { const value = map.get(key); if (!value) throw new Error(`missing ${key}`); return value }; return { forkRoot: get('--fork'), nodePath: get('--node'), nodeSha256: get('--node-sha256'), osHome: get('--home'), qwenCliPath: get('--qwen-cli'), qwenCliSha256: get('--qwen-cli-sha256'), qwenRoot: get('--qwen-root'), qwenTreeSha256: get('--qwen-tree-sha256'), runtimeParent: get('--runtime'), sourceRoot: get('--source'), workspaceDirectory: get('--workspace') } }
async function listen(server) { await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) }); return server.address().port }
async function freePort() { const server = createServer(); const port = await listen(server); await new Promise(ok => server.close(ok)); return port }
async function body(request) { let bytes = Buffer.alloc(0); for await (const chunk of request) { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 1024 * 1024) throw new Error('provider request exceeds qualification limit') } return JSON.parse(bytes) }
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'` }
function finish(response, payload, text) { const base = { id: 'b4-permission', object: 'chat.completion.chunk', created: 0, model: payload.model }; response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`); response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`); response.end('data: [DONE]\n\n') }
function tool(response, payload, callId, command) {
  const selected = payload.tools.find(value => value.function?.name === 'run_shell_command'); if (selected === undefined) throw new Error('Qwen omitted run_shell_command')
  const base = { id: callId, object: 'chat.completion.chunk', created: 0, model: payload.model }; const arguments_ = JSON.stringify({ command, description: 'synthetic permission negative control' })
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: selected.function.name, arguments: arguments_ } }] }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`); response.end('data: [DONE]\n\n')
}

export async function runExternalQwenPermissionProbe(input) {
  const rejectEffect = join(input.workspaceDirectory, 'reject-effect.txt'); const lateEffect = join(input.workspaceDirectory, 'late-effect.txt')
  const lateEntered = deferred(); const lateRelease = deferred(); const requests = []; const permissions = []
  const provider = createServer(async (request, response) => {
    const payload = await body(request); requests.push(payload); response.writeHead(200, { 'content-type': 'text/event-stream' })
    const source = JSON.stringify(payload.messages); const last = payload.messages.at(-1)
    if (last?.role !== 'tool' && source.includes('B4 REJECT PERMISSION')) return tool(response, payload, 'b4-reject', `/usr/bin/printf REJECTED > ${shellQuote(rejectEffect)}`)
    if (last?.role !== 'tool' && source.includes('B4 LATE PERMISSION')) return tool(response, payload, 'b4-late', `/usr/bin/printf LATE > ${shellQuote(lateEffect)}`)
    finish(response, payload, 'B4_PERMISSION_OK')
  })
  const port = await listen(provider); const expiresAt = '2099-01-01T00:00:00.000Z'; const identity = { credential: 'b4-permission', expiresAt, subject: 'b4-user', type: 'lumx.local-auth.v1' }
  let host
  try {
    host = await launchLumxHost(await prepareLumxHostLaunch({ ...input, consumer: 'external-qwen', launchId: crypto.randomUUID(), mode: 'developer', port: await freePort(),
      auth: { byokKey: 'local-provider-key', endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, gateway: { validate: async value => ({ active: true, expiresAt, subject: value.subject }) }, getIdentity: () => identity },
      external: { engineId: 'qwen-code-0.24.0', model: 'qwen3.7-max', qwenCliPath: input.qwenCliPath, qwenCliSha256: input.qwenCliSha256, qwenRoot: input.qwenRoot, qwenTreeSha256: input.qwenTreeSha256 } }))
    await host.control.healthCheck(); const connection = new ClientSideConnection(() => ({
      requestPermission: async params => {
        permissions.push(params); const late = permissions.length === 2; const wanted = late ? 'allow_once' : 'reject_once'; const option = params.options.find(value => value.kind === wanted)
        if (late) { lateEntered.resolve(); await lateRelease.promise }
        return option === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: option.optionId } }
      }, sessionUpdate: async () => {}, readTextFile: async () => { throw new Error('filesystem read disabled') }, writeTextFile: async () => { throw new Error('filesystem write disabled') },
    }), host.acp)
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const rejected = await connection.newSession({ cwd: input.workspaceDirectory, mcpServers: [] }); const rejectedResult = await connection.prompt({ sessionId: rejected.sessionId, prompt: [{ type: 'text', text: 'B4 REJECT PERMISSION' }] })
    const late = await connection.newSession({ cwd: input.workspaceDirectory, mcpServers: [] }); const latePrompt = connection.prompt({ sessionId: late.sessionId, prompt: [{ type: 'text', text: 'B4 LATE PERMISSION' }] }); await timeout(lateEntered.promise, 'late permission barrier')
    const cancelled = await timeout(connection.cancel({ sessionId: late.sessionId }), 'cancel during permission'); const lateResult = await timeout(latePrompt, 'late permission prompt'); lateRelease.resolve()
    await new Promise(resolveTick => setImmediate(resolveTick)); const after = await connection.newSession({ cwd: input.workspaceDirectory, mcpServers: [] }); const afterResult = await connection.prompt({ sessionId: after.sessionId, prompt: [{ type: 'text', text: 'B4 AFTER PERMISSION' }] })
    const exit = await host.shutdown()
    return { canonical: false, classification: 'B4 actual permission refusal and late-reply qualification', rejectedResult, lateResult, cancelled, afterResult, exit,
      providerRequests: requests.length, permissions: permissions.length, rejectedEffect: existsSync(rejectEffect), lateEffect: existsSync(lateEffect) }
  } finally { lateRelease.resolve(); await host?.shutdown().catch(() => {}); provider.closeAllConnections?.(); await new Promise(ok => provider.close(ok)) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const input = args(process.argv.slice(2)); for (const path of [input.osHome, input.runtimeParent, input.workspaceDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 })
  try { process.stdout.write(`${JSON.stringify(await runExternalQwenPermissionProbe(input), null, 2)}\n`) } finally { rmSync(input.runtimeParent, { recursive: true, force: true }) }
}
