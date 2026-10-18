import { createServer } from 'node:http'
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { ClientSideConnection, PROTOCOL_VERSION } from '../../apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'
import { launchLumxHost } from './host-supervisor.mjs'
import { prepareLumxHostLaunch } from './host-launch-materials.mjs'

function args(argv) { const values = new Map(); for (let i = 0; i < argv.length; i += 2) values.set(argv[i], argv[i + 1]); const get = key => { const value = values.get(key); if (!value) throw new Error(`missing ${key}`); return value }; return { forkRoot: get('--fork'), nodePath: get('--node'), nodeSha256: get('--node-sha256'), osHome: get('--home'), qwenCliPath: get('--qwen-cli'), qwenCliSha256: get('--qwen-cli-sha256'), qwenRoot: get('--qwen-root'), qwenTreeSha256: get('--qwen-tree-sha256'), runtimeParent: get('--runtime'), sourceRoot: get('--source'), workspaceDirectory: get('--workspace') } }
async function listen(server) { await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveReady) }); return server.address().port }
async function freePort() { const server = createServer(); const port = await listen(server); await new Promise(resolveClose => server.close(resolveClose)); return port }
function client(host, updates, permissions) { return new ClientSideConnection(() => ({
  requestPermission: async params => { permissions.push(params); const option = params.options.find(value => value.kind === 'allow_once'); return option === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: option.optionId } } },
  sessionUpdate: async params => { updates.push(params) }, readTextFile: async () => { throw new Error('front ACP filesystem read disabled') }, writeTextFile: async () => { throw new Error('front ACP filesystem write disabled') },
}), host.acp) }

export async function runExternalQwenHostProbe(input) {
  const requests = []; let finalAt
  const provider = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk; const payload = JSON.parse(body); requests.push(payload)
    response.writeHead(200, { 'content-type': 'text/event-stream' }); const base = { id: 'b4-host', object: 'chat.completion.chunk', created: 0, model: payload.model }
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'B4_HOST_OK' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`); response.end('data: [DONE]\n\n', () => { finalAt = Date.now() })
  })
  const providerPort = await listen(provider); const identity = { credential: 'local-b4-host', expiresAt: '2099-01-01T00:00:00.000Z', subject: 'b4-host-user', type: 'lumx.local-auth.v1' }
  const launches = []; let sessionId
  const launch = async () => launchLumxHost(await prepareLumxHostLaunch({ ...input, consumer: 'external-qwen', launchId: crypto.randomUUID(), mode: 'developer', port: await freePort(),
    auth: { byokKey: 'local-provider-key', endpoint: `http://127.0.0.1:${providerPort}/v1/chat/completions`, gateway: { validate: async value => ({ active: true, expiresAt: identity.expiresAt, subject: value.subject }) }, getIdentity: () => identity },
    external: { engineId: 'qwen-code-0.24.0', model: 'qwen3.7-max', qwenCliPath: input.qwenCliPath, qwenCliSha256: input.qwenCliSha256, qwenRoot: input.qwenRoot, qwenTreeSha256: input.qwenTreeSha256 },
  }))
  try {
    const first = await launch(); launches.push(first); const updates = []; const permissions = []; const health = await first.control.healthCheck(); if (health.status !== 'pass') throw new Error(`Host health failed: ${health.error}`); const firstClient = client(first, updates, permissions)
    const initialized = await firstClient.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    let created; try { created = await firstClient.newSession({ cwd: input.workspaceDirectory, mcpServers: [] }) } catch (error) { throw new Error(`front session/new failed: ${error.message}`, { cause: error }) }; sessionId = created.sessionId
    let prompt; try { prompt = await firstClient.prompt({ sessionId, prompt: [{ type: 'text', text: 'Return exactly B4_HOST_OK and use no tools.' }] }) } catch (error) { throw new Error(`front session/prompt failed: ${error.message}`, { cause: error }) }
    const firstExit = await first.shutdown()
    const second = await launch(); launches.push(second); const resumedUpdates = []; const secondClient = client(second, resumedUpdates, [])
    await secondClient.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }); await secondClient.resumeSession({ sessionId, cwd: input.workspaceDirectory, mcpServers: [] })
    const resumed = await secondClient.prompt({ sessionId, prompt: [{ type: 'text', text: 'Return exactly B4_HOST_OK again and use no tools.' }] }); const secondExit = await second.shutdown()
    return { canonical: false, classification: 'B4 supported Host/official ACP product probe', health, initialized, prompt, resumed, sessionId,
      requests: requests.length, requestTools: requests.map(value => value.tools?.map(tool => tool.function?.name ?? tool.name) ?? []), finalAt, firstExit, secondExit, updateTypes: updates.concat(resumedUpdates).map(value => value.update.sessionUpdate),
      dataHome: `${realpathSync(input.osHome)}/.lumx-developer`, permissions: permissions.length }
  } catch (error) { process.stderr.write(`${launches.map(host => host.stderr()).join('\n')}\n`); throw error }
  finally { for (const host of launches) await host.shutdown().catch(() => {}); provider.closeAllConnections?.(); await new Promise(resolveClose => provider.close(resolveClose)) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const input = args(process.argv.slice(2)); for (const path of [input.osHome, input.runtimeParent, input.workspaceDirectory]) mkdirSync(path, { recursive: true, mode: 0o700 })
  try { process.stdout.write(`${JSON.stringify(await runExternalQwenHostProbe(input), null, 2)}\n`) } finally { rmSync(input.runtimeParent, { recursive: true, force: true }) }
}
