import { createServer } from 'node:http'
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { createAcpModelRelay } from './model-relay.mjs'
import { prepareQwenLaunch, releaseQwenLaunch } from './qwen-launch-materials.mjs'
import { createSupervisedQwenEngine } from './supervised-qwen-engine.mjs'

function args(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1])
  const required = name => { const value = values.get(name); if (!value) throw new Error(`missing ${name}`); return value }
  return {
    nodePath: required('--node'), nodeSha256: required('--node-sha256'), qwenCliPath: required('--qwen-cli'),
    qwenCliSha256: required('--qwen-cli-sha256'), qwenRoot: required('--qwen-root'), qwenTreeSha256: required('--qwen-tree-sha256'),
    runtime: required('--runtime'), workspace: required('--workspace'),
  }
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return server.address().port
}
async function close(server) {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(() => resolve()))
}

/** Genuine pinned-Qwen create/prompt/fresh-process-load probe over the product engine owner. */
export async function runSupervisedQwenProbe(options) {
  const runtime = realpathSync(options.runtime); const workspace = realpathSync(options.workspace)
  const requests = []; const firstChunk = Promise.withResolvers(); const providerFinal = Promise.withResolvers()
  const provider = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body); requests.push(payload)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: 'b4-supervised', object: 'chat.completion.chunk', created: 0, model: payload.model }
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'B4_SUPERVISED_OK' }, finish_reason: null }] })}\n\n`)
    firstChunk.resolve(Date.now())
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    response.end('data: [DONE]\n\n', () => providerFinal.resolve(Date.now()))
  })
  const port = await listen(provider)
  const expiresAt = '2099-01-01T00:00:00.000Z'
  let identity = { credential: 'local-b4-identity', expiresAt, subject: 'b4-user', type: 'lumx.local-auth.v1' }
  const relay = await createAcpModelRelay({
    engineId: 'qwen-code-0.24.0', gateway: { validate: async input => ({ active: true, expiresAt, subject: input.subject }) },
    getIdentity: () => identity, launchId: 'b4-supervised', model: 'qwen3.7-max',
    providerEndpoint: `http://127.0.0.1:${port}/v1/chat/completions`, providerKey: 'local-provider-key', sessionId: 'b4-session',
  })
  const materials = prepareQwenLaunch({ ...options, runtime, workspace, relayPort: Number(new URL(relay.endpoint).port) })
  const updates = []
  const engine = createSupervisedQwenEngine({ materials, relay, model: 'qwen3.7-max', onUpdate: event => { updates.push(event.params) } })
  let created; let prompted; let firstExit; let loaded; let secondExit
  try {
    created = await engine.create({}, { handleId: 'handle-create', signal: new AbortController().signal })
    prompted = await engine.prompt({ prompt: [{ type: 'text', text: 'Return exactly B4_SUPERVISED_OK and use no tools.' }] },
      { handleId: 'handle-create', promptId: 'prompt-1', signal: new AbortController().signal })
    firstExit = await engine.dispose({ handleId: 'handle-create' })
    loaded = await engine.load({ nativeSessionId: created.nativeSessionId }, { handleId: 'handle-load', signal: new AbortController().signal })
    secondExit = await engine.dispose({ handleId: 'handle-load' })
    return {
      anchors: materials.anchors, canonical: false, classification: 'B4 supervised-engine milestone probe',
      created: created.nativeSessionId, firstChunkBeforeProviderFinal: await firstChunk.promise <= await providerFinal.promise,
      lifecycle: { firstExit, secondExit }, loaded: loaded.nativeSessionId, providerRequests: requests.length,
      prompt: prompted.result, sameNativeSession: created.nativeSessionId === loaded.nativeSessionId,
      settingsPersisted: readFileSync(materials.paths.settings, 'utf8').length > 0, updates: updates.length,
    }
  } finally {
    identity = undefined
    await engine.close().catch(() => {})
    await close(provider)
    releaseQwenLaunch(materials)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const options = args(process.argv.slice(2))
  mkdirSync(options.runtime, { recursive: true, mode: 0o700 }); mkdirSync(options.workspace, { recursive: true, mode: 0o700 })
  try { process.stdout.write(`${JSON.stringify(await runSupervisedQwenProbe(options), null, 2)}\n`) }
  finally { rmSync(options.runtime, { recursive: true, force: true }) }
}
